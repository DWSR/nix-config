import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/status.nix";
const statusExecutable = "bin/pi-agent-status";
const statusModule = "lib/pi-agent/status.mjs";
const generation = "task-5.6-status-v1";
const providerSentinel = "task-5-6-provider-sentinel";
const launchSentinel = "a56aa56a-5a56-456a-856a-a56aa56aa56a";
const openAiSentinel = "task-5-6-openai-sentinel";
const adminSentinel = "task-5-6-mcpproxy-admin-sentinel";
const headerSentinel = `Bearer ${providerSentinel}`;
const managedSettingKeys = [
  "defaultModel",
  "defaultThinkingLevel",
  "shellPath",
  "installTelemetry",
  "selfUpdate",
  "unmanagedPackages",
];
const extensionVersions = {
  backgroundTasks: "2.0.0",
  bashTimeout: "4.6.0",
  agentmemory: "0.9.29",
  codeIntelligence: "4.6.0",
  mcp: "0.1.0",
  plan: "0.49.2",
  questions: "4.6.0",
  subagents: "0.40.0",
  timestamps: "0.49.3",
};
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};

let fixtureRoot;
let packages;
let personalStatusModule;
let agentMemoryServer;
const agentMemoryUrl = "http://127.0.0.1:3111";
const agentMemorySecret = "agentmemory-status-secret";

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-status-tests";
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
    agentMemoryServer = childProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import http from "node:http"; http.createServer((request, response) => { const degraded = request.headers.authorization === "Bearer agentmemory-degraded-secret"; response.writeHead(degraded ? 503 : 200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: degraded ? "degraded" : "healthy" })); }).listen(3111, "127.0.0.1");',
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${agentMemoryUrl}/agentmemory/health`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fixtureRoot = buildFixture("packages");
    packages = Object.fromEntries(
      [
        "personal",
        "shopify",
        "degraded",
        "production",
        "missing-extension",
        "hardlink-extension",
        "component-symlink-extension",
        "leaf-symlink-extension",
        "recomputed-extension",
        "manifest-alias",
        "identity-alias",
        "lookup-failure",
      ].map((name) => [name, path.join(fixtureRoot, name)]),
    );
    personalStatusModule = await import(
      pathToFileURL(path.join(packages.personal, statusModule))
    );
  },
  { timeout: 600_000 },
);

after(() => {
  agentMemoryServer?.kill();
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function managedConfig(packageRoot) {
  return readJson(path.join(packageRoot, "share/pi-agent/managed-config.json"));
}

function managedProvider(providerSentinelValue = "${SHOPIFY_PI_TOKEN}") {
  return {
    api: "openai-responses",
    apiKey: providerSentinelValue,
    baseUrl: "https://gateway.example.test/vendors/openai/v1",
    headers: {
      Authorization:
        providerSentinelValue === "${SHOPIFY_PI_TOKEN}"
          ? "Bearer ${SHOPIFY_PI_TOKEN}"
          : `Bearer ${providerSentinelValue}`,
      "Shopify-Usage-Tag": "pi-agent",
      "X-Shopify-Session-Affinity-Header": "pi-agent-session-id",
      "pi-agent-session-id": "${PI_AGENT_LAUNCH_ID}",
    },
  };
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

function createState(t, packageRoot, options = {}) {
  const config = managedConfig(packageRoot);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-status-state-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  const settings = {
    userSetting: "preserved",
    ...structuredClone(config.settings),
    ...(options.settings ?? {}),
  };
  const providers =
    config.providerSelection.mode === "shopify-gateway"
      ? { openai: managedProvider() }
      : {};
  const models = {
    providers,
    userProvider: {
      apiKey: providerSentinel,
      headers: { Authorization: headerSentinel },
    },
    ...(options.models ?? {}),
  };
  const settingsRecords = Object.fromEntries(
    managedSettingKeys.map((key) => [
      `/${key}`,
      { valueHash: canonicalHash(config.settings[key]) },
    ]),
  );
  const providerRecords =
    config.providerSelection.mode === "shopify-gateway"
      ? { "/providers/openai": { valueHash: canonicalHash(managedProvider()) } }
      : {};
  const ownershipFiles = {
    "settings.json": settingsRecords,
  };
  if (options.modelsPresent !== false) {
    ownershipFiles["models.json"] = providerRecords;
  }
  const ownership = {
    schemaVersion: 1,
    generation,
    transaction: "committed",
    files: ownershipFiles,
    ...(options.ownership ?? {}),
  };
  writePrivateJson(path.join(agentDir, "settings.json"), settings);
  if (options.modelsPresent !== false) {
    writePrivateJson(path.join(agentDir, "models.json"), models);
  }
  writePrivateJson(path.join(agentDir, "ownership.json"), ownership);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return {
    root,
    agentDir,
    agentMemoryUrl,
    agentMemorySecretReference: "agentmemory-bearer",
    config,
  };
}

function statusEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    AGENTMEMORY_SECRET: agentMemorySecret,
    NO_COLOR: "1",
    ...overrides,
  };
  delete environment.FORCE_COLOR;
  return environment;
}

function runStatus(packageRoot, state, options = {}) {
  const args = options.format === "human" ? [] : ["--json"];
  const result = childProcess.spawnSync(
    path.join(packageRoot, statusExecutable),
    args,
    {
      ...commandOptions,
      cwd: options.cwd ?? commandOptions.cwd,
      env: statusEnvironment(options.environment),
      input: `${JSON.stringify({
        schemaVersion: 1,
        agentDir: state.agentDir,
         agentMemoryUrl: state.agentMemoryUrl,
         agentMemorySecretReference: state.agentMemorySecretReference,
      })}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  return result;
}

function runPrimitiveCliRejectionProbe(kind) {
  const modulePath = path.join(packages.personal, statusModule);
  const script = `
    import { pathToFileURL } from "node:url";

    const module = await import(pathToFileURL(${JSON.stringify(modulePath)}).href);
    const originalArgv = process.argv;
    const originalEnvironment = process.env;
    const originalPrepareStackTrace = Error.prepareStackTrace;
    let getterCalls = 0;
    let prepareStackTraceCalls = 0;
    let trapCalls = 0;
    let environment;

    switch (${JSON.stringify(kind)}) {
      case "inherited-data": {
        const credentialLayer = Object.create(null);
        Object.defineProperty(credentialLayer, "SHOPIFY_PI_TOKEN", {
          enumerable: true,
          value: "invocation",
        });
        environment = Object.create(Object.create(credentialLayer));
        break;
      }
      case "inherited-accessor": {
        const credentialLayer = Object.create(null);
        Object.defineProperty(credentialLayer, "SHOPIFY_PI_TOKEN", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return ${JSON.stringify(providerSentinel)};
          },
        });
        environment = Object.create(Object.create(credentialLayer));
        break;
      }
      case "proxy-prototype": {
        const prototype = new Proxy(Object.create(null), {
          getOwnPropertyDescriptor() {
            trapCalls += 1;
            throw new Error("unexpected descriptor trap");
          },
          getPrototypeOf() {
            trapCalls += 1;
            throw new Error("unexpected prototype trap");
          },
        });
        environment = Object.create(prototype);
        break;
      }
      case "exotic-prototype":
        environment = Object.create(Date.prototype);
        break;
      case "deep-prototype": {
        let prototype = null;
        for (let index = 0; index < 1_024; index += 1) {
          prototype = Object.create(prototype);
        }
        environment = Object.create(prototype);
        break;
      }
      case "prepare-stack-trace":
        environment = Object.create(null);
        Error.prepareStackTrace = () => {
          prepareStackTraceCalls += 1;
          return ${JSON.stringify(providerSentinel)};
        };
        break;
      default:
        throw new Error("unknown probe kind");
    }

    let code;
    try {
      process.argv = [process.execPath, "pi-agent-status", "--yaml"];
      process.env = environment;
      code = await module.runManagedStatusCli();
    } finally {
      process.argv = originalArgv;
      process.env = originalEnvironment;
      Error.prepareStackTrace = originalPrepareStackTrace;
    }
    process.stdout.write(JSON.stringify({
      code,
      getterCalls,
      prepareStackTraceCalls,
      trapCalls,
    }) + "\\n");
  `;
  const result = childProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      ...commandOptions,
      env: { NO_COLOR: "1" },
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return { result, observation: JSON.parse(result.stdout) };
}

function runInheritedCredentialStatusProbe(state, kind) {
  const modulePath = path.join(packages.personal, statusModule);
  const script = `
    import { pathToFileURL } from "node:url";

    const module = await import(pathToFileURL(${JSON.stringify(modulePath)}).href);
    const originalArgv = process.argv;
    const originalEnvironment = process.env;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const credentialLayer = Object.create(null);
    let getterCalls = 0;
    const descriptor = ${JSON.stringify(kind)} === "data"
      ? { enumerable: true, value: ${JSON.stringify(providerSentinel)} }
      : {
          enumerable: true,
          get() {
            getterCalls += 1;
            return ${JSON.stringify(providerSentinel)};
          },
        };
    Object.defineProperty(credentialLayer, "SHOPIFY_PI_TOKEN", descriptor);
    const environment = Object.create(Object.create(credentialLayer));
    const output = { stdout: "", stderr: "" };
    const capture = (stream) => (chunk, encoding, callback) => {
      output[stream] += typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encoding === "string" ? encoding : "utf8",
          );
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    };

    let code;
    try {
      process.argv = [process.execPath, "pi-agent-status", "--json"];
      process.env = environment;
      process.stdout.write = capture("stdout");
      process.stderr.write = capture("stderr");
      code = await module.runManagedStatusCli();
    } finally {
      process.argv = originalArgv;
      process.env = originalEnvironment;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    originalStdoutWrite.call(process.stdout, JSON.stringify({
      code,
      getterCalls,
      stdout: output.stdout,
      stderr: output.stderr,
    }) + "\\n");
  `;
  const result = childProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      ...commandOptions,
      env: { NO_COLOR: "1" },
      input: `${JSON.stringify({
        schemaVersion: 1,
        agentDir: state.agentDir,
         agentMemoryUrl: state.agentMemoryUrl,
         agentMemorySecretReference: state.agentMemorySecretReference,
      })}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function parseSuccessfulJson(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
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

function expectedComplete(state, providerMode, sandboxState, profile) {
  return {
    generation,
    piVersion: "0.83.0",
    providerMode,
    sandboxState,
    profile,
    mcpEndpoint: "http://127.0.0.1:8080/mcp",
    mcpReady: true,
     agentMemoryUrl: state.agentMemoryUrl,
     agentMemoryReady: true,
    extensions: extensionVersions,
    drift: [],
    lsp: { nix: "ready" },
    status: "complete",
    issues: [],
  };
}

function assertExtensionDegraded(report) {
  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.extensions,
    Object.fromEntries(
      Object.keys(extensionVersions).map((name) => [name, "unavailable"]),
    ),
  );
  assert.deepEqual(report.issues, [
    {
      component: "extensions",
      state: "degraded",
      recovery:
        "rebuild pi-agent-extensions and activate the managed generation",
    },
  ]);
}

test("the packaged component exposes one read-only status surface", async () => {
  for (const packageRoot of Object.values(packages)) {
    const executable = path.join(packageRoot, statusExecutable);
    const modulePath = path.join(packageRoot, statusModule);
    assert.equal(fs.existsSync(executable), true, executable);
    assert.notEqual(fs.statSync(executable).mode & 0o111, 0, executable);
    assert.equal(fs.existsSync(modulePath), true, modulePath);
    assert.equal(
      fs.existsSync(
        path.join(packageRoot, "lib/pi-agent/mcp-status-probe.mjs"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(packageRoot, "lib/pi-agent/extension-status-probe.mjs"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(packageRoot, "share/pi-agent/managed-config.json"),
      ),
      true,
    );
  }

  const source = fs.readFileSync(
    path.join(packages.production, statusModule),
    "utf8",
  );
  const wrapperSource = fs.readFileSync(
    path.join(packages.production, "bin/pi-agent-status.mjs"),
    "utf8",
  );
  const packageExpression = fs.readFileSync(
    path.join(repoRoot, "scripts/pi-agent-status.nix"),
    "utf8",
  );
  assert.doesNotMatch(packageExpression, /enableManagedStatus|STATUS_ENABLED/);
  assert.doesNotMatch(
    source,
    /PI_AGENT_STATUS_ENABLED|feature is disabled|not implemented/,
  );
  assert.match(source, /scrubEnvironment/);
  assert.match(source, /MCP_PROBE_MODULE/);
  assert.match(source, /EXTENSION_PROBE_MODULE/);
  assert.match(source, /AUTHORITATIVE_SENSITIVE_NAMES/);
  assert.match(source, /cwd: PROBE_CWD/);
  assert.doesNotMatch(source, /__PI_AGENT_STATUS_/);
  assert.doesNotMatch(source, /await module\.preflightMcpproxy/);
   assert.match(source, /agentmemory\/health/);
  assert.doesNotMatch(
    source,
    /spawn(?:Sync)?\([^\n]*PI_EXECUTABLE|bin\/pi["']/,
  );
  assert.match(packageExpression, /\bextensionIdentity,/);
  assert.doesNotMatch(
    source,
    /PI_AGENT_EXTENSION_IDENTITY|process\.env\[[^\]]*IDENTITY/,
  );
  assert.doesNotMatch(source, /\bnlink\b/);
  assert.match(
    wrapperSource,
    /await import\("\.\.\/lib\/pi-agent\/status\.mjs"\)/,
  );
  assert.match(wrapperSource, /catch \{/);
  assert.doesNotMatch(wrapperSource, /^import /m);

  const probeSource = fs.readFileSync(
    path.join(packages.production, "lib/pi-agent/mcp-status-probe.mjs"),
    "utf8",
  );
  assert.match(probeSource, /await module\.preflightMcpproxy/);
  const preflightPath = probeSource.match(
    /const PREFLIGHT_MODULE = "([^"]+)";/,
  )?.[1];
  assert.match(preflightPath ?? "", /^\/nix\/store\//);
  const preflight = await import(pathToFileURL(preflightPath));
  assert.equal(typeof preflight.preflightMcpproxy, "function");
  assert.equal(
    preflight.MCPPROXY_PREFLIGHT_CONTRACT.mcpUrl,
    "http://127.0.0.1:8080/mcp",
  );

  const extensionProbeSource = fs.readFileSync(
    path.join(packages.production, "lib/pi-agent/extension-status-probe.mjs"),
    "utf8",
  );
  assert.match(
    extensionProbeSource,
    /MANAGED_EXTENSION_IDENTITY_PATH !== EXPECTED_IDENTITY_PATH/,
  );
  assert.match(extensionProbeSource, /module\.loadManagedExtensionPackage\(\)/);
  assert.match(
    extensionProbeSource,
    /const EXPECTED_IDENTITY_PATH = "\/nix\/store\/[^"]+-identity\/extensions-provenance\.json"/,
  );
  assert.doesNotMatch(extensionProbeSource, /process\.env/);
  assert.doesNotMatch(
    extensionProbeSource,
    /loadManagedExtensionPackage\([^)]/,
  );

  assert.deepEqual(Object.keys(personalStatusModule), ["runManagedStatusCli"]);
});

test("review round 3 RED exports only the primitive status CLI entrypoint", () => {
  assert.deepEqual(Object.keys(personalStatusModule), ["runManagedStatusCli"]);
  assert.equal(personalStatusModule.runManagedStatusCli.length, 0);
});

test("review round 3 RED inherited data credentials suppress colliding CLI diagnostics", () => {
  const { result, observation } =
    runPrimitiveCliRejectionProbe("inherited-data");
  assert.deepEqual(observation, {
    code: 2,
    getterCalls: 0,
    prepareStackTraceCalls: 0,
    trapCalls: 0,
  });
  assert.equal(result.stderr, "");
});

test("valid status rejects inherited credential data without reading it", (t) => {
  const state = createState(t, packages.personal);
  const observation = runInheritedCredentialStatusProbe(state, "data");
  assert.equal(observation.code, 2);
  assert.equal(observation.getterCalls, 0);
  assert.equal(observation.stdout, "");
  assert.equal(observation.stderr, "");
  assert.equal(JSON.stringify(observation).includes(providerSentinel), false);
});

test("valid status rejects inherited credential accessors without invoking them", (t) => {
  const state = createState(t, packages.personal);
  const observation = runInheritedCredentialStatusProbe(state, "accessor");
  assert.equal(observation.code, 2);
  assert.equal(observation.getterCalls, 0);
  assert.equal(observation.stdout, "");
  assert.equal(observation.stderr, "");
  assert.equal(JSON.stringify(observation).includes(providerSentinel), false);
});

test("review round 3 RED inherited credential accessors fail closed without getter calls", () => {
  const { result, observation } = runPrimitiveCliRejectionProbe(
    "inherited-accessor",
  );
  assert.deepEqual(observation, {
    code: 2,
    getterCalls: 0,
    prepareStackTraceCalls: 0,
    trapCalls: 0,
  });
  assert.equal(result.stderr, "");
});

for (const kind of [
  "proxy-prototype",
  "exotic-prototype",
  "deep-prototype",
]) {
  test(`review round 3 RED ${kind} environments fail closed within the CLI boundary`, () => {
    const { result, observation } = runPrimitiveCliRejectionProbe(kind);
    assert.deepEqual(observation, {
      code: 2,
      getterCalls: 0,
      prepareStackTraceCalls: 0,
      trapCalls: 0,
    });
    assert.equal(result.stderr, "");
  });
}

test("review round 3 RED CLI rejection does not invoke Error.prepareStackTrace", () => {
  const { result, observation } = runPrimitiveCliRejectionProbe(
    "prepare-stack-trace",
  );
  assert.deepEqual(observation, {
    code: 2,
    getterCalls: 0,
    prepareStackTraceCalls: 0,
    trapCalls: 0,
  });
  assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
});

test("complete personal status is stable in JSON and human formats", (t) => {
  const state = createState(t, packages.personal);
  const models = readJson(path.join(state.agentDir, "models.json"));
  delete models.providers;
  writePrivateJson(path.join(state.agentDir, "models.json"), models);
  const marker = path.join(state.root, "pi-started");
  const environment = {
    PI_AGENT_FAKE_PI_MARKER: marker,
    PI_NONO: "audit",
  };
  const first = runStatus(packages.personal, state, { environment });
  const second = runStatus(packages.personal, state, { environment });
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(
    parseSuccessfulJson(first),
    expectedComplete(state, "personal", "audit", "pi-audit"),
  );

  const humanFirst = runStatus(packages.personal, state, {
    environment,
    format: "human",
  });
  const humanSecond = runStatus(packages.personal, state, {
    environment,
    format: "human",
  });
  assert.equal(humanFirst.status, 0, humanFirst.stderr);
  assert.equal(humanFirst.stderr, "");
  assert.equal(humanFirst.stdout, humanSecond.stdout);
  assert.equal(
    humanFirst.stdout,
    [
      "Pi managed status: complete",
      `Generation: ${generation}`,
      "Pi: 0.83.0",
      "Provider: personal",
      "Sandbox: audit (pi-audit)",
      "MCP: ready (http://127.0.0.1:8080/mcp)",
       `AgentMemory: ready (${state.agentMemoryUrl})`,
       "Extensions: agentmemory=0.9.29, backgroundTasks=2.0.0, bashTimeout=4.6.0, codeIntelligence=4.6.0, mcp=0.1.0, plan=0.49.2, questions=4.6.0, subagents=0.40.0, timestamps=0.49.3",
      "LSP: nix=ready",
      "Drift: none",
      "Recovery: none",
      "",
    ].join("\n"),
  );
  assert.equal(fs.existsSync(marker), false, "managed status started Pi");
});

test("canonical personal state permits an absent models file and ownership entry", (t) => {
  const state = createState(t, packages.personal, { modelsPresent: false });
  assert.equal(fs.existsSync(path.join(state.agentDir, "models.json")), false);
  assert.deepEqual(
    parseSuccessfulJson(runStatus(packages.personal, state)),
    expectedComplete(state, "personal", "audit", "pi-audit"),
  );
});

test("Shopify status reports the effective review profile without provider detail", (t) => {
  const state = createState(t, packages.shopify);
  const marker = path.join(state.root, "pi-started");
  const report = parseSuccessfulJson(
    runStatus(packages.shopify, state, {
      environment: {
        PI_AGENT_FAKE_PI_MARKER: marker,
        PI_NONO: "enforced",
        PI_NONO_PROFILE: "pi-review",
      },
    }),
  );
  assert.deepEqual(
    report,
    expectedComplete(state, "shopify-gateway", "enforced", "pi-review"),
  );
  assert.equal(JSON.stringify(report).includes("baseUrl"), false);
  assert.equal(JSON.stringify(report).includes("headers"), false);
  assert.equal(JSON.stringify(report).includes("apiKey"), false);
  assert.equal(fs.existsSync(marker), false, "managed status started Pi");
});

test("degraded components and configured-only LSP state retain deterministic recovery", (t) => {
  const state = createState(t, packages.degraded);
  const degradedEnvironment = { AGENTMEMORY_SECRET: "agentmemory-degraded-secret" };
  const first = runStatus(packages.degraded, state, { environment: degradedEnvironment });
  const second = runStatus(packages.degraded, state, { environment: degradedEnvironment });
  assert.equal(first.stdout, second.stdout);
  const report = parseSuccessfulJson(first);
  assert.equal(report.status, "degraded");
  assert.equal(report.mcpReady, false);
  assert.equal(report.agentMemoryReady, false);
  assert.deepEqual(report.lsp, { nix: "ready", typescript: "missing" });
  assert.deepEqual(report.extensions, {
    backgroundTasks: "unavailable",
    bashTimeout: "unavailable",
    agentmemory: "unavailable",
    codeIntelligence: "unavailable",
    mcp: "unavailable",
    plan: "unavailable",
    questions: "unavailable",
    subagents: "unavailable",
    timestamps: "unavailable",
  });
  assert.deepEqual(report.drift, []);
  assert.deepEqual(report.issues, [
    {
      component: "agentmemory",
      state: "degraded",
      recovery:
        "restart the AgentMemory daemon and verify its authenticated health route",
    },
    {
      component: "extensions",
      state: "degraded",
      recovery:
        "rebuild pi-agent-extensions and activate the managed generation",
    },
    {
      component: "lsp:typescript",
      state: "missing",
      recovery:
        "rebuild the configured language server and activate the managed generation",
    },
    {
      component: "mcp",
      state: "degraded",
      recovery: "restart mcpproxy or repair the declared upstream",
    },
  ]);
  for (const sentinel of [providerSentinel, adminSentinel, headerSentinel]) {
    assert.equal(first.stdout.includes(sentinel), false, first.stdout);
    assert.equal(first.stderr.includes(sentinel), false, first.stderr);
  }
});

test("reconciliation drift is observational, pointer-only, and non-mutating", (t) => {
  const state = createState(t, packages.personal, {
    settings: { shellPath: providerSentinel },
  });
  const before = snapshotTree(state.root);
  const first = runStatus(packages.personal, state);
  const second = runStatus(packages.personal, state);
  assert.equal(first.stdout, second.stdout);
  const report = parseSuccessfulJson(first);
  assert.equal(report.status, "drifted");
  assert.deepEqual(report.drift, ["settings.shellPath.value"]);
  assert.deepEqual(report.issues, [
    {
      component: "reconciliation",
      state: "drifted",
      recovery: "repair managed Pi state and rerun reconciliation",
    },
  ]);
  assert.equal(JSON.stringify(report).includes(providerSentinel), false);
  assert.deepEqual(snapshotTree(state.root), before);
});

test("credential and header sentinels never cross either output format or child probes", (t) => {
  const state = createState(t, packages.shopify, {
  });
  const models = readJson(path.join(state.agentDir, "models.json"));
  models.providers.openai = managedProvider(providerSentinel);
  models.userProvider = {
    apiKey: openAiSentinel,
    headers: {
      Authorization: headerSentinel,
      "X-API-Key": adminSentinel,
    },
  };
  writePrivateJson(path.join(state.agentDir, "models.json"), models);

  const environment = {
    SHOPIFY_PI_TOKEN: providerSentinel,
    PI_AGENT_LAUNCH_ID: launchSentinel,
    OPENAI_API_KEY: openAiSentinel,
  };
  const jsonResult = runStatus(packages.shopify, state, { environment });
  const secondJsonResult = runStatus(packages.shopify, state, { environment });
  assert.equal(jsonResult.stdout, secondJsonResult.stdout);
  const report = parseSuccessfulJson(jsonResult);
  const humanResult = runStatus(packages.shopify, state, {
    environment,
    format: "human",
  });
  const secondHumanResult = runStatus(packages.shopify, state, {
    environment,
    format: "human",
  });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.equal(humanResult.stdout, secondHumanResult.stdout);
  assert.equal(
    report.mcpReady,
    true,
    "MCP probe did not receive its isolated admin key",
  );
  assert.equal(
    report.agentMemoryReady,
    true,
  );
  assert.equal(report.status, "drifted");
  assert.deepEqual(report.drift, ["models.provider.openai.value"]);
  assert.equal(report.agentMemoryUrl, state.agentMemoryUrl);

  const combined = `${jsonResult.stdout}\n${jsonResult.stderr}\n${humanResult.stdout}\n${humanResult.stderr}`;
  for (const sentinel of [
    providerSentinel,
    launchSentinel,
    openAiSentinel,
    adminSentinel,
    headerSentinel,
  ]) {
    assert.equal(combined.includes(sentinel), false, combined);
  }
});

for (const secret of ["constructor", "[object Object]"]) {
  test(`command output remains collision-safe for ${JSON.stringify(secret)}`, (t) => {
    const state = createState(t, packages.personal);
    for (const format of ["human", "json"]) {
      const result = runStatus(packages.personal, state, {
        format,
        environment: { SHOPIFY_PI_TOKEN: secret },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.includes(secret), false, result.stdout);
    }
  });
}

test("source-controlled ownership keys cannot become drift output", (t) => {
  const state = createState(t, packages.personal);
  const ownership = readJson(path.join(state.agentDir, "ownership.json"));
  ownership.files["settings.json"][`/${providerSentinel}\nInjected: yes`] = {
    valueHash: canonicalHash("hostile"),
  };
  writePrivateJson(path.join(state.agentDir, "ownership.json"), ownership);

  const jsonResult = runStatus(packages.personal, state, {
    environment: { SHOPIFY_PI_TOKEN: providerSentinel },
  });
  const report = parseSuccessfulJson(jsonResult);
  const humanResult = runStatus(packages.personal, state, {
    environment: { SHOPIFY_PI_TOKEN: providerSentinel },
    format: "human",
  });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.equal(report.status, "drifted");
  assert.deepEqual(report.drift, ["ownership.invalid"]);
  const combined = `${jsonResult.stdout}\n${humanResult.stdout}\n${jsonResult.stderr}\n${humanResult.stderr}`;
  assert.equal(combined.includes(providerSentinel), false, combined);
  assert.equal(combined.includes("Injected: yes"), false, combined);
});

test("shared-policy probe environments remove exact values from retained names", (t) => {
  const state = createState(t, packages.personal);
  const credentialHome = path.join(state.root, `home-${providerSentinel}`);
  fs.mkdirSync(credentialHome, { mode: 0o700 });
  const report = parseSuccessfulJson(
    runStatus(packages.personal, state, {
      environment: {
        HOME: credentialHome,
        SHOPIFY_PI_TOKEN: providerSentinel,
      },
    }),
  );
  assert.equal(report.mcpReady, true);
  assert.equal(report.agentMemoryReady, true);
});

test("every probe replaces a credential-bearing caller cwd with the fixed safe cwd", (t) => {
  const state = createState(t, packages.personal);
  const callerCwd = path.join(state.root, `caller-${providerSentinel}`);
  fs.mkdirSync(callerCwd, { mode: 0o700 });
  const report = parseSuccessfulJson(
    runStatus(packages.personal, state, {
      cwd: callerCwd,
      environment: { SHOPIFY_PI_TOKEN: providerSentinel },
    }),
  );
  assert.deepEqual(
    report,
    expectedComplete(state, "personal", "audit", "pi-audit"),
  );
});

test("probe environments never inherit credential-bearing HOME or path values after Keychain failure", (t) => {
  const state = createState(t, packages["lookup-failure"]);
  const credentialHome = path.join(state.root, `home-${adminSentinel}`);
  fs.mkdirSync(credentialHome, { mode: 0o700 });
  const result = runStatus(packages["lookup-failure"], state, {
    environment: {
      HOME: credentialHome,
      PATH: `/usr/bin:${adminSentinel}`,
      TMPDIR: path.join(state.root, `tmp-${adminSentinel}`),
      XDG_CONFIG_HOME: path.join(state.root, `config-${adminSentinel}`),
    },
  });
  const report = parseSuccessfulJson(result);
  assert.equal(report.mcpReady, false);
  assert.equal(report.agentMemoryReady, true);
  assert.deepEqual(report.issues, [
    {
      component: "mcp",
      state: "degraded",
      recovery: "restart mcpproxy or repair the declared upstream",
    },
  ]);
  assert.equal(
    fs.existsSync(path.join(state.root, "keychain-secret-observed")),
    false,
  );
  assert.equal(
    `${result.stdout}\n${result.stderr}`.includes(adminSentinel),
    false,
  );
});

for (const [label, control] of [
  ["C0 controls", "\u001f"],
  ["C1 controls", "\u0085"],
  ["U+2028", "\u2028"],
  ["U+2029", "\u2029"],
]) {
  test(`required paths reject ${label} before human rendering`, (t) => {
    const state = createState(t, packages.personal);
    for (const field of ["agentDir", "agentMemoryUrl", "agentMemorySecretReference"]) {
      const result = runStatus(
        packages.personal,
        {
          ...state,
          [field]: `${state[field]}${control}Injected: yes`,
        },
        { format: "human" },
      );
      assert.equal(result.status, 2, `${field} accepted ${label}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
      assert.equal(result.stderr.includes("Injected: yes"), false);
    }
  });
}

for (const { label, secret } of [
  {
    label: "extension",
    secret: "backgroundTasks",
  },
  { label: "LSP", secret: "nix" },
]) {
  test(`exact credentials matching managed ${label} names fail closed`, (t) => {
    const state = createState(t, packages.personal);
    const options = { environment: { SHOPIFY_PI_TOKEN: secret } };
    const jsonResult = runStatus(packages.personal, state, options);
    const humanResult = runStatus(packages.personal, state, {
      ...options,
      format: "human",
    });
    for (const result of [jsonResult, humanResult]) {
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
    }
    assert.equal(
      `${jsonResult.stdout}\n${jsonResult.stderr}\n${humanResult.stdout}\n${humanResult.stderr}`.includes(
        secret,
      ),
      false,
    );
  });
}

for (const { label, secret } of [
  { label: "provider mode", secret: "personal" },
  { label: "sandbox state", secret: "audit" },
  { label: "profile", secret: "pi-audit" },
  { label: "status", secret: "complete" },
  { label: "LSP state", secret: "ready" },
  { label: "Pi version", secret: "0.83.0" },
  { label: "generation", secret: generation },
]) {
  test(`post-redaction schema rejects an exact credential matching ${label}`, (t) => {
    const state = createState(t, packages.personal);
    const result = runStatus(packages.personal, state, {
      environment: { SHOPIFY_PI_TOKEN: secret },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
  });
}

for (const { label, secret, format, otherFormat } of [
  {
    label: "JSON boolean text",
    secret: "true",
    format: "json",
    otherFormat: "human",
  },
  {
    label: "human empty-state text",
    secret: "none",
    format: "human",
    otherFormat: "json",
  },
  {
    label: "human heading text",
    secret: "Pi managed status",
    format: "human",
    otherFormat: "json",
  },
]) {
  test(`the selected rendering rejects an exact credential matching ${label}`, (t) => {
    const state = createState(t, packages.personal);
    const result = runStatus(packages.personal, state, {
      format,
      environment: { SHOPIFY_PI_TOKEN: secret },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);

    const otherResult = runStatus(packages.personal, state, {
      format: otherFormat,
      environment: { SHOPIFY_PI_TOKEN: secret },
    });
    assert.equal(otherResult.status, 0, otherResult.stderr);
    assert.equal(otherResult.stderr, "");
    assert.equal(otherResult.stdout.includes(secret), false, otherResult.stdout);
  });
}

test("validated JSON rejects an exact credential matching false", (t) => {
  const state = createState(t, packages.personal);
  const result = runStatus(packages.personal, state, {
    environment: { SHOPIFY_PI_TOKEN: "false" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("false"), false);
});

for (const format of ["human", "json"]) {
  test(`rejection output omits an exact status credential in ${format} mode`, (t) => {
    const state = createState(t, packages.personal);
    const result = runStatus(packages.personal, state, {
      format,
      environment: { SHOPIFY_PI_TOKEN: "status" },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(
      `${result.stdout}\n${result.stderr}`.includes("status"),
      false,
    );
  });
}

test("every CLI rejection path suppresses colliding fixed diagnostic tokens", (t) => {
  const state = createState(t, packages.personal);
  const executable = path.join(packages.personal, statusExecutable);
  const cases = [
    { secret: "pi-agent", args: ["--yaml"], input: "" },
    { secret: "invocation", args: ["--json"], input: "{" },
    {
      secret: "rejected",
      args: ["--json"],
      input: `${JSON.stringify({
        schemaVersion: 1,
        agentDir: "relative",
         agentMemoryUrl: state.agentMemoryUrl,
         agentMemorySecretReference: state.agentMemorySecretReference,
      })}\n`,
    },
  ];
  for (const { secret, args, input } of cases) {
    const result = childProcess.spawnSync(executable, args, {
      ...commandOptions,
      env: statusEnvironment({ SHOPIFY_PI_TOKEN: secret }),
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, secret);
    assert.equal(result.stdout, "", secret);
    assert.equal(result.stderr, "", secret);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
  }
});

test("malformed CLI input remains collision-safe in human and JSON modes", (t) => {
  const state = createState(t, packages.personal);
  const executable = path.join(packages.personal, statusExecutable);
  const secrets = [
    "invalid",
    "personal",
    "status",
    "complete",
    "ready",
    "son",
    "personal-superset",
    "constructor",
    "[object Object]",
    "a",
    "1",
    "秘密",
    "\u001f",
    "\u0085",
    "\u2028",
    "\u2029",
    "Bearer formatter-header-secret",
  ];
  const input = `${JSON.stringify({
    schemaVersion: 1,
    agentDir: "relative",
     agentMemoryUrl: state.agentMemoryUrl,
     agentMemorySecretReference: state.agentMemorySecretReference,
  })}\n`;
  for (const args of [[], ["--json"]]) {
    for (const secret of secrets) {
      const result = childProcess.spawnSync(executable, args, {
        ...commandOptions,
        env: statusEnvironment({ SHOPIFY_PI_TOKEN: secret }),
        input,
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.ifError(result.error);
      assert.equal(result.status, 2, JSON.stringify(secret));
      assert.equal(result.stdout, "", JSON.stringify(secret));
      assert.equal(
        `${result.stdout}\n${result.stderr}`.includes(secret),
        false,
        JSON.stringify(secret),
      );
    }
  }
});

test("exact credentials matching closed status object keys fail closed", (t) => {
  const state = createState(t, packages.personal);
  const result = runStatus(packages.personal, state, {
    environment: { SHOPIFY_PI_TOKEN: "issues" },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
});

test("redacted object-key collisions fail closed", (t) => {
  const state = createState(t, packages.personal);
  const result = runStatus(packages.personal, state, {
    environment: {
      SHOPIFY_PI_TOKEN: "backgroundTasks",
      PI_AGENT_LAUNCH_ID: "bashTimeout",
    },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
});

test("ownership state is closed at every structural level", async (t) => {
  const variants = [
    ["root field", (ownership) => (ownership[providerSentinel] = true)],
    ["file", (ownership) => (ownership.files[providerSentinel] = {})],
    [
      "record field",
      (ownership) =>
        (ownership.files["settings.json"]["/shellPath"][providerSentinel] =
          true),
    ],
  ];
  for (const [name, mutate] of variants) {
    await t.test(name, () => {
      const state = createState(t, packages.personal);
      const ownership = readJson(path.join(state.agentDir, "ownership.json"));
      mutate(ownership);
      writePrivateJson(path.join(state.agentDir, "ownership.json"), ownership);
      const result = runStatus(packages.personal, state, {
        environment: { SHOPIFY_PI_TOKEN: providerSentinel },
      });
      const report = parseSuccessfulJson(result);
      assert.equal(report.status, "drifted");
      assert.deepEqual(report.drift, ["ownership.invalid"]);
      assert.equal(
        result.stdout.includes(providerSentinel),
        false,
        result.stdout,
      );
    });
  }
});

test("extension readiness requires the canonical readable package entrypoint", (t) => {
  const state = createState(t, packages["missing-extension"]);
  const report = parseSuccessfulJson(
    runStatus(packages["missing-extension"], state),
  );
  assert.equal(report.status, "degraded");
  assert.equal(report.extensions.mcp, "unavailable");
  assert.deepEqual(report.issues, [
    {
      component: "extensions",
      state: "degraded",
      recovery:
        "rebuild pi-agent-extensions and activate the managed generation",
    },
  ]);
});

test("extension readiness accepts a coherent package with a legitimate hardlink", (t) => {
  const state = createState(t, packages["hardlink-extension"]);
  assert.deepEqual(
    parseSuccessfulJson(runStatus(packages["hardlink-extension"], state)),
    expectedComplete(state, "personal", "audit", "pi-audit"),
  );
});

for (const [label, packageName] of [
  ["intermediate symlink", "component-symlink-extension"],
  ["leaf symlink", "leaf-symlink-extension"],
  ["package and local inventory recomputation", "recomputed-extension"],
  ["manifest alias", "manifest-alias"],
  ["identity alias", "identity-alias"],
]) {
  test(`extension readiness rejects ${label} through the loader identity contract`, (t) => {
    const state = createState(t, packages[packageName]);
    assertExtensionDegraded(
      parseSuccessfulJson(runStatus(packages[packageName], state)),
    );
  });
}

test("invalid invocations fail with one fixed value-free diagnostic", (t) => {
  const state = createState(t, packages.personal);
  const executable = path.join(packages.personal, statusExecutable);
  const cases = [
    { args: ["--yaml"], input: "" },
    { args: ["--json"], input: "{" },
    {
      args: ["--json"],
      input: `${JSON.stringify({
        schemaVersion: 1,
        agentDir: providerSentinel,
         agentMemoryUrl: state.agentMemoryUrl,
         agentMemorySecretReference: state.agentMemorySecretReference,
      })}\n`,
    },
  ];
  for (const fixture of cases) {
    const result = childProcess.spawnSync(executable, fixture.args, {
      ...commandOptions,
      env: statusEnvironment({ SHOPIFY_PI_TOKEN: providerSentinel }),
      input: fixture.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "pi-agent-status: invocation rejected\n");
    assert.equal(result.stderr.includes(providerSentinel), false);
  }
});
