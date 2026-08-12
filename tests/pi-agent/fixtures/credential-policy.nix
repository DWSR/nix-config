{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;

  policyPath = repoRoot + "/home-manager/common/pi-agent/credential-policy.nix";
  mkPolicy =
    package:
    import policyPath {
      inherit lib pkgs;
      trustedDevxOutPath = package.outPath;
    };
  policyWithoutDevx = import policyPath { inherit lib pkgs; };
  devxPackage = pkgs.writeShellApplication {
    name = "devx";
    text = ''
      if [ -n "''${PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER-}" ]; then
        printf 'resolver executed\n' > "$PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER"
      fi
      exit 97
    '';
  };
  devxReference = {
    package = devxPackage;
    relativePath = "bin/devx";
  };
  policy = mkPolicy devxPackage;
  alternateDevxPackage = pkgs.writeShellApplication {
    name = "alternate-devx";
    text = "exit 98";
  };
  contextSwappedDevxPackage = devxPackage // {
    outPath = builtins.appendContext (builtins.unsafeDiscardStringContext alternateDevxPackage.outPath) (
      builtins.getContext devxPackage.outPath
    );
  };
  recursiveDevxPackage =
    let
      recursive = devxPackage // {
        outPath = builtins.appendContext "/tmp/host-supplied-devx" (
          builtins.getContext devxPackage.outPath
        );
        out = recursive;
      };
    in
    recursive;
  ignoredNullIfdProbe = pkgs.writeText "pi-agent-credential-policy-ifd-probe" "probe";
  ignoredNullIfdPackage = devxPackage // {
    drvAttrs = devxPackage.drvAttrs // {
      __ignoreNulls = true;
      task25IgnoredNullIfd = builtins.trace "TASK_2_5_IFD_THUNK_FORCED" (
        if builtins.readFile ignoredNullIfdProbe == "probe" then null else null
      );
    };
  };
  recursiveMetadataPackage =
    let
      recursiveMetadata.recurse = recursiveMetadata;
    in
    devxPackage
    // {
      drvAttrs = devxPackage.drvAttrs // {
        __ignoreNulls = true;
        task25RecursiveMetadata = recursiveMetadata;
      };
      meta = (devxPackage.meta or { }) // {
        task25RecursiveMetadata = recursiveMetadata;
      };
    };
  hostileToStringDevxPackage = devxPackage // {
    __toString = _: "/tmp/coerced-host-devx";
  };
  selectedMultiOutputPackage =
    pkgs.runCommand "pi-agent-credential-policy-multi-output"
      {
        outputs = [
          "out"
          "tools"
        ];
      }
      ''
        mkdir -p "$out/share/pi-agent" "$tools/bin"
        touch "$out/share/pi-agent/data" "$tools/bin/devx"
      '';
  writeTextPackage = pkgs.writeText "pi-agent-credential-policy-write-text" "fixture";
  writeShellScriptBinPackage = pkgs.writeShellScriptBin "pi-agent-credential-policy-script" "exit 0";
  personalSelection = {
    mode = "personal";
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
  };
  shopifySelection = {
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
  personal =
    (mkPolicy (throw "personal resolver planning evaluated the Shopify devx reference")).render
      {
        hostSelection = personalSelection;
      };
  shopify = policy.render { hostSelection = shopifySelection; };
  hostileToStringShopify = (mkPolicy hostileToStringDevxPackage).render {
    hostSelection = shopifySelection;
  };
  selectedMultiOutputShopify = (mkPolicy selectedMultiOutputPackage.tools).render {
    hostSelection = shopifySelection;
  };
  ignoredNullIfdShopify = (mkPolicy ignoredNullIfdPackage).render {
    hostSelection = shopifySelection;
  };
  recursiveMetadataShopify = (mkPolicy recursiveMetadataPackage).render {
    hostSelection = shopifySelection;
  };
  forcePlans = rendered: builtins.deepSeq rendered.resolverPlans rendered.resolverPlans;
  forceRender = policyValue: args: builtins.deepSeq (forcePlans (policyValue.render args)) true;
  modulePath = repoRoot + "/home-manager/common/pi-agent/default.nix";
  mkModuleEvaluation =
    moduleConfig:
    lib.evalModules {
      modules = [
        modulePath
        moduleConfig
      ];
      specialArgs = {
        inherit pkgs;
        piAgentAdvisoryDate = "2026-08-09";
      };
    };
  summarizeModulePackage =
    package:
    let
      selected =
        (mkModuleEvaluation { programs.pi-agent.package = package; }).config.programs.pi-agent.package;
    in
    builtins.deepSeq selected.outPath {
      packageIsDerivation = lib.isDerivation selected;
      renderedPath = selected.outPath;
      inherit (selected) outputName;
    };
  disabledModule = mkModuleEvaluation { };
  strongerProviderOverride = lib.evalModules {
    modules = [
      modulePath
      {
        programs.pi-agent.provider = {
          _module.freeformType = lib.mkOverride 0 (lib.types.attrsOf lib.types.anything);
          mode = "shopify-gateway";
          enabledRoles = [ "openai" ];
          defaultModel = {
            provider = "openai";
            modelId = "gpt-5.6-sol";
          };
          devx = {
            package = recursiveDevxPackage;
            relativePath = "bin/devx";
          };
          contextSwappedDevx = {
            package = contextSwappedDevxPackage;
            relativePath = "bin/devx";
          };
          hostileToStringDevx = {
            package = hostileToStringDevxPackage;
            relativePath = "bin/devx";
          };
          argv = [ "host-supplied-argv" ];
          environmentName = "HOST_SUPPLIED_TOKEN";
          ignoredNullIfdDevx = {
            package = ignoredNullIfdPackage;
            relativePath = "bin/devx";
          };
          recursiveMetadataDevx = {
            package = recursiveMetadataPackage;
            relativePath = "bin/devx";
          };
        };
      }
    ];
    specialArgs = {
      inherit pkgs;
      piAgentAdvisoryDate = "2026-08-09";
    };
  };
  strongerProviderSelection = strongerProviderOverride.config.programs.pi-agent.provider;
  strongerProviderRender = policy.render { hostSelection = strongerProviderSelection; };

  fixtures = {
    resolver-contract = {
      inherit (policy) resolverKinds;
      devx = {
        executable = "${devxPackage.outPath}/bin/devx";
        packageHasOutputContext = builtins.getContext devxPackage.outPath != { };
        packageIsDerivation = lib.isDerivation devxPackage;
        inherit (devxReference) relativePath;
      };
      personalPlans = forcePlans personal;
      personalInvocations = map personal.launcherInvocation personal.resolverPlans;
      shopifyPlans = forcePlans shopify;
      shopifyInvocations = map shopify.launcherInvocation shopify.resolverPlans;
      hostileToStringExecutable = (builtins.head (forcePlans hostileToStringShopify)).executable;
      selectedMultiOutput = {
        inherit (builtins.head (forcePlans selectedMultiOutputShopify)) executable;
        expectedExecutable = "${selectedMultiOutputPackage.tools.outPath}/bin/devx";
        packageIsDerivation = lib.isDerivation selectedMultiOutputPackage.tools;
        outputName = selectedMultiOutputPackage.tools.outputName;
      };
      strongerProviderOverride = {
        inherit (builtins.head (forcePlans strongerProviderRender)) executable;
        hostExecutable = "${strongerProviderSelection.devx.package.outPath}/bin/devx";
        hostArgv = strongerProviderSelection.argv;
        hostEnvironmentName = strongerProviderSelection.environmentName;
        hostIgnoredNullIfdOutPath = strongerProviderSelection.ignoredNullIfdDevx.package.outPath;
        hostRecursiveMetadataOutPath = strongerProviderSelection.recursiveMetadataDevx.package.outPath;
        hostContextSwappedOutPath = strongerProviderSelection.contextSwappedDevx.package.outPath;
        hostHostileToString = toString strongerProviderSelection.hostileToStringDevx.package;
      };
      personalRuntimeModuleIsDerivation = lib.isDerivation personal.runtimeModule;
      shopifyRuntimeModuleIsDerivation = lib.isDerivation shopify.runtimeModule;
    };
    personal-runtime-module = personal.runtimeModule;
    shopify-runtime-module = shopify.runtimeModule;
    managed-shell = policy.managedShell;
    ignored-null-ifd-contract = {
      inherit (builtins.head (forcePlans ignoredNullIfdShopify)) executable;
      expectedExecutable = "${ignoredNullIfdPackage.outPath}/bin/devx";
    };
    recursive-metadata-contract = {
      inherit (builtins.head (forcePlans recursiveMetadataShopify)) executable;
      expectedExecutable = "${recursiveMetadataPackage.outPath}/bin/devx";
    };
    host-override-metadata-contract = {
      inherit (builtins.head (forcePlans strongerProviderRender)) executable;
      expectedExecutable = "${devxPackage.outPath}/bin/devx";
      ignoredNullIfdOutPath = strongerProviderSelection.ignoredNullIfdDevx.package.outPath;
      recursiveMetadataOutPath = strongerProviderSelection.recursiveMetadataDevx.package.outPath;
    };
    home-module-package-regressions = {
      writeText = summarizeModulePackage writeTextPackage;
      writeShellApplication = summarizeModulePackage devxPackage;
      writeShellScriptBin = summarizeModulePackage writeShellScriptBinPackage;
      selectedMultiOutput = summarizeModulePackage selectedMultiOutputPackage.tools;
    };
    disabled-module = {
      inherit (disabledModule.config.programs.pi-agent) enable;
      resolverKinds = disabledModule.config.programs.pi-agent.internal.resolverKinds;
    };

    missing-trusted-devx = forceRender policyWithoutDevx { hostSelection = shopifySelection; };
    unknown-provider-mode = forceRender policy {
      hostSelection = shopifySelection // {
        mode = "host-plugin";
      };
    };
    unexpected-render-argv = forceRender policy {
      hostSelection = shopifySelection;
      argv = [ "--host-supplied" ];
    };
    unexpected-render-environment-name = forceRender policy {
      hostSelection = shopifySelection;
      environmentName = "HOST_SUPPLIED_TOKEN";
    };
  };
in
fixtures.${fixture} or (throw "unknown pi-agent credential-policy fixture: ${fixture}")
