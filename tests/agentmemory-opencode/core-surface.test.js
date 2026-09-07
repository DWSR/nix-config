'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const smokeSecret = 'agentmemory-core-surface-secret';
const expectedCoreTools = [
  'memory_consolidate',
  'memory_diagnose',
  'memory_lesson_save',
  'memory_recall',
  'memory_reflect',
  'memory_save',
  'memory_sessions',
  'memory_smart_search',
];

function packageRoot(attribute, environmentName) {
  if (process.env[environmentName]) return process.env[environmentName];

  return execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', `.#darwinConfigurations.ShopifyLaptop.pkgs.${attribute}`],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
}

function renderIntegration() {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [ flake.outputs.overlays.custom-packages ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        home.mcp = {
          obsidianVaultPath = "/tmp/agentmemory/vault";
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
        };
        programs.agentmemory = {
          enable = true;
          dataDir = "/tmp/agentmemory/data";
          runtimeDir = "/tmp/agentmemory/runtime";
          logDir = "/tmp/agentmemory/logs";
          restPort = 35111;
          streamPort = 35112;
          viewerPort = 35113;
          enginePort = 61134;
          bearerReference = "agentmemory-bearer";
        };
      }
    ];
  }).config;
  mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text);
in builtins.toJSON {
  launchdEnvironment = hm.launchd.agents.agentmemory.config.EnvironmentVariables;
  settings = hm.home.file."/tmp/agentmemory/runtime/.env".text;
  agentmemoryServer = builtins.head (builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers);
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
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
  for (let index = 0; index < count; index += 1) ports.push(await freePort());
  return ports;
}

async function waitForHttp(url, child, output, options = {}, predicate = (response) => response.ok) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
      if (predicate(response)) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${url} did not become ready (${lastError})\n${output.stderr}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function stopAgentMemory(packagePath, directory, environment, restPort) {
  spawnSync(
    path.join(packagePath, 'bin/agentmemory'),
    ['stop', '--force', '--port', String(restPort)],
    {
      cwd: directory,
      env: { ...environment, AGENTMEMORY_DATA_DIR: path.join(directory, 'data') },
      stdio: 'ignore',
      timeout: 5_000,
    },
  );
}

async function listProxyTools(harness) {
  const deadline = Date.now() + 30_000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = spawnSync(
      path.join(harness.mcpproxyPackage, 'bin/mcpproxy'),
      [
        'tools',
        'list',
        '--server=agentmemory',
        '-o',
        'json',
        `--config=${harness.configPath}`,
        `--data-dir=${harness.proxyDataDir}`,
      ],
      { cwd: harness.directory, env: { ...process.env, HOME: harness.directory }, encoding: 'utf8' },
    );
    if (lastResult.status === 0) {
      const tools = JSON.parse(lastResult.stdout);
      if (tools.length > 0) return { result: lastResult, tools };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`mcpproxy tools/list did not return an upstream inventory: ${lastResult?.stderr || ''}`);
}

async function startProxyHarness(rendered) {
  const agentmemoryPackage = packageRoot('agentmemory', 'AGENTMEMORY_PACKAGE_PATH');
  const mcpproxyPackage = packageRoot('mcpproxy-go', 'MCPPROXY_PACKAGE_PATH');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-core-surface-'));
  const proxyDataDir = path.join(directory, 'proxy-data');
  fs.mkdirSync(proxyDataDir);
  const [restPort, streamPort, viewerPort, enginePort, proxyPort] = await freePorts(5);
  const output = { stderr: '' };
  const daemonEnvironment = {
    ...process.env,
    ...rendered.launchdEnvironment,
    HOME: directory,
    AGENTMEMORY_DATA_DIR: path.join(directory, 'data'),
    AGENTMEMORY_RUNTIME_DIR: path.join(directory, 'runtime'),
    AGENTMEMORY_PROVIDER: 'noop',
    AGENTMEMORY_SECRET: smokeSecret,
    AGENTMEMORY_AUTO_COMPRESS: 'false',
    CONSOLIDATION_ENABLED: 'false',
    GRAPH_EXTRACTION_ENABLED: 'false',
    III_REST_PORT: String(restPort),
    III_STREAM_PORT: String(streamPort),
    III_VIEWER_PORT: String(viewerPort),
    III_ENGINE_PORT: String(enginePort),
  };
  const daemon = spawn(
    path.join(agentmemoryPackage, 'bin/agentmemory'),
    ['--port', String(restPort), '--data-dir', path.join(directory, 'data')],
    { cwd: directory, env: daemonEnvironment, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', (chunk) => { output.stderr += chunk; });

  const baseUrl = `http://127.0.0.1:${restPort}`;
  const proxyConfig = {
    listen: `127.0.0.1:${proxyPort}`,
    routing_mode: 'retrieve_tools',
    quarantine_enabled: false,
    require_mcp_auth: false,
    mcpServers: [
      {
        ...rendered.agentmemoryServer,
        command: path.join(agentmemoryPackage, 'bin/agentmemory-mcp'),
        env: {
          ...rendered.agentmemoryServer.env,
          AGENTMEMORY_URL: baseUrl,
          AGENTMEMORY_SECRET: smokeSecret,
        },
      },
    ],
  };
  const configPath = path.join(directory, 'mcp_config.json');
  fs.writeFileSync(configPath, JSON.stringify(proxyConfig));
  let proxy;
  try {
    await waitForHttp(
      `${baseUrl}/agentmemory/health`,
      daemon,
      output,
      { headers: { Authorization: `Bearer ${smokeSecret}` } },
    );
    await waitForHttp(
      `${baseUrl}/agentmemory/mcp/tools`,
      daemon,
      output,
      { headers: { Authorization: `Bearer ${smokeSecret}` } },
    );

    proxy = spawn(
      path.join(mcpproxyPackage, 'bin/mcpproxy'),
      [
        'serve',
        `--config=${configPath}`,
        `--data-dir=${proxyDataDir}`,
        `--listen=127.0.0.1:${proxyPort}`,
        '--log-to-file=false',
        '--allow-server-add=false',
        '--allow-server-remove=false',
      ],
      { cwd: directory, env: { ...process.env, HOME: directory }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    proxy.stderr.setEncoding('utf8');
    proxy.stderr.on('data', (chunk) => { output.stderr += chunk; });

    await waitForHttp(`http://127.0.0.1:${proxyPort}/healthz`, proxy, output);
  } catch (error) {
    stopAgentMemory(agentmemoryPackage, directory, daemonEnvironment, restPort);
    if (proxy) await stopChild(proxy);
    await stopChild(daemon);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    agentmemoryPackage,
    mcpproxyPackage,
    baseUrl,
    configPath,
    directory,
    proxyDataDir,
    daemon,
    proxy,
    output,
    async close() {
      stopAgentMemory(agentmemoryPackage, directory, daemonEnvironment, restPort);
      await stopChild(proxy);
      await stopChild(daemon);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('healthy mcpproxy tools/list exposes exactly the daemon core inventory', async () => {
  const rendered = renderIntegration();
  assert.deepEqual(rendered.agentmemoryServer.env, {
    AGENTMEMORY_URL: 'http://127.0.0.1:35111',
    AGENTMEMORY_SECRET: '${env:AGENTMEMORY_BEARER}',
    AGENTMEMORY_TOOLS: 'core',
  });
  assert.match(rendered.settings, /AGENTMEMORY_TOOLS=core/);

  const harness = await startProxyHarness(rendered);
  try {
    const { result, tools } = await listProxyTools(harness);
    assert.equal(result.status, 0, `${result.stderr}\n${harness.output.stderr}`);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedCoreTools, harness.output.stderr);
    assert.equal(tools.length, expectedCoreTools.length);
    assert.equal(rendered.launchdEnvironment.AGENTMEMORY_TOOLS, 'core');
    assert.ok(!names.includes('memory_export'));
    assert.ok(!names.includes('memory_governance_delete'));
  } finally {
    await harness.close();
  }
});
