{
  cavememPackage,
  credentialRuntimeModule,
  defaultState,
  extensionIdentity,
  extensionManifest,
  extensionPackage,
  managedConfig,
  piPackage,
  pkgs,
  keychainExecutable ? "/usr/bin/security",
  mcpPreflightModule ? null,
}:
let
  expectedPiVersion = "0.83.0";
  checkedPiPackage =
    if
      (piPackage.pname or null) == "pi-coding-agent" && (piPackage.version or null) == expectedPiVersion
    then
      piPackage
    else
      throw "pi-agent status requires the reviewed pi-coding-agent 0.83.0 package";
  sandboxResolver = import ./pi-agent-sandbox-resolver.nix {
    inherit defaultState pkgs;
  };
  reconcilerModule = pkgs.writeText "pi-agent-status-reconciler.mjs" (
    builtins.readFile ./pi-agent-reconcile.mjs
  );
  defaultMcpPreflightModule = pkgs.writeText "pi-agent-status-mcp-preflight.mjs" ''
    import { pathToFileURL } from "node:url";

    const piNodeModules = ${builtins.toJSON "${checkedPiPackage}/lib/node_modules"};
    const extensionRoot = ${builtins.toJSON (toString extensionPackage)};
    const { createJiti } = await import(
      pathToFileURL(piNodeModules + "/jiti/lib/jiti.mjs").href
    );
    const module = await createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@earendil-works/pi-ai/compat": piNodeModules + "/@earendil-works/pi-ai/compat.js",
        "@earendil-works/pi-ai": piNodeModules + "/@earendil-works/pi-ai/index.js",
        "@earendil-works/pi-coding-agent": piNodeModules + "/@earendil-works/pi-coding-agent/index.js",
        "@earendil-works/pi-tui": piNodeModules + "/@earendil-works/pi-tui/index.js",
        typebox: extensionRoot + "/lib/node_modules/typebox/build/index.mjs",
      },
    }).import(extensionRoot + "/lib/pi-agent/extensions/mcpproxy/index.ts");

    export const MCPPROXY_PREFLIGHT_CONTRACT = module.MCPPROXY_PREFLIGHT_CONTRACT;
    export const preflightMcpproxy = module.preflightMcpproxy;
  '';
  selectedMcpPreflightModule =
    if mcpPreflightModule == null then defaultMcpPreflightModule else mcpPreflightModule;
  extensionIdentityFile =
    if (extensionPackage.identityFile or null) == "extensions-provenance.json" then
      extensionPackage.identityFile
    else
      throw "pi-agent status requires the reviewed extension identity filename";
  extensionProvenancePath =
    if (extensionPackage.provenancePath or null) == "share/pi-agent/extensions-provenance.json" then
      extensionPackage.provenancePath
    else
      throw "pi-agent status requires the reviewed extension provenance path";
  extensionIdentityPath = "${extensionIdentity}/${extensionIdentityFile}";
  probeWorkingDirectory = pkgs.runCommand "pi-agent-status-probe-cwd" { } ''
    mkdir -p "$out"
  '';
  mcpProbeSource = pkgs.writeText "pi-agent-mcp-status-probe.mjs" ''
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";

    const PREFLIGHT_MODULE = ${builtins.toJSON (toString selectedMcpPreflightModule)};
    const DIRECT_TOOL_NAMES = Object.freeze([
      "retrieve_tools",
      "describe_tool",
      "call_tool_read",
      "call_tool_write",
      "call_tool_destructive",
      "read_cache",
    ]);

    function isRecord(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function sameStrings(actual, expected) {
      return (
        Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index])
      );
    }

    let ready = false;
    try {
      const bytes = fs.readFileSync(0);
      if (bytes.length === 0 || bytes.length > 65536) throw new Error("invalid input");
      const input = JSON.parse(bytes.toString("utf8"));
      if (
        !isRecord(input)
        || Object.keys(input).sort().join(",") !== "adminApiKey,endpoint"
        || typeof input.adminApiKey !== "string"
        || input.adminApiKey.length === 0
        || typeof input.endpoint !== "string"
      ) {
        throw new Error("invalid input");
      }
      const module = await import(pathToFileURL(PREFLIGHT_MODULE).href);
      const contract = module.MCPPROXY_PREFLIGHT_CONTRACT;
      if (
        !isRecord(contract)
        || contract.mcpUrl !== input.endpoint
        || !sameStrings(contract.toolNames, DIRECT_TOOL_NAMES)
        || typeof module.preflightMcpproxy !== "function"
      ) {
        throw new Error("invalid contract");
      }
      const result = await module.preflightMcpproxy({
        adminApiKey: input.adminApiKey,
        mandatoryUpstreams: ["obsidian", "cavemem"],
        timeoutMs: 2000,
      });
      ready = isRecord(result) && sameStrings(result.toolNames, DIRECT_TOOL_NAMES);
    } catch {
      ready = false;
    }
    process.stdout.write(JSON.stringify({ ready }) + "\n");
  '';
  extensionProbeSource = pkgs.writeText "pi-agent-extension-status-probe.mjs" ''
    import { pathToFileURL } from "node:url";

    const PI_NODE_MODULES = ${builtins.toJSON "${checkedPiPackage}/lib/node_modules"};
    const EXTENSION_ROOT = ${builtins.toJSON (toString extensionPackage)};
    const EXPECTED_IDENTITY_PATH = ${builtins.toJSON extensionIdentityPath};
    const EXPECTED_PROVENANCE_PATH = ${builtins.toJSON "${extensionPackage}/${extensionProvenancePath}"};
    const EXPECTED_CWD = ${builtins.toJSON (toString probeWorkingDirectory)};
    const EXPECTED_PI_VERSION = ${builtins.toJSON expectedPiVersion};

    try {
      if (process.argv.length !== 2 || process.cwd() !== EXPECTED_CWD) {
        throw new Error("invalid invocation");
      }
      const { createJiti } = await import(
        pathToFileURL(PI_NODE_MODULES + "/jiti/lib/jiti.mjs").href
      );
      const module = await createJiti(import.meta.url, {
        moduleCache: false,
      }).import(EXTENSION_ROOT + "/lib/pi-agent/extensions/managed-manifest.ts");
      if (
        module.MANAGED_EXTENSION_IDENTITY_PATH !== EXPECTED_IDENTITY_PATH
        || EXPECTED_PROVENANCE_PATH !== EXTENSION_ROOT + "/share/pi-agent/extensions-provenance.json"
        || typeof module.loadManagedExtensionPackage !== "function"
        || module.loadManagedExtensionPackage.length !== 0
      ) {
        throw new Error("invalid identity contract");
      }
      const resolved = module.loadManagedExtensionPackage();
      if (
        resolved.packageRoot !== EXTENSION_ROOT
        || resolved.piVersion !== EXPECTED_PI_VERSION
        || !Array.isArray(resolved.extensionOrder)
        || !Array.isArray(resolved.entries)
        || resolved.extensionOrder.length !== resolved.entries.length
      ) {
        throw new Error("invalid extension contract");
      }
      const extensions = {};
      for (const [index, logicalName] of resolved.extensionOrder.entries()) {
        const entry = resolved.entries[index];
        if (
          typeof logicalName !== "string"
          || entry.logicalName !== logicalName
          || typeof entry.version !== "string"
          || Object.hasOwn(extensions, logicalName)
        ) {
          throw new Error("invalid extension contract");
        }
        extensions[logicalName] = entry.version;
      }
      process.stdout.write(JSON.stringify({
        ready: true,
        piVersion: resolved.piVersion,
        extensionOrder: resolved.extensionOrder,
        extensions,
      }) + "\n");
    } catch {
      process.stdout.write('{"ready":false}\n');
    }
  '';
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_STATUS_MANAGED_CONFIG__"
        "__PI_AGENT_STATUS_EXTENSION_MANIFEST__"
        "__PI_AGENT_STATUS_CREDENTIAL_POLICY__"
        "__PI_AGENT_STATUS_SANDBOX_RESOLVER__"
        "__PI_AGENT_STATUS_RECONCILER__"
        "__PI_AGENT_STATUS_NODE__"
        "__PI_AGENT_STATUS_EXTENSION_PACKAGE_ROOT__"
        "__PI_AGENT_STATUS_PROBE_CWD__"
        "__PI_AGENT_STATUS_CAVEMEM__"
        "__PI_AGENT_STATUS_KEYCHAIN__"
        "__PI_AGENT_STATUS_PI_VERSION__"
        "__PI_AGENT_STATUS_SANDBOX_DEFAULT__"
      ]
      [
        (toString managedConfig)
        (toString extensionManifest)
        "${credentialRuntimeModule}/lib/pi-agent/credential-policy.mjs"
        "${sandboxResolver}/lib/pi-agent/sandbox-resolver.mjs"
        (toString reconcilerModule)
        "${pkgs.nodejs}/bin/node"
        (toString extensionPackage)
        (toString probeWorkingDirectory)
        "${cavememPackage}/bin/cavemem"
        (toString keychainExecutable)
        expectedPiVersion
        defaultState
      ]
      (builtins.readFile ./pi-agent-status.mjs);
  sourceFile = pkgs.writeText "pi-agent-status.mjs" source;
in
pkgs.runCommand "pi-agent-status-${defaultState}"
  {
    nativeBuildInputs = [ pkgs.coreutils ];
  }
  ''
    mkdir -p "$out/bin" "$out/lib/pi-agent" "$out/share/pi-agent"
    install -m444 ${sourceFile} "$out/lib/pi-agent/status.mjs"
    install -m444 ${mcpProbeSource} "$out/lib/pi-agent/mcp-status-probe.mjs"
    install -m444 ${extensionProbeSource} "$out/lib/pi-agent/extension-status-probe.mjs"
    install -m444 ${managedConfig} "$out/share/pi-agent/managed-config.json"
    install -m444 ${extensionManifest} "$out/share/pi-agent/extensions.json"
    cat > "$out/bin/pi-agent-status.mjs" <<EOF
    #!${pkgs.nodejs}/bin/node
    try {
      const { runManagedStatusCli } = await import("../lib/pi-agent/status.mjs");
      process.exitCode = await runManagedStatusCli();
    } catch {
      process.exitCode = 2;
    }
    EOF
    chmod 0555 "$out/bin/pi-agent-status.mjs"
    ln -s pi-agent-status.mjs "$out/bin/pi-agent-status"
  ''
