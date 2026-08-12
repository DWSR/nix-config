{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystem = "aarch64-darwin";
  credentialPolicy = import ../../home-manager/common/pi-agent/credential-policy.nix {
    lib = final.lib;
    pkgs = final;
  };
  requireSupported =
    value: if system == supportedSystem then value else throw "pi-agent supports only aarch64-darwin";
  upstream = requireSupported inputs.pi-nix.packages.${system}.coding-agent;
  contextRecoveryCommit = "32850ef7c5edff7a6eee0214516fbb7382bf292d";
  contextRecoveryParent = "e56893f4cd6545ab1498b72ae4e1e2241a0926f4";
  contextRecoveryPatch = ./pi-context-recovery.patch;
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
  extensionNpmDepsHash = "sha256-wE7PBb/d2x9ueJ7X7S2Ju3xugHM6NNHsAkHI0u9c3ak=";
  cooperativePlanModePatch = ./extensions/patches/pi-plan-mode-cooperative-state.patch;
  managedBashTimeoutPatch = ./extensions/patches/supi-bash-timeout-managed-default.patch;
  structuredQuestionsPatch = ./extensions/patches/supi-ask-user-structured-results.patch;
  managedBackgroundPipePatch = ./extensions/patches/pi-background-tasks-managed-pipe.patch;
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
  planModeTypecheckConfig = final.writeText "pi-plan-mode-tsconfig.json" (
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
          "@earendil-works/pi-coding-agent" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-coding-agent/index.d.ts"
          ];
          "@earendil-works/pi-tui" = [
            "${final.pi-agent}/lib/node_modules/@earendil-works/pi-tui/index.d.ts"
          ];
          "@narumitw/pi-tui-kit" = [ "pi-tui-kit/dist/index.d.ts" ];
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
        "plan-mode/src/index.ts"
      ];
    }
  );
  extensionInventory = {
    mcp = {
      package = "pi-mcp-adapter";
      version = "2.20.1";
      sourceRef = "1dbdef96";
      entryPath = "lib/node_modules/pi-mcp-adapter/index.ts";
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
      extensions = final.lib.mapAttrs (_logicalName: extension: {
        inherit (extension) version entryPath license;
      }) extensionInventory;
    }
  );
  extensionProvenance = final.writeText "pi-agent-extensions-provenance.json" (
    builtins.toJSON {
      schemaVersion = 1;
      extensions = final.lib.mapAttrs (_logicalName: extension: {
        inherit (extension) package version sourceRef;
      }) extensionInventory;
      patches = {
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
      };
      runtimeDependencies = extensionRuntimeDependencies;
    }
  );
in
{
  pi-agent = requireSupported (
    upstream.overrideAttrs (
      old:
      let
        patches = (old.patches or [ ]) ++ [
          undiciPatch
          contextRecoveryPatch
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
      src = extensionRoot;
      npmDepsHash = extensionNpmDepsHash;
      dontNpmBuild = true;

      installPhase = ''
        runHook preInstall

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

        typecheckDir=$(mktemp -d)
        ln -s "$PWD/node_modules/@mrclrchtr/supi-ask-user" "$typecheckDir/ask-user"
        ln -s "$PWD/node_modules/@99percentpeople/pi-background-tasks" "$typecheckDir/background-tasks"
        ln -s "$PWD/node_modules/@mrclrchtr/supi-bash-timeout" "$typecheckDir/bash-timeout"
        ln -s "$PWD/node_modules/@narumitw/pi-plan-mode" "$typecheckDir/plan-mode"
        ln -s "$PWD/node_modules/@narumitw/pi-tui-kit" "$typecheckDir/pi-tui-kit"
        ln -s "$PWD/node_modules/typebox" "$typecheckDir/typebox"
        install -Dm444 ${planModeTypecheckConfig} "$typecheckDir/tsconfig.json"
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

        mkdir -p "$out/lib/node_modules"
        cp -R node_modules/. "$out/lib/node_modules/"

        install -Dm444 ${extensionManifest} "$out/share/pi-agent/extensions.json"
        install -Dm444 ${extensionProvenance} "$out/share/pi-agent/extensions-provenance.json"
        install -Dm444 package.json "$out/share/pi-agent/extensions-package.json"
        install -Dm444 package-lock.json "$out/share/pi-agent/extensions-package-lock.json"

        install -Dm444 node_modules/pi-mcp-adapter/LICENSE \
          "$out/share/licenses/pi-agent-extensions/mcp/LICENSE"
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

      passthru = {
        manifest = extensionManifest;
        provenance = extensionProvenance;
        typecheckConfig = planModeTypecheckConfig;
      };
      meta = {
        description = "Fixed public extension closure for the managed Pi agent";
        license = final.lib.licenses.mit;
        platforms = [ supportedSystem ];
      };
    }
  );
}
