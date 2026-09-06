import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixturePath = "tests/pi-agent/fixtures/shopify-host.nix";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const extensionOrder = [
  "cavemem",
  "mcp",
  "subagents",
  "plan",
  "timestamps",
  "bashTimeout",
  "questions",
  "codeIntelligence",
  "backgroundTasks",
];
const extensionRelativePaths = {
  backgroundTasks: "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts",
  bashTimeout: "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts",
  cavemem: "lib/pi-agent/extensions/cavemem/index.ts",
  codeIntelligence: "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts",
  mcp: "lib/pi-agent/extensions/mcpproxy/index.ts",
  plan: "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  questions: "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts",
  subagents: "lib/node_modules/pi-subagents/index.ts",
  timestamps: "lib/node_modules/@narumitw/pi-stamp/src/index.ts",
};
const shopifyRoles = ["anthropic", "openai", "google", "groq", "xai"];
const routeSuffixes = {
  anthropic: "/apis/anthropic/v1",
  openai: "/vendors/openai/v1",
  google:
    "/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google",
  groq: "/vendors/groq/openai/v1",
  xai: "/vendors/xai/v1",
};

function fixtureExpression(fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-shopify-host-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
    in import (repoSource + "/${fixturePath}") {
      repoRoot = repoSource;
      fixture = ${JSON.stringify(fixture)};
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

function shopifyFixture() {
  const result = evaluateFixture("shopify");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejectedFixture(fixture, expectedDiagnostic) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated: ${result.stdout}`);
  assert.match(`${result.stderr}\n${result.stdout}`, expectedDiagnostic);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readTextTree(root) {
  if (fs.statSync(root).isFile()) {
    return fs.readFileSync(root, "utf8");
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => readTextTree(path.join(root, entry.name)))
    .join("\n");
}

function runProjectionFactory(factory, input) {
  const result = childProcess.spawnSync(path.join(factory, "bin/pi-agent-provider-projection"), [], {
    ...commandOptions,
    input: `${JSON.stringify(input)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function expectedCatalog() {
  return [
    {
      api: "anthropic-messages",
      modelOverrides: "none",
      modelSource: "pi-0.83.0-built-in:anthropic",
      providerId: "anthropic",
      requestPolicy: "shopify-standard-v1",
      role: "anthropic",
      route: {
        owner: "pi-agent-module",
        role: "anthropic-api-v1",
        suffix: routeSuffixes.anthropic,
      },
    },
    {
      api: "openai-responses",
      modelOverrides: "none",
      modelSource: "pi-0.83.0-built-in:openai",
      providerId: "openai",
      requestPolicy: "shopify-standard-v1",
      role: "openai",
      route: {
        owner: "pi-agent-module",
        role: "openai-vendor-v1",
        suffix: routeSuffixes.openai,
      },
    },
    {
      api: "google-generative-ai",
      modelOverrides: "none",
      modelSource: "pi-0.83.0-built-in:google",
      providerId: "google",
      requestPolicy: "shopify-google-bearer-v1",
      role: "google",
      route: {
        owner: "pi-agent-module",
        role: "google-vertex-global",
        suffix: routeSuffixes.google,
      },
    },
    {
      api: "openai-completions",
      modelOverrides: "none",
      modelSource: "pi-0.83.0-built-in:groq",
      providerId: "groq",
      requestPolicy: "shopify-standard-v1",
      role: "groq",
      route: {
        owner: "pi-agent-module",
        role: "groq-openai-v1",
        suffix: routeSuffixes.groq,
      },
    },
    {
      api: "pi-per-model",
      modelOverrides: "none",
      modelSource: "pi-0.83.0-built-in:xai",
      providerId: "xai",
      requestPolicy: "shopify-standard-v1",
      role: "xai",
      route: {
        owner: "pi-agent-module",
        role: "xai-vendor-v1",
        suffix: routeSuffixes.xai,
      },
    },
  ];
}

function expectedAffinityHeaders() {
  return [
    {
      name: "X-Shopify-Session-Affinity-Header",
      value: { kind: "fixed-public-literal", value: "pi-agent-session-id" },
    },
    {
      name: "pi-agent-session-id",
      value: {
        kind: "environment-reference",
        name: "PI_AGENT_LAUNCH_ID",
        template: "${PI_AGENT_LAUNCH_ID}",
      },
    },
    {
      name: "Shopify-Usage-Tag",
      value: { kind: "fixed-public-literal", value: "pi-agent" },
    },
  ];
}

function expectedCredential() {
  return {
    field: "apiKey",
    value: {
      kind: "environment-reference",
      name: "SHOPIFY_PI_TOKEN",
      template: "${SHOPIFY_PI_TOKEN}",
    },
  };
}

test("Shopify host renders the exact closed managed surface", () => {
  const result = shopifyFixture();

  assert.equal(result.enable, true);
  assert.deepEqual(result.provider, {
    mode: "shopify-gateway",
    enabledRoles: shopifyRoles,
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(result.sandbox, { defaultState: "audit" });
  assert.deepEqual(result.mcp, { cacheTtlDays: 7, port: 8080 });
  assert.equal(result.cavememDataDir, result.hostCavememDataDir);
  assert.equal(result.cavememDataDir, "/tmp/pi-agent-shopify-host/.local/share/cavemem");
  assert.match(result.providerHandoff, /^\/nix\/store\//);
  assert.deepEqual(
    result.resolverPlans.map(({ kind, executable }) => ({ kind, executable: /^\/nix\/store\//.test(executable) })),
    [
      { kind: "shopify-gateway-token", executable: true },
      { kind: "shopify-gateway-base", executable: true },
    ],
  );
  assert.deepEqual(Object.keys(result.extensionRefs).sort(), [...extensionOrder].sort());
  for (const [name, ref] of Object.entries(result.extensionRefs)) {
    assert.match(ref.package, /^\/nix\/store\//);
    assert.equal(ref.relativePath, extensionRelativePaths[name]);
  }
  assert.match(result.extensionManifest, /^\/nix\/store\/[^/]+\/share\/pi-agent\/extensions\.json$/);
  assert.match(result.extensionIdentity, /^\/nix\/store\/[^/]+\/extensions-provenance\.json$/);
  assert.equal(result.instructionRefs.length, 3);
  assert.deepEqual(
    result.instructionRefs.map(({ relativePath }) => relativePath),
    ["share/pi-agent/instructions.md", "share/pi-agent/shopify.md", "share/pi-agent/guide.md"],
  );
  assert.ok(result.instructionRefs.every(({ package: packagePath }) => /^\/nix\/store\//.test(packagePath)));
  assert.equal(
    fs.readFileSync(
      path.join(result.instructionRefs[1].package, result.instructionRefs[1].relativePath),
      "utf8",
    ),
    "# Shopify host instructions\n\nApply Shopify host constraints only for host-scoped agents and keep personal-host profiles free of Shopify-only workflow text.\n",
  );
  assert.deepEqual(
    result.instructionResources,
    result.instructionRefs.map(({ package: packagePath, relativePath }) => `${packagePath}/${relativePath}`),
  );
  assert.deepEqual(Object.keys(result.profilePaths).sort(), ["pi-audit", "pi-managed", "pi-review"]);
  assert.match(result.managedConfig, /^\/nix\/store\//);
  assert.match(result.projectionFactory, /^\/nix\/store\//);
  assert.deepEqual(result.selected.providerSelection, {
    mode: "shopify-gateway",
    enabledRoles: shopifyRoles,
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(result.selected.defaultModel, { provider: "openai", modelId: "gpt-5.6-sol" });
  assert.equal(result.selected.defaultThinkingLevel, "xhigh");
  assert.deepEqual(result.selected.extensionOrder, extensionOrder);
  assert.deepEqual(result.selected.instructionResources, result.instructionResources);
  assert.equal(result.selected.mcpEndpoint, "http://127.0.0.1:8080/mcp");
  assert.equal(result.selected.sandboxDefault, "audit");
  assert.deepEqual(result.selected.providerCatalog.shopify, expectedCatalog());
  assert.deepEqual(result.selected.providerCatalog.defaults.shopify, {
    model: "openai/gpt-5.6-sol",
    reasoning: "xhigh",
  });
});

test("Shopify projection contains only catalog routes and credential templates", () => {
  const result = shopifyFixture();
  const managedConfig = readJson(result.managedConfig);
  const baseUrl = "https://gateway.example.test";
  const projection = runProjectionFactory(result.projectionFactory, {
    schemaVersion: 1,
    generation: managedConfig.generation,
    providerSelection: managedConfig.providerSelection,
    joinedUrls: Object.fromEntries(
      shopifyRoles.map((role) => [role, `${baseUrl}${routeSuffixes[role]}`]),
    ),
  });
  const credential = expectedCredential();
  const affinityHeaders = expectedAffinityHeaders();

  assert.deepEqual(projection, {
    schemaVersion: 1,
    generation: managedConfig.generation,
    mode: "shopify-gateway",
    default: {
      model: { provider: "openai", modelId: "gpt-5.6-sol" },
      reasoning: "xhigh",
    },
    providers: [
      {
        providerId: "anthropic",
        catalogRole: "anthropic",
        baseUrl: `${baseUrl}${routeSuffixes.anthropic}`,
        api: { kind: "provider-api", value: "anthropic-messages" },
        modelCatalog: { source: "pi-0.83.0-built-in:anthropic", overrides: [] },
        credential,
        headers: affinityHeaders,
      },
      {
        providerId: "openai",
        catalogRole: "openai",
        baseUrl: `${baseUrl}${routeSuffixes.openai}`,
        api: { kind: "provider-api", value: "openai-responses" },
        modelCatalog: { source: "pi-0.83.0-built-in:openai", overrides: [] },
        credential,
        headers: affinityHeaders,
      },
      {
        providerId: "google",
        catalogRole: "google",
        baseUrl: `${baseUrl}${routeSuffixes.google}`,
        api: { kind: "provider-api", value: "google-generative-ai" },
        modelCatalog: { source: "pi-0.83.0-built-in:google", overrides: [] },
        credential,
        headers: [
          ...affinityHeaders,
          {
            name: "Authorization",
            value: {
              kind: "bearer-environment-reference",
              name: "SHOPIFY_PI_TOKEN",
              template: "Bearer ${SHOPIFY_PI_TOKEN}",
            },
          },
        ],
      },
      {
        providerId: "groq",
        catalogRole: "groq",
        baseUrl: `${baseUrl}${routeSuffixes.groq}`,
        api: { kind: "provider-api", value: "openai-completions" },
        modelCatalog: { source: "pi-0.83.0-built-in:groq", overrides: [] },
        credential,
        headers: affinityHeaders,
      },
      {
        providerId: "xai",
        catalogRole: "xai",
        baseUrl: `${baseUrl}${routeSuffixes.xai}`,
        api: { kind: "pi-per-model-api", providerApiField: "omit" },
        modelCatalog: { source: "pi-0.83.0-built-in:xai", overrides: [] },
        credential,
        headers: affinityHeaders,
      },
    ],
  });

  const projectionText = JSON.stringify(projection);
  const generatedArtifactText = [
    fs.readFileSync(result.managedConfig, "utf8"),
    readTextTree(result.projectionFactory),
    projectionText,
  ].join("\n");
  assert.doesNotMatch(generatedArtifactText, /resolved-token|resolved-launch-id/i);
  assert.doesNotMatch(generatedArtifactText, /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  assert.doesNotMatch(projectionText, /devx|resolver/i);
  assert.match(projectionText, /\$\{SHOPIFY_PI_TOKEN\}/);
  assert.match(projectionText, /\$\{PI_AGENT_LAUNCH_ID\}/);
});

test("Shopify host rejects host-authored provider escape hatches structurally", async (t) => {
  const cases = {
    "shopify-routes": /programs\.pi-agent\.provider\.routes/,
    "shopify-apis": /programs\.pi-agent\.provider\.apis/,
    "shopify-headers": /programs\.pi-agent\.provider\.headers/,
    "shopify-resolver-argv": /programs\.pi-agent\.provider\.resolverArgv/,
    "shopify-store-paths": /programs\.pi-agent\.provider\.storePaths/,
  };

  for (const [fixture, diagnostic] of Object.entries(cases)) {
    await t.test(fixture, () => rejectedFixture(fixture, diagnostic));
  }
});
