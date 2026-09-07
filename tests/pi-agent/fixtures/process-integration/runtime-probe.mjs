import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [piRoot, extensionRoot, lspExecutable, childAgent, evidencePath, mode] = process.argv.slice(2);
if (!piRoot || !extensionRoot || !lspExecutable || !childAgent || !evidencePath) {
  throw new Error("usage: runtime-probe PI_ROOT EXTENSION_ROOT LSP_EXECUTABLE CHILD_AGENT EVIDENCE_PATH [MODE]");
}

const root = path.dirname(evidencePath);
const workspace = root;
const cleanupStatePath = process.env.PI_CODING_AGENT_DIR
  ? path.join(process.env.PI_CODING_AGENT_DIR, "process-integration-cleanup.json")
  : undefined;
if (!cleanupStatePath) throw new Error("PI_CODING_AGENT_DIR is required for process integration cleanup registration");
const registrations = [];
const registeredGroups = new Set();
const registeredProcesses = new Set();
const activeSessions = [];
const operations = [];
const SESSION_CLEANUP_TIMEOUT_MS = 10_000;
const FINALIZER_PROBE_TIMEOUT_MS = 2_500;
let report;
let failure;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForStableAbsence(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (predicate()) stableSamples = 0;
    else if (++stableSamples >= 3) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach stable absence`);
}

function persistCleanupState(extra = {}) {
  if (!cleanupStatePath) return;
  let state = {};
  try {
    state = readJson(cleanupStatePath);
  } catch {
    state = {};
  }
  const next = {
    ...state,
    ...extra,
    probePid: process.pid,
    groups: [...registeredGroups],
    processes: [...registeredProcesses],
    registrations: registrations.map((registration) => ({ ...registration })),
  };
  const temporaryPath = `${cleanupStatePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`);
  fs.renameSync(temporaryPath, cleanupStatePath);
  const persisted = readJson(cleanupStatePath);
  assert.equal(persisted.probePid, process.pid, "process cleanup registration was not persisted by the managed runtime");
  assert.deepEqual(persisted.groups, next.groups, "persisted process groups differ from the managed registration");
  assert.deepEqual(persisted.processes, next.processes, "persisted process PIDs differ from the managed registration");
  return persisted;
}

function register(record) {
  registrations.push(record);
  registeredGroups.add(record.pgid);
  registeredProcesses.add(record.leaderPid);
  registeredProcesses.add(record.descendantPid);
  for (const pid of record.extraPids ?? []) registeredProcesses.add(pid);
  const persisted = persistCleanupState({ phase: "running" });
  assert.equal(
    persisted.registrations.some((entry) => (
      entry.kind === record.kind
      && entry.pgid === record.pgid
      && entry.leaderPid === record.leaderPid
      && entry.descendantPid === record.descendantPid
    )),
    true,
    `managed registration for ${record.kind} was not persisted under nono`,
  );
  return record;
}

function recordOperation(name) {
  if (!operations.includes(name)) operations.push(name);
}

async function waitForFile(file, label = path.basename(file)) {
  await waitFor(() => fs.existsSync(file), label);
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createUi() {
  return {
    async select() { return undefined; },
    async confirm() { return false; },
    async input() { return undefined; },
    async editor() { return undefined; },
    async custom() { return undefined; },
    notify() {},
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
    theme: { fg: (_color, text) => text, bold: (text) => text, inverse: (text) => text },
  };
}

function resultText(result) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

function recordFromReady(kind, modeValue, pgid, readyPath, extraPids = []) {
  const ready = readJson(readyPath);
  return register({
    kind,
    mode: modeValue,
    pgid,
    leaderPid: ready.leaderPid,
    descendantPid: ready.descendantPid,
    extraPids,
  });
}

async function cleanupRecord(record, production = {}) {
  const before = {
    groupAlive: processGroupExists(record.pgid),
    leaderAlive: processExists(record.leaderPid),
    descendantAlive: processExists(record.descendantPid),
  };
  const groupGone = await waitForStableAbsence(() => processGroupExists(record.pgid), `${record.kind} group ${record.pgid}`);
  const leaderGone = await waitForStableAbsence(() => processExists(record.leaderPid), `${record.kind} leader ${record.leaderPid}`);
  const descendantGone = await waitForStableAbsence(() => processExists(record.descendantPid), `${record.kind} descendant ${record.descendantPid}`);
  const extraPidsGone = await Promise.all(
    (record.extraPids ?? []).map((pid) => waitForStableAbsence(() => processExists(pid), `${record.kind} PID ${pid}`)),
  );
  const survivors = [
    ["group", processGroupExists(record.pgid)],
    ["leader", processExists(record.leaderPid)],
    ["descendant", processExists(record.descendantPid)],
    ...(record.extraPids ?? []).map((pid) => [`extra:${pid}`, processExists(pid)]),
  ].filter(([, alive]) => alive).map(([name]) => name);
  return {
    ...production,
    before,
    groupGone,
    leaderGone,
    descendantGone,
    extraPidsGone: extraPidsGone.every(Boolean),
    survivors,
  };
}

async function executeDirect(fixture, name, args, signal = new AbortController().signal, allowError = false) {
  const definition = fixture.session.getToolDefinition(name);
  assert.ok(definition, `${name} was not registered by the production runtime`);
  const result = await definition.execute(
    `process-integration-${name}-${Date.now()}`,
    args,
    signal,
    undefined,
    fixture.session.extensionRunner.createContext(),
  );
  if (!allowError) assert.notEqual(result.isError, true, `${name}: ${resultText(result)}`);
  return result;
}

async function createSession(codingAgent, ai, manifest, loaderPath, sessionId) {
  const settingsManager = codingAgent.SettingsManager.create(workspace, path.join(root, "agent"), {
    projectTrusted: true,
  });
  const resourceLoader = new codingAgent.DefaultResourceLoader({
    cwd: workspace,
    agentDir: path.join(root, "agent"),
    settingsManager,
    additionalExtensionPaths: [loaderPath],
    noExtensions: manifest.loader.discovery.extensions === false,
    noSkills: manifest.loader.discovery.skills === false,
    noPromptTemplates: manifest.loader.discovery.prompts === false,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await codingAgent.ModelRuntime.create({
    authPath: path.join(root, "agent/auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = ai.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "reviewed Pi model fixture is unavailable");
  const sessionManager = codingAgent.SessionManager.create(workspace, path.join(root, "sessions"), { id: sessionId });
  const created = await codingAgent.createAgentSession({
    cwd: workspace,
    agentDir: path.join(root, "agent"),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    sessionStartEvent: { type: "session_start", reason: sessionId === "process-main" ? "startup" : "resume" },
  });
  const extensionErrors = [];
  const ui = createUi();
  await created.session.bindExtensions({
    uiContext: ui,
    mode: "rpc",
    onError(error) { extensionErrors.push(error); },
  });
  assert.deepEqual(extensionErrors, []);
  await created.session.extensionRunner.emit({ type: "session_start", reason: sessionId === "process-main" ? "startup" : "resume" });
  assert.deepEqual(extensionErrors, []);
  const fixture = { ...created, extensionErrors, resourceLoader, sessionFile: created.session.sessionFile, ui };
  activeSessions.push(fixture);
  return fixture;
}

async function shutdownSession(fixture, reason = "quit") {
  if (!fixture || fixture.closed) return;
  fixture.closed = true;
  recordOperation("session_shutdown");
  try {
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason });
  } finally {
    fixture.session.dispose();
    const index = activeSessions.indexOf(fixture);
    if (index >= 0) activeSessions.splice(index, 1);
  }
}

async function registerLspRecord(kind) {
  const observationPath = path.join(root, ".task-4-9-server-observation.json");
  const descendantPath = path.join(root, ".task-4-9-descendant-observation.json");
  await waitForFile(observationPath, `${kind} LSP startup`);
  await waitForFile(descendantPath, `${kind} LSP descendant startup`);
  const observation = readJson(observationPath);
  const descendant = readJson(descendantPath);
  assert.ok(Number.isInteger(observation.pid), `${kind} LSP observation did not record a PID`);
  assert.ok(Number.isInteger(descendant.pid), `${kind} LSP descendant observation did not record a PID`);
  return register({
    kind,
    mode: "production-code-intelligence",
    pgid: observation.pid,
    leaderPid: observation.pid,
    descendantPid: descendant.pid,
    extraPids: [],
  });
}

async function runFailureMode(codingAgent, ai, manifest, loaderPath) {
  const fixture = await createSession(codingAgent, ai, manifest, loaderPath, "process-failure");
  const lspRecord = await registerLspRecord("language-server-failure");
  assert.equal(processGroupExists(lspRecord.pgid), true);
  const readyPath = path.join(root, "failure.ready");
  const signalPath = path.join(root, "failure.signals");
  const command = [process.execPath, path.join(root, "tree-worker.mjs"), "stubborn", readyPath, signalPath]
    .map(quoteShell).join(" ");
  const started = await executeDirect(fixture, "bg_start", { name: "failure-task", command });
  await waitForFile(readyPath, "failure finalizer task");
  const record = recordFromReady("background-failure", "pipe", started.details.pid, readyPath, []);
  if (mode === "hang-after-registration") await new Promise(() => {});
  throw new Error(`intentional process probe failure after registering ${record.kind}`);
}

async function runIntegration(codingAgent, ai, manifest, loaderPath) {
  const fixture = await createSession(codingAgent, ai, manifest, loaderPath, "process-main");

  const childLogDir = path.join(root, "child-agent-launches");
  fs.mkdirSync(childLogDir, { recursive: true });
  process.env.PI_SUBAGENT_FIXTURE_LOG_DIR = childLogDir;
  process.env.PI_SUBAGENT_FIXTURE_TREE = "1";
  const controller = new AbortController();
  const childExecution = executeDirect(fixture, "subagent", {
    agent: "worker",
    task: "[managed-tree] process integration cancellation",
    agentContract: { version: 1 },
  }, controller.signal, true);
  const childTreePath = await waitForChildTree(childLogDir, childExecution);
  const childTree = readJson(childTreePath);
  const childRecord = register({
    kind: "foreground-child-agent",
    mode: "production-subagent",
    pgid: childTree.processGroupId,
    leaderPid: childTree.parentPid,
    descendantPid: childTree.descendantPid,
    extraPids: [],
  });
  assert.equal(processGroupExists(childRecord.pgid), true);
  recordOperation("subagent.abort");
  controller.abort(new Error("process integration cancellation"));
  const childResult = await childExecution;
  const childCleanup = await cleanupRecord(childRecord, { result: childResult.isError === true });

  const lspObservationPath = path.join(root, ".task-4-9-server-observation.json");
  const lspDescendantPath = path.join(root, ".task-4-9-descendant-observation.json");
  const lspLifecyclePath = path.join(root, ".task-4-9-lsp-lifecycle.jsonl");
  recordOperation("code_health");
  const health = await executeDirect(fixture, "code_health", { scope: "source.ts", include: ["servers"] });
  await waitForFile(lspObservationPath, "managed LSP startup");
  await waitForFile(lspDescendantPath, "managed LSP descendant startup");
  await waitFor(() => fs.existsSync(lspLifecyclePath) && fs.readFileSync(lspLifecyclePath, "utf8").includes('"event":"initialize"'), "managed LSP initialization");
  const lspRecord = await registerLspRecord("language-server");
  assert.match(resultText(health), /typescript[\s\S]*ready/i);

  const replacementReady = path.join(root, "replacement-old.ready");
  const replacementSignals = path.join(root, "replacement-old.signals");
  const replacementCommand = [process.execPath, path.join(root, "tree-worker.mjs"), "normal", replacementReady, replacementSignals]
    .map(quoteShell).join(" ");
  const oldStart = await executeDirect(fixture, "bg_start", { name: "replacement-old", command: replacementCommand });
  await waitForFile(replacementReady, "background replacement old task");
  const oldRecord = recordFromReady("background-pipe", "production-background", oldStart.details.pid, replacementReady);
  recordOperation("bg_kill");
  const oldKill = await executeDirect(fixture, "bg_kill", { id: oldStart.details.id });
  const oldCleanup = await cleanupRecord(oldRecord, { result: oldKill.details });
  const newReady = path.join(root, "replacement-new.ready");
  const newSignals = path.join(root, "replacement-new.signals");
  const newCommand = [process.execPath, path.join(root, "tree-worker.mjs"), "normal", newReady, newSignals]
    .map(quoteShell).join(" ");
  const newStart = await executeDirect(fixture, "bg_start", { name: "replacement-new", command: newCommand });
  await waitForFile(newReady, "background replacement new task");
  const newRecord = recordFromReady("background-pipe-replacement", "production-background", newStart.details.pid, newReady);
  const newKill = await executeDirect(fixture, "bg_kill", { id: newStart.details.id });
  const newCleanup = await cleanupRecord(newRecord, { result: newKill.details });

  const ptyWorker = path.join(root, "tree-worker.mjs");
  const gracefulReady = path.join(root, "pty-graceful.ready");
  const gracefulSignals = path.join(root, "pty-graceful.signals");
  const gracefulStart = await executeDirect(fixture, "bg_start", {
    name: "pty-graceful",
    command: [process.execPath, ptyWorker, "normal", gracefulReady, gracefulSignals].map(quoteShell).join(" "),
    pty: true,
  });
  await waitForFile(gracefulReady, "graceful PTY");
  const gracefulRecord = recordFromReady("pty", "production-pty", gracefulStart.details.pid, gracefulReady);
  recordOperation("bg_send");
  const gracefulStop = await executeDirect(fixture, "bg_send", { id: gracefulStart.details.id, signal: "SIGTERM" });
  const gracefulCleanup = await cleanupRecord(gracefulRecord, { result: gracefulStop.details, finalSignal: gracefulStop.details.finalSignal });

  const forcedReady = path.join(root, "pty-forced.ready");
  const forcedSignals = path.join(root, "pty-forced.signals");
  const forcedStart = await executeDirect(fixture, "bg_start", {
    name: "pty-forced",
    command: [process.execPath, ptyWorker, "stubborn", forcedReady, forcedSignals].map(quoteShell).join(" "),
    pty: true,
  });
  await waitForFile(forcedReady, "forced PTY");
  const forcedRecord = recordFromReady("pty", "production-pty", forcedStart.details.pid, forcedReady);
  const forcedStop = await executeDirect(fixture, "bg_send", { id: forcedStart.details.id, signal: "SIGTERM" });
  const forcedCleanup = await cleanupRecord(forcedRecord, { result: forcedStop.details, finalSignal: forcedStop.details.finalSignal });

  const sessionReady = path.join(root, "session-exit.ready");
  const sessionSignals = path.join(root, "session-exit.signals");
  const sessionCommand = [process.execPath, path.join(root, "tree-worker.mjs"), "stubborn", sessionReady, sessionSignals]
    .map(quoteShell).join(" ");
  const sessionStart = await executeDirect(fixture, "bg_start", { name: "session-exit", command: sessionCommand });
  await waitForFile(sessionReady, "session exit task");
  const sessionRecord = recordFromReady("background-session-exit", "production-background", sessionStart.details.pid, sessionReady);

  await shutdownSession(fixture);
  const lspCleanup = await cleanupRecord(lspRecord, { shutdown: "session_shutdown" });
  const sessionCleanup = await cleanupRecord(sessionRecord, { shutdown: "session_shutdown" });
  const initialLspObservation = path.join(root, ".task-4-9-server-observation.initial.json");
  const initialLspDescendant = path.join(root, ".task-4-9-descendant-observation.initial.json");
  fs.renameSync(lspObservationPath, initialLspObservation);
  fs.renameSync(lspDescendantPath, initialLspDescendant);

  const replacementFixture = await createSession(codingAgent, ai, manifest, loaderPath, "process-replacement");
  const replacementLspRecord = await registerLspRecord("language-server-replacement");
  await shutdownSession(replacementFixture, "reload");
  const replacementLspCleanup = await cleanupRecord(replacementLspRecord, { shutdown: "session_shutdown" });

  return {
    sandbox: { profile: "pi-managed", pid: process.pid },
    runtime: { kind: "pi-coding-agent", operations: [...operations] },
    paths: [
      { name: "foreground-child-cancellation", registered: childRecord, cleanup: childCleanup },
      { name: "lsp-session-shutdown", registered: lspRecord, cleanup: lspCleanup },
      { name: "background-replacement", registered: oldRecord, cleanup: oldCleanup },
      { name: "pty-graceful", registered: gracefulRecord, cleanup: gracefulCleanup },
      { name: "pty-forced", registered: forcedRecord, cleanup: forcedCleanup },
      { name: "background-session-shutdown", registered: sessionRecord, cleanup: sessionCleanup },
      { name: "lsp-session-replacement", registered: replacementLspRecord, cleanup: replacementLspCleanup },
    ],
    replacement: {
      old: oldRecord,
      new: newRecord,
      oldGroupGoneBeforeNewTask: oldCleanup.groupGone,
      oldCleanup,
      newCleanup,
    },
  };
}

async function waitForFileInDirectory(directory, suffix) {
  let match;
  await waitFor(() => {
    match = fs.readdirSync(directory).find((entry) => entry.endsWith(suffix));
    return match !== undefined;
  }, `fixture file ${suffix}`);
  return path.join(directory, match);
}

async function waitForChildTree(childLogDir, childExecution) {
  try {
    return await Promise.race([
      waitForFileInDirectory(childLogDir, ".tree"),
      childExecution.then((result) => {
        throw new Error(`production subagent ended before fixture tree: ${JSON.stringify(result)}`);
      }),
    ]);
  } catch (error) {
    error.message += `; child fixture entries: ${JSON.stringify(fs.existsSync(childLogDir) ? fs.readdirSync(childLogDir).sort() : [])}`;
    throw error;
  }
}

async function inspectAll(timeoutMs = FINALIZER_PROBE_TIMEOUT_MS) {
  const groups = await Promise.all([...registeredGroups].map(async (pgid) => {
    try {
      await waitForStableAbsence(() => processGroupExists(pgid), `registered group ${pgid}`, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }));
  const pids = await Promise.all([...registeredProcesses].map(async (pid) => {
    try {
      await waitForStableAbsence(() => processExists(pid), `registered PID ${pid}`, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }));
  return { allGroupsGone: groups.every(Boolean), allPidsGone: pids.every(Boolean) };
}

function safeEmergencySignal(target, signal, group) {
  try {
    if (group) process.kill(-target, signal);
    else process.kill(target, signal);
    return { target, signal, group, sent: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { target, signal, group, sent: false, alreadyGone: true };
    return { target, signal, group, sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function emergencyFinalize() {
  const signals = [];
  const send = (signal) => {
    for (const pgid of registeredGroups) {
      if (processGroupExists(pgid)) signals.push(safeEmergencySignal(pgid, signal, true));
    }
    for (const pid of registeredProcesses) {
      if (processExists(pid)) signals.push(safeEmergencySignal(pid, signal, false));
    }
  };
  send("SIGTERM");
  const afterTerm = await inspectAll();
  if (!afterTerm.allGroupsGone || !afterTerm.allPidsGone) {
    send("SIGKILL");
  }
  const stable = await inspectAll(5_000);
  return { signals, ...stable };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupSessions() {
  const errors = [];
  for (const fixture of [...activeSessions].reverse()) {
    try {
      await withTimeout(shutdownSession(fixture), SESSION_CLEANUP_TIMEOUT_MS, "session cleanup");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      try { fixture.session.dispose(); } catch { /* emergency finalizer owns process cleanup */ }
    }
  }
  return errors;
}

async function main() {
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "cavemem"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent/settings.json"), "{}\n");
  fs.writeFileSync(path.join(root, "agent/auth.json"), `${JSON.stringify({ anthropic: { type: "api_key", key: "process-model-fixture" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "source.ts"), "export function greet(name: string): string { return `hello ${name}`; }\n");
  fs.writeFileSync(path.join(root, "implementation.ts"), "export class Greeter {}\n");
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "process-integration-fixture", private: true })}\n`);
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi/settings.json"), "{}\n");
  fs.writeFileSync(path.join(root, "cavemem/settings.json"), `${JSON.stringify({
    dataDir: path.join(root, "cavemem"),
    workerPort: 37777,
    logLevel: "error",
    compression: { intensity: "full", expandForModel: true },
    embedding: { provider: "none", model: "process-integration", batchSize: 16, autoStart: false, idleShutdownMs: 60_000 },
    search: { alpha: 0.5, defaultLimit: 20 },
    privacy: { excludePatterns: [], redactSecrets: true },
    ides: {},
  }, null, 2)}\n`);
  const bootstrap = { schemaVersion: 1, mode: "personal", redactExact: Object.freeze((value) => value) };
  Object.defineProperty(bootstrap, "toJSON", { configurable: false, enumerable: false, value: Object.freeze(() => { throw new Error("runtime bootstrap is not serializable"); }), writable: false });
  Object.freeze(bootstrap);
  Object.defineProperty(globalThis, Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1"), { configurable: false, enumerable: false, value: bootstrap, writable: false });
  const environment = {};
  for (const [name, value] of Object.entries({
    CAVEMEM_DATA_DIR: path.join(root, "cavemem"),
    HOME: path.join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/sh",
    TERM: "xterm-256color",
    TMPDIR: path.join(root, "tmp"),
    USER: "pi-agent-process-fixture",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  })) {
    Object.defineProperty(environment, name, { configurable: false, enumerable: true, value, writable: false });
    if (value.startsWith(root)) fs.mkdirSync(value, { recursive: true });
  }
  Object.freeze(environment);
  const capability = { schemaVersion: 1, environment };
  Object.defineProperty(capability, "toJSON", { configurable: false, enumerable: false, value: Object.freeze(() => { throw new Error("Cavemem environment is not serializable"); }), writable: false });
  Object.freeze(capability);
  Object.defineProperty(globalThis, Symbol.for("dwsr.pi-agent.cavemem-environment.v1"), { configurable: false, enumerable: false, value: capability, writable: false });
  Object.assign(process.env, environment, {
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_AGENT_LSP_EXECUTABLES: JSON.stringify({ typescript: lspExecutable }),
    PI_SUBAGENT_FIXTURE_LOG_DIR: path.join(root, "child-agent-launches"),
    PI_SUBAGENT_FIXTURE_TREE: "1",
  });
  process.argv[1] = childAgent;
  const codingAgent = await import(pathToFileURL(path.join(piRoot, "lib/node_modules/@earendil-works/pi-coding-agent/index.js")));
  const ai = await import(pathToFileURL(path.join(piRoot, "lib/node_modules/@earendil-works/pi-ai/compat.js")));
  const manifest = readJson(path.join(extensionRoot, "share/pi-agent/extensions.json"));
  const loaderPath = path.join(extensionRoot, manifest.loader.entryPath);
  if (mode) {
    await runFailureMode(codingAgent, ai, manifest, loaderPath);
    return;
  }
  report = await runIntegration(codingAgent, ai, manifest, loaderPath);
}

try {
  persistCleanupState({ phase: "setup" });
  await main();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  process.exitCode = 1;
} finally {
  let sessionErrors;
  try {
    sessionErrors = await cleanupSessions();
  } catch (error) {
    sessionErrors = [error instanceof Error ? error.message : String(error)];
  }
  let emergencyFinalizer;
  try {
    emergencyFinalizer = await emergencyFinalize();
  } catch (error) {
    emergencyFinalizer = {
      signals: [],
      allGroupsGone: false,
      allPidsGone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let sessionExit;
  try {
    sessionExit = await inspectAll(5_000);
  } catch (error) {
    sessionExit = {
      allGroupsGone: false,
      allPidsGone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const summary = {
    allOwnedGroupsGone: sessionExit.allGroupsGone && emergencyFinalizer.allGroupsGone,
    allOwnedPidsGone: sessionExit.allPidsGone && emergencyFinalizer.allPidsGone,
  };
  if (report) Object.assign(report, { sessionExit, emergencyFinalizer, summary });
  const evidence = {
    sandbox: { profile: "pi-managed", pid: process.pid },
    runtime: report?.runtime ?? { kind: "pi-coding-agent", operations: [...operations] },
    paths: report?.paths ?? [],
    replacement: report?.replacement,
    sessionExit,
    emergencyFinalizer,
    summary,
    failure: failure ? { name: failure.name, message: failure.message } : null,
    sessionErrors,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  persistCleanupState({ phase: "probe-cleaned", probeCleanup: { sessionErrors, emergencyFinalizer, sessionExit, summary } });
}

if (failure) throw failure;
process.stdout.write(`${JSON.stringify(report)}\n`);
