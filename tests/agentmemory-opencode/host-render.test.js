'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
});
let renderedHosts;

function renderHosts() {
  if (renderedHosts) return renderedHosts;
  if (process.env.AGENTMEMORY_MATRIX_HOSTS) {
    const rows = JSON.parse(fs.readFileSync(process.env.AGENTMEMORY_MATRIX_HOSTS, 'utf8'));
    renderedHosts = { personal: rows.personal.hostRender };
    return renderedHosts;
  }

  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      lib = flake.inputs.nixpkgs.lib;
      summarizeConfig = hm:
        let
          agentmemory = hm.programs.agentmemory;
          agentmemoryJob = hm.launchd.agents.agentmemory;
          mcpproxyJob = hm.launchd.agents.mcpproxy;
          settingsPath = "\${agentmemory.runtimeDir}/.env";
          mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text);
          packageNames = map (package: package.name or "") hm.home.packages;
          agentmemoryLaunchers = builtins.filter (
            package: (package.name or "") == "agentmemory"
          ) hm.home.packages;
          agentmemoryLauncherText =
            if agentmemoryLaunchers == [ ] then
              ""
            else
              builtins.unsafeDiscardStringContext (
                builtins.readFile "\${builtins.head agentmemoryLaunchers}/bin/agentmemory"
              );
         in
         {
          homeDirectory = hm.home.homeDirectory;
          mcp = {
            serverNames = map (server: server.name) mcpConfig.mcpServers;
            inherit packageNames;
            obsidianPackageNames = builtins.filter (name: lib.hasInfix "mcp-obsidian" name) packageNames;
            obsidianVaultPathConfigured = builtins.hasAttr "obsidianVaultPath" hm.home.mcp;
            retiredPipelinePackages = builtins.filter (name:
              builtins.elem name [ "memory-sync" "cavemem-import-vault" ]
            ) packageNames;
            launchdEnvironment = mcpproxyJob.config.EnvironmentVariables;
          };
          expectedDataDir = "\${hm.xdg.dataHome}/agentmemory";
          expectedRuntimeDir = "\${hm.home.homeDirectory}/.agentmemory";
          expectedLogDir = "\${hm.home.homeDirectory}/Library/Logs/agentmemory";
          agentmemory = {
            inherit (agentmemory)
              enable
              dataDir
              runtimeDir
              logDir
              restPort
              streamPort
              viewerPort
              enginePort
              bearerReference
              ;
            launcherText = agentmemoryLauncherText;
            hasObsidianImporter = builtins.any (
              package: (package.name or "") == "agentmemory-import-obsidian"
            ) hm.home.packages;
            settings = hm.home.file.\${settingsPath}.text;
            launchd = {
              inherit (agentmemoryJob.config) Label EnvironmentVariables;
            };
          };
           opencode = {
             agents = builtins.attrNames hm.programs.opencode.agents;
             contextHasStockAgentMemory = lib.hasInfix "stock AgentMemory" hm.programs.opencode.context;
             wrapperHasAgentMemoryPreflight = lib.hasInfix "AgentMemory daemon preflight failed" (builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands);
             wrapperHasObsidianImporter = lib.hasInfix "agentmemory-import-obsidian" (builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands);
           };
          secretUri = builtins.getAttr "agentmemory-bearer" hm.home.mcp.keychainSecrets;
          capturePlugins = builtins.filter (name:
             builtins.match "opencode/plugins/agentmemory-.*" name != null
          ) (builtins.attrNames hm.xdg.configFile);
        };
      summarize = host:
        let
          darwin = flake.darwinConfigurations.\${host}.config;
          hm = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
        in (summarizeConfig hm) // {
          casks = map (cask: cask.name) darwin.homebrew.casks;
        };
    in builtins.toJSON {
      personal = summarize "${HOSTS.personal}";
    }
  `;

  renderedHosts = JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    }),
  );
  return renderedHosts;
}

test('personal host cuts OpenCode over to AgentMemory runtime wiring', () => {
  const rendered = renderHosts();
  const personal = rendered.personal;

  for (const [host, config] of Object.entries(rendered)) {
    assert.equal(config.agentmemory.enable, true, `${host} enables AgentMemory`);
    assert.equal(config.agentmemory.dataDir, config.expectedDataDir);
    assert.equal(config.agentmemory.runtimeDir, config.expectedRuntimeDir);
    assert.equal(config.agentmemory.logDir, config.expectedLogDir);
    assert.equal(config.agentmemory.restPort, 3111);
    assert.equal(config.agentmemory.streamPort, 3112);
    assert.equal(config.agentmemory.viewerPort, 3113);
    assert.equal(config.agentmemory.enginePort, 49134);
    assert.equal(config.agentmemory.bearerReference, 'agentmemory-bearer');
    assert.match(config.agentmemory.launcherText, /Library\/Keychains\/login\.keychain-db/);
    assert.equal(config.agentmemory.hasObsidianImporter, true, `${host} exposes the managed Obsidian importer`);
    assert.equal(config.mcp.packageNames.includes('agentmemory-import-cavemem'), false, `${host} omits the retired importer`);
    assert.equal(config.opencode.wrapperHasObsidianImporter, false, `${host} does not invoke the importer at startup`);
    assert.equal(config.opencode.wrapperHasAgentMemoryPreflight, true, `${host} checks the AgentMemory daemon`);
    assert.equal(config.opencode.contextHasStockAgentMemory, true, `${host} renders AgentMemory instructions`);
    assert.equal(config.mcp.serverNames.includes('obsidian'), false, `${host} omits the Obsidian MCP server`);
    assert.equal(config.mcp.packageNames.some((name) => name.includes('mcp-obsidian')), false, `${host} omits the Obsidian MCP package`);
    assert.deepEqual(config.mcp.obsidianPackageNames, [], `${host} omits Obsidian MCP packages`);
    assert.equal(config.mcp.obsidianVaultPathConfigured, false, `${host} omits the Obsidian vault-path option`);
    assert.deepEqual(config.mcp.retiredPipelinePackages, [], `${host} omits retired memory pipeline commands`);
    assert.ok(config.mcp.serverNames.includes('agentmemory'), `${host} retains AgentMemory MCP`);
    assert.equal(config.mcp.serverNames.includes('cavemem'), false, `${host} omits the retired server`);
    assert.ok(config.mcp.serverNames.includes('github'), `${host} retains GitHub MCP`);
    assert.ok(config.mcp.serverNames.includes('time'), `${host} retains time MCP`);
    assert.ok(config.mcp.serverNames.includes('git-mcp'), `${host} retains git-mcp`);
    assert.ok(config.casks.includes('obsidian'), `${host} retains the Obsidian desktop cask`);
    assert.match(config.mcp.launchdEnvironment.MCPPROXY_CONFIG_HASH, /^[0-9a-f]{64}$/);
    assert.equal(config.agentmemory.launchd.Label, 'dev.dwsr.agentmemory');
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_DATA_DIR, config.agentmemory.dataDir);
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_RUNTIME_DIR, config.agentmemory.runtimeDir);
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_SECRET_REFERENCE, 'agentmemory-bearer');
    assert.match(config.agentmemory.settings, /AGENTMEMORY_DATA_DIR=/);
    assert.doesNotMatch(config.agentmemory.settings, /AGENTMEMORY_SECRET=/);
    assert.deepEqual(config.capturePlugins, ['opencode/plugins/agentmemory-capture.ts']);
    assert.match(config.secretUri, /^op:\/\/Private\/AgentMemory\/Bearer$/);
    assert.doesNotMatch(JSON.stringify(config), /bearer-value|test-secret|sk-[A-Za-z0-9]/i);
  }

  assert.equal(personal.secretUri, 'op://Private/AgentMemory/Bearer');
  assert.doesNotMatch(personal.agentmemory.launcherText, /OPENAI_/);
  assert.doesNotMatch(personal.agentmemory.launcherText, /ANTHROPIC_(?:API_KEY|BASE_URL|MODEL)/);
  assert.doesNotMatch(personal.agentmemory.launcherText, /AGENTMEMORY_(?:AUTO_COMPRESS|GRAPH_EXTRACTION_ENABLED)/);
  const { launcherText: _personalLauncher, ...personalAgentMemory } = personal.agentmemory;
  assert.ok(personalAgentMemory.enable);
});
