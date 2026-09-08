import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const rendererPath = path.join(repoRoot, "home-manager/common/pi-agent/managed-config.nix");
const factoryExecutable = "bin/pi-agent-provider-projection";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const roles = ["anthropic", "openai", "google", "groq", "xai"];
const tokenTemplate = "${SHOPIFY_PI_TOKEN}";
const launchTemplate = "${PI_AGENT_LAUNCH_ID}";
const tokenSentinel = "task-2-2-token-sentinel";
const uuidSentinel = "7f7c53f9-43e7-46b4-bf9c-8d7764cf00d2";
const injectedApiKey = "task-2.2-injected-api-key-sentinel";
const injectedContextWindow = 424242;
const hostilePackagePath = "/tmp/pi-agent-host-path";

const tokenReference = {
  kind: "environment-reference",
  name: "SHOPIFY_PI_TOKEN",
  template: tokenTemplate,
};
const launchReference = {
  kind: "environment-reference",
  name: "PI_AGENT_LAUNCH_ID",
  template: launchTemplate,
};
const affinityHeaders = [
  {
    name: "X-Shopify-Session-Affinity-Header",
    value: { kind: "fixed-public-literal", value: "pi-agent-session-id" },
  },
  { name: "pi-agent-session-id", value: launchReference },
  {
    name: "Shopify-Usage-Tag",
    value: { kind: "fixed-public-literal", value: "pi-agent" },
  },
];
const googleHeaders = [
  ...affinityHeaders,
  {
    name: "Authorization",
    value: {
      kind: "bearer-environment-reference",
      name: "SHOPIFY_PI_TOKEN",
      template: `Bearer ${tokenTemplate}`,
    },
  },
];

const providerCatalog = {
  schemaVersion: 1,
  personal: {
    role: "personal-openai",
    providerId: "openai",
    api: "openai-responses",
    modelSource: "pi-0.83.0-built-in:openai",
    modelOverrides: "none",
    requestPolicy: "personal-pi-auth-v1",
  },
  shopify: [
    {
      role: "anthropic",
      providerId: "anthropic",
      route: {
        owner: "pi-agent-module",
        role: "anthropic-api-v1",
        suffix: "/apis/anthropic/v1",
      },
      api: "anthropic-messages",
      modelSource: "pi-0.83.0-built-in:anthropic",
      modelOverrides: "none",
      requestPolicy: "shopify-standard-v1",
    },
    {
      role: "openai",
      providerId: "openai",
      route: {
        owner: "pi-agent-module",
        role: "openai-vendor-v1",
        suffix: "/vendors/openai/v1",
      },
      api: "openai-responses",
      modelSource: "pi-0.83.0-built-in:openai",
      modelOverrides: "none",
      requestPolicy: "shopify-standard-v1",
    },
    {
      role: "google",
      providerId: "google",
      route: {
        owner: "pi-agent-module",
        role: "google-vertex-global",
        suffix:
          "/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google",
      },
      api: "google-generative-ai",
      modelSource: "pi-0.83.0-built-in:google",
      modelOverrides: "none",
      requestPolicy: "shopify-google-bearer-v1",
    },
    {
      role: "groq",
      providerId: "groq",
      route: {
        owner: "pi-agent-module",
        role: "groq-openai-v1",
        suffix: "/vendors/groq/openai/v1",
      },
      api: "openai-completions",
      modelSource: "pi-0.83.0-built-in:groq",
      modelOverrides: "none",
      requestPolicy: "shopify-standard-v1",
    },
    {
      role: "xai",
      providerId: "xai",
      route: {
        owner: "pi-agent-module",
        role: "xai-vendor-v1",
        suffix: "/vendors/xai/v1",
      },
      api: "pi-per-model",
      modelSource: "pi-0.83.0-built-in:xai",
      modelOverrides: "none",
      requestPolicy: "shopify-standard-v1",
    },
  ],
  defaults: {
    personal: { model: "openai/gpt-5.6-sol", reasoning: "xhigh" },
    shopify: { model: "openai/gpt-5.6-sol", reasoning: "xhigh" },
  },
  unsupported: [
    { providerId: "cohere", policy: "reject", reason: "no-pi-core-api" },
    {
      providerId: "perplexity",
      policy: "reject",
      reason: "no-required-coding-tool-path",
    },
  ],
};

const joinedUrls = {
  anthropic: "https://gateway.example.test/apis/anthropic/v1",
  openai: "https://gateway.example.test/vendors/openai/v1",
  google:
    "https://gateway.example.test/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google",
  groq: "https://gateway.example.test/vendors/groq/openai/v1",
  xai: "https://gateway.example.test/vendors/xai/v1",
};

function fixtureExpression(fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-managed-config-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
    in
      import (repoSource + "/tests/pi-agent/fixtures/managed-config.nix") {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = repoSource;
      }
  `;
}

function evaluateFixture(fixture) {
  return childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixture)],
    commandOptions,
  );
}

function validFixture(fixture) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejectedFixture(fixture, diagnostics) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated: ${result.stdout}`);
  const output = `${result.stderr}\n${result.stdout}`;

  for (const diagnostic of diagnostics) {
    assert.match(output, diagnostic, `${fixture} did not emit ${diagnostic}:\n${output}`);
  }
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
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1);
  return outputs[0];
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function runFactory(factory, input, options = {}) {
  return childProcess.spawnSync(path.join(factory, factoryExecutable), options.argv ?? [], {
    ...commandOptions,
    env: {
      ...process.env,
      ...(options.environment ?? {}),
    },
    input: options.rawInput ?? `${JSON.stringify(input)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function expectedProvider(entry) {
  return {
    providerId: entry.providerId,
    catalogRole: entry.role,
    baseUrl: joinedUrls[entry.role],
    api:
      entry.role === "xai"
        ? { kind: "pi-per-model-api", providerApiField: "omit" }
        : { kind: "provider-api", value: entry.api },
    modelCatalog: { source: entry.modelSource, overrides: [] },
    credential: { field: "apiKey", value: tokenReference },
    headers: entry.role === "google" ? googleHeaders : affinityHeaders,
  };
}

function shopifyFactoryInput(generation = "task-2.2-runtime-v1") {
  return {
    schemaVersion: 1,
    generation,
    providerSelection: {
      mode: "shopify-gateway",
      enabledRoles: ["xai", "groq", "google", "openai", "anthropic"],
      defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
    },
    joinedUrls,
  };
}

function expectedShopifyProjection(generation = "task-2.2-runtime-v1") {
  return {
    schemaVersion: 1,
    generation,
    mode: "shopify-gateway",
    default: {
      model: { provider: "openai", modelId: "gpt-5.6-sol" },
      reasoning: "xhigh",
    },
    providers: providerCatalog.shopify.map(expectedProvider),
  };
}

function readTree(root) {
  const chunks = [];

  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      chunks.push(fs.readlinkSync(target));
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        visit(path.join(target, entry));
      }
    } else {
      chunks.push(fs.readFileSync(target, "utf8"));
    }
  }

  visit(root);
  return chunks.join("\n");
}

test("the planned managed-config renderer exists", () => {
  assert.ok(fs.existsSync(rendererPath), "missing home-manager/common/pi-agent/managed-config.nix");
});

test("ManagedConfigV1 renders the exact fixed catalog and package-backed paths", () => {
  const managedConfigPath = buildFixture("shopify-managed-config");
  const config = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));
  const paths = validFixture("path-expectations");

  assert.deepEqual(config, {
    schemaVersion: 1,
    generation: "task-2.2-managed-v1",
    agentDir: "pi-default",
    agentMemory: {
      url: "http://127.0.0.1:3111",
      secretReference: "agentmemory-bearer",
    },
    settings: {
      defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
      defaultThinkingLevel: "xhigh",
      shellPath: config.settings.shellPath,
      installTelemetry: false,
      selfUpdate: false,
      unmanagedPackages: false,
    },
    timeouts: { bashDefaultMs: 543210 },
    providerCatalog,
    providerSelection: {
      mode: "shopify-gateway",
      enabledRoles: roles,
      defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
    },
    extensionManifest: paths.extensionManifest,
    extensionOrder: [
      "agentmemory",
      "mcp",
      "subagents",
      "plan",
      "timestamps",
      "bashTimeout",
      "questions",
      "codeIntelligence",
      "backgroundTasks",
    ],
    instructionResources: paths.instructionResources,
    lspExecutables: paths.lspExecutables,
    mcpEndpoint: "http://127.0.0.1:8080/mcp",
    sandboxDefault: "audit",
  });

  for (const renderedPath of [
    config.settings.shellPath,
    config.extensionManifest,
    ...config.instructionResources,
    ...Object.values(config.lspExecutables),
  ]) {
    assert.match(renderedPath, /^\/nix\/store\/[^/]+\/.+/);
  }
  assert.equal(fs.readFileSync(managedConfigPath, "utf8"), canonicalJson(config));
});

test("remediation RED: managed config projects only declared model fields", () => {
  const managedConfigPath = buildFixture("malicious-model-managed-config");
  const config = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));

  assert.deepEqual(config.settings.defaultModel, {
    provider: "openai",
    modelId: "gpt-5.6-sol",
  });
  assert.deepEqual(config.providerSelection.defaultModel, {
    provider: "openai",
    modelId: "gpt-5.6-sol",
  });
  assert.doesNotMatch(
    fs.readFileSync(managedConfigPath, "utf8"),
    new RegExp(`${injectedApiKey}|apiKey|contextWindow|${injectedContextWindow}`),
  );
});

test("remediation RED: factory consumes the maliciously reopened renderer selection safely", () => {
  const managedConfigPath = buildFixture("malicious-model-managed-config");
  const factory = buildFixture("malicious-model-projection-factory");
  const config = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));
  const result = runFactory(factory, {
    schemaVersion: 1,
    generation: config.generation,
    providerSelection: config.providerSelection,
    joinedUrls,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${canonicalJson(expectedShopifyProjection(config.generation))}\n`);
  assert.doesNotMatch(
    result.stdout,
    new RegExp(`${injectedApiKey}|apiKey.*${injectedApiKey}|contextWindow|${injectedContextWindow}`),
  );
});

test("remediation RED: package paths use validated selected outPath instead of coercion", () => {
  const managedConfigPath = buildFixture("hostile-package-managed-config");
  const config = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));
  const paths = validFixture("path-expectations");

  assert.equal(config.extensionManifest, paths.extensionManifest);
  assert.deepEqual(config.instructionResources, paths.instructionResources);
  assert.deepEqual(config.lspExecutables, paths.lspExecutables);
  assert.doesNotMatch(fs.readFileSync(managedConfigPath, "utf8"), new RegExp(hostilePackagePath));
});

test("the factory emits catalog-ordered PersistedProviderProjectionV1 bytes", () => {
  const factory = buildFixture("shopify-projection-factory");
  const result = runFactory(factory, shopifyFactoryInput());
  const expected = expectedShopifyProjection();

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${canonicalJson(expected)}\n`);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(
    JSON.parse(result.stdout).providers.map((provider) => provider.providerId),
    roles,
  );

  const google = JSON.parse(result.stdout).providers.find(({ providerId }) => providerId === "google");
  const xai = JSON.parse(result.stdout).providers.find(({ providerId }) => providerId === "xai");
  assert.deepEqual(google.headers, googleHeaders);
  assert.deepEqual(xai.api, { kind: "pi-per-model-api", providerApiField: "omit" });
  assert.equal("value" in xai.api, false);
});

test("personal projection preserves Pi auth without a provider override", () => {
  const factory = buildFixture("personal-projection-factory");
  const managedConfigPath = buildFixture("personal-managed-config");
  const managedConfig = JSON.parse(fs.readFileSync(managedConfigPath, "utf8"));
  const input = {
    schemaVersion: 1,
    generation: managedConfig.generation,
    providerSelection: managedConfig.providerSelection,
    joinedUrls: {},
  };
  const expected = {
    schemaVersion: 1,
    generation: input.generation,
    mode: "personal",
    default: {
      model: input.providerSelection.defaultModel,
      reasoning: "xhigh",
    },
    providers: [],
  };
  const result = runFactory(factory, input);

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${canonicalJson(expected)}\n`);
  assert.deepEqual(managedConfig.providerSelection, {
    mode: "personal",
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), [
    "default",
    "generation",
    "mode",
    "providers",
    "schemaVersion",
  ]);
});

test("factory output is stable across process secrets and changes with generation", () => {
  const factory = buildFixture("shopify-projection-factory");
  const input = shopifyFactoryInput();
  const first = runFactory(factory, input, {
    environment: {
      SHOPIFY_PI_TOKEN: tokenSentinel,
      PI_AGENT_LAUNCH_ID: uuidSentinel,
    },
  });
  const second = runFactory(factory, input, {
    environment: {
      SHOPIFY_PI_TOKEN: "different-token-sentinel",
      PI_AGENT_LAUNCH_ID: "20128b61-cd11-4697-871d-85e865caa881",
    },
  });
  const next = runFactory(factory, shopifyFactoryInput("task-2.2-runtime-v2"));

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.notEqual(first.stdout, next.stdout);
  assert.equal(JSON.parse(next.stdout).generation, "task-2.2-runtime-v2");
  assert.doesNotMatch(first.stdout, new RegExp(`${tokenSentinel}|${uuidSentinel}`));
});

test("factory schema rejects every runtime or extension input channel", async (t) => {
  const factory = buildFixture("shopify-projection-factory");
  const forbiddenInputs = {
    token: { ...shopifyFactoryInput(), token: tokenSentinel },
    launchUuid: { ...shopifyFactoryInput(), launchUuid: uuidSentinel },
    headers: { ...shopifyFactoryInput(), headers: { Authorization: tokenSentinel } },
    argv: { ...shopifyFactoryInput(), argv: ["--token", tokenSentinel] },
    resolvers: { ...shopifyFactoryInput(), resolvers: { custom: "fixture" } },
    modelMetadata: { ...shopifyFactoryInput(), modelMetadata: { contextWindow: 1 } },
    publicLiterals: { ...shopifyFactoryInput(), publicLiterals: { usage: "fixture" } },
    nestedModelMetadata: {
      ...shopifyFactoryInput(),
      providerSelection: {
        ...shopifyFactoryInput().providerSelection,
        defaultModel: {
          ...shopifyFactoryInput().providerSelection.defaultModel,
          contextWindow: 1,
        },
      },
    },
  };

  for (const [name, input] of Object.entries(forbiddenInputs)) {
    await t.test(name, () => {
      const result = runFactory(factory, input);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /invalid factory input/);
      assert.doesNotMatch(result.stderr, new RegExp(`${tokenSentinel}|${uuidSentinel}`));
    });
  }

  await t.test("command arguments", () => {
    const result = runFactory(factory, shopifyFactoryInput(), {
      argv: ["--token", tokenSentinel],
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /does not accept command arguments/);
    assert.doesNotMatch(result.stderr, new RegExp(tokenSentinel));
  });
});

test("factory validates exact selected roles and already joined HTTPS URLs", async (t) => {
  const factory = buildFixture("shopify-projection-factory");
  const cases = {
    "unknown schema": { ...shopifyFactoryInput(), schemaVersion: 2 },
    "duplicate role": {
      ...shopifyFactoryInput(),
      providerSelection: {
        ...shopifyFactoryInput().providerSelection,
        enabledRoles: ["openai", "openai"],
      },
      joinedUrls: { openai: joinedUrls.openai },
    },
    "missing selected URL": {
      ...shopifyFactoryInput(),
      joinedUrls: Object.fromEntries(
        Object.entries(joinedUrls).filter(([role]) => role !== "groq"),
      ),
    },
    "extra URL role": {
      ...shopifyFactoryInput(),
      joinedUrls: { ...joinedUrls, cohere: "https://gateway.example.test/cohere" },
    },
    "disabled default provider": {
      ...shopifyFactoryInput(),
      providerSelection: {
        ...shopifyFactoryInput().providerSelection,
        enabledRoles: ["anthropic"],
      },
      joinedUrls: { anthropic: joinedUrls.anthropic },
    },
    "non-HTTPS URL": {
      ...shopifyFactoryInput(),
      joinedUrls: { ...joinedUrls, openai: joinedUrls.openai.replace("https:", "http:") },
    },
    "URL userinfo": {
      ...shopifyFactoryInput(),
      joinedUrls: {
        ...joinedUrls,
        openai: joinedUrls.openai.replace("https://", "https://token@"),
      },
    },
    "URL query": {
      ...shopifyFactoryInput(),
      joinedUrls: { ...joinedUrls, openai: `${joinedUrls.openai}?token=fixture` },
    },
    "URL fragment": {
      ...shopifyFactoryInput(),
      joinedUrls: { ...joinedUrls, openai: `${joinedUrls.openai}#fragment` },
    },
    "wrong joined route": {
      ...shopifyFactoryInput(),
      joinedUrls: { ...joinedUrls, openai: "https://gateway.example.test/v1" },
    },
  };

  for (const [name, input] of Object.entries(cases)) {
    await t.test(name, () => {
      const result = runFactory(factory, input);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /invalid factory input/);
    });
  }
});

test("disabled mode emits no managed artifacts and unsupported systems fail actionably", () => {
  assert.deepEqual(validFixture("disabled"), {
    managedConfigIsNull: true,
    projectionFactoryIsNull: true,
    emittedConfigKeys: [],
  });
  rejectedFixture("unsupported-system", [
    /programs\.pi-agent/,
    /supports only aarch64-darwin/,
    /disable programs\.pi-agent\.enable/,
  ]);
});

test("managed artifacts are closed read-only internal module outputs", async (t) => {
  await t.test("managed config", () => {
    rejectedFixture("internal-managed-config-override", [
      /programs\.pi-agent\.internal\.managedConfig/,
      /read-only/,
    ]);
  });
  await t.test("projection factory", () => {
    rejectedFixture("internal-projection-factory-override", [
      /programs\.pi-agent\.internal\.projectionFactory/,
      /read-only/,
    ]);
  });
  await t.test("unknown output", () => {
    rejectedFixture("internal-unknown-output", [
      /programs\.pi-agent\.internal\.runtimeSecrets/,
      /does not exist/,
    ]);
  });
});

test("generated immutable artifacts contain templates but no runtime sentinels", () => {
  const managedConfig = buildFixture("shopify-managed-config");
  const factory = buildFixture("shopify-projection-factory");
  const projection = runFactory(factory, shopifyFactoryInput(), {
    environment: {
      SHOPIFY_PI_TOKEN: tokenSentinel,
      PI_AGENT_LAUNCH_ID: uuidSentinel,
    },
  });
  const generated = [fs.readFileSync(managedConfig, "utf8"), readTree(factory), projection.stdout].join(
    "\n",
  );

  assert.equal(projection.status, 0, projection.stderr);
  assert.match(projection.stdout, /\$\{SHOPIFY_PI_TOKEN\}/);
  assert.match(projection.stdout, /\$\{PI_AGENT_LAUNCH_ID\}/);
  assert.doesNotMatch(generated, new RegExp(`${tokenSentinel}|${uuidSentinel}`));
});
