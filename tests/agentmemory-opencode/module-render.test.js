'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const agentMemoryModuleSource = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/agentmemory.nix'),
  'utf8',
);

function renderModule({ enable }) {
  const nixBoolean = enable ? 'true' : 'false';
  const settingsPath = '/tmp/agentmemory/runtime/.env';
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
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        programs.agentmemory = {
          enable = ${nixBoolean};
          dataDir = "/tmp/agentmemory/data";
          runtimeDir = "/tmp/agentmemory/runtime";
          logDir = "/tmp/agentmemory/logs";
          restPort = 35111;
          streamPort = 35112;
          viewerPort = 35113;
          enginePort = 61134;
          bearerReference = "agentmemory-bearer";
          backupDestination = "/tmp/agentmemory/backups";
        };
      }
    ];
  }).config;
  settingsPath = ${JSON.stringify(settingsPath)};
  pluginPath = "opencode/plugins/agentmemory-capture.ts";
  agent = if builtins.hasAttr "agentmemory" hm.launchd.agents then hm.launchd.agents.agentmemory else null;
  plugin = if builtins.hasAttr pluginPath hm.xdg.configFile then {
    source = toString hm.xdg.configFile.${JSON.stringify("opencode/plugins/agentmemory-capture.ts")}.source;
    sourceText = builtins.readFile hm.xdg.configFile.${JSON.stringify("opencode/plugins/agentmemory-capture.ts")}.source;
  } else null;
  configTexts = builtins.attrValues (builtins.mapAttrs (_: value: value.text or "") hm.xdg.configFile);
in builtins.toJSON {
  files = builtins.attrNames hm.home.file;
  configFiles = builtins.attrNames hm.xdg.configFile;
  configTexts = configTexts;
  plugin = plugin;
  activation = builtins.attrNames hm.home.activation;
  packages = map (package: package.name or "") hm.home.packages;
  settings = if builtins.hasAttr settingsPath hm.home.file then hm.home.file.${JSON.stringify(settingsPath)}.text else null;
  launchd = if agent == null then null else {
    label = agent.config.Label;
    programArguments = agent.config.ProgramArguments;
    environment = agent.config.EnvironmentVariables;
  };
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

function renderStockMcpModule({ enable }) {
  const nixBoolean = enable ? 'true' : 'false';
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
      "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
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
          enable = ${nixBoolean};
          restPort = 35111;
        };
        programs.opencode.settings.mcp.mcpproxy = {
          type = "remote";
          url = "http://127.0.0.1:8080/mcp";
          enabled = true;
        };
      }
    ];
  }).config;
  mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile.${JSON.stringify("mcpproxy/mcp_config.json")}.text);
  agentMemoryServers = builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers;
in builtins.toJSON {
  mcpConfig = mcpConfig;
  agentMemory = if agentMemoryServers == [ ] then null else builtins.head agentMemoryServers;
  opencodeMcp = hm.programs.opencode.settings.mcp or { };
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

test('enabled AgentMemory rendering is deterministic and declarative', () => {
  const first = renderModule({ enable: true });
  const second = renderModule({ enable: true });

  assert.deepEqual(first, second);
  assert.match(first.files.join('\n'), /\/tmp\/agentmemory\/runtime\/\.env/);
  assert.ok(first.activation.includes('agentmemoryLogDir'));
  assert.ok(first.packages.some((name) => name.startsWith('agentmemory-')));
  assert.equal(first.launchd.label, 'dev.dwsr.agentmemory');
  assert.match(first.launchd.programArguments.at(-1), /\/bin\/agentmemory$/);
  assert.equal(first.launchd.environment.AGENTMEMORY_DATA_DIR, '/tmp/agentmemory/data');
  assert.equal(first.launchd.environment.AGENTMEMORY_RUNTIME_DIR, '/tmp/agentmemory/runtime');
  assert.equal(first.launchd.environment.III_REST_PORT, '35111');
  assert.equal(first.launchd.environment.III_STREAM_PORT, '35112');
  assert.equal(first.launchd.environment.III_VIEWER_PORT, '35113');
  assert.equal(first.launchd.environment.III_ENGINE_PORT, '61134');
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET, undefined);
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET_REFERENCE, 'agentmemory-bearer');
  assert.match(first.settings, /AGENTMEMORY_DATA_DIR=\/tmp\/agentmemory\/data/);
  assert.match(first.settings, /AGENTMEMORY_URL=http:\/\/127\.0\.0\.1:35111/);
  assert.match(first.settings, /AGENTMEMORY_BACKUP_DESTINATION=\/tmp\/agentmemory\/backups/);
  assert.match(first.settings, /AGENTMEMORY_SECRET_REFERENCE=agentmemory-bearer/);
  assert.doesNotMatch(first.settings, /connect opencode/);
  const pluginFiles = first.configFiles.filter((file) => file.startsWith('opencode/plugins/') && file.includes('agentmemory'));
  assert.deepEqual(pluginFiles, ['opencode/plugins/agentmemory-capture.ts']);
  assert.ok(first.plugin);
  assert.match(
    first.plugin.source,
    /\/lib\/node_modules\/@agentmemory\/agentmemory\/plugin\/opencode\/agentmemory-capture\.ts$/,
  );
  assert.match(first.plugin.sourceText, /export const AgentmemoryCapturePlugin/);
  assert.doesNotMatch(first.configTexts.join('\n'), /connect opencode/);
  assert.doesNotMatch(first.configTexts.join('\n'), /@agentmemory\/mcp|agentmemory.*mcp/i);
  assert.doesNotMatch(agentMemoryModuleSource, /programs\.opencode/);
});

test('disabled AgentMemory rendering contributes no runtime files, package, or service', () => {
  const rendered = renderModule({ enable: false });

  assert.doesNotMatch(rendered.files.join('\n'), /agentmemory/);
  assert.equal(rendered.activation.includes('agentmemoryLogDir'), false);
  assert.equal(rendered.settings, null);
  assert.equal(rendered.launchd, null);
  assert.equal(rendered.packages.some((name) => name.startsWith('agentmemory-')), false);
  assert.equal(rendered.plugin, null);
  assert.deepEqual(
    rendered.configFiles.filter((file) => file.startsWith('opencode/plugins/') && file.includes('agentmemory')),
    [],
  );
});

test('enabled AgentMemory registers the stock core shim through mcpproxy only', () => {
  const rendered = renderStockMcpModule({ enable: true });
  const server = rendered.agentMemory;

  assert.ok(server);
  assert.equal(server.protocol, 'stdio');
  assert.match(server.command, /\/bin\/agentmemory-mcp$/);
  assert.deepEqual(server.args, []);
  assert.deepEqual(server.env, {
    AGENTMEMORY_URL: 'http://127.0.0.1:35111',
    AGENTMEMORY_SECRET: '${env:AGENTMEMORY_BEARER}',
    AGENTMEMORY_TOOLS: 'core',
  });
  assert.equal(server.enabled, true);
  assert.equal(server.quarantined, false);
  assert.equal(rendered.mcpConfig.routing_mode, 'retrieve_tools');
  assert.equal(rendered.mcpConfig.quarantine_enabled, false);
  assert.deepEqual(Object.keys(rendered.opencodeMcp), ['mcpproxy']);
  assert.equal(rendered.opencodeMcp.agentmemory, undefined);
  assert.deepEqual(Object.keys(server).sort(), [
    'args',
    'command',
    'enabled',
    'env',
    'name',
    'protocol',
    'quarantined',
  ]);
  assert.doesNotMatch(JSON.stringify(rendered.mcpConfig), /op:\/\/Private\/AgentMemory\/Bearer/);
  assert.doesNotMatch(JSON.stringify(rendered.mcpConfig), /test-secret/);
});

test('disabled AgentMemory contributes no stock MCP registration', () => {
  const rendered = renderStockMcpModule({ enable: false });

  assert.equal(rendered.agentMemory, null);
  assert.equal(rendered.mcpConfig.mcpServers.some((server) => server.name === 'agentmemory'), false);
  assert.deepEqual(Object.keys(rendered.opencodeMcp), ['mcpproxy']);
  assert.equal(rendered.opencodeMcp.agentmemory, undefined);
});
