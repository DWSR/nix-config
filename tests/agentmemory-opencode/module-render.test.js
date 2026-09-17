'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const agentMemoryModuleSource = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/agentmemory.nix'),
  'utf8',
);
const mcpModuleSource = fs.readFileSync(
  path.join(repoRoot, 'home-manager/mcp/default.nix'),
  'utf8',
);
const mcpOverlaySource = fs.readFileSync(
  path.join(repoRoot, 'overlays/mcp-servers.nix'),
  'utf8',
);
const commonDefaultSource = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/default.nix'),
  'utf8',
);
const cavememModuleSource = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/cavemem.nix'),
  'utf8',
);
const flakeSource = fs.readFileSync(path.join(repoRoot, 'flake.nix'), 'utf8');

const retiredPipelineNames = Object.freeze({
  sync: ['memory', 'sync'].join('-'),
  vaultImporter: ['cavemem', 'import', 'vault'].join('-'),
  vaultOption: ['obsidian', 'Vault', 'Path'].join(''),
  curator: ['vault', 'curator'].join('-'),
  synthesizer: ['vault', 'synthesizer'].join('-'),
});

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

function renderStockMcpModule({ enable, addInventoryServer = false }) {
  const nixBoolean = enable ? 'true' : 'false';
  const inventoryServer = addInventoryServer
    ? `{ "inventory-change" = { command = "/bin/true"; }; }`
    : `{ }`;
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
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
          extraServers = ${inventoryServer};
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
  mcpConfigText = builtins.unsafeDiscardStringContext hm.xdg.configFile.${JSON.stringify("mcpproxy/mcp_config.json")}.text;
  mcpConfig = builtins.fromJSON mcpConfigText;
  agentMemoryServers = builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers;
  mcpproxyJob = hm.launchd.agents.mcpproxy;
in builtins.toJSON {
  mcpConfigText = mcpConfigText;
  mcpConfig = mcpConfig;
  agentMemory = if agentMemoryServers == [ ] then null else builtins.head agentMemoryServers;
  opencodeMcp = hm.programs.opencode.settings.mcp or { };
  packages = map (package: package.name or "") hm.home.packages;
  mcpproxy = {
    environment = mcpproxyJob.config.EnvironmentVariables;
    programArguments = mcpproxyJob.config.ProgramArguments;
    wrapperText = builtins.unsafeDiscardStringContext (
      builtins.readFile (builtins.head mcpproxyJob.config.ProgramArguments)
    );
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
   })`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

test('obsolete vault pipelines are absent from active configuration', () => {
  const retiredFiles = [
    path.join(repoRoot, 'home-manager/common', `${retiredPipelineNames.sync}.nix`),
    path.join(repoRoot, 'scripts', `${retiredPipelineNames.sync}.nix`),
    path.join(repoRoot, 'tests', retiredPipelineNames.sync, 'contract.test.js'),
    path.join(repoRoot, 'scripts', `${retiredPipelineNames.vaultImporter}.js`),
    path.join(repoRoot, 'scripts', `${retiredPipelineNames.vaultImporter}.nix`),
    path.join(repoRoot, 'home-manager/common/agents', `${retiredPipelineNames.curator}.md`),
    path.join(repoRoot, 'home-manager/common/agents', `${retiredPipelineNames.synthesizer}.md`),
  ];

  for (const file of retiredFiles) {
    assert.equal(fs.existsSync(file), false, `${file} must be retired`);
  }

  for (const [name, source] of Object.entries({
    'common default module': commonDefaultSource,
    'Cavemem module': cavememModuleSource,
    flake: flakeSource,
  })) {
    for (const term of [
      retiredPipelineNames.sync,
      retiredPipelineNames.vaultImporter,
      retiredPipelineNames.vaultOption,
    ]) {
      assert.equal(source.includes(term), false, `${name} retains retired reference ${term}`);
    }
  }
});

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
  assert.equal(first.packages.includes('memory-sync'), false);
  assert.equal(first.packages.includes('cavemem-import-vault'), false);
  assert.match(first.agentmemoryCli.source, /AGENTMEMORY_SECURITY_BIN/);
  assert.match(first.agentmemoryCli.source, /AGENTMEMORY_KEYCHAIN_PATH/);
  assert.match(first.agentmemoryCli.source, /Library\/Keychains\/login\.keychain-db/);
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
  assert.equal(first.launchd.environment.AGENTMEMORY_AUTO_COMPRESS, 'false');
  assert.equal(first.launchd.environment.AGENTMEMORY_III_VERSION, '0.11.5');
  assert.equal(first.launchd.environment.OTEL_ENABLED, 'false');
  assert.equal(first.launchd.environment.OTEL_METRICS_ENABLED, 'false');
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET, undefined);
  assert.equal(first.launchd.environment.AGENTMEMORY_SECRET_REFERENCE, 'agentmemory-bearer');
  assert.match(first.settings, /AGENTMEMORY_DATA_DIR=\/tmp\/agentmemory\/data/);
  assert.match(first.settings, /AGENTMEMORY_URL=http:\/\/127\.0\.0\.1:35111/);
  assert.match(first.settings, /AGENTMEMORY_SECRET_REFERENCE=agentmemory-bearer/);
  assert.match(first.settings, /AGENTMEMORY_BM25_MAX_ENTRIES=100000/);
  assert.match(first.settings, /AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES=50000/);
  assert.match(first.settings, /AGENTMEMORY_AUTO_COMPRESS=false/);
  assert.match(first.settings, /AGENTMEMORY_III_VERSION=0\.11\.5/);
  assert.match(first.settings, /OTEL_ENABLED=false/);
  assert.match(first.settings, /OTEL_METRICS_ENABLED=false/);
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
  assert.match(server.command, /\/bin\/agentmemory$/);
  assert.deepEqual(server.args, ['mcp']);
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

test('managed MCP inventory removes Obsidian and reloads on rendered-config changes', () => {
  const rendered = renderStockMcpModule({ enable: true });
  const changed = renderStockMcpModule({ enable: true, addInventoryServer: true });
  const serverNames = rendered.mcpConfig.mcpServers.map((server) => server.name);

  assert.equal(serverNames.includes('obsidian'), false);
  assert.equal(rendered.packages.some((name) => name.includes('mcp-obsidian')), false);
  assert.ok(serverNames.includes('agentmemory'));
  assert.ok(serverNames.includes('github'));
  assert.ok(serverNames.includes('time'));
  assert.ok(serverNames.includes('instances-mcp'));
  assert.ok(serverNames.includes('git-mcp'));
  assert.match(rendered.mcpproxy.environment.MCPPROXY_CONFIG_HASH, /^[0-9a-f]{64}$/);
  assert.match(rendered.mcpproxy.wrapperText, /Library\/Keychains\/login\.keychain-db/);
  assert.equal(
    rendered.mcpproxy.environment.MCPPROXY_CONFIG_HASH,
    crypto.createHash('sha256').update(rendered.mcpConfigText).digest('hex'),
  );
  assert.notEqual(rendered.mcpConfigText, changed.mcpConfigText);
  assert.notEqual(
    rendered.mcpproxy.environment.MCPPROXY_CONFIG_HASH,
    changed.mcpproxy.environment.MCPPROXY_CONFIG_HASH,
  );
  assert.doesNotMatch(rendered.mcpConfigText, /op:\/\/|test-secret|bearer-value/i);
  assert.doesNotMatch(JSON.stringify(rendered.mcpproxy), /op:\/\/|test-secret|bearer-value/i);
   assert.doesNotMatch(
     mcpModuleSource,
     new RegExp(`mcp-${['obsidian'].join('')}|${retiredPipelineNames.vaultOption}`),
   );
  assert.doesNotMatch(mcpOverlaySource, /mcp-obsidian/);
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

test('ConsumerCutover removes vault-only agents in every backend', () => {
  const agentMemory = renderConsumerCutover({ enable: true });
  const cavemem = renderConsumerCutover({ enable: false });

  for (const rendered of [agentMemory, cavemem]) {
    assert.equal(rendered.agents.includes(retiredPipelineNames.synthesizer), false);
    assert.equal(rendered.agents.includes(retiredPipelineNames.curator), false);
  }

  for (const rendered of [agentMemory, cavemem]) {
    assert.doesNotMatch(
      rendered.context,
      /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|write-note|read-note|list-notes|search-by-tags|search-vault/i,
    );
  }
});
