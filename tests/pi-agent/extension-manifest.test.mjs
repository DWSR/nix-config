import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANIFEST_ALTERATIONS,
  MANIFEST_SENTINEL,
} from "./fixtures/extension-manifest/manifest-alterations.mjs";
import {
  PROVENANCE_FAILURE_FIXTURES,
  PROVENANCE_SENTINEL,
} from "./fixtures/extension-manifest/provenance-fixtures.mjs";
import {
  PROVIDER_ENVIRONMENT_NAMES,
  createProviderFreeEnvironment,
} from "./fixtures/extension-manifest/subprocess-environment.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const mcpServerFixture = path.join(testsDir, "fixtures/mcpproxy-server.mjs");
const expectedOrder = [
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
const expectedExtensions = {
  agentmemory: {
    package: "@agentmemory/agentmemory",
    version: "0.9.29",
    sourceRef: "e04ba88819c365c9acf9d6661ea802143e728bd6",
    entryPath: "lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts",
    license: "Apache-2.0",
  },
  mcp: {
    package: "@dwsr/pi-mcpproxy-adapter",
    version: "0.1.0",
    sourceRef: "repository",
    entryPath: "lib/pi-agent/extensions/mcpproxy/index.ts",
  },
  subagents: {
    package: "pi-subagents",
    version: "0.40.0",
    sourceRef: "d4d2ab70",
    entryPath: "lib/node_modules/pi-subagents/index.ts",
  },
  plan: {
    package: "@narumitw/pi-plan-mode",
    version: "0.49.2",
    sourceRef: "df5f5ce7",
    entryPath: "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  },
  timestamps: {
    package: "@narumitw/pi-stamp",
    version: "0.49.3",
    sourceRef: "4c2c2e8c",
    entryPath: "lib/node_modules/@narumitw/pi-stamp/src/index.ts",
  },
  bashTimeout: {
    package: "@mrclrchtr/supi-bash-timeout",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts",
  },
  questions: {
    package: "@mrclrchtr/supi-ask-user",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts",
  },
  codeIntelligence: {
    package: "@mrclrchtr/supi-code-intelligence",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts",
  },
  backgroundTasks: {
    package: "@99percentpeople/pi-background-tasks",
    version: "2.0.0",
    sourceRef: "0d231ab3",
    entryPath: "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts",
  },
};
const expectedLoader = {
  entryPath: "lib/pi-agent/extensions/managed-loader.ts",
  discovery: {
    extensions: false,
    skills: false,
    prompts: false,
  },
};
const directToolNames = [
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
];
const expectedRegisteredTools = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "memory_health",
  "memory_search",
  "memory_save",
  ...directToolNames,
  "subagent",
  "subagent_wait",
  "plan_mode_question",
  "plan_mode_complete",
  "ask_user",
  "code_resolve",
  "code_inspect",
  "code_orientation",
  "code_graph",
  "code_find",
  "code_health",
  "code_refactor_plan",
  "code_refactor_apply",
  "bg_start",
  "bg_wait",
  "bg_status",
  "bg_logs",
  "bg_send",
  "bg_kill",
  "subagent_supervisor",
  "intercom",
];
const expectedManagedExtensionTools = expectedRegisteredTools.filter(
  (name) => !["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name),
);
const forbiddenToolNames = [
  "mcp",
  "mcpScript",
  "code_execution",
  "mcpproxy_code_execution",
  "sieve",
  "pi_install",
  "package_manager",
  "telemetry",
];
const recovery = "rebuild pi-agent-extensions and activate the managed generation";
const inputSentinel = "TASK_4_12_PRIVATE_VALIDATOR_INPUT_SENTINEL";
const subprocessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-manifest-processes-"));
const subprocessEnvironment = createProviderFreeEnvironment(subprocessRoot);
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: subprocessEnvironment,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

let runtimePaths;
let runtimeModules;
let manifestModule;
let lateCollisionExtensionPath;
let alteredManifestPackagePaths;
let alteredProvenancePackagePaths;
let importFailurePackagePaths;
let orderedTracePackagePath;

after(() => {
  fs.rmSync(subprocessRoot, { recursive: true, force: true });
});

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-extension-manifest-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
    in
      ${body}
  `;
}

function buildRuntimePaths() {
  if (runtimePaths) return runtimePaths;
  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression("[ pkgs.pi-agent pkgs.pi-agent-extensions pkgs.pi-agent-extensions.identity ]"),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, 3, `expected three runtime outputs, got ${outputs.join(", ")}`);
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) =>
      fs.existsSync(path.join(output, "share/pi-agent/extensions.json")),
    ),
    identity: outputs.find((output) =>
      fs.existsSync(path.join(output, "extensions-provenance.json")),
    ),
  };
  assert.match(runtimePaths.pi ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.extensions ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.identity ?? "", /^\/nix\/store\//);
  assert.notEqual(runtimePaths.identity, runtimePaths.extensions);
  return runtimePaths;
}

function buildLateCollisionExtensionPath() {
  if (lateCollisionExtensionPath) return lateCollisionExtensionPath;
  lateCollisionExtensionPath = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          pkgs.runCommand "pi-agent-extensions-late-reserved-collision" {
            __structuredAttrs = true;
            outputs = [ "out" "identity" ];
            unsafeDiscardReferences.identity = true;
          } ''
            mkdir -p "$out"
            cp -R ${"${pkgs.pi-agent-extensions}"}/. "$out/"
            chmod u+w \
              "$out/lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts" \
              "$out/share/pi-agent/extensions-provenance.json"
            cp ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/late-reserved-collision.ts\"}"} \\
              "$out/lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts"
            ${"${pkgs.nodejs}"}/bin/node \
              ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
              prepare "$out" "$identity" \
              ${"${pkgs.pi-agent-extensions.identity}"}/extensions-provenance.json
            printf '%s\n' "$identity/extensions-provenance.json" > "$out/fixture-identity-path"
          ''
        `),
      ],
      commandOptions,
    )
    .trim();
  assert.match(lateCollisionExtensionPath, /^\/nix\/store\//);
  return lateCollisionExtensionPath;
}

function buildAlteredManifestPackagePaths() {
  if (alteredManifestPackagePaths) return alteredManifestPackagePaths;
  const fixtureIds = JSON.stringify(MANIFEST_ALTERATIONS.map(({ id }) => id));
  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          let
            fixtures = builtins.fromJSON ${JSON.stringify(fixtureIds)};
            mkFixture = fixture: pkgs.runCommand "pi-agent-extension-manifest-\${fixture}" {
              inherit fixture;
              __structuredAttrs = true;
              nativeBuildInputs = [ pkgs.nodejs ];
              outputs = [ "out" "identity" ];
              unsafeDiscardReferences.identity = true;
            } ''
              mkdir -p "$out"
              cp -R ${"${pkgs.pi-agent-extensions}"}/. "$out/"
              chmod u+w \
                "$out/share/pi-agent/extensions.json" \
                "$out/share/pi-agent/extensions-provenance.json"
              node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
                prepare "$out" "$identity" \
                ${"${pkgs.pi-agent-extensions.identity}"}/extensions-provenance.json
              node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/manifest-alterations.mjs\"}"} \
                "$fixture" "$out"
              printf '%s\\n' "$fixture" > "$out/fixture-name"
              printf '%s\\n' "$identity/extensions-provenance.json" > "$out/fixture-identity-path"
            '';
          in map mkFixture fixtures
        `),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, MANIFEST_ALTERATIONS.length);
  alteredManifestPackagePaths = new Map(outputs.map((output) => [
    fs.readFileSync(path.join(output, "fixture-name"), "utf8").trim(),
    output,
  ]));
  return alteredManifestPackagePaths;
}

function buildAlteredProvenancePackagePaths() {
  if (alteredProvenancePackagePaths) return alteredProvenancePackagePaths;
  const fixtureIds = JSON.stringify(PROVENANCE_FAILURE_FIXTURES.map(({ id }) => id));
  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          let
            fixtures = builtins.fromJSON ${JSON.stringify(fixtureIds)};
            mkFixture = fixture: pkgs.runCommand "pi-agent-extension-provenance-\${fixture}" {
              inherit fixture;
              __structuredAttrs = true;
              nativeBuildInputs = [ pkgs.nodejs ];
              outputs = [ "out" "identity" "forgedIdentity" ];
              unsafeDiscardReferences.forgedIdentity = true;
              unsafeDiscardReferences.identity = true;
            } ''
              mkdir -p "$out"
              cp -R ${"${pkgs.pi-agent-extensions}"}/. "$out/"
              chmod -R u+w "$out"
              node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
                prepare "$out" "$identity" \
                ${"${pkgs.pi-agent-extensions.identity}"}/extensions-provenance.json
              node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
                "$fixture" "$out" ${"${pkgs.pi-agent-extensions}"}
              mkdir -p "$forgedIdentity"
              cp "$out/share/pi-agent/extensions-provenance.json" \
                "$forgedIdentity/extensions-provenance.json"
              printf '%s\\n' "$fixture" > "$out/fixture-name"
              printf '%s\\n' "$identity/extensions-provenance.json" > "$out/fixture-identity-path"
              printf '%s\\n' "$forgedIdentity/extensions-provenance.json" \
                > "$out/fixture-forged-identity-path"
            '';
          in map mkFixture fixtures
        `),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, PROVENANCE_FAILURE_FIXTURES.length);
  alteredProvenancePackagePaths = new Map(outputs.map((output) => [
    fs.readFileSync(path.join(output, "fixture-name"), "utf8").trim(),
    output,
  ]));
  return alteredProvenancePackagePaths;
}

function buildImportFailurePackagePaths() {
  if (importFailurePackagePaths) return importFailurePackagePaths;
  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          let
            mkFixture = variant: pkgs.runCommand "pi-agent-extension-import-failure-\${variant}" {
              inherit variant;
              __structuredAttrs = true;
              nativeBuildInputs = [ pkgs.nodejs ];
              outputs = [ "out" "identity" ];
              unsafeDiscardReferences.identity = true;
            } ''
              mkdir -p "$out"
              cp -R ${"${pkgs.pi-agent-extensions}"}/. "$out/"
              chmod u+w \
                "$out/lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts" \
                "$out/share/pi-agent/extensions.json" \
                "$out/share/pi-agent/extensions-provenance.json"
              if [ "$variant" = "factory" ]; then
                cp ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/factory-time-failure.ts\"}"} \
                  "$out/lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts"
              else
                cp ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/import-time-failure.ts\"}"} \
                  "$out/lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts"
              fi
              node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
                prepare "$out" "$identity" \
                ${"${pkgs.pi-agent-extensions.identity}"}/extensions-provenance.json
              if [ "$variant" = "invalid-manifest" ]; then
                node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/manifest-alterations.mjs\"}"} \
                  reordered "$out"
              fi
              printf '%s\\n' "$variant" > "$out/fixture-name"
              printf '%s\\n' "$identity/extensions-provenance.json" > "$out/fixture-identity-path"
            '';
          in map mkFixture [ "import" "factory" "invalid-manifest" ]
        `),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, 3);
  importFailurePackagePaths = new Map(outputs.map((output) => [
    fs.readFileSync(path.join(output, "fixture-name"), "utf8").trim(),
    output,
  ]));
  return importFailurePackagePaths;
}

function buildOrderedTracePackagePath() {
  if (orderedTracePackagePath) return orderedTracePackagePath;
  const fixtureSource = '${source + "/tests/pi-agent/fixtures/extension-manifest/ordered-factory.ts.in"}';
  const replacements = expectedOrder.map((logicalName) => {
    const entryPath = expectedExtensions[logicalName].entryPath;
    return `
      chmod u+w "$out/${entryPath}"
      substitute ${fixtureSource} "$out/${entryPath}" \\
        --subst-var-by logicalName ${JSON.stringify(logicalName)}
    `;
  }).join("\n");
  orderedTracePackagePath = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          pkgs.runCommand "pi-agent-extension-ordered-factory-trace" {
            __structuredAttrs = true;
            nativeBuildInputs = [ pkgs.nodejs ];
            outputs = [ "out" "identity" ];
            unsafeDiscardReferences.identity = true;
          } ''
            mkdir -p "$out"
            cp -R ${"${pkgs.pi-agent-extensions}"}/. "$out/"
            ${replacements}
            chmod u+w "$out/lib/pi-agent/extensions/mcpproxy"
            chmod u+w "$out/share/pi-agent/extensions-provenance.json"
            node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
              prepare "$out" "$identity" \
              ${"${pkgs.pi-agent-extensions.identity}"}/extensions-provenance.json
            node ${"${source + \"/tests/pi-agent/fixtures/extension-manifest/provenance-fixtures.mjs\"}"} \
              provenance-hardlink "$out"
            printf '%s\n' "$identity/extensions-provenance.json" > "$out/fixture-identity-path"
          ''
        `),
      ],
      commandOptions,
    )
    .trim();
  assert.match(orderedTracePackagePath, /^\/nix\/store\//);
  return orderedTracePackagePath;
}

function runCombinedLoaderProbe(extensionRoot) {
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(testsDir, "fixtures/extension-manifest/combined-loader-probe.mjs"),
      buildRuntimePaths().pi,
      extensionRoot,
    ],
    {
      ...commandOptions,
      env: subprocessEnvironment,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "combined loader probe emitted no report");
  return {
    observable: `${result.stdout}\n${result.stderr}`,
    report: JSON.parse(lines.at(-1)),
  };
}

function assertRejectedBeforeModel(probe, diagnostic, sentinel, label) {
  const { observable, report } = probe;
  assert.equal(report.thrown, null, label);
  assert.equal(report.errors.length, 1, label);
  assert.equal(report.errors[0].includes(diagnostic), true, `${label}: ${report.errors[0]}`);
  assert.match(report.errors[0], /Recovery: rebuild pi-agent-extensions and activate the managed generation/);
  assert.deepEqual(report.extensionErrors, [], label);
  assert.equal(report.modelCalls, 0, label);
  assert.deepEqual(report.modelContext, [], label);
  assert.deepEqual(report.modelTools, [], label);
  assert.equal(
    report.sessionBranch.some(({ role }) => role === "user" || role === "assistant"),
    false,
    label,
  );
  assert.deepEqual(report.notifications, [], label);
  assert.equal(observable.includes(sentinel), false, label);
  assert.equal(JSON.stringify(report).includes(sentinel), false, label);
}

function runHeadlessPrint(extensionRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-print-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  try {
    return childProcess.spawnSync(
      path.join(buildRuntimePaths().pi, "bin/pi"),
      [
        "--offline",
        "--approve",
        "--no-extensions",
        "--extension",
        path.join(extensionRoot, expectedLoader.entryPath),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--print",
        "--no-session",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
        "--api-key",
        "task-4-12-unused-print-key",
        "must not reach print mode",
      ],
      {
        ...commandOptions,
        cwd,
        env: {
          ...createProviderFreeEnvironment(root, subprocessEnvironment),
          PI_CODING_AGENT_DIR: agentDir,
        },
        timeout: 30_000,
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readPackageArtifacts(extensions = buildRuntimePaths().extensions) {
  const identityPath = extensions === buildRuntimePaths().extensions
    ? path.join(buildRuntimePaths().identity, "extensions-provenance.json")
    : fs.readFileSync(path.join(extensions, "fixture-identity-path"), "utf8").trim();
  return {
    manifest: readJson(path.join(extensions, "share/pi-agent/extensions.json")),
    provenance: readJson(path.join(extensions, "share/pi-agent/extensions-provenance.json")),
    trustedProvenance: readJson(identityPath),
  };
}

async function importManifestModule(extensionRoot) {
  const runtime = buildRuntimePaths();
  const piNodeModules = path.join(runtime.pi, "lib/node_modules");
  const { createJiti } = await import(
    pathToFileURL(path.join(piNodeModules, "jiti/lib/jiti.mjs"))
  );
  return createJiti(import.meta.url, { moduleCache: false }).import(
    path.join(extensionRoot, "lib/pi-agent/extensions/managed-manifest.ts"),
  );
}

async function loadManifestModule() {
  if (manifestModule) return manifestModule;
  manifestModule = await importManifestModule(buildRuntimePaths().extensions);
  return manifestModule;
}

async function loadRuntimeModules() {
  if (runtimeModules) return runtimeModules;
  const nodeModules = path.join(buildRuntimePaths().pi, "lib/node_modules");
  const [codingAgent, ai, streams] = await Promise.all([
    import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js"))),
    import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js"))),
    import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/utils/event-stream.js"))),
  ]);
  runtimeModules = { ...codingAgent, ...ai, ...streams };
  return runtimeModules;
}

function expectedManifest() {
  return {
    schemaVersion: 1,
    piVersion: "0.83.0",
    loader: structuredClone(expectedLoader),
    extensionOrder: [...expectedOrder],
    extensions: Object.fromEntries(
      Object.entries(expectedExtensions).map(([name, extension]) => [
        name,
        {
          version: extension.version,
          entryPath: extension.entryPath,
          license: extension.license ?? "MIT",
        },
      ]),
    ),
  };
}

function cloneArtifacts() {
  const { manifest, provenance } = readPackageArtifacts();
  return {
    manifest: structuredClone(manifest),
    provenance: structuredClone(provenance),
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

function assertManagedFailure(action, fixture) {
  assert.throws(
    action,
    (error) => {
      assert.equal(error.name, "ManagedExtensionError", fixture.id);
      assert.equal(error.kind, fixture.kind, fixture.id);
      assert.equal(error.component, fixture.component, fixture.id);
      assert.equal(error.recovery, recovery);
      assert.equal(
        error.message,
        `Managed ${fixture.component} failed (${fixture.kind}). Recovery: ${recovery}.`,
      );
      assert.equal(error.message.includes(MANIFEST_SENTINEL), false);
      assert.equal(error.message.includes(PROVENANCE_SENTINEL), false);
      assert.equal(error.message.includes(inputSentinel), false);
      assert.equal(JSON.stringify(error).includes(MANIFEST_SENTINEL), false);
      assert.equal(JSON.stringify(error).includes(PROVENANCE_SENTINEL), false);
      assert.equal(JSON.stringify(error).includes(inputSentinel), false);
      return true;
    },
    fixture.id,
  );
}

test("package publishes the exact closed, ordered, immutable extension manifest", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const { manifest, provenance, trustedProvenance } = readPackageArtifacts();
  assert.deepEqual(manifest, expectedManifest());
  assert.deepEqual(manifest.extensions.agentmemory, {
    version: expectedExtensions.agentmemory.version,
    entryPath: expectedExtensions.agentmemory.entryPath,
    license: expectedExtensions.agentmemory.license,
  });
  assert.doesNotMatch(JSON.stringify(manifest.extensions.agentmemory), /cavemem/i);
  assert.deepEqual(trustedProvenance, provenance);
  assert.deepEqual(Object.keys(provenance).sort(), [
    "extensionOrder",
    "extensions",
    "loader",
    "packageRoot",
    "patches",
    "piVersion",
    "runtimeDependencies",
    "schemaVersion",
  ]);
  assert.equal(provenance.schemaVersion, 2);
  assert.equal(provenance.packageRoot, runtime.extensions);
  assert.equal(provenance.piVersion, "0.83.0");
  assert.deepEqual(provenance.extensionOrder, expectedOrder);
  assert.deepEqual(provenance.loader, {
    entryPath: expectedLoader.entryPath,
    kind: "regular-file",
    sha256: sha256File(path.join(runtime.extensions, expectedLoader.entryPath)),
  });
  assert.deepEqual(Object.keys(manifest.extensions).sort(), [...expectedOrder].sort());
  assert.deepEqual(Object.keys(provenance.extensions).sort(), [...expectedOrder].sort());
  assert.equal(new Set(expectedOrder).size, expectedOrder.length);
  assert.equal(
    new Set(Object.values(provenance.extensions).map(({ package: packageName }) => packageName)).size,
    expectedOrder.length,
  );
  assert.equal(
    new Set(Object.values(manifest.extensions).map(({ entryPath }) => entryPath)).size,
    expectedOrder.length,
  );
  for (const logicalName of expectedOrder) {
    const expected = expectedExtensions[logicalName];
    assert.deepEqual(provenance.extensions[logicalName], {
      package: expected.package,
      version: expected.version,
      sourceRef: expected.sourceRef,
      entryPath: expected.entryPath,
      kind: "regular-file",
      sha256: sha256File(path.join(runtime.extensions, expected.entryPath)),
    });
  }

  const validator = await loadManifestModule();
  assert.equal(
    validator.MANAGED_EXTENSION_IDENTITY_PATH,
    path.join(runtime.identity, "extensions-provenance.json"),
  );
  const resolved = validator.validateManagedExtensionPackage({
    packageRoot: runtime.extensions,
    manifest,
    provenance,
  });
  assert.deepEqual(resolved.extensionOrder, expectedOrder);
  assert.deepEqual(
    resolved.entries.map(({
      logicalName,
      package: packageName,
      version,
      sourceRef,
      entryPath,
      license,
      kind,
      sha256,
    }) => ({
      logicalName,
      package: packageName,
      version,
      sourceRef,
      entryPath,
      license,
      kind,
      sha256,
    })),
    expectedOrder.map((logicalName) => ({
      logicalName,
      package: expectedExtensions[logicalName].package,
      version: expectedExtensions[logicalName].version,
      sourceRef: expectedExtensions[logicalName].sourceRef,
      entryPath: expectedExtensions[logicalName].entryPath,
      license: expectedExtensions[logicalName].license ?? "MIT",
      kind: "regular-file",
      sha256: sha256File(path.join(runtime.extensions, expectedExtensions[logicalName].entryPath)),
    })),
  );
  assert.deepEqual(resolved.loader, {
    absoluteEntryPath: path.join(runtime.extensions, expectedLoader.entryPath),
    entryPath: expectedLoader.entryPath,
    kind: "regular-file",
    sha256: sha256File(path.join(runtime.extensions, expectedLoader.entryPath)),
  });
  assert.equal(resolved.packageRoot, runtime.extensions);
  assert.equal(resolved.piVersion, "0.83.0");
  for (const entry of resolved.entries) {
    assert.equal(fs.statSync(entry.absoluteEntryPath).isFile(), true);
    assert.equal(path.relative(runtime.extensions, entry.absoluteEntryPath).startsWith(".."), false);
  }
  assertDeepFrozen(resolved);
  const loaded = validator.loadManagedExtensionPackage();
  assert.deepEqual(loaded, resolved);
  assertDeepFrozen(loaded);
});

test("manifest validator rejects every altered inventory value-safely", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const { validateManagedExtensionPackage } = await loadManifestModule();
  assert.deepEqual(
    MANIFEST_ALTERATIONS
      .filter(({ id }) => [
        "missing",
        "duplicate-logical-identity",
        "incompatible-version",
        "generic-mcp-proxy",
        "code-execution",
        "sieve",
        "mutable-package-manager",
        "telemetry",
      ].includes(id))
      .map(({ id }) => id),
    [
      "missing",
      "duplicate-logical-identity",
      "incompatible-version",
      "generic-mcp-proxy",
      "code-execution",
      "sieve",
      "mutable-package-manager",
      "telemetry",
    ],
  );
  assert.deepEqual(
    [...new Set(MANIFEST_ALTERATIONS.map(({ kind }) => kind))].sort(),
    [
      "duplicate",
      "forbidden",
      "incompatible",
      "malformed",
      "missing",
      "non-file",
      "path",
      "reordered",
      "unexpected",
    ],
  );

  for (const fixture of MANIFEST_ALTERATIONS) {
    const artifacts = cloneArtifacts();
    fixture.alter(artifacts);
    assertManagedFailure(
      () => validateManagedExtensionPackage({
        packageRoot: runtime.extensions,
        ...artifacts,
      }),
      fixture,
    );
  }
});

test("exported validator rejects hostile descriptors without invoking user code", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const validator = await loadManifestModule();
  const expectedFailure = {
    id: "hostile-validator-input",
    kind: "malformed",
    component: "extension manifest",
  };
  const input = {
    packageRoot: runtime.extensions,
    ...cloneArtifacts(),
  };

  let trapCalls = 0;
  const trapHandler = {
    get(target, property, receiver) {
      trapCalls += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      trapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf(target) {
      trapCalls += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCalls += 1;
      return Reflect.ownKeys(target);
    },
  };
  const transparentProxy = new Proxy(input, trapHandler);
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(transparentProxy),
    expectedFailure,
  );
  assert.equal(trapCalls, 0);
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      ...input,
      provenance: new Proxy(input.provenance, trapHandler),
    }),
    expectedFailure,
  );
  assert.equal(trapCalls, 0);

  const revocable = Proxy.revocable(input, {
    get() {
      trapCalls += 1;
      throw new Error(inputSentinel);
    },
  });
  revocable.revoke();
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(revocable.proxy),
    expectedFailure,
  );
  assert.equal(trapCalls, 0);

  let getterCalls = 0;
  const forged = new validator.ManagedExtensionError("path", inputSentinel);
  const accessorInput = {
    manifest: input.manifest,
    provenance: input.provenance,
  };
  Object.defineProperty(accessorInput, "packageRoot", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw forged;
    },
  });
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(accessorInput),
    expectedFailure,
  );
  assert.equal(getterCalls, 0);
  const nestedAccessorProvenance = { ...input.provenance };
  Object.defineProperty(nestedAccessorProvenance, "extensions", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw forged;
    },
  });
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      ...input,
      provenance: nestedAccessorProvenance,
    }),
    expectedFailure,
  );
  assert.equal(getterCalls, 0);
  assert.equal(typeof validator.isManagedExtensionError, "function");
  assert.equal(validator.isManagedExtensionError(forged), false);

  const extraInput = { ...input, [inputSentinel]: true };
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(extraInput),
    expectedFailure,
  );
  let toJsonCalls = 0;
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      ...input,
      toJSON() {
        toJsonCalls += 1;
        throw forged;
      },
    }),
    expectedFailure,
  );
  assert.equal(toJsonCalls, 0);
  const symbolInput = { ...input, [Symbol(inputSentinel)]: true };
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(symbolInput),
    expectedFailure,
  );
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      ...input,
      provenance: { ...input.provenance, [Symbol(inputSentinel)]: true },
    }),
    expectedFailure,
  );
});

test("real Pi/Jiti combined loader rejects every altered manifest before a model call", { timeout: 1_200_000 }, () => {
  const packages = buildAlteredManifestPackagePaths();
  for (const fixture of MANIFEST_ALTERATIONS) {
    const extensionRoot = packages.get(fixture.id);
    assert.match(extensionRoot ?? "", /^\/nix\/store\//, fixture.id);
    assertRejectedBeforeModel(
      runCombinedLoaderProbe(extensionRoot),
      `Managed ${fixture.component} failed (${fixture.kind})`,
      MANIFEST_SENTINEL,
      fixture.id,
    );
  }
});

test("shared validator rejects every altered filesystem provenance identity", { timeout: 1_200_000 }, async () => {
  const packages = buildAlteredProvenancePackagePaths();
  for (const fixture of PROVENANCE_FAILURE_FIXTURES) {
    const extensionRoot = packages.get(fixture.id);
    assert.match(extensionRoot ?? "", /^\/nix\/store\//, fixture.id);
    const { validateManagedExtensionPackage } = await importManifestModule(extensionRoot);
    const { manifest, provenance } = readPackageArtifacts(extensionRoot);
    assertManagedFailure(
      () => validateManagedExtensionPackage({
        packageRoot: extensionRoot,
        manifest,
        provenance,
      }),
      fixture,
    );
  }
});

test("exported APIs cannot replace the build-time trusted identity", { timeout: 1_200_000 }, async () => {
  const extensionRoot = buildAlteredProvenancePackagePaths().get("provenance-recomputed-tamper");
  assert.match(extensionRoot ?? "", /^\/nix\/store\//);
  const validator = await importManifestModule(extensionRoot);
  assert.equal(validator.validateManagedExtensionPackage.length, 1);
  assert.equal(validator.loadManagedExtensionPackage.length, 0);
  const { manifest, provenance } = readPackageArtifacts(extensionRoot);
  const digestFailure = PROVENANCE_FAILURE_FIXTURES.find(
    ({ id }) => id === "provenance-recomputed-tamper",
  );
  assert.ok(digestFailure);
  const malformedFailure = {
    id: "trusted-provenance-override",
    kind: "malformed",
    component: "extension manifest",
  };

  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      packageRoot: extensionRoot,
      manifest,
      provenance,
      trustedProvenance: structuredClone(provenance),
    }),
    malformedFailure,
  );
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage({
      packageRoot: extensionRoot,
      manifest,
      provenance,
    }),
    digestFailure,
  );
  assertManagedFailure(
    () => validator.validateManagedExtensionPackage(
      { packageRoot: extensionRoot, manifest, provenance },
      structuredClone(provenance),
    ),
    digestFailure,
  );

  const forgedIdentityPath = fs.readFileSync(
    path.join(extensionRoot, "fixture-forged-identity-path"),
    "utf8",
  ).trim();
  assertManagedFailure(
    () => validator.loadManagedExtensionPackage(forgedIdentityPath),
    digestFailure,
  );

  let trapCalls = 0;
  const transparentOverride = new Proxy({}, {
    get() { trapCalls += 1; return forgedIdentityPath; },
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
  });
  assertManagedFailure(
    () => validator.loadManagedExtensionPackage(transparentOverride),
    digestFailure,
  );
  const revocableOverride = Proxy.revocable({}, {
    get() { trapCalls += 1; throw new Error(inputSentinel); },
  });
  revocableOverride.revoke();
  assertManagedFailure(
    () => validator.loadManagedExtensionPackage(revocableOverride.proxy),
    digestFailure,
  );
  assert.equal(trapCalls, 0);

  let getterCalls = 0;
  const accessorOverride = {};
  Object.defineProperty(accessorOverride, "toString", {
    get() {
      getterCalls += 1;
      throw new validator.ManagedExtensionError("path", inputSentinel);
    },
  });
  assertManagedFailure(
    () => validator.loadManagedExtensionPackage(accessorOverride),
    digestFailure,
  );
  assert.equal(getterCalls, 0);
});

test("real Pi/Jiti loader rejects every altered provenance before a model call", { timeout: 1_200_000 }, () => {
  const packages = buildAlteredProvenancePackagePaths();
  for (const fixture of PROVENANCE_FAILURE_FIXTURES) {
    const extensionRoot = packages.get(fixture.id);
    assert.match(extensionRoot ?? "", /^\/nix\/store\//, fixture.id);
    assertRejectedBeforeModel(
      runCombinedLoaderProbe(extensionRoot),
      `Managed ${fixture.component} failed (${fixture.kind})`,
      PROVENANCE_SENTINEL,
      fixture.id,
    );
  }
});

test("real pi --print exits on a managed loader error before print-mode dispatch", { timeout: 1_200_000 }, () => {
  const extensionRoot = buildAlteredManifestPackagePaths().get("reordered");
  assert.match(extensionRoot ?? "", /^\/nix\/store\//);
  const result = runHeadlessPrint(extensionRoot);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Failed to load extension/);
  assert.match(result.stderr, /Managed extension manifest failed \(reordered\)/);
  assert.match(result.stderr, /Recovery: rebuild pi-agent-extensions and activate the managed generation/);
  assert.doesNotMatch(result.stderr, /must not reach print mode|TASK_4_12_PRIVATE_MANIFEST_SENTINEL/);
});

test("unchanged hardlinked entry validates and loads in exact factory order", { timeout: 1_200_000 }, async () => {
  const extensionRoot = buildOrderedTracePackagePath();
  const entry = path.join(extensionRoot, expectedExtensions.mcp.entryPath);
  const hardlinkTarget = `${entry}.hardlink-target`;
  const entryStat = fs.statSync(entry);
  const targetStat = fs.statSync(hardlinkTarget);
  assert.equal(entryStat.dev, targetStat.dev);
  assert.equal(entryStat.ino, targetStat.ino);

  const { validateManagedExtensionPackage } = await importManifestModule(extensionRoot);
  const { manifest, provenance } = readPackageArtifacts(extensionRoot);
  const resolved = validateManagedExtensionPackage({
    packageRoot: extensionRoot,
    manifest,
    provenance,
  });
  assert.equal(
    resolved.entries.find(({ logicalName }) => logicalName === "mcp")?.sha256,
    sha256File(entry),
  );
  assertDeepFrozen(resolved);

  const { report } = runCombinedLoaderProbe(extensionRoot);
  assert.equal(report.thrown, null);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.trace,
    [
      ...expectedOrder.flatMap((logicalName) => [
        `evaluate:${logicalName}`,
        `factory:${logicalName}`,
      ]),
      "validate:surface",
    ],
  );
  assert.equal(report.modelCalls, 1);
});

test("manifest validation precedes imports and extension failures are value-safe", { timeout: 1_200_000 }, () => {
  const packages = buildImportFailurePackagePaths();
  const expected = [
    {
      variant: "import",
      diagnostic: "Managed extension backgroundTasks failed (load)",
      sentinel: "TASK_4_12_PRIVATE_IMPORT_FAILURE_SENTINEL",
    },
    {
      variant: "factory",
      diagnostic: "Managed extension backgroundTasks failed (load)",
      sentinel: "TASK_4_12_PRIVATE_FACTORY_FAILURE_SENTINEL",
    },
    {
      variant: "invalid-manifest",
      diagnostic: "Managed extension manifest failed (reordered)",
      sentinel: "TASK_4_12_PRIVATE_IMPORT_FAILURE_SENTINEL",
    },
  ];

  for (const { variant, diagnostic, sentinel } of expected) {
    const extensionRoot = packages.get(variant);
    assert.match(extensionRoot ?? "", /^\/nix\/store\//, variant);
    assertRejectedBeforeModel(
      runCombinedLoaderProbe(extensionRoot),
      diagnostic,
      sentinel,
      variant,
    );
  }
});

function applyEnvironment(overrides) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function waitForChildMessage(child, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for MCP fixture"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`MCP fixture exited before readiness: ${code ?? signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function startMcpServer() {
  const runtime = buildRuntimePaths();
  const serverModule = path.join(
    runtime.extensions,
    "lib/node_modules/@modelcontextprotocol/server/dist/index.mjs",
  );
  const child = childProcess.fork(mcpServerFixture, [], {
    cwd: repoRoot,
    env: {
      ...subprocessEnvironment,
      PI_AGENT_MCP_SERVER_MODULE: serverModule,
      PI_AGENT_MCP_FIXTURE_VARIANT: "exact",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const ready = await waitForChildMessage(child, (message) => message?.type === "ready");
    assert.equal(Number.isInteger(ready.port), true, stderr);
    return { child, port: ready.port, stderr: () => stderr };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function stopMcpServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.send({ type: "shutdown" });
  await waitForChildMessage(server.child, (message) => message?.type === "stopped").catch(() => {
    server.child.kill("SIGKILL");
  });
}

function installFetchRedirect(port) {
  const original = globalThis.fetch;
  const redirected = (input, init) => {
    const source = input instanceof Request ? input.url : input;
    const url = new URL(source);
    if (url.hostname === "127.0.0.1" && url.port === "8080") url.port = String(port);
    if (input instanceof Request) return original(new Request(url, input), init);
    return original(input instanceof URL ? url : url.href, init);
  };
  globalThis.fetch = redirected;
  return () => {
    if (globalThis.fetch === redirected) globalThis.fetch = original;
  };
}

function createUi() {
  const notifications = [];
  return {
    notifications,
    context: {
      async select() { return undefined; },
      async confirm() { return false; },
      async input() { return undefined; },
      async editor() { return undefined; },
      async custom() { return undefined; },
      notify(message, type = "info") { notifications.push({ message, type }); },
      onTerminalInput() { return () => {}; },
      setStatus() {},
      setWidget() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setFooter() {},
      setHeader() {},
      setTitle() {},
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() { return ""; },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() { return undefined; },
      getAllThemes() { return []; },
      getTheme() { return undefined; },
      setTheme() { return { success: false, error: "unavailable in fixture" }; },
      getToolsExpanded() { return false; },
      setToolsExpanded() {},
      theme: {},
    },
  };
}

function assistantMessage(model, text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function writeAmbientResources(root, cwd, agentDir) {
  const ambientExtension = `export default function ambient(pi) { throw new Error("${root}-ambient-extension"); }\n`;
  for (const directory of [path.join(agentDir, "extensions"), path.join(cwd, ".pi/extensions")]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "ambient.ts"), ambientExtension);
  }
  for (const directory of [path.join(agentDir, "skills/ambient"), path.join(cwd, ".pi/skills/ambient")]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: ambient\ndescription: ambient\n---\nambient\n");
  }
  for (const directory of [path.join(agentDir, "prompts"), path.join(cwd, ".pi/prompts")]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "ambient.md"), "ambient prompt\n");
  }
}

async function createCombinedSession({
  extensionRoot = buildRuntimePaths().extensions,
  id,
  responseText,
}) {
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createAssistantMessageEventStream,
    getModel,
  } = await loadRuntimeModules();
  const runtime = buildRuntimePaths();
  const manifest = readPackageArtifacts(extensionRoot).manifest;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-extension-manifest-${id}-`));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  for (const directory of [cwd, agentDir, sessionsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeAmbientResources(id, cwd, agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  fs.writeFileSync(
    path.join(agentDir, "auth.json"),
    `${JSON.stringify({ anthropic: { type: "api_key", key: "task-4-12-model-stub" } })}\n`,
    { mode: 0o600 },
  );
  const isolatedEnvironment = createProviderFreeEnvironment(
    path.join(root, "environment"),
    subprocessEnvironment,
  );
  const restoreEnvironment = applyEnvironment({
    ...Object.fromEntries(PROVIDER_ENVIRONMENT_NAMES.map((name) => [name, undefined])),
    HOME: isolatedEnvironment.HOME,
    TMPDIR: isolatedEnvironment.TMPDIR,
    XDG_CACHE_HOME: isolatedEnvironment.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: isolatedEnvironment.XDG_CONFIG_HOME,
    XDG_DATA_HOME: isolatedEnvironment.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: isolatedEnvironment.XDG_RUNTIME_DIR,
    XDG_STATE_HOME: isolatedEnvironment.XDG_STATE_HOME,
    PI_CODING_AGENT_DIR: agentDir,
    PI_AGENT_BASH_TIMEOUT_MS: "4100",
    PI_AGENT_LSP_EXECUTABLES: "{}",
    MCP_DIRECT_TOOLS: "ambient-direct-tool-sentinel",
  });
  let session;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [path.join(extensionRoot, manifest.loader.entryPath)],
      noExtensions: manifest.loader.discovery.extensions === false,
      noSkills: manifest.loader.discovery.skills === false,
      noPromptTemplates: manifest.loader.discovery.prompts === false,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const startupErrors = resourceLoader.getExtensions().errors;
    assert.deepEqual(resourceLoader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(resourceLoader.getPrompts(), { prompts: [], diagnostics: [] });
    if (startupErrors.length > 0) {
      return {
        extensionErrors: [],
        getModelCalls: () => 0,
        resourceLoader,
        restoreEnvironment,
        root,
        session: undefined,
        startupErrors,
        ui: undefined,
      };
    }

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "reviewed Pi model fixture is unavailable");
    const sessionManager = SessionManager.create(cwd, sessionsDir, { id });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    }));
    const ui = createUi();
    const extensionErrors = [];
    await session.bindExtensions({
      uiContext: ui.context,
      mode: "tui",
      onError(error) { extensionErrors.push(error); },
    });
    let modelCalls = 0;
    session.agent.streamFunction = (activeModel) => {
      modelCalls += 1;
      const names = session.getAllTools().map(({ name }) => name);
      for (const directName of directToolNames) {
        assert.equal(names.filter((name) => name === directName).length, 1);
      }
      const message = assistantMessage(activeModel, responseText);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    return {
      extensionErrors,
      getModelCalls: () => modelCalls,
      resourceLoader,
      restoreEnvironment,
      root,
      session,
      startupErrors,
      ui,
    };
  } catch (error) {
    session?.dispose();
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeCombinedSession(fixture) {
  try {
    if (fixture.session) {
      await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      fixture.session.dispose();
    }
  } finally {
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("real Pi/Jiti loader registers all managed factories before accepting one prompt", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const server = await startMcpServer();
  const restoreFetch = installFetchRedirect(server.port);
  let accepted;
  try {
    const manifest = readPackageArtifacts().manifest;
    assert.deepEqual(manifest.extensionOrder, expectedOrder);
    assert.deepEqual(
      Object.fromEntries(expectedOrder.map((logicalName) => [
        logicalName,
        manifest.extensions[logicalName].version,
      ])),
      Object.fromEntries(expectedOrder.map((logicalName) => [
        logicalName,
        expectedExtensions[logicalName].version,
      ])),
    );
    assert.deepEqual(manifest.loader, expectedLoader);
    accepted = await createCombinedSession({
      id: "task-4-12-accepted",
      responseText: "task-4-12 prompt accepted",
    });
    assert.deepEqual(accepted.startupErrors, []);
    const loaded = accepted.resourceLoader.getExtensions().extensions;
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].resolvedPath, path.join(runtime.extensions, expectedLoader.entryPath));
    const registeredNames = accepted.session.getAllTools().map(({ name }) => name);
    assert.deepEqual(
      [...loaded[0].tools.keys()],
      expectedManagedExtensionTools,
    );
    assert.deepEqual(registeredNames, expectedRegisteredTools);
    assert.deepEqual(accepted.resourceLoader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(accepted.resourceLoader.getPrompts(), { prompts: [], diagnostics: [] });
    for (const forbiddenName of forbiddenToolNames) {
      assert.equal(registeredNames.includes(forbiddenName), false);
    }
    assert.equal(registeredNames.some((name) => name.startsWith("mcpproxy_")), false);
    assert.equal(registeredNames.some((name) => name.startsWith("mcp__mcpproxy_")), false);

    await accepted.session.prompt("accept this minimal managed prompt");
    await accepted.session.waitForIdle();
    assert.equal(accepted.getModelCalls(), 1);
    assert.equal(
      accepted.session.sessionManager.getBranch().some((entry) =>
        entry.message?.role === "assistant"
          && entry.message.content?.some((content) => content.text === "task-4-12 prompt accepted"),
      ),
      true,
    );
    assert.deepEqual(accepted.extensionErrors, []);
    await closeCombinedSession(accepted);
    accepted = undefined;

    const collisionProbe = runCombinedLoaderProbe(buildLateCollisionExtensionPath());
    assertRejectedBeforeModel(
      collisionProbe,
      "Managed extension MCP surface failed (surface)",
      "TASK_4_12_PRIVATE_COLLISION_SENTINEL",
      "managed ninth-factory reserved-name collision",
    );
    const collisionFailure = collisionProbe.report.errors[0];
    assert.equal(collisionFailure.includes("retrieve_tools"), false);
  } finally {
    if (accepted) await closeCombinedSession(accepted).catch(() => {});
    restoreFetch();
    await stopMcpServer(server);
  }
});

test("Task 4.12 production files contain no feature seam", () => {
  const sources = [
    path.join(repoRoot, "overlays/pi-agent/default.nix"),
    path.join(repoRoot, "overlays/pi-agent/extensions/managed-loader.ts.in"),
    path.join(repoRoot, "overlays/pi-agent/extensions/managed-manifest.ts.in"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(
    sources,
    /task412(?:ExactExtensionLoader|DigestProvenanceEnabled|TrustedIdentityEnabled)|PI_AGENT_TASK_4_12|EXACT_MANAGED_LOADER_ENABLED/,
  );
});
