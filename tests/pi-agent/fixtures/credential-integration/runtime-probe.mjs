import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [
  piRoot,
  extensionRoot,
  shellRoot,
  cavememRoot,
  nonoRoot,
  profilePath,
  lspRoot,
  statusRoot,
  validatorRoot,
  credentialPolicyRoot,
  personalCredentialPolicyRoot,
  sqliteRoot,
] = process.argv.slice(2);

if ([
  piRoot,
  extensionRoot,
  shellRoot,
  cavememRoot,
  nonoRoot,
  profilePath,
  lspRoot,
  statusRoot,
  validatorRoot,
  credentialPolicyRoot,
  personalCredentialPolicyRoot,
  sqliteRoot,
].some((value) => !value)) {
  throw new Error("credential integration runtime paths are required");
}

const token = "task-7-5-shopify-token-sentinel-8f4a";
const launchId = "75000000-0000-4000-8000-000000000075";
const ambientSentinels = [
  "task-7-5-ambient-openai-sentinel",
  "task-7-5-ambient-anthropic-sentinel",
  "task-7-5-ambient-mcpproxy-sentinel",
];
const personalToken = "task-7-5-personal-openai-auth-sentinel";
const providerSentinels = [token, launchId, ...ambientSentinels];
const allSentinels = [...providerSentinels, personalToken];
const forbiddenEnvironmentNames = [
  "SHOPIFY_PI_TOKEN",
  "PI_AGENT_LAUNCH_ID",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MCPPROXY_API_KEY",
];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-credential-integration-"));
const workspace = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
const childAgentDir = path.join(root, "child-agent");
const errorAgentDir = path.join(root, "error-agent");
const timeoutAgentDir = path.join(root, "timeout-agent");
const cancellationAgentDir = path.join(root, "cancellation-agent");
const personalAgentDir = path.join(root, "personal-agent");
const sessionsDir = path.join(root, "sessions");
const dataDir = path.join(root, "cavemem");
const tmpDir = path.join(root, "tmp");
const auditLog = path.join(root, "nono-audit.log");
const probeLog = path.join(root, "probe.log");
const shellOutput = path.join(root, "shell-output.txt");
const lspObservation = path.join(workspace, ".task-7-5-lsp-observation.json");
const personalAuthPath = path.join(personalAgentDir, "auth.json");
const cavememEnvironmentEvidence = path.join(dataDir, "environment-tripwire.jsonl");
const statusEnvironmentEvidence = path.join(root, "status-environment-tripwire.jsonl");
const validatorEnvironmentEvidence = path.join(root, "validator-environment-tripwire.jsonl");
const backgroundPipeEvidencePath = path.join(root, "background-pipe-environment.json");
const backgroundPtyEvidencePath = path.join(root, "background-pty-environment.json");
const backgroundPipePath = path.join(root, "background-pipe.mjs");
const backgroundPtyPath = path.join(root, "background-pty.mjs");

const cleanupState = {
  groups: new Set(),
  processes: new Set(),
  servers: new Set(),
};

for (const directory of [
  workspace,
  agentDir,
  childAgentDir,
  errorAgentDir,
  timeoutAgentDir,
  cancellationAgentDir,
  personalAgentDir,
  sessionsDir,
  dataDir,
  tmpDir,
  path.join(workspace, ".pi"),
]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(path.join(workspace, "source.ts"), "export const credentialIsolationFixture = true;\n", { mode: 0o600 });
fs.writeFileSync(path.join(workspace, "package.json"), "{\"name\":\"task-7-5-credential-fixture\",\"private\":true}\n", { mode: 0o600 });

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function backgroundEnvironmentEvidenceSource(mode, role, outputPath) {
  return `
import crypto from "node:crypto";
import fs from "node:fs";

const SENTINEL_HASHES = ${JSON.stringify(sentinelHashes)};
const FORBIDDEN_NAMES = ${JSON.stringify(forbiddenEnvironmentNames)};
const MODE = ${JSON.stringify(mode)};
const ROLE = ${JSON.stringify(role)};
const OUTPUT_PATH = ${JSON.stringify(outputPath)};

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const entries = Object.entries(process.env)
  .sort(([left], [right]) => left.localeCompare(right));
const values = Object.fromEntries(entries.map(([name, value]) => [name, {
  length: value.length,
  sha256: digest(value),
}]));
const sentinelValueHashes = entries
  .map(([, value]) => digest(value))
  .filter((hash) => Object.hasOwn(SENTINEL_HASHES, hash));
const observed = {
  schemaVersion: 1,
  mode: MODE,
  role: ROLE,
  names: entries.map(([name]) => name),
  values,
  forbiddenNames: entries
    .filter(([name]) => FORBIDDEN_NAMES.includes(name))
    .map(([name]) => name),
  sentinelValueHashes,
  sentinelValueNames: entries
    .filter(([, value]) => Object.hasOwn(SENTINEL_HASHES, digest(value)))
    .map(([name]) => name),
};
fs.mkdirSync(${JSON.stringify(path.dirname(outputPath))}, { recursive: true, mode: 0o700 });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(observed) + "\\n", { mode: 0o600 });
if (observed.forbiddenNames.length > 0 || observed.sentinelValueHashes.length > 0) {
  process.exit(71);
}
process.stdout.write("task-7-5-background-ready\\n");
process.stdin.resume();
setInterval(() => {}, 0x7fffffff);
`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const sentinelHashes = Object.freeze(Object.fromEntries([
  [sha256(token), "provider-token"],
  [sha256(launchId), "provider-launch-id"],
  ...ambientSentinels.map((value, index) => [sha256(value), `ambient-${index}`]),
  [sha256(personalToken), "personal-token"],
]));

function environmentTripwireSource(label, outputPath, { spawnWorker = false } = {}) {
  const source = `
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const SENTINEL_HASHES = ${JSON.stringify(sentinelHashes)};
const FORBIDDEN_NAMES = ${JSON.stringify(forbiddenEnvironmentNames)};
const OUTPUT_PATH = ${JSON.stringify(outputPath)};
const LABEL = ${JSON.stringify(label)};
const ROLE = process.argv[2] === "--worker" ? "worker" : "hook";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const entries = Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right));
const values = Object.fromEntries(entries.map(([name, value]) => [name, {
  length: value.length,
  sha256: digest(value),
}]));
const observed = {
  label: LABEL,
  role: ROLE,
  names: entries.map(([name]) => name),
  values,
  forbiddenNames: entries
    .filter(([name]) => FORBIDDEN_NAMES.includes(name))
    .map(([name]) => name),
  sentinelValueNames: entries
    .filter(([, value]) => Object.hasOwn(SENTINEL_HASHES, digest(value)))
    .map(([name]) => name),
};
fs.mkdirSync(${JSON.stringify(dataDir)}, { recursive: true, mode: 0o700 });
fs.appendFileSync(\`\${OUTPUT_PATH}.\${ROLE}\`, JSON.stringify(observed) + "\\n", { mode: 0o600 });
const clean = observed.forbiddenNames.length === 0 && observed.sentinelValueNames.length === 0;
if (!clean) process.exitCode = 71;
${spawnWorker ? `
if (ROLE === "hook") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.once("end", () => {
    const worker = spawnSync(process.execPath, [process.argv[1], "--worker", process.argv[3] ?? "unknown"], {
      env: { ...process.env },
      stdio: "ignore",
    });
    if (worker.status !== 0) process.exitCode = worker.status ?? 1;
  });
} else {
  process.exit(process.exitCode ?? 0);
}
` : ""}
`;
  return source;
}

function environmentEvidencePaths(file) {
  return [file, `${file}.hook`, `${file}.worker`].filter((candidate) => fs.existsSync(candidate));
}

function readEnvironmentEvidence(file) {
  return environmentEvidencePaths(file).flatMap((candidate) => fs.readFileSync(candidate, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)));
}

async function waitForBackgroundEnvironmentEvidence(file, expected) {
  await waitForFile(file, 15_000);
  const evidence = fs.readFileSync(file, "utf8");
  const lines = evidence.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${path.basename(file)} must contain one evidence record`);
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch (error) {
    assert.fail(`${path.basename(file)} contains malformed JSON: ${error.message}`);
  }
  assert.ok(record && typeof record === "object" && !Array.isArray(record), `${path.basename(file)} record is not an object`);
  assert.equal(record.schemaVersion, 1, `${path.basename(file)} has an unsupported schema`);
  assert.equal(record.mode, expected.mode, `${path.basename(file)} has the wrong mode`);
  assert.equal(record.role, expected.role, `${path.basename(file)} has the wrong role`);
  assert.ok(Array.isArray(record.names), `${path.basename(file)} is missing environment names`);
  assert.ok(record.names.every((name) => typeof name === "string"), `${path.basename(file)} has malformed environment names`);
  assert.equal(new Set(record.names).size, record.names.length, `${path.basename(file)} repeats an environment name`);
  assert.equal(
    record.names.some((name) => forbiddenEnvironmentNames.includes(name)),
    false,
    `${path.basename(file)} contains a forbidden environment name`,
  );
  assert.ok(record.values && typeof record.values === "object" && !Array.isArray(record.values), `${path.basename(file)} is missing environment hashes`);
  assert.deepEqual(
    Object.keys(record.values).sort(),
    [...record.names].sort(),
    `${path.basename(file)} names and hashes differ`,
  );
  for (const value of Object.values(record.values)) {
    assert.ok(Number.isInteger(value.length) && value.length >= 0, `${path.basename(file)} has a malformed value length`);
    assert.match(value.sha256 ?? "", /^[0-9a-f]{64}$/u, `${path.basename(file)} has a malformed value hash`);
  }
  assert.ok(Array.isArray(record.forbiddenNames), `${path.basename(file)} is missing forbidden-name evidence`);
  assert.ok(Array.isArray(record.sentinelValueHashes), `${path.basename(file)} is missing sentinel-hash evidence`);
  assert.ok(Array.isArray(record.sentinelValueNames), `${path.basename(file)} is missing sentinel-name evidence`);
  assert.ok(record.sentinelValueHashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash)), `${path.basename(file)} has a malformed sentinel hash`);
  assert.deepEqual(record.forbiddenNames, [], `${path.basename(file)} observed a forbidden environment name`);
  assert.deepEqual(record.sentinelValueHashes, [], `${path.basename(file)} observed a sentinel hash`);
  assert.deepEqual(record.sentinelValueNames, [], `${path.basename(file)} observed a sentinel name`);
  assert.equal(allSentinels.every((value) => !evidence.includes(value)), true, `${path.basename(file)} contains a raw sentinel`);
  return record;
}

function backgroundEnvironmentEvidenceIsClean(record) {
  return record.forbiddenNames.length === 0
    && record.sentinelValueHashes.length === 0
    && record.sentinelValueNames.length === 0;
}

function environmentEvidenceIsClean(file, roles) {
  const records = readEnvironmentEvidence(file);
  return roles.every((role) => records.some((record) => (
    record.role === role
    && Array.isArray(record.names)
    && record.names.every((name) => typeof name === "string")
    && record.values !== undefined
    && Object.keys(record.values).sort().join("\n") === [...record.names].sort().join("\n")
    && Object.values(record.values).every((value) => (
      Number.isInteger(value.length)
      && value.length >= 0
      && typeof value.sha256 === "string"
      && /^[0-9a-f]{64}$/u.test(value.sha256)
    ))
    && Array.isArray(record.forbiddenNames)
    && record.forbiddenNames.length === 0
    && Array.isArray(record.sentinelValueNames)
    && record.sentinelValueNames.length === 0
  ))) && environmentEvidencePaths(file).every((candidate) => scanValueFree(candidate));
}

function writeEnvironmentPreload(file, label, outputPath) {
  fs.writeFileSync(file, environmentTripwireSource(label, outputPath), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function readTree(rootPath) {
  const chunks = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (stat.isFile()) chunks.push(fs.readFileSync(file));
  }
  if (fs.existsSync(rootPath)) visit(rootPath);
  return Buffer.concat(chunks).toString("utf8");
}

function scanValueFree(rootPath, { allowPersonalAuth = false } = {}) {
  const violations = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (!stat.isFile()) return;
    const text = fs.readFileSync(file, "utf8");
    for (const value of allSentinels) {
      if (!text.includes(value)) continue;
      if (allowPersonalAuth && value === personalToken && path.resolve(file) === path.resolve(personalAuthPath)) continue;
      violations.push({ file, kind: value === personalToken ? "personal" : "provider" });
    }
  }
  if (fs.existsSync(rootPath)) visit(rootPath);
  return violations.length === 0;
}

function rememberProcess(pid) {
  if (Number.isInteger(pid) && pid > 0) cleanupState.processes.add(pid);
  return pid;
}

function rememberProcessGroup(pgid) {
  if (Number.isInteger(pgid) && pgid > 0) cleanupState.groups.add(pgid);
  return pgid;
}

function scrubEnvironment(policy) {
  const scrubbed = { ...policy.scrubEnvironment(Object.fromEntries(Object.entries(process.env))) };
  for (const name of policy.cavememEnvironmentAllowlist) {
    if (typeof process.env[name] === "string") scrubbed[name] = process.env[name];
  }
  scrubbed.CAVEMEM_DATA_DIR = dataDir;
  return scrubbed;
}

function installCapabilities(policy, runtimeSecrets) {
  const runtimeSymbol = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
  const environmentSymbol = Symbol.for("dwsr.pi-agent.cavemem-environment.v1");
  const exactValues = [...runtimeSecrets.exactRedactionValues];
  const runtime = {
    schemaVersion: 1,
    mode: "shopify-gateway",
    redactExact: Object.freeze((value) => {
      let result = value;
      for (const exact of exactValues.sort((left, right) => right.length - left.length)) {
        result = result.split(exact).join("[REDACTED]");
      }
      return result;
    }),
  };
  Object.defineProperty(runtime, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(() => {
      throw new Error("Pi runtime bootstrap is not serializable");
    }),
  });
  Object.freeze(runtime);
  Object.defineProperty(globalThis, runtimeSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: runtime,
  });

  const environment = scrubEnvironment(policy);
  const capabilityEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    Object.defineProperty(capabilityEnvironment, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  Object.freeze(capabilityEnvironment);
  const capability = { schemaVersion: 1, environment: capabilityEnvironment };
  Object.defineProperty(capability, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(() => {
      throw new Error("Cavemem process environment is not serializable");
    }),
  });
  Object.freeze(capability);
  Object.defineProperty(globalThis, environmentSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: capability,
  });
  return { runtime, environment: capabilityEnvironment };
}

function createProviderServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const markers = [
        ["provider-error", "error"],
        ["provider-timeout", "timeout"],
        ["provider-cancel", "cancellation"],
      ];
      const marker = markers
        .map(([value, mode]) => ({ mode, position: body.lastIndexOf(value) }))
        .sort((left, right) => right.position - left.position)[0];
      const mode = request.headers["x-task-7-5-mode"]
        ?? (marker.position >= 0 ? marker.mode : "normal");
      const kind = body.includes("root-provider-request")
        ? "root"
        : body.includes("foreground-child-provider-request")
          ? "foreground-child"
          : "other";
      const authorized = request.headers.authorization === `Bearer ${token}`
        && request.headers["pi-agent-session-id"] === launchId;
      requests.push({
        mode,
        kind,
        authorized,
        bodyHasSentinel: allSentinels.some((value) => body.includes(value)),
      });
      if (mode === "timeout" || mode === "cancellation") {
        setTimeout(() => response.end(), 2_000);
        return;
      }
      if (!authorized || mode === "error") {
        response.writeHead(mode === "error" ? 503 : 401, { "content-type": "text/plain" });
        response.end("provider fixture failure\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "task-7-5-provider-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "task-7-5-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "provider-ok" }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "task-7-5-provider-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "task-7-5-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return { requests, server };
}

function baseEnvironment(providerPort) {
  return {
    HOME: path.join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NO_COLOR: "1",
    PATH: `${path.join(cavememRoot, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    SHELL: process.env.SHELL ?? "/bin/sh",
    TMPDIR: tmpDir,
    USER: "pi-agent-credential-fixture",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    CAVEMEM_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_AGENT_LAUNCH_ID: launchId,
    SHOPIFY_PI_TOKEN: token,
    OPENAI_API_KEY: ambientSentinels[0],
    ANTHROPIC_API_KEY: ambientSentinels[1],
    MCPPROXY_API_KEY: ambientSentinels[2],
    PI_AGENT_BASH_TIMEOUT_MS: "250",
    PI_AGENT_LSP_EXECUTABLES: JSON.stringify({ typescript: path.join(lspRoot, "bin/typescript-language-server") }),
    TASK_7_5_PROVIDER_PORT: String(providerPort),
  };
}

function managedPiEnvironment(policy, sourceEnvironment, targetAgentDir, providerEnvironment) {
  const environment = {};
  for (const name of policy.rootPiEnvironmentAllowlist) {
    if (typeof sourceEnvironment[name] === "string") environment[name] = sourceEnvironment[name];
  }
  Object.assign(environment, providerEnvironment, {
    CAVEMEM_DATA_DIR: dataDir,
    PI_AGENT_BASH_TIMEOUT_MS: "250",
    PI_AGENT_LSP_EXECUTABLES: JSON.stringify({ typescript: path.join(lspRoot, "bin/typescript-language-server") }),
    PI_CODING_AGENT_DIR: targetAgentDir,
    TASK_7_5_PROVIDER_PORT: sourceEnvironment.TASK_7_5_PROVIDER_PORT,
  });
  return environment;
}

function installProcessEnvironment(policy, environment) {
  for (const name of new Set([...policy.sensitiveNames, ...Object.keys(baseEnvironment(0))])) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
}

function writePiState(providerPort, targetAgentDir, requestMode) {
  writePrivateJson(path.join(targetAgentDir, "models.json"), {
    providers: {
      openai: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "${SHOPIFY_PI_TOKEN}",
        authHeader: true,
        headers: {
          "pi-agent-session-id": "${PI_AGENT_LAUNCH_ID}",
          ...(requestMode === undefined ? {} : { "x-task-7-5-mode": requestMode }),
        },
        models: [{
          id: "task-7-5-model",
          name: "Task 7.5 provider fixture",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_192,
          maxTokens: 256,
        }],
      },
    },
  });
  writePrivateJson(path.join(targetAgentDir, "settings.json"), {
    shellPath: path.join(shellRoot, "bin/pi-agent-shell"),
  });
  writePrivateJson(path.join(targetAgentDir, "auth.json"), {});
}

function writePersonalPiState(targetAgentDir) {
  writePrivateJson(path.join(targetAgentDir, "models.json"), {});
  writePrivateJson(path.join(targetAgentDir, "settings.json"), {
    shellPath: path.join(shellRoot, "bin/pi-agent-shell"),
  });
  writePrivateJson(path.join(targetAgentDir, "auth.json"), {
    openai: { type: "api_key", key: personalToken },
  });
}

async function runPersonalProviderProbe(personalPolicy, sourceEnvironment) {
  const boundary = personalPolicy.createCredentialBoundary({
    resolverResults: {},
    launchId: null,
    environment: sourceEnvironment,
  });
  const rootEnvironment = managedPiEnvironment(
    personalPolicy,
    sourceEnvironment,
    personalAgentDir,
    boundary.runtime.rootPiEnvironment,
  );
  const childEnvironment = managedPiEnvironment(
    personalPolicy,
    sourceEnvironment,
    personalAgentDir,
    boundary.runtime.childPiEnvironment,
  );
  writePersonalPiState(personalAgentDir);
  const codingAgent = await import(`file://${piRoot}/lib/node_modules/@earendil-works/pi-coding-agent/index.js`);
  const modelRuntime = await codingAgent.ModelRuntime.create({
    authPath: path.join(personalAgentDir, "auth.json"),
    modelsPath: path.join(personalAgentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("openai", "gpt-5.6-sol");
  assert.ok(model);
  const auth = await modelRuntime.getAuth(model);
  const state = readTree(personalAgentDir);
  const personalBoundarySurface = [
    boundary.runtime.mode,
    ...boundary.resolvers.map(({ kind }) => kind),
    ...Object.keys(boundary.runtime.rootPiEnvironment),
    ...Object.keys(boundary.runtime.childPiEnvironment),
  ].join("\n");
  return {
    mode: boundary.runtime.mode,
    rootCredentialNames: Object.keys(boundary.runtime.rootPiEnvironment),
    foregroundChildCredentialNames: Object.keys(boundary.runtime.childPiEnvironment),
    authSource: auth?.source,
    authIsolated: auth?.auth?.apiKey === personalToken
      && auth.auth.apiKey !== token
      && !JSON.stringify(rootEnvironment).includes(token)
      && !JSON.stringify(childEnvironment).includes(token),
    noShopifyCredentialInheritance: !state.includes(token)
      && !state.includes("SHOPIFY_PI_TOKEN")
      && !personalBoundarySurface.includes(token),
  };
}

function runPi(environment, targetAgentDir, prompt, options = {}) {
  const {
    timeout = 60_000,
    cancelAfter,
  } = options;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      path.join(piRoot, "bin/pi"),
      [
        "--print",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--model",
        "openai/task-7-5-model",
        prompt,
      ],
      {
        cwd: workspace,
        env: { ...environment, PI_CODING_AGENT_DIR: targetAgentDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    rememberProcess(child.pid);
    let stdout = "";
    let stderr = "";
    let outcome = "completed";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeoutTimer = setTimeout(() => {
      if (outcome !== "completed") return;
      outcome = "timeout";
      child.kill("SIGTERM");
    }, timeout);
    let cancellationForceTimer;
    const cancellationTimer = cancelAfter === undefined
      ? undefined
      : setTimeout(() => {
        outcome = "cancellation";
        child.kill("SIGINT");
        cancellationForceTimer = setTimeout(() => child.kill("SIGTERM"), 1_000);
      }, cancelAfter);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeoutTimer);
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
      if (cancellationForceTimer !== undefined) clearTimeout(cancellationForceTimer);
      const result = {
        status,
        signal,
        stdout,
        stderr,
        outcome,
        error: outcome === "timeout"
          ? { code: "ETIMEDOUT" }
          : outcome === "cancellation"
            ? { code: "ECANCELLED" }
            : undefined,
      };
      fs.appendFileSync(probeLog, `${JSON.stringify({ prompt, outcome, status, signal })}\n`);
      resolve(result);
    });
  });
}

function waitForFile(file, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path.basename(file)}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function waitForProcessGone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processGone(pid);
}

async function waitForProcessGroupGone(pgid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(pgid);
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function terminateProcessGroup(pgid, timeoutMs = 2_000) {
  if (!Number.isInteger(pgid) || pgid <= 0) return true;
  signalProcessGroup(pgid, "SIGTERM");
  if (await waitForProcessGroupGone(pgid, timeoutMs)) return true;
  signalProcessGroup(pgid, "SIGKILL");
  return waitForProcessGroupGone(pgid, timeoutMs);
}

async function terminateProcess(pid, timeoutMs = 2_000) {
  if (!Number.isInteger(pid) || pid <= 0 || processGone(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return true;
  }
  if (await waitForProcessGone(pid, timeoutMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return true;
  }
  return waitForProcessGone(pid, timeoutMs);
}

async function closeTrackedServers() {
  for (const server of cleanupState.servers) {
    if (!server.listening) continue;
    await new Promise((resolve) => server.close(resolve));
  }
}

function discoverOwnedProcesses() {
  const workerFile = path.join(dataDir, "worker.pid");
  if (fs.existsSync(workerFile)) {
    try {
      rememberProcessGroup(JSON.parse(fs.readFileSync(workerFile, "utf8")).pid);
    } catch {
      // The worker may be between atomic receipt updates; the root teardown remains bounded.
    }
  }
  for (const observationFile of [path.join(workspace, ".task-4-9-server-observation.json")]) {
    if (!fs.existsSync(observationFile)) continue;
    try {
      const observation = JSON.parse(fs.readFileSync(observationFile, "utf8"));
      rememberProcess(observation.pid);
      rememberProcessGroup(observation.pid);
      rememberProcess(observation.descendantPid);
    } catch {
      // A partial observation cannot identify an owned process safely.
    }
  }
}

async function cleanupOwnedResources() {
  discoverOwnedProcesses();
  await closeTrackedServers();
  const groupResults = await Promise.all(
    [...cleanupState.groups].map((pgid) => terminateProcessGroup(pgid)),
  );
  const processResults = await Promise.all(
    [...cleanupState.processes].map((pid) => terminateProcess(pid)),
  );
  const groupGone = [...cleanupState.groups].every((pgid) => !processGroupExists(pgid));
  const processesGone = [...cleanupState.processes].every((pid) => processGone(pid));
  return {
    failureSafe: groupResults.every(Boolean) && processResults.every(Boolean),
    processes: groupGone && processesGone,
  };
}

function verifyOwnedResourcesGone() {
  discoverOwnedProcesses();
  return {
    processes: [...cleanupState.groups].every((pgid) => !processGroupExists(pgid))
      && [...cleanupState.processes].every((pid) => processGone(pid)),
  };
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function spawnScrubbed(command, args, environment, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: workspace,
    env: environment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function cavememSettings(workerPort) {
  return {
    dataDir,
    workerPort,
    logLevel: "error",
    compression: { intensity: "full", expandForModel: true },
    embedding: {
      provider: "none",
      model: "task-7-5-none",
      batchSize: 16,
      autoStart: false,
      idleShutdownMs: 60_000,
    },
    search: { alpha: 0.5, defaultLimit: 20 },
    privacy: { excludePatterns: [], redactSecrets: true },
    ides: {},
  };
}

function readCavememRows() {
  const database = path.join(dataDir, "data.db");
  if (!fs.existsSync(database)) return [];
  const result = childProcess.spawnSync(
    path.join(sqliteRoot, "bin/sqlite3"),
    [
      "-json",
      database,
      "SELECT session_id, kind, content, metadata FROM observations ORDER BY id",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

async function runCavememProbe(policy, workerPort) {
  writePrivateJson(path.join(dataDir, "settings.json"), cavememSettings(workerPort));
  const bridgePath = path.join(extensionRoot, "lib/pi-agent/extensions/cavemem/index.ts");
  const { createCavememBridge } = await import(`file://${bridgePath}`);
  const handlers = new Map();
  createCavememBridge({
    command: path.join(cavememRoot, "bin/cavemem"),
    killGraceMs: 250,
    noProgressMs: 10_000,
  })({ on(event, handler) { handlers.set(event, handler); } });
  const notifications = [];
  const context = {
    cwd: workspace,
    sessionManager: {
      getHeader() { return null; },
      getSessionFile() { return path.join(agentDir, "task-7-5-session.jsonl"); },
      getSessionId() { return "task-7-5-session"; },
    },
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  };
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
  const successInput = {
    command: `printf ${token}`,
    headers: { authorization: `Bearer ${token}` },
    launchId,
  };
  const failureInput = {
    command: `printf ${launchId}`,
    credentials: { token },
  };
  const successId = "task-7-5-capture-success";
  const failureId = "task-7-5-capture-failure";
  await handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: successId,
    toolName: "task-7-5-successful-tool",
    args: successInput,
  }, context);
  await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: successId,
    toolName: "task-7-5-successful-tool",
    input: successInput,
  }, context);
  await handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: successId,
    toolName: "task-7-5-successful-tool",
    input: successInput,
    content: [{ type: "text", text: `success output ${token}` }],
    details: { launchId },
    isError: false,
  }, context);
  await handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: failureId,
    toolName: "task-7-5-failing-tool",
    args: failureInput,
  }, context);
  await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: failureId,
    toolName: "task-7-5-failing-tool",
    input: failureInput,
  }, context);
  await handlers.get("tool_execution_end")({
    type: "tool_execution_end",
    toolCallId: failureId,
    toolName: "task-7-5-failing-tool",
    result: {
      content: [{ type: "text", text: `failed output ${launchId}` }],
      details: { authorization: `Bearer ${token}` },
    },
    isError: true,
  }, context);
  const workerFile = path.join(dataDir, "worker.pid");
  let workerStarted = await waitForFile(workerFile, 15_000).then(() => true, () => false);
  let workerStartOutput = "";
  let workerStopOutput = "";
  let workerStopStatus = null;
  if (!workerStarted) {
    const workerEnvironment = {
      ...policy.scrubEnvironment(Object.fromEntries(Object.entries(process.env))),
      CAVEMEM_DATA_DIR: dataDir,
    };
    const workerStart = spawnScrubbed(
      path.join(cavememRoot, "bin/cavemem"),
      ["worker", "start"],
      workerEnvironment,
      { timeout: 15_000 },
    );
    workerStartOutput = `${workerStart.stdout ?? ""}\n${workerStart.stderr ?? ""}`;
    workerStarted = await waitForFile(workerFile, 15_000).then(() => true, () => false);
  }
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  const workerPid = fs.existsSync(workerFile)
    ? JSON.parse(fs.readFileSync(workerFile, "utf8")).pid
    : null;
  rememberProcessGroup(workerPid);
  if (fs.existsSync(workerFile)) {
    const workerEnvironment = {
      ...policy.scrubEnvironment(Object.fromEntries(Object.entries(process.env))),
      CAVEMEM_DATA_DIR: dataDir,
    };
    const workerStop = spawnScrubbed(
      path.join(cavememRoot, "bin/cavemem"),
      ["worker", "stop"],
      workerEnvironment,
      { timeout: 15_000 },
    );
    workerStopOutput = `${workerStop.stdout ?? ""}\n${workerStop.stderr ?? ""}`;
    workerStopStatus = workerStop.status;
  }
  const workerGone = workerPid === null
    ? !fs.existsSync(workerFile)
    : await waitForProcessGone(workerPid) && !fs.existsSync(workerFile);
  const rows = readCavememRows();
  const rowText = JSON.stringify(rows);
  return {
    workerStarted,
    workerGone,
    normalShutdownVerified: workerStarted && workerStopStatus === 0 && workerGone,
    notifications,
    workerStartOutput,
    workerStopOutput,
    capture: {
      success: rows.some((row) => row.content.includes(successId)),
      failure: rows.some((row) => row.content.includes(failureId)),
      rowsSentinelFree: allSentinels.every((value) => !rowText.includes(value)),
    },
    valueFree: scanValueFree(dataDir),
  };
}

async function runCavememEnvironmentProbe() {
  const command = writeExecutable(
    path.join(root, "cavemem-environment-tripwire.mjs"),
    environmentTripwireSource("cavemem", cavememEnvironmentEvidence, { spawnWorker: true }),
  );
  const bridgePath = path.join(extensionRoot, "lib/pi-agent/extensions/cavemem/index.ts");
  const { createCavememBridge } = await import(`file://${bridgePath}`);
  const handlers = new Map();
  createCavememBridge({
    command,
    killGraceMs: 250,
    noProgressMs: 10_000,
  })({ on(event, handler) { handlers.set(event, handler); } });
  const context = {
    cwd: workspace,
    sessionManager: {
      getHeader() { return null; },
      getSessionFile() { return path.join(personalAgentDir, "task-7-5-environment-session.jsonl"); },
      getSessionId() { return "task-7-5-environment-session"; },
    },
    ui: { notify() {} },
  };
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
  await handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: "task-7-5-environment-tripwire",
    toolName: "task-7-5-environment-tripwire",
    input: { value: "value-free" },
    content: [{ type: "text", text: "value-free" }],
    details: {},
    isError: false,
  }, context);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  const records = readEnvironmentEvidence(cavememEnvironmentEvidence);
  return {
    hook: environmentEvidenceIsClean(cavememEnvironmentEvidence, ["hook"]),
    worker: environmentEvidenceIsClean(cavememEnvironmentEvidence, ["worker"]),
    records,
  };
}

function createUi() {
  const notifications = [];
  const context = {
    async select() { return undefined; },
    async confirm() { return false; },
    async input() { return undefined; },
    async editor() { return undefined; },
    async custom() { return undefined; },
    notify(message, type) { notifications.push({ message, type }); },
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
  };
  return { context, notifications };
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

async function runIntegratedSession() {
  const codingAgent = await import(`file://${piRoot}/lib/node_modules/@earendil-works/pi-coding-agent/index.js`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPaths = ["cavemem", "codeIntelligence", "backgroundTasks", "subagents"].map(
    (name) => path.join(extensionRoot, manifest.extensions[name].entryPath),
  );
  let created;
  let ui;
  let extensionErrors = [];
  let pipePid;
  let ptyPid;
  let childResult;
  let bash;
  let pipeStart;
  let pipeEvidence;
  let pipeWait;
  let pipeLogs;
  let ptyStart;
  let ptyEvidence;
  let ptyWait;
  let ptyLogs;
  let codeHealth;
  let lspStarted = false;
  let shutdown = { outcome: "not-attempted" };
  try {
    const settingsManager = codingAgent.SettingsManager.create(workspace, agentDir, { projectTrusted: true });
    const resourceLoader = new codingAgent.DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await codingAgent.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel("openai", "task-7-5-model");
    assert.ok(model);
    const sessionManager = codingAgent.SessionManager.create(workspace, sessionsDir, { id: "task-7-5-integrated" });
    created = await codingAgent.createAgentSession({
      cwd: workspace,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    ui = createUi();
    extensionErrors = [];
    await created.session.bindExtensions({
      uiContext: ui.context,
      mode: "tui",
      onError(error) { extensionErrors.push(error); },
    });
    await created.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    const execute = async (name, args) => {
      const definition = created.session.getToolDefinition(name);
      assert.ok(definition, `${name} was not registered`);
      return definition.execute(
        `task-7-5-${name}`,
        args,
        new AbortController().signal,
        undefined,
        created.session.extensionRunner.createContext(),
      );
    };
    const savedArgv1 = process.argv[1];
    process.argv[1] = path.join(piRoot, "bin/pi");
    try {
      childResult = await execute("subagent", {
        agent: "worker",
        task: "foreground-child-provider-request",
        agentContract: { version: 1 },
      });
    } finally {
      process.argv[1] = savedArgv1;
    }
    assert.match(resultText(childResult), /provider-ok/);
    bash = await execute("bash", { command: "env" });
    pipeStart = await execute("bg_start", { name: "task-7-5-pipe", command: backgroundPipePath });
    pipePid = rememberProcessGroup(pipeStart.details?.pid);
    assert.ok(Number.isInteger(pipePid), "background pipe did not expose a process group");
    pipeEvidence = await waitForBackgroundEnvironmentEvidence(backgroundPipeEvidencePath, {
      mode: "pipe",
      role: "background-pipe",
    });
    pipeLogs = await execute("bg_logs", { id: pipeStart.details?.id, stream: "stdout", tail: 50 });
    ptyStart = await execute("bg_start", { name: "task-7-5-pty", command: backgroundPtyPath, pty: true });
    ptyPid = rememberProcessGroup(ptyStart.details?.pid);
    assert.ok(Number.isInteger(ptyPid), "background PTY did not expose a process group");
    ptyEvidence = await waitForBackgroundEnvironmentEvidence(backgroundPtyEvidencePath, {
      mode: "pty",
      role: "background-pty",
    });
    ptyLogs = await execute("bg_logs", { id: ptyStart.details?.id, stream: "terminal", tail: 50 });
    codeHealth = await execute("code_health", { scope: "source.ts", include: ["servers"] });
    const lspObservationPath = path.join(workspace, ".task-4-9-server-observation.json");
    lspStarted = await waitForFile(lspObservationPath, 15_000).then(() => true, () => false);
    try {
      await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      shutdown = { outcome: "completed" };
    } catch (error) {
      shutdown = {
        outcome: "failed",
        error: String(error?.message ?? error),
      };
      throw error;
    }
  } finally {
    if (created) {
      try {
        created.session.dispose();
      } catch {
        // Cleanup is best-effort here; owned process probes below remain authoritative.
      }
    }
  }
  const lspObservationPath = path.join(workspace, ".task-4-9-server-observation.json");
  const lspObservation = fs.existsSync(lspObservationPath)
    ? JSON.parse(fs.readFileSync(lspObservationPath, "utf8"))
    : null;
  const lspGroupGone = lspObservation === null
    ? true
    : await waitForProcessGroupGone(rememberProcessGroup(lspObservation.pid));
  const lspLeaderGone = lspObservation?.pid === undefined
    ? true
    : await waitForProcessGone(rememberProcess(lspObservation.pid));
  const lspDescendantGone = lspObservation?.descendantPid === undefined
    ? true
    : await waitForProcessGone(rememberProcess(lspObservation.descendantPid));
  const backgroundGroupsGone = await Promise.all(
    [pipePid, ptyPid]
      .filter((pid) => Number.isInteger(pid))
      .map((pid) => waitForProcessGroupGone(pid)),
  );
  return {
    bash: resultText(bash),
    pipe: `${resultText(pipeStart)}\n${resultText(pipeWait)}\n${resultText(pipeLogs)}`,
    pipeEvidence,
    pty: `${resultText(ptyStart)}\n${resultText(ptyWait)}\n${resultText(ptyLogs)}`,
    ptyEvidence,
    codeHealth: resultText(codeHealth),
    childProvider: resultText(childResult),
    pipePid,
    ptyPid,
    lspStarted,
    lspValueFree: lspObservation === null ? true : scanValueFree(lspObservationPath),
    lspGone: lspLeaderGone,
    lspGroupGone: lspGroupGone && lspLeaderGone,
    lspDescendantGone,
    backgroundGroupsGone: backgroundGroupsGone.every(Boolean),
    normalShutdownVerified: shutdown.outcome === "completed"
      && lspGroupGone
      && lspLeaderGone
      && lspDescendantGone
      && backgroundGroupsGone.every(Boolean),
    shutdown,
    extensionErrors: extensionErrors.map((error) => String(error?.message ?? error)),
    notifications: ui?.notifications ?? [],
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function reservePort() {
  const server = net.createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  fs.writeFileSync(probeLog, "", { mode: 0o600 });
  const policy = await import(`file://${credentialPolicyRoot}/lib/pi-agent/credential-policy.mjs`);
  const personalPolicy = await import(`file://${personalCredentialPolicyRoot}/lib/pi-agent/credential-policy.mjs`);
  const { server, requests } = createProviderServer();
  cleanupState.servers.add(server);
  const providerPort = await listen(server);
  const sourceEnvironment = baseEnvironment(providerPort);
  for (const name of [
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]) {
    fs.mkdirSync(sourceEnvironment[name], { recursive: true, mode: 0o700 });
  }
  installProcessEnvironment(policy, sourceEnvironment);
  const personalProvider = await runPersonalProviderProbe(personalPolicy, sourceEnvironment);
  const boundary = policy.createCredentialBoundary({
    resolverResults: {
      "shopify-gateway-base": `http://127.0.0.1:${providerPort}/v1`,
      "shopify-gateway-token": token,
    },
    launchId,
    environment: sourceEnvironment,
  });
  const rootEnvironment = managedPiEnvironment(
    policy,
    sourceEnvironment,
    agentDir,
    boundary.runtime.rootPiEnvironment,
  );
  const childEnvironment = managedPiEnvironment(
    policy,
    sourceEnvironment,
    childAgentDir,
    boundary.runtime.childPiEnvironment,
  );
  installCapabilities(policy, boundary.runtime);
  installProcessEnvironment(policy, rootEnvironment);
  writePiState(providerPort, agentDir);
  writePiState(providerPort, childAgentDir);

  const normalRoot = await runPi(rootEnvironment, agentDir, "root-provider-request");
  const normalChild = await runPi(childEnvironment, childAgentDir, "foreground-child-provider-request");
  assert.equal(
    normalRoot.status,
    0,
    JSON.stringify({ status: normalRoot.status, signal: normalRoot.signal, error: normalRoot.error, stdout: normalRoot.stdout, stderr: normalRoot.stderr, requests }),
  );
  assert.equal(normalChild.status, 0, `${normalChild.stdout}\n${normalChild.stderr}`);
  assert.match(normalRoot.stdout, /provider-ok/);
  assert.match(normalChild.stdout, /provider-ok/);

  writePiState(providerPort, errorAgentDir, "error");
  writePiState(providerPort, timeoutAgentDir, "timeout");
  writePiState(providerPort, cancellationAgentDir, "cancellation");
  const errorResult = await runPi(rootEnvironment, errorAgentDir, "provider-error");
  assert.notEqual(errorResult.status, 0);
  assert.doesNotMatch(`${errorResult.stdout}\n${errorResult.stderr}`, new RegExp(allSentinels.join("|")));

  const timeoutResult = await runPi(rootEnvironment, timeoutAgentDir, "provider-timeout", { timeout: 5_000 });
  assert.equal(timeoutResult.error?.code, "ETIMEDOUT");

  const cancellationResult = await runPi(
    childEnvironment,
    cancellationAgentDir,
    "provider-cancel",
    { timeout: 5_000, cancelAfter: 1_500 },
  );
  assert.equal(cancellationResult.error?.code, "ECANCELLED");

  writeExecutable(
    backgroundPipePath,
    backgroundEnvironmentEvidenceSource("pipe", "background-pipe", backgroundPipeEvidencePath),
  );
  writeExecutable(
    backgroundPtyPath,
    backgroundEnvironmentEvidenceSource("pty", "background-pty", backgroundPtyEvidencePath),
  );
  const integrated = await runIntegratedSession();
  await new Promise((resolve) => server.close(resolve));
  const cavememPort = await reservePort();
  const scrubbedEnvironment = { ...policy.scrubEnvironment(Object.fromEntries(Object.entries(sourceEnvironment))) };
  const lsp = {
    gone: integrated.lspGone,
    groupGone: integrated.lspGroupGone,
    descendantGone: integrated.lspDescendantGone,
    valueFree: integrated.lspValueFree,
  };
  const shellResult = spawnScrubbed(
    path.join(shellRoot, "bin/pi-agent-shell"),
    ["-c", "env"],
    sourceEnvironment,
  );
  const cavemem = await runCavememProbe(policy, cavememPort);
  const cavememEnvironment = await runCavememEnvironmentProbe();
  const statusPreload = writeEnvironmentPreload(
    path.join(root, "status-environment-tripwire.mjs"),
    "status",
    statusEnvironmentEvidence,
  );
  const validatorPreload = writeEnvironmentPreload(
    path.join(root, "validator-environment-tripwire.mjs"),
    "validator",
    validatorEnvironmentEvidence,
  );
  const statusEnvironment = {
    ...scrubbedEnvironment,
    NODE_OPTIONS: `--import=${pathToFileURL(statusPreload).href}`,
  };
  const validatorEnvironment = {
    ...scrubbedEnvironment,
    NODE_OPTIONS: `--import=${pathToFileURL(validatorPreload).href}`,
  };
  const statusResult = spawnScrubbed(
    path.join(statusRoot, "bin/pi-agent-status"),
    ["--json"],
    statusEnvironment,
    { input: `${JSON.stringify({ schemaVersion: 1, agentDir, cavememDataDir: dataDir })}\n`, },
  );
  const validatorResult = spawnScrubbed(
    path.join(validatorRoot, "bin/pi-agent-validate"),
    ["--check"],
    validatorEnvironment,
    { input: `${JSON.stringify({ schemaVersion: 1, agentDir, cavememDataDir: dataDir })}\n`, },
  );
  const nonoResult = spawnScrubbed(
    path.join(nonoRoot, "bin/nono"),
    [
      "run",
      "--silent",
      "--no-rollback",
      "--log-file",
      auditLog,
      "--profile",
      profilePath,
      "--allow-cwd",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(process.env))",
    ],
    rootEnvironment,
  );
  fs.writeFileSync(shellOutput, shellResult.stdout, { mode: 0o600 });
  const nonProviderOutputs = [
    shellResult.stdout,
    shellResult.stderr,
    JSON.stringify(lsp),
    JSON.stringify(cavemem),
    statusResult.stdout,
    statusResult.stderr,
    validatorResult.stdout,
    validatorResult.stderr,
    nonoResult.stdout,
    nonoResult.stderr,
    JSON.stringify(integrated),
    errorResult.stdout,
    errorResult.stderr,
    timeoutResult.stdout,
    timeoutResult.stderr,
    cancellationResult.stdout,
    cancellationResult.stderr,
  ].join("\n");
  const nonProviderFree = allSentinels.every((value) => !nonProviderOutputs.includes(value));
  const scanFree = scanValueFree(root, { allowPersonalAuth: true });
  const sessionFilesFree = scanValueFree(sessionsDir);
  const backgroundProcessesGone = await Promise.all(
    [integrated.pipePid, integrated.ptyPid]
      .filter((pid) => Number.isInteger(pid))
      .map((pid) => waitForProcessGone(pid)),
  );
  const normalCleanup = verifyOwnedResourcesGone();
  const statusEnvironmentClean = environmentEvidenceIsClean(statusEnvironmentEvidence, ["hook"]);
  const validatorEnvironmentClean = environmentEvidenceIsClean(validatorEnvironmentEvidence, ["hook"]);
  const personalAuthText = fs.existsSync(personalAuthPath)
    ? fs.readFileSync(personalAuthPath, "utf8")
    : "";
  const personalAuthOnly = personalAuthText.includes(personalToken)
    && providerSentinels.every((value) => !personalAuthText.includes(value))
    && scanValueFree(personalAgentDir, { allowPersonalAuth: true });
  const nonPersonalArtifactsFree = [
    tmpDir,
    sessionsDir,
    dataDir,
    agentDir,
    childAgentDir,
    errorAgentDir,
    timeoutAgentDir,
    cancellationAgentDir,
  ].every((directory) => scanValueFree(directory));
  const paths = {
    normal: normalRoot.status === 0
      && normalChild.status === 0
      && normalRoot.outcome === "completed"
      && normalChild.outcome === "completed"
      ? "completed"
      : "failed",
    error: errorResult.status !== 0
      && errorResult.outcome === "completed"
      && !new RegExp(allSentinels.join("|"), "u").test(`${errorResult.stdout}\n${errorResult.stderr}`)
      ? "rejected-without-sentinel"
      : "failed",
    timeout: timeoutResult.outcome === "timeout"
      && timeoutResult.status !== 0
      && timeoutResult.error?.code === "ETIMEDOUT"
      ? "timed-out"
      : "failed",
    cancellation: cancellationResult.outcome === "cancellation"
      && cancellationResult.signal === "SIGINT"
      && cancellationResult.error?.code === "ECANCELLED"
      ? "cancelled"
      : "failed",
    shutdown: integrated.normalShutdownVerified && cavemem.normalShutdownVerified
      ? "completed"
      : "failed",
  };
  const report = {
    provider: {
      root: requests.some(({ kind, mode, authorized, bodyHasSentinel }) => kind === "root" && mode === "normal" && authorized && !bodyHasSentinel) ? "succeeded" : "failed",
      foregroundChild: requests.some(({ kind, mode, authorized, bodyHasSentinel }) => kind === "foreground-child" && mode === "normal" && authorized && !bodyHasSentinel) ? "succeeded" : "failed",
      requestModes: [...new Set(requests.map(({ mode }) => mode))].sort(),
      requestBodiesSentinelFree: requests.every(({ bodyHasSentinel }) => !bodyHasSentinel),
    },
    nonProviderProbes: {
      bash: nonProviderFree && !integrated.bash.includes(token) ? "sentinel-free" : "leaked",
      backgroundPipe: backgroundEnvironmentEvidenceIsClean(integrated.pipeEvidence) ? "sentinel-free" : "leaked",
      backgroundPty: backgroundEnvironmentEvidenceIsClean(integrated.ptyEvidence) ? "sentinel-free" : "leaked",
      lsp: nonProviderFree && lsp.valueFree ? "sentinel-free" : "leaked",
      cavememHook: nonProviderFree && cavemem.valueFree && cavememEnvironment.hook ? "sentinel-free" : "leaked",
      cavememWorker: nonProviderFree && cavemem.workerGone && cavememEnvironment.worker ? "sentinel-free" : "leaked",
      status: nonProviderFree && statusEnvironmentClean ? "sentinel-free" : "leaked",
      validator: nonProviderFree && validatorEnvironmentClean ? "sentinel-free" : "leaked",
    },
    paths,
    personalProvider,
    cavememCapture: {
      success: cavemem.capture.success && cavemem.capture.rowsSentinelFree ? "redacted" : "leaked",
      failure: cavemem.capture.failure && cavemem.capture.rowsSentinelFree ? "redacted" : "leaked",
      persistedRows: cavemem.capture.rowsSentinelFree && cavemem.valueFree ? "sentinel-free" : "leaked",
      hookEnvironment: cavememEnvironment.hook ? "sentinel-free" : "leaked",
      workerEnvironment: cavememEnvironment.worker ? "sentinel-free" : "leaked",
    },
    scan: {
      failed: !nonProviderFree
        || !scanFree
        || !personalAuthOnly
        || !nonPersonalArtifactsFree
        || !statusEnvironmentClean
        || !validatorEnvironmentClean
        || integrated.extensionErrors.some((error) => allSentinels.some((value) => error.includes(value))),
      logs: [
        probeLog,
        shellOutput,
        auditLog,
        path.join(workspace, ".task-4-9-lsp-lifecycle.jsonl"),
      ].filter((file) => fs.existsSync(file)).every(scanValueFree),
      temporaryFiles: scanValueFree(tmpDir),
      piSessions: scanValueFree(agentDir) && sessionFilesFree,
      cavememRows: scanValueFree(dataDir),
      nonoAudit: fs.existsSync(auditLog) && scanValueFree(auditLog),
      personalAuthOnly,
      nonPersonalArtifacts: nonPersonalArtifactsFree,
    },
    cleanup: {
      processes: lsp.gone
        && lsp.groupGone
        && lsp.descendantGone
        && integrated.lspGroupGone
        && integrated.lspDescendantGone
        && integrated.backgroundGroupsGone
        && cavemem.workerGone
        && backgroundProcessesGone.every(Boolean)
        && normalCleanup.processes
        && integrated.normalShutdownVerified
        && cavemem.normalShutdownVerified,
      failureSafe: normalCleanup.processes,
      temporaryRoots: scanFree,
    },
    probes: {
      lspValueFree: lsp.valueFree,
      lspGone: lsp.gone,
      lspGroupGone: lsp.groupGone,
      lspDescendantGone: integrated.lspDescendantGone && lsp.descendantGone && lsp.groupGone,
      cavememWorkerStarted: cavemem.workerStarted,
      cavememHookEnvironmentTripwire: cavememEnvironment.hook,
      cavememWorkerEnvironmentTripwire: cavememEnvironment.worker,
      statusEnvironmentTripwire: statusEnvironmentClean,
      validatorEnvironmentTripwire: validatorEnvironmentClean,
      backgroundPipeEvidence: backgroundEnvironmentEvidenceIsClean(integrated.pipeEvidence),
      backgroundPtyEvidence: backgroundEnvironmentEvidenceIsClean(integrated.ptyEvidence),
      lspHealth: integrated.codeHealth,
      integratedLspStarted: integrated.lspStarted,
      integratedErrorsValueFree: integrated.extensionErrors.every(
        (error) => !allSentinels.some((value) => error.includes(value)),
      ),
      shutdownCompleted: integrated.normalShutdownVerified && cavemem.normalShutdownVerified,
      normalCleanupVerified: normalCleanup.processes,
    },
  };
  report.scan.report = allSentinels.every((value) => !JSON.stringify(report).includes(value));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

let primaryError;
try {
  await main();
} catch (error) {
  primaryError = error;
}

let finalCleanup;
let cleanupError;
try {
  finalCleanup = await cleanupOwnedResources();
  fs.rmSync(root, { recursive: true, force: true });
} catch (error) {
  cleanupError = error;
}
const rootGone = !fs.existsSync(root);
if (primaryError) {
  if (cleanupError || !finalCleanup?.processes || !rootGone) {
    primaryError.message = `${primaryError.message}; task-7-5 cleanup failed`;
  }
  throw primaryError;
}
if (cleanupError || !finalCleanup?.processes || !rootGone) {
  throw new Error("task-7-5 owned process or temporary-root cleanup failed");
}
