{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  home-manager = flake.inputs.home-manager;
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  shopifyHomeModule = repoRoot + "/configurations/shopify/home-manager";
  homeDefaults = {
    home = {
      username = "brandonmcnama";
      homeDirectory = "/tmp/pi-agent-shopify-host";
      stateVersion = "26.05";
    };
  };
  mkConfiguration =
    extraModules:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs = {
        inherit (flake) inputs;
      };
      modules = [
        shopifyHomeModule
        homeDefaults
        {
          home.mcp.keychainSecrets."agentmemory-bearer" = "op://Employee/AgentMemory/Bearer";
          programs.agentmemory.enable = true;
        }
      ]
      ++ extraModules;
    };
  shopify = mkConfiguration [ ];
  shopifyConfig = shopify.config.programs.pi-agent;
  packageNames =
    configuration:
    map (package: package.pname or package.name or "unknown") configuration.config.home.packages;
  withProviderInjection =
    injection:
    mkConfiguration [
      {
        programs.pi-agent.provider = injection;
      }
    ];
  invalidRoutes = withProviderInjection {
    routes.openai = "https://gateway.example.test/vendors/openai/v1";
  };
  invalidApis = withProviderInjection {
    apis.openai = "openai-responses";
  };
  invalidHeaders = withProviderInjection {
    headers.openai.Authorization = "host-authored-header";
  };
  invalidResolverArgv = withProviderInjection {
    resolverArgv."shopify-gateway-token" = [ "--key" ];
  };
  invalidStorePaths = withProviderInjection {
    storePaths.devx = "/nix/store/host-authored-devx";
  };
  discardContexts =
    value:
    if builtins.isString value then
      builtins.unsafeDiscardStringContext value
    else if builtins.isList value then
      map discardContexts value
    else if builtins.isAttrs value then
      builtins.mapAttrs (_name: discardContexts) value
    else
      value;
  shopifyManagedConfig = builtins.fromJSON (
    builtins.unsafeDiscardStringContext (builtins.readFile shopifyConfig.internal.managedConfig)
  );
  pathOrNull = value: if value == null then null else toString value;
  packageReference = reference: {
    package = toString reference.package;
    inherit (reference) relativePath;
  };
  shopifySummary = {
    inherit (shopifyConfig)
      enable
      provider
      sandbox
      mcp
      ;
    agentMemoryDataDir = toString shopify.config.programs.agentmemory.dataDir;
    agentMemoryBackupDestination = shopify.config.programs.agentmemory.backupDestination;
    mcpServers = builtins.attrNames shopify.config.home.mcp.extraServers;
    packages = packageNames shopify;
    package = toString shopifyConfig.package;
    packageVersion = shopifyConfig.package.version;
    agentMemoryUrl = shopifyConfig.internal.agentMemoryUrl;
    agentMemorySecretReference = shopifyConfig.internal.agentMemorySecretReference;
    extensionRefs = builtins.mapAttrs (_name: packageReference) shopifyConfig.extensions;
    instructionRefs = map packageReference (shopifyConfig.instructions ++ shopifyConfig.resources);
    extensionManifest = pathOrNull shopifyConfig.internal.extensionManifest;
    extensionIdentity = pathOrNull shopifyConfig.internal.extensionIdentity;
    instructionResources = shopifyConfig.internal.instructionResources;
    profilePaths = shopifyConfig.internal.profilePaths;
    managedConfig = pathOrNull shopifyConfig.internal.managedConfig;
    projectionFactory = pathOrNull shopifyConfig.internal.projectionFactory;
    providerHandoff = pathOrNull shopifyConfig.internal.shopifyProviderHandoff;
    guidancePackage = pathOrNull shopifyConfig.internal.guidancePackage;
    commands = shopifyConfig.internal.commands;
    publishableArtifacts = map toString shopifyPublishableArtifacts;
    commandPackages = {
      reconciler = pathOrNull shopifyConfig.internal.reconciler;
      launcher = pathOrNull shopifyConfig.internal.launcher;
      status = pathOrNull shopifyConfig.internal.status;
      validator = pathOrNull shopifyConfig.internal.validator;
      managed = pathOrNull shopifyConfig.internal.managedCommand;
      managedStatus = pathOrNull shopifyConfig.internal.managedStatusCommand;
      managedValidator = pathOrNull shopifyConfig.internal.managedValidatorCommand;
    };
    resolverPlans = shopifyConfig.internal.resolverPlans;
    selected = {
      inherit (shopifyManagedConfig) providerCatalog providerSelection;
      inherit (shopifyManagedConfig.settings) defaultModel defaultThinkingLevel;
      inherit (shopifyManagedConfig)
        extensionOrder
        instructionResources
        mcpEndpoint
        sandboxDefault
        ;
    };
  };
  shopifyPublishableArtifacts = [
    shopifyConfig.package
    shopifyConfig.internal.managedConfig
    shopifyConfig.internal.projectionFactory
    shopifyConfig.internal.extensionManifest
    shopifyConfig.internal.extensionIdentity
    shopifyConfig.internal.shopifyProviderHandoff
    shopifyConfig.internal.guidancePackage
    shopifyConfig.internal.sandboxCatalog
    shopifyConfig.internal.credentialRuntimeModule
    shopifyConfig.internal.credentialResolver
    shopifyConfig.internal.managedShell
    shopifyConfig.internal.sandboxResolver
    shopifyConfig.internal.sandboxExecutor
    shopifyConfig.internal.reconciler
    shopifyConfig.internal.launcher
    shopifyConfig.internal.status
    shopifyConfig.internal.validator
    shopifyConfig.internal.managedCommand
    shopifyConfig.internal.managedStatusCommand
    shopifyConfig.internal.managedValidatorCommand
  ]
  ++ builtins.attrValues shopifyConfig.internal.profilePaths
  ++ shopifyConfig.internal.instructionResources
  ++ map (reference: reference.package) (builtins.attrValues shopifyConfig.extensions)
  ++ map (reference: reference.package) (
    shopifyConfig.manifests ++ shopifyConfig.instructions ++ shopifyConfig.resources
  )
  ++ map (reference: reference.package) (builtins.attrValues shopifyConfig.languageServers);
  shopifyPublishable = pkgs.runCommand "pi-agent-shopify-host-publishable" { } ''
    mkdir -p "$out/roots"
    ${pkgs.lib.concatImapStringsSep "\n" (
      index: package: "ln -s ${package} \"$out/roots/${toString index}\""
    ) shopifyPublishableArtifacts}
  '';
in
{
  shopify =
    let
      summary = discardContexts shopifySummary;
    in
    builtins.deepSeq summary summary;
  shopify-publishable = shopifyPublishable;
  # Deliberately force each host-injection fixture so evaluation must reject
  # every removed provider escape hatch at the closed option boundary.
  shopify-routes = builtins.deepSeq invalidRoutes.config.programs.pi-agent true;
  shopify-apis = builtins.deepSeq invalidApis.config.programs.pi-agent true;
  shopify-headers = builtins.deepSeq invalidHeaders.config.programs.pi-agent true;
  shopify-resolver-argv = builtins.deepSeq invalidResolverArgv.config.programs.pi-agent true;
  shopify-store-paths = builtins.deepSeq invalidStorePaths.config.programs.pi-agent true;
}
.${fixture} or (throw "unknown Shopify host fixture: ${fixture}")
