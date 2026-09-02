{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;

  generation = "task-5.7-validator-v1";
  providerSentinel = "task-5-7-provider-sentinel";
  launchSentinel = "a57aa57a-5a57-457a-857a-a57aa57aa57a";
  openAiSentinel = "task-5-7-openai-sentinel";
  adminSentinel = "task-5-7-mcpproxy-admin-sentinel";
  extensionOrder = [
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
  extensionVersions = {
    cavemem = "0.1.0";
    mcp = "0.1.0";
    subagents = "0.40.0";
    plan = "0.49.2";
    timestamps = "0.49.3";
    bashTimeout = "4.6.0";
    questions = "4.6.0";
    codeIntelligence = "4.6.0";
    backgroundTasks = "2.0.0";
  };
  manifestExtensions = builtins.mapAttrs (name: version: {
    inherit version;
    entryPath = "lib/pi-agent/extensions/${name}/index.ts";
    license = "MIT";
  }) extensionVersions;
  extensionManifest = pkgs.writeText "pi-agent-task-5-7-extensions.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = "0.83.0";
      loader = {
        entryPath = "lib/pi-agent/extensions/managed-loader.ts";
        discovery = {
          extensions = false;
          skills = false;
          prompts = false;
        };
      };
      inherit extensionOrder;
      extensions = manifestExtensions;
    }
  );

  contextFiles = [
    "packages/ai/test/openai-responses-terminal-event.test.ts"
    "packages/ai/test/overflow.test.ts"
    "packages/coding-agent/test/assistant-message.test.ts"
    "packages/coding-agent/test/suite/agent-session-compaction.test.ts"
  ];
  terminalFiles = [
    "packages/coding-agent/test/suite/agent-session-retry-events.test.ts"
  ];
  mkContextEvidence =
    healthy:
    pkgs.writeTextDir "manifest.json" (
      builtins.toJSON {
        schemaVersion = 1;
        piVersion = "0.83.0";
        upstreamCommit = "32850ef7c5edff7a6eee0214516fbb7382bf292d";
        upstreamParent = "e56893f4cd6545ab1498b72ae4e1e2241a0926f4";
        upstreamTests = contextFiles;
        terminalBaselineTests = terminalFiles;
        summary = {
          failed = if healthy then 0 else 1;
          files = 5;
          passed = if healthy then 5 else 4;
          total = 5;
        };
        tests = builtins.genList (index: {
          id = "${builtins.elemAt (contextFiles ++ terminalFiles) index} > fixture";
          status = if healthy || index != 0 then "pass" else "fail";
        }) 5;
      }
    );
  requiredPatches = map (name: repoRoot + "/overlays/pi-agent/${name}") [
    "pi-undici-8.9.0.patch"
    "pi-context-recovery.patch"
    "pi-launch-redaction-bootstrap.patch"
    "pi-cavemem-environment-bootstrap.patch"
  ];
  mkPiPackage =
    healthy:
    let
      contextEvidence = mkContextEvidence healthy;
      piManifest = pkgs.writeText "pi-agent-task-5-7-pi-package.json" (
        builtins.toJSON {
          name = "@earendil-works/pi-coding-agent";
          version = "0.83.0";
        }
      );
      undiciManifest = pkgs.writeText "pi-agent-task-5-7-undici-package.json" (
        builtins.toJSON {
          name = "undici";
          version = if healthy then "8.9.0" else "8.8.0";
        }
      );
      gondolinUndiciManifest = pkgs.writeText "pi-agent-task-5-7-gondolin-undici-package.json" (
        builtins.toJSON {
          name = "undici";
          version = "6.28.0";
        }
      );
    in
    pkgs.runCommand "pi-coding-agent-0.83.0-task-5-7"
      {
        pname = "pi-coding-agent";
        version = "0.83.0";
        patches = requiredPatches;
        passthru.tests.context-recovery = contextEvidence;
      }
      ''
        mkdir -p \
          "$out/lib/node_modules/@earendil-works/pi-coding-agent" \
          "$out/lib/node_modules/undici" \
          "$out/lib/node_modules/@earendil-works/gondolin/node_modules/undici"
        cp ${piManifest} "$out/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
        cp ${undiciManifest} "$out/lib/node_modules/undici/package.json"
        cp ${gondolinUndiciManifest} \
          "$out/lib/node_modules/@earendil-works/gondolin/node_modules/undici/package.json"
      '';
  healthyPi = mkPiPackage true;
  brokenPi = mkPiPackage false;

  mkExtensionPackage =
    healthy:
    pkgs.runCommand "pi-agent-extensions-task-5-7"
      {
        passthru = {
          manifest = extensionManifest;
          identityFile = "extensions-provenance.json";
          provenancePath = "share/pi-agent/extensions-provenance.json";
        };
      }
      ''
        mkdir -p \
          "$out/lib/node_modules/node-pty/prebuilds/darwin-arm64" \
          "$out/share/pi-agent"
        cp ${extensionManifest} "$out/share/pi-agent/extensions.json"
        printf '%s\n' '{"name":"node-pty","version":"1.2.0-beta.14"}' \
          > "$out/lib/node_modules/node-pty/package.json"
        printf '%s\n' 'fixture native module' \
          > "$out/lib/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"
        ${
          if healthy then
            ''
              printf '%s\n' '#!${pkgs.runtimeShell}' 'exit 0' \
                > "$out/lib/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
              chmod 0555 "$out/lib/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
            ''
          else
            ""
        }
      '';
  healthyExtensions = mkExtensionPackage true;
  brokenExtensions = mkExtensionPackage false;

  profileNames = [
    "pi-audit"
    "pi-managed"
    "pi-review"
  ];
  profileSources = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = {
        extends = [ "default" ];
        meta = {
          inherit name;
          version = "1.0.0-pi-agent.1";
        };
      };
    }) profileNames
  );
  profileCatalogValue = {
    schemaVersion = 1;
    nonoVersion = "0.69.0";
    profiles = builtins.listToAttrs (
      map (name: {
        inherit name;
        value = {
          sourcePath = "share/pi-agent/nono/profiles/${name}.json";
          resolvedPath = "share/pi-agent/nono/resolved/${name}.json";
        };
      }) profileNames
    );
  };
  mkProfilePackage =
    healthy:
    pkgs.runCommand "pi-agent-nono-profile-catalog-task-5-7" { } (
      ''
        mkdir -p \
          "$out/share/pi-agent/nono/profiles" \
          "$out/share/pi-agent/nono/resolved"
        printf '%s' ${pkgs.lib.escapeShellArg (builtins.toJSON profileCatalogValue)} \
          > "$out/share/pi-agent/nono/catalog.json"
      ''
      + builtins.concatStringsSep "\n" (
        map (name: ''
          printf '%s' ${pkgs.lib.escapeShellArg (builtins.toJSON profileSources.${name})} \
            > "$out/share/pi-agent/nono/profiles/${name}.json"
          printf '%s' ${
            pkgs.lib.escapeShellArg (
              builtins.toJSON {
                inherit name;
                extends = [ "default" ];
              }
            )
          } > "$out/share/pi-agent/nono/resolved/${name}.json"
        '') profileNames
      )
      + (
        if healthy then
          ""
        else
          ''
            rm "$out/share/pi-agent/nono/profiles/pi-managed.json"
          ''
      )
    );
  mkProfileCatalog = healthy: {
    catalog = profileCatalogValue;
    nonoVersion = "0.69.0";
    package = mkProfilePackage healthy;
    profiles = profileSources;
  };

  unavailableExtensions = builtins.mapAttrs (_name: _version: "unavailable") extensionVersions;
  healthyStatus = {
    inherit generation;
    piVersion = "0.83.0";
    providerMode = "personal";
    sandboxState = "audit";
    profile = "pi-audit";
    mcpEndpoint = "http://127.0.0.1:8080/mcp";
    mcpReady = true;
    cavememDataDir = null;
    cavememReady = true;
    extensions = extensionVersions;
    drift = [ ];
    lsp = {
      nix = "ready";
    };
    status = "complete";
    issues = [ ];
  };
  componentStatus = healthyStatus // {
    mcpReady = false;
    cavememReady = false;
    extensions = unavailableExtensions;
    lsp = {
      nix = "missing";
    };
    status = "degraded";
    issues = [
      {
        component = "cavemem";
        state = "degraded";
        recovery = "fixture";
      }
      {
        component = "extensions";
        state = "degraded";
        recovery = "fixture";
      }
      {
        component = "lsp:nix";
        state = "missing";
        recovery = "fixture";
      }
      {
        component = "mcp";
        state = "degraded";
        recovery = "fixture";
      }
    ];
  };
  driftStatus = healthyStatus // {
    drift = [
      "ownership.generation"
      "settings.shellPath.value"
    ];
    status = "drifted";
    issues = [
      {
        component = "reconciliation";
        state = "drifted";
        recovery = "fixture";
      }
    ];
  };
  manualStatus = healthyStatus // {
    providerMode = "shopify-gateway";
  };

  mkManagedConfig =
    providerMode: selectedExtensionPackage:
    pkgs.writeText "pi-agent-task-5-7-managed-config.json" (
      builtins.toJSON {
        schemaVersion = 1;
        inherit generation extensionOrder;
        extensionManifest = "${selectedExtensionPackage}/share/pi-agent/extensions.json";
        providerSelection = {
          mode = providerMode;
        };
        sandboxDefault = "audit";
        mcpEndpoint = "http://127.0.0.1:8080/mcp";
        lspExecutables = {
          nix = "/nix/store/task-5-7-nixd/bin/nixd";
        };
      }
    );
  mkStatusPackage =
    {
      name,
      providerMode,
      selectedExtensionPackage,
      report,
      hostile ? false,
    }:
    let
      managedConfig = mkManagedConfig providerMode selectedExtensionPackage;
      script = pkgs.writeText "pi-agent-task-5-7-status-${name}.mjs" ''
        #!${pkgs.nodejs}/bin/node
        import fs from "node:fs";
        import path from "node:path";

        const forbiddenNames = [
          "SHOPIFY_PI_TOKEN",
          "PI_AGENT_LAUNCH_ID",
          "OPENAI_API_KEY",
          "MCPPROXY_API_KEY",
        ];
        const forbiddenValues = ${
          builtins.toJSON [
            providerSentinel
            launchSentinel
            openAiSentinel
            adminSentinel
          ]
        };
        if (
          forbiddenNames.some((name) => Object.hasOwn(process.env, name))
          || Object.values(process.env).some((value) =>
            forbiddenValues.some((secret) => value.includes(secret)))
        ) {
          process.stderr.write(${builtins.toJSON providerSentinel});
          process.exit(71);
        }
        if (process.argv.length !== 3 || process.argv[2] !== "--json") {
          process.exit(64);
        }
        if (
          (process.env.PI_NONO !== undefined
            && !["disabled", "audit", "enforced"].includes(process.env.PI_NONO))
          || (process.env.PI_NONO_PROFILE !== undefined
            && !["pi-audit", "pi-managed", "pi-review"].includes(process.env.PI_NONO_PROFILE))
        ) {
          process.exit(65);
        }
        const input = JSON.parse(fs.readFileSync(0, "utf8"));
        if (path.basename(path.dirname(input.agentDir)).includes("selection-collision-")) {
          fs.writeFileSync(
            path.join(path.dirname(input.agentDir), "selection-collision-status-invoked"),
            "invoked\n",
          );
        }
        ${
          if hostile then
            ''
              process.stdout.write(${builtins.toJSON ("raw request " + providerSentinel)});
              process.stderr.write(${builtins.toJSON ("Authorization: Bearer " + providerSentinel)});
              process.exit(75);
            ''
          else
            ''
              const report = ${builtins.toJSON report};
              report.cavememDataDir = input.cavememDataDir;
              if (process.env.PI_NONO === "disabled") {
                report.sandboxState = "disabled";
                report.profile = null;
              } else if (process.env.PI_NONO === "enforced") {
                report.sandboxState = "enforced";
                report.profile = process.env.PI_NONO_PROFILE ?? "pi-managed";
              } else if (process.env.PI_NONO === "audit") {
                report.sandboxState = "audit";
                report.profile = process.env.PI_NONO_PROFILE ?? "pi-audit";
              }
              process.stdout.write(JSON.stringify(report) + "\n");
            ''
        }
      '';
    in
    pkgs.runCommand "pi-agent-task-5-7-status-${name}" { } ''
      mkdir -p "$out/bin" "$out/share/pi-agent"
      cp ${script} "$out/bin/pi-agent-status"
      chmod 0555 "$out/bin/pi-agent-status"
      cp ${managedConfig} "$out/share/pi-agent/managed-config.json"
    '';

  fakeDevx = pkgs.writeShellScriptBin "devx" "exit 1";
  credentialPolicy = import (repoRoot + "/home-manager/common/pi-agent/credential-policy.nix") {
    inherit (pkgs) lib;
    inherit pkgs;
    trustedDevxOutPath = fakeDevx.outPath;
  };
  credentialRuntime =
    mode:
    (credentialPolicy.render {
      hostSelection = { inherit mode; };
    }).runtimeModule;
  mkValidator =
    {
      name,
      providerMode ? "personal",
      report,
      healthyPackage ? true,
      healthyProfiles ? true,
      healthyPty ? true,
      hostile ? false,
    }:
    let
      selectedExtensionPackage = if healthyPty then healthyExtensions else brokenExtensions;
      statusPackage = mkStatusPackage {
        inherit
          name
          providerMode
          report
          hostile
          selectedExtensionPackage
          ;
      };
    in
    import (repoRoot + "/scripts/pi-agent-validate.nix") {
      credentialRuntimeModule = credentialRuntime providerMode;
      extensionPackage = selectedExtensionPackage;
      piPackage = if healthyPackage then healthyPi else brokenPi;
      profileCatalog = mkProfileCatalog healthyProfiles;
      inherit pkgs statusPackage;
    };

  healthy = mkValidator {
    name = "healthy";
    report = healthyStatus;
  };
  componentFailure = mkValidator {
    name = "component-failure";
    report = componentStatus;
    healthyPackage = false;
    healthyProfiles = false;
    healthyPty = false;
  };
  drift = mkValidator {
    name = "drift";
    report = driftStatus;
  };
  manualGate = mkValidator {
    name = "manual-gate";
    providerMode = "shopify-gateway";
    report = manualStatus;
  };
  hostileStatus = mkValidator {
    name = "hostile-status";
    report = healthyStatus;
    hostile = true;
  };
  productionArtifacts =
    let
      statusPackage = mkStatusPackage {
        name = "production-artifacts";
        providerMode = "personal";
        report = healthyStatus;
        selectedExtensionPackage = pkgs.pi-agent-extensions;
      };
      profileCatalog = import (repoRoot + "/home-manager/common/pi-agent/profiles.nix") {
        inherit (pkgs) lib;
        inherit pkgs;
      };
    in
    import (repoRoot + "/scripts/pi-agent-validate.nix") {
      credentialRuntimeModule = credentialRuntime "personal";
      extensionPackage = pkgs.pi-agent-extensions;
      piPackage = pkgs.pi-agent;
      inherit pkgs profileCatalog statusPackage;
    };
  packages = pkgs.linkFarm "pi-agent-task-5-7-validator-fixtures" [
    {
      name = "healthy";
      path = healthy;
    }
    {
      name = "component-failure";
      path = componentFailure;
    }
    {
      name = "drift";
      path = drift;
    }
    {
      name = "manual-gate";
      path = manualGate;
    }
    {
      name = "hostile-status";
      path = hostileStatus;
    }
    {
      name = "production-artifacts";
      path = productionArtifacts;
    }
  ];
in
if fixture == "packages" then packages else throw "unknown pi-agent validator fixture: ${fixture}"
