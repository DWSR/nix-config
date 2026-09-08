import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixturePath = "tests/pi-agent/fixtures/personal-host.nix";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const extensionOrder = [
  "agentmemory",
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
  agentmemory: "lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts",
  codeIntelligence: "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts",
  mcp: "lib/pi-agent/extensions/mcpproxy/index.ts",
  plan: "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  questions: "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts",
  subagents: "lib/node_modules/pi-subagents/index.ts",
  timestamps: "lib/node_modules/@narumitw/pi-stamp/src/index.ts",
};

function fixtureExpression(fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-personal-host-source";
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

function personalFixture() {
  const result = evaluateFixture("personal");
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

function runPersonalFactory(factory, input) {
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

test("personal host renders the exact common managed surface", () => {
  const result = personalFixture();

  assert.equal(result.enable, true);
  assert.deepEqual(result.provider, {
    mode: "personal",
    enabledRoles: [],
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(result.sandbox, { defaultState: "audit" });
  assert.deepEqual(result.mcp, { cacheTtlDays: 7, port: 8080 });
  assert.equal(result.agentMemoryUrl, "http://127.0.0.1:3111");
  assert.equal(result.agentMemorySecretReference, "agentmemory-bearer");
  assert.equal(result.providerHandoff, null);
  assert.deepEqual(result.resolverPlans, [{ kind: "pi-auth" }]);
  assert.deepEqual(Object.keys(result.extensionRefs).sort(), [...extensionOrder].sort());
  for (const [name, ref] of Object.entries(result.extensionRefs)) {
    assert.match(ref.package, /^\/nix\/store\//);
    assert.equal(ref.relativePath, extensionRelativePaths[name]);
  }
  assert.match(result.extensionManifest, /^\/nix\/store\/[^/]+\/share\/pi-agent\/extensions\.json$/);
  assert.match(result.extensionIdentity, /^\/nix\/store\/[^/]+\/extensions-provenance\.json$/);
  assert.ok(result.instructionResources.length >= 2);
  assert.ok(result.instructionResources.every((value) => /^\/nix\/store\//.test(value)));
  assert.deepEqual(Object.keys(result.profilePaths).sort(), ["pi-audit", "pi-managed", "pi-review"]);
  assert.match(result.managedConfig, /^\/nix\/store\//);
  assert.match(result.projectionFactory, /^\/nix\/store\//);
  assert.deepEqual(result.selected.providerSelection, {
    mode: "personal",
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(result.selected.defaultModel, { provider: "openai", modelId: "gpt-5.6-sol" });
  assert.equal(result.selected.defaultThinkingLevel, "xhigh");
  assert.deepEqual(result.selected.extensionOrder, extensionOrder);
  assert.deepEqual(result.selected.instructionResources, result.instructionResources);
  assert.equal(result.selected.mcpEndpoint, "http://127.0.0.1:8080/mcp");
  assert.equal(result.selected.sandboxDefault, "audit");
  assert.deepEqual(result.selected.personalCatalog, {
    api: "openai-responses",
    modelOverrides: "none",
    modelSource: "pi-0.83.0-built-in:openai",
    providerId: "openai",
    requestPolicy: "personal-pi-auth-v1",
    role: "personal-openai",
  });
  assert.equal("route" in result.selected.personalCatalog, false);
  assert.equal("headers" in result.selected.personalCatalog, false);
});

test("personal projection is structurally empty of Shopify provider state", () => {
  const result = personalFixture();
  const managedConfig = readJson(result.managedConfig);
  const projection = runPersonalFactory(result.projectionFactory, {
    schemaVersion: 1,
    generation: managedConfig.generation,
    providerSelection: managedConfig.providerSelection,
    joinedUrls: {},
  });

  assert.deepEqual(projection, {
    schemaVersion: 1,
    generation: managedConfig.generation,
    mode: "personal",
    default: {
      model: { provider: "openai", modelId: "gpt-5.6-sol" },
      reasoning: "xhigh",
    },
    providers: [],
  });
  assert.deepEqual(result.resolverPlans, [{ kind: "pi-auth" }]);
  assert.equal(result.providerHandoff, null);
  assert.equal("providers" in result.selected.providerSelection, false);
  assert.equal("resolvers" in result.selected.providerSelection, false);
  assert.equal("runtime" in result.selected.providerSelection, false);
  assert.doesNotMatch(JSON.stringify(projection), /gateway|shopify|token|authorization|header|devx/i);
});

test("personal host rejects Shopify roles, resolvers, provider objects, and runtime values structurally", async (t) => {
  const cases = {
    "personal-shopify-role": /personal mode does not accept Shopify enabled roles/,
    "personal-shopify-resolver": /programs\.pi-agent\.provider\.resolvers/,
    "personal-provider-object": /programs\.pi-agent\.provider\.providerObjects/,
    "personal-runtime-value": /programs\.pi-agent\.provider\.runtime/,
  };

  for (const [fixture, diagnostic] of Object.entries(cases)) {
    await t.test(fixture, () => rejectedFixture(fixture, diagnostic));
  }
});
