import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentMemoryEntry =
  'lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts';
const agentMemorySecurityEntry =
  'lib/node_modules/@agentmemory/agentmemory/integrations/pi/security.ts';
const commandOptions = {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 600_000,
};

test('managed AgentMemory package contains the bundled Pi integration', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'overlays/agentmemory-deps/package.json'), 'utf8'),
  );
  const packagePath = process.env.AGENTMEMORY_PACKAGE_PATH || execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      'path:.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.agentmemory',
    ],
    commandOptions,
  ).trim();

  assert.ok(manifest.files.includes('integrations/'));
  assert.equal(fs.existsSync(path.join(packagePath, agentMemoryEntry)), true);
  assert.equal(fs.existsSync(path.join(packagePath, agentMemorySecurityEntry)), true);
});

function buildRuntimePaths() {
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
          pkgs = flake.darwinConfigurations.Brandons-MacBook-Pro.pkgs;
        in [ flake.inputs.pi.packages.aarch64-darwin.coding-agent pkgs.agentmemory ]`,
    ],
    commandOptions,
  )
    .trim()
    .split('\n');

  assert.equal(outputs.length, 2);
  return {
    pi: outputs.find((output) => fs.existsSync(path.join(output, 'bin/pi'))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, agentMemoryEntry))),
  };
}

function renderPiOwnership() {
  const expression = `(let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    hm = flake.darwinConfigurations.Brandons-MacBook-Pro.config.home-manager.users.brandonmcnama;
    pi = hm.programs.pi.coding-agent;
    extensions = map (extension: builtins.unsafeDiscardStringContext (toString extension)) pi.extensions;
    mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text);
  in builtins.toJSON {
    agentMemory = {
      enabled = hm.programs.agentmemory.enable;
      extension = builtins.head (builtins.filter (e: builtins.match ".*/integrations/pi/index[.]ts" e != null) extensions);
      runtimePackage = builtins.unsafeDiscardStringContext (toString hm.programs.agentmemory.package);
      dataDir = toString hm.programs.agentmemory.dataDir;
      url = pi.environment.AGENTMEMORY_URL.value;
      secretFile = pi.environment.AGENTMEMORY_SECRET.file;
      secretReference = hm.programs.agentmemory.bearerReference;
    };
    pi = {
      inherit (pi) enable;
      package = builtins.unsafeDiscardStringContext (toString pi.package);
      inherit extensions;
      retiredExtensions = builtins.filter (e: builtins.match ".*cavemem.*" e != null) extensions;
    };
    memoryServerNames = map (server: server.name) mcpConfig.mcpServers;
   })`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], commandOptions),
  );
}

const expectedProject = path.basename(repoRoot);
const expectedSessionId = 'session';
const expectedSearchResults = [
  { title: 'compatibility', narrative: 'bundled Pi route works', type: 'fact', score: 0.9 },
];

function assertRequestEnvelope(body, expectedKeys) {
  assert.deepEqual(Object.keys(body).sort(), [...expectedKeys].sort());
  assert.equal(body.sessionId, expectedSessionId);
  assert.equal(body.project, expectedProject);
  assert.equal(body.cwd, repoRoot);
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

const routeFixtures = new Map([
  [
    '/agentmemory/health',
    {
      method: 'GET',
      count: 3,
      body: (actual) => assert.equal(actual, null),
      response: { status: 'healthy', version: '0.9.29' },
    },
  ],
  [
    '/agentmemory/session/start',
    {
      method: 'POST',
      count: 1,
      body: (actual) =>
        assert.deepEqual(actual, {
          sessionId: expectedSessionId,
          project: expectedProject,
          cwd: repoRoot,
        }),
      response: { ok: true, sessionId: expectedSessionId },
    },
  ],
  [
    '/agentmemory/observe',
    {
      method: 'POST',
      count: 3,
      body: (actual) => {
        assertRequestEnvelope(actual, ['hookType', 'sessionId', 'project', 'cwd', 'timestamp', 'data']);
        if (actual.data.tool_name === 'conversation') {
          assert.equal(actual.hookType, 'post_tool_use');
          assert.deepEqual(actual.data, {
            tool_name: 'conversation',
            tool_input: 'find the compatibility decision',
            tool_output: 'assistant output',
          });
          return;
        }
        if (actual.data.tool_name === 'Bash') {
          assert.equal(actual.hookType, 'post_tool_use');
          assert.deepEqual(actual.data, {
            tool_name: 'Bash',
            tool_input: '{"command":"true"}',
            tool_output: '[{"type":"text","text":"tool output"}]',
          });
          return;
        }
        assert.equal(actual.hookType, 'prompt_submit');
        assert.deepEqual(actual.data, { prompt: 'find the compatibility decision' });
      },
      response: { accepted: true, ok: true },
    },
  ],
  [
    '/agentmemory/smart-search',
    {
      method: 'POST',
      count: 2,
      body: (actual, occurrence) =>
        assert.deepEqual(actual, [
          { query: 'find the compatibility decision', limit: 5, project: expectedProject },
          { query: 'compatibility', limit: 5, project: expectedProject },
        ][occurrence]),
      response: { results: expectedSearchResults },
    },
  ],
  [
    '/agentmemory/remember',
    {
      method: 'POST',
      count: 1,
      body: (actual) =>
        assert.deepEqual(actual, {
          content: 'route coverage',
          type: 'fact',
          project: expectedProject,
        }),
      response: { id: 'memory-compatibility', ok: true },
    },
  ],
  [
    '/agentmemory/session/end',
    {
      method: 'POST',
      count: 1,
      body: (actual) => assert.deepEqual(actual, { sessionId: expectedSessionId }),
      response: { ok: true, sessionId: expectedSessionId },
    },
  ],
  [
    '/agentmemory/consolidate',
    {
      method: 'POST',
      count: 1,
      body: (actual) => assert.deepEqual(actual, {}),
      response: { consolidated: 0, ok: true },
    },
  ],
]);

const expectedRequestCount = [...routeFixtures.values()].reduce((total, route) => total + route.count, 0);

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function startMockServer() {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    const bodyChunks = [];
    for await (const chunk of request) bodyChunks.push(chunk);
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const fixture = routeFixtures.get(pathname);
    let parsedBody = null;
    try {
      parsedBody = bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) : null;
    } catch (error) {
      errors.push(new Error(`${request.method} ${pathname} sent invalid JSON: ${error.message}`));
      writeJson(response, 400, { error: 'invalid JSON' });
      return;
    }

    const requestRecord = {
      authorization: request.headers.authorization,
      body: parsedBody,
      method: request.method,
      pathname,
      response: fixture?.response ?? null,
    };
    requests.push(requestRecord);

    if (!fixture) {
      errors.push(new Error(`unexpected AgentMemory route: ${request.method} ${pathname}`));
      writeJson(response, 404, { error: 'unexpected route' });
      return;
    }
    if (request.method !== fixture.method) {
      errors.push(new Error(`unexpected method for ${pathname}: ${request.method}, expected ${fixture.method}`));
      writeJson(response, 405, { error: 'unexpected method' });
      return;
    }
    if (requestRecord.authorization !== 'Bearer compatibility-secret') {
      errors.push(new Error(`missing or invalid bearer for ${request.method} ${pathname}`));
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }

    const occurrence = requests.filter(({ pathname: requestPath }) => requestPath === pathname).length - 1;
    try {
      fixture.body(parsedBody, occurrence);
    } catch (error) {
      errors.push(new Error(`${request.method} ${pathname} body mismatch: ${error.message}`));
      writeJson(response, 400, { error: 'unexpected body' });
      return;
    }
    writeJson(response, 200, fixture.response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        errors,
        requests,
        server,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function waitForRequests(requests, count) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (requests.length >= count) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out at ${requests.length}/${count} requests`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function loadPiModule(runtime, relativeEntry) {
  const { createJiti } = await import(
    pathToFileURL(`${runtime.pi}/lib/node_modules/jiti/lib/jiti.mjs`).href,
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      typebox: `${runtime.pi}/lib/node_modules/typebox/build/index.mjs`,
    },
  });
  return jiti.import(`${runtime.extensions}/${relativeEntry}`);
}

async function loadFactory(runtime) {
  const module = await loadPiModule(runtime, agentMemoryEntry);
  return module.default;
}

async function loadSecurityHelper(runtime) {
  return loadPiModule(runtime, agentMemorySecurityEntry);
}

async function exerciseFactory(runtime) {
  const ownership = renderPiOwnership();
  assert.equal(ownership.agentMemory.enabled, true);
  assert.equal(ownership.agentMemory.extension, path.join(ownership.agentMemory.runtimePackage, agentMemoryEntry));
  assert.equal(ownership.agentMemory.runtimePackage, runtime.extensions);
  assert.ok(ownership.agentMemory.dataDir.endsWith('/agentmemory'));
  assert.equal(ownership.agentMemory.url, 'http://127.0.0.1:3111');
  assert.equal(ownership.agentMemory.secretReference, 'agentmemory-bearer');
  assert.match(ownership.agentMemory.secretFile, /\.agentmemory\/pi-bearer$/);
  assert.equal(ownership.pi.enable, true);
  assert.match(ownership.pi.package, /-pi$/);
  assert.deepEqual(ownership.pi.retiredExtensions, []);
  assert.equal(ownership.memoryServerNames.includes('agentmemory'), true);
  assert.equal(ownership.memoryServerNames.includes('cavemem'), false);

  const mock = await startMockServer();
  const previous = {
    AGENTMEMORY_SECRET: process.env.AGENTMEMORY_SECRET,
    AGENTMEMORY_URL: process.env.AGENTMEMORY_URL,
  };
  process.env.AGENTMEMORY_SECRET = 'compatibility-secret';
  process.env.AGENTMEMORY_URL = mock.url;

  try {
    const events = new Map();
    const tools = new Map();
    const commands = new Map();
    const statuses = [];
    const pi = {
      on(name, handler) {
        events.set(name, handler);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    };
    const factory = await loadFactory(runtime);
    factory(pi);
    const context = {
      sessionManager: { getSessionFile: () => '/tmp/pi-compatibility/session.jsonl' },
      ui: {
        notify() {},
        setStatus(key, text) {
          statuses.push({ key, text });
        },
      },
    };

    await events.get('session_start')({}, context);
    const beforeAgentResult = await events.get('before_agent_start')(
      {
        prompt: 'find the compatibility decision',
        systemPrompt: 'base prompt',
        systemPromptOptions: { cwd: repoRoot },
      },
      context,
    );
    assert.match(beforeAgentResult.systemPrompt, /Relevant long-term memory from agentmemory/);
    const healthResult = await tools.get('memory_health').execute('health-call', {});
    assert.deepEqual(healthResult.details, { status: 'healthy', version: '0.9.29' });
    const searchResult = await tools
      .get('memory_search')
      .execute('search-call', { query: 'compatibility', limit: 5 });
    assert.deepEqual(searchResult.details, { query: 'compatibility', results: expectedSearchResults });
    const saveResult = await tools
      .get('memory_save')
      .execute('save-call', { content: 'route coverage', type: 'fact' });
    assert.deepEqual(saveResult.details, { id: 'memory-compatibility', ok: true });
    events.get('tool_result')({
      content: [{ type: 'text', text: 'tool output' }],
      input: { command: 'true' },
      isError: false,
      toolName: 'Bash',
    });
    await events.get('agent_end')({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'assistant output' }] }],
    });
    await events.get('session_shutdown')({ reason: 'quit' });
    await waitForRequests(mock.requests, expectedRequestCount);

    assert.deepEqual(mock.errors, []);
    assert.deepEqual([...new Set(mock.requests.map((request) => request.pathname))].sort(), [
      ...routeFixtures.keys(),
    ].sort());
    for (const [pathname, fixture] of routeFixtures) {
      const routeRequests = mock.requests.filter((request) => request.pathname === pathname);
      assert.equal(routeRequests.length, fixture.count, `${pathname} request count`);
      assert.deepEqual(
        routeRequests.map((request) => request.method),
        Array(fixture.count).fill(fixture.method),
        `${pathname} request methods`,
      );
      assert.deepEqual(
        routeRequests.map((request) => request.response),
        Array(fixture.count).fill(fixture.response),
        `${pathname} response shape`,
      );
    }
    assert.ok(mock.requests.every((request) => request.authorization === 'Bearer compatibility-secret'));
    assert.equal(commands.has('agentmemory-status'), true);
    assert.deepEqual(statuses.at(-1), { key: 'agentmemory', text: '🧠 agentmemory' });
  } finally {
    if (previous.AGENTMEMORY_SECRET === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previous.AGENTMEMORY_SECRET;
    if (previous.AGENTMEMORY_URL === undefined) delete process.env.AGENTMEMORY_URL;
    else process.env.AGENTMEMORY_URL = previous.AGENTMEMORY_URL;
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

test('bundled AgentMemory Pi integration uses authenticated standard routes', async () => {
  await exerciseFactory(buildRuntimePaths());
});

test('bundled Pi security helper keeps its relative layout and bearer guard contract', async () => {
  const runtime = buildRuntimePaths();
  assert.equal(path.posix.dirname(agentMemorySecurityEntry), path.posix.dirname(agentMemoryEntry));
  assert.equal(path.posix.basename(agentMemorySecurityEntry), 'security.ts');
  assert.match(runtime.extensions, /agentmemory-0\.9\.29/);
  assert.equal(fs.existsSync(path.join(runtime.extensions, agentMemoryEntry)), true);
  assert.equal(fs.existsSync(path.join(runtime.extensions, agentMemorySecurityEntry)), true);

  const security = await loadSecurityHelper(runtime);
  assert.equal(typeof security.usesPlaintextBearerAuth, 'function');
  assert.equal(typeof security.plaintextBearerAuthMessage, 'function');
  assert.equal(typeof security.createPlaintextBearerAuthGuard, 'function');
  assert.equal(security.usesPlaintextBearerAuth('http://127.0.0.1:3111', 'secret'), false);
  assert.equal(security.usesPlaintextBearerAuth('http://localhost:3111', 'secret'), false);
  assert.equal(security.usesPlaintextBearerAuth('https://memory.example.test', 'secret'), false);
  assert.equal(security.usesPlaintextBearerAuth('http://memory.example.test', 'secret'), true);
  assert.equal(security.usesPlaintextBearerAuth('http://memory.example.test'), false);

  const warnings = [];
  const guard = security.createPlaintextBearerAuthGuard((message) => warnings.push(message));
  guard('http://memory.example.test', 'secret');
  guard('http://memory.example.test', 'secret');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plaintext HTTP/);

  const strictGuard = security.createPlaintextBearerAuthGuard(() => {}, {
    AGENTMEMORY_REQUIRE_HTTPS: '1',
  });
  assert.throws(
    () => strictGuard('http://memory.example.test', 'secret'),
    /plaintext HTTP/,
  );
});
