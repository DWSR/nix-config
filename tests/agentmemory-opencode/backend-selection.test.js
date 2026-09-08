'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function renderBackend(backend) {
  const backendOption = backend === undefined ? '' : `home.opencode.memoryBackend = "${backend}";`;
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
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        home.mcp = {
          obsidianVaultPath = "/tmp/backend-selection/vault";
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
        };
        home.cavemem = {
          enable = true;
          dataDir = "/tmp/backend-selection/cavemem";
        };
        ${backendOption}
         programs.agentmemory = {
           enable = true;
           dataDir = "/tmp/backend-selection/agentmemory";
           runtimeDir = "/tmp/backend-selection/agentmemory-runtime";
           logDir = "/tmp/backend-selection/agentmemory-logs";
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
  agentTexts = builtins.mapAttrs (_: value:
    if builtins.typeOf value == "path" then builtins.readFile value else value
  ) hm.programs.opencode.agents;
  mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text);
  capturePlugins = builtins.filter (file:
    builtins.match "opencode/plugins/(cavemem\\.js|agentmemory-.*)" file != null
  ) (builtins.attrNames hm.xdg.configFile);
  cavememServer = builtins.filter (server: server.name == "cavemem") mcpConfig.mcpServers;
  agentMemoryServer = builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers;
   agentMemoryJob = if builtins.hasAttr "agentmemory" hm.launchd.agents then hm.launchd.agents.agentmemory else null;
   cavememSettings = builtins.hasAttr "/tmp/backend-selection/cavemem/settings.json" hm.home.file;
   piManagedConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile hm.programs.pi-agent.internal.managedConfig));
   piProfiles = {
     audit = builtins.readFile hm.programs.pi-agent.internal.profilePaths.pi-audit;
     managed = builtins.readFile hm.programs.pi-agent.internal.profilePaths.pi-managed;
     review = builtins.readFile hm.programs.pi-agent.internal.profilePaths.pi-review;
   };
   nonoProfiles = builtins.mapAttrs (_: file: file.text) {
    managed = hm.xdg.configFile."nono/profiles/opencode-managed.json";
    audit = hm.xdg.configFile."nono/profiles/opencode-audit.json";
    review = hm.xdg.configFile."nono/profiles/opencode-review.json";
  };
in builtins.toJSON {
  backend = hm.home.opencode.memoryBackend;
  capturePlugins = capturePlugins;
  wrapper = builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands;
  context = hm.programs.opencode.context;
  agentTexts = agentTexts;
  agents = builtins.attrNames hm.programs.opencode.agents;
  memorySync = {
    enable = hm.programs.memory-sync.enable;
    packageNames = map (package: package.name or "") hm.home.packages;
  };
  cavemem = {
    settings = cavememSettings;
    packageNames = map (package: package.name or "") hm.home.packages;
    serverCount = builtins.length cavememServer;
  };
   agentMemory = {
     packageNames = map (package: package.name or "") hm.home.packages;
     serverCount = builtins.length agentMemoryServer;
     job = agentMemoryJob;
   };
   pi = {
     extensionNames = builtins.attrNames hm.programs.pi-agent.extensions;
     managedConfig = piManagedConfig;
     profiles = piProfiles;
   };
   nonoProfiles = nonoProfiles;
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

function renderShopifyValidator(backend) {
  const rollbackOverride =
    backend === 'cavemem'
      ? 'home.opencode.memoryBackend = pkgs.lib.mkForce "cavemem";'
      : '';
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
      ${JSON.stringify(path.join(repoRoot, 'configurations/shopify/home-manager/default.nix'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        ${rollbackOverride}
      }
    ];
  }).config;
   validator = hm.programs.opencode.agents."yb-issue-validator";
   validationSkill = hm.xdg.configFile."opencode/skills/validate-yb-issue";
 in builtins.toJSON {
   validator = if builtins.typeOf validator == "path" then builtins.readFile validator else validator;
   skill = builtins.readFile (validationSkill.source + "/SKILL.md");
 })\n`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

test('the selector defaults to the retained cavemem OpenCode backend', () => {
  const rendered = renderBackend(undefined);

  assert.equal(rendered.backend, 'cavemem');
  assert.deepEqual(rendered.capturePlugins, ['opencode/plugins/cavemem.js']);
  assert.equal(rendered.agentMemory.job.config.Label, 'dev.dwsr.agentmemory');
  assert.equal(rendered.agentMemory.serverCount, 1);
  assert.ok(rendered.agentMemory.packageNames.some((name) => name.startsWith('agentmemory')));
  assert.equal(rendered.memorySync.enable, true);
  assert.deepEqual(rendered.pi.managedConfig.extensionOrder[0], 'agentmemory');
  assert.match(rendered.pi.managedConfig.agentMemory.url, /127\.0\.0\.1:3111/);
});

test('AgentMemory mode owns OpenCode capture while Pi owns AgentMemory', () => {
  const rendered = renderBackend('agentmemory');
  const agentText = Object.values(rendered.agentTexts).join('\n');

  assert.deepEqual(rendered.capturePlugins, ['opencode/plugins/agentmemory-capture.ts']);
  assert.match(rendered.wrapper, /AgentMemory daemon preflight failed/);
  assert.doesNotMatch(rendered.wrapper, /cavemem MCP server not reachable/);
  assert.match(rendered.context, /stock AgentMemory/i);
  assert.doesNotMatch(rendered.context, /cavemem/i);
  assert.doesNotMatch(agentText, /cavemem/i);
  assert.equal(rendered.agents.includes('vault-synthesizer'), false);
  assert.equal(rendered.memorySync.enable, false);
  assert.equal(
    rendered.memorySync.packageNames.some((name) => /memory-sync/.test(name)),
    false,
  );
  assert.equal(rendered.agentMemory.job.config.Label, 'dev.dwsr.agentmemory');
  assert.equal(rendered.agentMemory.serverCount, 1);
  assert.ok(rendered.agentMemory.packageNames.some((name) => name.startsWith('agentmemory')));
  assert.equal(rendered.cavemem.settings, true);
  assert.equal(rendered.cavemem.serverCount, 1);
  assert.ok(rendered.cavemem.packageNames.some((name) => name.startsWith('cavemem')));
  assert.deepEqual(rendered.pi.extensionNames, [
    'agentmemory',
    'backgroundTasks',
    'bashTimeout',
    'codeIntelligence',
    'mcp',
    'plan',
    'questions',
    'subagents',
    'timestamps',
  ]);
  assert.deepEqual(rendered.pi.managedConfig.extensionOrder, [
    'agentmemory',
    'mcp',
    'subagents',
    'plan',
    'timestamps',
    'bashTimeout',
    'questions',
    'codeIntelligence',
    'backgroundTasks',
  ]);
  assert.equal(rendered.pi.managedConfig.mcpEndpoint, 'http://127.0.0.1:8080/mcp');
  assert.match(rendered.pi.managedConfig.agentMemory.url, /127\.0\.0\.1:3111/);
  assert.equal(rendered.pi.managedConfig.agentMemory.secretReference, 'agentmemory-bearer');
  for (const text of Object.values(rendered.pi.profiles)) {
    assert.doesNotMatch(text, /CAVEMEM_DATA_DIR|cavemem/);
    assert.match(text, /3111/);
  }
  for (const text of Object.values(rendered.nonoProfiles)) {
    const profile = JSON.parse(text);
    assert.ok(profile.network.open_port.includes(3111));
    assert.ok(profile.environment.allow_vars.includes('AGENTMEMORY_SECRET'));
    assert.doesNotMatch(text, /CAVEMEM_DATA_DIR|local\/share\/cavemem/);
  }
  assert.match(rendered.context, /## Obsidian Memory Recall/);
  assert.match(rendered.context, /## Tag Guidelines/);
});

test('cavemem mode owns OpenCode capture and restores its consumers without AgentMemory capture', () => {
  const rendered = renderBackend('cavemem');
  const agentText = Object.values(rendered.agentTexts).join('\n');

  assert.deepEqual(rendered.capturePlugins, ['opencode/plugins/cavemem.js']);
  assert.match(rendered.wrapper, /cavemem MCP server not reachable/);
  assert.doesNotMatch(rendered.wrapper, /AgentMemory daemon preflight failed/);
  assert.match(rendered.context, /Ambient capture \(cavemem\)/);
  assert.doesNotMatch(rendered.context, /stock AgentMemory/i);
  assert.match(agentText, /cavemem/);
  assert.equal(rendered.agents.includes('vault-synthesizer'), true);
  assert.equal(rendered.memorySync.enable, true);
  assert.equal(
    rendered.memorySync.packageNames.filter((name) => /memory-sync/.test(name)).length,
    1,
  );
  assert.equal(rendered.agentMemory.job.config.Label, 'dev.dwsr.agentmemory');
  assert.equal(rendered.agentMemory.serverCount, 1);
  assert.ok(rendered.agentMemory.packageNames.some((name) => name.startsWith('agentmemory')));
  assert.equal(rendered.cavemem.settings, true);
  assert.equal(rendered.cavemem.serverCount, 1);
  assert.ok(rendered.cavemem.packageNames.some((name) => name.startsWith('cavemem')));
  for (const text of Object.values(rendered.nonoProfiles)) {
    const profile = JSON.parse(text);
    assert.equal(profile.network.open_port.includes(3111), false);
    assert.ok(profile.environment.allow_vars.includes('CAVEMEM_DATA_DIR'));
    assert.doesNotMatch(text, /AGENTMEMORY_SECRET|local\/share\/agentmemory/);
    assert.match(text, /local\/share\/cavemem/);
  }
  assert.match(rendered.context, /## Obsidian Memory Recall/);
  assert.match(rendered.context, /## Tag Guidelines/);
  assert.deepEqual(rendered.pi.managedConfig.extensionOrder[0], 'agentmemory');
  assert.match(rendered.pi.managedConfig.agentMemory.url, /127\.0\.0\.1:3111/);
});

test('Shopify host instructions follow the selected backend and preserve rollback text', () => {
  const agentMemory = renderShopifyValidator('agentmemory');
  const cavemem = renderShopifyValidator('cavemem');

  assert.match(agentMemory.validator, /Search Obsidian memories and AgentMemory/);
  assert.doesNotMatch(agentMemory.validator, /cavemem/i);
  assert.doesNotMatch(agentMemory.skill, /cavemem/i);
  assert.match(agentMemory.skill, /AgentMemory:.*search/i);
  assert.match(cavemem.validator, /Search Obsidian memories and cavemem/);
  assert.doesNotMatch(cavemem.validator, /Search Obsidian memories and AgentMemory/);
  assert.match(cavemem.skill, /Cavemem:.*search/);
  assert.doesNotMatch(cavemem.skill, /AgentMemory:.*search/i);
});
