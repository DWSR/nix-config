{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  supportedPkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  modulePath = repoRoot + "/home-manager/common/pi-agent/default.nix";

  extensionNames = [
    "cavemem"
    "mcp"
    "subagents"
    "plan"
    "timestamps"
    "bashTimeout"
    "questions"
    "codeIntelligence"
    "backgroundTasks"
  ];

  mkPackages =
    pkgs:
    let
      extensionPackage = pkgs.runCommand "pi-agent-managed-config-extensions" { } ''
        mkdir -p "$out/lib/pi/extensions"
        ${pkgs.lib.concatMapStringsSep "\n" (name: ''
          touch "$out/lib/pi/extensions/${name}.mjs"
        '') extensionNames}
      '';
      manifestPackage = pkgs.writeTextDir "share/pi-agent/extensions.json" ''
        {"schemaVersion":1}
      '';
      instructionPackage = pkgs.writeTextDir "share/pi-agent/instructions.md" ''
        # Managed fixture instructions
      '';
      resourcePackage = pkgs.writeTextDir "share/pi-agent/resources/rules.md" ''
        # Managed fixture rules
      '';
      lspPackage = pkgs.writeShellScriptBin "fixture-lsp" "exit 0";
      multiOutputPackage =
        pkgs.runCommand "pi-agent-managed-config-multi-output"
          {
            outputs = [
              "out"
              "tools"
            ];
          }
          ''
            mkdir -p "$out/share/pi-agent" "$tools/bin"
            touch "$out/share/pi-agent/data" "$tools/bin/multi-lsp"
          '';
    in
    {
      inherit
        extensionPackage
        instructionPackage
        lspPackage
        manifestPackage
        multiOutputPackage
        resourcePackage
        ;
      piPackage = pkgs.writeShellScriptBin "pi" "exit 0";
    };

  mkModule = pkgs: packages: {
    programs.pi-agent = {
      enable = true;
      package = packages.piPackage;
      extensions = pkgs.lib.genAttrs extensionNames (name: {
        package = packages.extensionPackage;
        relativePath = "lib/pi/extensions/${name}.mjs";
      });
      manifests = [
        {
          package = packages.manifestPackage;
          relativePath = "share/pi-agent/extensions.json";
        }
      ];
      instructions = [
        {
          package = packages.instructionPackage;
          relativePath = "share/pi-agent/instructions.md";
        }
      ];
      resources = [
        {
          package = packages.resourcePackage;
          relativePath = "share/pi-agent/resources/rules.md";
        }
      ];
      languageServers = {
        fixture = {
          package = packages.lspPackage;
          relativePath = "bin/fixture-lsp";
        };
        multi = {
          package = packages.multiOutputPackage.tools;
          relativePath = "bin/multi-lsp";
        };
      };
      provider = {
        mode = "shopify-gateway";
        enabledRoles = [
          "xai"
          "groq"
          "google"
          "openai"
          "anthropic"
        ];
        defaultModel = {
          provider = "openai";
          modelId = "gpt-5.6-sol";
        };
      };
      state = {
        generation = "task-2.2-managed-v1";
        location = "pi-default";
      };
      mcp.port = 8080;
      sandbox.defaultState = "audit";
      timeouts.bashDefaultMs = 543210;
    };
  };

  mkEvaluation =
    pkgs: moduleConfig:
    pkgs.lib.evalModules {
      modules = [
        modulePath
      ]
      ++ (if builtins.isList moduleConfig then moduleConfig else [ moduleConfig ]);
      specialArgs = {
        inherit pkgs;
        piAgentAdvisoryDate = "2026-08-08";
      };
    };

  supportedPackages = mkPackages supportedPkgs;
  shopifyEvaluation = mkEvaluation supportedPkgs (mkModule supportedPkgs supportedPackages);
  shopifyCfg = shopifyEvaluation.config.programs.pi-agent;
  personalEvaluation = mkEvaluation supportedPkgs (
    supportedPkgs.lib.recursiveUpdate (mkModule supportedPkgs supportedPackages) {
      programs.pi-agent = {
        provider = {
          mode = "personal";
          enabledRoles = [ ];
          defaultModel = {
            provider = "openai";
            modelId = "gpt-5.6-sol";
          };
        };
        state.generation = "task-2.2-personal-v1";
      };
    }
  );
  personalCfg = personalEvaluation.config.programs.pi-agent;

  maliciousModelEvaluation = mkEvaluation supportedPkgs [
    (mkModule supportedPkgs supportedPackages)
    {
      programs.pi-agent.provider.defaultModel = {
        _module.freeformType = supportedPkgs.lib.mkOverride 0 (
          supportedPkgs.lib.types.attrsOf supportedPkgs.lib.types.anything
        );
        apiKey = "task-2.2-injected-api-key-sentinel";
        contextWindow = 424242;
      };
    }
  ];
  maliciousModelCfg = maliciousModelEvaluation.config.programs.pi-agent;

  hostileStringPackage = package: package // { __toString = _: "/tmp/pi-agent-host-path"; };
  hostilePackageEvaluation = mkEvaluation supportedPkgs (
    supportedPkgs.lib.recursiveUpdate (mkModule supportedPkgs supportedPackages) {
      programs.pi-agent = {
        manifests = [
          {
            package = hostileStringPackage supportedPackages.manifestPackage;
            relativePath = "share/pi-agent/extensions.json";
          }
        ];
        instructions = [
          {
            package = hostileStringPackage supportedPackages.instructionPackage;
            relativePath = "share/pi-agent/instructions.md";
          }
        ];
        resources = [
          {
            package = hostileStringPackage supportedPackages.resourcePackage;
            relativePath = "share/pi-agent/resources/rules.md";
          }
        ];
        languageServers = {
          fixture = {
            package = hostileStringPackage supportedPackages.lspPackage;
            relativePath = "bin/fixture-lsp";
          };
          multi = {
            package = hostileStringPackage supportedPackages.multiOutputPackage.tools;
            relativePath = "bin/multi-lsp";
          };
        };
      };
    }
  );
  hostilePackageCfg = hostilePackageEvaluation.config.programs.pi-agent;

  internalManagedConfigOverride = mkEvaluation supportedPkgs (
    supportedPkgs.lib.recursiveUpdate (mkModule supportedPkgs supportedPackages) {
      programs.pi-agent.internal.managedConfig = supportedPkgs.writeText "host-managed-config.json" "{}";
    }
  );
  internalProjectionFactoryOverride = mkEvaluation supportedPkgs (
    supportedPkgs.lib.recursiveUpdate (mkModule supportedPkgs supportedPackages) {
      programs.pi-agent.internal.projectionFactory = supportedPkgs.writeShellScriptBin "host-factory" "exit 0";
    }
  );
  internalUnknownOutput = mkEvaluation supportedPkgs (
    supportedPkgs.lib.recursiveUpdate (mkModule supportedPkgs supportedPackages) {
      programs.pi-agent.internal.runtimeSecrets = { };
    }
  );

  disabledEvaluation = mkEvaluation supportedPkgs { };
  disabledCfg = disabledEvaluation.config.programs.pi-agent;
  disabledEmittedConfigKeys = builtins.filter (
    name:
    builtins.elem name [
      "activation"
      "home"
      "launchd"
      "systemd"
      "xdg"
    ]
  ) (builtins.attrNames disabledEvaluation.config);

  unsupportedPkgs = import flake.inputs.nixpkgs {
    system = "x86_64-darwin";
    overlays = [
      (final: _prev: {
        pi-agent = final.writeShellScriptBin "pi" "exit 0";
      })
    ];
  };
  unsupportedPackages = mkPackages unsupportedPkgs;
  unsupportedEvaluation = mkEvaluation unsupportedPkgs (mkModule unsupportedPkgs unsupportedPackages);

  fixtures = {
    reconciler = supportedPkgs.pi-agent-reconcile;
    pi-runtime = supportedPkgs.pi-agent;
    shopify-managed-config = shopifyCfg.internal.managedConfig;
    shopify-projection-factory = shopifyCfg.internal.projectionFactory;
    personal-managed-config = personalCfg.internal.managedConfig;
    personal-projection-factory = personalCfg.internal.projectionFactory;
    malicious-model-managed-config = maliciousModelCfg.internal.managedConfig;
    malicious-model-projection-factory = maliciousModelCfg.internal.projectionFactory;
    hostile-package-managed-config = hostilePackageCfg.internal.managedConfig;
    path-expectations = {
      extensionManifest = "${supportedPackages.manifestPackage}/share/pi-agent/extensions.json";
      instructionResources = [
        "${supportedPackages.instructionPackage}/share/pi-agent/instructions.md"
        "${supportedPackages.resourcePackage}/share/pi-agent/resources/rules.md"
      ];
      lspExecutables = {
        fixture = "${supportedPackages.lspPackage}/bin/fixture-lsp";
        multi = "${supportedPackages.multiOutputPackage.tools}/bin/multi-lsp";
      };
    };
    disabled = builtins.deepSeq disabledCfg.internal {
      managedConfigIsNull = disabledCfg.internal.managedConfig == null;
      projectionFactoryIsNull = disabledCfg.internal.projectionFactory == null;
      emittedConfigKeys = disabledEmittedConfigKeys;
    };
    unsupported-system = builtins.deepSeq unsupportedEvaluation.config.programs.pi-agent.internal.managedConfig true;
    internal-managed-config-override = builtins.deepSeq internalManagedConfigOverride.config.programs.pi-agent.internal.managedConfig true;
    internal-projection-factory-override = builtins.deepSeq internalProjectionFactoryOverride.config.programs.pi-agent.internal.projectionFactory true;
    internal-unknown-output = builtins.deepSeq internalUnknownOutput.config.programs.pi-agent.internal true;
  };
in
fixtures.${fixture} or (throw "unknown pi-agent managed-config fixture: ${fixture}")
