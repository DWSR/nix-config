import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-common-integration-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
    in
      import (source + "/tests/pi-agent/fixtures/common-integration.nix") {
        repoRoot = source;
        fixture = ${JSON.stringify(fixture)};
      }
  `;
}

function evaluate(fixture) {
  const result = childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixture)],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("enabled common module exposes the complete immutable managed surface", () => {
  const result = evaluate("enabled");
  const { config } = result;

  assert.equal(config.enable, true);
  assert.deepEqual(result.common, { ezaEnabled: true, atuinInstalled: true });
  assert.match(config.package, /^\/nix\/store\//);
  assert.match(config.managedConfig, /^\/nix\/store\//);
  assert.match(config.projectionFactory, /^\/nix\/store\//);
  assert.match(config.sandboxCatalog, /^\/nix\/store\//);
  assert.match(config.guidancePackage, /^\/nix\/store\//);
  assert.match(config.credentialRuntimeModule, /^\/nix\/store\//);
  assert.match(config.extensionManifest, /^\/nix\/store\/[^/]+\/share\/pi-agent\/extensions\.json$/);
  assert.match(config.extensionIdentity, /^\/nix\/store\/[^/]+\/extensions-provenance\.json$/);
  assert.equal(config.instructionResources.length, 2);
  assert.match(config.instructionResources[0], /^\/nix\/store\/[^/]+\/share\/pi-agent\/instructions\.md$/);
  assert.match(config.instructionResources[1], /^\/nix\/store\/[^/]+\/share\/pi-agent\/guide\.md$/);
  const artifactNames = [
    "credentialResolver",
    "launcher",
    "managedCommand",
    "managedShell",
    "managedStatusCommand",
    "managedValidatorCommand",
    "reconciler",
    "sandboxExecutor",
    "sandboxResolver",
    "status",
    "validator",
  ];
  for (const name of artifactNames) {
    assert.match(result.artifacts[name], /^\/nix\/store\//, `${name} was not forced`);
  }
  assert.match(result.artifacts.managedShell, /^\/nix\/store\/[^/]+-pi-agent-shell-[^/]+$/);
  assert.deepEqual(result.artifacts.resolverPlans, [{ kind: "pi-auth" }]);
  assert.deepEqual(Object.keys(config.profilePaths).sort(), [
    "pi-audit",
    "pi-managed",
    "pi-review",
  ]);
  assert.ok(Object.values(config.profilePaths).every((value) =>
    /^\/nix\/store\/[^/]+\/share\/pi-agent\/nono\/profiles\/pi-(?:audit|managed|review)\.json$/.test(value),
  ));
  assert.deepEqual(config.commands, [
    "pi",
    "pi-agent-status",
    "pi-agent-validate",
    "pi-agent-reconcile",
  ]);
  assert.deepEqual(config.statusInputs, {
    agentDir: "/tmp/pi-agent-integration/.pi/agent",
    cavememDataDir: "/tmp/pi-agent-integration/cavemem",
    extensionManifest: config.extensionManifest,
    extensionIdentity: config.extensionIdentity,
    managedConfig: config.managedConfig,
  });

  assert.equal(result.activation.some((name) => /pi-agent|cavemem/i.test(name)), false);
  assert.equal(result.files.some((name) => /\/(?:pi-agent|pi-coding-agent|pi-agent-extensions|cavemem)(?:\/|$)/i.test(name)), false);
  assert.ok(result.packages.includes("pi-agent-launcher"));
  assert.ok(result.packages.includes("pi-agent-status"));
  assert.ok(result.packages.includes("pi-agent-validate"));
  assert.ok(result.packages.includes("pi-agent-reconcile"));
  assert.equal(result.packages.some((name) => /pi-coding-agent|pi-agent-extensions/.test(name)), false);

  const managedConfig = fs.readFileSync(config.managedConfig, "utf8");
  assert.doesNotMatch(managedConfig, /task-6-2|SHOPIFY_PI_TOKEN=.*[^$]|PI_AGENT_LAUNCH_ID=.*[^$]/);
  const managedConfigValue = JSON.parse(managedConfig);
  assert.equal(managedConfigValue.settings.shellPath, `${result.artifacts.managedShell}/bin/pi-agent-shell`);
  assert.equal(managedConfigValue.timeouts.bashDefaultMs, 120000);
  assert.equal(managedConfigValue.extensionManifest, config.extensionManifest);
  assert.deepEqual(managedConfigValue.instructionResources, config.instructionResources);
});

test("Shopify common integration uses the trusted package-backed devx resolver path", () => {
  const result = evaluate("shopify");
  const plans = result.artifacts.resolverPlans;

  assert.deepEqual(plans.map(({ kind }) => kind), [
    "shopify-gateway-token",
    "shopify-gateway-base",
  ]);
  assert.ok(plans.every(({ executable }) => /^\/nix\/store\/[^/]+\/bin\/devx$/.test(executable)));
});

test("disabled common module emits no Pi commands, resources, or mutable activation", () => {
  const result = evaluate("disabled");
  const { config } = result;

  assert.equal(config.enable, false);
  assert.deepEqual(result.common, { ezaEnabled: true, atuinInstalled: true });
  assert.match(config.package, /^\/nix\/store\//);
  assert.equal(config.managedConfig, null);
  assert.equal(config.projectionFactory, null);
  assert.equal(config.sandboxCatalog, null);
  assert.equal(config.guidancePackage, null);
  assert.equal(config.credentialRuntimeModule, null);
  assert.equal(config.extensionManifest, null);
  assert.equal(config.extensionIdentity, null);
  assert.deepEqual(config.instructionResources, []);
  assert.deepEqual(config.profilePaths, { });
  assert.deepEqual(config.commands, []);
  assert.deepEqual(result.artifacts, {
    credentialResolver: null,
    launcher: null,
    managedCommand: null,
    managedCommandSource: null,
    managedShell: null,
    managedStatusCommand: null,
    managedValidatorCommand: null,
    reconciler: null,
    resolverPlans: [],
    sandboxExecutor: null,
    sandboxResolver: null,
    status: null,
    validator: null,
  });
  assert.equal(result.packages.some((name) => /pi-agent|pi-coding-agent/.test(name)), false);
  assert.equal(result.files.some((name) => /\/(?:pi-agent|pi-coding-agent|pi-agent-extensions|cavemem)(?:\/|$)/i.test(name)), false);
  assert.equal(result.activation.some((name) => /pi-agent|cavemem/i.test(name)), false);
});

test("managed wrapper reports value-free launcher component and recovery diagnostics", () => {
  const result = evaluate("enabled");
  const agentDir = result.config.statusInputs.agentDir;
  const cavememDataDir = result.config.statusInputs.cavememDataDir;
  const secret = "task-6-2-launch-secret";

  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cavememDataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{invalid:\n", { mode: 0o600 });

  try {
    const launch = childProcess.spawnSync(
      path.join(result.artifacts.managedCommand, "bin/pi"),
      ["--print", secret],
      {
        ...commandOptions,
        env: {
          ...process.env,
          PI_NONO: "disabled",
          PI_NONO_PROFILE: "",
          PI_NONO_LISTEN_PORTS: "",
          SHOPIFY_PI_TOKEN: secret,
        },
      },
    );

    assert.equal(launch.status, 1, launch.stderr);
    assert.match(
      launch.stderr,
      /Managed launch failed: state\. Recovery: repair managed Pi state and rerun reconciliation\./,
    );
    assert.doesNotMatch(launch.stderr, new RegExp(secret));
    assert.doesNotMatch(launch.stderr, /node:internal|\bat /);
  } finally {
    fs.rmSync(path.resolve(agentDir, "../.."), { recursive: true, force: true });
  }
});
