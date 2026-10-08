'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const matrixCheck = `path:${repoRoot}#checks.aarch64-darwin.agentmemory-opencode-matrix`;
const vaultAgentNames = Object.freeze({
  curator: ['vault', 'curator'].join('-'),
  synthesizer: ['vault', 'synthesizer'].join('-'),
});

function evalMatrix() {
  const hostMatrixPath = process.env.AGENTMEMORY_MATRIX_HOSTS || '';
  const hostRowsExpression = hostMatrixPath
    ? `builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ${JSON.stringify(hostMatrixPath)}))`
    : '{}';
  const expression = `
    let
      flake = builtins.getFlake ${JSON.stringify(`path:${repoRoot}`)};
      pkgs = import flake.inputs.nixpkgs {
        system = "aarch64-darwin";
        overlays = [
          flake.outputs.overlays.unstable-packages
          flake.outputs.overlays.custom-packages
        ];
        config.allowUnfree = true;
      };
      commonModules = [
        "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
         ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
         ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
         ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode-nono.nix'))}
         ${JSON.stringify(path.join(repoRoot, 'home-manager/common/session-compaction.nix'))}
         ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      ];
      mkSynthetic = scenario:
        (flake.inputs.home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          extraSpecialArgs = { inherit (flake) inputs; };
          modules = commonModules ++ [
            {
              home.username = "brandonmcnama";
              home.homeDirectory = "/Users/brandonmcnama";
              home.stateVersion = "26.05";
              home.mcp = {
                githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
                keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
              };
               programs.agentmemory = {
                enable = scenario.agentMemoryEnable;
                dataDir = "/tmp/agentmemory-matrix/agentmemory";
                runtimeDir = "/tmp/agentmemory-matrix/runtime";
                logDir = "/tmp/agentmemory-matrix/logs";
                bearerReference = "agentmemory-bearer";
              };
              programs.opencode.settings.mcp.mcpproxy = {
                type = "remote";
                url = "http://127.0.0.1:8080/mcp";
                enabled = true;
              };
            }
          ];
        }).config;
      hostConfig = host:
        (builtins.getAttr host flake.darwinConfigurations).config.home-manager.users.brandonmcnama;
      hostRows = ${hostRowsExpression};
      scenarios = {
        enabled = mkSynthetic {
          agentMemoryEnable = true;
        };
        disabled = mkSynthetic {
          agentMemoryEnable = false;
        };
        personal =
          if builtins.hasAttr "personal" hostRows then hostRows.personal else hostConfig "Brandons-MacBook-Pro";
      };
      discardText = value: builtins.unsafeDiscardStringContext value;
      configText = name: value:
        if value ? text && value.text != null then
          discardText value.text
        else if value ? source && value.source != null && builtins.match ".*\\\\.(js|json|md|ts)$" name != null then
          discardText (builtins.readFile value.source)
        else
          "";
      summarize = name: hm:
        let
          packageNames = map (package: package.name or "") hm.home.packages;
          obsidianPackageNames = builtins.filter (package: pkgs.lib.hasInfix "mcp-obsidian" package) packageNames;
          retiredPipelinePackageNames = builtins.filter (
            package: builtins.elem package [ "memory-sync" "cavemem-import-vault" ]
          ) packageNames;
          configFiles = builtins.attrNames hm.xdg.configFile;
          pluginFiles = builtins.filter (
            file: builtins.match "opencode/plugins/.*" file != null
          ) configFiles;
          memoryPluginFiles = builtins.filter (
             file: builtins.match "opencode/plugins/agentmemory-.*" file != null
          ) configFiles;
          relevantConfigTexts = builtins.mapAttrs configText (
            pkgs.lib.filterAttrs (
               file: _: builtins.match "(opencode/(AGENTS\\\\.md|opencode\\\\.json|plugins/agentmemory-.*)|mcpproxy/mcp_config\\\\.json|nono/profiles/.*)" file != null
            ) hm.xdg.configFile
          );
          relevantHomeTexts = builtins.mapAttrs (
            _: value: if value ? text && value.text != null then discardText value.text else ""
          ) (pkgs.lib.filterAttrs (
            file: _: builtins.match ".*agentmemory.*" file != null
          ) hm.home.file);
          memoryPluginSources = map (
            file: discardText (builtins.readFile (builtins.getAttr file hm.xdg.configFile).source)
          ) memoryPluginFiles;
          mcpConfig = builtins.fromJSON (
            discardText hm.xdg.configFile."mcpproxy/mcp_config.json".text
          );
          agentMemoryServers = builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers;
          agentMemoryJob =
            if builtins.hasAttr "agentmemory" hm.launchd.agents then hm.launchd.agents.agentmemory else null;
          agentMemorySettingsPath = hm.programs.agentmemory.runtimeDir + "/.env";
          agentMemorySettings =
            if builtins.hasAttr agentMemorySettingsPath hm.home.file then
              discardText (builtins.getAttr agentMemorySettingsPath hm.home.file).text
            else
              null;
          agentMemoryRuntimeConfig = discardText (
            builtins.readFile "\${hm.programs.agentmemory.package}/lib/node_modules/@agentmemory/agentmemory/iii-config.yaml"
          );
          agentMemoryRuntimeLauncher = discardText (
            builtins.readFile "\${hm.programs.agentmemory.package}/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs"
          );
          nonoProfiles = builtins.mapAttrs (
            _: value: builtins.fromJSON (discardText value.text)
          ) (pkgs.lib.filterAttrs (
            file: _: builtins.match "nono/profiles/.*\\\\.json" file != null
          ) hm.xdg.configFile);
          agentTexts = builtins.mapAttrs (
            _: value:
            if builtins.typeOf value == "path" || pkgs.lib.hasPrefix "/nix/store/" value then
              discardText (builtins.readFile value)
            else
              discardText value
          ) hm.programs.opencode.agents;
          launchd =
            if agentMemoryJob == null then
              null
            else
              {
                Label = agentMemoryJob.config.Label;
                RunAtLoad = agentMemoryJob.config.RunAtLoad;
                KeepAlive = agentMemoryJob.config.KeepAlive;
                ProgramArguments = map discardText agentMemoryJob.config.ProgramArguments;
                EnvironmentVariables = builtins.mapAttrs (
                  _: value: discardText value
                ) agentMemoryJob.config.EnvironmentVariables;
              };
          allGeneratedText = builtins.concatStringsSep "\\n" (
            [
              (discardText (hm.programs.opencode.context or ""))
              (builtins.concatStringsSep "\\n" (builtins.attrValues agentTexts))
                (builtins.concatStringsSep "\\n" (builtins.attrValues relevantConfigTexts))
                (builtins.concatStringsSep "\\n" (builtins.attrValues relevantHomeTexts))
                (builtins.concatStringsSep "\\n" memoryPluginSources)
                (builtins.concatStringsSep "\\n" (map discardText hm.home.opencode.wrapperCommands))
            ]
            ++ (if launchd == null then [ ] else [ (builtins.toJSON launchd) ])
          );
        in
        {
          inherit name packageNames pluginFiles memoryPluginFiles nonoProfiles allGeneratedText launchd;
          agentMemory = {
            enable = hm.programs.agentmemory.enable;
            obsidianImporter = builtins.elem "agentmemory-import-obsidian" packageNames;
            packageNames = builtins.filter (package: pkgs.lib.hasPrefix "agentmemory" package) packageNames;
            settings = agentMemorySettings;
            runtimeConfig = agentMemoryRuntimeConfig;
            runtimeLauncher = agentMemoryRuntimeLauncher;
            inherit launchd;
            ports = {
              rest = hm.programs.agentmemory.restPort;
              stream = hm.programs.agentmemory.streamPort;
              viewer = hm.programs.agentmemory.viewerPort;
              engine = hm.programs.agentmemory.enginePort;
            };
          };
          mcp = {
            serverNames = map (server: server.name) mcpConfig.mcpServers;
            agentMemoryCount = builtins.length agentMemoryServers;
            configText = discardText hm.xdg.configFile."mcpproxy/mcp_config.json".text;
            obsidianPackageNames = obsidianPackageNames;
            obsidianVaultPathConfigured = builtins.hasAttr "obsidianVaultPath" hm.home.mcp;
            retiredPipelinePackageNames = retiredPipelinePackageNames;
            opencodeNames = builtins.attrNames (hm.programs.opencode.settings.mcp or { });
          };
           instructions = {
             context = hm.programs.opencode.context;
             agents = agentTexts;
           };
           consumers = {
             vaultCurator = builtins.hasAttr ${JSON.stringify(vaultAgentNames.curator)} hm.programs.opencode.agents;
             vaultSynthesizer = builtins.hasAttr ${JSON.stringify(vaultAgentNames.synthesizer)} hm.programs.opencode.agents;
              nativeCompactCommand = builtins.hasAttr "compact" hm.programs.opencode.commands;
           };
          secretReference =
            if builtins.hasAttr "agentmemory-bearer" hm.home.mcp.keychainSecrets then
              hm.home.mcp.keychainSecrets."agentmemory-bearer"
            else
              null;
        };
    in
    builtins.toJSON {
      enabled = summarize "enabled" scenarios.enabled;
      disabled = summarize "disabled" scenarios.disabled;
      personal =
        if builtins.hasAttr "personal" hostRows then scenarios.personal else summarize "personal" scenarios.personal;
    }
  `;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600_000,
    }),
  );
}

function assertCheckIsRegistered() {
  assert.doesNotThrow(() => {
    execFileSync('nix', ['eval', '--impure', '--raw', `${matrixCheck}.name`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
    });
  });
}

function assertNoBearerLiteral(rendered) {
  assert.doesNotMatch(
    rendered.allGeneratedText,
    /AGENTMEMORY_SECRET\s*=\s*["']?[A-Za-z0-9][A-Za-z0-9._-]{7,}/,
    `${rendered.name} serializes an AgentMemory bearer value`,
  );
  assert.doesNotMatch(
    rendered.allGeneratedText,
    /Authorization:\s*Bearer\s+[A-Za-z0-9]{8,}/i,
    `${rendered.name} serializes an Authorization bearer value`,
  );
}

function assertLoopbackEndpointContract(rendered) {
  const { settings, runtimeConfig, runtimeLauncher, ports } = rendered.agentMemory;
  const urls = settings.match(/(?:https?|wss?):\/\/[^'"\s]+/g) || [];

  assert.deepEqual(
    urls,
    [`http://127.0.0.1:${ports.rest}`, `http://127.0.0.1:${ports.viewer}`, `ws://127.0.0.1:${ports.engine}`],
    `${rendered.name} emits only loopback REST, viewer, and engine URLs`,
  );

  const portEnvironmentNames = {
    rest: 'III_REST_PORT',
    stream: 'III_STREAM_PORT',
    viewer: 'III_VIEWER_PORT',
    engine: 'III_ENGINE_PORT',
  };
  for (const [name, port] of Object.entries(ports)) {
    assert.match(
      settings,
      new RegExp(`${portEnvironmentNames[name]}=['"]?${port}['"]?`),
      `${rendered.name} renders the ${name} port contract`,
    );
  }

  const hosts = [...runtimeConfig.matchAll(/\bhost:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(hosts.length >= 2, `${rendered.name} exposes REST and stream host bindings`);
  assert.deepEqual(hosts, hosts.map(() => '127.0.0.1'));
  assert.doesNotMatch(runtimeConfig, /\bhost:\s*(?!127\.0\.0\.1\b)[^\s#]+/);

  assert.match(
    runtimeLauncher,
    /setWorkerPort\(lines, "iii-worker-manager", options\.ports\.enginePort\)/,
    `${rendered.name} derives the engine binding from the configured engine port`,
  );
  assert.match(
    runtimeLauncher,
    /"      host: 127\.0\.0\.1"/,
    `${rendered.name} keeps the generated engine binding on loopback`,
  );
  assert.doesNotMatch(runtimeLauncher, /\bhost:\s*(?!127\.0\.0\.1\b)[^\s#]+/);
}

function assertAgentMemoryPromptContract(rendered) {
  const context = rendered.instructions.context;

   assert.equal(rendered.consumers.vaultCurator, false, `${rendered.name} omits ${vaultAgentNames.curator}`);
   assert.equal(rendered.consumers.vaultSynthesizer, false, `${rendered.name} omits ${vaultAgentNames.synthesizer}`);
  assert.match(context, /stock AgentMemory/i);
  assert.match(context, /memory_recall/);
  assert.match(context, /memory_save/);
  assert.match(context, /memory_lesson_save/);
  assert.doesNotMatch(
    context,
    /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|write-note|read-note|list-notes|search-by-tags|search-vault/i,
  );
}

function assertAgentMemoryRuntime(rendered) {
  assert.equal(rendered.agentMemory.enable, true, `${rendered.name} enables AgentMemory`);
  assert.equal(
    rendered.agentMemory.obsidianImporter,
    true,
    `${rendered.name} exposes the managed Obsidian-to-AgentMemory importer`,
  );
  assert.equal(rendered.agentMemory.ports.rest, 3111);
  assert.equal(rendered.agentMemory.ports.stream, 3112);
  assert.equal(rendered.agentMemory.ports.viewer, 3113);
  assert.equal(rendered.agentMemory.ports.engine, 49134);
  assert.ok(rendered.agentMemory.packageNames.length >= 2);
  assert.ok(rendered.agentMemory.packageNames.includes('agentmemory-import-obsidian'));
  assert.equal(rendered.agentMemory.packageNames.includes('agentmemory-import-cavemem'), false);
  assert.equal(rendered.agentMemory.launchd.Label, 'dev.dwsr.agentmemory');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.III_REST_PORT, '3111');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.III_STREAM_PORT, '3112');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.III_VIEWER_PORT, '3113');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.III_ENGINE_PORT, '49134');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_BM25_MAX_ENTRIES, '100000');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES, '50000');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_AUTO_COMPRESS, 'false');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_III_VERSION, '0.11.5');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.OTEL_ENABLED, 'false');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.OTEL_METRICS_ENABLED, 'false');
  assert.equal(rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_SECRET, undefined);
  assert.equal(
    rendered.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_SECRET_REFERENCE,
    'agentmemory-bearer',
  );
  assert.match(rendered.agentMemory.settings, /AGENTMEMORY_URL='?http:\/\/127\.0\.0\.1:3111/);
  assert.doesNotMatch(rendered.agentMemory.settings, /AGENTMEMORY_SECRET=/);
  assertLoopbackEndpointContract(rendered);
  assert.equal(rendered.memoryPluginFiles.length, 1);
  assert.deepEqual(rendered.memoryPluginFiles, ['opencode/plugins/agentmemory-capture.ts']);
  assert.equal(rendered.mcp.agentMemoryCount, 1);
  assert.deepEqual(rendered.mcp.opencodeNames, ['mcpproxy']);
  assert.deepEqual(rendered.mcp.serverNames.includes('agentmemory'), true);
  assert.equal(rendered.mcp.obsidianVaultPathConfigured, false);
  assert.deepEqual(rendered.mcp.obsidianPackageNames, []);
  assert.deepEqual(rendered.mcp.retiredPipelinePackageNames, []);
  assert.equal(rendered.mcp.serverNames.includes('obsidian'), false);
  assert.doesNotMatch(
    rendered.mcp.configText,
    /obsidianVaultPath|mcp-obsidian|memory-sync|cavemem-import-vault/i,
  );
  assertNoBearerLiteral(rendered);
}

test('the focused AgentMemory host-render matrix validates personal and disabled runtimes', () => {
  assertCheckIsRegistered();
  const rendered = evalMatrix();

  for (const row of [rendered.enabled, rendered.personal]) {
    assertAgentMemoryRuntime(row);
    assertAgentMemoryPromptContract(row);
    for (const profile of Object.values(row.nonoProfiles)) {
      assert.ok(profile.network.open_port.includes(8080));
      assert.ok(profile.network.open_port.includes(3111));
      assert.ok(profile.environment.allow_vars.includes('AGENTMEMORY_SECRET'));
      assert.doesNotMatch(JSON.stringify(profile), /CAVEMEM_DATA_DIR|local\/share\/cavemem/);
    }
  }

  assert.equal(rendered.personal.secretReference, 'op://Private/AgentMemory/Bearer');
  assert.equal(rendered.personal.agentMemory.launchd.EnvironmentVariables.AGENTMEMORY_DATA_DIR.endsWith('/agentmemory'), true);
  assert.equal(rendered.personal.consumers.nativeCompactCommand, true);
  const disabled = rendered.disabled;
  assert.equal(disabled.agentMemory.enable, false);
  assert.equal(disabled.agentMemory.launchd, null);
  assert.deepEqual(disabled.agentMemory.packageNames, []);
  assert.deepEqual(disabled.memoryPluginFiles, []);
  assert.equal(disabled.mcp.agentMemoryCount, 0);
  assert.deepEqual(disabled.mcp.opencodeNames, ['mcpproxy']);
  assertNoBearerLiteral(disabled);
  for (const profile of Object.values(disabled.nonoProfiles)) {
    assert.deepEqual(profile.network.open_port, [8080]);
    assert.equal(profile.environment.allow_vars.includes('AGENTMEMORY_SECRET'), false);
  }
});
