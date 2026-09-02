import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/validator.nix";
const validatorExecutable = "bin/pi-agent-validate";
const validatorModule = "lib/pi-agent/validate.mjs";
const generation = "task-5.7-validator-v1";
const providerSentinel = "task-5-7-provider-sentinel";
const launchSentinel = "a57aa57a-5a57-457a-857a-a57aa57aa57a";
const openAiSentinel = "task-5-7-openai-sentinel";
const adminSentinel = "task-5-7-mcpproxy-admin-sentinel";
const selectionCollisionCases = [
  {
    name: "state equality",
    sensitiveValue: "disabled",
    selection: { PI_NONO: "disabled" },
  },
  {
    name: "profile containment",
    sensitiveValue: "review",
    selection: { PI_NONO: "enforced", PI_NONO_PROFILE: "pi-review" },
  },
  {
    name: "listen-port containment",
    sensitiveValue: "80",
    selection: { PI_NONO_LISTEN_PORTS: "8080" },
  },
];
const emptySelectionControls = [
  "PI_NONO",
  "PI_NONO_PROFILE",
  "PI_NONO_LISTEN_PORTS",
];
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};

const evidence = Object.freeze({
  package: [
    "package-contract:v1",
    "pi:0.83.0",
    "undici:8.9.0",
    "context-recovery:v1",
  ],
  json: ["status-command:v1", "managed-json:v1"],
  ownership: ["status-command:v1", "ownership-state:v1"],
  profiles: [
    "profile-catalog:v1",
    "nono:0.69.0",
    "profiles:pi-audit,pi-managed,pi-review",
  ],
  extensions: [
    "extension-provenance:v2",
    "extension-order:v1",
    "extensions:backgroundTasks@2.0.0,bashTimeout@4.6.0,cavemem@0.1.0,codeIntelligence@4.6.0,mcp@0.1.0,plan@0.49.2,questions@4.6.0,subagents@0.40.0,timestamps@0.49.3",
  ],
  mcp: ["mcp-preflight:v1", "transport:/mcp", "direct-tools:v1"],
  cavemem: ["cavemem-worker-status:v1"],
  pty: ["node-pty:1.2.0-beta.14", "darwin-arm64-prebuild:v1"],
  lsp: ["lsp-inventory:v1"],
  drift: ["reconciliation-drift:v1"],
  seatbelt: ["sandbox-host-probe:v1", "nono:0.69.0"],
});

const recovery = Object.freeze({
  package:
    "rebuild the managed generation or reactivate the previous generation",
  json: "repair settings.json and models.json, then rerun reconciliation",
  ownership:
    "repair or remove invalid ownership state, then rerun reconciliation",
  profiles:
    "use PI_NONO=disabled, audit, or enforced; select pi-audit, pi-managed, or pi-review; use canonical comma-separated listen ports; use PI_NONO=disabled pi for one-launch rollback",
  extensions:
    "update the pinned extension set, rebuild pi-agent-extensions, and reactivate the generation",
  mcp: "restart mcpproxy or repair the declared upstream",
  cavemem: "restart the Cavemem worker and verify the managed data directory",
  pty: "rebuild pi-agent-extensions with the Darwin ARM node-pty prebuild",
  lsp: "rebuild the configured language server and activate the managed generation",
  drift: "repair managed Pi state and rerun reconciliation",
  seatbelt:
    "run validation on an unsandboxed macOS host; select a valid profile or use PI_NONO=disabled pi for rollback",
  provider:
    "configure Pi authentication or the Shopify gateway provider, then rerun validation",
});

const defaultStatuses = Object.freeze({
  package: "pass",
  json: "pass",
  ownership: "pass",
  profiles: "pass",
  extensions: "pass",
  mcp: "pass",
  cavemem: "pass",
  pty: "pass",
  lsp: "pass",
  drift: "pass",
  seatbelt: "manual-required",
  provider: "pass",
});

let fixtureRoot;
let packages;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-validator-tests";
        filter = sourcePath: type:
          let base = builtins.baseNameOf sourcePath;
          in base != ".git" && base != "result";
      };
    in
      import (source + "/${fixtureRelativePath}") {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = source;
      }
  `;
}

function buildFixture(fixture) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression(fixture),
    ],
    { ...commandOptions, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1, result.stdout);
  return outputs[0];
}

before(
  async () => {
    fixtureRoot = buildFixture("packages");
    packages = Object.fromEntries(
      [
        "healthy",
        "component-failure",
        "drift",
        "manual-gate",
        "hostile-status",
        "production-artifacts",
      ].map((name) => [name, path.join(fixtureRoot, name)]),
    );
    const module = await import(
      pathToFileURL(path.join(packages.healthy, validatorModule))
    );
    assert.deepEqual(Object.keys(module), [
      "runRuntimeCompatibilityValidatorCli",
    ]);
  },
  { timeout: 600_000 },
);

function createState(t, suffix = "state") {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-agent-validator-${suffix}-`),
  );
  const agentDir = path.join(root, "agent");
  const cavememDataDir = path.join(root, "cavemem");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cavememDataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(agentDir, "models.json"), "{}\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(agentDir, "ownership.json"), "{}\n", {
    mode: 0o600,
  });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { root, agentDir, cavememDataDir };
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relativePath = path.relative(root, file);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          mode: stat.mode & 0o777,
        });
        visit(file);
      } else {
        entries.push({
          path: relativePath,
          type: "file",
          mode: stat.mode & 0o777,
          bytes: fs.readFileSync(file).toString("base64"),
        });
      }
    }
  }
  visit(root);
  return entries;
}

function validatorEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    SHOPIFY_PI_TOKEN: providerSentinel,
    PI_AGENT_LAUNCH_ID: launchSentinel,
    OPENAI_API_KEY: openAiSentinel,
    MCPPROXY_API_KEY: adminSentinel,
    ...overrides,
  };
  delete environment.FORCE_COLOR;
  return environment;
}

function runValidator(packageRoot, state, options = {}) {
  const result = childProcess.spawnSync(
    path.join(packageRoot, validatorExecutable),
    options.args ?? ["--check"],
    {
      ...commandOptions,
      env: validatorEnvironment(options.environment),
      input:
        options.input ??
        `${JSON.stringify({
          schemaVersion: 1,
          agentDir: state.agentDir,
          cavememDataDir: state.cavememDataDir,
        })}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return result;
}

function gate(name, status, gateEvidence, gateRecovery) {
  return {
    name,
    status,
    evidence: gateEvidence,
    recovery: status === "pass" ? "none" : gateRecovery,
  };
}

function expectedReport(overrides = {}, options = {}) {
  const statuses = { ...defaultStatuses, ...overrides };
  const providerMode = options.providerMode ?? "personal";
  return {
    generation,
    gates: [
      gate(
        "package-patches",
        statuses.package,
        evidence.package,
        recovery.package,
      ),
      gate("managed-json", statuses.json, evidence.json, recovery.json),
      gate(
        "ownership",
        statuses.ownership,
        evidence.ownership,
        recovery.ownership,
      ),
      gate(
        "sandbox-profiles",
        statuses.profiles,
        evidence.profiles,
        recovery.profiles,
      ),
      gate(
        "extension-inventory",
        statuses.extensions,
        evidence.extensions,
        recovery.extensions,
      ),
      gate("mcp-surface", statuses.mcp, evidence.mcp, recovery.mcp),
      gate("cavemem", statuses.cavemem, evidence.cavemem, recovery.cavemem),
      gate("pty", statuses.pty, evidence.pty, recovery.pty),
      gate("lsp", statuses.lsp, evidence.lsp, recovery.lsp),
      gate(
        "reconciliation-drift",
        statuses.drift,
        evidence.drift,
        recovery.drift,
      ),
      gate(
        "sandbox-seatbelt-host",
        statuses.seatbelt,
        evidence.seatbelt,
        recovery.seatbelt,
      ),
      gate(
        "provider-setup",
        statuses.provider,
        ["provider-contract:v1", `mode:${providerMode}`],
        recovery.provider,
      ),
    ],
  };
}

function parseReport(result, expectedStatus) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, expectedStatus, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function assertNoSentinels(result) {
  const bytes = `${result.stdout}\n${result.stderr}`;
  for (const sentinel of [
    providerSentinel,
    launchSentinel,
    openAiSentinel,
    adminSentinel,
  ]) {
    assert.equal(bytes.includes(sentinel), false, bytes);
  }
}

test("the packaged validator exposes one command-byte runtime surface", () => {
  for (const packageRoot of Object.values(packages)) {
    const executable = path.join(packageRoot, validatorExecutable);
    const modulePath = path.join(packageRoot, validatorModule);
    assert.equal(fs.existsSync(executable), true, executable);
    assert.notEqual(fs.statSync(executable).mode & 0o111, 0, executable);
    assert.equal(fs.existsSync(modulePath), true, modulePath);
  }

  const source = fs.readFileSync(
    path.join(packages.healthy, validatorModule),
    "utf8",
  );
  const packageExpression = fs.readFileSync(
    path.join(repoRoot, "scripts/pi-agent-validate.nix"),
    "utf8",
  );
  const fixtureExpressionSource = fs.readFileSync(
    path.join(repoRoot, fixtureRelativePath),
    "utf8",
  );
  assert.doesNotMatch(source, /__PI_AGENT_VALIDATOR_/);
  assert.match(source, /pi-agent-status/);
  assert.match(source, /scrubEnvironment/);
  assert.doesNotMatch(
    source,
    /executeSandboxedPi|reconcileManagedState|bin\/pi["']/,
  );
  assert.doesNotMatch(
    `${source}\n${packageExpression}\n${fixtureExpressionSource}`,
    /PI_AGENT_TASK57_VALIDATOR|enableRuntimeValidator|feature is disabled/,
  );
});

test("healthy check and dry-run reports are stable, credential-free, and non-mutating", (t) => {
  const state = createState(t, providerSentinel);
  const before = snapshotTree(state.root);
  let firstBytes;

  for (const mode of ["--check", "--dry-run"]) {
    const first = runValidator(packages.healthy, state, { args: [mode] });
    const second = runValidator(packages.healthy, state, { args: [mode] });
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(parseReport(first, 0), expectedReport());
    assertNoSentinels(first);
    firstBytes ??= first.stdout;
    assert.equal(first.stdout, firstBytes);
    assert.deepEqual(snapshotTree(state.root), before);
  }
});

test("the selected production package, profile, and PTY artifacts satisfy their gates", (t) => {
  const state = createState(t, "production");
  const report = parseReport(
    runValidator(packages["production-artifacts"], state),
    0,
  );
  const statuses = Object.fromEntries(
    report.gates.map(({ name, status }) => [name, status]),
  );
  assert.equal(statuses["package-patches"], "pass");
  assert.equal(statuses["sandbox-profiles"], "pass");
  assert.equal(statuses["extension-inventory"], "pass");
  assert.equal(statuses.pty, "pass");
});

test("explicit rollback selection remains read-only and needs no nested Seatbelt probe", (t) => {
  const state = createState(t, "rollback");
  const result = runValidator(packages.healthy, state, {
    environment: { PI_NONO: "disabled" },
  });
  assert.deepEqual(
    parseReport(result, 0),
    expectedReport({ seatbelt: "pass" }),
  );
});

test("empty sandbox controls use the exact host-default report", async (t) => {
  for (const mode of ["--check", "--dry-run"]) {
    for (const control of emptySelectionControls) {
      await t.test(`${mode} ${control}`, (subtest) => {
        const state = createState(
          subtest,
          `empty-${mode.slice(2)}-${control.toLowerCase().replaceAll("_", "-")}`,
        );
        const result = runValidator(packages.healthy, state, {
          args: [mode],
          environment: { [control]: "" },
        });

        assert.deepEqual(parseReport(result, 0), expectedReport());
        assertNoSentinels(result);
      });
    }
  }
});

test("selection values containing credentials reject before the status process starts", async (t) => {
  for (const mode of ["--check", "--dry-run"]) {
    for (const fixture of selectionCollisionCases) {
      await t.test(`${mode} ${fixture.name}`, (subtest) => {
        const state = createState(
          subtest,
          `selection-collision-${mode.slice(2)}-${fixture.name.replaceAll(" ", "-")}`,
        );
        const marker = path.join(
          state.root,
          "selection-collision-status-invoked",
        );
        const result = runValidator(packages.healthy, state, {
          args: [mode],
          environment: {
            SHOPIFY_PI_TOKEN: fixture.sensitiveValue,
            ...fixture.selection,
          },
        });

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "pi-agent-validate: invocation rejected\n");
        assert.equal(
          fs.existsSync(marker),
          false,
          "status process crossed the credential boundary",
        );
        assert.equal(
          `${result.stdout}${result.stderr}`.includes(fixture.sensitiveValue),
          false,
        );
      });
    }
  }
});

test("invalid launch overrides fail closed and list the accepted values", (t) => {
  const state = createState(t, "invalid-override");
  const result = runValidator(packages.healthy, state, {
    environment: { PI_NONO: "invalid-state" },
  });
  const report = parseReport(result, 1);
  const profileGate = report.gates.find(
    ({ name }) => name === "sandbox-profiles",
  );
  assert.equal(profileGate.status, "fail");
  assert.equal(profileGate.recovery, recovery.profiles);
  assertNoSentinels(result);
  assert.equal(result.stdout.includes("invalid-state"), false);
});

test("component failures identify every affected gate with finite recovery", (t) => {
  const state = createState(t, "components");
  const result = runValidator(packages["component-failure"], state);
  assert.deepEqual(
    parseReport(result, 1),
    expectedReport({
      package: "fail",
      profiles: "fail",
      extensions: "fail",
      mcp: "fail",
      cavemem: "fail",
      pty: "fail",
      lsp: "fail",
    }),
  );
  assertNoSentinels(result);
});

test("managed JSON and ownership drift fail their gates without changing state", (t) => {
  const state = createState(t, "drift");
  const before = snapshotTree(state.root);
  const result = runValidator(packages.drift, state, { args: ["--dry-run"] });
  assert.deepEqual(
    parseReport(result, 1),
    expectedReport({ json: "fail", ownership: "fail", drift: "fail" }),
  );
  assert.deepEqual(snapshotTree(state.root), before);
  assertNoSentinels(result);
});

test("Shopify live provider and nested Seatbelt checks remain explicit manual gates", (t) => {
  const state = createState(t, "manual");
  const result = runValidator(packages["manual-gate"], state);
  assert.deepEqual(
    parseReport(result, 0),
    expectedReport(
      { provider: "manual-required" },
      { providerMode: "shopify-gateway" },
    ),
  );
  assertNoSentinels(result);
});

test("raw child diagnostics and request content never enter validator output", (t) => {
  const state = createState(t, `hostile-${providerSentinel}`);
  const result = runValidator(packages["hostile-status"], state);
  const report = parseReport(result, 1);
  const statuses = Object.fromEntries(
    report.gates.map(({ name, status }) => [name, status]),
  );
  assert.deepEqual(statuses, {
    "package-patches": "pass",
    "managed-json": "fail",
    ownership: "fail",
    "sandbox-profiles": "fail",
    "extension-inventory": "fail",
    "mcp-surface": "fail",
    cavemem: "fail",
    pty: "pass",
    lsp: "fail",
    "reconciliation-drift": "fail",
    "sandbox-seatbelt-host": "fail",
    "provider-setup": "fail",
  });
  assertNoSentinels(result);
  assert.equal(result.stdout.includes(state.agentDir), false);
  assert.equal(result.stdout.includes(state.cavememDataDir), false);
});

test("invalid invocations reject before probes with one value-free diagnostic", (t) => {
  const state = createState(t, "invalid");
  for (const options of [
    { args: [] },
    { args: ["--json"] },
    { args: ["--check", "--dry-run"] },
    { input: "{" },
    {
      input: `${JSON.stringify({
        schemaVersion: 1,
        agentDir: "relative",
        cavememDataDir: state.cavememDataDir,
      })}\n`,
    },
  ]) {
    const result = runValidator(packages.healthy, state, options);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "pi-agent-validate: invocation rejected\n");
    assertNoSentinels(result);
  }
});

test("an exact credential collision suppresses the complete report", (t) => {
  const state = createState(t, "collision");
  const result = runValidator(packages.healthy, state, {
    environment: { SHOPIFY_PI_TOKEN: "pass" },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "pi-agent-validate: invocation rejected\n");
  assert.equal(`${result.stdout}${result.stderr}`.includes("pass"), false);
});
