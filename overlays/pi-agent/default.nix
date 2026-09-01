{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystem = "aarch64-darwin";
  credentialPolicy = import ../../home-manager/common/pi-agent/credential-policy.nix {
    inherit (final) lib;
    pkgs = final;
  };
  requireSupported =
    value: if system == supportedSystem then value else throw "pi-agent supports only aarch64-darwin";
  upstream = requireSupported inputs.pi-nix.packages.${system}.coding-agent;
  contextRecoveryCommit = "32850ef7c5edff7a6eee0214516fbb7382bf292d";
  contextRecoveryParent = "e56893f4cd6545ab1498b72ae4e1e2241a0926f4";
  contextRecoveryPatch = ./pi-context-recovery.patch;
  piRuntimeBootstrapPatch = ./pi-launch-redaction-bootstrap.patch;
  piCavememEnvironmentBootstrapPatch = final.replaceVars ./pi-cavemem-environment-bootstrap.patch {
    cavememEnvironmentAllowlist = builtins.toJSON credentialPolicy.cavememEnvironmentAllowlist;
  };
  contextRecoveryTestFiles = [
    "packages/ai/test/openai-responses-terminal-event.test.ts"
    "packages/ai/test/overflow.test.ts"
    "packages/coding-agent/test/assistant-message.test.ts"
    "packages/coding-agent/test/suite/agent-session-compaction.test.ts"
  ];
  terminalBaselineTestFiles = [
    "packages/coding-agent/test/suite/agent-session-retry-events.test.ts"
  ];
  contextRecoveryTestMetadata = final.writeText "pi-context-recovery-test-metadata.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = upstream.version;
      upstreamCommit = contextRecoveryCommit;
      upstreamParent = contextRecoveryParent;
      upstreamTests = contextRecoveryTestFiles;
      terminalBaselineTests = terminalBaselineTestFiles;
    }
  );
  contextRecoveryManifestRenderer = final.writeText "pi-context-recovery-manifest.mjs" ''
    import fs from "node:fs";

    const [metadataPath, outputPath, ...reportPaths] = process.argv.slice(2);
    if (!metadataPath || !outputPath || reportPaths.length === 0) {
      throw new Error("usage: render-context-recovery-manifest METADATA OUTPUT REPORT...");
    }

    const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    const sameValues = (left, right) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const expectedFiles = [...metadata.upstreamTests, ...metadata.terminalBaselineTests].sort(compareText);
    const results = [];

    for (const reportPath of reportPaths) {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (report.success !== true || !Array.isArray(report.testResults)) {
        throw new Error("focused Vitest report is incomplete or unsuccessful");
      }

      for (const fileResult of report.testResults) {
        const markerIndex = fileResult.name.lastIndexOf("packages/");
        if (markerIndex < 0 || !Array.isArray(fileResult.assertionResults)) {
          throw new Error("focused Vitest report has an unexpected file result");
        }

        const file = fileResult.name.slice(markerIndex);
        if (!expectedFiles.includes(file) || fileResult.status !== "passed") {
          throw new Error("unexpected or unsuccessful focused test file: " + file);
        }

        for (const assertion of fileResult.assertionResults) {
          if (assertion.status !== "passed" || !Array.isArray(assertion.ancestorTitles)) {
            throw new Error("focused test did not pass: " + assertion.title);
          }
          const titles = [...assertion.ancestorTitles.filter(Boolean), assertion.title];
          results.push({ id: file + " > " + titles.join(" > "), status: "pass" });
        }
      }
    }

    results.sort((left, right) => compareText(left.id, right.id));
    const files = [...new Set(results.map(({ id }) => id.slice(0, id.indexOf(" > "))))].sort(compareText);
    if (!sameValues(files, expectedFiles)) {
      throw new Error("focused Vitest reports did not cover the declared test files");
    }
    if (new Set(results.map(({ id }) => id)).size !== results.length) {
      throw new Error("focused Vitest reports contain duplicate test identifiers");
    }

    const manifest = {
      ...metadata,
      summary: {
        failed: 0,
        files: files.length,
        passed: results.length,
        total: results.length,
      },
      tests: results,
    };
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  '';
  undiciPatch = ./pi-undici-8.9.0.patch;
  piLock = ./pi-package-lock.json;
  npmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
  extensionRoot = ./extensions;
  extensionNpmDepsHash = "sha256-bSn4YVPB1qGfOAGXYzl9Oq3XmQ0G9rNCsk+coNgTFTM=";
  managedExtensionOrder = [
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
  managedExtensionLoaderContract = {
    entryPath = "lib/pi-agent/extensions/managed-loader.ts";
    discovery = {
      extensions = false;
      skills = false;
      prompts = false;
    };
  };
  managedExtensionContract = {
    piVersion = upstream.version;
    loader = managedExtensionLoaderContract;
    extensionOrder = managedExtensionOrder;
    provenance = extensionProvenanceContract;
    extensions = final.lib.mapAttrs (_logicalName: extension: {
      inherit (extension)
        package
        version
        sourceRef
        entryPath
        license
        ;
    }) extensionInventory;
  };
  trustedIdentityPlaceholder = "__PI_AGENT_EXTENSION_IDENTITY_PATH__";
  managedExtensionLoaderSource = final.replaceVars ./extensions/managed-loader.ts.in {
    trustedIdentityPath = trustedIdentityPlaceholder;
  };
  managedExtensionManifestSource = final.replaceVars ./extensions/managed-manifest.ts.in {
    managedExtensionContract = builtins.toJSON managedExtensionContract;
    trustedIdentityPath = trustedIdentityPlaceholder;
  };
  managedExtensionTypecheckPackage = final.writeText "pi-managed-extension-package.json" (
    builtins.toJSON { type = "module"; }
  );
  managedSubagentCatalog = final.writeText "pi-agent-managed-subagents.json" (
    builtins.readFile ./extensions/managed-subagents.json
  );
  managedSubagentPolicy = ./extensions/pi-subagents-managed-policy.ts.in;
  managedSubagentReader = ./extensions/pi-subagents-reader.md;
  managedSubagentWorker = ./extensions/pi-subagents-worker.md;
  managedSubagentsPatch = ./extensions/patches/pi-subagents-managed-children.patch;
  managedSubagentsLifecyclePatch = ./extensions/patches/pi-subagents-managed-lifecycle.patch;
  cavememBridgeSource = final.replaceVars ./extensions/cavemem/index.ts.in {
    cavemem = "${final.cavemem}/bin/cavemem";
  };
  cavememBridgePackage = builtins.fromJSON (builtins.readFile ./extensions/cavemem/package.json);
  mcpproxyAdapterPackage = builtins.fromJSON (builtins.readFile ./extensions/mcpproxy/package.json);
  managedMcpAdapterPatch = ./extensions/patches/pi-mcp-adapter-managed-direct-tools.patch;
  privateMcpCachePatch = ./extensions/patches/pi-mcp-adapter-private-cache.patch;
  cooperativePlanModePatch = ./extensions/patches/pi-plan-mode-cooperative-state.patch;
  managedBashTimeoutPatch = ./extensions/patches/supi-bash-timeout-managed-default.patch;
  structuredQuestionsPatch = ./extensions/patches/supi-ask-user-structured-results.patch;
  managedBackgroundPipePatch = ./extensions/patches/pi-background-tasks-managed-pipe.patch;
  managedBackgroundPtyPatch = ./extensions/patches/pi-background-tasks-managed-pty.patch;
  managedBackgroundEnvironmentModule = final.writeText "pi-background-tasks-managed-environment.ts" ''
    const ALLOW_NAMES: readonly string[] = ${builtins.toJSON credentialPolicy.shellAllowlist};
    const REMOVE_NAMES = new Set<string>(${builtins.toJSON credentialPolicy.shellRemoveNames});

    export function scrubManagedEnvironment(
      environment: Readonly<Record<string, string | undefined>>,
    ): Record<string, string> {
      const scrubbed: Record<string, string> = {};
      for (const name of ALLOW_NAMES) {
        const value = environment[name];
        if (!REMOVE_NAMES.has(name) && typeof value === "string") scrubbed[name] = value;
      }
      return scrubbed;
    }
  '';
  managedCodeIntelligencePatch = ./extensions/patches/supi-code-intelligence-managed-lsp.patch;
  managedCodeIntelligenceLifecyclePatch = ./extensions/patches/supi-code-intelligence-managed-lsp-lifecycle.patch;
  managedCodeIntelligenceConcurrencyPatch = ./extensions/patches/supi-code-intelligence-managed-lsp-concurrency.patch;
  managedCodeIntelligenceOwnershipPatch = ./extensions/patches/supi-code-intelligence-managed-lsp-ownership.patch;
  extensionTypecheckConfig = final.writeText "pi-extension-tsconfig.json" (
    builtins.toJSON {
      compilerOptions = {
        allowImportingTsExtensions = true;
        baseUrl = ".";
        esModuleInterop = true;
        forceConsistentCasingInFileNames = true;
        module = "Node16";
        moduleResolution = "Node16";
        noEmit = true;
        paths = {
          "@earendil-works/pi-ai" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-ai/dist/index.d.ts"
          ];
          "@earendil-works/pi-ai/compat" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"
          ];
          "@earendil-works/pi-coding-agent" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-coding-agent/index.d.ts"
          ];
          "@earendil-works/pi-tui" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-tui/index.d.ts"
          ];
          "@narumitw/pi-tui-kit" = [ "pi-tui-kit/dist/index.d.ts" ];
          "cross-spawn" = [
            "${final.pi-agent}/lib/node_modules/@types/cross-spawn/index.d.ts"
          ];
          "pi-mcp-adapter" = [ "pi-mcp-adapter/index.ts" ];
          "typebox" = [ "typebox/build/index.d.mts" ];
          "typebox/*" = [ "typebox/build/*/index.d.mts" ];
        };
        resolveJsonModule = true;
        skipLibCheck = true;
        strict = true;
        target = "ES2022";
        typeRoots = [ "${final.pi-agent}/lib/node_modules/@types" ];
        types = [ "node" ];
      };
      files = [
        "ask-user/src/extension.ts"
        "background-tasks/dist/managed-environment.ts"
        "bash-timeout/src/extension.ts"
        "cavemem/index.ts"
        "code-intelligence/src/extension.ts"
        "managed-loader.ts"
        "managed-manifest.ts"
        "mcpproxy/index.ts"
        "pi-subagents/src/managed-policy.ts"
        "plan-mode/src/index.ts"
      ];
    }
  );
  backgroundTypecheckExpectedDiagnostics = [
    "error TS2322: Type '(value: unknown) => void' is not assignable to type '() => void'."
    "error TS2339: Property 'codePointAt' does not exist on type 'unknown'."
    "error TS2339: Property 'killWindowsProcessTree' does not exist on type '{}'."
    "error TS2339: Property 'loadConfig' does not exist on type '{}'."
    "error TS2339: Property 'ptySpawnProcess' does not exist on type '{}'."
    "error TS2339: Property 'retainForNextAgentTurn' does not exist on type 'unknown'."
    "error TS2339: Property 'saveConfig' does not exist on type '{}'."
    "error TS2339: Property 'spawnProcess' does not exist on type '{}'."
    "error TS2339: Property 'terminalInput' does not exist on type '{}'."
    "error TS2339: Property 'terminalOutput' does not exist on type '{}'."
    "error TS2554: Expected 2 arguments, but got 1."
    "error TS2554: Expected 2 arguments, but got 1."
    "error TS2554: Expected 2 arguments, but got 1."
    "error TS2554: Expected 3 arguments, but got 2."
    "error TS2554: Expected 3 arguments, but got 2."
    "error TS2554: Expected 3 arguments, but got 2."
    "error TS2554: Expected 5 arguments, but got 3."
    "error TS2554: Expected 5 arguments, but got 3."
    "error TS2554: Expected 5 arguments, but got 3."
    "error TS2554: Expected 5 arguments, but got 4."
    "error TS2794: Expected 1 arguments, but got 0. Did you forget to include 'void' in your type argument to 'Promise'?"
    "error TS2794: Expected 1 arguments, but got 0. Did you forget to include 'void' in your type argument to 'Promise'?"
    "error TS2794: Expected 1 arguments, but got 0. Did you forget to include 'void' in your type argument to 'Promise'?"
  ];
  backgroundTypecheckConfig = final.writeText "pi-background-typecheck-tsconfig.json" (
    builtins.toJSON {
      compilerOptions = {
        allowImportingTsExtensions = true;
        baseUrl = ".";
        esModuleInterop = true;
        forceConsistentCasingInFileNames = true;
        lib = [ "ES2023" ];
        module = "Node16";
        moduleResolution = "Node16";
        noEmit = true;
        paths = {
          "@earendil-works/pi-ai" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-ai/dist/index.d.ts"
          ];
          "@earendil-works/pi-ai/compat" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"
          ];
          "@earendil-works/pi-coding-agent" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-coding-agent/index.d.ts"
          ];
          "@earendil-works/pi-tui" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-tui/index.d.ts"
          ];
          "@narumitw/pi-tui-kit" = [ "pi-tui-kit/dist/index.d.ts" ];
          "@99percentpeople/pi-shared-settings" = [ "shared-settings/dist/index.d.ts" ];
          "node-pty" = [ "node-pty/typings/node-pty.d.ts" ];
          "typebox" = [ "typebox/build/index.d.mts" ];
          "typebox/*" = [ "typebox/build/*/index.d.mts" ];
        };
        resolveJsonModule = true;
        skipLibCheck = true;
        strict = false;
        target = "ES2023";
        typeRoots = [ "${final.pi-agent}/lib/node_modules/@types" ];
        types = [ "node" ];
      };
      files = [
        "background-tasks/dist/index.ts"
        "background-tasks/dist/managed-environment.ts"
      ];
    }
  );
  backgroundTypecheckRenderer = final.writeText "pi-background-typecheck-render.mjs" ''
    import fs from "node:fs";

    const [diagnosticsPath, statusText] = process.argv.slice(2);
    const expected = ${builtins.toJSON backgroundTypecheckExpectedDiagnostics}.sort();
    const diagnostics = fs.readFileSync(diagnosticsPath, "utf8");
    const actual = diagnostics
      .split("\n")
      .map((line) => line.match(/error TS\d+: .*/)?.[0])
      .filter(Boolean)
      .sort();
    if (Number(statusText) !== 2 || JSON.stringify(actual) !== JSON.stringify(expected)) {
      process.stderr.write(diagnostics);
      throw new Error("background task TypeScript diagnostics changed from the reviewed bundled baseline");
    }
  '';
  extensionInventory = {
    cavemem = {
      package = cavememBridgePackage.name;
      inherit (cavememBridgePackage) version;
      sourceRef = "repository";
      entryPath = "lib/pi-agent/extensions/cavemem/index.ts";
      license = "MIT";
    };
    mcp = {
      package = mcpproxyAdapterPackage.name;
      inherit (mcpproxyAdapterPackage) version;
      sourceRef = "repository";
      entryPath = "lib/pi-agent/extensions/mcpproxy/index.ts";
      license = "MIT";
    };
    subagents = {
      package = "pi-subagents";
      version = "0.40.0";
      sourceRef = "d4d2ab70";
      entryPath = "lib/node_modules/pi-subagents/index.ts";
      license = "MIT";
    };
    plan = {
      package = "@narumitw/pi-plan-mode";
      version = "0.49.2";
      sourceRef = "df5f5ce7";
      entryPath = "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts";
      license = "MIT";
    };
    timestamps = {
      package = "@narumitw/pi-stamp";
      version = "0.49.3";
      sourceRef = "4c2c2e8c";
      entryPath = "lib/node_modules/@narumitw/pi-stamp/src/index.ts";
      license = "MIT";
    };
    bashTimeout = {
      package = "@mrclrchtr/supi-bash-timeout";
      version = "4.6.0";
      sourceRef = "98b80f6d";
      entryPath = "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts";
      license = "MIT";
    };
    questions = {
      package = "@mrclrchtr/supi-ask-user";
      version = "4.6.0";
      sourceRef = "98b80f6d";
      entryPath = "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts";
      license = "MIT";
    };
    codeIntelligence = {
      package = "@mrclrchtr/supi-code-intelligence";
      version = "4.6.0";
      sourceRef = "98b80f6d";
      entryPath = "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts";
      license = "MIT";
    };
    backgroundTasks = {
      package = "@99percentpeople/pi-background-tasks";
      version = "2.0.0";
      sourceRef = "0d231ab3";
      entryPath = "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts";
      license = "MIT";
    };
  };
  extensionRuntimeDependencies = {
    mcpClient = {
      package = "@modelcontextprotocol/client";
      version = "2.0.0";
      entryPath = "lib/node_modules/@modelcontextprotocol/client/dist/index.mjs";
    };
    mcpAdapter = {
      package = "pi-mcp-adapter";
      version = "2.20.1";
      sourceRef = "1dbdef96";
      entryPath = "lib/node_modules/pi-mcp-adapter/index.ts";
    };
    mcpServerSdk = {
      package = "@modelcontextprotocol/server";
      version = "2.0.0";
      entryPath = "lib/node_modules/@modelcontextprotocol/server/dist/index.mjs";
    };
    nodePty = {
      package = "node-pty";
      version = "1.2.0-beta.14";
      entryPath = "lib/node_modules/node-pty/lib/index.js";
    };
  };
  extensionManifest = final.writeText "pi-agent-extensions.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = upstream.version;
      loader = managedExtensionLoaderContract;
      extensionOrder = managedExtensionOrder;
      extensions = final.lib.mapAttrs (_logicalName: extension: {
        inherit (extension) version entryPath license;
      }) extensionInventory;
    }
  );
  extensionPatchProvenance = {
    bashTimeoutManagedDefault = {
      file = builtins.baseNameOf managedBashTimeoutPatch;
      package = "@mrclrchtr/supi-bash-timeout@4.6.0";
      task = "pi-agent-integration 4.6";
    };
    backgroundTasksManagedPipe = {
      file = builtins.baseNameOf managedBackgroundPipePatch;
      package = "@99percentpeople/pi-background-tasks@2.0.0";
      task = "pi-agent-integration 4.10";
    };
    backgroundTasksManagedPty = {
      file = builtins.baseNameOf managedBackgroundPtyPatch;
      package = "@99percentpeople/pi-background-tasks@2.0.0";
      task = "pi-agent-integration 4.11";
    };
    planModeCooperativeState = {
      file = builtins.baseNameOf cooperativePlanModePatch;
      package = "@narumitw/pi-plan-mode@0.49.2";
      task = "pi-agent-integration 4.3";
    };
    structuredQuestions = {
      file = builtins.baseNameOf structuredQuestionsPatch;
      package = "@mrclrchtr/supi-ask-user@4.6.0";
      task = "pi-agent-integration 4.7";
    };
    codeIntelligenceManagedLsp = {
      file = builtins.baseNameOf managedCodeIntelligencePatch;
      package = "@mrclrchtr/supi-code-intelligence@4.6.0";
      task = "pi-agent-integration 4.8";
    };
    codeIntelligenceManagedLspLifecycle = {
      file = builtins.baseNameOf managedCodeIntelligenceLifecyclePatch;
      package = "@mrclrchtr/supi-code-intelligence@4.6.0";
      task = "pi-agent-integration 4.9";
    };
    codeIntelligenceManagedLspConcurrency = {
      file = builtins.baseNameOf managedCodeIntelligenceConcurrencyPatch;
      package = "@mrclrchtr/supi-code-intelligence@4.6.0";
      task = "pi-agent-integration 4.9";
    };
    codeIntelligenceManagedLspOwnership = {
      file = builtins.baseNameOf managedCodeIntelligenceOwnershipPatch;
      package = "@mrclrchtr/supi-code-intelligence@4.6.0";
      task = "pi-agent-integration 4.9";
    };
    mcpAdapterManagedDirectTools = {
      file = builtins.baseNameOf managedMcpAdapterPatch;
      package = "pi-mcp-adapter@2.20.1";
      task = "pi-agent-integration 3.8";
    };
    mcpAdapterPrivateCache = {
      file = builtins.baseNameOf privateMcpCachePatch;
      package = "pi-mcp-adapter@2.20.1";
      task = "pi-agent-integration 3.9";
    };
    managedSubagents = {
      file = builtins.baseNameOf managedSubagentsPatch;
      package = "pi-subagents@0.40.0";
      task = "pi-agent-integration 4.1";
    };
    managedSubagentsLifecycle = {
      file = builtins.baseNameOf managedSubagentsLifecyclePatch;
      package = "pi-subagents@0.40.0";
      task = "pi-agent-integration 4.2";
    };
  };
  extensionProvenanceContract = {
    schemaVersion = 2;
    piVersion = upstream.version;
    loader = {
      inherit (managedExtensionLoaderContract) entryPath;
      kind = "regular-file";
    };
    extensionOrder = managedExtensionOrder;
    extensions = final.lib.mapAttrs (_logicalName: extension: {
      inherit (extension)
        package
        version
        sourceRef
        entryPath
        ;
      kind = "regular-file";
    }) extensionInventory;
    patches = extensionPatchProvenance;
    runtimeDependencies = extensionRuntimeDependencies;
  };
  extensionProvenanceRenderer = final.writeText "pi-agent-extension-provenance-renderer.mjs" ''
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";

    const contract = ${builtins.toJSON extensionProvenanceContract};
    const [packageRoot, identityRoot] = process.argv.slice(2);
    if (
      !packageRoot
      || !identityRoot
      || !path.isAbsolute(packageRoot)
      || !path.isAbsolute(identityRoot)
      || fs.realpathSync.native(packageRoot) !== packageRoot
    ) {
      throw new Error("extension package root is not canonical");
    }
    fs.mkdirSync(identityRoot, { recursive: true });
    if (fs.realpathSync.native(identityRoot) !== identityRoot || identityRoot === packageRoot) {
      throw new Error("extension identity root is not distinct and canonical");
    }

    function sha256(relativePath) {
      const segments = relativePath.split("/");
      let current = packageRoot;
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error("extension inventory path contains a symlink");
        if (index < segments.length - 1 && !stat.isDirectory()) {
          throw new Error("extension inventory path component is not a directory");
        }
        if (index === segments.length - 1 && !stat.isFile()) {
          throw new Error("extension inventory entry is not a regular file");
        }
      }
      return createHash("sha256").update(fs.readFileSync(current)).digest("hex");
    }

    const provenance = {
      ...contract,
      packageRoot,
      loader: {
        ...contract.loader,
        sha256: sha256(contract.loader.entryPath),
      },
      extensions: Object.fromEntries(contract.extensionOrder.map((logicalName) => {
        const extension = contract.extensions[logicalName];
        return [logicalName, {
          ...extension,
          sha256: sha256(extension.entryPath),
        }];
      })),
    };
    const rendered = JSON.stringify(provenance, null, 2) + "\n";
    for (const outputPath of [
      path.join(packageRoot, "share/pi-agent/extensions-provenance.json"),
      path.join(identityRoot, "extensions-provenance.json"),
    ]) {
      fs.writeFileSync(outputPath, rendered, { mode: 0o444 });
    }
  '';
in
{
  pi-agent = requireSupported (
    upstream.overrideAttrs (
      old:
      let
        patches = (old.patches or [ ]) ++ [
          undiciPatch
          contextRecoveryPatch
          piRuntimeBootstrapPatch
          piCavememEnvironmentBootstrapPatch
        ];
        postPatch = (old.postPatch or "") + ''
          cp ${piLock} package-lock.json
        '';
        npmDeps = final.fetchNpmDeps {
          inherit (old) src;
          inherit patches postPatch;
          hash = npmDepsHash;
        };
        contextRecoveryTests = upstream.overrideAttrs (_: {
          pname = "pi-agent-context-recovery-tests";
          inherit
            patches
            postPatch
            npmDepsHash
            npmDeps
            ;
          NO_COLOR = "1";
          buildPhase = ''
            runHook preBuild
            mkdir test-results

            if ! (
              cd packages/ai
              node ../../node_modules/vitest/dist/cli.js --run \
                test/openai-responses-terminal-event.test.ts \
                test/overflow.test.ts \
                --reporter=json \
                --outputFile=../../test-results/ai.json
            ) > test-results/ai.log 2>&1; then
              cat test-results/ai.log
              cat test-results/ai.json
              exit 1
            fi

            if ! (
              cd packages/coding-agent
              node ../../node_modules/vitest/dist/cli.js --run \
                test/assistant-message.test.ts \
                test/suite/agent-session-compaction.test.ts \
                test/suite/agent-session-retry-events.test.ts \
                --reporter=json \
                --outputFile=../../test-results/coding-agent.json
            ) > test-results/coding-agent.log 2>&1; then
              cat test-results/coding-agent.log
              cat test-results/coding-agent.json
              exit 1
            fi

            node ${contextRecoveryManifestRenderer} \
              ${contextRecoveryTestMetadata} \
              test-results/manifest.json \
              test-results/ai.json \
              test-results/coding-agent.json
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm444 test-results/manifest.json "$out/manifest.json"
            runHook postInstall
          '';
        });
      in
      {
        inherit
          patches
          postPatch
          npmDepsHash
          npmDeps
          ;
        passthru = (old.passthru or { }) // {
          tests = ((old.passthru or { }).tests or { }) // {
            context-recovery = contextRecoveryTests;
          };
        };
        meta = (old.meta or { }) // {
          platforms = [ supportedSystem ];
        };
      }
    )
  );

  pi-agent-reconcile = requireSupported (
    final.callPackage ../../scripts/pi-agent-reconcile.nix {
      inherit (final) pi-agent;
    }
  );

  pi-agent-extensions = requireSupported (
    final.buildNpmPackage {
      pname = "pi-agent-extensions";
      inherit (upstream) version;
      __structuredAttrs = true;
      outputs = [
        "out"
        "identity"
      ];
      # The identity JSON embeds $out; $out retains the identity output in its closure.
      unsafeDiscardReferences.identity = true;
      src = extensionRoot;
      npmDepsHash = extensionNpmDepsHash;
      dontNpmBuild = true;

      installPhase = ''
        runHook preInstall

        install -Dm444 ${managedSubagentPolicy} node_modules/pi-subagents/src/managed-policy.ts
        install -Dm444 ${managedSubagentReader} node_modules/pi-subagents/managed-agents/reader.md
        install -Dm444 ${managedSubagentWorker} node_modules/pi-subagents/managed-agents/worker.md
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/pi-subagents -p1 \
          < ${managedSubagentsPatch}
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/pi-subagents -p1 \
          < ${managedSubagentsLifecyclePatch}
        substituteInPlace node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts \
          --replace-fail 'chainDir: params.chainDir ?? getProjectChainRunsDir(effectiveCwd),' \
          'chainDir: path.join(path.dirname(sessionRoot), "chain-runs"),'
        install -m444 managed-plan-mode.ts.in \
          node_modules/@narumitw/pi-plan-mode/src/managed-plan-mode.ts
        patch --no-backup-if-mismatch -d node_modules/@narumitw/pi-plan-mode -p1 < ${cooperativePlanModePatch}
        patch --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-bash-timeout -p1 \
          < ${managedBashTimeoutPatch}
        patch --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-ask-user -p1 \
          < ${structuredQuestionsPatch}
        install -m444 ${managedBackgroundEnvironmentModule} \
          node_modules/@99percentpeople/pi-background-tasks/dist/managed-environment.ts
        patch --no-backup-if-mismatch -d node_modules/@99percentpeople/pi-background-tasks -p1 \
          < ${managedBackgroundPipePatch}
        patch --no-backup-if-mismatch -d node_modules/@99percentpeople/pi-background-tasks -p1 \
          < ${managedBackgroundPtyPatch}
        install -m444 ${managedBackgroundEnvironmentModule} \
          node_modules/@mrclrchtr/supi-code-intelligence/node_modules/@mrclrchtr/supi-lsp/src/client/managed-environment.ts
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-code-intelligence -p1 \
          < ${managedCodeIntelligencePatch}
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-code-intelligence -p1 \
          < ${managedCodeIntelligenceLifecyclePatch}
        substituteInPlace \
          node_modules/@mrclrchtr/supi-code-intelligence/node_modules/@mrclrchtr/supi-lsp/src/manager/manager.ts \
          --replace-fail \
          '      // Ignore shutdown failures when forcing a restart.' \
          '      return false;'
        substituteInPlace \
          node_modules/@mrclrchtr/supi-code-intelligence/src/substrate/workspace-provider-host.ts \
          --replace-fail \
          '...(this.#lsp ? [settleWithin(this.#lsp.shutdown())] : []),' \
          '...(this.#lsp ? [this.#lsp.shutdown()] : []),'
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-code-intelligence -p1 \
          < ${managedCodeIntelligenceConcurrencyPatch}
        substituteInPlace \
          node_modules/@mrclrchtr/supi-code-intelligence/src/substrate/lsp/lifecycle.ts \
          --replace-fail \
          $'const READINESS_POLL_MS = 2_000;\n\n/** Acquire providers once per workspace and release them after the final Pi session ends. */' \
          $'const READINESS_POLL_MS = 2_000;\n\nexport interface LspSessionLifecycleDependencies {\n  readonly acquireWorkspaceProviderHost?: typeof acquireWorkspaceProviderHost;\n}\n\n/** Acquire providers once per workspace and release them after the final Pi session ends. */' \
          --replace-fail \
          $'  onStarted?: (ctx: ExtensionContext) => void | Promise<void>,\n): void {\n  let readinessTimer' \
          $'  onStarted?: (ctx: ExtensionContext) => void | Promise<void>,\n  dependencies: LspSessionLifecycleDependencies = {},\n): void {\n  const acquireProviderHost = dependencies.acquireWorkspaceProviderHost ?? acquireWorkspaceProviderHost;\n  let readinessTimer'
        substituteInPlace \
          node_modules/@mrclrchtr/supi-code-intelligence/src/substrate/workspace-provider-host.ts \
          --replace-fail \
          $'  constructor(cwd: string) {\n    this.cwd = cwd;\n  }' \
          $'  constructor(\n    cwd: string,\n    private readonly dependencies: ResolvedDependencies,\n  ) {\n    this.cwd = cwd;\n  }' \
          --replace-fail \
          '? scanWorkspaceSentinels(this.cwd)' \
          '? this.dependencies.scanSentinels(this.cwd)' \
          --replace-fail \
          'const runtime = getDefaultWorkspaceRuntime();' \
          'const runtime = this.dependencies.getRuntime();' \
          --replace-fail \
          'this.#tree = new TreeSitterRuntimeController(this.cwd, runtime);' \
          'this.#tree = this.dependencies.createTreeController(this.cwd, runtime);' \
          --replace-fail \
          'this.#lsp = new LspRuntimeController(this.cwd, runtime);' \
          'this.#lsp = this.dependencies.createLspController(this.cwd, runtime);'
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/@mrclrchtr/supi-code-intelligence -p1 \
          < ${managedCodeIntelligenceOwnershipPatch}
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/pi-mcp-adapter -p1 \
          < ${managedMcpAdapterPatch}
        patch --fuzz=0 --no-backup-if-mismatch -d node_modules/pi-mcp-adapter -p1 \
          < ${privateMcpCachePatch}
        typecheckDir=$(mktemp -d)
        ln -s "$PWD/node_modules/@mrclrchtr/supi-ask-user" "$typecheckDir/ask-user"
        ln -s "$PWD/node_modules/@99percentpeople/pi-background-tasks" "$typecheckDir/background-tasks"
        ln -s "$PWD/node_modules/@99percentpeople/pi-shared-settings" "$typecheckDir/shared-settings"
        ln -s "$PWD/node_modules/node-pty" "$typecheckDir/node-pty"
        ln -s "$PWD/node_modules/@mrclrchtr/supi-bash-timeout" "$typecheckDir/bash-timeout"
        ln -s "$PWD/node_modules/@mrclrchtr/supi-code-intelligence" "$typecheckDir/code-intelligence"
        install -Dm444 ${cavememBridgeSource} "$typecheckDir/cavemem/index.ts"
        install -Dm444 ${./extensions/cavemem/package.json} "$typecheckDir/cavemem/package.json"
        install -Dm444 ${managedExtensionLoaderSource} "$typecheckDir/managed-loader.ts"
        install -Dm444 ${managedExtensionManifestSource} "$typecheckDir/managed-manifest.ts"
        install -Dm444 ${managedExtensionTypecheckPackage} "$typecheckDir/package.json"
        install -Dm444 ${./extensions/mcpproxy/index.ts} "$typecheckDir/mcpproxy/index.ts"
        install -Dm444 ${./extensions/mcpproxy/package.json} "$typecheckDir/mcpproxy/package.json"
        ln -s "$PWD/node_modules/pi-mcp-adapter" "$typecheckDir/pi-mcp-adapter"
        ln -s "$PWD/node_modules/pi-subagents" "$typecheckDir/pi-subagents"
        ln -s "$PWD/node_modules" "$typecheckDir/node_modules"
        ln -s "$PWD/node_modules/@narumitw/pi-plan-mode" "$typecheckDir/plan-mode"
        ln -s "$PWD/node_modules/@narumitw/pi-tui-kit" "$typecheckDir/pi-tui-kit"
        ln -s "$PWD/node_modules/typebox" "$typecheckDir/typebox"
        install -Dm444 ${extensionTypecheckConfig} "$typecheckDir/tsconfig.json"
        install -Dm444 ${backgroundTypecheckConfig} "$typecheckDir/background-typecheck.json"
        backgroundDiagnostics="$typecheckDir/background-diagnostics.txt"
        if ${final.nodejs}/bin/node \
          ${final.pi-agent}/lib/node_modules/typescript/bin/tsc \
          --pretty false \
          --project "$typecheckDir/background-typecheck.json" \
          > "$backgroundDiagnostics" 2>&1; then
          backgroundTypecheckStatus=0
        else
          backgroundTypecheckStatus=$?
        fi
        ${final.nodejs}/bin/node ${backgroundTypecheckRenderer} \
          "$backgroundDiagnostics" "$backgroundTypecheckStatus"
        ${final.nodejs}/bin/node \
          ${final.pi-agent}/lib/node_modules/typescript/bin/tsc \
          --project "$typecheckDir/tsconfig.json"

        piRuntime=$(find node_modules -type d \( \
          -path 'node_modules/@earendil-works/pi-*' -o \
          -path '*/node_modules/@earendil-works/pi-*' \
        \) -print -quit)
        if [ -n "$piRuntime" ]; then
          echo "nested Pi runtime found: $piRuntime" >&2
          exit 1
        fi

        test -f node_modules/node-pty/prebuilds/darwin-arm64/pty.node
        test -x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
        rm -rf node_modules/.bin

        mkdir -p "$out/lib/node_modules" "$identity"
        cp -R node_modules/. "$out/lib/node_modules/"
        install -Dm444 ${cavememBridgeSource} "$out/lib/pi-agent/extensions/cavemem/index.ts"
        install -Dm444 ${./extensions/cavemem/package.json} \
          "$out/lib/pi-agent/extensions/cavemem/package.json"
        install -Dm444 ${./extensions/mcpproxy/index.ts} \
          "$out/lib/pi-agent/extensions/mcpproxy/index.ts"
        install -Dm444 ${./extensions/mcpproxy/package.json} \
          "$out/lib/pi-agent/extensions/mcpproxy/package.json"
        install -Dm444 ${managedExtensionLoaderSource} \
          "$out/lib/pi-agent/extensions/managed-loader.ts"
        install -Dm444 ${managedExtensionManifestSource} \
          "$out/lib/pi-agent/extensions/managed-manifest.ts"
        for managedSource in \
          "$out/lib/pi-agent/extensions/managed-loader.ts" \
          "$out/lib/pi-agent/extensions/managed-manifest.ts"; do
          substituteInPlace "$managedSource" \
            --replace-fail '${trustedIdentityPlaceholder}' "$identity/extensions-provenance.json"
        done

        install -Dm444 ${extensionManifest} "$out/share/pi-agent/extensions.json"
        install -Dm444 ${managedSubagentCatalog} "$out/share/pi-agent/subagents.json"
        install -Dm444 package.json "$out/share/pi-agent/extensions-package.json"
        install -Dm444 package-lock.json "$out/share/pi-agent/extensions-package-lock.json"

        install -Dm444 node_modules/pi-mcp-adapter/LICENSE \
          "$out/share/licenses/pi-agent-extensions/mcpAdapter/LICENSE"
        install -Dm444 ${./extensions/licenses/repository-LICENSE} \
          "$out/share/licenses/pi-agent-extensions/cavemem/LICENSE"
        install -Dm444 ${./extensions/licenses/repository-LICENSE} \
          "$out/share/licenses/pi-agent-extensions/mcp/LICENSE"
        install -Dm444 node_modules/@modelcontextprotocol/client/LICENSE \
          "$out/share/licenses/pi-agent-extensions/mcpClient/LICENSE"
        install -Dm444 node_modules/@modelcontextprotocol/server/LICENSE \
          "$out/share/licenses/pi-agent-extensions/mcpServerSdk/LICENSE"
        install -Dm444 node_modules/pi-subagents/LICENSE \
          "$out/share/licenses/pi-agent-extensions/subagents/LICENSE"
        install -Dm444 node_modules/@narumitw/pi-plan-mode/LICENSE \
          "$out/share/licenses/pi-agent-extensions/plan/LICENSE"
        install -Dm444 node_modules/@narumitw/pi-stamp/LICENSE \
          "$out/share/licenses/pi-agent-extensions/timestamps/LICENSE"
        install -Dm444 licenses/supi-LICENSE \
          "$out/share/licenses/pi-agent-extensions/bashTimeout/LICENSE"
        install -Dm444 licenses/supi-LICENSE \
          "$out/share/licenses/pi-agent-extensions/questions/LICENSE"
        install -Dm444 licenses/supi-LICENSE \
          "$out/share/licenses/pi-agent-extensions/codeIntelligence/LICENSE"
        install -Dm444 node_modules/@99percentpeople/pi-background-tasks/LICENSE \
          "$out/share/licenses/pi-agent-extensions/backgroundTasks/LICENSE"
        install -Dm444 node_modules/node-pty/LICENSE \
          "$out/share/licenses/pi-agent-extensions/nodePty/LICENSE"

        runHook postInstall
      '';

      postFixup = ''
        ${final.nodejs}/bin/node ${extensionProvenanceRenderer} "$out" "$identity"
      '';

      passthru = {
        manifest = extensionManifest;
        identityFile = "extensions-provenance.json";
        provenancePath = "share/pi-agent/extensions-provenance.json";
        inherit backgroundTypecheckConfig;
        typecheckConfig = extensionTypecheckConfig;
      };
      meta = {
        description = "Fixed public extension closure for the managed Pi agent";
        license = final.lib.licenses.mit;
        platforms = [ supportedSystem ];
      };
    }
  );
}
