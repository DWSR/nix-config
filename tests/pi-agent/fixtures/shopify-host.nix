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
      ]
      ++ extraModules;
    };
  shopify = mkConfiguration [ ];
  shopifyConfig = shopify.config.programs.pi-agent;
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
    cavememDataDir = shopifyConfig.internal.cavememDataDir;
    hostCavememDataDir = toString shopify.config.home.cavemem.dataDir;
    extensionRefs = builtins.mapAttrs (_name: packageReference) shopifyConfig.extensions;
    instructionRefs = map packageReference (shopifyConfig.instructions ++ shopifyConfig.resources);
    extensionManifest = pathOrNull shopifyConfig.internal.extensionManifest;
    extensionIdentity = pathOrNull shopifyConfig.internal.extensionIdentity;
    instructionResources = shopifyConfig.internal.instructionResources;
    profilePaths = shopifyConfig.internal.profilePaths;
    managedConfig = pathOrNull shopifyConfig.internal.managedConfig;
    projectionFactory = pathOrNull shopifyConfig.internal.projectionFactory;
    providerHandoff = pathOrNull shopifyConfig.internal.shopifyProviderHandoff;
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
in
{
  shopify =
    let
      summary = discardContexts shopifySummary;
    in
    builtins.deepSeq summary summary;
  # Deliberately force each host-injection fixture so evaluation must reject
  # every removed provider escape hatch at the closed option boundary.
  shopify-routes = builtins.deepSeq invalidRoutes.config.programs.pi-agent true;
  shopify-apis = builtins.deepSeq invalidApis.config.programs.pi-agent true;
  shopify-headers = builtins.deepSeq invalidHeaders.config.programs.pi-agent true;
  shopify-resolver-argv = builtins.deepSeq invalidResolverArgv.config.programs.pi-agent true;
  shopify-store-paths = builtins.deepSeq invalidStorePaths.config.programs.pi-agent true;
}
.${fixture} or (throw "unknown Shopify host fixture: ${fixture}")
