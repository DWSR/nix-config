{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;

  managedFixture =
    name:
    import (repoRoot + "/tests/pi-agent/fixtures/managed-config.nix") {
      fixture = name;
      inherit repoRoot;
    };
  shopifyManagedConfig = managedFixture "shopify-managed-config";
  personalManagedConfig = managedFixture "personal-managed-config";
  shopifyProjectionFactory = managedFixture "shopify-projection-factory";
  personalProjectionFactory = managedFixture "personal-projection-factory";
  reconcilerPackage = pkgs.pi-agent-reconcile;
  reconcilerModule = "${reconcilerPackage}/lib/pi-agent/reconcile.mjs";
  adminKey = "task-5-8-mcpproxy-admin-sentinel";
  extensionOrder = [
    "agentmemory"
    "mcp"
    "subagents"
    "plan"
    "timestamps"
    "bashTimeout"
    "questions"
    "codeIntelligence"
    "backgroundTasks"
  ];
  extensionVersions = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = "1.0.0";
    }) extensionOrder
  );
  gateNames = [
    "package-patches"
    "managed-json"
    "ownership"
    "sandbox-profiles"
    "extension-inventory"
    "mcp-surface"
    "agentmemory"
    "pty"
    "lsp"
    "reconciliation-drift"
    "sandbox-seatbelt-host"
    "provider-setup"
  ];

  commonProbeSource = ''
    import fs from "node:fs";
    import path from "node:path";

    const TRACE_NAME = "pi-agent-launcher-trace.log";
    const FORBIDDEN_NAMES = [
      "SHOPIFY_PI_TOKEN",
      "PI_AGENT_LAUNCH_ID",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "MCPPROXY_API_KEY",
    ];
    const FORBIDDEN_VALUES = [
      "task-5-8-ambient-openai-sentinel",
      "task-5-8-ambient-anthropic-sentinel",
      "task-5-8-ambient-mcpproxy-sentinel",
    ];

    function trace(stage) {
      const root = process.env.TMPDIR;
      if (typeof root !== "string" || root.length === 0) throw new Error("missing temp root");
      fs.appendFileSync(path.join(root, TRACE_NAME), stage + "\n", { mode: 0o600 });
    }

    function lockState() {
      const agentDir = path.join(process.env.TMPDIR, "agent");
      return fs.existsSync(path.join(agentDir, ".pi-agent-reconcile.lock"))
        && fs.existsSync(path.join(agentDir, "settings.json.lock"))
        ? "locked"
        : "unlocked";
    }

    function assertCommitted() {
      const agentDir = path.join(process.env.TMPDIR, "agent");
      const ownership = JSON.parse(fs.readFileSync(path.join(agentDir, "ownership.json"), "utf8"));
      if (
        ownership.transaction !== "committed"
        || !fs.existsSync(path.join(agentDir, "settings.json"))
        || !fs.existsSync(path.join(agentDir, "models.json"))
        || lockState() !== "unlocked"
      ) {
        throw new Error("managed state is not committed");
      }
    }

    function assertScrubbed() {
      if (FORBIDDEN_NAMES.some((name) => Object.hasOwn(process.env, name))) {
        throw new Error("credential environment reached probe");
      }
      if (Object.values(process.env).some((value) =>
        typeof value === "string" && (
          value.startsWith("task-5-8-runtime-token-")
          || FORBIDDEN_VALUES.some((secret) => value.includes(secret))
        ))) {
        throw new Error("credential value reached probe");
      }
    }
  '';

  providerSelection =
    mode:
    if mode == "personal" then
      {
        mode = "personal";
        defaultModel = {
          provider = "openai";
          modelId = "gpt-5.6-sol";
        };
      }
    else
      {
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

  mkDevx =
    failStage:
    pkgs.writeShellApplication {
      name = "devx";
      runtimeInputs = [ pkgs.coreutils ];
      text = ''
        trace_file="''${TMPDIR:?}/pi-agent-launcher-trace.log"
        agent_dir="''${TMPDIR:?}/agent"
        if [[ -d "$agent_dir/.pi-agent-reconcile.lock" || -d "$agent_dir/settings.json.lock" ]]; then
          lock_state=locked
        else
          lock_state=unlocked
        fi

        case "''${3-}" in
          --key) operation=token ;;
          --base) operation=base ;;
          *) exit 93 ;;
        esac
        printf 'resolver-%s:%s\n' "$operation" "$lock_state" >> "$trace_file"

        ${lib.optionalString (failStage == "resolver") ''
          if [[ "$operation" == token ]]; then
            exit 42
          fi
        ''}
        if [[ "$operation" == token ]]; then
          printf 'task-5-8-runtime-token-%s\n' "$$"
        else
          cat "''${TMPDIR:?}/pi-agent-launcher-base.txt"
        fi
      '';
    };

  mkCredential =
    mode: failStage:
    let
      devx = mkDevx failStage;
      policy = import (repoRoot + "/home-manager/common/pi-agent/credential-policy.nix") {
        inherit lib pkgs;
        trustedDevxOutPath = devx.outPath;
      };
      rendered = policy.render { hostSelection = providerSelection mode; };
      wrapperSource = pkgs.writeText "pi-agent-launcher-resolver-wrapper.mjs" ''
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";

        const resolver = await import(pathToFileURL(${builtins.toJSON "${rendered.resolverExecutor}/lib/pi-agent/credential-resolver.mjs"}).href);

        export async function resolveProviderRuntimeSecrets(...inputs) {
          const agentDir = path.join(process.env.TMPDIR, "agent");
          const lockState = fs.existsSync(path.join(agentDir, ".pi-agent-reconcile.lock"))
            || fs.existsSync(path.join(agentDir, "settings.json.lock"))
            ? "locked"
            : "unlocked";
          fs.appendFileSync(
            path.join(process.env.TMPDIR, "pi-agent-launcher-trace.log"),
            "resolver:" + lockState + "\n",
            { mode: 0o600 },
          );
          return resolver.resolveProviderRuntimeSecrets(...inputs);
        }
      '';
      wrapper = pkgs.writeTextFile {
        name = "pi-agent-launcher-credential-resolver-${mode}-${failStage}";
        destination = "/lib/pi-agent/credential-resolver.mjs";
        text = builtins.readFile wrapperSource;
      };
    in
    {
      resolverPackage = wrapper;
      inherit (policy) managedShell;
      inherit (rendered) runtimeModule;
    };

  mkProviderHandoff =
    managedConfig: projectionFactory: failStage:
    let
      base = import (repoRoot + "/scripts/pi-agent-shopify-provider-handoff.nix") {
        inherit
          managedConfig
          pkgs
          projectionFactory
          reconcilerModule
          ;
        managedConfigDigest = builtins.hashString "sha256" (
          builtins.unsafeDiscardStringContext (builtins.readFile managedConfig)
        );
        projectionFactoryDigest = builtins.hashString "sha256" "${projectionFactory}/bin/pi-agent-provider-projection";
      };
    in
    pkgs.writeTextFile {
      name = "pi-agent-launcher-provider-handoff-${failStage}";
      destination = "/lib/pi-agent/shopify-provider-handoff.mjs";
      text = ''
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";

        const handoff = await import(pathToFileURL(${builtins.toJSON "${base}/lib/pi-agent/shopify-provider-handoff.mjs"}).href);

        export function composeShopifyProviderHandoff(...inputs) {
          const agentDir = path.join(process.env.TMPDIR, "agent");
          const locked = fs.existsSync(path.join(agentDir, ".pi-agent-reconcile.lock"))
            && fs.existsSync(path.join(agentDir, "settings.json.lock"));
          fs.appendFileSync(
            path.join(process.env.TMPDIR, "pi-agent-launcher-trace.log"),
            "projection:" + (locked ? "locked" : "unlocked") + "\n",
            { mode: 0o600 },
          );
          if (${builtins.toJSON (failStage == "projection")}) {
            throw new Error("fixture projection failure with hidden raw content");
          }
          return handoff.composeShopifyProviderHandoff(...inputs);
        }
      '';
    };

  mkPiPackage =
    failStage: shellPackage:
    let
      manifest = pkgs.writeText "pi-agent-launcher-pi-package.json" (
        builtins.toJSON {
          name = "@earendil-works/pi-coding-agent";
          version = if failStage == "package" then "0.82.0" else "0.83.0";
        }
      );
    in
    pkgs.runCommand "pi-coding-agent-0.83.0-launcher-${failStage}"
      {
        pname = "pi-coding-agent";
        version = "0.83.0";
      }
      ''
        mkdir -p "$out/bin" "$out/lib/node_modules/@earendil-works/pi-coding-agent"
        cp ${manifest} "$out/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
         cat > "$out/bin/pi" <<'EOF'
        #!${pkgs.runtimeShell}
        printf '%s\n' launched > "''${TMPDIR:?}/pi-was-launched"
        {
          printf 'PI_AGENT_BASH_TIMEOUT_MS=%s\n' "''${PI_AGENT_BASH_TIMEOUT_MS-<unset>}"
          printf 'SHOPIFY_PI_TOKEN=%s\n' "''${SHOPIFY_PI_TOKEN-<unset>}"
          printf 'PI_AGENT_LAUNCH_ID=%s\n' "''${PI_AGENT_LAUNCH_ID-<unset>}"
          printf 'MCPPROXY_API_KEY=%s\n' "''${MCPPROXY_API_KEY-<unset>}"
          printf 'OPENAI_API_KEY=%s\n' "''${OPENAI_API_KEY-<unset>}"
          printf 'ANTHROPIC_API_KEY=%s\n' "''${ANTHROPIC_API_KEY-<unset>}"
        } > "''${TMPDIR:?}/pi-agent-environment"
        ${shellPackage}/bin/pi-agent-shell -c '
          printf "PI_AGENT_BASH_TIMEOUT_MS=%s\\n" "''${PI_AGENT_BASH_TIMEOUT_MS-<unset>}"
          printf "SHOPIFY_PI_TOKEN=%s\\n" "''${SHOPIFY_PI_TOKEN-<unset>}"
          printf "MCPPROXY_API_KEY=%s\\n" "''${MCPPROXY_API_KEY-<unset>}"
        ' > "''${TMPDIR:?}/pi-agent-shell-environment"
        exit 0
        EOF
        chmod 0555 "$out/bin/pi"
      '';

  mkSandboxExecutor =
    piPackage:
    pkgs.writeTextFile {
      name = "pi-agent-launcher-sandbox-executor";
      destination = "/lib/pi-agent/sandbox-executor.mjs";
      text = ''
        import { spawnSync } from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";

        const PI_EXECUTABLE = ${builtins.toJSON "${piPackage}/bin/pi"};
        const REVIEW_TOOLS = "read,grep,find,ls";

        export function executeSandboxedPi(...inputs) {
          if (inputs.length !== 1) throw new Error("sandbox executor invocation rejected");
          const input = inputs[0];
          if (input === null || typeof input !== "object") throw new Error("sandbox executor input rejected");
          const route = process.env.PI_NONO === "disabled" ? "bare" : "nono";
          const profile = process.env.PI_NONO_PROFILE ||
            (process.env.PI_NONO === "enforced" ? "pi-managed" : "pi-audit");
          const argv = [...input.userArguments];
          if (profile === "pi-review") argv.push("--tools", REVIEW_TOOLS);
          const execution = {
            executable: PI_EXECUTABLE,
            argv,
            route,
            profile: route === "bare" ? null : profile,
            providerOrigin: input.providerOrigin,
            hasProviderRuntime: typeof process.env.SHOPIFY_PI_TOKEN === "string"
              && typeof process.env.PI_AGENT_LAUNCH_ID === "string",
            hasTimeoutBinding: Object.hasOwn(process.env, "PI_AGENT_BASH_TIMEOUT_MS"),
            timeoutBinding: process.env.PI_AGENT_BASH_TIMEOUT_MS,
             agentMemoryUrl: process.env.AGENTMEMORY_URL,
            agentDir: process.env.PI_CODING_AGENT_DIR,
            subagentBinaryOverride: process.env.PI_SUBAGENT_PI_BINARY,
            ambientOpenAi: process.env.OPENAI_API_KEY,
          };
          const piEnvironment = { ...process.env };
          for (const name of ["PI_NONO", "PI_NONO_PROFILE", "PI_NONO_LISTEN_PORTS"]) {
            delete piEnvironment[name];
          }
          fs.appendFileSync(
            path.join(process.env.TMPDIR, "pi-agent-launch-execution.jsonl"),
            JSON.stringify(execution) + "\n",
            { mode: 0o600 },
          );
          const result = spawnSync(PI_EXECUTABLE, argv, {
            cwd: process.cwd(),
            env: piEnvironment,
            shell: false,
            stdio: "inherit",
          });
          if (result.error) throw result.error;
          return { status: result.status, signal: result.signal };
        }
      '';
    };

  mkSandboxResolver =
    failStage:
    let
      resolver = pkgs.writeText "pi-agent-launcher-sandbox-resolver-${failStage}.mjs" (
        commonProbeSource
        + ''
            const ACCEPTED = Object.freeze({
             states: Object.freeze(["disabled", "audit", "enforced"]),
             profiles: Object.freeze(["pi-audit", "pi-managed", "pi-review"]),
             listenPorts: "comma-separated canonical decimal ports from 1 through 65535",
           });

          function selection(environment = {}) {
              assertCommitted();
              trace("profile:committed");
              if (${builtins.toJSON (failStage == "profile")}) {
                throw new Error("fixture profile raw failure");
              }
              const state = environment.PI_NONO ?? "";
              const profile = environment.PI_NONO_PROFILE ?? "";
              const listenPorts = environment.PI_NONO_LISTEN_PORTS ?? "";
              if (!["", "disabled", "audit", "enforced"].includes(state)) {
                throw new Error("sandbox override PI_NONO is invalid; accepted values: disabled, audit, enforced");
              }
              if (
                profile !== "" &&
                !["pi-audit", "pi-managed", "pi-review"].includes(profile)
              ) {
                throw new Error("sandbox override PI_NONO_PROFILE is invalid; accepted values: pi-audit, pi-managed, pi-review");
              }
              if (
                listenPorts !== "" &&
                !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(listenPorts)
              ) {
                throw new Error("sandbox override PI_NONO_LISTEN_PORTS is invalid; accepted format: comma-separated canonical decimal ports from 1 through 65535");
              }
               const selectedState = state === "" ? "audit" : state;
               const selectedProfile = profile === ""
                 ? (selectedState === "enforced" ? "pi-managed" : "pi-audit")
                 : profile;
               return Object.freeze({
                schemaVersion: 1,
                state: selectedState,
                profile: selectedState === "disabled" ? null : selectedProfile,
                listenPorts: Object.freeze([]),
                piTools: selectedProfile === "pi-review" ? Object.freeze(["read", "grep", "find", "ls"]) : null,
                source: Object.freeze({
                  state: state === "" ? "sandbox.defaultState" : "PI_NONO",
                  profile: profile === "" ? "state-default" : "PI_NONO_PROFILE",
                  listenPorts: "none",
                }),
                rollback: selectedState === "disabled" && state !== "",
                disableReason: selectedState === "disabled" ? (state === "" ? "host-default" : "override") : null,
                accepted: ACCEPTED,
              });
           }

           export function resolveSandboxSelection(...inputs) {
             if (inputs.length !== 0) throw new Error("sandbox resolver invocation rejected");
             return selection();
           }

            export function resolveSandboxSelectionFromEnvironment(...inputs) {
               if (inputs.length !== 1) throw new Error("sandbox resolver invocation rejected");
               return selection(inputs[0]);
            }
        ''
      );
      validator = pkgs.writeText "pi-agent-launcher-sandbox-validator-${failStage}.mjs" (
        commonProbeSource
        + ''
          export function validateSandboxSelection(...inputs) {
            if (inputs.length !== 1) throw new Error("sandbox validator invocation rejected");
            assertCommitted();
            trace("profile:validated");
             if (${builtins.toJSON (failStage == "profile-validation")}) {
               throw new Error("fixture profile validation raw failure");
             }
             const selected = inputs[0];
             const expectedState = process.env.PI_NONO || "audit";
             const expectedProfile = expectedState === "disabled"
               ? null
               : (process.env.PI_NONO_PROFILE || (expectedState === "enforced" ? "pi-managed" : "pi-audit"));
             if (selected.profile !== expectedProfile || selected.state !== expectedState) {
               throw new Error("fixture profile grant failure");
             }
            return selected;
          }
        ''
      );
    in
    pkgs.runCommand "pi-agent-launcher-sandbox-resolver-${failStage}" { } ''
      mkdir -p "$out/lib/pi-agent"
      cp ${resolver} "$out/lib/pi-agent/sandbox-resolver.mjs"
      cp ${validator} "$out/lib/pi-agent/sandbox-validator.mjs"
    '';

  mkStatusPackage =
    managedConfig: failStage:
    let
      config = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile managedConfig));
      mcpProbe = pkgs.writeText "pi-agent-launcher-mcp-probe.mjs" (
        commonProbeSource
        + ''
          const input = JSON.parse(fs.readFileSync(0, "utf8"));
          assertCommitted();
          assertScrubbed();
          trace("mcpproxy:committed");
          const validInput = input.adminApiKey === ${builtins.toJSON adminKey}
            && input.endpoint === "http://127.0.0.1:8080/mcp";
          if (${builtins.toJSON (failStage == "mcpproxy")}) {
            process.stdout.write("task-5-8-ambient-openai-sentinel\n");
          } else {
            process.stdout.write(JSON.stringify({ ready: validInput }) + "\n");
          }
        ''
      );
      statusReport = {
        inherit (config) generation;
        piVersion = "0.83.0";
        providerMode = config.providerSelection.mode;
        sandboxState = null;
        profile = null;
        inherit (config) mcpEndpoint;
        mcpReady = true;
        agentMemoryUrl = "http://127.0.0.1:3111";
        agentMemoryReady = true;
        extensions =
          if failStage == "extensions" then
            builtins.mapAttrs (_name: _version: "unavailable") extensionVersions
          else if failStage == "extensions-one" then
            builtins.mapAttrs (
              name: version: if name == "backgroundTasks" then "unavailable" else version
            ) extensionVersions
          else
            extensionVersions;
        drift = [ ];
        lsp = builtins.mapAttrs (_name: _executable: "ready") config.lspExecutables;
        status = if failStage == "extensions" then "degraded" else "complete";
        issues = [ ];
      };
      status = pkgs.writeText "pi-agent-launcher-status.mjs" (
        ''
          #!${pkgs.nodejs}/bin/node
        ''
        + commonProbeSource
        + ''
          if (process.argv.length !== 3 || process.argv[2] !== "--json") process.exit(64);
          const input = JSON.parse(fs.readFileSync(0, "utf8"));
          assertCommitted();
          assertScrubbed();
          trace("extensions:committed");
           const report = ${builtins.toJSON statusReport};
           const selectedState = process.env.PI_NONO || "audit";
           const selectedProfile = process.env.PI_NONO_PROFILE ||
             (selectedState === "enforced" ? "pi-managed" : "pi-audit");
           report.sandboxState = selectedState;
           report.profile = selectedState === "disabled" ? null : selectedProfile;
           report.agentMemoryUrl = input.agentMemoryUrl;
          process.stdout.write(JSON.stringify(report) + "\n");
        ''
      );
    in
    pkgs.runCommand "pi-agent-launcher-status-${failStage}" { } ''
      mkdir -p "$out/bin" "$out/lib/pi-agent" "$out/share/pi-agent"
      cp ${status} "$out/bin/pi-agent-status"
      chmod 0555 "$out/bin/pi-agent-status"
      cp ${mcpProbe} "$out/lib/pi-agent/mcp-status-probe.mjs"
      cp ${managedConfig} "$out/share/pi-agent/managed-config.json"
    '';

  mkKeychain = pkgs.writeShellApplication {
    name = "security";
    text = ''
       if [[ "$#" -ne 6 || "$1" != find-generic-password || "$2" != -s || "$3" != mcpproxy || "$4" != -a || "$6" != -w ]]; then
         exit 64
       fi
      for name in SHOPIFY_PI_TOKEN PI_AGENT_LAUNCH_ID OPENAI_API_KEY ANTHROPIC_API_KEY MCPPROXY_API_KEY; do
        if [[ -v "$name" ]]; then
          exit 65
        fi
      done
       if [[ "$5" == mcpproxy-api-key ]]; then
         printf '%s\n' ${lib.escapeShellArg adminKey}
       elif [[ "$5" == agentmemory-bearer ]]; then
         printf '%s\n' agentmemory-secret
       else
         exit 64
       fi
    '';
  };

  mkValidator =
    managedConfig: mode: failStage:
    let
      config = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile managedConfig));
      report = {
        inherit (config) generation;
        gates = map (name: {
          inherit name;
          status = "pass";
          evidence = [ "fixture:v1" ];
          recovery = "none";
        }) gateNames;
      };
      script = pkgs.writeText "pi-agent-launcher-validator.mjs" (
        ''
          #!${pkgs.nodejs}/bin/node
        ''
        + commonProbeSource
        + ''
          if (process.argv.length !== 3 || process.argv[2] !== "--check") process.exit(64);
          const input = JSON.parse(fs.readFileSync(0, "utf8"));
          if (
            input.schemaVersion !== 1
            || input.agentDir !== path.join(process.env.TMPDIR, "agent")
             || input.agentMemoryUrl !== "http://127.0.0.1:3111"
          ) process.exit(65);
          assertCommitted();
          assertScrubbed();
          trace("validator:committed");
          if (${builtins.toJSON (failStage == "validator")}) {
            process.stderr.write("task-5-8-ambient-anthropic-sentinel\n");
            process.exit(2);
          }
          process.stdout.write(${builtins.toJSON (builtins.toJSON report + "\n")});
        ''
      );
    in
    pkgs.runCommand "pi-agent-launcher-validator-${mode}-${failStage}" { } ''
      mkdir -p "$out/bin"
      cp ${script} "$out/bin/pi-agent-validate"
      chmod 0555 "$out/bin/pi-agent-validate"
    '';

  mkLauncher =
    mode: failStage:
    let
      managedConfig = if mode == "personal" then personalManagedConfig else shopifyManagedConfig;
      projectionFactory =
        if mode == "personal" then personalProjectionFactory else shopifyProjectionFactory;
      credential = mkCredential mode failStage;
      providerHandoff =
        if mode == "personal" then null else mkProviderHandoff managedConfig projectionFactory failStage;
      piPackage = mkPiPackage failStage credential.managedShell;
      sandboxResolverPackage = mkSandboxResolver failStage;
      statusPackage = mkStatusPackage managedConfig failStage;
      validatorPackage = mkValidator managedConfig mode failStage;
      sandboxExecutorPackage = mkSandboxExecutor piPackage;
    in
    import (repoRoot + "/scripts/pi-agent-launcher.nix") {
      inherit
        managedConfig
        piPackage
        pkgs
        projectionFactory
        providerHandoff
        reconcilerPackage
        sandboxResolverPackage
        sandboxExecutorPackage
        statusPackage
        validatorPackage
        ;
      credentialResolverPackage = credential.resolverPackage;
      credentialRuntimeModule = credential.runtimeModule;
      keychainExecutable = "${mkKeychain}/bin/security";
    };

  variants = {
    success = mkLauncher "shopify-gateway" "none";
    personal = mkLauncher "personal" "none";
    resolver-failure = mkLauncher "shopify-gateway" "resolver";
    projection-failure = mkLauncher "shopify-gateway" "projection";
    package-failure = mkLauncher "shopify-gateway" "package";
    profile-failure = mkLauncher "shopify-gateway" "profile";
    profile-validation-failure = mkLauncher "shopify-gateway" "profile-validation";
    mcpproxy-failure = mkLauncher "shopify-gateway" "mcpproxy";
    agentmemory-failure = mkLauncher "shopify-gateway" "agentmemory";
    extensions-failure = mkLauncher "shopify-gateway" "extensions";
    extensions-one-unavailable = mkLauncher "shopify-gateway" "extensions-one";
    validator-failure = mkLauncher "shopify-gateway" "validator";
  };
  packages = pkgs.linkFarm "pi-agent-launcher-fixtures" (
    lib.mapAttrsToList (name: value: {
      inherit name;
      path = value;
    }) variants
  );
in
{
  inherit packages;
}
.${fixture} or (throw "unknown pi-agent launcher fixture: ${fixture}")
