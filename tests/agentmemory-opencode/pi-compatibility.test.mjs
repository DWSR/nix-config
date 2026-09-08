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
const commandOptions = {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 600_000,
};

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
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      in [ pkgs.agentmemory pkgs.pi-agent ]`,
    ],
    commandOptions,
  )
    .trim()
    .split('\n');

  assert.equal(outputs.length, 2);
  return {
    agentmemory: outputs.find((output) => fs.existsSync(path.join(output, 'bin/agentmemory'))),
    pi: outputs.find((output) => fs.existsSync(path.join(output, 'bin/pi'))),
  };
}

function renderPiOwnership(backend) {
  const expression = `(let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
    hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs = { inherit (flake) inputs; };
      modules = [
        ${JSON.stringify(path.join(repoRoot, 'home-manager/common/default.nix'))}
        ${JSON.stringify(path.join(repoRoot, 'home-manager/common/cavemem.nix'))}
        ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
        {
          home.username = "brandonmcnama";
          home.homeDirectory = "/tmp/pi-compatibility";
          home.stateVersion = "26.05";
          home.opencode.memoryBackend = ${JSON.stringify(backend)};
          home.cavemem.enable = true;
          home.mcp = {
            obsidianVaultPath = "/tmp/pi-compatibility/vault";
            githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
            keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
          };
          programs.agentmemory = {
            enable = true;
            dataDir = "/tmp/pi-compatibility/data";
            runtimeDir = "/tmp/pi-compatibility/runtime";
            logDir = "/tmp/pi-compatibility/logs";
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
  in builtins.toJSON {
    inherit (hm.home.opencode) memoryBackend;
    agentMemory = {
      enabled = hm.programs.agentmemory.enable;
      extension = hm.programs.pi-agent.extensions.agentmemory.relativePath;
      url = hm.programs.pi-agent.internal.agentMemoryUrl;
      secretReference = hm.programs.pi-agent.internal.agentMemorySecretReference;
    };
  })`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], commandOptions),
  );
}

function startMockServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({
      authorization: request.headers.authorization,
      body: body.length ? JSON.parse(Buffer.concat(body).toString('utf8')) : null,
      method: request.method,
      pathname,
    });

    const payload =
      pathname === '/agentmemory/health'
        ? { status: 'healthy', version: '0.9.29' }
        : pathname === '/agentmemory/smart-search'
          ? {
              results: [
                { title: 'compatibility', narrative: 'bundled Pi route works', type: 'fact', score: 0.9 },
              ],
            }
          : { ok: true };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
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

async function loadFactory(runtime) {
  const { createJiti } = await import(
    pathToFileURL(`${runtime.pi}/lib/node_modules/jiti/lib/jiti.mjs`).href,
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      typebox: `${runtime.pi}/lib/node_modules/typebox/build/index.mjs`,
    },
  });
  const module = await jiti.import(`${runtime.agentmemory}/${agentMemoryEntry}`);
  return module.default;
}

async function exerciseFactory(backend, runtime) {
  const ownership = renderPiOwnership(backend);
  assert.equal(ownership.memoryBackend, backend);
  assert.equal(ownership.agentMemory.enabled, true);
  assert.equal(
    ownership.agentMemory.extension,
    'lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts',
  );
  assert.equal(ownership.agentMemory.url, 'http://127.0.0.1:3111');
  assert.equal(ownership.agentMemory.secretReference, 'agentmemory-bearer');

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
    await events.get('before_agent_start')(
      {
        prompt: 'find the compatibility decision',
        systemPrompt: 'base prompt',
        systemPromptOptions: { cwd: repoRoot },
      },
      context,
    );
    await tools.get('memory_health').execute('health-call', {});
    await tools.get('memory_search').execute('search-call', { query: 'compatibility', limit: 5 });
    await tools.get('memory_save').execute('save-call', { content: 'route coverage', type: 'fact' });
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
    await waitForRequests(mock.requests, 12);

    assert.deepEqual([...new Set(mock.requests.map((request) => request.pathname))].sort(), [
      '/agentmemory/consolidate',
      '/agentmemory/health',
      '/agentmemory/observe',
      '/agentmemory/remember',
      '/agentmemory/session/end',
      '/agentmemory/session/start',
      '/agentmemory/smart-search',
    ]);
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

test('bundled AgentMemory Pi integration uses authenticated standard routes in AgentMemory mode', async () => {
  await exerciseFactory('agentmemory', buildRuntimePaths());
});

test('bundled AgentMemory Pi integration remains active during OpenCode cavemem rollback', async () => {
  await exerciseFactory('cavemem', buildRuntimePaths());
});
