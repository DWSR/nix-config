import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
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
