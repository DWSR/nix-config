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

function renderHosts() {
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      summarize = host:
        let
          hm = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          agentmemory = hm.programs.agentmemory;
          pi = hm.programs.pi-agent;
          agentmemoryJob = hm.launchd.agents.agentmemory;
          settingsPath = "\${agentmemory.runtimeDir}/.env";
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
          pi = {
            inherit (pi) enable agentMemory;
            internal = {
              url = pi.internal.agentMemoryUrl;
              secretReference = pi.internal.agentMemorySecretReference;
              extension = pi.extensions.agentmemory.relativePath;
            };
          };
          secretUri = builtins.getAttr "agentmemory-bearer" hm.home.mcp.keychainSecrets;
          capturePlugins = builtins.filter (name:
            builtins.match "opencode/plugins/(cavemem\\.js|agentmemory-.*)" name != null
          ) (builtins.attrNames hm.xdg.configFile);
        };
    in builtins.toJSON {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    }),
  );
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
