'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const patchPath = path.join(repoRoot, 'overlays/agentmemory-patches/opencode-capture.patch');

function readPatch() {
  return fs.readFileSync(patchPath, 'utf8');
}

function targetFiles(patch) {
  const targets = new Set();
  for (const line of patch.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      targets.add(diffMatch[1]);
      targets.add(diffMatch[2]);
    }
  }
  return [...targets].sort();
}

function createPatchedFixture() {
  const packagePath = process.env.AGENTMEMORY_PACKAGE_PATH || execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      'path:.#darwinConfigurations.ShopifyLaptop.pkgs.agentmemory',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-opencode-plugin-'));
  const sourcePath = path.join(tempDir, 'agentmemory-capture.ts');
  fs.copyFileSync(
    path.join(
      packagePath,
      'lib/node_modules/@agentmemory/agentmemory/plugin/opencode/agentmemory-capture.ts',
    ),
    sourcePath,
  );
  return {
    root: tempDir,
    sourcePath,
    source: fs.readFileSync(sourcePath, 'utf8'),
  };
}

function requestsByPath(result, requestPath) {
  return result.requests.filter((request) => request.path === requestPath);
}

function assertPostRequest(request) {
  assert.equal(request.method, 'POST');
  assert.equal(request.authorization, 'Bearer test-secret');
  assert.equal(request.contentType, 'application/json');
}

function assertObservation(request, { sessionID, project, cwd, hookType, data }) {
  assert.equal(request.path, '/agentmemory/observe');
  assertPostRequest(request);
  assert.deepEqual(Object.keys(request.body).sort(), [
    'cwd',
    'data',
    'hookType',
    'project',
    'sessionId',
    'timestamp',
  ]);
  assert.equal(request.body.hookType, hookType);
  assert.equal(request.body.sessionId, sessionID);
  assert.equal(request.body.project, project);
  assert.equal(request.body.cwd, cwd);
  assert.match(request.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(request.body.data, data);
}

test('the patch is provenance-labelled and targets only the upstream entrypoint', () => {
  const patch = readPatch();
  const fixture = createPatchedFixture();

  try {
    assert.match(patch, /Provenance: repository-owned patch for AgentMemory e04ba888/);
    assert.match(patch, /Source: plugin\/opencode\/agentmemory-capture\.ts/);
    assert.deepEqual(targetFiles(patch), ['plugin/opencode/agentmemory-capture.ts']);
    assert.match(fixture.source, /export const AgentmemoryCapturePlugin/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the patched source retains stock requests, limits, context injection, and hooks', () => {
  const fixture = createPatchedFixture();
  try {
    const { source } = fixture;
    for (const event of [
      'session.created',
      'session.status',
      'session.idle',
      'session.deleted',
      'message.updated',
      'message.part.updated',
    ]) {
      assert.match(source, new RegExp(`type === "${event.replace('.', '\\.')}`));
    }
    for (const route of ['/session/start', '/observe', '/summarize', '/session/end', '/context']) {
      assert.match(source, new RegExp(`post(?:Json)?\\("${route.replace('/', '\\/')}"`));
    }
    assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
    assert.match(source, /AbortSignal\.timeout\(5000\)/);
    assert.match(source, /safeSlice/);
    assert.match(source, /MAX_STASHED_FILES/);
    assert.match(source, /experimental\.chat\.system\.transform/);
    assert.match(source, /experimental\.session\.compacting/);
    assert.match(source, /"chat\.params"/);
    assert.match(source, /"tool\.execute\.before"/);
    assert.match(source, /config: async/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the patched entrypoint emits standard requests for a complete OpenCode session', () => {
  const fixture = createPatchedFixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-opencode-plugin-'));
  const harnessPath = path.join(tempDir, 'harness.mjs');

  fs.writeFileSync(
    harnessPath,
    String.raw`
import { pathToFileURL } from "node:url";

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    requests.push({
      path: parsed.pathname,
      method: options.method,
      authorization: options.headers.Authorization || null,
      contentType: options.headers["Content-Type"] || null,
      body: JSON.parse(options.body),
      timeout: options.signal?.constructor?.name || null,
    });
  return {
    ok: true,
    async json() {
      return parsed.pathname.endsWith("/session/start") ? { context: "automatic context" } : {};
    },
  };
};

const { AgentmemoryCapturePlugin } = await import(pathToFileURL(process.argv[2]).href);
const sessionID = "session-1";
const hooks = await AgentmemoryCapturePlugin({
  worktree: process.cwd(),
  project: { id: process.cwd() },
});

await hooks.event({ event: {
  type: "session.created",
  properties: { info: { id: sessionID, directory: process.cwd(), title: "test session" } },
} });
await hooks["chat.message"](
  { sessionID, agent: "build", model: { providerID: "test", modelID: "model" } },
  { parts: [{ type: "text", text: "prompt text" }] },
);
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "text-1", sessionID, messageID: "message-1", type: "text",
    text: "assistant text", time: { start: 3, end: 4 },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "text-1", sessionID, messageID: "message-1", type: "text",
    text: "assistant text", time: { start: 3, end: 4 },
  } },
} });
await hooks.event({ event: {
  type: "message.updated",
  properties: { info: {
    id: "message-1", sessionID, role: "assistant", parentID: "user-1",
    modelID: "model", providerID: "test", mode: "build", cost: 0,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 }, finish: "stop",
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "text-1", sessionID, messageID: "message-1", type: "text",
    text: "assistant text", time: { start: 3, end: 4 },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "reasoning-1", sessionID, messageID: "message-1", type: "reasoning",
    text: "reasoning text", time: { start: 2, end: 3 },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-running", sessionID, messageID: "message-1", type: "tool",
    callID: "call-success", tool: "read",
    state: { status: "running", input: { path: "README.md" }, time: { start: 4 } },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-completed", sessionID, messageID: "message-1", type: "tool",
    callID: "call-success", tool: "read",
    state: {
      status: "completed", input: { path: "README.md" }, output: "file contents",
      title: "read", metadata: {}, time: { start: 4, end: 5 },
    },
  } },
} });
await hooks.event({ event: {
  type: "message.part.updated",
  properties: { part: {
    id: "tool-error", sessionID, messageID: "message-1", type: "tool",
    callID: "call-failure", tool: "write",
    state: {
      status: "error", input: { path: "README.md" }, error: "permission denied",
      time: { start: 6, end: 7 },
    },
  } },
} });
await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
const system = [];
await hooks["experimental.chat.system.transform"]({ sessionID }, { system });
if (typeof hooks.dispose === "function") await hooks.dispose();

console.log(JSON.stringify({ requests, system }));
`,
  );

  try {
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', harnessPath, fixture.sourcePath],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          AGENTMEMORY_URL: 'http://agentmemory.test:3111',
          AGENTMEMORY_SECRET: 'test-secret',
          AGENTMEMORY_PROJECT_NAME: 'contract-project',
        },
        encoding: 'utf8',
      },
    );
    const result = JSON.parse(output);
    const cwd = fs.realpathSync(tempDir);
    const observations = requestsByPath(result, '/agentmemory/observe');
    const observation = (hookType, predicate = () => true) => {
      const matches = observations.filter(
        (request) => request.body.hookType === hookType && predicate(request),
      );
      assert.equal(matches.length, 1, `expected one ${hookType} observation`);
      return matches[0];
    };

    const sessionStarts = requestsByPath(result, '/agentmemory/session/start');
    assert.equal(sessionStarts.length, 1);
    assertPostRequest(sessionStarts[0]);
    assert.deepEqual(sessionStarts[0].body, {
      sessionId: 'session-1',
      title: 'test session',
      parentID: null,
      version: null,
      project: 'contract-project',
      cwd,
    });

    assertObservation(observation('prompt_submit'), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'prompt_submit',
      data: {
        agent: 'build',
        model: { providerID: 'test', modelID: 'model' },
        variant: null,
        prompt: 'prompt text',
        files: [],
        parts_summary: ['text'],
      },
    });

    assertObservation(observation(
      'assistant_message',
      (request) => request.body.data?.text === undefined,
    ), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'assistant_message',
      data: {
        messageID: 'message-1',
        parentID: 'user-1',
        modelID: 'model',
        providerID: 'test',
        mode: 'build',
        cost: 0,
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cache_read: 0,
          cache_write: 0,
        },
        finish: 'stop',
        error: null,
        duration_ms: 1,
      },
    });

    assertObservation(observation(
      'assistant_message',
      (request) => request.body.data?.text === 'assistant text',
    ), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'assistant_message',
      data: {
        messageID: 'message-1',
        text: 'assistant text',
      },
    });

    assertObservation(observation('reasoning'), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'reasoning',
      data: {
        messageID: 'message-1',
        text: 'reasoning text',
      },
    });

    assertObservation(observation('pre_tool_use'), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'pre_tool_use',
      data: {
        tool_name: 'read',
        call_id: 'call-success',
        tool_input: '{"path":"README.md"}',
      },
    });

    assertObservation(observation('post_tool_use'), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'post_tool_use',
      data: {
        tool_name: 'read',
        call_id: 'call-success',
        tool_input: '{"path":"README.md"}',
        tool_output: 'file contents',
        title: 'read',
        metadata: {},
        duration_ms: 1,
        attachments: [],
      },
    });

    assertObservation(observation('post_tool_failure'), {
      sessionID: 'session-1',
      project: 'contract-project',
      cwd,
      hookType: 'post_tool_failure',
      data: {
        tool_name: 'write',
        call_id: 'call-failure',
        tool_input: '{"path":"README.md"}',
        tool_output: 'permission denied',
        duration_ms: 1,
      },
    });

    const summaries = requestsByPath(result, '/agentmemory/summarize');
    assert.equal(summaries.length, 1);
    assertPostRequest(summaries[0]);
    assert.deepEqual(summaries[0].body, { sessionId: 'session-1' });

    const sessionEnds = requestsByPath(result, '/agentmemory/session/end');
    assert.equal(sessionEnds.length, 1);
    assertPostRequest(sessionEnds[0]);
    assert.deepEqual(sessionEnds[0].body, { sessionId: 'session-1' });

    assert.ok(result.system.includes('automatic context'));

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
