import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as reconciliation from "../../scripts/pi-agent-reconcile.mjs";
import {
  currentDocuments,
  generationV1,
  generationV2,
  personalFactoryInput,
  providerOrder,
  shopifyFactoryInput,
} from "./fixtures/reconcile.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const managedConfigFixture = path.join(testsDir, "fixtures/managed-config.nix");
const factoryExecutable = "bin/pi-agent-provider-projection";
const reconcilerExecutable = "bin/pi-agent-reconcile";
const transactionFileName = ".pi-agent-reconcile-transaction.json";
const integrationLockName = ".pi-agent-reconcile.lock";
const temporaryPrefix = ".pi-agent-reconcile-";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};
const managedSettingKeys = [
  "defaultModel",
  "defaultThinkingLevel",
  "installTelemetry",
  "selfUpdate",
  "unmanagedPackages",
];
const { planManagedReconciliation, planManagedReconciliationInternal } = reconciliation;

let personalFactory;
let personalManagedConfigArtifact;
let piRuntime;
let reconcilerPackage;
let shopifyFactory;
let shopifyManagedConfigArtifact;

function fixtureExpression(fixture) {
  return `
    import (/. + ${JSON.stringify(managedConfigFixture)}) {
      fixture = ${JSON.stringify(fixture)};
      repoRoot = ${JSON.stringify(repoRoot)};
    }
  `;
}

function buildFactory(fixture) {
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
  return result.stdout.trim();
}

function runFactory(factory, input) {
  const result = childProcess.spawnSync(path.join(factory, factoryExecutable), [], {
    ...commandOptions,
    input: `${JSON.stringify(input)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bytesHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, jsonBytes(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function mutableFixture(t, current = currentDocuments()) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-reconcile-"));
  t.after(() => fs.rmSync(agentDir, { force: true, recursive: true }));
  writePrivateJson(path.join(agentDir, "settings.json"), current.settings);
  writePrivateJson(path.join(agentDir, "models.json"), current.models);
  return agentDir;
}

function filesystemInput(agentDir, providerProjection, lockTimeoutMs = 2_000) {
  return {
    agentDir,
    managedConfig: managedConfigForProjection(providerProjection),
    providerProjection,
    lockTimeoutMs,
  };
}

function parseReconcilerOutput(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return JSON.parse(result.stdout);
}

function runPackagedReconciler(input, options = {}) {
  const { args = [], env = {}, ...spawnOptions } = options;
  const result = childProcess.spawnSync(
    path.join(reconcilerPackage, reconcilerExecutable),
    args,
    {
      ...commandOptions,
      ...spawnOptions,
      env: { ...process.env, ...env },
      input: `${JSON.stringify(input)}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return { process: result, result: parseReconcilerOutput(result) };
}

function runPackagedRaw(args, input) {
  const result = childProcess.spawnSync(
    path.join(reconcilerPackage, reconcilerExecutable),
    args,
    {
      ...commandOptions,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return { process: result, result: parseReconcilerOutput(result) };
}

function collectChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        assert.equal(signal, null, stderr);
        resolve({ status, stderr, result: JSON.parse(stdout) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runPackagedWithBlockedStdin(args, partialInput) {
  const child = childProcess.spawn(path.join(reconcilerPackage, reconcilerExecutable), args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(partialInput);
  return collectChild(child, 1_000);
}

function spawnPackagedReconciler(input) {
  const child = childProcess.spawn(path.join(reconcilerPackage, reconcilerExecutable), [], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      try {
        assert.equal(signal, null, stderr);
        resolve({ status, stderr, result: JSON.parse(stdout) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function snapshotDirectory(root) {
  const snapshot = [];
  function visit(relativeDir) {
    const directory = path.join(root, relativeDir);
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = path.join(relativeDir, name);
      const file = path.join(root, relativePath);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        snapshot.push({ path: relativePath, type: "directory", mode: stat.mode & 0o777 });
        visit(relativePath);
      } else {
        snapshot.push({
          path: relativePath,
          type: "file",
          mode: stat.mode & 0o777,
          bytes: fs.readFileSync(file).toString("base64"),
        });
      }
    }
  }
  visit("");
  return snapshot;
}

function snapshotManagedArtifacts(agentDir) {
  return snapshotDirectory(agentDir).filter(
    ({ path: relativePath }) =>
      relativePath !== integrationLockName &&
      relativePath !== "settings.json.lock" &&
      !relativePath.startsWith(`${integrationLockName}${path.sep}`) &&
      !relativePath.startsWith(`settings.json.lock${path.sep}`),
  );
}

function runCompromiseProbe(input, mode, logPath = null) {
  const fixtureRoot = path.join(testsDir, "fixtures/lock-compromise");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--require",
      path.join(testsDir, "fixtures/lock-compromise-preload.cjs"),
      path.join(repoRoot, "scripts/pi-agent-reconcile.mjs"),
    ],
    {
      ...commandOptions,
      env: {
        ...process.env,
        NODE_PATH: [
          path.join(fixtureRoot, "node_modules"),
          path.join(piRuntime, "lib/node_modules"),
        ].join(path.delimiter),
        PI_AGENT_LOCK_COMPROMISE_PROBE: mode,
        ...(logPath === null ? {} : { PI_AGENT_LOCK_COMPROMISE_LOG: logPath }),
      },
      input: `${JSON.stringify(input)}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return { process: result, result: parseReconcilerOutput(result) };
}

function spawnRealLockRace(input, logPath) {
  const fixtureRoot = path.join(testsDir, "fixtures/real-lock-race");
  const child = childProcess.spawn(
    process.execPath,
    [path.join(repoRoot, "scripts/pi-agent-reconcile.mjs")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_PATH: path.join(fixtureRoot, "node_modules"),
        PI_AGENT_LOCK_RACE_LOG: logPath,
        PI_AGENT_REAL_PROPER_LOCKFILE: path.join(
          piRuntime,
          "lib/node_modules/proper-lockfile",
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return collectChild(child, 7_000);
}

function readRaceEvents(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoTransactionArtifacts(agentDir) {
  assert.deepEqual(
    fs.readdirSync(agentDir).filter(
      (name) =>
        name === transactionFileName ||
        name === integrationLockName ||
        name === "settings.json.lock" ||
        name.startsWith(temporaryPrefix),
    ),
    [],
  );
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (output.includes(expected)) resolve();
    });
    stream.on("error", reject);
  });
}

function shopifyProjection(options = {}) {
  return runFactory(shopifyFactory, shopifyFactoryInput(options));
}

function personalProjection(generation = generationV2) {
  return runFactory(personalFactory, personalFactoryInput(generation));
}

function managedConfigForProjection(providerProjection) {
  const managedConfig = structuredClone(
    providerProjection.mode === "personal"
      ? personalManagedConfigArtifact
      : shopifyManagedConfigArtifact,
  );
  managedConfig.generation = providerProjection.generation;
  managedConfig.settings.defaultModel = structuredClone(providerProjection.default.model);
  managedConfig.settings.defaultThinkingLevel = providerProjection.default.reasoning;
  managedConfig.providerSelection.defaultModel = structuredClone(providerProjection.default.model);
  if (providerProjection.mode === "shopify-gateway") {
    managedConfig.providerSelection.enabledRoles = providerProjection.providers.map(
      ({ providerId }) => providerId,
    );
  }
  return managedConfig;
}

function reconciliationInput(options = {}) {
  const {
    managedConfig,
    providerProjection = shopifyProjection(),
    current = currentDocuments(),
    ownershipState,
    extra = {},
  } = options;
  const effectiveManagedConfig = managedConfig ?? managedConfigForProjection(providerProjection);
  const input = {
    managedConfig: effectiveManagedConfig,
    providerProjection,
    currentSettings: current.settings,
    currentModels: current.models,
  };

  if (Object.hasOwn(options, "ownershipState")) {
    input.ownershipState = ownershipState;
  }
  for (const key of Object.keys(extra)) {
    input[key] = extra[key];
  }
  return input;
}

function plan(options = {}) {
  return planManagedReconciliationInternal(reconciliationInput(options));
}

function reconcile(options = {}) {
  return planManagedReconciliation(reconciliationInput(options));
}

function hashCanonicalJson(value) {
  const result = reconciliation.hashCanonicalJsonInternal(value);
  assert.equal(result.ok, true);
  return result.valueHash;
}

function successfulPlan(execution) {
  assert.equal(execution.reconcileResult.ok, true);
  assert.notEqual(execution.writePlan, null);
  return {
    result: execution.reconcileResult,
    writePlan: execution.writePlan,
  };
}

function writtenValue(writePlan, targetPath, currentValue) {
  return writePlan.writes.find(({ path: writePath }) => writePath === targetPath)?.value ?? currentValue;
}

function appliedDocuments(writePlan, current) {
  return {
    settings: writtenValue(writePlan, "settings.json", current.settings),
    models: writtenValue(writePlan, "models.json", current.models),
  };
}

function expectedPersistedProvider(provider) {
  const entries = [];
  if (provider.api.kind === "provider-api") {
    entries.push(["api", provider.api.value]);
  }
  entries.push(["apiKey", provider.credential.value.template]);
  entries.push(["baseUrl", provider.baseUrl]);
  entries.push([
    "headers",
    Object.fromEntries(
      provider.headers
        .map((header) => [
          header.name,
          header.value.kind === "fixed-public-literal"
            ? header.value.value
            : header.value.template,
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  ]);
  return Object.fromEntries(entries);
}

function assertValueFreeError(result, forbidden = []) {
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result.error);
  for (const value of forbidden) {
    assert.doesNotMatch(serialized, new RegExp(value));
  }
  assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
}

before(() => {
  reconcilerPackage = buildFactory("reconciler");
  piRuntime = buildFactory("pi-runtime");
  shopifyFactory = buildFactory("shopify-projection-factory");
  personalFactory = buildFactory("personal-projection-factory");
  shopifyManagedConfigArtifact = JSON.parse(
    fs.readFileSync(buildFactory("shopify-managed-config"), "utf8"),
  );
  personalManagedConfigArtifact = JSON.parse(
    fs.readFileSync(buildFactory("personal-managed-config"), "utf8"),
  );
});

test("adds only managed settings and actual Task 2.2 provider projections", () => {
  const current = currentDocuments();
  const currentBytes = {
    settings: JSON.stringify(current.settings),
    models: JSON.stringify(current.models),
  };
  const projection = shopifyProjection({
    roles: ["xai", "groq", "google", "openai", "anthropic"],
  });
  const { result, writePlan } = successfulPlan(plan({ current, providerProjection: projection }));
  assert.deepEqual(result.changed, ["models.json", "settings.json"]);
  const next = appliedDocuments(writePlan, current);

  for (const key of managedSettingKeys) {
    assert.deepEqual(next.settings[key], managedConfigForProjection(projection).settings[key]);
  }
  assert.equal(JSON.stringify(current.settings), currentBytes.settings);
  assert.equal(JSON.stringify(current.models), currentBytes.models);
  assert.equal(JSON.stringify(next.settings.unknownSetting), JSON.stringify(current.settings.unknownSetting));
  assert.equal(JSON.stringify(next.settings.packages), JSON.stringify(current.settings.packages));
  assert.equal(JSON.stringify(next.models.auth), JSON.stringify(current.models.auth));
  assert.equal(JSON.stringify(next.models.trust), JSON.stringify(current.models.trust));
  assert.equal(JSON.stringify(next.models.packages), JSON.stringify(current.models.packages));
  assert.equal(JSON.stringify(next.models.sessions), JSON.stringify(current.models.sessions));
  assert.equal(
    JSON.stringify(next.models.unknownModelsValue),
    JSON.stringify(current.models.unknownModelsValue),
  );
  assert.deepEqual(Object.keys(next.models.providers), ["local", ...providerOrder]);
  for (const provider of projection.providers) {
    assert.deepEqual(next.models.providers[provider.providerId], expectedPersistedProvider(provider));
  }

  assert.equal(writePlan.ownershipStates.pending.transaction, "pending");
  assert.equal(writePlan.ownershipStates.committed.transaction, "committed");
  assert.equal(writePlan.ownershipStates.committed.schemaVersion, 1);
  assert.equal(writePlan.ownershipStates.committed.generation, generationV1);
  assert.deepEqual(Object.keys(writePlan.ownershipStates.committed.files["settings.json"]), [
    "/defaultModel",
    "/defaultThinkingLevel",
    "/installTelemetry",
    "/selfUpdate",
    "/unmanagedPackages",
  ]);
});

test("updates owned values only after matching their prior managed hashes", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);
  const nextProjection = shopifyProjection({
    generation: generationV2,
    origin: "https://next-gateway.example.test",
    defaultModel: { provider: "anthropic", modelId: "claude-opus-4-6" },
  });
  const nextExecution = successfulPlan(plan({
    providerProjection: nextProjection,
    current: applied,
    ownershipState: first.writePlan.ownershipStates.committed,
  }));

  const { result, writePlan } = nextExecution;
  assert.deepEqual(result.changed, ["models.json", "settings.json"]);
  const next = appliedDocuments(writePlan, applied);
  assert.deepEqual(next.settings.defaultModel, {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
  });
  assert.equal(
    next.models.providers.openai.baseUrl,
    "https://next-gateway.example.test/vendors/openai/v1",
  );
  assert.deepEqual(next.models.providers.local, current.models.providers.local);
  assert.equal(writePlan.ownershipStates.committed.generation, generationV2);
});

test("removes unchanged stale providers without touching user providers", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);
  const projection = shopifyProjection({ generation: generationV2, roles: ["openai"] });
  const { result, writePlan } = successfulPlan(plan({
    providerProjection: projection,
    current: applied,
    ownershipState: first.writePlan.ownershipStates.committed,
  }));

  assert.deepEqual(result.changed, ["models.json"]);
  const next = appliedDocuments(writePlan, applied);
  assert.deepEqual(Object.keys(next.models.providers), ["local", "openai"]);
  assert.deepEqual(next.models.providers.local, current.models.providers.local);
  assert.deepEqual(Object.keys(writePlan.ownershipStates.committed.files["models.json"]), [
    "/providers/openai",
  ]);
});

test("rejects invalid target roots before planning mutations", async (t) => {
  const cases = [
    ["settings array", [], currentDocuments().models, "settings.json"],
    ["settings null", null, currentDocuments().models, "settings.json"],
    ["models array", currentDocuments().settings, [], "models.json"],
    ["models null", currentDocuments().settings, null, "models.json"],
    [
      "providers array",
      currentDocuments().settings,
      { providers: [], unknown: "preserve" },
      "models.json",
    ],
  ];

  for (const [name, currentSettings, currentModels, expectedPath] of cases) {
    await t.test(name, () => {
      const providerProjection = shopifyProjection();
      const result = planManagedReconciliation({
        managedConfig: managedConfigForProjection(providerProjection),
        providerProjection,
        currentSettings,
        currentModels,
      });

      assertValueFreeError(result);
      assert.deepEqual(result.error, { kind: "invalid-json", path: expectedPath });
    });
  }
});

test("fails value-free on active, security-key, and provider drift", async (t) => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);

  const cases = [
    [
      "active setting",
      {
        settings: { ...structuredClone(applied.settings), defaultThinkingLevel: "low" },
        models: structuredClone(applied.models),
      },
      { kind: "managed-drift", path: "settings.json", pointer: "/defaultThinkingLevel" },
    ],
    [
      "security setting",
      {
        settings: { ...structuredClone(applied.settings), selfUpdate: true },
        models: structuredClone(applied.models),
      },
      { kind: "managed-drift", path: "settings.json", pointer: "/selfUpdate" },
    ],
    [
      "provider",
      {
        settings: structuredClone(applied.settings),
        models: structuredClone(applied.models),
      },
      { kind: "managed-drift", path: "models.json", pointer: "/providers/openai" },
    ],
  ];
  cases[2][1].models.providers.openai.baseUrl = "https://user-drift.example.test/v1";

  for (const [name, drifted, expectedError] of cases) {
    await t.test(name, () => {
      const beforeBytes = JSON.stringify(drifted);
      const execution = plan({
        current: drifted,
        ownershipState: first.writePlan.ownershipStates.committed,
      });
      const result = execution.reconcileResult;

      assertValueFreeError(result, ["user-drift"]);
      assert.equal(execution.writePlan, null);
      assert.deepEqual(result.error, expectedError);
      assert.equal(JSON.stringify(drifted), beforeBytes);
    });
  }
});

test("returns no rewrite intent for an identical current projection", () => {
  const current = currentDocuments();
  const projection = shopifyProjection();
  const first = successfulPlan(plan({ current, providerProjection: projection }));
  const applied = appliedDocuments(first.writePlan, current);
  const beforeBytes = JSON.stringify(applied);
  const { result, writePlan } = successfulPlan(plan({
    current: applied,
    providerProjection: projection,
    ownershipState: first.writePlan.ownershipStates.committed,
  }));

  assert.deepEqual(result.changed, []);
  assert.deepEqual(writePlan.writes, []);
  assert.equal(JSON.stringify(applied), beforeBytes);
});

test("canonical hashes ignore object insertion order and preserve array order", () => {
  assert.equal(
    hashCanonicalJson({ first: 1, second: { a: true, b: [1, 2] } }),
    hashCanonicalJson({ second: { b: [1, 2], a: true }, first: 1 }),
  );
  assert.equal(
    hashCanonicalJson(
      JSON.parse(
        '{"__proto__":{"first":1,"second":2},"constructor":"constructor-value","prototype":"prototype-value"}',
      ),
    ),
    hashCanonicalJson(
      JSON.parse(
        '{"prototype":"prototype-value","constructor":"constructor-value","__proto__":{"second":2,"first":1}}',
      ),
    ),
  );
  assert.notEqual(hashCanonicalJson({ values: [1, 2] }), hashCanonicalJson({ values: [2, 1] }));
  assert.match(hashCanonicalJson({ stable: true }), /^sha256:[0-9a-f]{64}$/);
});

test("canonical hash validation rejects non-JSON values without echoing them", async (t) => {
  const cyclic = {};
  cyclic.self = cyclic;
  const exoticArray = [1, 2];
  Object.setPrototypeOf(exoticArray, null);
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => {
      throw new Error("accessor must not run");
    },
  });
  const symbolProperty = { stable: true };
  symbolProperty[Symbol("hidden")] = "hash-sentinel";
  const sparseArray = [1, , 3];
  const customArray = [1, 2];
  customArray.extra = "hash-sentinel";
  const cases = [
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["cycle", cyclic],
    ["exotic prototype", new Date(0)],
    ["exotic array prototype", exoticArray],
    ["accessor", accessor],
    ["symbol property", symbolProperty],
    ["sparse array", sparseArray],
    ["custom array property", customArray],
  ];

  for (const [name, value] of cases) {
    await t.test(name, () => {
      const result = reconciliation.hashCanonicalJsonInternal(value);
      assertValueFreeError(result, ["hash-sentinel"]);
      assert.deepEqual(result.error, { kind: "invalid-input", path: "canonical-json" });
    });
  }

  await t.test("null-prototype object", () => {
    const value = Object.assign(Object.create(null), { stable: [1, 2] });
    const result = reconciliation.hashCanonicalJsonInternal(value);
    assert.equal(result.ok, true);
    assert.match(result.valueHash, /^sha256:[0-9a-f]{64}$/);
  });
});

test("personal projection removes only unchanged previously owned Shopify providers", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);
  const { result, writePlan } = successfulPlan(plan({
    providerProjection: personalProjection(),
    current: applied,
    ownershipState: first.writePlan.ownershipStates.committed,
  }));

  assert.deepEqual(result.changed, ["models.json"]);
  const next = appliedDocuments(writePlan, applied);
  assert.deepEqual(next.models.providers, { local: current.models.providers.local });
  assert.equal("models.json" in writePlan.ownershipStates.committed.files, false);
});

test("same-generation joined URL changes are provider-projection-conflict", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);
  const conflictingProjection = shopifyProjection({
    generation: generationV1,
    origin: "https://conflicting-gateway.example.test",
  });
  const execution = plan({
    current: applied,
    providerProjection: conflictingProjection,
    ownershipState: first.writePlan.ownershipStates.committed,
  });
  const result = execution.reconcileResult;

  assertValueFreeError(result, ["conflicting-gateway"]);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, {
    kind: "provider-projection-conflict",
    providerId: "anthropic",
  });
});

test("surfaces pending ownership without attempting Task 2.4 recovery", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const execution = plan({
    current,
    ownershipState: first.writePlan.ownershipStates.pending,
  });
  const result = execution.reconcileResult;

  assertValueFreeError(result);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, {
    kind: "pending-transaction",
    path: "ownership.json",
  });
});

test("closed inputs reject unknown and runtime-secret channels without echoing values", async (t) => {
  const token = "task-2.3-token-sentinel";
  const launchId = "13e77fb0-a076-45aa-a55b-c89eebd88d60";
  const baseProjection = shopifyProjection();
  const cases = [
    ["top-level runtime secrets", baseProjection, { providerRuntimeSecrets: { token } }],
    ["projection token", { ...structuredClone(baseProjection), token }, {}],
    [
      "provider launch ID",
      {
        ...structuredClone(baseProjection),
        providers: baseProjection.providers.map((provider, index) =>
          index === 0 ? { ...structuredClone(provider), launchId } : structuredClone(provider),
        ),
      },
      {},
    ],
    [
      "credential token field",
      {
        ...structuredClone(baseProjection),
        providers: baseProjection.providers.map((provider, index) => {
          if (index !== 0) return structuredClone(provider);
          const changed = structuredClone(provider);
          changed.credential.value.token = token;
          return changed;
        }),
      },
      {},
    ],
    [
      "materialized token",
      {
        ...structuredClone(baseProjection),
        providers: baseProjection.providers.map((provider, index) => {
          if (index !== 0) return structuredClone(provider);
          const changed = structuredClone(provider);
          changed.credential.value.template = token;
          return changed;
        }),
      },
      {},
    ],
  ];

  for (const [name, providerProjection, extra] of cases) {
    await t.test(name, () => {
      const execution = plan({ providerProjection, extra });
      const result = execution.reconcileResult;
      assertValueFreeError(result, [token, launchId]);
      assert.equal(execution.writePlan, null);
      assert.equal(result.error.kind, "invalid-input");
    });
  }
});

test("canonicalizes managed settings, provider rows, fields, and ownership", () => {
  const projection = shopifyProjection({
    roles: ["xai", "groq", "google", "openai", "anthropic"],
  });
  assert.deepEqual(
    projection.providers.map(({ providerId }) => providerId),
    providerOrder,
    "Task 2.2 factory must remain the provider-order source",
  );
  const reorderedProjection = structuredClone(projection);
  reorderedProjection.providers.reverse();
  const current = currentDocuments();
  const { result, writePlan } = successfulPlan(
    plan({ current, providerProjection: reorderedProjection }),
  );

  const next = appliedDocuments(writePlan, current);
  assert.deepEqual(Object.keys(next.settings).slice(-managedSettingKeys.length), managedSettingKeys);
  assert.deepEqual(Object.keys(next.models.providers), ["local", ...providerOrder]);
  assert.deepEqual(Object.keys(next.models.providers.anthropic), [
    "api",
    "apiKey",
    "baseUrl",
    "headers",
  ]);
  assert.deepEqual(Object.keys(next.models.providers.anthropic.headers), [
    "Shopify-Usage-Tag",
    "X-Shopify-Session-Affinity-Header",
    "pi-agent-session-id",
  ]);
  assert.deepEqual(Object.keys(writePlan.ownershipStates.committed.files), [
    "models.json",
    "settings.json",
  ]);
  assert.deepEqual(Object.keys(writePlan.ownershipStates.committed.files["models.json"]), [
    "/providers/anthropic",
    "/providers/google",
    "/providers/groq",
    "/providers/openai",
    "/providers/xai",
  ]);
});

test("review round 1 RED: accepts the actual complete ManagedConfigV1 artifact", () => {
  const projection = shopifyProjection({ generation: shopifyManagedConfigArtifact.generation });
  const { result } = successfulPlan(plan({
    managedConfig: shopifyManagedConfigArtifact,
    providerProjection: projection,
  }));

  assert.equal(result.ok, true);
});

test("review round 1 RED: rejects unknown runtime channels in complete ManagedConfigV1", async (t) => {
  const token = "task-2.3-complete-config-token-sentinel";
  const cases = [
    [
      "top-level runtime secrets",
      (managedConfig) => (managedConfig.runtimeSecrets = { token }),
      "managedConfig",
    ],
    [
      "managed settings token",
      (managedConfig) => (managedConfig.settings.token = token),
      "managedConfig.settings",
    ],
    [
      "provider catalog runtime secrets",
      (managedConfig) => (managedConfig.providerCatalog.shopify[0].runtimeSecrets = { token }),
      "managedConfig.providerCatalog.shopify[0]",
    ],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    await t.test(name, () => {
      const managedConfig = structuredClone(shopifyManagedConfigArtifact);
      mutate(managedConfig);
      const execution = plan({
        managedConfig,
        providerProjection: shopifyProjection({ generation: managedConfig.generation }),
      });
      const result = execution.reconcileResult;
      assertValueFreeError(result, [token]);
      assert.equal(execution.writePlan, null);
      assert.deepEqual(result.error, { kind: "invalid-input", path: expectedPath });
    });
  }
});

test("review round 1 RED: identical unowned provider bytes are a managed collision", () => {
  const providerProjection = shopifyProjection({ roles: ["openai"] });
  const current = currentDocuments();
  current.models.providers.openai = expectedPersistedProvider(providerProjection.providers[0]);
  const execution = plan({ current, providerProjection });
  const result = execution.reconcileResult;

  assertValueFreeError(result);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, {
    kind: "managed-drift",
    path: "models.json",
    pointer: "/providers/openai",
  });

  const personal = successfulPlan(
    plan({ current, providerProjection: personalProjection(generationV2) }),
  );
  const afterPersonal = appliedDocuments(personal.writePlan, current);
  assert.deepEqual(afterPersonal.models.providers.openai, current.models.providers.openai);
  assert.equal("models.json" in personal.writePlan.ownershipStates.committed.files, false);
});

test("review round 1 RED: same-generation provider set removal conflicts before stale removal", () => {
  const current = currentDocuments();
  const first = successfulPlan(plan({ current }));
  const applied = appliedDocuments(first.writePlan, current);
  const execution = plan({
    current: applied,
    providerProjection: shopifyProjection({ generation: generationV1, roles: ["openai"] }),
    ownershipState: first.writePlan.ownershipStates.committed,
  });
  const result = execution.reconcileResult;

  assertValueFreeError(result);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, {
    kind: "provider-projection-conflict",
    providerId: "anthropic",
  });
});

test("review round 1 RED: same-generation provider set addition conflicts", () => {
  const current = currentDocuments();
  const providerProjection = shopifyProjection({ roles: ["openai"] });
  const first = successfulPlan(plan({ current, providerProjection }));
  const applied = appliedDocuments(first.writePlan, current);
  const execution = plan({
    current: applied,
    providerProjection: shopifyProjection(),
    ownershipState: first.writePlan.ownershipStates.committed,
  });
  const result = execution.reconcileResult;

  assertValueFreeError(result);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, {
    kind: "provider-projection-conflict",
    providerId: "anthropic",
  });
});

test("review round 1 RED: explicit null ownership is not absent ownership", () => {
  const execution = plan({ ownershipState: null });
  const result = execution.reconcileResult;

  assertValueFreeError(result);
  assert.equal(execution.writePlan, null);
  assert.deepEqual(result.error, { kind: "invalid-input", path: "ownershipState" });
});

test("review round 1: malformed ownership states fail closed", async (t) => {
  const cases = [
    ["explicit undefined", undefined, "ownershipState"],
    ["array", [], "ownershipState"],
    ["empty object", {}, "ownershipState"],
    [
      "unknown schema",
      { schemaVersion: 2, generation: generationV1, transaction: "committed", files: {} },
      "ownershipState.schemaVersion",
    ],
    [
      "unknown transaction",
      { schemaVersion: 1, generation: generationV1, transaction: "unknown", files: {} },
      "ownershipState.transaction",
    ],
    [
      "non-object files",
      { schemaVersion: 1, generation: generationV1, transaction: "committed", files: [] },
      "ownershipState.files",
    ],
  ];

  for (const [name, ownershipState, expectedPath] of cases) {
    await t.test(name, () => {
      const execution = plan({ ownershipState });
      assert.equal(execution.writePlan, null);
      assertValueFreeError(execution.reconcileResult);
      assert.deepEqual(execution.reconcileResult.error, {
        kind: "invalid-input",
        path: expectedPath,
      });
    });
  }
});

test("review round 1: target validation rejects every non-JSON hash input value-free", async (t) => {
  const cases = [
    ["undefined", (current) => (current.settings.unknownSetting = undefined)],
    ["NaN", (current) => (current.settings.unknownSetting = Number.NaN)],
    ["positive infinity", (current) => (current.settings.unknownSetting = Number.POSITIVE_INFINITY)],
    ["negative infinity", (current) => (current.settings.unknownSetting = Number.NEGATIVE_INFINITY)],
    ["cycle", (current) => (current.settings.unknownSetting = current.settings)],
    ["exotic prototype", (current) => (current.settings.unknownSetting = new Date(0))],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const current = currentDocuments();
      mutate(current);
      const execution = plan({ current });
      const result = execution.reconcileResult;
      assertValueFreeError(result, ["polluted"]);
      assert.equal(execution.writePlan, null);
      assert.deepEqual(result.error, { kind: "invalid-json", path: "settings.json" });
    });
  }

  await t.test("null-prototype objects remain valid JSON objects", () => {
    const current = currentDocuments();
    current.settings = Object.assign(Object.create(null), current.settings);
    current.models = Object.assign(Object.create(null), current.models);
    current.models.providers = Object.assign(Object.create(null), current.models.providers);
    successfulPlan(plan({ current }));
  });
});

test("review round 2 RED: preserves special-name unrelated JSON properties safely", () => {
  const current = currentDocuments();
  const specialSettings = JSON.parse(
    '{"__proto__":{"scope":"settings"},"constructor":{"scope":"settings"},"prototype":{"scope":"settings"}}',
  );
  const specialProviders = JSON.parse(
    '{"__proto__":{"metadata":{"__proto__":"provider-proto"}},"constructor":{"metadata":{"constructor":"provider-constructor"}},"prototype":{"metadata":{"prototype":"provider-prototype"}}}',
  );
  current.settings = Object.fromEntries([
    ...Object.entries(current.settings),
    ...Object.entries(specialSettings),
  ]);
  current.models.providers = Object.fromEntries([
    ...Object.entries(current.models.providers),
    ...Object.entries(specialProviders),
  ]);
  const before = {
    settings: Object.fromEntries(
      Object.keys(specialSettings).map((key) => [key, JSON.stringify(current.settings[key])]),
    ),
    providers: Object.fromEntries(
      Object.keys(specialProviders).map((key) => [key, JSON.stringify(current.models.providers[key])]),
    ),
  };

  const { writePlan } = successfulPlan(plan({ current }));
  const next = appliedDocuments(writePlan, current);

  for (const key of Object.keys(specialSettings)) {
    assert.equal(Object.hasOwn(next.settings, key), true);
    assert.equal(JSON.stringify(next.settings[key]), before.settings[key]);
  }
  for (const providerId of Object.keys(specialProviders)) {
    assert.equal(Object.hasOwn(next.models.providers, providerId), true);
    assert.equal(JSON.stringify(next.models.providers[providerId]), before.providers[providerId]);
  }
  assert.equal(Object.getPrototypeOf(next.settings), Object.prototype);
  assert.equal(Object.getPrototypeOf(next.models.providers), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "scope"), false);
  assert.equal(Object.hasOwn(Object.prototype, "metadata"), false);
});

test("review round 1 RED: public ReconcileResult has the exact design shape", () => {
  const result = reconcile();

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ["changed", "generation", "ok"]);
});

test("review round 1 RED: internal write planning is a separate explicit contract", () => {
  assert.equal(typeof reconciliation.planManagedReconciliationInternal, "function");
  const execution = plan();
  assert.deepEqual(Object.keys(execution).sort(), ["reconcileResult", "writePlan"]);
  assert.equal(execution.reconcileResult.ok, true);
  assert.deepEqual(Object.keys(execution.reconcileResult).sort(), ["changed", "generation", "ok"]);
  assert.deepEqual(Object.keys(execution.writePlan).sort(), [
    "generation",
    "ownershipStates",
    "schemaVersion",
    "writes",
  ]);
  assert.deepEqual(reconcile(), execution.reconcileResult);
});

test("packaged reconciliation commits private files and ownership last", (t) => {
  const current = currentDocuments();
  current.settings = JSON.parse(
    `${JSON.stringify(current.settings).slice(0, -1)},"__proto__":{"safe":"settings"},"constructor":{"safe":"constructor"},"prototype":{"safe":"prototype"}}`,
  );
  const specialProviders = JSON.parse(
    '{"__proto__":{"safe":"provider-proto"},"constructor":{"safe":"provider-constructor"},"prototype":{"safe":"provider-prototype"}}',
  );
  current.models.providers = Object.fromEntries([
    ...Object.entries(current.models.providers),
    ...Object.entries(specialProviders),
  ]);
  const agentDir = mutableFixture(t, current);
  fs.writeFileSync(
    path.join(agentDir, `${temporaryPrefix}interrupted-settings.json.tmp`),
    '{"partial":',
    { mode: 0o600 },
  );
  const projection = shopifyProjection();
  const execution = runPackagedReconciler(filesystemInput(agentDir, projection));

  assert.equal(execution.process.status, 0, execution.process.stderr);
  assert.deepEqual(execution.result, {
    ok: true,
    generation: generationV1,
    changed: ["models.json", "settings.json"],
  });
  const settings = readJson(path.join(agentDir, "settings.json"));
  const models = readJson(path.join(agentDir, "models.json"));
  const ownership = readJson(path.join(agentDir, "ownership.json"));
  assert.equal(ownership.transaction, "committed");
  assert.equal(ownership.generation, generationV1);
  assert.deepEqual(settings.__proto__, { safe: "settings" });
  assert.deepEqual(settings.constructor, { safe: "constructor" });
  assert.deepEqual(settings.prototype, { safe: "prototype" });
  assert.deepEqual(models.auth, current.models.auth);
  assert.deepEqual(models.providers.local, current.models.providers.local);
  for (const providerId of Object.keys(specialProviders)) {
    assert.deepEqual(models.providers[providerId], specialProviders[providerId]);
  }
  for (const name of ["settings.json", "models.json", "ownership.json"]) {
    assert.equal(fs.statSync(path.join(agentDir, name)).mode & 0o777, 0o600);
  }
  assertNoTransactionArtifacts(agentDir);
});

test("rejects every non-empty argv before mutable-state access", async (t) => {
  for (const args of [["--dry-run"], ["status"], ["--", "pi-argument"]]) {
    await t.test(args.join(" "), () => {
      const agentDir = mutableFixture(t);
      fs.writeFileSync(
        path.join(agentDir, `${temporaryPrefix}argv-sentinel.tmp`),
        "must remain byte-identical",
        { mode: 0o600 },
      );
      const before = snapshotDirectory(agentDir);
      const execution = runPackagedReconciler(
        filesystemInput(agentDir, shopifyProjection()),
        { args },
      );

      assert.equal(execution.process.status, 1);
      assert.deepEqual(execution.result, {
        ok: false,
        error: { kind: "invalid-input", path: "argv" },
      });
      assert.deepEqual(snapshotDirectory(agentDir), before);
    });
  }
});

test("packaged argv rejection never reads stdin", async (t) => {
  const agentDir = mutableFixture(t);
  const before = snapshotDirectory(agentDir);
  const malformed = `{"agentDir":${JSON.stringify(agentDir)}`;

  for (const [name, input] of [["malformed", malformed], ["empty", ""]]) {
    await t.test(name, () => {
      const execution = runPackagedRaw(["--dry-run"], input);
      assert.equal(execution.process.status, 1);
      assert.deepEqual(execution.result, {
        ok: false,
        error: { kind: "invalid-input", path: "argv" },
      });
      assert.deepEqual(snapshotDirectory(agentDir), before);
    });
  }

  await t.test("blocked without EOF", async () => {
    const execution = await runPackagedWithBlockedStdin(["--dry-run"], malformed);
    assert.equal(execution.status, 1);
    assert.deepEqual(execution.result, {
      ok: false,
      error: { kind: "invalid-input", path: "argv" },
    });
    assert.deepEqual(snapshotDirectory(agentDir), before);
  });
});

test("concurrent generations serialize to one complete generation", async (t) => {
  const current = currentDocuments();
  const agentDir = mutableFixture(t, current);
  const firstProjection = shopifyProjection();
  const secondProjection = shopifyProjection({
    generation: generationV2,
    origin: "https://next-gateway.example.test",
    defaultModel: { provider: "anthropic", modelId: "claude-opus-4-6" },
  });

  const executions = await Promise.all([
    spawnPackagedReconciler(filesystemInput(agentDir, firstProjection, 10_000)),
    spawnPackagedReconciler(filesystemInput(agentDir, secondProjection, 10_000)),
  ]);
  for (const execution of executions) {
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.result.ok, true);
  }

  const settings = readJson(path.join(agentDir, "settings.json"));
  const models = readJson(path.join(agentDir, "models.json"));
  const ownership = readJson(path.join(agentDir, "ownership.json"));
  const expected = ownership.generation === generationV1 ? firstProjection : secondProjection;
  assert.ok([generationV1, generationV2].includes(ownership.generation));
  assert.equal(ownership.transaction, "committed");
  assert.deepEqual(settings.defaultModel, expected.default.model);
  for (const provider of expected.providers) {
    assert.equal(models.providers[provider.providerId].baseUrl, provider.baseUrl);
  }
  assert.deepEqual(settings.packages, current.settings.packages);
  assert.deepEqual(models.providers.local, current.models.providers.local);
  assertNoTransactionArtifacts(agentDir);
});

test("Pi-compatible settings lock timeout fails without mutation", async (t) => {
  const agentDir = mutableFixture(t);
  const settingsPath = path.join(agentDir, "settings.json");
  const holder = childProcess.spawn(
    process.execPath,
    [path.join(testsDir, "fixtures/hold-proper-lock.cjs"), settingsPath, "", "1000"],
    {
      env: {
        ...process.env,
        NODE_PATH: path.join(piRuntime, "lib/node_modules"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => holder.kill());
  await waitForLine(holder.stdout, "locked\n");
  const before = {
    settings: fs.readFileSync(settingsPath, "utf8"),
    models: fs.readFileSync(path.join(agentDir, "models.json"), "utf8"),
  };

  const execution = runPackagedReconciler(
    filesystemInput(agentDir, shopifyProjection(), 50),
  );
  assert.equal(execution.process.status, 1);
  assert.deepEqual(execution.result, {
    ok: false,
    error: { kind: "lock-timeout", path: "settings.json" },
  });
  assert.equal(fs.readFileSync(settingsPath, "utf8"), before.settings);
  assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), before.models);
  assert.equal(fs.existsSync(path.join(agentDir, "ownership.json")), false);
  assert.equal(fs.existsSync(path.join(agentDir, integrationLockName)), false);
});

test("integration lock timeout fails before settings access", async (t) => {
  const agentDir = mutableFixture(t);
  const integrationLockPath = path.join(agentDir, integrationLockName);
  const holder = childProcess.spawn(
    process.execPath,
    [
      path.join(testsDir, "fixtures/hold-proper-lock.cjs"),
      agentDir,
      integrationLockPath,
      "1000",
    ],
    {
      env: {
        ...process.env,
        NODE_PATH: path.join(piRuntime, "lib/node_modules"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => holder.kill());
  await waitForLine(holder.stdout, "locked\n");

  const execution = runPackagedReconciler(
    filesystemInput(agentDir, shopifyProjection(), 50),
  );
  assert.equal(execution.process.status, 1);
  assert.deepEqual(execution.result, {
    ok: false,
    error: { kind: "lock-timeout", path: integrationLockName },
  });
  assert.equal(fs.existsSync(path.join(agentDir, "settings.json.lock")), false);
  assert.equal(fs.existsSync(path.join(agentDir, "ownership.json")), false);
});

test("lock compromise prevents every subsequent filesystem mutation", async (t) => {
  await t.test("settings lock before recovery cleanup", () => {
    const agentDir = mutableFixture(t);
    fs.writeFileSync(
      path.join(agentDir, `${temporaryPrefix}cleanup-sentinel.tmp`),
      "must survive lock compromise",
      { mode: 0o600 },
    );
    const before = snapshotDirectory(agentDir);
    const execution = runCompromiseProbe(
      filesystemInput(agentDir, shopifyProjection()),
      "settings-before-recovery",
    );

    assert.equal(execution.process.status, 1);
    assert.deepEqual(execution.result, {
      ok: false,
      error: { kind: "write-failure", path: "settings.json" },
    });
    assert.deepEqual(snapshotDirectory(agentDir), before);
  });

  await t.test("integration lock during state read", () => {
    const agentDir = mutableFixture(t);
    const before = snapshotDirectory(agentDir);
    const execution = runCompromiseProbe(
      filesystemInput(agentDir, shopifyProjection()),
      "integration-during-state-read",
    );

    assert.equal(execution.process.status, 1);
    assert.deepEqual(execution.result, {
      ok: false,
      error: { kind: "write-failure", path: integrationLockName },
    });
    assert.deepEqual(snapshotDirectory(agentDir), before);
  });
});

test("detected integration compromise is authoritative on a no-op exit", (t) => {
  const sentinel = "task-2.4-no-op-compromise-value-sentinel";
  const current = currentDocuments();
  current.settings.unrelatedCompromiseValue = sentinel;
  const agentDir = mutableFixture(t, current);
  const projection = shopifyProjection();
  const initial = runPackagedReconciler(filesystemInput(agentDir, projection));
  assert.equal(initial.process.status, 0, initial.process.stderr);

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lock-compromise-"));
  const logPath = path.join(logDir, "events.jsonl");
  t.after(() => fs.rmSync(logDir, { force: true, recursive: true }));
  const before = snapshotDirectory(agentDir);
  const execution = runCompromiseProbe(
    filesystemInput(agentDir, projection),
    "integration-during-state-read",
    logPath,
  );

  assert.equal(execution.process.status, 1);
  assertValueFreeError(execution.result, [sentinel]);
  assert.deepEqual(execution.result.error, {
    kind: "write-failure",
    path: integrationLockName,
  });
  assert.deepEqual(snapshotDirectory(agentDir), before);

  const events = readRaceEvents(logPath);
  const compromisedAt = events.findIndex(({ event }) => event === "integration-compromised");
  assert.notEqual(compromisedAt, -1, JSON.stringify(events));
  assert.equal(
    events.slice(compromisedAt + 1).some(({ event }) => event.endsWith("-release")),
    false,
    JSON.stringify(events),
  );
});

test("detected integration compromise overrides an ordinary state error", (t) => {
  const sentinel = "task-2.4-error-compromise-value-sentinel";
  const agentDir = mutableFixture(t);
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `{"unrelated":"${sentinel}"`,
    { mode: 0o600 },
  );
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lock-compromise-"));
  const logPath = path.join(logDir, "events.jsonl");
  t.after(() => fs.rmSync(logDir, { force: true, recursive: true }));
  const before = snapshotDirectory(agentDir);
  const execution = runCompromiseProbe(
    filesystemInput(agentDir, shopifyProjection()),
    "integration-during-state-read",
    logPath,
  );

  assert.equal(execution.process.status, 1);
  assertValueFreeError(execution.result, [sentinel]);
  assert.deepEqual(execution.result.error, {
    kind: "write-failure",
    path: integrationLockName,
  });
  assert.deepEqual(snapshotDirectory(agentDir), before);

  const events = readRaceEvents(logPath);
  const compromisedAt = events.findIndex(({ event }) => event === "integration-compromised");
  assert.notEqual(compromisedAt, -1, JSON.stringify(events));
  assert.equal(
    events.slice(compromisedAt + 1).some(({ event }) => event.endsWith("-release")),
    false,
    JSON.stringify(events),
  );
});

test("integration compromise dominates settings contention races", async (t) => {
  const cases = [
    ["contention clears", 2500, 5000],
    ["settings timeout", 5000, 2500],
  ];

  for (const [name, holdMs, lockTimeoutMs] of cases) {
    await t.test(name, async (t) => {
      const agentDir = mutableFixture(t);
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lock-race-"));
      const logPath = path.join(logDir, "events.jsonl");
      t.after(() => fs.rmSync(logDir, { force: true, recursive: true }));
      const holder = childProcess.spawn(
        process.execPath,
        [
          path.join(testsDir, "fixtures/hold-proper-lock.cjs"),
          path.join(agentDir, "settings.json"),
          "",
          String(holdMs),
        ],
        {
          env: {
            ...process.env,
            NODE_PATH: path.join(piRuntime, "lib/node_modules"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      t.after(() => holder.kill());
      await waitForLine(holder.stdout, "locked\n");
      const before = snapshotManagedArtifacts(agentDir);

      const execution = await spawnRealLockRace(
        filesystemInput(agentDir, shopifyProjection(), lockTimeoutMs),
        logPath,
      );
      assert.equal(execution.status, 1, execution.stderr);
      assert.deepEqual(execution.result, {
        ok: false,
        error: { kind: "write-failure", path: integrationLockName },
      });
      assert.deepEqual(snapshotManagedArtifacts(agentDir), before);

      const events = readRaceEvents(logPath);
      const compromisedAt = events.findIndex(
        ({ event }) => event === "integration-compromised",
      );
      assert.notEqual(compromisedAt, -1, JSON.stringify(events));
      assert.equal(events[compromisedAt].code, "ECOMPROMISED");
      assert.equal(
        events
          .slice(compromisedAt + 1)
          .some(({ event }) =>
            [
              "settings-attempt",
              "settings-acquired",
              "settings-release",
              "integration-release",
            ].includes(event),
          ),
        false,
        JSON.stringify(events),
      );
    });
  }
});

test("resumes a durable pending transaction after a partial commit", (t) => {
  const agentDir = mutableFixture(t);
  const firstProjection = shopifyProjection();
  const first = runPackagedReconciler(filesystemInput(agentDir, firstProjection));
  assert.equal(first.process.status, 0, first.process.stderr);

  const secondProjection = shopifyProjection({
    generation: generationV2,
    origin: "https://next-gateway.example.test",
    defaultModel: { provider: "anthropic", modelId: "claude-opus-4-6" },
  });
  const current = {
    settings: readJson(path.join(agentDir, "settings.json")),
    models: readJson(path.join(agentDir, "models.json")),
  };
  const priorOwnership = readJson(path.join(agentDir, "ownership.json"));
  const next = successfulPlan(plan({
    current,
    ownershipState: priorOwnership,
    providerProjection: secondProjection,
  }));
  const transactionId = "recovery-fixture";
  const targets = next.writePlan.writes.map(({ path: targetPath, value }) => {
    const beforeBytes = fs.readFileSync(path.join(agentDir, targetPath), "utf8");
    const afterBytes = jsonBytes(value);
    const temporaryPath = `${temporaryPrefix}${transactionId}-${targetPath}.tmp`;
    fs.writeFileSync(path.join(agentDir, temporaryPath), afterBytes, { mode: 0o600 });
    return {
      path: targetPath,
      temporaryPath,
      beforeHash: bytesHash(beforeBytes),
      afterHash: bytesHash(afterBytes),
    };
  });
  const priorOwnershipBytes = fs.readFileSync(path.join(agentDir, "ownership.json"), "utf8");
  writePrivateJson(path.join(agentDir, transactionFileName), {
    schemaVersion: 1,
    generation: generationV2,
    previousOwnershipHash: bytesHash(priorOwnershipBytes),
    pendingOwnership: next.writePlan.ownershipStates.pending,
    committedOwnership: next.writePlan.ownershipStates.committed,
    targets,
  });
  writePrivateJson(
    path.join(agentDir, "ownership.json"),
    next.writePlan.ownershipStates.pending,
  );
  fs.renameSync(
    path.join(agentDir, targets[0].temporaryPath),
    path.join(agentDir, targets[0].path),
  );

  const recovered = runPackagedReconciler(filesystemInput(agentDir, secondProjection));
  assert.equal(recovered.process.status, 0, recovered.process.stderr);
  assert.equal(recovered.result.ok, true);
  assert.equal(readJson(path.join(agentDir, "ownership.json")).transaction, "committed");
  assert.deepEqual(readJson(path.join(agentDir, "settings.json")).defaultModel, {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
  });
  assert.equal(
    readJson(path.join(agentDir, "models.json")).providers.openai.baseUrl,
    "https://next-gateway.example.test/vendors/openai/v1",
  );
  assertNoTransactionArtifacts(agentDir);
});

test("unknown pending ownership fails safely", (t) => {
  const agentDir = mutableFixture(t);
  const projection = shopifyProjection();
  const first = runPackagedReconciler(filesystemInput(agentDir, projection));
  assert.equal(first.process.status, 0, first.process.stderr);
  const ownershipPath = path.join(agentDir, "ownership.json");
  const pending = readJson(ownershipPath);
  pending.transaction = "pending";
  writePrivateJson(ownershipPath, pending);
  const before = new Map(
    ["settings.json", "models.json", "ownership.json"].map((name) => [
      name,
      fs.readFileSync(path.join(agentDir, name), "utf8"),
    ]),
  );

  const execution = runPackagedReconciler(filesystemInput(agentDir, projection));
  assert.equal(execution.process.status, 1);
  assert.deepEqual(execution.result, {
    ok: false,
    error: { kind: "pending-transaction", path: "ownership.json" },
  });
  for (const [name, bytes] of before) {
    assert.equal(fs.readFileSync(path.join(agentDir, name), "utf8"), bytes);
  }
});
