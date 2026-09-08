import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [piRoot, extensionRoot, mcpPortValue, fakePiFixture] = process.argv.slice(2);
if (!piRoot || !extensionRoot || !mcpPortValue || !fakePiFixture) {
  throw new Error("usage: runtime-probe PI_ROOT EXTENSION_ROOT MCP_PORT FAKE_PI_FIXTURE");
}
const mcpPort = Number(mcpPortValue);
if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535) {
  throw new Error("MCP_PORT must be a valid TCP port");
}

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-plan-integration-"));
const cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
const sessionsDir = path.join(root, "sessions");
const subagentLaunchDir = path.join(root, "subagent-launches");
const fakePiPackage = path.join(root, "fake-pi");
const fakePiCli = path.join(fakePiPackage, "bin/pi.mjs");
const effectsDir = path.join(root, "effects");
for (const directory of [
  cwd,
  agentDir,
  sessionsDir,
  subagentLaunchDir,
  path.dirname(fakePiCli),
  effectsDir,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
fs.writeFileSync(
  path.join(agentDir, "auth.json"),
  `${JSON.stringify({ anthropic: { type: "api_key", key: "task-4-13-model-stub" } })}\n`,
  { mode: 0o600 },
);
fs.writeFileSync(path.join(fakePiPackage, "package.json"), JSON.stringify({
  name: "@earendil-works/pi-coding-agent",
  type: "module",
  bin: { pi: "bin/pi.mjs" },
}));
fs.copyFileSync(fakePiFixture, fakePiCli);
fs.chmodSync(fakePiCli, 0o755);

const effectPaths = Object.freeze({
  bash: path.join(effectsDir, "bash"),
  background: path.join(effectsDir, "background"),
  refactor: path.join(effectsDir, "refactor.ts"),
  write: path.join(effectsDir, "write"),
});
const refactorSource = "export const task413Original = true;\n";
fs.writeFileSync(effectPaths.refactor, refactorSource);

const environmentValues = {
  HOME: path.join(root, "home"),
  LANG: "C",
  LC_ALL: "C",
  LC_CTYPE: "C",
  NO_COLOR: "1",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  SHELL: process.env.SHELL ?? "/bin/zsh",
  TERM: "xterm-256color",
  TMPDIR: path.join(root, "tmp"),
  USER: "task-4-13",
  XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  XDG_DATA_HOME: path.join(root, "xdg-data"),
  XDG_STATE_HOME: path.join(root, "xdg-state"),
};
for (const directory of Object.values(environmentValues).filter((value) => value.startsWith(root))) {
  fs.mkdirSync(directory, { recursive: true });
}

const bootstrap = {
  schemaVersion: 1,
  mode: "personal",
  redactExact: Object.freeze((value) => value),
};
Object.defineProperty(bootstrap, "toJSON", {
  configurable: false,
  enumerable: false,
  value: Object.freeze(() => { throw new Error("Pi runtime bootstrap is not serializable"); }),
  writable: false,
});
Object.freeze(bootstrap);
Object.defineProperty(globalThis, Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1"), {
  configurable: false,
  enumerable: false,
  value: bootstrap,
  writable: false,
});

Object.assign(process.env, environmentValues, {
  PI_AGENT_BASH_TIMEOUT_MS: "4100",
  PI_AGENT_LSP_EXECUTABLES: "{}",
  PI_CODING_AGENT_DIR: agentDir,
  PI_SUBAGENT_FIXTURE_LOG_DIR: subagentLaunchDir,
});
delete process.env.PI_SUBAGENT_PI_BINARY;
process.argv[1] = fakePiCli;

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : input;
  const url = new URL(source);
  if (url.hostname === "127.0.0.1" && url.port === "8080") url.port = String(mcpPort);
  if (input instanceof Request) return originalFetch(new Request(url, input), init);
  return originalFetch(input instanceof URL ? url : url.href, init);
};

const nodeModules = path.join(piRoot, "lib/node_modules");
const codingAgent = await import(pathToFileURL(
  path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js"),
));
const ai = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js")));
const streams = await import(pathToFileURL(
  path.join(nodeModules, "@earendil-works/pi-ai/utils/event-stream.js"),
));
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "share/pi-agent/extensions.json"), "utf8"),
);
const loaderPath = path.join(extensionRoot, manifest.loader.entryPath);
const model = ai.getModel("anthropic", "claude-sonnet-4-5");
assert.ok(model, "reviewed Pi model fixture is unavailable");

const allExtensionErrors = [];
const executionAttempts = [];
let toolCallSequence = 0;
let sessionSequence = 0;

function createUi() {
  const notifications = [];
  const statuses = new Map();
  const widgets = new Map();
  return {
    notifications,
    statuses,
    widgets,
    context: {
      async select() { return undefined; },
      async confirm() { return false; },
      async input() { return undefined; },
      async editor() { return undefined; },
      async custom() { return undefined; },
      notify(message, type = "info") { notifications.push({ message, type }); },
      onTerminalInput() { return () => {}; },
      setStatus(key, value) { statuses.set(key, value); },
      setWidget(key, value) { widgets.set(key, value); },
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

function assistantMessage(activeModel, response, sequence) {
  return {
    role: "assistant",
    content: response.type === "tool"
      ? [{
          type: "toolCall",
          id: `task-4-13-model-call-${sequence}`,
          name: response.name,
          arguments: response.arguments,
        }]
      : [{ type: "text", text: response.text }],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response.type === "tool" ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function setResponses(fixture, responses, snapshots = []) {
  let index = 0;
  fixture.session.agent.streamFunction = (activeModel, context) => {
    snapshots.push(context.tools.map(({ name }) => name));
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const message = assistantMessage(activeModel, response, index);
    const stream = streams.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  return snapshots;
}

async function createSession({ sessionFile, reason, id } = {}) {
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
  assert.deepEqual(resourceLoader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(resourceLoader.getPrompts(), { prompts: [], diagnostics: [] });

  const modelRuntime = await codingAgent.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const sessionManager = sessionFile
    ? codingAgent.SessionManager.open(sessionFile, sessionsDir, cwd)
    : codingAgent.SessionManager.create(cwd, sessionsDir, {
        id: id ?? `task-4-13-${++sessionSequence}`,
      });
  const created = await codingAgent.createAgentSession({
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
    onError(error) {
      extensionErrors.push({
        error: error.error,
        event: error.event,
        extensionPath: error.extensionPath,
      });
    },
  });
  setResponses(created, [{ type: "text", text: "task 4.13 fixture response" }]);
  return {
    ...created,
    extensionErrors,
    resourceLoader,
    sessionFile: created.session.sessionFile,
    ui,
  };
}

async function closeSession(fixture, appendedState) {
  await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  if (appendedState !== undefined) {
    fixture.session.sessionManager.appendCustomEntry("plan-mode-state", appendedState);
  }
  allExtensionErrors.push(...fixture.extensionErrors);
  fixture.session.dispose();
}

function planStateEntries(fixture) {
  return fixture.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
    .map((entry) => structuredClone(entry.data));
}

function latestPlanState(fixture) {
  const state = planStateEntries(fixture).at(-1);
  assert.ok(state, "Plan mode did not persist state");
  return state;
}

function diagnostics(fixture) {
  return [
    ...fixture.ui.notifications.map(({ message }) => message),
    ...fixture.extensionErrors.map(({ error }) => error),
  ].join("\n");
}

async function promptWithSnapshot(fixture, prompt) {
  const snapshots = setResponses(
    fixture,
    [{ type: "text", text: `completed: ${prompt}` }],
  );
  await fixture.session.prompt(prompt);
  await fixture.session.waitForIdle();
  assert.equal(snapshots.length, 1, `${prompt} produced an unexpected model call count`);
  return snapshots[0];
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

async function completePlan(fixture, plan) {
  setResponses(fixture, [{
    type: "tool",
    name: "plan_mode_complete",
    arguments: { plan },
  }]);
  await fixture.session.prompt("Complete the assembled-manifest plan");
  await fixture.session.waitForIdle();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function deniedCalls(mode) {
  return [
    {
      toolName: "bash",
      args: { command: `printf denied > ${shellQuote(effectPaths.bash)}` },
    },
    {
      toolName: "write",
      args: { path: effectPaths.write, content: "denied\n" },
    },
    {
      toolName: "bg_start",
      args: {
        name: `task-4-13-${mode}`,
        command: `printf denied > ${shellQuote(effectPaths.background)}`,
      },
    },
    {
      toolName: "subagent",
      args: { agent: "worker", task: `task-4-13-${mode}` },
    },
    {
      toolName: "call_tool_write",
      args: {
        name: "fixture:update_record",
        args: { id: `task-4-13-${mode}` },
        intent_reason: "Task 4.13 denial probe",
        intent_data_sensitivity: "internal",
      },
    },
    {
      toolName: "call_tool_destructive",
      args: {
        name: "fixture:delete_record",
        args: { id: `task-4-13-${mode}` },
        intent_reason: "Task 4.13 denial probe",
        intent_data_sensitivity: "internal",
      },
    },
    {
      toolName: "code_refactor_apply",
      args: { planId: `task-4-13-${mode}-must-not-apply` },
    },
  ];
}

async function probeGuards(fixture, mode, executeOnUnexpectedAllow) {
  const guards = [];
  for (const { toolName, args } of deniedCalls(mode)) {
    const toolCallId = `task-4-13-guard-${++toolCallSequence}`;
    const guard = await fixture.session.agent.beforeToolCall({
      assistantMessage: assistantMessage(model, { type: "text", text: "guard" }, toolCallSequence),
      toolCall: { type: "toolCall", id: toolCallId, name: toolName, arguments: args },
      args,
      context: { messages: [], systemPrompt: "", tools: [] },
    });
    guards.push({
      block: guard?.block === true,
      reason: guard?.reason ?? "",
      toolName,
    });
    if (executeOnUnexpectedAllow && !guard?.block) {
      executionAttempts.push({ mode, toolName });
      const definition = fixture.session.getToolDefinition(toolName);
      assert.ok(definition, `${toolName} was not registered`);
      await definition.execute(
        toolCallId,
        args,
        new AbortController().signal,
        undefined,
        fixture.session.extensionRunner.createContext(),
      ).catch(() => undefined);
    }
  }
  return guards;
}

function probeDenials(fixture, mode) {
  return probeGuards(fixture, mode, true);
}

function probeNormalGuards(fixture, mode) {
  return probeGuards(fixture, mode, false);
}

function latestNotification(fixture, pattern) {
  return fixture.ui.notifications.findLast(({ message }) => pattern.test(message))?.message ?? "";
}

function planSnapshot(fixture, modelTools, denials = undefined) {
  return {
    activeTools: fixture.session.getActiveToolNames(),
    modelTools,
    ...(denials === undefined ? {} : { denials }),
  };
}

let activeFixture;
try {
  const initial = await createSession({ id: "task-4-13-main" });
  activeFixture = initial;
  const sessionFile = initial.sessionFile;
  assert.ok(sessionFile, "main session did not create a session file");
  const registeredTools = initial.session.getAllTools().map(({ name }) => name);
  const normalTools = initial.session.getActiveToolNames();
  const normalModelTools = await promptWithSnapshot(initial, "Capture normal managed tools");
  const normal = planSnapshot(initial, normalModelTools);

  await initial.session.prompt("/plan start");
  const planModelTools = await promptWithSnapshot(initial, "Inspect without mutation");
  const planDenials = await probeDenials(initial, "plan");
  const plan = planSnapshot(initial, planModelTools, planDenials);
  assert.equal(latestPlanState(initial).phase, "planning");
  await closeSession(initial);
  activeFixture = undefined;

  const planning = await createSession({ sessionFile, reason: "resume" });
  activeFixture = planning;
  assert.equal(latestPlanState(planning).phase, "planning");
  const resumedPlanModelTools = await promptWithSnapshot(planning, "Continue resumed Plan discovery");
  const resumedPlanDenials = await probeDenials(planning, "resumed-plan");
  const resumedPlanning = planSnapshot(planning, resumedPlanModelTools, resumedPlanDenials);
  const completedPlan = "1. Inspect the assembled manifest\n2. Implement only after approval";
  await completePlan(planning, completedPlan);
  const completedState = latestPlanState(planning);
  const completionResult = planning.session.sessionManager
    .getBranch()
    .findLast((entry) => (
      entry.message?.role === "toolResult" && entry.message.toolName === "plan_mode_complete"
    ));
  const completion = {
    activeTools: planning.session.getActiveToolNames(),
    notification: latestNotification(planning, /ready for approval/i),
    phase: completedState.phase,
    presentation: JSON.stringify(completionResult?.message ?? null),
  };
  await closeSession(planning);
  activeFixture = undefined;

  const awaiting = await createSession({ sessionFile, reason: "resume" });
  activeFixture = awaiting;
  const resumedAwaitingApproval = {
    activeTools: awaiting.session.getActiveToolNames(),
    phase: latestPlanState(awaiting).phase,
  };
  const approvalModelSnapshots = setResponses(
    awaiting,
    [{ type: "text", text: "approved implementation handoff" }],
  );
  await awaiting.session.prompt("/plan implement");
  await waitFor(() => approvalModelSnapshots.length > 0, "approved implementation handoff");
  await awaiting.session.waitForIdle();
  assert.equal(approvalModelSnapshots.length, 1);
  const approval = {
    activeTools: awaiting.session.getActiveToolNames(),
    modelTools: approvalModelSnapshots[0],
    phase: latestPlanState(awaiting).phase,
  };
  await closeSession(awaiting);
  activeFixture = undefined;

  const approved = await createSession({ sessionFile, reason: "resume" });
  activeFixture = approved;
  const resumedApprovedModelTools = await promptWithSnapshot(approved, "Capture resumed approved tools");
  const resumedApproved = {
    activeTools: approved.session.getActiveToolNames(),
    modelTools: resumedApprovedModelTools,
    phase: latestPlanState(approved).phase,
  };
  await approved.session.prompt("/plan start");
  await approved.session.prompt("/plan exit");
  const explicitExit = {
    activeTools: approved.session.getActiveToolNames(),
    notification: latestNotification(approved, /Plan mode disabled/i),
    phase: latestPlanState(approved).phase,
  };
  await approved.session.prompt("/plan start");
  await approved.session.prompt("/plan cancel");
  const cancellation = {
    activeTools: approved.session.getActiveToolNames(),
    notification: latestNotification(approved, /Plan mode cancelled/i),
    phase: latestPlanState(approved).phase,
  };
  await closeSession(approved);
  activeFixture = undefined;

  const normalResume = await createSession({ sessionFile, reason: "resume" });
  activeFixture = normalResume;
  const resumedNormalModelTools = await promptWithSnapshot(normalResume, "Capture resumed normal tools");
  const resumedNormal = {
    activeTools: normalResume.session.getActiveToolNames(),
    modelTools: resumedNormalModelTools,
    phase: latestPlanState(normalResume).phase,
  };
  await closeSession(normalResume, {
    phase: "planning",
    capturedToolNames: [...normalTools, "task_4_13_unavailable_tool"],
  });
  activeFixture = undefined;

  const unavailable = await createSession({ sessionFile, reason: "resume" });
  activeFixture = unavailable;
  assert.equal(latestPlanState(unavailable).phase, "planning");
  await unavailable.session.prompt("/plan exit");
  const unavailableRestoration = {
    activeTools: unavailable.session.getActiveToolNames(),
    notification: latestNotification(unavailable, /unavailable/i),
    phase: latestPlanState(unavailable).phase,
  };
  await closeSession(unavailable, {
    phase: "planning",
    capturedToolNames: ["read", "read"],
  });
  activeFixture = undefined;

  const invalid = await createSession({ sessionFile, reason: "resume" });
  activeFixture = invalid;
  const invalidModelTools = await promptWithSnapshot(invalid, "Capture invalid-state fallback tools");
  const invalidGuards = await probeNormalGuards(invalid, "invalid-fallback");
  const invalidFallback = {
    activeTools: invalid.session.getActiveToolNames(),
    guards: invalidGuards,
    modelTools: invalidModelTools,
    notification: latestNotification(invalid, /not restored/i),
    phase: latestPlanState(invalid).phase,
  };
  await closeSession(invalid);
  activeFixture = undefined;

  const missingManager = codingAgent.SessionManager.create(cwd, sessionsDir, {
    id: "task-4-13-missing-state",
  });
  const missingSessionFile = missingManager.getSessionFile();
  assert.ok(missingSessionFile, "missing-state fixture did not create a session file");
  const missing = await createSession({ sessionFile: missingSessionFile, reason: "resume" });
  activeFixture = missing;
  const missingModelTools = await promptWithSnapshot(missing, "Capture missing-state fallback tools");
  const missingGuards = await probeNormalGuards(missing, "missing-fallback");
  const missingFallback = {
    activeTools: missing.session.getActiveToolNames(),
    guards: missingGuards,
    modelTools: missingModelTools,
    notification: latestNotification(missing, /not restored/i),
    phase: latestPlanState(missing).phase,
  };
  await closeSession(missing);
  activeFixture = undefined;

  const effects = {
    executionAttempts,
    files: Object.entries(effectPaths)
      .filter(([name, file]) => name !== "refactor" && fs.existsSync(file))
      .map(([name]) => name),
    refactorUnchanged: fs.readFileSync(effectPaths.refactor, "utf8") === refactorSource,
    subagentLaunches: fs.readdirSync(subagentLaunchDir).sort(),
  };
  const report = {
    approval,
    cancellation,
    completion,
    effects,
    explicitExit,
    extensionErrors: allExtensionErrors,
    extensionOrder: manifest.extensionOrder,
    invalidFallback,
    missingFallback,
    normal,
    plan,
    registeredTools,
    resumedApproved,
    resumedAwaitingApproval,
    resumedNormal,
    resumedPlanning,
    unavailableRestoration,
  };
  fs.writeSync(process.stdout.fd, `${JSON.stringify(report)}\n`);
} finally {
  if (activeFixture) {
    await closeSession(activeFixture).catch(() => activeFixture.session.dispose());
  }
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
