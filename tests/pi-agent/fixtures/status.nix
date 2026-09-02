{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;

  generation = "task-5.6-status-v1";
  adminSentinel = "task-5-6-mcpproxy-admin-sentinel";
  providerSentinel = "task-5-6-provider-sentinel";
  launchSentinel = "a56aa56a-5a56-456a-856a-a56aa56aa56a";
  openAiSentinel = "task-5-6-openai-sentinel";
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
  manifestExtensions = {
    cavemem = {
      version = extensionVersions.cavemem;
      entryPath = "lib/pi-agent/extensions/cavemem/index.ts";
      license = "MIT";
    };
    mcp = {
      version = extensionVersions.mcp;
      entryPath = "lib/pi-agent/extensions/mcpproxy/index.ts";
      license = "MIT";
    };
    subagents = {
      version = extensionVersions.subagents;
      entryPath = "lib/node_modules/pi-subagents/index.ts";
      license = "MIT";
    };
    plan = {
      version = extensionVersions.plan;
      entryPath = "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts";
      license = "MIT";
    };
    timestamps = {
      version = extensionVersions.timestamps;
      entryPath = "lib/node_modules/@narumitw/pi-stamp/src/index.ts";
      license = "MIT";
    };
    bashTimeout = {
      version = extensionVersions.bashTimeout;
      entryPath = "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts";
      license = "MIT";
    };
    questions = {
      version = extensionVersions.questions;
      entryPath = "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts";
      license = "MIT";
    };
    codeIntelligence = {
      version = extensionVersions.codeIntelligence;
      entryPath = "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts";
      license = "MIT";
    };
    backgroundTasks = {
      version = extensionVersions.backgroundTasks;
      entryPath = "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts";
      license = "MIT";
    };
  };
  manifestLoader = {
    entryPath = "lib/pi-agent/extensions/managed-loader.ts";
    discovery = {
      extensions = false;
      skills = false;
      prompts = false;
    };
  };
  completeManifest = "${pkgs.pi-agent-extensions}/share/pi-agent/extensions.json";
  canonicalIdentity = pkgs.pi-agent-extensions.identity;
  provenanceFixture =
    repoRoot + "/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs";
  degradedManifest = pkgs.writeText "pi-agent-task-5-6-degraded-extensions.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = "0.82.0";
      loader = manifestLoader;
      extensionOrder = builtins.filter (name: name != "codeIntelligence") extensionOrder;
      extensions = (removeAttrs manifestExtensions [ "codeIntelligence" ]) // {
        mcp = manifestExtensions.mcp // {
          version = providerSentinel;
        };
      };
    }
  );
  mkExtensionPackage =
    operation:
    pkgs.runCommand "pi-agent-task-5-6-${operation}-extension"
      {
        inherit operation;
        __structuredAttrs = true;
        nativeBuildInputs = [ pkgs.nodejs ];
        outputs = [
          "out"
          "identity"
        ];
        passthru = {
          inherit (pkgs.pi-agent-extensions) identityFile provenancePath;
        };
        unsafeDiscardReferences.identity = true;
      }
      ''
        mkdir -p "$out"
        cp -R ${pkgs.pi-agent-extensions}/. "$out/"
        chmod -R u+w "$out"
        node ${provenanceFixture} prepare \
          "$out" \
          "$identity" \
          ${canonicalIdentity}/${pkgs.pi-agent-extensions.identityFile}
        case "$operation" in
          hardlink)
            node ${provenanceFixture} provenance-hardlink "$out"
            ;;
          missing)
            node ${provenanceFixture} provenance-missing-entry "$out"
            ;;
          component-symlink)
            node ${provenanceFixture} provenance-component-symlink "$out"
            ;;
          leaf-symlink)
            node ${provenanceFixture} provenance-leaf-symlink "$out"
            ;;
          recomputed-tamper)
            node ${provenanceFixture} provenance-recomputed-tamper "$out"
            ;;
          manifest-alias)
            mv \
              "$out/share/pi-agent/extensions.json" \
              "$out/share/pi-agent/extensions.target.json"
            ln -s extensions.target.json "$out/share/pi-agent/extensions.json"
            ;;
          identity-alias)
            mv \
              "$identity/extensions-provenance.json" \
              "$identity/extensions-provenance.target.json"
            ln -s \
              extensions-provenance.target.json \
              "$identity/extensions-provenance.json"
            ;;
          *)
            printf 'unknown extension fixture: %s\n' "$operation" >&2
            exit 64
            ;;
        esac
      '';
  hardlinkExtensionPackage = mkExtensionPackage "hardlink";
  missingExtensionPackage = mkExtensionPackage "missing";
  componentSymlinkExtensionPackage = mkExtensionPackage "component-symlink";
  leafSymlinkExtensionPackage = mkExtensionPackage "leaf-symlink";
  recomputedExtensionPackage = mkExtensionPackage "recomputed-tamper";
  manifestAliasExtensionPackage = mkExtensionPackage "manifest-alias";
  identityAliasExtensionPackage = mkExtensionPackage "identity-alias";
  missingEntrypointManifest = "${missingExtensionPackage}/share/pi-agent/extensions.json";
  componentSymlinkManifest = "${componentSymlinkExtensionPackage}/share/pi-agent/extensions.json";
  leafSymlinkManifest = "${leafSymlinkExtensionPackage}/share/pi-agent/extensions.json";

  fakePi =
    pkgs.runCommand "pi-coding-agent-0.83.0-task-5-6-tripwire"
      {
        pname = "pi-coding-agent";
        version = "0.83.0";
      }
      ''
        mkdir -p "$out/bin" "$out/lib"
        ln -s ${pkgs.pi-agent}/lib/node_modules "$out/lib/node_modules"
        cat > "$out/bin/pi" <<'SH'
        #!${pkgs.runtimeShell}
        if [ -n "''${PI_AGENT_FAKE_PI_MARKER-}" ]; then
          printf 'started\n' > "$PI_AGENT_FAKE_PI_MARKER"
        fi
        exit 91
        SH
        chmod 0555 "$out/bin/pi"
      '';
  readyLsp = pkgs.writeShellScriptBin "nixd" "exit 0";
  missingLsp = pkgs.runCommand "pi-agent-task-5-6-missing-lsp" { } ''
    mkdir -p "$out/bin"
  '';
  fakeDevx = pkgs.writeShellScriptBin "devx" "exit 1";

  credentialPolicy = import (repoRoot + "/home-manager/common/pi-agent/credential-policy.nix") {
    inherit lib pkgs;
    trustedDevxOutPath = fakeDevx.outPath;
  };
  credentialRuntime =
    mode:
    (credentialPolicy.render {
      hostSelection = { inherit mode; };
    }).runtimeModule;

  forbiddenProbeValues = [
    providerSentinel
    launchSentinel
    openAiSentinel
    adminSentinel
  ];
  fakeCavemem = pkgs.writeTextFile {
    name = "pi-agent-task-5-6-cavemem";
    destination = "/bin/cavemem";
    executable = true;
    text = ''
      #!${pkgs.nodejs}/bin/node
      import fs from "node:fs";
      import path from "node:path";

       const forbidden = ${builtins.toJSON forbiddenProbeValues};
       const dataDir = process.env.CAVEMEM_DATA_DIR;
       if (
        process.argv.length !== 4
        || process.argv[2] !== "worker"
         || process.argv[3] !== "status"
         || typeof dataDir !== "string"
         || forbidden.some((secret) => process.cwd().includes(secret))
       ) {
        process.exit(64);
      }
      if (
        Object.values(process.env).some((value) =>
          forbidden.some((secret) => value.includes(secret)),
        )
      ) {
        fs.writeFileSync(path.join(dataDir, "probe-secret-observed"), "observed\n");
        process.exit(71);
      }
      process.stdout.write(
        fs.existsSync(path.join(dataDir, "worker-ready"))
          ? "running (pid 4242)\n"
          : "not running\n",
      );
    '';
  };
  fakeSecurity = pkgs.writeTextFile {
    name = "pi-agent-task-5-6-security";
    destination = "/bin/security";
    executable = true;
    text = ''
      #!${pkgs.nodejs}/bin/node
      const forbidden = ${builtins.toJSON forbiddenProbeValues};
      const expected = [
        "find-generic-password",
        "-s",
        "mcpproxy",
        "-a",
        "mcpproxy-api-key",
        "-w",
      ];
       if (
         JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)
         || forbidden.some((secret) => process.cwd().includes(secret))
         || Object.values(process.env).some((value) =>
          forbidden.some((secret) => value.includes(secret)),
        )
      ) {
        process.exit(71);
      }
      process.stdout.write(${builtins.toJSON "${adminSentinel}\n"});
    '';
  };
  failingSecurity = pkgs.writeTextFile {
    name = "pi-agent-task-5-6-failing-security";
    destination = "/bin/security";
    executable = true;
    text = ''
      #!${pkgs.nodejs}/bin/node
      import fs from "node:fs";
      import path from "node:path";

      const expected = [
        "find-generic-password",
        "-s",
        "mcpproxy",
        "-a",
        "mcpproxy-api-key",
        "-w",
      ];
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
        process.exit(64);
      }
      if (
        Object.values(process.env).some((value) =>
          value.includes(${builtins.toJSON adminSentinel}),
        )
      ) {
        const home = process.env.HOME;
        if (typeof home === "string") {
          fs.writeFileSync(
            path.join(path.dirname(home), "keychain-secret-observed"),
            "observed\n",
          );
        }
      }
      process.exit(75);
    '';
  };
  directToolNames = [
    "retrieve_tools"
    "describe_tool"
    "call_tool_read"
    "call_tool_write"
    "call_tool_destructive"
    "read_cache"
  ];
  readyMcpModule = pkgs.writeText "pi-agent-task-5-6-ready-mcp.mjs" ''
    const ADMIN_KEY = ${builtins.toJSON adminSentinel};
    const FORBIDDEN_VALUES = Object.freeze(${builtins.toJSON forbiddenProbeValues});
    const TOOL_NAMES = Object.freeze(${builtins.toJSON directToolNames});
    export const MCPPROXY_PREFLIGHT_CONTRACT = Object.freeze({
      mcpUrl: "http://127.0.0.1:8080/mcp",
      recovery: "restart mcpproxy or repair the declared upstream",
      toolNames: TOOL_NAMES,
    });
     export async function preflightMcpproxy(options) {
       if (
         FORBIDDEN_VALUES.some((secret) => process.cwd().includes(secret))
         ||
         Object.values(process.env).some((value) =>
          FORBIDDEN_VALUES.some((secret) => value.includes(secret)),
        )
      ) {
        throw new Error("MCP preflight inherited an exact credential value");
      }
      if (
        options.adminApiKey !== ADMIN_KEY
        || JSON.stringify(options.mandatoryUpstreams) !== '["obsidian","cavemem"]'
      ) {
        throw new Error("credential-bearing MCP fixture input rejected");
      }
      return Object.freeze({ toolNames: TOOL_NAMES });
    }
  '';
  degradedMcpModule = pkgs.writeText "pi-agent-task-5-6-degraded-mcp.mjs" ''
    export const MCPPROXY_PREFLIGHT_CONTRACT = Object.freeze({
      mcpUrl: "http://127.0.0.1:8080/mcp",
      recovery: "restart mcpproxy or repair the declared upstream",
      toolNames: Object.freeze(${builtins.toJSON directToolNames}),
    });
    export async function preflightMcpproxy() {
      throw new Error(
        "Authorization: Bearer ${providerSentinel}; X-API-Key: ${adminSentinel}",
      );
    }
  '';

  managedSettings = {
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
    defaultThinkingLevel = "xhigh";
    shellPath = "${pkgs.bash}/bin/bash";
    installTelemetry = false;
    selfUpdate = false;
    unmanagedPackages = false;
  };
  mkManagedConfig =
    {
      mode,
      manifest,
      lspExecutables ? {
        nix = "${readyLsp}/bin/nixd";
      },
    }:
    pkgs.writeText "pi-agent-task-5-6-managed-config-${mode}.json" (
      builtins.toJSON {
        schemaVersion = 1;
        inherit generation;
        agentDir = "pi-default";
        settings = managedSettings;
        timeouts.bashDefaultMs = 120000;
        providerSelection =
          if mode == "personal" then
            {
              inherit mode;
              inherit (managedSettings) defaultModel;
            }
          else
            {
              inherit mode;
              enabledRoles = [ "openai" ];
              inherit (managedSettings) defaultModel;
            };
        extensionManifest = toString manifest;
        inherit extensionOrder lspExecutables;
        instructionResources = [ ];
        mcpEndpoint = "http://127.0.0.1:8080/mcp";
        sandboxDefault = "audit";
      }
    );
  personalConfig = mkManagedConfig {
    mode = "personal";
    manifest = completeManifest;
  };
  shopifyConfig = mkManagedConfig {
    mode = "shopify-gateway";
    manifest = completeManifest;
  };
  degradedConfig = mkManagedConfig {
    mode = "personal";
    manifest = degradedManifest;
    lspExecutables = {
      nix = "${readyLsp}/bin/nixd";
      typescript = "${missingLsp}/bin/typescript-language-server";
    };
  };
  missingEntrypointConfig = mkManagedConfig {
    mode = "personal";
    manifest = missingEntrypointManifest;
  };
  componentSymlinkConfig = mkManagedConfig {
    mode = "personal";
    manifest = componentSymlinkManifest;
  };
  leafSymlinkConfig = mkManagedConfig {
    mode = "personal";
    manifest = leafSymlinkManifest;
  };

  mkStatus =
    {
      managedConfig,
      extensionManifest,
      extensionPackage ? pkgs.pi-agent-extensions,
      extensionIdentity ? canonicalIdentity,
      mode,
      mcpPreflightModule ? null,
      piPackage ? fakePi,
      cavememPackage ? fakeCavemem,
      keychainExecutable ? "${fakeSecurity}/bin/security",
    }:
    import (repoRoot + "/scripts/pi-agent-status.nix") {
      inherit
        cavememPackage
        extensionIdentity
        extensionManifest
        keychainExecutable
        managedConfig
        mcpPreflightModule
        piPackage
        pkgs
        ;
      credentialRuntimeModule = credentialRuntime mode;
      defaultState = "audit";
      inherit extensionPackage;
    };
  personal = mkStatus {
    managedConfig = personalConfig;
    extensionManifest = completeManifest;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  shopify = mkStatus {
    managedConfig = shopifyConfig;
    extensionManifest = completeManifest;
    mode = "shopify-gateway";
    mcpPreflightModule = readyMcpModule;
  };
  degraded = mkStatus {
    managedConfig = degradedConfig;
    extensionManifest = degradedManifest;
    mode = "personal";
    mcpPreflightModule = degradedMcpModule;
  };
  missingExtension = mkStatus {
    managedConfig = missingEntrypointConfig;
    extensionManifest = missingEntrypointManifest;
    extensionPackage = missingExtensionPackage;
    extensionIdentity = missingExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  hardlinkExtension = mkStatus {
    managedConfig = mkManagedConfig {
      mode = "personal";
      manifest = "${hardlinkExtensionPackage}/share/pi-agent/extensions.json";
    };
    extensionManifest = "${hardlinkExtensionPackage}/share/pi-agent/extensions.json";
    extensionPackage = hardlinkExtensionPackage;
    extensionIdentity = hardlinkExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  componentSymlinkExtension = mkStatus {
    managedConfig = componentSymlinkConfig;
    extensionManifest = componentSymlinkManifest;
    extensionPackage = componentSymlinkExtensionPackage;
    extensionIdentity = componentSymlinkExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  leafSymlinkExtension = mkStatus {
    managedConfig = leafSymlinkConfig;
    extensionManifest = leafSymlinkManifest;
    extensionPackage = leafSymlinkExtensionPackage;
    extensionIdentity = leafSymlinkExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  recomputedExtension = mkStatus {
    managedConfig = mkManagedConfig {
      mode = "personal";
      manifest = "${recomputedExtensionPackage}/share/pi-agent/extensions.json";
    };
    extensionManifest = "${recomputedExtensionPackage}/share/pi-agent/extensions.json";
    extensionPackage = recomputedExtensionPackage;
    extensionIdentity = recomputedExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  manifestAlias = mkStatus {
    managedConfig = mkManagedConfig {
      mode = "personal";
      manifest = "${manifestAliasExtensionPackage}/share/pi-agent/extensions.json";
    };
    extensionManifest = "${manifestAliasExtensionPackage}/share/pi-agent/extensions.json";
    extensionPackage = manifestAliasExtensionPackage;
    extensionIdentity = manifestAliasExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  identityAlias = mkStatus {
    managedConfig = mkManagedConfig {
      mode = "personal";
      manifest = "${identityAliasExtensionPackage}/share/pi-agent/extensions.json";
    };
    extensionManifest = "${identityAliasExtensionPackage}/share/pi-agent/extensions.json";
    extensionPackage = identityAliasExtensionPackage;
    extensionIdentity = identityAliasExtensionPackage.identity;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
  };
  lookupFailure = mkStatus {
    managedConfig = personalConfig;
    extensionManifest = completeManifest;
    mode = "personal";
    mcpPreflightModule = readyMcpModule;
    keychainExecutable = "${failingSecurity}/bin/security";
  };
  production = mkStatus {
    managedConfig = personalConfig;
    extensionManifest = completeManifest;
    mode = "personal";
    piPackage = pkgs.pi-agent;
    cavememPackage = pkgs.cavemem;
    keychainExecutable = "/usr/bin/security";
  };
  packages = pkgs.linkFarm "pi-agent-task-5-6-status-fixtures" [
    {
      name = "personal";
      path = personal;
    }
    {
      name = "shopify";
      path = shopify;
    }
    {
      name = "degraded";
      path = degraded;
    }
    {
      name = "production";
      path = production;
    }
    {
      name = "missing-extension";
      path = missingExtension;
    }
    {
      name = "hardlink-extension";
      path = hardlinkExtension;
    }
    {
      name = "component-symlink-extension";
      path = componentSymlinkExtension;
    }
    {
      name = "leaf-symlink-extension";
      path = leafSymlinkExtension;
    }
    {
      name = "recomputed-extension";
      path = recomputedExtension;
    }
    {
      name = "manifest-alias";
      path = manifestAlias;
    }
    {
      name = "identity-alias";
      path = identityAlias;
    }
    {
      name = "lookup-failure";
      path = lookupFailure;
    }
  ];
in
if fixture == "packages" then packages else throw "unknown pi-agent status fixture: ${fixture}"
