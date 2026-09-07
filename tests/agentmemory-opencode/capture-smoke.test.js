'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const smokeSecret = 'agentmemory-capture-smoke-secret';

function packageRoot() {
  if (process.env.AGENTMEMORY_PACKAGE_PATH) {
    return process.env.AGENTMEMORY_PACKAGE_PATH;
  }

  return execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '.#darwinConfigurations.ShopifyLaptop.pkgs.agentmemory',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
}

function pluginSource(packagePath) {
  const sourcePath = path.join(
    packagePath,
    'lib/node_modules/@agentmemory/agentmemory/plugin/opencode/agentmemory-capture.ts',
  );
  assert.ok(fs.existsSync(sourcePath), `patched plugin is missing: ${sourcePath}`);
  return sourcePath;
}

function copyPluginSource(sourcePath, directory) {
  const copiedPath = path.join(directory, 'agentmemory-capture.ts');
  fs.copyFileSync(sourcePath, copiedPath);
  return copiedPath;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function freePorts(count) {
  const ports = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(await freePort());
  }
  return ports;
}

function writeHarness(directory, source) {
  const harnessPath = path.join(directory, 'plugin-harness.mjs');
  fs.writeFileSync(harnessPath, source);
  return harnessPath;
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return true;
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  return exited;
}

async function stopDaemon(child, requestStop, timeoutMs = 5_000) {
  requestStop();
  if (child.exitCode === null) child.kill('SIGTERM');
  if (await waitForExit(child, timeoutMs)) {
    assert.notEqual(child.exitCode, null, 'AgentMemory daemon must be gone after graceful stop');
    return;
  }

  child.kill('SIGKILL');
  const killed = await waitForExit(child, timeoutMs);
  assert.equal(killed, true, 'AgentMemory daemon did not exit after bounded SIGKILL');
  assert.notEqual(child.exitCode, null, 'AgentMemory daemon must be gone after SIGKILL');
}

async function waitForLiveness(baseUrl, child, output) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/agentmemory/livez`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `AgentMemory daemon did not become ready (${lastError})\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
  );
}

async function startDaemon(packagePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-capture-daemon-'));
  const [restPort, streamPort, viewerPort, enginePort] = await freePorts(4);
  const output = { stdout: '', stderr: '' };
  const daemon = spawn(
    path.join(packagePath, 'bin/agentmemory'),
    ['--port', String(restPort), '--data-dir', path.join(directory, 'data')],
    {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        AGENTMEMORY_PROVIDER: 'noop',
        AGENTMEMORY_SECRET: smokeSecret,
        AGENTMEMORY_DATA_DIR: path.join(directory, 'data'),
        AGENTMEMORY_RUNTIME_DIR: path.join(directory, 'runtime'),
        AGENTMEMORY_AUTO_COMPRESS: 'false',
        CONSOLIDATION_ENABLED: 'false',
        GRAPH_EXTRACTION_ENABLED: 'false',
        MAX_OBS_PER_SESSION: '10',
        III_REST_PORT: String(restPort),
        III_STREAM_PORT: String(streamPort),
        III_VIEWER_PORT: String(viewerPort),
        III_ENGINE_PORT: String(enginePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { output.stdout += chunk; });
  daemon.stderr.on('data', (chunk) => { output.stderr += chunk; });

  const baseUrl = `http://127.0.0.1:${restPort}`;
  try {
    await waitForLiveness(baseUrl, daemon, output);
  } catch (error) {
    daemon.kill('SIGKILL');
    assert.equal(await waitForExit(daemon), true, 'AgentMemory daemon survived startup cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    directory,
    daemon,
    packagePath,
    output,
    restPort,
    async close() {
      spawnSync(
        path.join(packagePath, 'bin/agentmemory'),
        ['stop', '--force', '--port', String(restPort)],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: directory,
            AGENTMEMORY_SECRET: smokeSecret,
            AGENTMEMORY_DATA_DIR: path.join(directory, 'data'),
          },
          stdio: 'ignore',
          timeout: 5_000,
        },
      );
      try {
        await stopDaemon(daemon, () => {});
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  assert.equal(response.ok, true, `${url} returned HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function realDaemonHarness() {
  return String.raw`
import { pathToFileURL } from "node:url";

const sourcePath = process.argv[2];
const requests = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  requests.push({
    path: parsed.pathname,
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });
  const response = await nativeFetch(url, options);
  requests.at(-1).status = response.status;
  return response;
};

const { AgentmemoryCapturePlugin } = await import(pathToFileURL(sourcePath).href);
const sessionID = "task-2-4-smoke-session";
const hooks = await AgentmemoryCapturePlugin({
  worktree: process.cwd(),
  project: { id: process.cwd() },
});

await hooks.event({ event: {
  type: "session.created",
  properties: { info: {
    id: sessionID,
    directory: process.cwd(),
    title: "Task 2.4 capture smoke",
  } },
} });
await hooks["chat.message"](
  { sessionID, agent: "build", model: { providerID: "test", modelID: "smoke-model" } },
  { parts: [{ type: "text", text: "capture smoke prompt ".repeat(100) }] },
);
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "assistant-text", sessionID, messageID: "assistant-1", type: "text",
    text: "assistant smoke response", time: { start: 3, end: 4 },
  } },
} });
await hooks.event({ event: {
  type: "message.updated",
  properties: { info: {
    id: "assistant-1", sessionID, role: "assistant", parentID: "user-1",
    modelID: "smoke-model", providerID: "test", mode: "build", cost: 0,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 }, finish: "stop",
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "reasoning-1", sessionID, messageID: "assistant-1", type: "reasoning",
    text: "reasoning smoke detail", time: { start: 2, end: 3 },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-running", sessionID, messageID: "assistant-1", type: "tool",
    callID: "tool-success", tool: "read",
    state: { status: "running", input: { path: "README.md" }, time: { start: 4 } },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-completed", sessionID, messageID: "assistant-1", type: "tool",
    callID: "tool-success", tool: "read",
    state: {
      status: "completed", input: { path: "src/index.ts" }, output: "smoke contents",
      title: "read", metadata: {}, time: { start: 4, end: 5 },
    },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-error", sessionID, messageID: "assistant-1", type: "tool",
    callID: "tool-failure", tool: "write",
    state: {
      status: "error", input: { path: "README.md" }, error: "smoke permission denied",
      time: { start: 6, end: 7 },
    },
  } },
} });
await hooks.event({ event: {
  type: "session.status",
  properties: { sessionID, status: { type: "busy", attempt: 1, message: "smoke" } },
} });
for (let index = 0; index < 3; index += 1) {
  await hooks.event({ event: {
    type: "session.status",
    properties: { sessionID, status: { type: "busy", attempt: index + 2, message: "overflow" } },
  } });
}
await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
const system = [];
await hooks["experimental.chat.system.transform"]({ sessionID }, { system });
await hooks.dispose();

console.log(JSON.stringify({ requests, system }));
`;
}

function failureHarness() {
  return String.raw`
import { pathToFileURL } from "node:url";

const sourcePath = process.argv[2];
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = (milliseconds) => originalTimeout(Math.min(milliseconds, 10));
let observeCount = 0;
let aborted = false;
  let abortReasonName = null;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/session/start")) {
      return new Response("upstream failure", { status: 503 });
  }
  if (path.endsWith("/observe")) {
    observeCount += 1;
    if (observeCount === 1) return Promise.reject(new Error("capture request failed"));
    if (observeCount === 3) return new Response("upstream failure", { status: 503 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("late response", { status: 200 })), 1_000);
      const onAbort = () => {
        aborted = true;
        abortReasonName = options.signal?.reason?.name || null;
        clearTimeout(timer);
        reject(options.signal?.reason || new Error("request aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }
  return new Response("{}", { status: 200 });
};

const { AgentmemoryCapturePlugin } = await import(pathToFileURL(sourcePath).href);
const hooks = await AgentmemoryCapturePlugin({ worktree: process.cwd(), project: { id: process.cwd() } });
await hooks.event({ event: {
  type: "session.created",
  properties: { info: { id: "failure-session", directory: process.cwd(), title: "failure" } },
} });
await hooks["chat.message"](
  { sessionID: "failure-session", agent: "build", model: { providerID: "test", modelID: "model" } },
  { parts: [{ type: "text", text: "first failure" }] },
);
await hooks["chat.message"](
  { sessionID: "failure-session", agent: "build", model: { providerID: "test", modelID: "model" } },
  { parts: [{ type: "text", text: "second timeout" }] },
);
await hooks["chat.message"](
  { sessionID: "failure-session", agent: "build", model: { providerID: "test", modelID: "model" } },
  { parts: [{ type: "text", text: "third response failure" }] },
);
await hooks.dispose();
console.log(JSON.stringify({ observeCount, aborted, abortReasonName }));
`;
}

function runHarness(harnessPath, sourcePath, args, env) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', harnessPath, sourcePath, ...args],
    {
      cwd: path.dirname(harnessPath),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test('the packaged plugin captures a real daemon session and preserves stock storage semantics', async () => {
  const packagePath = packageRoot();
  const packagedSourcePath = pluginSource(packagePath);
  const daemon = await startDaemon(packagePath);
  const sourcePath = copyPluginSource(packagedSourcePath, daemon.directory);
  const harnessPath = writeHarness(daemon.directory, realDaemonHarness());

  try {
    const result = runHarness(
      harnessPath,
      sourcePath,
      [daemon.baseUrl],
      {
        AGENTMEMORY_URL: daemon.baseUrl,
        AGENTMEMORY_SECRET: smokeSecret,
        AGENTMEMORY_PROJECT_NAME: 'agentmemory-capture-smoke',
      },
    );
    const headers = { Authorization: `Bearer ${smokeSecret}` };
    const sessions = await getJson(
      `${daemon.baseUrl}/agentmemory/sessions?agentId=*`,
      { headers },
    );
    const session = sessions.sessions.find((candidate) => candidate.id === 'task-2-4-smoke-session');
    assert.ok(session, 'the smoke session must be discoverable after the plugin exits');
    assert.equal(session.status, 'completed');

    const observations = await getJson(
      `${daemon.baseUrl}/agentmemory/observations?sessionId=task-2-4-smoke-session`,
      { headers },
    );
    assert.equal(observations.observations.length, 10, 'stock MAX_OBS_PER_SESSION must cap the session');
    assert.ok(observations.observations.every((observation) => observation.narrative.length <= 400));
    assert.ok(observations.observations.every((observation) => !('raw' in observation)));
    assert.ok(observations.observations.some((observation) => observation.title === 'prompt_submit'));
    assert.ok(observations.observations.some((observation) => observation.title === 'reasoning'));
    assert.ok(
      observations.observations.some((observation) => observation.title === 'read'),
      JSON.stringify(observations.observations.map((observation) => observation.title)),
    );
    assert.ok(
      observations.observations.some((observation) => observation.title === 'write'),
      JSON.stringify(observations.observations.map((observation) => observation.title)),
    );

    const paths = result.requests.map((request) => request.path);
    const toolRequests = result.requests.filter((request) => request.body?.hookType === 'post_tool_use' || request.body?.hookType === 'post_tool_failure');
    assert.deepEqual(
      toolRequests.map((request) => [request.body.hookType, request.body.data.tool_name, request.status]),
      [['post_tool_use', 'read', 201], ['post_tool_failure', 'write', 201]],
    );
    assert.equal(paths.filter((requestPath) => requestPath.endsWith('/session/start')).length, 1);
    assert.equal(paths.filter((requestPath) => requestPath.endsWith('/observe')).length, 11);
    assert.equal(paths.filter((requestPath) => requestPath.endsWith('/summarize')).length, 1);
    assert.equal(paths.filter((requestPath) => requestPath.endsWith('/session/end')).length, 1);
    assert.ok(result.system.some((entry) => entry.includes('<agentmemory-instructions>')));
  } finally {
    await daemon.close();
  }
});

test('cleanup rejects when a daemon survives bounded SIGKILL', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = (signal) => signals.push(signal);

  await assert.rejects(
    stopDaemon(child, () => {}, 10),
    /did not exit after bounded SIGKILL/,
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('failed and timed-out REST calls are logged without a durable retry queue', () => {
  const packagePath = packageRoot();
  const packagedSourcePath = pluginSource(packagePath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-capture-failure-'));
  const sourcePath = copyPluginSource(packagedSourcePath, directory);
  const harnessPath = writeHarness(directory, failureHarness());

  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', harnessPath, sourcePath],
      {
        cwd: directory,
        env: {
          ...process.env,
          AGENTMEMORY_URL: 'http://agentmemory.invalid:3111',
          AGENTMEMORY_SECRET: smokeSecret,
          AGENTMEMORY_PROJECT_NAME: 'agentmemory-capture-failure',
          OPENCODE_AGENTMEMORY_DEBUG: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const resultData = JSON.parse(result.stdout);
    assert.equal(resultData.observeCount, 3);
    assert.equal(resultData.aborted, true);
    assert.equal(resultData.abortReasonName, 'TimeoutError');
    assert.match(result.stderr, /POST \/observe failed: capture request failed/);
    assert.match(result.stderr, /POST \/observe failed: .*aborted|POST \/observe failed: .*TimeoutError/i);
    assert.match(result.stderr, /POST \/observe failed: HTTP 503/);
    assert.match(result.stderr, /POST \/session\/start failed: HTTP 503/);
    assert.doesNotMatch(result.stderr, /retry queue|durable queue/i);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['agentmemory-capture.ts', 'plugin-harness.mjs']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
