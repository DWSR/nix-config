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
        file: builtins.match "opencode/plugins/(cavemem\\.js|agentmemory-.*)" file != null
      ) configFiles;
      relevantConfigTexts = builtins.mapAttrs configText (
        pkgs.lib.filterAttrs (
          file: _:
          builtins.match "(opencode/(AGENTS\\.md|opencode\\.json|plugins/(cavemem\\.js|agentmemory-.*))|mcpproxy/mcp_config\\.json|nono/profiles/.*)" file
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
      cavememServers = builtins.filter (server: server.name == "cavemem") mcpConfig.mcpServers;
      agentMemoryJob = hm.launchd.agents.agentmemory;
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
      backend = hm.home.opencode.memoryBackend;
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
      cavemem = {
        enable = hm.home.cavemem.enable;
        packageNames = builtins.filter (package: pkgs.lib.hasPrefix "cavemem" package) packageNames;
      };
      mcp = {
        serverNames = map (server: server.name) mcpConfig.mcpServers;
        agentMemoryCount = builtins.length agentMemoryServers;
        cavememCount = builtins.length cavememServers;
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
        augmentation = hm.programs.session-compaction.augmentationEnabled;
      };
      secretReference = hm.home.mcp.keychainSecrets."agentmemory-bearer";
    };
in
pkgs.writeText "agentmemory-opencode-hosts.json" (
  builtins.toJSON {
    personal = summarizeHost "Brandons-MacBook-Pro";
    shopify = summarizeHost "ShopifyLaptop";
  }
)
