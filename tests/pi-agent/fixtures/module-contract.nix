{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;

  modulePath = repoRoot + "/home-manager/common/pi-agent/default.nix";
  extensionPackage = pkgs.writeTextDir "lib/pi/extensions/fixture.mjs" "export default {};";
  manifestPackage = pkgs.writeTextDir "share/pi-agent/extensions.json" "{}";
  instructionPackage = pkgs.writeTextDir "share/pi-agent/instructions.md" "# Fixture instructions";
  resourcePackage = pkgs.writeTextDir "share/pi-agent/resources/rules.md" "# Fixture rules";
  lspPackage = pkgs.writeShellScriptBin "fixture-lsp" "exit 0";
  piPackage = pkgs.writeShellScriptBin "pi" "exit 0";
  alternatePiPackage = pkgs.writeShellScriptBin "alternate-pi" "exit 0";
  alternateResourcePackage = pkgs.writeTextDir "share/pi-agent/resources/alternate.md" "alternate";
  alternateLspPackage = pkgs.writeShellScriptBin "alternate-lsp" "exit 0";
  multiOutputPackage =
    pkgs.runCommand "pi-agent-module-multi-output"
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
  swapOutputText =
    metadataPackage: pathPackage:
    metadataPackage
    // {
      outPath = builtins.appendContext (builtins.unsafeDiscardStringContext pathPackage.outPath) (
        builtins.getContext metadataPackage.outPath
      );
    };
  rootContextSwapPackage = swapOutputText piPackage alternatePiPackage;
  resourceContextSwapPackage = swapOutputText resourcePackage alternateResourcePackage;
  lspContextSwapPackage = swapOutputText lspPackage alternateLspPackage;
  forgedPackage = {
    type = "derivation";
    outPath = "/nix/store/00000000000000000000000000000000-forged-package";
    drvPath = "/nix/store/00000000000000000000000000000000-forged-package.drv";
    outputName = "out";
    outputs = [ "out" ];
  };
  decodeCodepoint = hex: builtins.fromJSON "\"\\u${hex}\"";
  unicodeWhitespace = {
    nbsp = decodeCodepoint "00A0";
    ogham = decodeCodepoint "1680";
    en-space = decodeCodepoint "2002";
    em-space = decodeCodepoint "2003";
    thin-space = decodeCodepoint "2009";
    zero-width = decodeCodepoint "200B";
    line-separator = decodeCodepoint "2028";
    paragraph-separator = decodeCodepoint "2029";
    narrow-no-break = decodeCodepoint "202F";
    word-joiner = decodeCodepoint "2060";
    medium-mathematical = decodeCodepoint "205F";
    ideographic = decodeCodepoint "3000";
    bom = decodeCodepoint "FEFF";
  };
  openFreeform = {
    _module.freeformType = lib.types.attrsOf lib.types.anything;
  };

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

  extensionRefs = lib.genAttrs extensionNames (name: {
    package = extensionPackage;
    relativePath = "lib/pi/extensions/${name}.mjs";
  });

  baseModule = {
    programs.pi-agent = {
      enable = true;
      package = piPackage;

      extensions = extensionRefs;
      manifests = [
        {
          package = manifestPackage;
          relativePath = "share/pi-agent/extensions.json";
        }
      ];
      instructions = [
        {
          package = instructionPackage;
          relativePath = "share/pi-agent/instructions.md";
        }
      ];
      resources = [
        {
          package = resourcePackage;
          relativePath = "share/pi-agent/resources/rules.md";
        }
      ];
      languageServers.fixture = {
        package = lspPackage;
        relativePath = "bin/fixture-lsp";
      };
      languageServers.multi = {
        package = multiOutputPackage.tools;
        relativePath = "bin/multi-lsp";
      };

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

      state = {
        generation = "module-contract-v1";
        location = "pi-default";
      };
      mcp = {
        port = 8080;
        cacheTtlDays = 7;
      };
      sandbox.defaultState = "audit";
      subagents = {
        maxDepth = 2;
        termination = {
          gracefulMs = 3000;
          forcedMs = 1000;
        };
      };
      plan = {
        enable = true;
        defaultTools = [
          "read"
          "grep"
          "find"
          "ls"
        ];
      };
      timeouts = {
        resolverMs = 10000;
        preflightMs = 15000;
        bashDefaultMs = 120000;
      };
    };
  };

  validModule = lib.recursiveUpdate baseModule {
    programs.pi-agent.security = {
      allowLiteralProviderValues = false;
      allowCapabilityElevation = false;
      advisories = {
        exceptions = [
          {
            id = "GHSA-fixture";
            rationale = "Fixture exception metadata";
            approver = "fixture-reviewer";
            expiresOn = "2026-12-31";
          }
        ];
      };
    };
  };

  mkEvaluationAt =
    advisoryDate: moduleConfig:
    lib.evalModules {
      modules = [
        modulePath
        moduleConfig
      ];
      specialArgs = {
        inherit pkgs;
        piAgentAdvisoryDate = advisoryDate;
      };
    };
  mkEvaluation = mkEvaluationAt "2026-08-08";

  withPi = value: {
    programs.pi-agent = value;
  };

  overridePi = value: lib.recursiveUpdate baseModule (withPi value);

  summarizeRef = ref: {
    packageIsDerivation = lib.isDerivation ref.package;
    packageHasOutputContext = builtins.getContext ref.package.outPath != { };
    packageOutputName = ref.package.outputName;
    inherit (ref) relativePath;
  };
  summarizeOptionalRef = ref: if ref == null then null else summarizeRef ref;
  summarizeConfig = cfg: {
    inherit (cfg) enable;
    packageIsDerivation = lib.isDerivation cfg.package;
    packageHasOutputContext = builtins.getContext cfg.package.outPath != { };
    packageOutputName = cfg.package.outputName;
    extensions = lib.mapAttrs (_: summarizeOptionalRef) cfg.extensions;
    manifests = map summarizeRef cfg.manifests;
    instructions = map summarizeRef cfg.instructions;
    resources = map summarizeRef cfg.resources;
    languageServers = lib.mapAttrs (_: summarizeRef) cfg.languageServers;
    inherit (cfg) provider;
    resolverKinds = cfg.internal.resolverKinds;
    security = cfg.security or null;
    sandboxCatalog =
      if cfg.internal.sandboxCatalog == null then
        null
      else
        {
          packageIsDerivation = lib.isDerivation cfg.internal.sandboxCatalog;
          packageHasOutputContext = builtins.getContext cfg.internal.sandboxCatalog.outPath != { };
          packageOutputName = cfg.internal.sandboxCatalog.outputName;
        };
    inherit (cfg)
      state
      mcp
      sandbox
      subagents
      plan
      timeouts
      ;
  };

  forceModuleAt =
    advisoryDate: moduleConfig:
    let
      cfg = (mkEvaluationAt advisoryDate moduleConfig).config.programs.pi-agent;
    in
    builtins.deepSeq (summarizeConfig cfg) true;
  forceModule = forceModuleAt "2026-08-08";

  validEvaluation = mkEvaluation validModule;
  validCfg = validEvaluation.config.programs.pi-agent;
  validSummary = summarizeConfig validCfg;

  personalEvaluation = mkEvaluation (overridePi {
    provider = {
      mode = "personal";
      enabledRoles = [ ];
      defaultModel = {
        provider = "openai";
        modelId = "gpt-5.6-sol";
      };
    };
  });

  disabledEvaluation = mkEvaluation { };
  disabledCfg = disabledEvaluation.config.programs.pi-agent;
  emittedConfigKeys = builtins.filter (
    name:
    builtins.elem name [
      "activation"
      "home"
      "launchd"
      "systemd"
      "xdg"
    ]
  ) (builtins.attrNames disabledEvaluation.config);
  enabledEmittedConfigKeys = builtins.filter (
    name:
    builtins.elem name [
      "activation"
      "launchd"
      "systemd"
    ]
  ) (builtins.attrNames validEvaluation.config);

  invalidPath =
    relativePath:
    forceModule (overridePi {
      extensions.cavemem = {
        package = extensionPackage;
        inherit relativePath;
      };
    });
  timeoutSummary =
    value:
    let
      timeouts =
        (mkEvaluation (overridePi {
          timeouts.bashDefaultMs = value;
        })).config.programs.pi-agent.timeouts;
    in
    builtins.deepSeq timeouts timeouts;
  invalidBashTimeout =
    value:
    forceModule (overridePi {
      timeouts.bashDefaultMs = value;
    });

  incompleteAdvisory = {
    id = "GHSA-incomplete";
    rationale = "Missing an approver";
    expiresOn = "2026-12-31";
  };
  mkAdvisory =
    overrides:
    {
      id = "GHSA-fixture";
      rationale = "Fixture exception metadata";
      approver = "fixture-reviewer";
      expiresOn = "2026-12-31";
    }
    // overrides;
  securityModule =
    exceptions:
    lib.recursiveUpdate baseModule {
      programs.pi-agent.security = {
        allowLiteralProviderValues = false;
        allowCapabilityElevation = false;
        advisories = { inherit exceptions; };
      };
    };
  securitySummaryAt =
    advisoryDate: moduleConfig:
    let
      security = (mkEvaluationAt advisoryDate moduleConfig).config.programs.pi-agent.security;
    in
    builtins.deepSeq security security;
  unicodeWhitespaceFixtures = lib.mapAttrs' (
    name: whitespace:
    lib.nameValuePair "advisory-unicode-${name}" (
      forceModule (securityModule [
        (mkAdvisory { id = "${whitespace}${whitespace}"; })
      ])
    )
  ) unicodeWhitespace;

  fixtures = {
    valid-shopify = builtins.deepSeq validSummary validSummary;
    valid-personal =
      let
        cfg = personalEvaluation.config.programs.pi-agent;
        summary = {
          inherit (cfg.provider) mode enabledRoles defaultModel;
          resolverKinds = cfg.internal.resolverKinds;
        };
      in
      builtins.deepSeq summary summary;
    disabled = builtins.deepSeq (summarizeConfig disabledCfg) {
      inherit (disabledCfg) enable;
      inherit emittedConfigKeys;
      inherit (summarizeConfig disabledCfg) sandboxCatalog;
    };
    bash-timeout-min = timeoutSummary 1;
    bash-timeout-max = timeoutSummary 2147483647;
    bash-timeout-non-default = timeoutSummary 543210;
    bash-activation-purity = builtins.deepSeq validSummary enabledEmittedConfigKeys;
    advisory-normalized = securitySummaryAt "2026-08-08" (securityModule [
      (mkAdvisory {
        id = "  GHSA-normalized  ";
        rationale = "\tNormalized   fixture\t rationale\n";
        approver = "  fixture-reviewer  ";
      })
    ]);
    advisory-unicode-normalized = securitySummaryAt "2026-08-08" (securityModule [
      (mkAdvisory {
        id = "GHSA-unicode-normalized";
        rationale = "Unicode${unicodeWhitespace.nbsp}internal${unicodeWhitespace.em-space}rationale";
      })
    ]);
    advisory-leap-positive = securitySummaryAt "2024-02-28" (securityModule [
      (mkAdvisory {
        id = "GHSA-leap";
        expiresOn = "2024-02-29";
      })
    ]);
    advisory-boundary-active = securitySummaryAt "2026-08-08" (securityModule [
      (mkAdvisory {
        id = "GHSA-boundary-active";
        expiresOn = "2026-08-09";
      })
    ]);

    path-empty = invalidPath "";
    path-absolute = invalidPath "/lib/pi/extension.mjs";
    path-dot = invalidPath "lib/./extension.mjs";
    path-dot-dot = invalidPath "lib/../extension.mjs";
    path-double-separator = invalidPath "lib//extension.mjs";
    path-trailing-separator = invalidPath "lib/pi/";
    path-backslash = invalidPath "lib\\pi\\extension.mjs";
    path-encoded-traversal = invalidPath "lib/%2e%2e/extension.mjs";

    shopify-empty-roles = forceModule (overridePi {
      provider.enabledRoles = [ ];
    });
    shopify-duplicate-roles = forceModule (overridePi {
      provider.enabledRoles = [
        "openai"
        "openai"
      ];
    });
    shopify-disabled-default = forceModule (overridePi {
      provider = {
        enabledRoles = [ "anthropic" ];
        defaultModel.provider = "openai";
      };
    });
    enabled-missing-default = forceModule (overridePi {
      provider.defaultModel = null;
    });
    personal-non-openai-default = forceModule (overridePi {
      provider = {
        mode = "personal";
        enabledRoles = [ ];
        defaultModel.provider = "anthropic";
      };
    });
    personal-shopify-roles = forceModule (overridePi {
      provider = {
        mode = "personal";
        enabledRoles = [ "openai" ];
      };
    });
    unsupported-role = forceModule (overridePi {
      provider.enabledRoles = [ "cohere" ];
    });

    provider-headers = forceModule (overridePi {
      provider.headers.X-ApiKey = "fixture-secret";
    });
    provider-base-url = forceModule (overridePi {
      provider.baseUrl = "https://token@example.invalid";
    });
    provider-runtime-base-path = forceModule (overridePi {
      provider.runtimeBasePath = "?token=fixture-secret";
    });
    provider-model-metadata = forceModule (overridePi {
      provider.defaultModel.contextWindow = 1000000;
    });
    provider-model-store-string = forceModule (overridePi {
      provider.defaultModel.modelId = "/nix/store/fixture-model";
    });
    provider-model-shell-text = forceModule (overridePi {
      provider.defaultModel.modelId = "model; printf fixture-secret";
    });
    provider-public-literal = forceModule (overridePi {
      provider.publicLiterals.affinityHeader = "fixture-affinity";
    });
    provider-secret-argv = forceModule (overridePi {
      provider.resolvers.shopify-gateway-token.argv = [
        "--token"
        "fixture-secret"
      ];
    });
    provider-environment-name = forceModule (overridePi {
      provider.resolvers.shopify-gateway-token.environmentName = "FIXTURE_SECRET";
    });

    extension-store-root = forceModule (overridePi {
      extensions.cavemem.storeRoot = "/nix/store/fixture-root";
    });
    extension-raw-package-string = forceModule (overridePi {
      extensions.cavemem.package = "/nix/store/fixture-package";
    });
    root-forged-package = forceModule (overridePi {
      package = forgedPackage;
    });
    resource-forged-package = forceModule (overridePi {
      resources = [
        {
          package = forgedPackage;
          relativePath = "share/pi-agent/resources/forged.md";
        }
      ];
    });
    lsp-forged-package = forceModule (overridePi {
      languageServers.fixture.package = forgedPackage;
    });
    root-context-swap-package = forceModule (overridePi {
      package = rootContextSwapPackage;
    });
    resource-context-swap-package = forceModule (overridePi {
      resources = [
        {
          package = resourceContextSwapPackage;
          relativePath = "share/pi-agent/resources/alternate.md";
        }
      ];
    });
    lsp-context-swap-package = forceModule (overridePi {
      languageServers.fixture.package = lspContextSwapPackage;
    });
    extension-arbitrary-name = forceModule (overridePi {
      extensions.unreviewed = {
        package = extensionPackage;
        relativePath = "lib/pi/extensions/unreviewed.mjs";
      };
    });
    subagent-shell = forceModule (overridePi {
      subagents.shell = "printf fixture-secret";
    });
    mcp-endpoint = forceModule (overridePi {
      mcp.endpoint = "https://example.invalid/mcp";
    });
    plan-executable-tool = forceModule (overridePi {
      plan.defaultTools = [
        "read"
        "bash"
      ];
    });
    timeout-string = forceModule (overridePi {
      timeouts.resolverMs = "ten seconds";
    });
    bash-timeout-zero = invalidBashTimeout 0;
    bash-timeout-negative = invalidBashTimeout (-1);
    bash-timeout-non-integer = invalidBashTimeout 1.5;
    bash-timeout-overflow = invalidBashTimeout 2147483648;
    bash-public-shell-path = forceModule (overridePi {
      shellPath = "/tmp/host-shell";
    });
    bash-public-shell-text = forceModule (overridePi {
      shell.text = "printf host-shell";
    });
    bash-public-shell-argv = forceModule (overridePi {
      shell.argv = [ "--host-shell" ];
    });
    bash-public-binding-name = forceModule (overridePi {
      timeouts.bindingName = "HOST_BASH_TIMEOUT";
    });
    state-generation-shell-text = forceModule (overridePi {
      state.generation = "generation; printf fixture-secret";
    });

    freeform-root-provider-url = forceModule (
      overridePi (
        openFreeform
        // {
          providerUrl = "https://example.invalid/provider";
        }
      )
    );
    freeform-extension = forceModule (overridePi {
      extensions = openFreeform // {
        unreviewed = {
          package = extensionPackage;
          relativePath = "lib/pi/extensions/unreviewed.mjs";
        };
      };
    });
    freeform-resource-ref = forceModule (overridePi {
      resources = [
        (
          openFreeform
          // {
            package = resourcePackage;
            relativePath = "share/pi-agent/resources/rules.md";
            storeRoot = "/nix/store/freeform-resource-root";
          }
        )
      ];
    });
    freeform-provider = forceModule (overridePi {
      provider = openFreeform // {
        baseUrl = "https://example.invalid/provider";
      };
    });
    freeform-model = forceModule (overridePi {
      provider.defaultModel = openFreeform // {
        contextWindow = 1000000;
      };
    });
    freeform-state = forceModule (overridePi {
      state = openFreeform // {
        storeRoot = "/nix/store/freeform-state-root";
      };
    });
    freeform-mcp = forceModule (overridePi {
      mcp = openFreeform // {
        endpoint = "https://example.invalid/mcp";
      };
    });
    freeform-sandbox = forceModule (overridePi {
      sandbox = openFreeform // {
        profile = "unreviewed";
      };
    });
    freeform-subagent = forceModule (overridePi {
      subagents = openFreeform // {
        shell = "printf fixture-secret";
      };
    });
    freeform-termination = forceModule (overridePi {
      subagents.termination = openFreeform // {
        argv = [ "fixture-secret" ];
      };
    });
    freeform-plan = forceModule (overridePi {
      plan = openFreeform // {
        shell = "printf fixture-secret";
      };
    });
    freeform-timeouts = forceModule (overridePi {
      timeouts = openFreeform // {
        command = "sleep infinity";
      };
    });
    freeform-security = forceModule (overridePi {
      security = openFreeform // {
        providerHeaders.X-ApiKey = "fixture-secret";
      };
    });
    freeform-advisories = forceModule (overridePi {
      security.advisories = openFreeform // {
        evaluationDate = "2026-08-08";
      };
    });
    freeform-advisory-entry = forceModule (securityModule [
      (
        openFreeform
        // (mkAdvisory { })
        // {
          headers.X-ApiKey = "fixture-secret";
        }
      )
    ]);

    top-level-advisories = forceModule (overridePi {
      advisories.exceptions = [ ];
    });
    security-literal-provider-values = forceModule (overridePi {
      security.allowLiteralProviderValues = true;
    });
    security-capability-elevation = forceModule (overridePi {
      security.allowCapabilityElevation = true;
    });
    advisory-incomplete = forceModule (securityModule [ incompleteAdvisory ]);
    advisory-host-date = forceModule (
      lib.recursiveUpdate
        (securityModule [
          (mkAdvisory { })
        ])
        {
          programs.pi-agent.security.advisories.evaluationDate = "2026-08-08";
        }
    );
    advisory-missing-date = forceModuleAt null (securityModule [
      (mkAdvisory { })
    ]);
    advisory-invalid-date = forceModuleAt "not-a-date" validModule;
    advisory-impossible-date = forceModule (securityModule [
      (mkAdvisory {
        id = "GHSA-impossible";
        expiresOn = "2026-04-31";
      })
    ]);
    advisory-non-leap-date = forceModuleAt "2026-02-01" (securityModule [
      (mkAdvisory {
        id = "GHSA-non-leap";
        expiresOn = "2026-02-29";
      })
    ]);
    advisory-century-non-leap-date = forceModuleAt "2100-02-01" (securityModule [
      (mkAdvisory {
        id = "GHSA-century-non-leap";
        expiresOn = "2100-02-29";
      })
    ]);
    advisory-invalid-evaluation-date = forceModuleAt "2026-02-29" validModule;
    advisory-whitespace-id = forceModule (securityModule [
      (mkAdvisory { id = " \t\n "; })
    ]);
    advisory-whitespace-rationale = forceModule (securityModule [
      (mkAdvisory { rationale = " \t\n "; })
    ]);
    advisory-whitespace-approver = forceModule (securityModule [
      (mkAdvisory { approver = " \t\n "; })
    ]);
    advisory-duplicate-id = forceModule (securityModule [
      (mkAdvisory { id = " GHSA-duplicate "; })
      (mkAdvisory { id = "GHSA-duplicate"; })
    ]);
    advisory-unicode-duplicate-id = forceModule (securityModule [
      (mkAdvisory { id = "GHSA${unicodeWhitespace.nbsp}duplicate"; })
      (mkAdvisory { id = "GHSA duplicate"; })
    ]);
    advisory-expired = forceModule (securityModule [
      (mkAdvisory {
        id = "GHSA-expired";
        rationale = "Expired fixture";
        expiresOn = "2026-08-08";
      })
    ]);
  }
  // unicodeWhitespaceFixtures;
in
fixtures.${fixture} or (throw "unknown pi-agent module fixture: ${fixture}")
