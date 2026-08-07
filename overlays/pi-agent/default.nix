{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystem = "aarch64-darwin";
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
  manifest = final.writeText "pi-agent-extensions.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = upstream.version;
      extensions = { };
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

  pi-agent-extensions = requireSupported (
    final.runCommand "pi-agent-extensions-${upstream.version}-placeholder"
      {
        passthru = { inherit manifest; };
        meta = {
          description = "Managed Pi extension package placeholder";
          platforms = [ supportedSystem ];
        };
      }
      ''
        install -Dm444 ${manifest} "$out/share/pi-agent/extensions.json"
      ''
  );
}
