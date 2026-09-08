{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  home-manager = flake.inputs.home-manager;
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  personalHomeModule = repoRoot + "/configurations/personal/home-manager";
  homeDefaults = {
    home = {
      username = "brandonmcnama";
      homeDirectory = "/tmp/pi-agent-personal-host";
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
        personalHomeModule
        homeDefaults
        {
          home.mcp.keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
          programs.agentmemory.enable = true;
        }
      ]
      ++ extraModules;
    };
  personal = mkConfiguration [ ];
  personalConfig = personal.config.programs.pi-agent;
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
  personalManagedConfig =
    if personalConfig.enable then
      builtins.fromJSON (
        builtins.unsafeDiscardStringContext (builtins.readFile personalConfig.internal.managedConfig)
      )
    else
      null;
  pathOrNull = value: if value == null then null else toString value;
  extensionRefs =
    if personalConfig.enable then
      builtins.mapAttrs (_name: ref: {
        package = toString ref.package;
        inherit (ref) relativePath;
      }) personalConfig.extensions
    else
      { };
  personalSummary = {
    inherit (personalConfig)
      enable
      provider
      sandbox
      mcp
      ;
    package = toString personalConfig.package;
    packageVersion = personalConfig.package.version;
    agentMemoryUrl = personalConfig.internal.agentMemoryUrl;
    agentMemorySecretReference = personalConfig.internal.agentMemorySecretReference;
    inherit extensionRefs;
    extensionManifest = pathOrNull personalConfig.internal.extensionManifest;
    extensionIdentity = pathOrNull personalConfig.internal.extensionIdentity;
    instructionResources = personalConfig.internal.instructionResources;
    profilePaths = personalConfig.internal.profilePaths;
    managedConfig = pathOrNull personalConfig.internal.managedConfig;
    projectionFactory = pathOrNull personalConfig.internal.projectionFactory;
    providerHandoff = pathOrNull personalConfig.internal.shopifyProviderHandoff;
    guidancePackage = pathOrNull personalConfig.internal.guidancePackage;
    commands = personalConfig.internal.commands;
    publishableArtifacts = map toString personalPublishableArtifacts;
    commandPackages = {
      reconciler = pathOrNull personalConfig.internal.reconciler;
      launcher = pathOrNull personalConfig.internal.launcher;
      status = pathOrNull personalConfig.internal.status;
      validator = pathOrNull personalConfig.internal.validator;
      managed = pathOrNull personalConfig.internal.managedCommand;
      managedStatus = pathOrNull personalConfig.internal.managedStatusCommand;
      managedValidator = pathOrNull personalConfig.internal.managedValidatorCommand;
    };
    resolverPlans = personalConfig.internal.resolverPlans;
    selected =
      if personalManagedConfig == null then
        null
      else
        {
          inherit (personalManagedConfig) providerSelection;
          inherit (personalManagedConfig.settings) defaultModel defaultThinkingLevel;
          inherit (personalManagedConfig)
            extensionOrder
            instructionResources
            mcpEndpoint
            sandboxDefault
            ;
          personalCatalog = personalManagedConfig.providerCatalog.personal;
        };
  };
  personalPublishableArtifacts = [
    personalConfig.package
    personalConfig.internal.managedConfig
    personalConfig.internal.projectionFactory
    personalConfig.internal.extensionManifest
    personalConfig.internal.extensionIdentity
    personalConfig.internal.guidancePackage
    personalConfig.internal.sandboxCatalog
    personalConfig.internal.credentialRuntimeModule
    personalConfig.internal.credentialResolver
    personalConfig.internal.managedShell
    personalConfig.internal.sandboxResolver
    personalConfig.internal.sandboxExecutor
    personalConfig.internal.reconciler
    personalConfig.internal.launcher
    personalConfig.internal.status
    personalConfig.internal.validator
    personalConfig.internal.managedCommand
    personalConfig.internal.managedStatusCommand
    personalConfig.internal.managedValidatorCommand
  ]
  ++ builtins.attrValues personalConfig.internal.profilePaths
  ++ personalConfig.internal.instructionResources
  ++ map (reference: reference.package) (builtins.attrValues personalConfig.extensions)
  ++ map (reference: reference.package) (
    personalConfig.manifests ++ personalConfig.instructions ++ personalConfig.resources
  )
  ++ map (reference: reference.package) (builtins.attrValues personalConfig.languageServers);
  personalPublishable = pkgs.runCommand "pi-agent-personal-host-publishable" { } ''
    mkdir -p "$out/roots"
    ${pkgs.lib.concatImapStringsSep "\n" (
      index: package: "ln -s ${package} \"$out/roots/${toString index}\""
    ) personalPublishableArtifacts}
  '';
  withInjection =
    injection:
    mkConfiguration [
      {
        programs.pi-agent = {
          enable = true;
          provider = injection;
        };
      }
    ];
  invalidRole = withInjection {
    mode = "personal";
    enabledRoles = [ "openai" ];
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
  };
  invalidResolver = withInjection {
    mode = "personal";
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
    resolvers.shopify-gateway-token.kind = "shopify-gateway-token";
  };
  invalidProvider = withInjection {
    mode = "personal";
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
    providerObjects.openai.baseUrl = "https://gateway.example.test/vendors/openai/v1";
  };
  invalidRuntime = withInjection {
    mode = "personal";
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
    runtime.token = "personal-host-runtime-sentinel";
  };
in
{
  personal =
    let
      summary = discardContexts personalSummary;
    in
    builtins.deepSeq summary summary;
  personal-publishable = personalPublishable;
  personal-shopify-role = builtins.deepSeq invalidRole.config.programs.pi-agent true;
  personal-shopify-resolver = builtins.deepSeq invalidResolver.config.programs.pi-agent true;
  personal-provider-object = builtins.deepSeq invalidProvider.config.programs.pi-agent true;
  personal-runtime-value = builtins.deepSeq invalidRuntime.config.programs.pi-agent true;
}
.${fixture} or (throw "unknown personal host fixture: ${fixture}")
