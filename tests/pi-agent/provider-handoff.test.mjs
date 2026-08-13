import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/provider-handoff.nix";
const handoffModuleRelativePath = "lib/pi-agent/shopify-provider-handoff.mjs";
const resolverModuleRelativePath = "lib/pi-agent/credential-resolver.mjs";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};
const candidateSentinel = "task-5-3-base-candidate-sentinel-4f2ab8";
const tokenOne = "task-5-3-token-one-sentinel-417eda";
const tokenTwo = "task-5-3-token-two-sentinel-c98253";
const inputSentinel = "task-5-3-input-sentinel-a3c4df";

let fixtureRoot;
let handoff;
let handoffSource;
let managedConfig;
let personalResolver;
let reconciler;
let shopifyResolver;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-provider-handoff-tests";
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

async function importModule(file) {
  return import(pathToFileURL(file));
}

async function loadHandoff(name) {
  const modulePath = path.join(fixtureRoot, name, handoffModuleRelativePath);
  assert.ok(fs.existsSync(modulePath), `missing packaged handoff ${modulePath}`);
  return {
    module: await importModule(modulePath),
    source: fs.readFileSync(modulePath, "utf8"),
  };
}

async function loadResolver(name) {
  const modulePath = path.join(
    fixtureRoot,
    "credential-packages",
    name,
    resolverModuleRelativePath,
  );
  assert.ok(fs.existsSync(modulePath), `missing packaged resolver ${modulePath}`);
  return importModule(modulePath);
}

before(
  async () => {
    fixtureRoot = buildFixture("packages");
    const loadedHandoff = await loadHandoff("handoff");
    handoff = loadedHandoff.module;
    handoffSource = loadedHandoff.source;
    managedConfig = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, "managed-config.json"), "utf8"),
    );
    [shopifyResolver, personalResolver, reconciler] = await Promise.all([
      loadResolver("shopify"),
      loadResolver("personal"),
      importModule(path.join(fixtureRoot, "reconciler.mjs")),
    ]);
  },
  { timeout: 600_000 },
);

async function withEnvironment(environment, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function resolveShopify(baseCandidate, token, tempRoot = undefined) {
  return withEnvironment(
    {
      PI_AGENT_TASK52_MODE: "success",
      PI_AGENT_TASK52_TOKEN_OUTPUT: token,
      PI_AGENT_TASK52_BASE_OUTPUT: baseCandidate,
      ...(tempRoot === undefined ? {} : { TMPDIR: tempRoot }),
    },
    () => shopifyResolver.resolveProviderRuntimeSecrets(),
  );
}

function currentDocuments() {
  return {
    settings: {
      theme: "user-theme",
      packages: ["user-package"],
      unrelatedSetting: { nested: ["preserve", 7] },
    },
    models: {
      providers: {
        local: {
          baseUrl: "https://local.example.test/v1",
          api: "openai-completions",
          headers: { "X-User-Header": "preserve" },
        },
      },
      auth: { source: "user-auth" },
      trust: { project: true },
      packages: ["user-model-package"],
      sessions: { retained: true },
      unrelatedModelsValue: [1, { two: 2 }],
    },
  };
}

function handoffInput(baseCandidate, documents = currentDocuments()) {
  return {
    baseCandidate,
    currentSettings: documents.settings,
    currentModels: documents.models,
  };
}

function runHandoff(baseCandidate, documents = currentDocuments(), module = handoff) {
  return module.composeShopifyProviderHandoff(
    handoffInput(baseCandidate, documents),
  );
}

function reconciliationInput(result, documents = currentDocuments()) {
  return {
    managedConfig,
    providerProjection: result.providerProjection,
    currentSettings: documents.settings,
    currentModels: documents.models,
  };
}

function runDirectFactory(inputBytes) {
  const result = childProcess.spawnSync(
    path.join(fixtureRoot, "projection-factory", "bin/pi-agent-provider-projection"),
    [],
    {
      ...commandOptions,
      env: {},
      input: inputBytes,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return result;
}

function expectedJoinedUrls(baseCandidate) {
  const selectedRoles = new Set(managedConfig.providerSelection.enabledRoles);
  const origin = new URL(baseCandidate).origin;
  return Object.fromEntries(
    managedConfig.providerCatalog.shopify
      .filter(({ role }) => selectedRoles.has(role))
      .map(({ role, route }) => [role, origin + route.suffix]),
  );
}

function applyWritePlan(writePlan, documents) {
  const next = structuredClone(documents);
  for (const write of writePlan.writes) {
    if (write.path === "settings.json") next.settings = structuredClone(write.value);
    else if (write.path === "models.json") next.models = structuredClone(write.value);
    else assert.fail(`unexpected write path ${write.path}`);
  }
  return next;
}

function readTextTree(root) {
  const chunks = [];
  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      chunks.push(fs.readlinkSync(target));
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) visit(path.join(target, entry));
    } else {
      chunks.push(fs.readFileSync(target, "utf8"));
    }
  }
  visit(root);
  return chunks.join("\n");
}

function assertNoValues(text, values) {
  for (const value of values) {
    assert.equal(text.includes(String(value)), false, `value crossed persistence boundary: ${value}`);
  }
}

function assertFixedError(operation, expectedMessage, forbidden = []) {
  assert.throws(operation, (error) => {
    assert.equal(error.message, expectedMessage);
    assert.deepEqual(Object.keys(error), []);
    assertNoValues(error.message, forbidden);
    return true;
  });
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("valid Shopify bases retain only the origin and pass exact factory output to reconciliation", async (t) => {
  assert.deepEqual(Object.keys(handoff), ["composeShopifyProviderHandoff"]);
  const bases = [
    "https://gateway.example.test",
    "https://gateway.example.test/accepted/but/not/retained",
    "https://gateway.example.test:8443/tenant/path",
    "https://[2001:db8::1]/tenant/@path/%40/%3F/%23",
    "https://gateway.example.test/path/%40-user/%3F-query/%23-fragment",
    "https://host\\path@segment",
  ];

  for (const [index, baseCandidate] of bases.entries()) {
    await t.test(baseCandidate, async () => {
      const resolved = await resolveShopify(baseCandidate, `${tokenOne}-${index}`);
      const { runtimeSecrets, baseCandidate: resolvedBase } = resolved;
      const documents = currentDocuments();
      const before = structuredClone(documents);
      const result = runHandoff(resolvedBase, documents);
      const factoryInput = JSON.parse(result.factoryInputBytes);
      const joinedUrls = expectedJoinedUrls(baseCandidate);

      assert.deepEqual(Object.keys(result).sort(), [
        "factoryInputBytes",
        "projectionBytes",
        "providerProjection",
        "reconciliationResult",
      ]);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(resolved.runtimeSecrets, runtimeSecrets);
      assert.throws(() => JSON.stringify(runtimeSecrets), /not serializable/);
      assert.deepEqual(factoryInput, {
        schemaVersion: managedConfig.schemaVersion,
        generation: managedConfig.generation,
        providerSelection: managedConfig.providerSelection,
        joinedUrls,
      });
      for (const entry of managedConfig.providerCatalog.shopify) {
        if (managedConfig.providerSelection.enabledRoles.includes(entry.role)) {
          assert.equal(joinedUrls[entry.role], new URL(baseCandidate).origin + entry.route.suffix);
        }
      }

      const directFactory = runDirectFactory(result.factoryInputBytes);
      assert.equal(directFactory.status, 0, directFactory.stderr);
      assert.equal(directFactory.stderr, "");
      assert.equal(result.projectionBytes, directFactory.stdout);
      assert.deepEqual(result.providerProjection, JSON.parse(directFactory.stdout));
      const plannerInput = reconciliationInput(result, documents);
      assert.equal(plannerInput.providerProjection, result.providerProjection);
      assert.deepEqual(
        result.reconciliationResult,
        reconciler.planManagedReconciliation(plannerInput),
      );
      assert.equal(result.reconciliationResult.ok, true);

      const directPlan = reconciler.planManagedReconciliationInternal(
        plannerInput,
      );
      assert.equal(directPlan.reconcileResult.ok, true);
      assert.ok(directPlan.writePlan);
      const next = applyWritePlan(directPlan.writePlan, documents);
      assert.deepEqual(next.settings.theme, before.settings.theme);
      assert.deepEqual(next.settings.packages, before.settings.packages);
      assert.deepEqual(next.settings.unrelatedSetting, before.settings.unrelatedSetting);
      assert.deepEqual(next.models.providers.local, before.models.providers.local);
      assert.deepEqual(next.models.auth, before.models.auth);
      assert.deepEqual(next.models.trust, before.models.trust);
      assert.deepEqual(next.models.packages, before.models.packages);
      assert.deepEqual(next.models.sessions, before.models.sessions);
      assert.deepEqual(next.models.unrelatedModelsValue, before.models.unrelatedModelsValue);
      assert.deepEqual(documents, before);
      const serializedBoundary = JSON.stringify({
        input: handoffInput(resolvedBase, documents),
        result,
      });
      assert.doesNotMatch(serializedBoundary, /runtimeSecrets|token|launchId/);
      assertNoValues(serializedBoundary, [
        runtimeSecrets.token,
        runtimeSecrets.launchId,
      ]);

      const xai = result.providerProjection.providers.find(
        ({ providerId }) => providerId === "xai",
      );
      assert.deepEqual(xai.api, {
        kind: "pi-per-model-api",
        providerApiField: "omit",
      });
      assert.equal("value" in xai.api, false);
    });
  }
});

test("distinct real resolver launches retain secret identity outside stable persisted bytes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-provider-handoff-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const baseCandidate = "https://stable-gateway.example.test/ignored/path";
  const firstOutcome = await resolveShopify(baseCandidate, tokenOne, tempRoot);
  const secondOutcome = await resolveShopify(baseCandidate, tokenTwo, tempRoot);
  const {
    runtimeSecrets: firstRuntimeSecrets,
    baseCandidate: firstBaseCandidate,
  } = firstOutcome;
  const {
    runtimeSecrets: secondRuntimeSecrets,
    baseCandidate: secondBaseCandidate,
  } = secondOutcome;
  const first = runHandoff(firstBaseCandidate);
  const second = runHandoff(secondBaseCandidate);

  assert.notEqual(firstRuntimeSecrets, secondRuntimeSecrets);
  assert.notEqual(
    firstRuntimeSecrets.launchId,
    secondRuntimeSecrets.launchId,
  );
  assert.equal(firstOutcome.runtimeSecrets, firstRuntimeSecrets);
  assert.equal(secondOutcome.runtimeSecrets, secondRuntimeSecrets);
  assert.throws(() => JSON.stringify(firstRuntimeSecrets), /not serializable/);
  assert.throws(() => JSON.stringify(secondRuntimeSecrets), /not serializable/);
  assert.doesNotMatch(JSON.stringify(first), /runtimeSecrets|token|launchId/);
  assert.doesNotMatch(JSON.stringify(second), /runtimeSecrets|token|launchId/);
  assert.equal(first.factoryInputBytes, second.factoryInputBytes);
  assert.equal(first.projectionBytes, second.projectionBytes);
  assert.deepEqual(first.providerProjection, second.providerProjection);

  const forbidden = [
    tokenOne,
    tokenTwo,
    firstRuntimeSecrets.launchId,
    secondRuntimeSecrets.launchId,
  ];
  assertNoValues(
    [
      first.factoryInputBytes,
      first.projectionBytes,
      JSON.stringify(first),
      second.factoryInputBytes,
      second.projectionBytes,
      JSON.stringify(second),
      handoffSource,
      readTextTree(tempRoot),
    ].join("\n"),
    forbidden,
  );
  assert.match(first.projectionBytes, /\$\{SHOPIFY_PI_TOKEN\}/);
  assert.match(first.projectionBytes, /\$\{PI_AGENT_LAUNCH_ID\}/);
  assert.equal(fs.readdirSync(tempRoot).length, 0);
});

test("invalid and personal bases fail with fixed diagnostics before state mutation", async (t) => {
  const personalOutcome = await personalResolver.resolveProviderRuntimeSecrets();
  const cases = [
    ["non-string", 17],
    ["malformed", `https://[${candidateSentinel}`],
    ["http", `http://${candidateSentinel}.example.test/path`],
    ["userinfo", `https://${candidateSentinel}:password@example.test/path`],
    ["query", `https://example.test/path?candidate=${candidateSentinel}`],
    ["fragment", `https://example.test/path#${candidateSentinel}`],
    ["empty userinfo delimiter", "https://@host/path"],
    ["empty query delimiter", "https://host/path?"],
    ["empty fragment delimiter", "https://host/path#"],
    ["backslash empty userinfo", "https:\\\\@host/path"],
    ["extra slash empty userinfo", "https:////@host/path"],
    ["tab-stripped empty userinfo", "https:\t//@host/path"],
    ["carriage-return-stripped empty userinfo", "https:\r//@host/path"],
    ["line-feed-stripped empty userinfo", "https:\n//@host/path"],
    ["NUL in authority introducer", "https:\0//@host/path"],
    ["empty raw authority", "https:///path"],
    ["noncanonical scheme spelling", "HTTPS://host/path"],
    ["opaque null origin", `mailto:${candidateSentinel}@example.test`],
    ["personal null", personalOutcome.baseCandidate],
  ];

  for (const [name, candidate] of cases) {
    await t.test(name, () => {
      const documents = currentDocuments();
      const before = structuredClone(documents);
      assertFixedError(
        () => runHandoff(candidate, documents),
        "Shopify provider base validation failed",
        [candidateSentinel],
      );
      assert.deepEqual(documents, before);
    });
  }
});

test("closed handoff input rejects caller overrides, prototypes, accessors, and extra keys", async (t) => {
  const baseCandidate = "https://closed-input.example.test/path";
  const valid = handoffInput(baseCandidate);
  let getterRead = false;
  const accessorInput = {};
  Object.defineProperties(accessorInput, {
    baseCandidate: {
      enumerable: true,
      get() {
        getterRead = true;
        return baseCandidate;
      },
    },
    currentSettings: { enumerable: true, value: valid.currentSettings },
    currentModels: { enumerable: true, value: valid.currentModels },
  });
  const symbolInput = { ...valid };
  symbolInput[Symbol(inputSentinel)] = true;
  let nestedProxyTrapRead = false;
  const nestedProxy = new Proxy(Object.freeze({}), {
    getPrototypeOf() {
      nestedProxyTrapRead = true;
      throw new Error(inputSentinel);
    },
    ownKeys() {
      nestedProxyTrapRead = true;
      throw new Error(inputSentinel);
    },
  });
  const topLevelProxy = new Proxy(valid, {
    getPrototypeOf() {
      throw new Error(inputSentinel);
    },
  });
  const legacyRuntimeTarget = Object.freeze({});
  const legacyRuntimeProxy = new Proxy(legacyRuntimeTarget, {
    isExtensible() {
      nestedProxyTrapRead = true;
      throw new Error(inputSentinel);
    },
  });
  const cases = {
    "caller generation override": { ...valid, generation: inputSentinel },
    "caller selection override": {
      ...valid,
      providerSelection: { mode: "personal" },
    },
    "caller factory override": { ...valid, projectionFactory: () => inputSentinel },
    "caller reconciler override": { ...valid, reconciler: () => inputSentinel },
    "serializable fake runtime secrets": {
      ...valid,
      runtimeSecrets: Object.freeze({ token: inputSentinel }),
    },
    "trapping runtime secrets": { ...valid, runtimeSecrets: nestedProxy },
    "legacy serializable resolver outcome": {
      resolverOutcome: Object.freeze({
        runtimeSecrets: Object.freeze({ token: inputSentinel }),
        baseCandidate,
      }),
      currentSettings: valid.currentSettings,
      currentModels: valid.currentModels,
    },
    "legacy trapping resolver outcome": {
      resolverOutcome: Object.freeze({
        runtimeSecrets: legacyRuntimeProxy,
        baseCandidate,
      }),
      currentSettings: valid.currentSettings,
      currentModels: valid.currentModels,
    },
    "missing current models": {
      baseCandidate,
      currentSettings: valid.currentSettings,
    },
    "null prototype": Object.assign(Object.create(null), valid),
    "top-level proxy": topLevelProxy,
    accessor: accessorInput,
    symbol: symbolInput,
  };

  for (const [name, input] of Object.entries(cases)) {
    await t.test(name, () => {
      assertFixedError(
        () => handoff.composeShopifyProviderHandoff(input),
        "Shopify provider handoff input rejected",
        [inputSentinel],
      );
    });
  }
  assert.equal(getterRead, false);
  assert.equal(nestedProxyTrapRead, false);
  assertFixedError(
    () => handoff.composeShopifyProviderHandoff(),
    "Shopify provider handoff input rejected",
  );
  assertFixedError(
    () => handoff.composeShopifyProviderHandoff(valid, valid),
    "Shopify provider handoff input rejected",
  );
});

test("nested hostile reconciliation state reports a fixed value-free error", () => {
  const nestedProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error(inputSentinel);
    },
  });
  const documents = currentDocuments();
  documents.models.providers.local = nestedProxy;
  assertFixedError(
    () => runHandoff("https://nested-state.example.test", documents),
    "Shopify provider reconciliation validation failed",
    [inputSentinel],
  );
});

test("returned projection and reconciliation result are deeply immutable", async () => {
  const { baseCandidate } = await resolveShopify(
    "https://immutable.example.test/path",
    tokenOne,
  );
  const documents = currentDocuments();
  const result = runHandoff(baseCandidate, documents);
  const projectionBefore = JSON.stringify(result.providerProjection);
  const resultBefore = JSON.stringify(result.reconciliationResult);
  const plannerInput = reconciliationInput(result, documents);
  const plannerBefore = reconciler.planManagedReconciliation(plannerInput);
  const firstProvider = result.providerProjection.providers[0];

  assertDeepFrozen(result.providerProjection);
  assertDeepFrozen(result.reconciliationResult);
  for (const mutate of [
    () => { firstProvider.baseUrl = "https://tampered.example.test"; },
    () => { firstProvider.headers[0].name = "X-Tampered"; },
    () => { firstProvider.headers[0].value.value = "tampered"; },
    () => { firstProvider.modelCatalog.source = "tampered"; },
    () => { firstProvider.modelCatalog.overrides.push("tampered"); },
    () => { result.providerProjection.default.model.modelId = "tampered"; },
    () => { result.providerProjection.default.reasoning = "off"; },
    () => { result.providerProjection.providers.push(firstProvider); },
    () => { firstProvider.headers.push(firstProvider.headers[0]); },
    () => { result.reconciliationResult.ok = false; },
    () => { result.reconciliationResult.changed.push("tampered.json"); },
  ]) {
    assert.throws(mutate, TypeError);
  }

  assert.equal(JSON.stringify(result.providerProjection), projectionBefore);
  assert.equal(JSON.stringify(result.reconciliationResult), resultBefore);
  assert.equal(plannerInput.providerProjection, result.providerProjection);
  assert.deepEqual(reconciler.planManagedReconciliation(plannerInput), plannerBefore);
  assert.deepEqual(documents, currentDocuments());
});

test("tampered catalog, selection, and factory artifacts fail before planner mutation", async (t) => {
  const { baseCandidate } = await resolveShopify(
    "https://tamper-check.example.test/path",
    tokenOne,
  );
  for (const name of [
    "tampered-catalog-handoff",
    "tampered-selection-handoff",
    "tampered-factory-handoff",
  ]) {
    await t.test(name, async () => {
      const loaded = await loadHandoff(name);
      const documents = currentDocuments();
      const before = structuredClone(documents);
      assertFixedError(
        () => runHandoff(baseCandidate, documents, loaded.module),
        "Shopify provider artifact validation failed",
        [candidateSentinel, tokenOne],
      );
      assert.deepEqual(documents, before);
      assertNoValues(loaded.source, [tokenOne]);
    });
  }
});

test("changed Nix files pass Statix and deadnix", () => {
  const nixFiles = [
    "home-manager/common/pi-agent/default.nix",
    "home-manager/common/pi-agent/managed-config.nix",
    "scripts/pi-agent-shopify-provider-handoff.nix",
    "tests/pi-agent/fixtures/managed-config.nix",
    "tests/pi-agent/fixtures/provider-handoff.nix",
  ];
  const checks = [
    [
      path.join(fixtureRoot, "statix/bin/statix"),
      ["check", "--config", ".statix.toml"],
      [
        "home-manager/common/pi-agent/managed-config.nix",
        "scripts/pi-agent-shopify-provider-handoff.nix",
        "tests/pi-agent/fixtures/provider-handoff.nix",
      ],
    ],
    [path.join(fixtureRoot, "deadnix/bin/deadnix"), ["--fail"], nixFiles],
  ];
  for (const [executable, prefix, files] of checks) {
    for (const file of files) {
      const result = childProcess.spawnSync(executable, [...prefix, file], {
        ...commandOptions,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.ifError(result.error);
      assert.equal(
        result.status,
        0,
        `${path.basename(executable)} ${file}\n${result.stdout}${result.stderr}`,
      );
    }
  }
});

test("the package is Shopify-only and fixes every executable dependency at build time", () => {
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "personal-state.json"), "utf8")),
    { isNull: true },
  );
  assert.match(handoffSource, /\/nix\/store\/[0-9a-df-np-sv-z]{32}-/);
  assert.doesNotMatch(
    handoffSource,
    /__PI_AGENT_|PI_AGENT_TASK_53_ENABLED_PLACEHOLDER/,
  );
  assert.doesNotMatch(handoffSource, /TODO|FIXME/);
  assert.equal(
    fs.statSync(
      path.join(fixtureRoot, "handoff", handoffModuleRelativePath),
    ).mode & 0o222,
    0,
  );
});
