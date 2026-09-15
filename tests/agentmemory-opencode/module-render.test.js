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
       ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
       "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
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
         };
         home.opencode.memoryBackend = "${enable ? 'agentmemory' : 'cavemem'}";
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
  agentmemoryCliPackages = builtins.filter (
    package: (package.name or "") == "agentmemory"
  ) hm.home.packages;
  agentmemoryCliPackage =
    if agentmemoryCliPackages == [ ] then null else builtins.head agentmemoryCliPackages;
in builtins.toJSON {
  files = builtins.attrNames hm.home.file;
  configFiles = builtins.attrNames hm.xdg.configFile;
  configTexts = configTexts;
  plugin = plugin;
  activation = builtins.attrNames hm.home.activation;
  packages = map (package: package.name or "") hm.home.packages;
  agentmemoryCli = if agentmemoryCliPackage == null then null else {
    source = builtins.unsafeDiscardStringContext (
      builtins.readFile "\${agentmemoryCliPackage}/bin/agentmemory"
    );
  };
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
       ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
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
         home.opencode.memoryBackend = "${enable ? 'agentmemory' : 'cavemem'}";
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

function renderConsumerCutover({ enable, augmentationEnabled }) {
  const nixBoolean = enable ? 'true' : 'false';
  const augmentationOverride =
    augmentationEnabled === undefined
      ? ''
      : `augmentationEnabled = ${augmentationEnabled ? 'true' : 'false'};`;
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
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
         programs.agentmemory.enable = ${nixBoolean};
         home.opencode.memoryBackend = "${enable ? 'agentmemory' : 'cavemem'}";
        programs.session-compaction = {
          enable = true;
          thresholdTokens = 123456;
          thresholdWallTimeHours = 7;
          cooldownMinutes = 19;
          ${augmentationOverride}
        };
      }
    ];
  }).config;
in builtins.toJSON {
  wrapper = builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands;
  command = toString hm.programs.opencode.commands.compact;
  augmentationEnabled = hm.programs.session-compaction.augmentationEnabled;
  agents = builtins.attrNames hm.programs.opencode.agents;
  context = hm.programs.opencode.context;
  memorySync = {
    enable = hm.programs.memory-sync.enable;
    packageNames = map (package: package.name or "") hm.home.packages;
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

test('enabled AgentMemory rendering is deterministic and declarative', () => {
  const first = renderModule({ enable: true });
  const second = renderModule({ enable: true });

  assert.deepEqual(first, second);
  assert.match(first.files.join('\n'), /\/tmp\/agentmemory\/runtime\/\.env/);
  assert.ok(first.activation.includes('agentmemoryLogDir'));
  assert.equal(first.activation.includes('agentmemory-import-obsidian'), false);
  assert.ok(first.packages.some((name) => name.startsWith('agentmemory-')));
  assert.ok(first.packages.includes('agentmemory-import-cavemem'));
  assert.ok(first.packages.includes('agentmemory-import-obsidian'));
  assert.match(first.agentmemoryCli.source, /AGENTMEMORY_SECURITY_BIN/);
  assert.match(first.agentmemoryCli.source, /find-generic-password -s mcpproxy -a agentmemory-bearer -w/);
  assert.match(first.agentmemoryCli.source, /agentmemory-0\.9\.29\/bin\/agentmemory/);
  assert.equal(first.launchd.label, 'dev.dwsr.agentmemory');
  assert.match(first.launchd.programArguments.at(-1), /\/bin\/agentmemory$/);
  assert.doesNotMatch(JSON.stringify(first.launchd), /agentmemory-import-obsidian/);
  assert.equal(first.launchd.environment.AGENTMEMORY_DATA_DIR, '/tmp/agentmemory/data');
  assert.equal(first.launchd.environment.AGENTMEMORY_RUNTIME_DIR, '/tmp/agentmemory/runtime');
  assert.equal(first.launchd.environment.III_REST_PORT, '35111');
  assert.equal(first.launchd.environment.III_STREAM_PORT, '35112');
  assert.equal(first.launchd.environment.III_VIEWER_PORT, '35113');
  assert.equal(first.launchd.environment.III_ENGINE_PORT, '61134');
  assert.equal(first.launchd.environment.AGENTMEMORY_BM25_MAX_ENTRIES, '100000');
  assert.equal(first.launchd.environment.AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES, '50000');
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET, undefined);
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET_REFERENCE, 'agentmemory-bearer');
  assert.match(first.settings, /AGENTMEMORY_DATA_DIR=\/tmp\/agentmemory\/data/);
  assert.match(first.settings, /AGENTMEMORY_URL=http:\/\/127\.0\.0\.1:35111/);
  assert.match(first.settings, /AGENTMEMORY_SECRET_REFERENCE=agentmemory-bearer/);
  assert.match(first.settings, /AGENTMEMORY_BM25_MAX_ENTRIES=100000/);
  assert.match(first.settings, /AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES=50000/);
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
  assert.doesNotMatch(first.configTexts.join('\n'), /@agentmemory\/mcp/i);
  assert.doesNotMatch(agentMemoryModuleSource, /programs\.opencode/);
});

test('disabled AgentMemory rendering contributes no runtime files, package, or service', () => {
  const rendered = renderModule({ enable: false });

  assert.doesNotMatch(rendered.files.join('\n'), /agentmemory/);
  assert.equal(rendered.activation.includes('agentmemoryLogDir'), false);
  assert.equal(rendered.settings, null);
  assert.equal(rendered.launchd, null);
  assert.equal(rendered.agentmemoryCli, null);
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
    AGENTMEMORY_BM25_MAX_ENTRIES: '100000',
    AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES: '50000',
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

test('ConsumerCutover selects compaction source without changing native compaction wiring', () => {
  const agentMemory = renderConsumerCutover({ enable: true });
  const cavemem = renderConsumerCutover({ enable: false });

  for (const rendered of [agentMemory, cavemem]) {
    assert.match(rendered.wrapper, /SESSION_COMPACTION_THRESHOLD_TOKENS="123456"/);
    assert.match(rendered.wrapper, /SESSION_COMPACTION_THRESHOLD_WALL_HOURS="7"/);
    assert.match(rendered.wrapper, /SESSION_COMPACTION_COOLDOWN_MINUTES="19"/);
    assert.match(rendered.command, /compact\.md$/);
  }

  assert.match(
    agentMemory.wrapper,
    /SESSION_COMPACTION_AUGMENTATION_ENABLED="0"/,
    'AgentMemory selection must use native compaction without cavemem augmentation',
  );
  assert.match(
    cavemem.wrapper,
    /SESSION_COMPACTION_AUGMENTATION_ENABLED="1"/,
    'cavemem selection must retain the prior augmentation source',
  );
  assert.equal(
    agentMemory.command,
    cavemem.command,
    'backend selection must not change /compact command wiring',
  );
});

test('ConsumerCutover forces AgentMemory augmentation off without changing cavemem overrides', () => {
  const agentMemoryOverride = renderConsumerCutover({
    enable: true,
    augmentationEnabled: true,
  });
  const cavememOverride = renderConsumerCutover({
    enable: false,
    augmentationEnabled: false,
  });

  assert.match(
    agentMemoryOverride.wrapper,
    /SESSION_COMPACTION_AUGMENTATION_ENABLED="0"/,
  );
  assert.equal(agentMemoryOverride.augmentationEnabled, false);
  assert.match(
    cavememOverride.wrapper,
    /SESSION_COMPACTION_AUGMENTATION_ENABLED="0"/,
  );
  assert.equal(cavememOverride.augmentationEnabled, false);
});

test('ConsumerCutover removes synthesis and sync consumers only in AgentMemory mode', () => {
  const agentMemory = renderConsumerCutover({ enable: true });
  const cavemem = renderConsumerCutover({ enable: false });

  assert.equal(agentMemory.agents.includes('vault-synthesizer'), false);
  assert.equal(agentMemory.agents.includes('vault-curator'), true);
  assert.equal(agentMemory.memorySync.enable, false);
  assert.deepEqual(
    agentMemory.memorySync.packageNames.filter((name) => /memory-sync/.test(name)),
    [],
  );

  assert.equal(cavemem.agents.includes('vault-synthesizer'), true);
  assert.equal(cavemem.agents.includes('vault-curator'), true);
  assert.equal(cavemem.memorySync.enable, true);
  assert.equal(
    cavemem.memorySync.packageNames.filter((name) => /memory-sync/.test(name)).length,
    1,
  );

  for (const rendered of [agentMemory, cavemem]) {
    assert.match(rendered.context, /## Obsidian Memory Recall/);
    assert.match(rendered.context, /## Obsidian Tool Reference/);
    assert.match(
      rendered.context,
      /automatic (?:AgentMemory|ambient-backend)-to-Obsidian promotion is not provided/,
    );
  }
});
