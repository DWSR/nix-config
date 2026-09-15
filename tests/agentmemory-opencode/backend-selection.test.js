'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function renderBackend(backend) {
  const backendOption = backend === undefined ? '' : `home.opencode.memoryBackend = "${backend}";`;
  const memorySyncEnabled = backend !== 'agentmemory';
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
      "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode-nono.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/session-compaction.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/memory-sync.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/cavemem.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        home.mcp = {
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
         programs.opencode-nono.enable = true;
         programs.memory-sync.enable = ${memorySyncEnabled};
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

test('the selector defaults to the retained cavemem OpenCode backend', () => {
  const rendered = renderBackend(undefined);

  assert.equal(rendered.backend, 'cavemem');
  assert.deepEqual(rendered.capturePlugins, ['opencode/plugins/cavemem.js']);
  assert.equal(rendered.agentMemory.job.config.Label, 'dev.dwsr.agentmemory');
  assert.equal(rendered.agentMemory.serverCount, 1);
  assert.ok(rendered.agentMemory.packageNames.some((name) => name.startsWith('agentmemory')));
  assert.equal(rendered.memorySync.enable, true);
});

test('AgentMemory mode owns OpenCode capture and consumers', () => {
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
  for (const text of Object.values(rendered.nonoProfiles)) {
    const profile = JSON.parse(text);
    assert.ok(profile.network.open_port.includes(3111));
    assert.ok(profile.environment.allow_vars.includes('AGENTMEMORY_SECRET'));
    assert.doesNotMatch(text, /CAVEMEM_DATA_DIR|local\/share\/cavemem/);
  }
  assert.match(rendered.context, /## Obsidian Memory Recall/);
  assert.match(rendered.context, /## Tag Guidelines/);
});
