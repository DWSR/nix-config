import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const nodeModulesRelativePath = "lib/node_modules/@earendil-works/pi-coding-agent";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};
const piAuthSentinel = "task-5-1-existing-pi-auth-sentinel";
const ambientOpenAiSentinel = "task-5-1-ambient-openai-sentinel";
const exactRedactionSerializationError = "exact redaction values are not serializable";

let managedConfig;
let personalFactory;
let personalPolicy;
let personalPolicyOutput;
let piExports;
let reconciler;

function fixtureExpression(relativePath, fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-task-5-1-source";
        filter = sourcePath: type:
          let base = builtins.baseNameOf sourcePath;
          in base != ".git" && base != "result";
      };
    in
      import (repoSource + "/${relativePath}") {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = repoSource;
      }
  `;
}

function buildFixture(relativePath, fixture) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression(relativePath, fixture),
    ],
    { ...commandOptions, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1, result.stdout);
  return outputs[0];
}

function runFactory(input, environment = {}) {
  const result = childProcess.spawnSync(
    path.join(personalFactory, "bin/pi-agent-provider-projection"),
    [],
    {
      ...commandOptions,
      env: { ...process.env, ...environment },
      input: `${JSON.stringify(input)}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return result;
}

function personalFactoryInput(overrides = {}) {
  return {
    schemaVersion: 1,
    generation: managedConfig.generation,
    providerSelection: structuredClone(managedConfig.providerSelection),
    joinedUrls: {},
    ...overrides,
  };
}

function createPersonalProjection() {
  const result = runFactory(personalFactoryInput());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return { bytes: result.stdout, value: JSON.parse(result.stdout) };
}

function writePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function createAgentState(t, providers) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-personal-runtime-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const settings = {
    theme: "user-theme",
    packages: ["user-package"],
    defaultProjectTrust: "always",
    unrelated: { nested: ["preserve", { bytes: "structurally" }] },
  };
  const models = {
    ...(providers === undefined ? {} : { providers }),
    auth: { source: "user-model-auth" },
    trust: { project: true },
    packages: ["user-model-package"],
    sessions: { retained: true },
    unrelated: [1, { two: 2 }],
  };
  const authBytes = `${JSON.stringify(
    {
      openai: { type: "api_key", key: piAuthSentinel },
      anthropic: { type: "api_key", key: "unrelated-auth-sentinel" },
    },
    null,
    2,
  )}\n`;
  const files = {
    "auth.json": authBytes,
    "models.json": `${JSON.stringify(models, null, 2)}\n`,
    "settings.json": `${JSON.stringify(settings, null, 2)}\n`,
    "packages/state.json": '{"retained":"package-state"}\n',
    "sessions/retained.jsonl": '{"retained":"session-state"}\n',
    "trust.json": '{"retained":"trust-state"}\n',
  };
  for (const [relativePath, bytes] of Object.entries(files)) {
    writePrivate(path.join(agentDir, relativePath), bytes);
  }

  return { agentDir, files, models, settings };
}

function runReconciler(agentDir, projection) {
  const result = childProcess.spawnSync(path.join(reconciler, "bin/pi-agent-reconcile"), [], {
    ...commandOptions,
    input: `${JSON.stringify({
      agentDir,
      managedConfig,
      providerProjection: projection,
      lockTimeoutMs: 2_000,
    })}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return { process: result, value: JSON.parse(result.stdout) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function expectedCatalogDefault() {
  const [provider, ...modelIdParts] = managedConfig.providerCatalog.defaults.personal.model.split("/");
  assert.notEqual(provider, "");
  assert.ok(modelIdParts.length > 0);
  return { provider, modelId: modelIdParts.join("/") };
}

function assertNonSerializable(value) {
  assert.throws(() => JSON.stringify(value), /not serializable/);
}

function readTextTree(root) {
  const chunks = [];
  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      chunks.push(fs.readlinkSync(target));
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        visit(path.join(target, entry));
      }
      return;
    }
    chunks.push(fs.readFileSync(target).toString("utf8"));
  }
  visit(root);
  return chunks.join("\n");
}

function closureText(root) {
  const result = childProcess.spawnSync("nix-store", ["--query", "--requisites", root], {
    ...commandOptions,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort()
    .map((storePath) => `${storePath}\n${readTextTree(storePath)}`)
    .join("\n");
}

before(
  async () => {
    const managedFixture = "tests/pi-agent/fixtures/managed-config.nix";
    const credentialFixture = "tests/pi-agent/fixtures/credential-policy.nix";
    const managedConfigPath = buildFixture(managedFixture, "personal-managed-config");
    personalFactory = buildFixture(managedFixture, "personal-projection-factory");
    personalPolicyOutput = buildFixture(credentialFixture, "personal-runtime-module");
    reconciler = buildFixture(managedFixture, "reconciler");
    const piRuntime = buildFixture(managedFixture, "pi-runtime");

    managedConfig = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));
    personalPolicy = await import(
      pathToFileURL(path.join(personalPolicyOutput, "lib/pi-agent/credential-policy.mjs"))
    );
    piExports = await import(pathToFileURL(path.join(piRuntime, nodeModulesRelativePath, "index.js")));
  },
  { timeout: 600_000 },
);

test("personal composition structurally rejects every Shopify/provider override surface", async (t) => {
  const cases = {
    "non-catalog default": {
      ...personalFactoryInput(),
      providerSelection: {
        ...managedConfig.providerSelection,
        defaultModel: { provider: "openai", modelId: "gpt-5.5" },
      },
    },
    "joined endpoint": {
      ...personalFactoryInput(),
      joinedUrls: { openai: "https://gateway.example.test/vendors/openai/v1" },
    },
    "Shopify role": {
      ...personalFactoryInput(),
      providerSelection: { ...managedConfig.providerSelection, enabledRoles: ["openai"] },
    },
    "provider object": { ...personalFactoryInput(), providers: [{ providerId: "openai" }] },
    "header object": { ...personalFactoryInput(), headers: { Authorization: "fixture" } },
    "resolver object": { ...personalFactoryInput(), resolvers: [{ kind: "shopify-gateway-token" }] },
  };

  for (const [name, input] of Object.entries(cases)) {
    await t.test(name, () => {
      const result = runFactory(input);
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /invalid factory input/);
    });
  }

  assert.throws(
    () =>
      personalPolicy.createProviderRuntimeSecrets({
        resolverResults: {
          "shopify-gateway-token": "must-not-be-consumed",
          "shopify-gateway-base": "https://must-not-be-consumed.example.test",
        },
        launchId: null,
      }),
    /fields must match the closed schema/,
  );
});

test("built personal artifacts select the catalog default through Pi auth", async (t) => {
  const expectedDefault = expectedCatalogDefault();
  const projection = createPersonalProjection();
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-personal-no-dispatch-"));
  const marker = path.join(markerRoot, "resolver-ran");
  t.after(() => fs.rmSync(markerRoot, { recursive: true, force: true }));

  assert.deepEqual(projection.value, {
    schemaVersion: 1,
    generation: managedConfig.generation,
    mode: "personal",
    default: {
      model: expectedDefault,
      reasoning: managedConfig.providerCatalog.defaults.personal.reasoning,
    },
    providers: [],
  });
  assert.deepEqual(managedConfig.settings.defaultModel, expectedDefault);
  assert.equal(
    managedConfig.settings.defaultThinkingLevel,
    managedConfig.providerCatalog.defaults.personal.reasoning,
  );
  assert.deepEqual(managedConfig.providerSelection, {
    mode: "personal",
    defaultModel: expectedDefault,
  });
  assert.deepEqual(Object.keys(managedConfig.providerCatalog.personal).sort(), [
    "api",
    "modelOverrides",
    "modelSource",
    "providerId",
    "requestPolicy",
    "role",
  ]);
  assert.equal(managedConfig.providerCatalog.personal.requestPolicy, "personal-pi-auth-v1");
  assert.equal("route" in managedConfig.providerCatalog.personal, false);
  assert.equal("headers" in managedConfig.providerCatalog.personal, false);

  const previousMarker = process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER;
  process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER = marker;
  let boundary;
  try {
    boundary = personalPolicy.createCredentialBoundary({
      resolverResults: {},
      launchId: null,
      environment: {
        HOME: "/Users/personal-fixture",
        PATH: "/usr/bin",
        OPENAI_API_KEY: ambientOpenAiSentinel,
        SHOPIFY_PI_TOKEN: "must-not-cross",
      },
    });
  } finally {
    if (previousMarker === undefined) delete process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER;
    else process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER = previousMarker;
  }

  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(boundary.resolvers, [{ kind: "pi-auth" }]);
  assert.deepEqual(Object.keys(boundary.resolvers[0]), ["kind"]);
  assert.equal("executable" in boundary.resolvers[0], false);
  assert.equal("argv" in boundary.resolvers[0], false);
  assert.equal(boundary.runtime.mode, "personal");
  assert.deepEqual(boundary.runtime.rootPiEnvironment, {});
  assert.deepEqual(boundary.runtime.childPiEnvironment, {});
  const exactRedactionValues = boundary.runtime.exactRedactionValues;
  assert.equal(exactRedactionValues.size, 0);
  assert.equal(typeof exactRedactionValues.has, "function");
  assert.equal(typeof exactRedactionValues.values, "function");
  assert.equal(exactRedactionValues.has(piAuthSentinel), false);
  assert.deepEqual([...exactRedactionValues.values()], []);
  assert.deepEqual([...exactRedactionValues], []);
  for (const serialize of [
    () => JSON.stringify(exactRedactionValues),
    () => JSON.stringify({ exactRedactionValues }),
  ]) {
    assert.throws(serialize, (error) => {
      assert.equal(error.message, exactRedactionSerializationError);
      assert.doesNotMatch(error.message, new RegExp(`${piAuthSentinel}|${ambientOpenAiSentinel}`));
      return true;
    });
  }
  assert.equal("OPENAI_API_KEY" in boundary.runtime.rootPiEnvironment, false);
  assertNonSerializable(boundary.runtime);
  assertNonSerializable(boundary.runtime.rootPiEnvironment);
  assertNonSerializable(boundary.runtime.childPiEnvironment);

  const state = createAgentState(t);
  const beforeAuth = fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8");
  const beforeModels = fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8");
  const execution = runReconciler(state.agentDir, projection.value);
  assert.equal(execution.process.status, 0, execution.process.stderr);
  assert.deepEqual(execution.value, {
    ok: true,
    generation: managedConfig.generation,
    changed: ["settings.json"],
  });
  assert.equal(fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8"), beforeAuth);
  assert.equal(fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8"), beforeModels);
  for (const relativePath of [
    "packages/state.json",
    "sessions/retained.jsonl",
    "trust.json",
  ]) {
    assert.equal(fs.readFileSync(path.join(state.agentDir, relativePath), "utf8"), state.files[relativePath]);
  }
  const nextSettings = readJson(path.join(state.agentDir, "settings.json"));
  const nextModels = readJson(path.join(state.agentDir, "models.json"));
  assert.deepEqual(nextSettings.packages, state.settings.packages);
  assert.deepEqual(nextSettings.unrelated, state.settings.unrelated);
  assert.deepEqual(nextModels.auth, state.models.auth);
  assert.deepEqual(nextModels.trust, state.models.trust);
  assert.deepEqual(nextModels.packages, state.models.packages);
  assert.deepEqual(nextModels.sessions, state.models.sessions);

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ambientOpenAiSentinel;
  try {
    const modelRuntime = await piExports.ModelRuntime.create({
      authPath: path.join(state.agentDir, "auth.json"),
      modelsPath: path.join(state.agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel(expectedDefault.provider, expectedDefault.modelId);
    assert.ok(model, "the catalog-owned built-in OpenAI model is unavailable");
    assert.equal(model.provider, "openai");
    assert.equal(model.id, "gpt-5.6-sol");
    assert.equal(model.api, "openai-responses");
    assert.equal(model.baseUrl, "https://api.openai.com/v1");
    assert.equal(modelRuntime.getRegisteredProviderConfig("openai"), undefined);
    const auth = await modelRuntime.getAuth(model);
    assert.equal(auth?.auth.apiKey, piAuthSentinel);
    assert.equal(auth?.source, "stored credential");
    assert.notEqual(auth?.auth.apiKey, ambientOpenAiSentinel);
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
  assert.equal(fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8"), beforeAuth);

  const generatedState = ["settings.json", "models.json", "ownership.json"]
    .map((name) => fs.readFileSync(path.join(state.agentDir, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(generatedState, new RegExp(`${piAuthSentinel}|${ambientOpenAiSentinel}`));
});

test("personal reconciliation preserves unowned providers including the same OpenAI ID", (t) => {
  const projection = createPersonalProjection().value;
  const providers = {
    local: {
      baseUrl: "https://local.example.test/v1",
      api: "openai-completions",
      headers: { "X-User-Header": "local-user-owned" },
    },
    openai: {
      baseUrl: "https://user-openai.example.test/v1",
      api: "openai-responses",
      apiKey: "${USER_OPENAI_API_KEY}",
      headers: { "X-User-Header": "same-id-user-owned" },
    },
  };
  const state = createAgentState(t, providers);
  const beforeModels = fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8");
  const beforeAuth = fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8");
  const execution = runReconciler(state.agentDir, projection);

  assert.equal(execution.process.status, 0, execution.process.stderr);
  assert.deepEqual(execution.value.changed, ["settings.json"]);
  assert.equal(fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8"), beforeModels);
  assert.equal(fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8"), beforeAuth);
  assert.deepEqual(readJson(path.join(state.agentDir, "models.json")).providers, providers);
  assert.equal("models.json" in readJson(path.join(state.agentDir, "ownership.json")).files, false);
});

test("personal runtime artifacts contain no Shopify provider surface", () => {
  const projection = createPersonalProjection();
  const runtime = personalPolicy.createProviderRuntimeSecrets({
    resolverResults: {},
    launchId: null,
  });
  const structuralSurface = JSON.stringify({
    mode: runtime.mode,
    default: projection.value.default,
    providers: projection.value.providers,
    resolverPlans: personalPolicy.resolverPlans,
    rootEnvironmentNames: Object.keys(runtime.rootPiEnvironment),
    childEnvironmentNames: Object.keys(runtime.childPiEnvironment),
    exactRedactionSize: runtime.exactRedactionValues.size,
    requestPolicy: managedConfig.providerCatalog.personal.requestPolicy,
  });

  assert.doesNotMatch(structuralSurface, /shopify|gateway|devx|authorization|header|token/i);
  assert.doesNotMatch(projection.bytes, /shopify|gateway|devx|authorization|header|token/i);

  const generatedClosure = closureText(personalPolicyOutput);
  const forbiddenSurfaces = [
    /https?:\/\/[^\s"'`]*shopify/i,
    /X-Shopify-Session-Affinity-Header/i,
    /Shopify-Usage-Tag/i,
    /\$\{SHOPIFY_PI_TOKEN\}/,
    /Bearer\s+\$\{SHOPIFY_PI_TOKEN\}/,
    /\/nix\/store\/[^\s"']+-devx\/bin\/devx/,
    /\bllm-gateway\b/,
    /\bprint-token\b/,
  ];
  for (const forbidden of forbiddenSurfaces) {
    assert.doesNotMatch(generatedClosure, forbidden);
  }
});
