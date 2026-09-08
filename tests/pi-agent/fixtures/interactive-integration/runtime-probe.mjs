import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [piRoot, extensionRoot, mcpPortValue, lspRoot] = process.argv.slice(2);
if (!piRoot || !extensionRoot || !mcpPortValue || !lspRoot) {
  throw new Error("usage: runtime-probe PI_ROOT EXTENSION_ROOT MCP_PORT LSP_ROOT");
}
const mcpPort = Number(mcpPortValue);
if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535) {
  throw new Error("MCP_PORT must be a valid TCP port");
}
const reviewTools = ["read", "grep", "find", "ls"];
const expectedPlanTools = [
  "read",
  "grep",
  "find",
  "ls",
  "plan_mode_question",
  "plan_mode_complete",
];

let root;
let cwd;
let agentDir;
let sessionsDir;
let timeoutEffects;
let ptyScript;
let timeoutProbeObservationPath;
let environmentValues;
let originalFetch;
let codingAgent;
let ai;
let streams;
let manifest;
let loaderPath;
let model;
const ownedProcessGroups = new Set();
const ownedProcesses = new Set();
const cleanupStatePath = process.env.PI_AGENT_INTERACTIVE_CLEANUP_FILE;
const requestedRoot = process.env.PI_AGENT_INTERACTIVE_ROOT;

function persistCleanupState(extra = {}) {
  if (!cleanupStatePath) return;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(cleanupStatePath, "utf8"));
  } catch {
    state = {};
  }
  const next = {
    ...state,
    ...extra,
    probePid: process.pid,
    root,
    groups: [...ownedProcessGroups],
    processes: [...ownedProcesses],
  };
  const temporaryPath = `${cleanupStatePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`);
  fs.renameSync(temporaryPath, cleanupStatePath);
}

function registerProcessGroup(pgid) {
  ownedProcessGroups.add(pgid);
  persistCleanupState({ phase: "running" });
}

function registerProcess(pid) {
  ownedProcesses.add(pid);
  persistCleanupState({ phase: "running" });
}

async function setup() {
  root = requestedRoot
    ? fs.realpathSync(requestedRoot)
    : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-interactive-integration-"));
  fs.mkdirSync(root, { recursive: true });
  persistCleanupState({ phase: "setup" });
  cwd = path.join(root, "workspace");
  agentDir = path.join(root, "agent");
  sessionsDir = path.join(root, "sessions");
  timeoutEffects = path.join(root, "timeout-effects.log");
  ptyScript = path.join(root, "interactive-pty.cjs");
  for (const directory of [cwd, agentDir, sessionsDir, path.dirname(ptyScript)]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const sourceText = [
    "export function greet(name: string): string {",
    "  return `hello ${name}`;",
    "}",
    "",
    'export const result = greet("world");',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(cwd, "source.ts"), sourceText);
  fs.writeFileSync(path.join(cwd, "implementation.ts"), "export class Greeter {}\n");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "interactive-fixture", private: true }));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/settings.json"), "{}\n");
  fs.writeFileSync(
    ptyScript,
    [
      "const readline = require('node:readline');",
      "process.stdout.write('pty-ready\\n');",
      "readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => process.stdout.write(`pty-input:${line}\\n`));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  timeoutProbeObservationPath = path.join(root, "timeout-descendant-observation.json");

  environmentValues = {
    HOME: path.join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TERM: "xterm-256color",
    TMPDIR: path.join(root, "tmp"),
    USER: "pi-interactive",
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  };
  for (const directory of Object.values(environmentValues).filter((value) => value.startsWith(root))) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  fs.writeFileSync(
    path.join(agentDir, "auth.json"),
    `${JSON.stringify({ anthropic: { type: "api_key", key: "interactive-model-fixture" } })}\n`,
    { mode: 0o600 },
  );
  Object.assign(process.env, environmentValues, {
    PI_AGENT_BASH_TIMEOUT_MS: "250",
    PI_AGENT_LSP_EXECUTABLES: JSON.stringify({
      typescript: path.join(lspRoot, "bin/typescript-language-server"),
    }),
    PI_CODING_AGENT_DIR: agentDir,
  });
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SHOPIFY_PI_TOKEN", "PI_AGENT_LAUNCH_ID"]) {
    delete process.env[name];
  }

  if (process.env.PI_AGENT_INTERACTIVE_PROBE_MODE) return;

  originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const source = input instanceof Request ? input.url : input;
    const url = new URL(source);
    if (url.hostname === "127.0.0.1" && url.port === "8080") url.port = String(mcpPort);
    if (input instanceof Request) return originalFetch(new Request(url, input), init);
    return originalFetch(input instanceof URL ? url : url.href, init);
  };

  installCapabilitySymbols();
  const nodeModules = path.join(piRoot, "lib/node_modules");
  codingAgent = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js")));
  ai = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js")));
  streams = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/utils/event-stream.js")));
  manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "share/pi-agent/extensions.json"), "utf8"));
  loaderPath = path.join(extensionRoot, manifest.loader.entryPath);
  model = ai.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "reviewed Pi model fixture is unavailable");
}

function installCapabilitySymbols() {
  const bootstrap = { schemaVersion: 1, mode: "personal", redactExact: Object.freeze((value) => value) };
  Object.defineProperty(bootstrap, "toJSON", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(() => { throw new Error("runtime bootstrap is not serializable"); }),
    writable: false,
  });
  Object.freeze(bootstrap);
  Object.defineProperty(globalThis, Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1"), {
    configurable: false,
    enumerable: false,
    value: bootstrap,
    writable: false,
  });

}
function createUi() {
  const notifications = [];
  const theme = { fg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
  return {
    notifications,
    context: {
      async select() { return undefined; },
      async confirm() { return false; },
      async input() { return undefined; },
      async editor() { return undefined; },
      custom(factory) {
        return new Promise((resolve, reject) => {
          try {
            const component = factory({ requestRender() {} }, theme, { matches: () => false }, resolve);
            queueMicrotask(() => component?.handleInput?.("\u001b"));
          } catch (error) {
            reject(error);
          }
        });
      },
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
      theme,
    },
  };
}

function assistantMessage(activeModel, response, sequence, timestamp = Date.now()) {
  return {
    role: "assistant",
    content: response.type === "tool"
      ? [{ type: "toolCall", id: `interactive-call-${sequence}`, name: response.name, arguments: response.arguments }]
      : [{ type: "text", text: response.text }],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: response.type === "tool" ? "toolUse" : "stop",
    timestamp,
  };
}

function setResponses(fixture, responses, snapshots = []) {
  let index = 0;
  fixture.session.agent.streamFunction = (activeModel, context, options) => {
    snapshots.push({
      tools: (context.tools ?? []).map(({ name }) => name),
      messages: JSON.stringify(context.messages),
    });
    const response = options?.signal?.aborted
      ? { type: "text", text: "aborted" }
      : responses[Math.min(index++, responses.length - 1)];
    const message = options?.signal?.aborted
      ? { ...assistantMessage(activeModel, response, index), stopReason: "aborted", errorMessage: "Request aborted by user" }
      : assistantMessage(activeModel, response, index);
    const stream = streams.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  return snapshots;
}

async function createSession({ sessionFile, reason, id }) {
  let created;
  try {
    const settingsManager = codingAgent.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new codingAgent.DefaultResourceLoader({
      cwd,
      agentDir,
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
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const sessionManager = sessionFile
      ? codingAgent.SessionManager.open(sessionFile, sessionsDir, cwd)
      : codingAgent.SessionManager.create(cwd, sessionsDir, { id: id ?? "interactive-integration" });
    created = await codingAgent.createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent: {
        type: "session_start",
        reason: reason ?? (sessionFile ? "resume" : "startup"),
        ...(sessionFile ? { previousSessionFile: sessionFile } : {}),
      },
    });
    const ui = createUi();
    const extensionErrors = [];
    await created.session.bindExtensions({
      uiContext: ui.context,
      mode: "tui",
      onError(error) { extensionErrors.push(error); },
    });
    return { ...created, extensionErrors, resourceLoader, sessionFile: created.session.sessionFile, ui };
  } catch (error) {
    if (created?.session) {
      await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "setup-failed" }).catch(() => {});
      try {
        created.session.dispose();
      } catch {
        // Preserve the setup error; the outer cleanup owns observed processes.
      }
    }
    throw error;
  }
}

async function closeSession(fixture, appendedState) {
  try {
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    if (appendedState !== undefined) {
      fixture.session.sessionManager.appendCustomEntry("plan-mode-state", appendedState);
    }
  } finally {
    fixture.session.dispose();
  }
}

function branchToolResult(fixture, toolCallId) {
  return fixture.session.sessionManager.getBranch()
    .findLast((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId)?.message;
}

async function runToolTurn(fixture, name, arguments_, prompt, responses = [{ type: "text", text: "turn complete" }]) {
  const snapshots = setResponses(fixture, [
    { type: "tool", name, arguments: arguments_ },
    ...responses,
  ]);
  await fixture.session.prompt(prompt);
  await fixture.session.waitForIdle();
  const toolCallId = fixture.session.sessionManager.getBranch()
    .findLast((entry) => entry.message?.role === "assistant" && entry.message.content?.some((item) => item.type === "toolCall" && item.name === name))
    ?.message.content.find((item) => item.type === "toolCall" && item.name === name).id;
  const result = toolCallId === undefined ? undefined : branchToolResult(fixture, toolCallId);
  assert.ok(result, `missing ${name} result`);
  return { result, snapshots, toolCallId };
}

async function executeDirect(fixture, name, arguments_) {
  const definition = fixture.session.getToolDefinition(name);
  assert.ok(definition, `${name} was not registered`);
  return definition.execute(
    `direct-${name}-${Date.now()}`,
    arguments_,
    new AbortController().signal,
    undefined,
    fixture.session.extensionRunner.createContext(),
  );
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await predicate(), true, `timed out waiting for ${label}`);
}

function resultText(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
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

async function assertGroupGone(pgid) {
  assert.equal(
    await waitUntilGone(() => processGroupExists(pgid)),
    true,
    `process group ${pgid} cleanup did not reach stable absence`,
  );
}

async function assertProcessGone(pid) {
  assert.equal(
    await waitUntilGone(() => processExists(pid)),
    true,
    `process ${pid} cleanup did not reach stable absence`,
  );
}

function planStates(fixture) {
  return fixture.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
    .map((entry) => structuredClone(entry.data));
}

function latestPlanState(fixture) {
  const state = planStates(fixture).at(-1);
  assert.ok(state, "missing Plan state");
  return state;
}

function timestampEntries(fixture) {
  return fixture.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-stamp")
    .map((entry) => ({ role: entry.data?.role, timestamp: entry.data?.timestamp }));
}

function timestampEntryRecords(fixture) {
  return fixture.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-stamp");
}

function persistedTimestampEntryRecords(fixture) {
  return fs.readFileSync(fixture.sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-stamp");
}

function renderedTimestampRows(fixture, entries, label) {
  const renderer = fixture.session.extensionRunner.getEntryRenderer("pi-stamp");
  assert.ok(renderer, `${label} timestamp renderer is missing`);
  const theme = fixture.ui.context.theme;
  return entries.flatMap((entry) => {
    const component = renderer(entry, { expanded: false }, theme);
    return component?.render(80).map((line) => String(line).trim()).filter(Boolean) ?? [];
  });
}

function timestampEvidence(fixture, label) {
  const records = timestampEntryRecords(fixture);
  const persistedRecords = persistedTimestampEntryRecords(fixture);
  const renderedRows = renderedTimestampRows(fixture, records, label);
  assert.ok(records.length > 0, `${label} has no persisted timestamp entries`);
  assert.ok(persistedRecords.length > 0, `${label} session file has no timestamp entries`);
  assert.ok(renderedRows.length > 0, `${label} rendered no timestamp entries`);
  assert.ok(
    renderedRows.some((row) => /\d{2}:\d{2}:\d{2}/.test(row)),
    `${label} rendered timestamp rows contain no local time text`,
  );
  return {
    identities: timestampEntries(fixture),
    persisted: persistedRecords.map((entry) => ({ role: entry.data?.role, timestamp: entry.data?.timestamp })),
    rendered: renderedRows,
  };
}

function contextHasTimestamp(fixture, snapshots) {
  const context = JSON.stringify(fixture.session.sessionManager.buildSessionContext().messages);
  return snapshots.some(({ messages }) => /pi-stamp|\d{2}:\d{2}:\d{2}/.test(messages))
    || /pi-stamp|\d{2}:\d{2}:\d{2}/.test(context);
}

const unexpectedMutationExecutions = [];

async function guardTool(fixture, toolName, args, { executeOnUnexpectedAllow = false } = {}) {
  const result = await fixture.session.agent.beforeToolCall({
    assistantMessage: assistantMessage(model, { type: "text", text: "guard" }, Date.now()),
    toolCall: { type: "toolCall", id: `guard-${toolName}-${Date.now()}`, name: toolName, arguments: args },
    args,
    context: { messages: [], systemPrompt: "", tools: [] },
  });
  if (executeOnUnexpectedAllow && result?.block !== true) {
    unexpectedMutationExecutions.push(toolName);
    const definition = fixture.session.getToolDefinition(toolName);
    assert.ok(definition, `${toolName} was not registered for the unexpected-allow probe`);
    await definition.execute(
      `unexpected-plan-mutation-${toolName}`,
      args,
      new AbortController().signal,
      undefined,
      fixture.session.extensionRunner.createContext(),
    ).catch(() => undefined);
  }
  return result ?? {};
}

async function waitForBackgroundLogs(fixture, id, pattern) {
  let result;
  await waitFor(async () => {
    result = await executeDirect(fixture, "bg_logs", { id, stream: "terminal", tail: 30 });
    return pattern.test(resultText(result));
  }, `background output ${pattern}`);
  return result;
}

let activeFixtures = [];

async function runIntegration() {
  const initial = await createSession({ id: "interactive-integration-main" });
  activeFixtures.push(initial);
  const normalTools = initial.session.getActiveToolNames();
  const registeredTools = initial.session.getAllTools().map(({ name }) => name);
  const contextSnapshots = [];
  setResponses(initial, [{ type: "text", text: "combined session prompt" }], contextSnapshots);
  await initial.session.prompt("combined session prompt");
  await initial.session.waitForIdle();

  const question = await runToolTurn(initial, "ask_user", {
    title: "Cancellation check",
    questions: [{ type: "choice", id: "cancel", header: "Cancel", prompt: "Cancel this question.", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }],
  }, "cancel the combined question");
  contextSnapshots.push(...question.snapshots);
  const questionCancelled = question.result.isError === true
    && Object.keys(question.result.details ?? {}).length === 0
    && /interaction was cancelled/i.test(resultText(question.result))
    && !JSON.stringify(initial.session.sessionManager.getBranch()).includes('"outcome":"submitted"');

  const timeoutResult = await runToolTurn(initial, "bash", {
    command: [
      `: > ${JSON.stringify(timeoutEffects)}`,
      `(while :; do printf tick >> ${JSON.stringify(timeoutEffects)}; sleep 0.02; done) & descendant=$!`,
      `printf '{"commandPid":%s,"pgid":%s,"descendantPid":%s}\\n' "$$" "$$" "$descendant" > ${JSON.stringify(timeoutProbeObservationPath)}`,
      'wait "$descendant"',
    ].join("; "),
  }, "run the bounded Bash timeout");
  contextSnapshots.push(...timeoutResult.snapshots);
  assert.equal(timeoutResult.result.isError, true, resultText(timeoutResult.result));
  assert.match(resultText(timeoutResult.result), /Command timed out after 0\.25 seconds/);
  await waitFor(() => fs.existsSync(timeoutProbeObservationPath), "Bash timeout process observation");
  const timeoutObservation = JSON.parse(fs.readFileSync(timeoutProbeObservationPath, "utf8"));
  assert.ok(Number.isInteger(timeoutObservation.commandPid), "Bash timeout command did not record its PID");
  assert.ok(Number.isInteger(timeoutObservation.pgid), "Bash timeout command did not record its process-group ID");
  assert.ok(Number.isInteger(timeoutObservation.descendantPid), "Bash timeout descendant did not record its PID");
  assert.equal(timeoutObservation.pgid, timeoutObservation.commandPid, "Bash timeout group leader was not recorded");
  registerProcessGroup(timeoutObservation.pgid);
  registerProcess(timeoutObservation.commandPid);
  registerProcess(timeoutObservation.descendantPid);
  const timeoutDescendantCleanup = {
    groupGone: await waitUntilGone(() => processGroupExists(timeoutObservation.pgid)),
    commandGone: await waitUntilGone(() => processExists(timeoutObservation.commandPid)),
    descendantGone: await waitUntilGone(() => processExists(timeoutObservation.descendantPid)),
  };
  timeoutDescendantCleanup.stableAbsence = Object.values(timeoutDescendantCleanup).every(Boolean);
  assert.equal(timeoutDescendantCleanup.groupGone, true, "Bash timeout process group remained alive");
  assert.equal(timeoutDescendantCleanup.commandGone, true, "Bash timeout command remained alive");
  assert.equal(timeoutDescendantCleanup.descendantGone, true, "Bash timeout descendant remained alive");
  assert.equal(timeoutDescendantCleanup.stableAbsence, true, "Bash timeout cleanup was not stably absent");
  const timeoutDescendantContinued = !timeoutDescendantCleanup.stableAbsence;

  const pipeStart = await executeDirect(initial, "bg_start", {
    name: "combined-pipe",
    command: "printf pipe-start; sleep 0.15; printf pipe-done",
  });
  assert.ok(pipeStart.details?.id, resultText(pipeStart));
  const pipeId = pipeStart.details.id;
  const pipeWait = await executeDirect(initial, "bg_wait", { id: pipeId, timeout: 10 });
  const pipeLogs = await executeDirect(initial, "bg_logs", { id: pipeId, stream: "stdout", tail: 20 });
  const backgroundPipeCompleted = pipeWait.details.status === "completed" && /pipe-start[\s\S]*pipe-done/.test(resultText(pipeLogs));

  const ptyStart = await executeDirect(initial, "bg_start", {
    name: "combined-pty",
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ptyScript)}`,
    pty: true,
  });
  assert.ok(ptyStart.details?.id, resultText(ptyStart));
  const ptyId = ptyStart.details.id;
  const ptyPgid = ptyStart.details.pid;
  registerProcessGroup(ptyPgid);
  await waitForBackgroundLogs(initial, ptyId, /pty-ready/);
  await executeDirect(initial, "bg_send", { id: ptyId, input: "hello\n" });
  await waitForBackgroundLogs(initial, ptyId, /pty-input:hello/);
  const ptyStop = await executeDirect(initial, "bg_send", { id: ptyId, signal: "SIGTERM" });
  await assertGroupGone(ptyPgid);
  const ptyStopped = ptyStop.details.status === "stopped";

  const lspObservationPath = path.join(cwd, ".task-4-9-server-observation.json");
  const lspDescendantObservationPath = path.join(cwd, ".task-4-9-descendant-observation.json");
  const lspLifecyclePath = path.join(cwd, ".task-4-9-lsp-lifecycle.jsonl");
  await waitFor(() => fs.existsSync(lspObservationPath), "managed LSP startup");
  await waitFor(() => fs.existsSync(lspDescendantObservationPath), "managed LSP descendant startup");
  await waitFor(
    () => fs.existsSync(lspLifecyclePath) && fs.readFileSync(lspLifecyclePath, "utf8").includes('"event":"initialize"'),
    "managed LSP initialization",
  );
  const lspObservation = JSON.parse(fs.readFileSync(lspObservationPath, "utf8"));
  const lspDescendantObservation = JSON.parse(fs.readFileSync(lspDescendantObservationPath, "utf8"));
  assert.ok(Number.isInteger(lspObservation.pid), "fresh LSP observation did not record a PID");
  assert.ok(Number.isInteger(lspDescendantObservation.pid), "fresh LSP descendant observation did not record a PID");
  registerProcessGroup(lspObservation.pid);
  registerProcess(lspDescendantObservation.pid);
  const health = await executeDirect(initial, "code_health", { scope: "source.ts", include: ["servers"] });
  const lspReady = !health.isError && /typescript[\s\S]*ready/i.test(resultText(health));
  assert.equal(lspReady, true, resultText(health));
  const beforePreview = fs.readFileSync(path.join(cwd, "source.ts"));
  const preview = await executeDirect(initial, "code_refactor_plan", {
    target: { anchor: { file: "source.ts", line: 1, character: 17 } },
    operation: { rename_symbol: { newName: "salute" } },
  });
  const refactorPreviewWrote = !beforePreview.equals(fs.readFileSync(path.join(cwd, "source.ts")));
  assert.notEqual(preview.isError, true, resultText(preview));
  assert.match(resultText(preview), /This is a preview\. No files were changed/);
  const planId = /\*\*Plan ID:\*\* `([^`]+)`/.exec(resultText(preview))?.[1];
  assert.ok(planId, "missing managed refactor plan ID");

  initial.session.setActiveToolsByName(reviewTools);
  const reviewToolsSnapshot = initial.session.getActiveToolNames();
  const refactorApplyBlockedInReview = (await guardTool(initial, "code_refactor_apply", { planId })).block === true;
  initial.session.setActiveToolsByName(normalTools);

  await initial.session.prompt("/plan start");
  await initial.session.waitForIdle();
  const planTools = initial.session.getActiveToolNames();
  const planDeniedTools = [];
  for (const [toolName, args] of [
    ["bash", { command: "printf denied" }],
    ["write", { path: "denied", content: "denied" }],
    ["bg_start", { name: "denied", command: "printf denied" }],
    ["subagent", { agent: "worker", task: "denied" }],
    ["call_tool_write", { name: "fixture:update_record", args: { id: "interactive-plan-write" }, intent_reason: "denied", intent_data_sensitivity: "internal" }],
    ["call_tool_destructive", { name: "fixture:delete_record", args: { id: "interactive-plan-delete" }, intent_reason: "denied", intent_data_sensitivity: "internal" }],
    ["code_refactor_apply", { planId }],
  ]) {
    const guard = await guardTool(
      initial,
      toolName,
      args,
      { executeOnUnexpectedAllow: toolName === "call_tool_write" || toolName === "call_tool_destructive" },
    );
    assert.equal(guard.block, true, `${toolName} was not denied in Plan`);
    planDeniedTools.push(toolName);
  }
  const refactorApplyBlockedInPlan = planDeniedTools.includes("code_refactor_apply");
  const planState = latestPlanState(initial);
  const planCompletion = await runToolTurn(initial, "plan_mode_complete", {
    plan: "1. Inspect the integrated runtime\n2. Apply only after approval",
  }, "complete the combined Plan", []);
  contextSnapshots.push(...planCompletion.snapshots);
  assert.equal(planCompletion.result.isError, false, resultText(planCompletion.result));
  assert.match(resultText(planCompletion.result), /Proposed Plan/i);
  assert.match(
    initial.ui.notifications.map(({ message }) => message).join("\n"),
    /ready for approval/i,
  );
  const planCompletionState = latestPlanState(initial);
  assert.equal(planCompletionState.phase, "awaiting-approval");
  const planApprovalSnapshots = setResponses(initial, [{ type: "text", text: "approved combined implementation" }]);
  await initial.session.prompt("/plan implement");
  await waitFor(() => planApprovalSnapshots.length > 0, "Plan approval handoff");
  await initial.session.waitForIdle();
  contextSnapshots.push(...planApprovalSnapshots);
  const planApprovalState = latestPlanState(initial);
  const approvedTools = initial.session.getActiveToolNames();
  assert.equal(planApprovalSnapshots.length, 1);
  assert.equal(planApprovalState.phase, "approved");
  assert.deepEqual(planApprovalSnapshots[0].tools, normalTools);
  assert.deepEqual(approvedTools, normalTools);

  const freshPlan = await executeDirect(initial, "code_refactor_plan", {
    target: { anchor: { file: "source.ts", line: 1, character: 17 } },
    operation: { rename_symbol: { newName: "salute" } },
  });
  const applied = await executeDirect(initial, "code_refactor_apply", {
    planId: /\*\*Plan ID:\*\* `([^`]+)`/.exec(resultText(freshPlan))?.[1],
  });
  const refactorApplyWrote = !beforePreview.equals(fs.readFileSync(path.join(cwd, "source.ts")))
    && applied.isError !== true;

  const sessionFile = initial.sessionFile;
  const initialTimestampEvidence = timestampEvidence(initial, "fresh session");
  const initialTimestamps = initialTimestampEvidence.identities;
  const initialTimestampPersisted = initialTimestampEvidence.persisted;
  const initialTimestampRendered = initialTimestampEvidence.rendered;
  await closeSession(initial, { phase: "planning", capturedToolNames: [...normalTools, "combined_unavailable_tool"] });
  await assertGroupGone(lspObservation.pid);
  await assertProcessGone(lspDescendantObservation.pid);
  const initialLspObservationArchive = path.join(cwd, ".task-4-9-server-observation.initial.json");
  const initialLspDescendantObservationArchive = path.join(cwd, ".task-4-9-descendant-observation.initial.json");
  fs.renameSync(lspObservationPath, initialLspObservationArchive);
  fs.renameSync(lspDescendantObservationPath, initialLspDescendantObservationArchive);
  activeFixtures = [];

  const resumed = await createSession({ sessionFile, reason: "resume", id: "interactive-integration-resume" });
  activeFixtures.push(resumed);
  const resumedTimestampEvidence = timestampEvidence(resumed, "resumed session");
  const resumedTimestamps = resumedTimestampEvidence.identities;
  const resumedTimestampPersisted = resumedTimestampEvidence.persisted;
  const resumedTimestampRendered = resumedTimestampEvidence.rendered;
  const resumedPlanState = latestPlanState(resumed);
  const resumedPlanTools = resumed.session.getActiveToolNames();
  assert.equal(resumedPlanState.phase, "planning");
  assert.deepEqual(resumedPlanTools, expectedPlanTools);
  await resumed.session.prompt("/plan exit");
  await resumed.session.waitForIdle();
  const resumedRestoredTools = resumed.session.getActiveToolNames();
  const resumedUnavailableName = resumed.ui.notifications.find(({ message }) => message.includes("combined_unavailable_tool"))
    ? "combined_unavailable_tool"
    : undefined;
  const resumedLspObservationPath = path.join(cwd, ".task-4-9-server-observation.json");
  const resumedLspDescendantObservationPath = path.join(cwd, ".task-4-9-descendant-observation.json");
  await waitFor(() => fs.existsSync(resumedLspObservationPath), "resumed LSP startup");
  await waitFor(() => fs.existsSync(resumedLspDescendantObservationPath), "resumed LSP descendant startup");
  await waitFor(
    () => fs.readFileSync(lspLifecyclePath, "utf8").match(/"event":"initialize"/g)?.length >= 2,
    "resumed LSP initialization",
  );
  const resumedLspObservation = JSON.parse(fs.readFileSync(resumedLspObservationPath, "utf8"));
  const resumedLspDescendantObservation = JSON.parse(fs.readFileSync(resumedLspDescendantObservationPath, "utf8"));
  assert.notEqual(resumedLspObservation.pid, lspObservation.pid, "resume reused the fresh LSP PID");
  assert.notEqual(resumedLspDescendantObservation.pid, lspDescendantObservation.pid, "resume reused the fresh LSP descendant PID");
  assert.equal(processGroupExists(resumedLspObservation.pid), true, "resumed LSP PID was not observed running");
  assert.equal(processExists(resumedLspDescendantObservation.pid), true, "resumed LSP descendant was not observed running");
  registerProcessGroup(resumedLspObservation.pid);
  registerProcess(resumedLspDescendantObservation.pid);
  await closeSession(resumed);
  await assertGroupGone(resumedLspObservation.pid);
  await assertProcessGone(resumedLspDescendantObservation.pid);
  const resumedLspObservationArchive = path.join(cwd, ".task-4-9-server-observation.resumed.json");
  const resumedLspDescendantObservationArchive = path.join(cwd, ".task-4-9-descendant-observation.resumed.json");
  fs.renameSync(resumedLspObservationPath, resumedLspObservationArchive);
  fs.renameSync(resumedLspDescendantObservationPath, resumedLspDescendantObservationArchive);
  activeFixtures = [];

  const timestampContextSnapshots = contextSnapshots.filter(({ messages }) => /pi-stamp|\d{2}:\d{2}:\d{2}/.test(messages));
  const report = {
    extensionOrder: manifest.extensionOrder,
    normalTools,
    registeredTools,
    planTools,
    reviewTools: reviewToolsSnapshot,
    planDeniedTools,
    planState,
    planCompletion: planCompletionState,
    planApproval: planApprovalState,
    resumedPlanState,
    resumedPlanTools,
    resumedRestoredTools,
    resumedUnavailableName,
    timestampInitial: initialTimestamps,
    timestampInitialPersisted: initialTimestampPersisted,
    timestampInitialRendered: initialTimestampRendered,
    timestampResumed: resumedTimestamps,
    timestampResumedPersisted: resumedTimestampPersisted,
    timestampResumedRendered: resumedTimestampRendered,
    modelContextSnapshotCount: contextSnapshots.length,
    timestampContextSnapshotCount: timestampContextSnapshots.length,
    timestampContextPolluted: contextHasTimestamp(resumed, contextSnapshots),
    questionCancelled,
    bashTimedOut: timeoutResult.result.isError && /Command timed out/.test(resultText(timeoutResult.result)),
    backgroundPipeCompleted,
    ptyStopped,
    ptyGroupLeaked: processGroupExists(ptyPgid),
    timeoutDescendant: timeoutObservation,
    timeoutDescendantCleanup,
    timeoutDescendantContinued,
    lspReady,
    refactorPreviewWrote,
    refactorApplyWrote,
    refactorApplyBlockedInPlan,
    refactorApplyBlockedInReview,
    lspGroupsLeaked: processGroupExists(lspObservation.pid) || processGroupExists(resumedLspObservation.pid),
    lspDescendantsLeaked: processExists(lspDescendantObservation.pid)
      || processExists(resumedLspDescendantObservation.pid),
    unexpectedMutationExecutions,
    extensionErrors: [...initial.extensionErrors, ...resumed.extensionErrors],
    toolCollision: new Set(registeredTools).size !== registeredTools.length,
  };
  fs.writeSync(process.stdout.fd, `${JSON.stringify(report)}\n`);
}

async function waitUntilGone(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (predicate()) {
      stableSamples = 0;
    } else {
      stableSamples += 1;
      if (stableSamples >= 3) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function forceKillGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return { alreadyGone: true };
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { sent: true };
}

function forceKillProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return { alreadyGone: true };
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { sent: true };
}

async function cleanupOwnedProcesses() {
  const groups = [...ownedProcessGroups];
  const processes = [...ownedProcesses];
  const groupSignals = groups.map((pgid) => ({ pgid, ...forceKillGroup(pgid) }));
  const processSignals = processes.map((pid) => ({ pid, ...forceKillProcess(pid) }));
  const groupResults = await Promise.all(groups.map(async (pgid, index) => ({
    ...groupSignals[index],
    gone: await waitUntilGone(() => processGroupExists(pgid)),
  })));
  const processResults = await Promise.all(processes.map(async (pid, index) => ({
    ...processSignals[index],
    gone: await waitUntilGone(() => processExists(pid)),
  })));
  return {
    ok: groupResults.every(({ gone, error }) => gone && !error)
      && processResults.every(({ gone, error }) => gone && !error),
    groups: groupResults,
    processes: processResults,
  };
}

async function cleanupAll() {
  const sessionResults = [];
  for (const fixture of [...activeFixtures].reverse()) {
    try {
      await closeSession(fixture);
      sessionResults.push({ sessionFile: fixture.sessionFile, ok: true });
    } catch (error) {
      sessionResults.push({
        sessionFile: fixture.sessionFile,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        fixture.session.dispose();
      } catch {
        sessionResults.at(-1).disposeError = true;
      }
    }
  }
  const processCleanup = await cleanupOwnedProcesses();
  if (originalFetch) globalThis.fetch = originalFetch;
  let rootRemoved = true;
  let rootRemovalError;
  if (root) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rootRemoved = false;
      rootRemovalError = error instanceof Error ? error.message : String(error);
    }
  }
  const cleanup = {
    ok: sessionResults.every(({ ok }) => ok) && processCleanup.ok && rootRemoved,
    sessions: sessionResults,
    processes: processCleanup,
    rootRemoved,
    rootRemovalError,
  };
  persistCleanupState({ phase: "cleaned", probeCleanup: cleanup });
  return cleanup;
}

async function runFailureProbe(mode) {
  if (mode === "fast" || mode === "timeout") {
    const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    registerProcessGroup(child.pid);
    registerProcess(child.pid);
    if (mode === "fast") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeSync(process.stdout.fd, `${JSON.stringify({ mode, registeredPid: child.pid })}\n`);
      return;
    }
    await new Promise(() => {});
  }
  throw new Error(`unknown failure probe mode: ${mode}`);
}

try {
  await setup();
  const failureProbeMode = process.env.PI_AGENT_INTERACTIVE_PROBE_MODE;
  if (failureProbeMode) await runFailureProbe(failureProbeMode);
  else await runIntegration();
} finally {
  await cleanupAll();
}
