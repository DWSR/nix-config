{
  config,
  lib,
  piAgentAdvisoryDate ? null,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;
  homeConfig = config;
  gatewayResolverPackage = pkgs.writeShellScriptBin "devx" ''
    set -eu
    gateway="$(command -v devx || true)"
    if [ -z "$gateway" ]; then
      printf '%s\n' "pi-agent: managed Shopify gateway command is unavailable" >&2
      exit 127
    fi
    exec "$gateway" "$@"
  '';
  credentialPolicy = import ./credential-policy.nix {
    inherit lib pkgs;
    trustedDevxOutPath = gatewayResolverPackage.outPath;
  };
  managedConfigRenderer = import ./managed-config.nix {
    inherit lib pkgs;
    shellPath = credentialPolicy.shellExecutable;
  };
  profileCatalogRenderer = import ./profiles.nix { inherit lib pkgs; };
  guidance = import ./guidance.nix { inherit pkgs; };

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
  extensionPackage = pkgs.pi-agent-extensions;
  extensionEntryPaths = {
    cavemem = "lib/pi-agent/extensions/cavemem/index.ts";
    mcp = "lib/pi-agent/extensions/mcpproxy/index.ts";
    subagents = "lib/node_modules/pi-subagents/index.ts";
    plan = "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts";
    timestamps = "lib/node_modules/@narumitw/pi-stamp/src/index.ts";
    bashTimeout = "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts";
    questions = "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts";
    codeIntelligence = "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts";
    backgroundTasks = "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts";
  };
  defaultExtensionRefs = lib.genAttrs extensionNames (name: {
    package = extensionPackage;
    relativePath = extensionEntryPaths.${name};
  });
  defaultManifestRef = {
    package = extensionPackage;
    relativePath = "share/pi-agent/extensions.json";
  };
  renderIntegration =
    {
      cfg,
      managedConfig,
      outerConfig,
      projectionFactory,
      providerHandoff,
    }:
    let
      profileCatalog = import ./profiles.nix {
        inherit (pkgs) lib;
        inherit pkgs;
      };
      integrationPolicy = import ./credential-policy.nix {
        inherit lib pkgs;
        trustedDevxOutPath = gatewayResolverPackage.outPath;
      };
      credentialArtifacts = integrationPolicy.render { hostSelection = cfg.provider; };
      renderReference = reference: "${reference.package.outPath}/${reference.relativePath}";
      integrationExtensionPackage = pkgs.pi-agent-extensions;
      extensionManifest = renderReference (builtins.head cfg.manifests);
      extensionIdentity = "${integrationExtensionPackage.identity}/extensions-provenance.json";
      homeDirectory = toString outerConfig.home.homeDirectory;
      cavememDataDir =
        if outerConfig.home ? cavemem && outerConfig.home.cavemem ? dataDir then
          toString outerConfig.home.cavemem.dataDir
        else
          "${homeDirectory}/.local/share/cavemem";
      agentDir = "${homeDirectory}/.pi/agent";
      profilePaths = lib.mapAttrs (
        name: _profile: "${profileCatalog.package}/share/pi-agent/nono/profiles/${name}.json"
      ) profileCatalog.profiles;
      sandboxResolver = pkgs.callPackage ../../../scripts/pi-agent-sandbox-resolver.nix {
        defaultState = cfg.sandbox.defaultState;
      };
      sandboxExecutor = pkgs.callPackage ../../../scripts/pi-agent-sandbox-executor.nix {
        defaultState = cfg.sandbox.defaultState;
        piPackage = cfg.package;
        inherit profileCatalog;
      };
      reconciler = pkgs.pi-agent-reconcile;
      status = pkgs.callPackage ../../../scripts/pi-agent-status.nix {
        cavememPackage = pkgs.cavemem;
        credentialRuntimeModule = credentialArtifacts.runtimeModule;
        defaultState = cfg.sandbox.defaultState;
        extensionIdentity = integrationExtensionPackage.identity;
        inherit extensionManifest;
        extensionPackage = integrationExtensionPackage;
        inherit managedConfig;
        piPackage = cfg.package;
      };
      validator = pkgs.callPackage ../../../scripts/pi-agent-validate.nix {
        credentialRuntimeModule = credentialArtifacts.runtimeModule;
        extensionPackage = integrationExtensionPackage;
        piPackage = cfg.package;
        inherit profileCatalog;
        statusPackage = status;
      };
      launcher = pkgs.callPackage ../../../scripts/pi-agent-launcher.nix {
        cavememPackage = pkgs.cavemem;
        credentialResolverPackage = credentialArtifacts.resolverExecutor;
        credentialRuntimeModule = credentialArtifacts.runtimeModule;
        inherit managedConfig;
        piPackage = cfg.package;
        inherit projectionFactory providerHandoff;
        reconcilerPackage = reconciler;
        sandboxExecutorPackage = sandboxExecutor;
        sandboxResolverPackage = sandboxResolver;
        statusPackage = status;
        validatorPackage = validator;
      };
      commandSource = pkgs.writeText "pi-agent-managed-command.mjs" ''
        import { executeManagedLaunch } from ${builtins.toJSON "${launcher}/lib/pi-agent/launcher.mjs"};

        const args = process.argv.slice(2);
        const agentDir = ${builtins.toJSON agentDir};
        const cavememDataDir = ${builtins.toJSON cavememDataDir};

        if (args[0] === "--managed-status") {
          const { spawnSync } = await import("node:child_process");
          const statusArgs = args.slice(1);
          if (statusArgs.some((arg) => arg !== "--json")) process.exitCode = 64;
          else {
            const result = spawnSync(
              ${builtins.toJSON "${status}/bin/pi-agent-status"},
              statusArgs,
              {
                encoding: "utf8",
                input: JSON.stringify({ schemaVersion: 1, agentDir, cavememDataDir }) + "\\n",
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            process.exitCode = result.status ?? 2;
          }
        } else {
          try {
            const result = await executeManagedLaunch({ agentDir, cavememDataDir, userArguments: args });
            process.exitCode = result?.status ?? 0;
          } catch (error) {
            const component =
              error?.name === "ManagedLaunchError" &&
              typeof error.component === "string"
                ? error.component
                : "unknown";
            const recovery =
              error?.name === "ManagedLaunchError" &&
              typeof error.recovery === "string"
                ? error.recovery
                : "run pi-agent-status and repair the managed generation";
            process.stderr.write(
              `Managed launch failed: ${"$"}{component}. Recovery: ${"$"}{recovery}.\n`,
            );
            process.exitCode = 1;
          }
        }
      '';
      managedCommand = pkgs.writeTextFile {
        name = "pi-agent-launcher";
        destination = "/bin/pi";
        executable = true;
        text = ''
          #!${pkgs.runtimeShell}
          exec ${pkgs.nodejs}/bin/node ${commandSource} "$@"
        '';
      };
      statusCommand = pkgs.writeTextFile {
        name = "pi-agent-status";
        destination = "/bin/pi-agent-status";
        executable = true;
        text = ''
          #!${pkgs.runtimeShell}
          exec ${pkgs.nodejs}/bin/node -e ${lib.escapeShellArg ''
            const { spawnSync } = require("node:child_process");
            const result = spawnSync(${builtins.toJSON "${status}/bin/pi-agent-status"}, process.argv.slice(1), {
              encoding: "utf8",
              input: JSON.stringify({ schemaVersion: 1, agentDir: ${builtins.toJSON agentDir}, cavememDataDir: ${builtins.toJSON cavememDataDir} }) + "\\n",
              stdio: ["pipe", "inherit", "inherit"],
            });
            process.exitCode = result.status ?? 2;
          ''} "$@"
        '';
      };
      validatorCommand = pkgs.writeTextFile {
        name = "pi-agent-validate";
        destination = "/bin/pi-agent-validate";
        executable = true;
        text = ''
          #!${pkgs.runtimeShell}
          exec ${pkgs.nodejs}/bin/node -e ${lib.escapeShellArg ''
            const { spawnSync } = require("node:child_process");
            const result = spawnSync(${builtins.toJSON "${validator}/bin/pi-agent-validate"}, process.argv.slice(1), {
              encoding: "utf8",
              input: JSON.stringify({ schemaVersion: 1, agentDir: ${builtins.toJSON agentDir}, cavememDataDir: ${builtins.toJSON cavememDataDir} }) + "\\n",
              stdio: ["pipe", "inherit", "inherit"],
            });
            process.exitCode = result.status ?? 2;
          ''} "$@"
        '';
      };
    in
    {
      inherit
        agentDir
        cavememDataDir
        extensionIdentity
        extensionManifest
        managedCommand
        reconciler
        sandboxExecutor
        sandboxResolver
        status
        statusCommand
        validator
        validatorCommand
        ;
      credentialResolver = credentialArtifacts.resolverExecutor;
      credentialRuntimeModule = credentialArtifacts.runtimeModule;
      inherit (credentialArtifacts) resolverPlans;
      instructionResources = map renderReference (cfg.instructions ++ cfg.resources);
      inherit launcher;
      inherit (integrationPolicy) managedShell;
      inherit profilePaths;
      statusInputs = {
        inherit
          agentDir
          cavememDataDir
          extensionIdentity
          extensionManifest
          ;
        managedConfig = toString managedConfig;
      };
      commands = [
        "pi"
        "pi-agent-status"
        "pi-agent-validate"
        "pi-agent-reconcile"
      ];
    };
  shopifyProviderRoles = [
    "anthropic"
    "openai"
    "google"
    "groq"
    "xai"
  ];
  inherit (credentialPolicy) resolverKinds;

  decodeCodepoint = hex: builtins.fromJSON "\"\\u${hex}\"";
  metadataUnicodeWhitespace = map decodeCodepoint [
    "00A0"
    "1680"
    "2000"
    "2001"
    "2002"
    "2003"
    "2004"
    "2005"
    "2006"
    "2007"
    "2008"
    "2009"
    "200A"
    "200B"
    "2028"
    "2029"
    "202F"
    "205F"
    "2060"
    "3000"
    "FEFF"
  ];
  normalizeWhitespace =
    value:
    let
      unicodeNormalized = lib.replaceStrings metadataUnicodeWhitespace (map (
        _: " "
      ) metadataUnicodeWhitespace) value;
    in
    lib.concatStringsSep " " (
      builtins.filter (part: builtins.isString part && part != "") (
        builtins.split "[[:space:]]+" unicodeNormalized
      )
    );
  trimmedMetadataType = types.addCheck types.str (value: normalizeWhitespace value != "") // {
    description = "trimmed non-empty advisory metadata";
  };
  safeIdentifierType =
    types.addCheck types.str (value: builtins.match "[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*" value != null)
    // {
      description = "safe non-empty identifier";
    };
  catalogModelIdType =
    types.addCheck types.str (
      value:
      builtins.match "[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*(/[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*)*" value != null
    )
    // {
      description = "safe catalog model identifier";
    };
  hasDerivationOutputContext =
    package:
    if
      !(
        lib.isDerivation package
        && package ? outPath
        && package ? drvPath
        && package ? outputName
        && package ? outputs
        && builtins.isString package.outPath
        && builtins.isString package.drvPath
        && builtins.isString package.outputName
        && builtins.isList package.outputs
        && lib.all builtins.isString package.outputs
        && builtins.hasAttr package.outputName package
      )
    then
      false
    else
      let
        drvPath = builtins.unsafeDiscardStringContext package.drvPath;
        drvReference = (builtins.getContext package.drvPath).${drvPath} or null;
        outputReference = (builtins.getContext package.outPath).${drvPath} or null;
        selectedOutput = builtins.getAttr package.outputName package;
      in
      builtins.elem package.outputName package.outputs
      && lib.isDerivation selectedOutput
      && selectedOutput ? outPath
      && selectedOutput ? drvPath
      && selectedOutput ? outputName
      && builtins.isString selectedOutput.outPath
      && builtins.isString selectedOutput.drvPath
      && selectedOutput.outputName == package.outputName
      && builtins.unsafeDiscardStringContext selectedOutput.drvPath == drvPath
      && builtins.getContext selectedOutput.drvPath == builtins.getContext package.drvPath
      &&
        builtins.unsafeDiscardStringContext selectedOutput.outPath
        == builtins.unsafeDiscardStringContext package.outPath
      && builtins.getContext selectedOutput.outPath == builtins.getContext package.outPath
      && drvReference != null
      && (drvReference.allOutputs or false)
      && outputReference != null
      && builtins.elem package.outputName (outputReference.outputs or [ ]);
  derivationPackageType = types.addCheck types.package hasDerivationOutputContext // {
    description = "context-backed Nix derivation package";
  };
  digitValues = {
    "0" = 0;
    "1" = 1;
    "2" = 2;
    "3" = 3;
    "4" = 4;
    "5" = 5;
    "6" = 6;
    "7" = 7;
    "8" = 8;
    "9" = 9;
  };
  parseDecimal =
    value:
    lib.foldl' (result: digit: result * 10 + digitValues.${digit}) 0 (lib.stringToCharacters value);
  isGregorianDate =
    value:
    builtins.isString value
    && builtins.match "[0-9]{4}-[0-9]{2}-[0-9]{2}" value != null
    && (
      let
        year = parseDecimal (builtins.substring 0 4 value);
        month = parseDecimal (builtins.substring 5 2 value);
        day = parseDecimal (builtins.substring 8 2 value);
        leapYear = lib.mod year 400 == 0 || (lib.mod year 4 == 0 && lib.mod year 100 != 0);
        monthLengths = [
          31
          (if leapYear then 29 else 28)
          31
          30
          31
          30
          31
          31
          30
          31
          30
          31
        ];
      in
      year >= 1
      && month >= 1
      && month <= 12
      && day >= 1
      && day <= builtins.elemAt monthLengths (month - 1)
    );
  canonicalDateType = types.addCheck types.str isGregorianDate // {
    description = "Gregorian date in YYYY-MM-DD form";
  };
  canonicalRelativePathType =
    types.addCheck types.str (
      value:
      let
        segments = lib.splitString "/" value;
      in
      value != ""
      && lib.all (segment: segment != "." && segment != "..") segments
      && builtins.match "[A-Za-z0-9._+,:=@~-]+(/[A-Za-z0-9._+,:=@~-]+)*" value != null
    )
    // {
      description = "canonical package-relative path";
    };
  closedSubmodule =
    module:
    types.submodule {
      imports = [ module ];
      config._module.freeformType = lib.mkForce null;
    };

  packageResourceRefType = closedSubmodule {
    options = {
      package = mkOption {
        type = derivationPackageType;
        description = "Nix package containing the referenced resource.";
      };
      relativePath = mkOption {
        type = canonicalRelativePathType;
        description = "Canonical path relative to the package output root.";
      };
    };
  };
  languageServerMapType =
    types.addCheck (types.attrsOf packageResourceRefType) (
      servers: lib.all (name: safeIdentifierType.check name) (builtins.attrNames servers)
    )
    // {
      description = "language-server map with safe identifiers and package-backed executables";
    };
  optionalPackageResourceRef =
    name:
    mkOption {
      type = types.nullOr packageResourceRefType;
      default = null;
      description = "Package-backed reference for the managed ${name} extension.";
    };

  modelRefType = closedSubmodule {
    options = {
      provider = mkOption {
        type = types.enum shopifyProviderRoles;
        default = "openai";
        description = "Closed provider role referenced by the model.";
      };
      modelId = mkOption {
        type = catalogModelIdType;
        description = "Safe built-in model identifier.";
      };
    };
  };
  providerSelectionType = closedSubmodule {
    options = {
      mode = mkOption {
        type = types.enum [
          "personal"
          "shopify-gateway"
        ];
        default = "personal";
        description = "Host provider mode.";
      };
      enabledRoles = mkOption {
        type = types.listOf (types.enum shopifyProviderRoles);
        default = [ ];
        description = "Shopify provider roles enabled for this host.";
      };
      defaultModel = mkOption {
        type = types.nullOr modelRefType;
        default = null;
        description = "Default model reference within the selected provider catalog.";
      };
    };
  };
  validateProviderSelection =
    selection:
    if selection.mode == "personal" && selection.enabledRoles != [ ] then
      throw "programs.pi-agent.provider: personal mode does not accept Shopify enabled roles"
    else if selection.mode == "shopify-gateway" && selection.enabledRoles == [ ] then
      throw "programs.pi-agent.provider: Shopify gateway mode requires at least one enabled role"
    else if lib.unique selection.enabledRoles != selection.enabledRoles then
      throw "programs.pi-agent.provider: enabled roles must be unique"
    else if selection.defaultModel == null then
      selection
    else if selection.mode == "personal" && selection.defaultModel.provider != "openai" then
      throw "programs.pi-agent.provider: personal mode requires the OpenAI default provider"
    else if
      selection.mode == "shopify-gateway"
      && !builtins.elem selection.defaultModel.provider selection.enabledRoles
    then
      throw "programs.pi-agent.provider: default model provider `${selection.defaultModel.provider}` is not enabled"
    else
      selection;

  readOnlyPlanToolType =
    types.enum [
      "read"
      "grep"
      "find"
      "ls"
    ]
    // {
      description = "read-only plan tool";
    };
  validatePlan =
    plan:
    if plan.defaultTools == [ ] then
      throw "programs.pi-agent.plan.defaultTools must not be empty"
    else if lib.unique plan.defaultTools != plan.defaultTools then
      throw "programs.pi-agent.plan.defaultTools must be unique"
    else
      plan;

  advisoryExceptionType = closedSubmodule {
    options = {
      id = mkOption {
        type = trimmedMetadataType;
        apply = normalizeWhitespace;
        description = "Advisory identifier.";
      };
      rationale = mkOption {
        type = trimmedMetadataType;
        apply = normalizeWhitespace;
        description = "Reason the exception is accepted.";
      };
      approver = mkOption {
        type = trimmedMetadataType;
        apply = normalizeWhitespace;
        description = "Identity of the exception approver.";
      };
      expiresOn = mkOption {
        type = canonicalDateType;
        description = "Last date before the exception is expired.";
      };
    };
  };
  advisoryConfigType = closedSubmodule {
    options.exceptions = mkOption {
      type = types.listOf advisoryExceptionType;
      default = [ ];
      description = "Complete, time-bounded production advisory exceptions.";
    };
  };
  validateAdvisories =
    advisories:
    let
      ids = map (exception: exception.id) advisories.exceptions;
      expired =
        if piAgentAdvisoryDate == null then
          null
        else
          lib.findFirst (exception: exception.expiresOn <= piAgentAdvisoryDate) null advisories.exceptions;
    in
    if piAgentAdvisoryDate != null && !isGregorianDate piAgentAdvisoryDate then
      throw "piAgentAdvisoryDate must be a Gregorian date in YYYY-MM-DD form"
    else if advisories.exceptions != [ ] && piAgentAdvisoryDate == null then
      throw "programs.pi-agent.security.advisories: advisory exceptions require an evaluation date"
    else if lib.unique ids != ids then
      throw "programs.pi-agent.security.advisories: advisory exception IDs must be unique"
    else if expired != null then
      throw "programs.pi-agent.security.advisories: advisory exception `${expired.id}` expired on ${expired.expiresOn}"
    else
      advisories;
  fixedFalseType = types.enum [ false ] // {
    description = "false (fixed module security ceiling)";
  };
  securityType = closedSubmodule {
    options = {
      allowLiteralProviderValues = mkOption {
        type = fixedFalseType;
        default = false;
        description = "Whether host-authored literal provider values are permitted.";
      };
      allowCapabilityElevation = mkOption {
        type = fixedFalseType;
        default = false;
        description = "Whether managed processes may request capability elevation.";
      };
      advisories = mkOption {
        type = advisoryConfigType;
        default = { };
        apply = validateAdvisories;
        description = "Strict production advisory exception metadata.";
      };
    };
  };
  validateAgentConfig =
    cfg:
    if cfg ? internal && cfg.internal ? managedConfig && cfg.internal.managedConfig != null then
      throw "programs.pi-agent.internal.managedConfig is read-only"
    else if
      cfg ? internal && cfg.internal ? projectionFactory && cfg.internal.projectionFactory != null
    then
      throw "programs.pi-agent.internal.projectionFactory is read-only"
    else if
      cfg ? internal && cfg.internal ? guidancePackage && cfg.internal.guidancePackage != null
    then
      throw "programs.pi-agent.internal.guidancePackage is read-only"
    else
      let
        validated =
          if cfg.enable && pkgs.stdenv.hostPlatform.system != managedConfigRenderer.supportedSystem then
            managedConfigRenderer.validateSystem cfg
          else if cfg.enable && cfg.provider.defaultModel == null then
            throw "programs.pi-agent.provider.defaultModel must be set when programs.pi-agent is enabled"
          else
            cfg;
        rendered = if validated.enable then managedConfigRenderer.render validated else null;
        integrated =
          if validated.enable then
            renderIntegration {
              cfg = validated;
              outerConfig = homeConfig;
              inherit (rendered) managedConfig projectionFactory;
              providerHandoff = rendered.shopifyProviderHandoff;
            }
          else
            { };
        internal = {
          inherit resolverKinds;
          managedConfig = if rendered == null then null else rendered.managedConfig;
          projectionFactory = if rendered == null then null else rendered.projectionFactory;
          shopifyProviderHandoff = if rendered == null then null else rendered.shopifyProviderHandoff;
          sandboxCatalog = if validated.enable then profileCatalogRenderer.package else null;
          guidancePackage = if validated.enable then guidance.package else null;
          credentialRuntimeModule = integrated.credentialRuntimeModule or null;
          credentialResolver = integrated.credentialResolver or null;
          managedShell = integrated.managedShell or null;
          resolverPlans = integrated.resolverPlans or [ ];
          sandboxResolver = integrated.sandboxResolver or null;
          sandboxExecutor = integrated.sandboxExecutor or null;
          reconciler = integrated.reconciler or null;
          launcher = integrated.launcher or null;
          status = integrated.status or null;
          validator = integrated.validator or null;
          managedCommand = integrated.managedCommand or null;
          managedStatusCommand = integrated.statusCommand or null;
          managedValidatorCommand = integrated.validatorCommand or null;
          cavememDataDir = integrated.cavememDataDir or null;
          extensionManifest = integrated.extensionManifest or null;
          extensionIdentity = integrated.extensionIdentity or null;
          instructionResources = integrated.instructionResources or [ ];
          profilePaths = integrated.profilePaths or { };
          statusInputs = integrated.statusInputs or { };
          commands = integrated.commands or [ ];
        };
      in
      validated // { inherit internal; };
in
{
  options.programs.pi-agent = mkOption {
    type = closedSubmodule {
      imports = [ ];
      options = {
        enable = mkEnableOption "the managed Pi agent integration";

        package = mkOption {
          type = derivationPackageType;
          default = pkgs.pi-agent;
          defaultText = lib.literalExpression "pkgs.pi-agent";
          description = "Patched Pi package consumed by later managed launch tasks.";
        };

        extensions = mkOption {
          type = closedSubmodule {
            options = lib.genAttrs extensionNames optionalPackageResourceRef;
          };
          default = defaultExtensionRefs;
          description = "Closed package-backed managed extension inventory.";
        };
        manifests = mkOption {
          type = types.listOf packageResourceRefType;
          default = [ defaultManifestRef ];
          description = "Package-backed manifest references.";
        };
        instructions = mkOption {
          type = types.listOf packageResourceRefType;
          default = [ guidance.instructionResource ];
          description = "Package-backed instruction references.";
        };
        resources = mkOption {
          type = types.listOf packageResourceRefType;
          default = [ guidance.guideResource ];
          description = "Package-backed managed resource references.";
        };
        languageServers = mkOption {
          type = languageServerMapType;
          default = { };
          description = "Language-server names mapped to package-backed executable references.";
        };

        provider = mkOption {
          type = providerSelectionType;
          default = { };
          apply = validateProviderSelection;
          description = "Closed personal or Shopify provider selection.";
        };

        state = mkOption {
          type = closedSubmodule {
            options = {
              generation = mkOption {
                type = safeIdentifierType;
                default = "pi-agent-v1";
                description = "Managed-state generation identifier.";
              };
              location = mkOption {
                type = types.enum [ "pi-default" ];
                default = "pi-default";
                description = "Module-owned mutable-state location reference.";
              };
            };
          };
          default = { };
          description = "Managed-state identity without a host-authored path.";
        };

        mcp = mkOption {
          type = closedSubmodule {
            options = {
              port = mkOption {
                type = types.ints.between 1 65535;
                default = 8080;
                description = "Loopback mcpproxy port.";
              };
              cacheTtlDays = mkOption {
                type = types.ints.positive;
                default = 7;
                description = "Adapter-owned metadata cache lifetime in days.";
              };
            };
          };
          default = { };
          description = "Typed local mcpproxy selection without a host-authored endpoint.";
        };

        sandbox = mkOption {
          type = closedSubmodule {
            options.defaultState = mkOption {
              type = types.enum [
                "disabled"
                "audit"
                "enforced"
              ];
              default = "disabled";
              description = "Default managed sandbox state.";
            };
          };
          default = { };
          description = "Typed sandbox selection; profile rendering belongs to Task 2.6.";
        };

        subagents = mkOption {
          type = closedSubmodule {
            options = {
              maxDepth = mkOption {
                type = types.ints.positive;
                default = 1;
                description = "Maximum foreground child-agent nesting depth.";
              };
              termination = mkOption {
                type = closedSubmodule {
                  options = {
                    gracefulMs = mkOption {
                      type = types.ints.positive;
                      default = 3000;
                      description = "Graceful child process-group termination window.";
                    };
                    forcedMs = mkOption {
                      type = types.ints.positive;
                      default = 1000;
                      description = "Forced child process-group termination window.";
                    };
                  };
                };
                default = { };
                description = "Bounded foreground child termination policy.";
              };
            };
          };
          default = { };
          description = "Typed foreground-only sub-agent limits.";
        };

        plan = mkOption {
          type = closedSubmodule {
            options = {
              enable = mkOption {
                type = types.bool;
                default = true;
                description = "Whether the managed read-only planning state is available.";
              };
              defaultTools = mkOption {
                type = types.listOf readOnlyPlanToolType;
                default = [
                  "read"
                  "grep"
                  "find"
                  "ls"
                ];
                description = "Unique non-empty read-only tool set used on plan entry.";
              };
            };
          };
          default = { };
          apply = validatePlan;
          description = "Typed read-only plan-mode contract.";
        };

        timeouts = mkOption {
          type = closedSubmodule {
            options = {
              resolverMs = mkOption {
                type = types.ints.positive;
                default = 10000;
                description = "Provider resolver timeout in milliseconds.";
              };
              preflightMs = mkOption {
                type = types.ints.positive;
                default = 15000;
                description = "Managed preflight timeout in milliseconds.";
              };
              bashDefaultMs = mkOption {
                type = types.ints.between 1 2147483647;
                default = 120000;
                description = "Default Bash tool timeout in milliseconds.";
              };
            };
          };
          default = { };
          description = "Positive bounded timeout values.";
        };

        security = mkOption {
          type = securityType;
          default = { };
          description = "Closed module-evaluation security ceilings and advisory policy.";
        };

        internal.resolverKinds = mkOption {
          type = types.listOf (types.enum resolverKinds);
          default = resolverKinds;
          internal = true;
          readOnly = true;
          description = "Module-owned finite provider resolver vocabulary.";
        };
        internal.managedConfig = mkOption {
          type = types.nullOr types.path;
          internal = true;
          readOnly = true;
          description = "Immutable secret-free ManagedConfigV1 JSON artifact.";
        };
        internal.projectionFactory = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable PersistedProviderProjectionV1 factory package.";
        };
        internal.shopifyProviderHandoff = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable Shopify provider composition and reconciliation handoff package.";
        };
        internal.sandboxCatalog = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable standalone Pi nono profile catalog package.";
        };
        internal.guidancePackage = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable Pi instructions and operator guidance package.";
        };
        internal.credentialRuntimeModule = mkOption {
          type = types.nullOr types.path;
          internal = true;
          readOnly = true;
          description = "Immutable credential and subprocess policy module.";
        };
        internal.credentialResolver = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable package-owned credential resolver.";
        };
        internal.resolverPlans = mkOption {
          type = types.listOf types.attrs;
          internal = true;
          readOnly = true;
          description = "Read-back package-backed credential resolver plans.";
        };
        internal.managedShell = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable credential-scrubbed shell package.";
        };
        internal.sandboxResolver = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable sandbox selection and validation package.";
        };
        internal.sandboxExecutor = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable nono and direct Pi execution package.";
        };
        internal.reconciler = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable managed-state reconciler package.";
        };
        internal.launcher = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable preflight and managed launch package.";
        };
        internal.status = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable redacted managed status package.";
        };
        internal.validator = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Immutable runtime compatibility validator package.";
        };
        internal.managedCommand = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Repository-owned managed pi command package.";
        };
        internal.managedStatusCommand = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Repository-owned status command package.";
        };
        internal.managedValidatorCommand = mkOption {
          type = types.nullOr derivationPackageType;
          internal = true;
          readOnly = true;
          description = "Repository-owned validator command package.";
        };
        internal.cavememDataDir = mkOption {
          type = types.nullOr types.str;
          internal = true;
          readOnly = true;
          description = "Read-back Cavemem data directory passed to managed runtime probes.";
        };
        internal.extensionManifest = mkOption {
          type = types.nullOr types.path;
          internal = true;
          readOnly = true;
          description = "Read-back immutable extension manifest path.";
        };
        internal.extensionIdentity = mkOption {
          type = types.nullOr types.path;
          internal = true;
          readOnly = true;
          description = "Read-back immutable extension identity path.";
        };
        internal.instructionResources = mkOption {
          type = types.listOf types.str;
          internal = true;
          readOnly = true;
          description = "Read-back managed instruction and help resource paths.";
        };
        internal.profilePaths = mkOption {
          type = types.attrsOf types.str;
          internal = true;
          readOnly = true;
          description = "Read-back managed sandbox profile paths.";
        };
        internal.statusInputs = mkOption {
          type = types.attrsOf types.anything;
          internal = true;
          readOnly = true;
          description = "Status input paths shared with the launcher contract.";
        };
        internal.commands = mkOption {
          type = types.listOf types.str;
          internal = true;
          readOnly = true;
          description = "Repository-owned commands installed by the managed integration.";
        };
      };
    };
    default = { };
    apply = validateAgentConfig;
    description = "Closed structural contracts for the managed Pi integration.";
  };

}
