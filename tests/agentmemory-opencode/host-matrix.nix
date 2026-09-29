{
  pkgs,
  self,
}:
let
  discard = value: builtins.unsafeDiscardStringContext value;
  configText =
    name: value:
    if value ? text && value.text != null then
      discard value.text
    else if
      value ? source && value.source != null && builtins.match ".*\\.(js|json|md|ts)$" name != null
    then
      discard (builtins.readFile value.source)
    else
      "";

  summarizeHost =
    hostName:
    let
      hm = self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama;
      packageNames = map (package: package.name or "") hm.home.packages;
      obsidianVaultPathConfigured = builtins.hasAttr "obsidianVaultPath" hm.home.mcp;
      obsidianPackageNames = builtins.filter (
        package: pkgs.lib.hasInfix "mcp-obsidian" package
      ) packageNames;
      retiredPipelinePackageNames = builtins.filter (
        package:
        builtins.elem package [
          "memory-sync"
          "cavemem-import-vault"
        ]
      ) packageNames;
      configFiles = builtins.attrNames hm.xdg.configFile;
      memoryPluginFiles = builtins.filter (
        file: builtins.match "opencode/plugins/agentmemory-.*" file != null
      ) configFiles;
      relevantConfigTexts = builtins.mapAttrs configText (
        pkgs.lib.filterAttrs (
          file: _:
          builtins.match "(opencode/(AGENTS\\.md|opencode\\.json|plugins/agentmemory-.*)|mcpproxy/mcp_config\\.json|nono/profiles/.*)" file
          != null
        ) hm.xdg.configFile
      );
      relevantHomeTexts = builtins.mapAttrs (
        _: value: if value ? text && value.text != null then discard value.text else ""
      ) (pkgs.lib.filterAttrs (file: _: builtins.match ".*agentmemory.*" file != null) hm.home.file);
      memoryPluginSources = map (
        file: discard (builtins.readFile (builtins.getAttr file hm.xdg.configFile).source)
      ) memoryPluginFiles;
      mcpConfig = builtins.fromJSON (discard hm.xdg.configFile."mcpproxy/mcp_config.json".text);
      agentMemoryServers = builtins.filter (server: server.name == "agentmemory") mcpConfig.mcpServers;
      agentMemoryJob = hm.launchd.agents.agentmemory;
      mcpproxyJob = hm.launchd.agents.mcpproxy;
      agentMemorySettingsPath = "${hm.programs.agentmemory.runtimeDir}/.env";
      agentMemorySettings = (builtins.getAttr agentMemorySettingsPath hm.home.file).text;
      agentMemoryPackage = hm.programs.agentmemory.package;
      agentMemoryRuntimeConfig = discard (
        builtins.readFile "${agentMemoryPackage}/lib/node_modules/@agentmemory/agentmemory/iii-config.yaml"
      );
      agentMemoryRuntimeLauncher = discard (
        builtins.readFile "${agentMemoryPackage}/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs"
      );
      nonoProfiles = builtins.mapAttrs (_: value: builtins.fromJSON (discard value.text)) (
        pkgs.lib.filterAttrs (
          file: _: builtins.match "nono/profiles/.*\\.json" file != null
        ) hm.xdg.configFile
      );
      agentTexts = builtins.mapAttrs (
        _: value:
        if builtins.typeOf value == "path" || pkgs.lib.hasPrefix "/nix/store/" value then
          discard (builtins.readFile value)
        else
          discard value
      ) hm.programs.opencode.agents;
      agentmemoryLaunchers = builtins.filter (
        package: (package.name or "") == "agentmemory"
      ) hm.home.packages;
      skillNames = builtins.filter (name: builtins.match "opencode/skills/.+" name != null) configFiles;
      skillFiles = pkgs.lib.filterAttrs (
        name: _:
        builtins.match "opencode/skills/(binks-pr-review|create-yb-fix-pr|github-native-stacks|validate-yb-issue)" name
        != null
      ) hm.xdg.configFile;
      pi = hm.programs.pi.coding-agent;
      nono = hm.programs.opencode-nono;
      launchd = {
        Label = agentMemoryJob.config.Label;
        RunAtLoad = agentMemoryJob.config.RunAtLoad;
        KeepAlive = agentMemoryJob.config.KeepAlive;
        ProgramArguments = map discard agentMemoryJob.config.ProgramArguments;
        EnvironmentVariables = builtins.mapAttrs (_: discard) agentMemoryJob.config.EnvironmentVariables;
      };
      allGeneratedText = pkgs.lib.concatStringsSep "\n" [
        (discard hm.programs.opencode.context)
        (pkgs.lib.concatStringsSep "\n" (builtins.attrValues agentTexts))
        (pkgs.lib.concatStringsSep "\n" (builtins.attrValues relevantConfigTexts))
        (pkgs.lib.concatStringsSep "\n" (builtins.attrValues relevantHomeTexts))
        (pkgs.lib.concatStringsSep "\n" memoryPluginSources)
        (pkgs.lib.concatStringsSep "\n" (map discard hm.home.opencode.wrapperCommands))
        (builtins.toJSON launchd)
      ];
    in
    {
      name = hostName;
      inherit
        memoryPluginFiles
        nonoProfiles
        allGeneratedText
        launchd
        ;
      agentMemory = {
        enable = hm.programs.agentmemory.enable;
        obsidianImporter = builtins.elem "agentmemory-import-obsidian" packageNames;
        packageNames = builtins.filter (package: pkgs.lib.hasPrefix "agentmemory" package) packageNames;
        settings = discard agentMemorySettings;
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
        configText = discard hm.xdg.configFile."mcpproxy/mcp_config.json".text;
        inherit obsidianPackageNames obsidianVaultPathConfigured retiredPipelinePackageNames;
        opencodeNames = builtins.attrNames (hm.programs.opencode.settings.mcp or { });
      };
      instructions = {
        context = discard hm.programs.opencode.context;
        agents = agentTexts;
      };
      consumers = {
        vaultCurator = builtins.hasAttr ("vault" + "-curator") hm.programs.opencode.agents;
        vaultSynthesizer = builtins.hasAttr ("vault" + "-synthesizer") hm.programs.opencode.agents;
        nativeCompactCommand = builtins.hasAttr "compact" hm.programs.opencode.commands;
      };
      secretReference = hm.home.mcp.keychainSecrets."agentmemory-bearer";

      # Evaluate real host projections before entering the check builder:
      # nested Nix in the build environment cannot refetch Shopify's private
      # skill inputs. Synthetic HM variants remain in the
      # JS tests, but host assertions read these snapshots in the flake check.
      hostRender = {
        homeDirectory = hm.home.homeDirectory;
        mcp = {
          serverNames = map (server: server.name) mcpConfig.mcpServers;
          inherit packageNames obsidianPackageNames obsidianVaultPathConfigured;
          retiredPipelinePackages = retiredPipelinePackageNames;
          launchdEnvironment = mcpproxyJob.config.EnvironmentVariables;
        };
        expectedDataDir = "${hm.xdg.dataHome}/agentmemory";
        expectedRuntimeDir = "${hm.home.homeDirectory}/.agentmemory";
        expectedLogDir = "${hm.home.homeDirectory}/Library/Logs/agentmemory";
        agentmemory = {
          inherit (hm.programs.agentmemory)
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
          launcherText = discard (builtins.readFile "${builtins.head agentmemoryLaunchers}/bin/agentmemory");
          hasObsidianImporter = builtins.elem "agentmemory-import-obsidian" packageNames;
          settings = discard agentMemorySettings;
          launchd = {
            inherit (agentMemoryJob.config) Label EnvironmentVariables;
          };
        };
        opencode = {
          agents = builtins.attrNames hm.programs.opencode.agents;
          contextHasStockAgentMemory = pkgs.lib.hasInfix "stock AgentMemory" hm.programs.opencode.context;
          wrapperHasAgentMemoryPreflight = pkgs.lib.hasInfix "AgentMemory daemon preflight failed" (
            builtins.concatStringsSep "\n" hm.home.opencode.wrapperCommands
          );
          wrapperHasObsidianImporter = pkgs.lib.hasInfix "agentmemory-import-obsidian" (
            builtins.concatStringsSep "\n" hm.home.opencode.wrapperCommands
          );
        };
        secretUri = hm.home.mcp.keychainSecrets."agentmemory-bearer";
        capturePlugins = memoryPluginFiles;
        casks = map (cask: cask.name) self.darwinConfigurations.${hostName}.config.homebrew.casks;
      };

      cutover = {
        context = discard hm.programs.opencode.context;
        agents = agentTexts;
        skills = builtins.mapAttrs (
          _: value: discard (builtins.readFile (value.source + "/SKILL.md"))
        ) skillFiles;
        wrapper = builtins.concatStringsSep "\n" (map discard hm.home.opencode.wrapperCommands);
        agentNames = builtins.attrNames hm.programs.opencode.agents;
        commandNames = builtins.attrNames (hm.programs.opencode.commands or { });
        inherit packageNames skillNames;
        serverNames = map (server: server.name) mcpConfig.mcpServers;
        pi = {
          inherit (pi) enable;
          agentMemoryUrl = pi.environment.AGENTMEMORY_URL.value;
          extensions = map (extension: discard (toString extension)) pi.extensions;
          instructionResources = [
            {
              path = discard (toString pi.rules);
              content = discard (builtins.readFile pi.rules);
            }
          ];
          mcpPort = hm.home.mcp.listenPort;
        };
      };

      # The separate opencode-nono check reads this projection instead of
      # refetching Shopify-only Pi skills from nested Nix in its build sandbox.
      nonoRender = {
        profileTexts = {
          "opencode-managed" = discard hm.xdg.configFile."nono/profiles/${nono.managedProfile}.json".text;
          "opencode-audit" = discard hm.xdg.configFile."nono/profiles/${nono.auditProfile}.json".text;
          "opencode-review" = discard hm.xdg.configFile."nono/profiles/${nono.reviewProfile}.json".text;
        };
        metadataText = discard hm.xdg.configFile."opencode/opencode-nono/metadata.json".text;
        guideText = discard hm.xdg.configFile."opencode/opencode-nono/README.md".text;
        nonoPackageName = nono.package.name;
        launcherPackageName = hm.programs.opencode.package.name;
        nonoInHomePackages = builtins.elem nono.package hm.home.packages;
        assertions = map (assertion: { inherit (assertion) assertion message; }) hm.assertions;
        permission = hm.programs.opencode.settings.permission or null;
        mcp = hm.programs.opencode.settings.mcp or null;
      };
    };
in
pkgs.writeText "agentmemory-opencode-hosts.json" (
  builtins.toJSON {
    personal = summarizeHost "Brandons-MacBook-Pro";
    shopify = summarizeHost "ShopifyLaptop";
  }
)
