import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixturePath = path.join(
  testsDir,
  "fixtures/credential-integration/runtime-probe.mjs",
);
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

let runtimePaths;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-credential-integration-tests";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      lsp = import (source + "/tests/pi-agent/fixtures/code-intelligence.nix") { repoRoot = source; };
      host = import (source + "/tests/pi-agent/fixtures/shopify-host.nix") {
        fixture = "shopify";
        repoRoot = source;
      };
      credential = import (source + "/tests/pi-agent/fixtures/credential-policy.nix") {
        fixture = "shopify-runtime-module";
        repoRoot = source;
      };
      statusFixtures = import (source + "/tests/pi-agent/fixtures/status.nix") {
        fixture = "packages";
        repoRoot = source;
      };
      validatorFixtures = import (source + "/tests/pi-agent/fixtures/validator.nix") {
        fixture = "packages";
        repoRoot = source;
      };
      policy = import (source + "/home-manager/common/pi-agent/credential-policy.nix") {
        inherit pkgs;
        inherit (pkgs) lib;
      };
      personalCredential = import (source + "/tests/pi-agent/fixtures/credential-policy.nix") {
        fixture = "personal-runtime-module";
        repoRoot = source;
      };
      profile = pkgs.runCommand "pi-agent-task-7-5-profile" { }
        ("mkdir -p $out; cp " + host.profilePaths."pi-managed" + " $out/pi-managed.json");
    in ${body}
  `;
}

function buildRuntimePaths() {
  if (runtimePaths) return runtimePaths;
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      filteredFlakeExpression(`[
        pkgs.pi-agent
        pkgs.pi-agent-extensions
        policy.managedShell
        pkgs.cavemem
        pkgs.nono
        lsp.validServer
        credential
        personalCredential
        statusFixtures
        validatorFixtures
        profile
        pkgs.sqlite
      ]`),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n").filter(Boolean);
  const credentialPolicies = outputs.filter((output) => fs.existsSync(path.join(output, "lib/pi-agent/credential-policy.mjs")));
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, "share/pi-agent/extensions.json"))),
    shell: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi-agent-shell"))),
    cavemem: outputs.find((output) => fs.existsSync(path.join(output, "bin/cavemem"))),
    nono: outputs.find((output) => fs.existsSync(path.join(output, "bin/nono"))),
    lsp: outputs.find((output) => fs.existsSync(path.join(output, "bin/typescript-language-server"))),
    credentialPolicy: credentialPolicies[0],
    personalCredentialPolicy: credentialPolicies[1],
    sqlite: outputs.find((output) => fs.existsSync(path.join(output, "bin/sqlite3"))),
    statusFixtures: outputs.find((output) => fs.existsSync(path.join(output, "production/bin/pi-agent-status"))),
    validatorFixtures: outputs.find((output) => fs.existsSync(path.join(output, "healthy/bin/pi-agent-validate"))),
    profile: undefined,
  };
  const profileRoot = outputs.find((output) => fs.existsSync(path.join(output, "pi-managed.json")));
  runtimePaths.profile = profileRoot ? path.join(profileRoot, "pi-managed.json") : undefined;
  runtimePaths.status = path.join(runtimePaths.statusFixtures, "production");
  runtimePaths.validator = path.join(runtimePaths.validatorFixtures, "healthy");
  for (const [name, output] of Object.entries(runtimePaths)) {
    assert.match(output ?? "", /^\/nix\/store\//, `missing ${name} runtime output`);
  }
  return runtimePaths;
}

test("Task 7.5 keeps provider credentials inside root and foreground child Pi", () => {
  const runtime = buildRuntimePaths();
  const result = childProcess.spawnSync(
    process.execPath,
    [
      fixturePath,
      runtime.pi,
      runtime.extensions,
      runtime.shell,
      runtime.cavemem,
      runtime.nono,
      runtime.profile,
      runtime.lsp,
      runtime.status,
      runtime.validator,
      runtime.credentialPolicy,
      runtime.personalCredentialPolicy,
      runtime.sqlite,
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));

  assert.deepEqual(report.provider, {
    root: "succeeded",
    foregroundChild: "succeeded",
    requestModes: ["cancellation", "error", "normal", "timeout"],
    requestBodiesSentinelFree: true,
  });
  assert.deepEqual(report.nonProviderProbes, {
    bash: "sentinel-free",
    backgroundPipe: "sentinel-free",
    backgroundPty: "sentinel-free",
    lsp: "sentinel-free",
    cavememHook: "sentinel-free",
    cavememWorker: "sentinel-free",
    status: "sentinel-free",
    validator: "sentinel-free",
  });
  assert.deepEqual(report.paths, {
    normal: "completed",
    error: "rejected-without-sentinel",
    timeout: "timed-out",
    cancellation: "cancelled",
    shutdown: "completed",
  });
  assert.deepEqual(report.personalProvider, {
    mode: "personal",
    rootCredentialNames: [],
    foregroundChildCredentialNames: [],
    authSource: "stored credential",
    authIsolated: true,
    noShopifyCredentialInheritance: true,
  });
  assert.deepEqual(report.cavememCapture, {
    success: "redacted",
    failure: "redacted",
    persistedRows: "sentinel-free",
    hookEnvironment: "sentinel-free",
    workerEnvironment: "sentinel-free",
  });
  assert.equal(report.scan.failed, false);
  assert.equal(report.scan.logs, true);
  assert.equal(report.scan.temporaryFiles, true);
  assert.equal(report.scan.piSessions, true);
  assert.equal(report.scan.report, true);
  assert.equal(report.scan.cavememRows, true);
  assert.equal(report.scan.nonoAudit, true);
  assert.equal(report.probes.cavememWorkerStarted, true);
  assert.equal(report.probes.cavememHookEnvironmentTripwire, true);
  assert.equal(report.probes.cavememWorkerEnvironmentTripwire, true);
  assert.equal(report.probes.statusEnvironmentTripwire, true);
  assert.equal(report.probes.validatorEnvironmentTripwire, true);
  assert.equal(report.probes.backgroundPipeEvidence, true);
  assert.equal(report.probes.backgroundPtyEvidence, true);
  assert.equal(report.probes.integratedLspStarted, true);
  assert.equal(report.probes.lspGroupGone, true);
  assert.equal(report.probes.lspDescendantGone, true);
  assert.equal(report.cleanup.processes, true);
  assert.equal(report.cleanup.failureSafe, true);
  assert.equal(report.cleanup.temporaryRoots, true);
});
