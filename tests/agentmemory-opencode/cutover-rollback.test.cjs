'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '../..');
const agentMemoryEntry =
  'lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts';
const agentMemorySecret = 'cutover-rollback-secret';

function renderSelection(backend) {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [
      flake.outputs.overlays.unstable-packages
      flake.outputs.overlays.custom-packages
    ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    extraSpecialArgs = { inherit (flake) inputs; };
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/default.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/cavemem.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/tmp/cutover-rollback";
        home.stateVersion = "26.05";
        home.opencode.memoryBackend = ${JSON.stringify(backend)};
        home.mcp = {
          obsidianVaultPath = "/tmp/cutover-rollback/vault";
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets."agentmemory-bearer" = "agentmemory-bearer";
        };
        home.cavemem = {
          enable = true;
          dataDir = "/tmp/cutover-rollback/cavemem";
        };
        programs.agentmemory = {
          enable = true;
          dataDir = "/tmp/cutover-rollback/agentmemory";
          runtimeDir = "/tmp/cutover-rollback/runtime";
          logDir = "/tmp/cutover-rollback/logs";
          bearerReference = "agentmemory-bearer";
        };
        programs.pi-agent = {
          enable = true;
          provider = {
            mode = "personal";
            defaultModel = {
              provider = "openai";
              modelId = "gpt-5.6-sol";
            };
          };
        };
      }
    ];
  }).config;
  capturePlugins = builtins.filter (file:
    builtins.match "opencode/plugins/(cavemem\\.js|agentmemory-.*)" file != null
  ) (builtins.attrNames hm.xdg.configFile);
in builtins.toJSON {
  inherit (hm.home.opencode) memoryBackend;
  capturePlugins = capturePlugins;
  piExtension = hm.programs.pi-agent.extensions.agentmemory.relativePath;
  piUrl = hm.programs.pi-agent.internal.agentMemoryUrl;
  piSecretReference = hm.programs.pi-agent.internal.agentMemorySecretReference;
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600_000,
    }),
  );
}

function packageRoot() {
  if (process.env.AGENTMEMORY_PACKAGE_PATH) return process.env.AGENTMEMORY_PACKAGE_PATH;

  return execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '.#darwinConfigurations.ShopifyLaptop.pkgs.agentmemory',
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 },
  ).trim().split('\n').at(-1);
}

function createJsonStore(directory, name, seed) {
  const filePath = path.join(directory, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(seed));
  return {
    filePath,
    read() {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
    append(record) {
      const records = this.read();
      records.push(record);
      fs.writeFileSync(filePath, JSON.stringify(records));
    },
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function isForbiddenAgentMemoryRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const hasMigrationSegment = segments.includes('migration') || segments.includes('migrate');
  const hasReversalSegment = segments.some((segment) =>
    ['reverse', 'reversal', 'rollback', 'revert'].includes(segment),
  );
  return (
    segments.includes('import') ||
    segments.includes('delete') ||
    (hasMigrationSegment && hasReversalSegment)
  );
}

async function startAgentMemoryMock(store) {
  const requests = [];
  const unexpectedRequests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const requestRecord = { method: request.method, pathname, body };
    requests.push(requestRecord);

    if (isForbiddenAgentMemoryRoute(pathname)) {
      unexpectedRequests.push({ ...requestRecord, reason: 'forbidden route' });
      writeJson(response, 405, { error: `forbidden route ${request.method} ${pathname}` });
      return;
    }

    if (pathname === '/agentmemory/health' && request.method === 'GET') {
      writeJson(response, 200, { status: 'healthy', version: 'fixture' });
      return;
    }
    if (pathname === '/agentmemory/smart-search' && request.method === 'POST') {
      writeJson(response, 200, { results: [] });
      return;
    }
    if (pathname === '/agentmemory/remember' && request.method === 'POST') {
      store.append({ kind: 'remember', body });
      writeJson(response, 200, { id: 'fixture-memory', ok: true });
      return;
    }
    if (pathname === '/agentmemory/consolidate' && request.method === 'POST') {
      writeJson(response, 200, { consolidated: 0, ok: true });
      return;
    }

    if (
      request.method === 'POST' &&
      [
        '/agentmemory/session/start',
        '/agentmemory/observe',
        '/agentmemory/summarize',
        '/agentmemory/session/end',
      ].includes(pathname)
    ) {
      store.append({ kind: 'ambient', pathname, body });
      writeJson(response, 200, { ok: true });
      return;
    }

    unexpectedRequests.push({ ...requestRecord, reason: 'unexpected route' });
    writeJson(response, 404, { error: `unexpected route ${request.method} ${pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    unexpectedRequests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createCavememFixture(directory, store) {
  const binDirectory = path.join(directory, 'bin');
  fs.mkdirSync(binDirectory);
  const executablePath = path.join(binDirectory, 'cavemem');
  fs.writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const filePath = process.env.CAVEMEM_STORE;
  const records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  records.push({ kind: 'ambient', argv: process.argv.slice(2), payload: JSON.parse(input) });
  fs.writeFileSync(filePath, JSON.stringify(records));
});
`,
    { mode: 0o755 },
  );
  return {
    env: {
      CAVEMEM_STORE: store.filePath,
      PATH: `${binDirectory}:${process.env.PATH}`,
    },
  };
}

function writeOpenCodeHarness(directory) {
  const harnessPath = path.join(directory, 'opencode-agentmemory-harness.mjs');
  fs.writeFileSync(
    harnessPath,
    String.raw`
import { pathToFileURL } from "node:url";

const { AgentmemoryCapturePlugin } = await import(pathToFileURL(process.argv[2]).href);
if (process.env.CAVEMEM_STORE !== process.argv[3]) {
  throw new Error("cutover must expose the Cavemem fixture store to the OpenCode process");
}
const hooks = await AgentmemoryCapturePlugin({
  worktree: process.cwd(),
  project: { id: process.cwd() },
});
const sessionID = "cutover-opencode-session";
await hooks.event({ event: {
  type: "session.created",
  properties: { info: { id: sessionID, directory: process.cwd(), title: "cutover" } },
} });
await hooks["chat.message"](
  { sessionID, agent: "build", model: { providerID: "fixture", modelID: "fixture" } },
  { parts: [{ type: "text", text: "cutover prompt" }] },
);
await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
await hooks.dispose();
`,
  );
  return harnessPath;
}

function runOpenCodeAgentMemoryCapture(directory, sourcePath, baseUrl, cavememEnv) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      writeOpenCodeHarness(directory),
      sourcePath,
      cavememEnv.CAVEMEM_STORE,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        ...cavememEnv,
        AGENTMEMORY_URL: baseUrl,
        AGENTMEMORY_SECRET: agentMemorySecret,
        AGENTMEMORY_PROJECT_NAME: 'cutover-rollback',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

async function buildPiRuntime() {
  const outputs = execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '--impure',
      '--expr',
      `let
        flake = builtins.getFlake ${JSON.stringify(repoRoot)};
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      in [ pkgs.pi-agent pkgs.pi-agent-extensions ]`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 },
  ).trim().split('\n');
  return {
    pi: outputs.find((output) => fs.existsSync(path.join(output, 'bin/pi'))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, 'share/pi-agent/extensions.json'))),
  };
}

async function loadPiFactory(runtime) {
  const { createJiti } = await import(
    pathToFileURL(`${runtime.pi}/lib/node_modules/jiti/lib/jiti.mjs`).href,
  );
  const jiti = createJiti(pathToFileURL(__filename).href, {
    moduleCache: false,
    alias: {
      typebox: `${runtime.pi}/lib/node_modules/typebox/build/index.mjs`,
    },
  });
  const module = await jiti.import(`${runtime.extensions}/${agentMemoryEntry}`);
  return module.default;
}

async function runPiAgentMemoryCapture(runtime, baseUrl, cavememEnv) {
  const env = {
    ...cavememEnv,
    AGENTMEMORY_SECRET: agentMemorySecret,
    AGENTMEMORY_URL: baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  assert.equal(process.env.CAVEMEM_STORE, cavememEnv.CAVEMEM_STORE);

  try {
    const events = new Map();
    const pi = {
      on(name, handler) {
        events.set(name, handler);
      },
      registerCommand() {},
      registerTool() {},
    };
    const factory = await loadPiFactory(runtime);
    factory(pi);
    const context = {
      sessionManager: { getSessionFile: () => '/tmp/cutover-rollback/session.jsonl' },
      ui: { notify() {}, setStatus() {} },
    };
    await events.get('session_start')({ reason: 'startup' }, context);
    await events.get('session_shutdown')({ reason: 'quit' }, context);
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function loadCavememPlugin() {
  const module = await import(
    `${pathToFileURL(path.join(repoRoot, 'home-manager/common/opencode-plugins/cavemem.js')).href}?fixture=${Date.now()}`,
  );
  return module.cavemem();
}

async function waitForLength(store, expectedLength) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (store.read().length >= expectedLength) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.read().length, expectedLength);
}

test('cutover and OpenCode-only rollback preserve ownership without dual writes', async () => {
  const cutover = renderSelection('agentmemory');
  const rollback = renderSelection('cavemem');
  assert.deepEqual(cutover.capturePlugins, ['opencode/plugins/agentmemory-capture.ts']);
  assert.equal(cutover.piExtension, agentMemoryEntry);
  assert.equal(cutover.piUrl, 'http://127.0.0.1:3111');
  assert.deepEqual(rollback.capturePlugins, ['opencode/plugins/cavemem.js']);
  assert.equal(rollback.piExtension, agentMemoryEntry);
  assert.equal(rollback.piSecretReference, 'agentmemory-bearer');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cutover-rollback-'));
  const agentMemorySeed = [{ id: 'imported-agentmemory', source: 'cavemem-import' }];
  const cavememSeed = [{ id: 'legacy-cavemem', source: 'legacy-history' }];
  const agentMemoryStore = createJsonStore(directory, 'agentmemory-store', agentMemorySeed);
  const cavememStore = createJsonStore(directory, 'cavemem-store', cavememSeed);
  const agentMemory = await startAgentMemoryMock(agentMemoryStore);
  const cavemem = createCavememFixture(directory, cavememStore);

  try {
    const packagePath = packageRoot();
    const sourcePath = path.join(
      packagePath,
      'lib/node_modules/@agentmemory/agentmemory/plugin/opencode/agentmemory-capture.ts',
    );
    const packagedSourcePath = path.join(directory, 'agentmemory-capture.ts');
    fs.copyFileSync(sourcePath, packagedSourcePath);
    const runtime = await buildPiRuntime();
    runOpenCodeAgentMemoryCapture(
      directory,
      packagedSourcePath,
      agentMemory.url,
      cavemem.env,
    );
    await runPiAgentMemoryCapture(runtime, agentMemory.url, cavemem.env);

    const afterCutoverAgentMemory = agentMemoryStore.read();
    assert.ok(
      afterCutoverAgentMemory.length > agentMemorySeed.length,
      'OpenCode and Pi must write ambient records to the AgentMemory fixture during cutover',
    );
    assert.ok(
      afterCutoverAgentMemory.some(
        (record) => record.body?.sessionId === 'cutover-opencode-session',
      ),
      'the OpenCode AgentMemory session must be present in the fixture',
    );
    assert.ok(
      afterCutoverAgentMemory.some((record) => record.body?.sessionId === 'session'),
      'the Pi AgentMemory session must be present in the fixture',
    );
    assert.deepEqual(
      cavememStore.read(),
      cavememSeed,
      'AgentMemory cutover must not write new ambient history to cavemem',
    );
    assert.ok(agentMemory.requests.length > 0, 'the AgentMemory mock must record every request');
    assert.deepEqual(agentMemory.unexpectedRequests, [], 'cutover must not use an unexpected route');
    assert.deepEqual(afterCutoverAgentMemory.slice(0, agentMemorySeed.length), agentMemorySeed);

    const rollbackAgentMemorySnapshot = agentMemoryStore.read();
    const rollbackCavememPlugin = await loadCavememPlugin();
    const rollbackEnvironment = {
      ...process.env,
      ...cavemem.env,
    };
    const previousPath = process.env.PATH;
    const previousStore = process.env.CAVEMEM_STORE;
    process.env.PATH = rollbackEnvironment.PATH;
    process.env.CAVEMEM_STORE = rollbackEnvironment.CAVEMEM_STORE;
    try {
      await rollbackCavememPlugin['session.created']({ sessionID: 'rollback-opencode-session' });
    } finally {
      process.env.PATH = previousPath;
      if (previousStore === undefined) delete process.env.CAVEMEM_STORE;
      else process.env.CAVEMEM_STORE = previousStore;
    }
    await waitForLength(cavememStore, cavememSeed.length + 1);

    assert.deepEqual(
      agentMemoryStore.read(),
      rollbackAgentMemorySnapshot,
      'OpenCode rollback must leave the Pi-owned AgentMemory store unchanged',
    );
    const afterRollbackCavemem = cavememStore.read();
    assert.deepEqual(afterRollbackCavemem[0], cavememSeed[0]);
    assert.equal(afterRollbackCavemem.length, cavememSeed.length + 1);
    assert.deepEqual(afterRollbackCavemem[1].payload, {
      session_id: 'rollback-opencode-session',
      ide: 'opencode',
    });
    assert.deepEqual(
      agentMemory.unexpectedRequests,
      [],
      'cutover and rollback must not use an import, delete, or migration-reversal route',
    );
    assert.deepEqual(agentMemoryStore.read().slice(0, agentMemorySeed.length), agentMemorySeed);
  } finally {
    await agentMemory.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
