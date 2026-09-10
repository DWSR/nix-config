'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});
let renderedHosts;

function renderHosts() {
  if (renderedHosts) return renderedHosts;

  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      lib = flake.inputs.nixpkgs.lib;
      summarizeConfig = hm:
        let
          agentmemory = hm.programs.agentmemory;
          pi = hm.programs.pi-agent;
          agentmemoryJob = hm.launchd.agents.agentmemory;
          settingsPath = "\${agentmemory.runtimeDir}/.env";
          mcpConfig = builtins.fromJSON (builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text);
          cavememServers = builtins.filter (server: server.name == "cavemem") mcpConfig.mcpServers;
          agentTexts = builtins.mapAttrs (_: value:
            if builtins.typeOf value == "path" then builtins.readFile value else value
          ) hm.programs.opencode.agents;
        in
        {
          backend = hm.home.opencode.memoryBackend;
          cavememEnabled = hm.home.cavemem.enable;
          homeDirectory = hm.home.homeDirectory;
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
              backupDestination
              ;
            settings = hm.home.file.\${settingsPath}.text;
            launchd = {
              inherit (agentmemoryJob.config) Label EnvironmentVariables;
              };
            };
          cavemem = {
            dataDir = hm.home.cavemem.dataDir;
            packageNames = map (package: package.name or "") hm.home.packages;
            serverCount = builtins.length cavememServers;
            settings = builtins.hasAttr "\${hm.home.cavemem.dataDir}/settings.json" hm.home.file;
          };
          opencode = {
            agents = builtins.attrNames hm.programs.opencode.agents;
            agentTextHasCavemem = builtins.any (text: lib.hasInfix "cavemem" text) (builtins.attrValues agentTexts);
            contextHasCavemem = lib.hasInfix "Ambient capture (cavemem)" hm.programs.opencode.context;
            contextHasStockAgentMemory = lib.hasInfix "stock AgentMemory" hm.programs.opencode.context;
            wrapperHasAgentMemoryPreflight = lib.hasInfix "AgentMemory daemon preflight failed" (builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands);
            wrapperHasCavememPreflight = lib.hasInfix "cavemem MCP server not reachable" (builtins.concatStringsSep "\\n" hm.home.opencode.wrapperCommands);
          };
          consumers = {
            memorySync = hm.programs.memory-sync.enable;
            sessionCompactionAugmentation = hm.programs.session-compaction.augmentationEnabled;
          };
          pi = {
            inherit (pi) enable agentMemory;
            internal = {
              url = pi.internal.agentMemoryUrl;
              secretReference = pi.internal.agentMemorySecretReference;
              extension = pi.extensions.agentmemory.relativePath;
            };
          };
          secretUri = builtins.getAttr "agentmemory-bearer" hm.home.mcp.keychainSecrets;
          rollbackCommand =
            if agentmemory.rollbackPackage == null then
              null
            else
              "\${agentmemory.rollbackPackage}/bin/opencode-cavemem-rollback";
          rollbackCommandInstalled =
            agentmemory.rollbackPackage != null && builtins.elem agentmemory.rollbackPackage hm.home.packages;
          capturePlugins = builtins.filter (name:
            builtins.match "opencode/plugins/(cavemem\\.js|agentmemory-.*)" name != null
          ) (builtins.attrNames hm.xdg.configFile);
        };
      summarize = host:
        let
          hm = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
        in
        summarizeConfig hm // {
          rollback = summarizeConfig hm.specialisation."opencode-cavemem-rollback".configuration;
        };
    in builtins.toJSON {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
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

test('both hosts cut OpenCode and Pi over to equivalent AgentMemory runtime wiring', () => {
  const rendered = renderHosts();
  const personal = rendered.personal;
  const shopify = rendered.shopify;

  for (const [host, config] of Object.entries(rendered)) {
    assert.equal(config.backend, 'agentmemory', `${host} selects AgentMemory for OpenCode`);
    assert.equal(config.cavememEnabled, false, `${host} does not enable normal cavemem runtime`);
    assert.equal(config.agentmemory.enable, true, `${host} enables AgentMemory`);
    assert.equal(config.agentmemory.dataDir, config.expectedDataDir);
    assert.equal(config.agentmemory.runtimeDir, config.expectedRuntimeDir);
    assert.equal(config.agentmemory.logDir, config.expectedLogDir);
    assert.equal(config.agentmemory.restPort, 3111);
    assert.equal(config.agentmemory.streamPort, 3112);
    assert.equal(config.agentmemory.viewerPort, 3113);
    assert.equal(config.agentmemory.enginePort, 49134);
    assert.equal(config.agentmemory.bearerReference, 'agentmemory-bearer');
    assert.equal(config.agentmemory.launchd.Label, 'dev.dwsr.agentmemory');
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_DATA_DIR, config.agentmemory.dataDir);
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_RUNTIME_DIR, config.agentmemory.runtimeDir);
    assert.equal(config.agentmemory.launchd.EnvironmentVariables.AGENTMEMORY_SECRET_REFERENCE, 'agentmemory-bearer');
    assert.match(config.agentmemory.settings, /AGENTMEMORY_DATA_DIR=/);
    assert.doesNotMatch(config.agentmemory.settings, /AGENTMEMORY_SECRET=/);
    assert.equal(config.pi.enable, true, `${host} enables Pi`);
    assert.equal(config.pi.agentMemory.restPort, 3111);
    assert.equal(config.pi.agentMemory.secretReference, 'agentmemory-bearer');
    assert.equal(config.pi.internal.url, 'http://127.0.0.1:3111');
    assert.equal(config.pi.internal.secretReference, 'agentmemory-bearer');
    assert.equal(config.pi.internal.extension, 'lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts');
    assert.deepEqual(config.capturePlugins, ['opencode/plugins/agentmemory-capture.ts']);
    assert.match(config.secretUri, /^op:\/\/(Private|Employee)\/AgentMemory\/Bearer$/);
    assert.doesNotMatch(JSON.stringify(config), /bearer-value|test-secret|sk-[A-Za-z0-9]/i);
  }

  assert.equal(personal.secretUri, 'op://Private/AgentMemory/Bearer');
  assert.equal(shopify.secretUri, 'op://Employee/AgentMemory/Bearer');
  assert.equal(personal.agentmemory.backupDestination, null);
  assert.equal(
    shopify.agentmemory.backupDestination,
    `${shopify.homeDirectory}/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/agentmemory-backup`,
  );

  const equivalentAgentMemory = config => ({
    ...config.agentmemory,
    backupDestination: null,
    settings: config.agentmemory.settings.replace(/^AGENTMEMORY_BACKUP_DESTINATION=.*\n/m, ''),
  });
  assert.deepEqual(personal.backend, shopify.backend);
  assert.deepEqual(personal.cavememEnabled, shopify.cavememEnabled);
  assert.deepEqual(equivalentAgentMemory(personal), equivalentAgentMemory(shopify));
  for (const field of ['pi', 'capturePlugins']) {
    assert.deepEqual(
      personal[field],
      shopify[field],
      `${field} is equivalent across hosts except declared secret and backup destination values`,
    );
  }
});

test('both real hosts render a complete data-preserving cavemem OpenCode rollback specialisation', () => {
  const rendered = renderHosts();

  for (const [host, normal] of Object.entries(rendered)) {
    const rollback = normal.rollback;

    assert.equal(rollback.backend, 'cavemem', `${host} rollback selects cavemem`);
    assert.equal(rollback.cavememEnabled, true, `${host} rollback enables the cavemem module`);
    assert.equal(rollback.cavemem.settings, true, `${host} rollback renders cavemem settings`);
    assert.equal(rollback.cavemem.serverCount, 1, `${host} rollback registers cavemem with mcpproxy`);
    assert.ok(
      rollback.cavemem.packageNames.some((name) => name.startsWith('cavemem')),
      `${host} rollback installs cavemem`,
    );
    assert.ok(
      rollback.cavemem.packageNames.some((name) => name.startsWith('cavemem-smoke-test')),
      `${host} rollback installs the cavemem check`,
    );
    assert.deepEqual(rollback.capturePlugins, ['opencode/plugins/cavemem.js']);
    assert.equal(rollback.opencode.wrapperHasCavememPreflight, true);
    assert.equal(rollback.opencode.wrapperHasAgentMemoryPreflight, false);
    assert.equal(rollback.opencode.contextHasCavemem, true);
    assert.equal(rollback.opencode.contextHasStockAgentMemory, false);
    assert.equal(rollback.opencode.agents.includes('vault-synthesizer'), true);
    assert.equal(rollback.opencode.agentTextHasCavemem, true);
    assert.equal(rollback.consumers.memorySync, true);
    assert.equal(rollback.consumers.sessionCompactionAugmentation, true);
    assert.equal(rollback.agentmemory.dataDir, normal.agentmemory.dataDir);
    assert.equal(rollback.cavemem.dataDir, normal.cavemem.dataDir);
    assert.match(normal.rollbackCommand, /^\/nix\/store\/.*\/bin\/opencode-cavemem-rollback$/);
    assert.equal(normal.rollbackCommandInstalled, true);
    assert.equal(rollback.rollbackCommand, null);
    assert.equal(rollback.rollbackCommandInstalled, false);
  }
});
