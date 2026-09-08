{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  home-manager = flake.inputs.home-manager;

  commonModule = repoRoot + "/home-manager/common";
  homeDefaults = {
    home = {
      username = "pi-agent-integration";
      homeDirectory = "/tmp/pi-agent-integration";
      stateVersion = "26.05";
    };
  };

  mkConfiguration =
    module:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs = {
        inherit (flake) inputs;
      };
      modules = [
        commonModule
        homeDefaults
        module
      ];
    };

  enabled = mkConfiguration {
    programs.pi-agent = {
      enable = true;
      provider = {
        mode = "personal";
        defaultModel = {
          provider = "openai";
          modelId = "gpt-5.6-sol";
        };
      };
    };
    programs.agentmemory.enable = true;
  };
  disabled = mkConfiguration { };
  shopify = mkConfiguration {
    programs.pi-agent = {
      enable = true;
      provider = {
        mode = "shopify-gateway";
        enabledRoles = [
          "anthropic"
          "openai"
          "google"
          "groq"
          "xai"
        ];
        defaultModel = {
          provider = "openai";
          modelId = "gpt-5.6-sol";
        };
      };
    };
    programs.agentmemory.enable = true;
  };

  packageNames =
    configuration:
    map (package: package.pname or package.name or "unknown") configuration.config.home.packages;
  fileNames = configuration: builtins.attrNames configuration.config.home.file;
  activationNames = configuration: builtins.attrNames configuration.config.home.activation;

  summarize =
    configuration:
    let
      cfg = configuration.config.programs.pi-agent;
      inherit (cfg) internal;
      inherit (internal) statusInputs;
      pathOrNull = value: if value == null then null else toString value;
    in
    {
      packages = packageNames configuration;
      files = fileNames configuration;
      activation = activationNames configuration;
      common = {
        ezaEnabled = configuration.config.programs.eza.enable;
        atuinInstalled = builtins.elem "atuin" (packageNames configuration);
      };
      config = {
        inherit (cfg) enable;
        package = pathOrNull cfg.package;
        managedConfig = pathOrNull internal.managedConfig;
        projectionFactory = pathOrNull internal.projectionFactory;
        sandboxCatalog = pathOrNull internal.sandboxCatalog;
        guidancePackage = pathOrNull internal.guidancePackage;
        inherit (internal)
          extensionManifest
          extensionIdentity
          instructionResources
          profilePaths
          ;
        credentialRuntimeModule = pathOrNull internal.credentialRuntimeModule;
        inherit statusInputs;
        inherit (internal) commands;
      };
      artifacts = {
        credentialResolver = pathOrNull internal.credentialResolver;
        launcher = pathOrNull internal.launcher;
        managedCommand = pathOrNull internal.managedCommand;
        managedCommandSource =
          if internal.managedCommand == null then
            null
          else
            builtins.readFile "${internal.managedCommand}/bin/pi";
        managedShell = pathOrNull internal.managedShell;
        managedStatusCommand = pathOrNull internal.managedStatusCommand;
        managedValidatorCommand = pathOrNull internal.managedValidatorCommand;
        reconciler = pathOrNull internal.reconciler;
        inherit (internal) resolverPlans;
        sandboxExecutor = pathOrNull internal.sandboxExecutor;
        sandboxResolver = pathOrNull internal.sandboxResolver;
        status = pathOrNull internal.status;
        validator = pathOrNull internal.validator;
      };
    };

  fixtures = {
    enabled = summarize enabled;
    disabled = summarize disabled;
    shopify = summarize shopify;
  };
in
fixtures.${fixture} or (throw "unknown common integration fixture: ${fixture}")
