import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const task36LoaderProbePath = path.join(
  testsDir,
  "fixtures/cavemem-bridge/loader-probe.mjs",
);
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 900_000,
};

let runtimePaths;
let runtimeModules;
let bridgeModule;
let task36ToolCallSequence = 0;

const task36Token = "task36-shopify-token-sentinel-0123456789";
const task36LaunchId = "12345678-1234-4abc-8def-1234567890ab";
const task36Redacted = "[REDACTED]";
const task36BootstrapSymbol = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-cavemem-bridge-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      lifecycleRuntime = pkgs.buildEnv {
        name = "pi-agent-cavemem-bridge-runtime";
        paths = [ pkgs.cavemem pkgs.nodejs pkgs.sqlite ];
      };
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
        filteredFlakeExpression("[ pkgs.pi-agent pkgs.pi-agent-extensions lifecycleRuntime ]"),
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
    lifecycle: outputs.find((output) => fs.existsSync(path.join(output, "bin/cavemem"))),
  };
  for (const [name, output] of Object.entries(runtimePaths)) {
    assert.match(output ?? "", /^\/nix\/store\//, `missing ${name} runtime`);
  }
  return runtimePaths;
}

async function loadRuntimeModules() {
  if (runtimeModules) return runtimeModules;
  const { pi } = buildRuntimePaths();
  const nodeModules = path.join(pi, "lib/node_modules");
  const codingAgent = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js")),
  );
  const ai = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js")),
  );
  const streams = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/utils/event-stream.js")),
  );
  const typebox = await import(pathToFileURL(path.join(nodeModules, "typebox/build/index.mjs")));
  runtimeModules = { ...codingAgent, ...ai, ...streams, ...typebox };
  return runtimeModules;
}

async function loadBridgeModule() {
  if (bridgeModule) return bridgeModule;
  const { extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const entry = manifest.extensions.cavemem;
  assert.deepEqual(entry, {
    version: "0.1.0",
    entryPath: "lib/pi-agent/extensions/cavemem/index.ts",
    license: "MIT",
  });
  bridgeModule = await import(pathToFileURL(path.join(extensions, entry.entryPath)));
  return bridgeModule;
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

function assistantMessage(model, content, stopReason = "stop") {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
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
    stopReason,
    timestamp: Date.now(),
  };
}

async function createSession({
  root,
  id = "task35-lifecycle-session",
  extensionFactories,
  extensionPath,
  assistantTexts = ["task35assistantdefault"],
} = {}) {
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createAssistantMessageEventStream,
    getModel,
  } = await loadRuntimeModules();
  const fixtureRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-bridge-"));
  const cwd = path.join(fixtureRoot, "workspace");
  const agentDir = path.join(fixtureRoot, "agent");
  const sessionsDir = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.ANTHROPIC_API_KEY = "cavemem-bridge-test-key";

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPath ? [extensionPath] : [],
    extensionFactories: extensionFactories ?? [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "reviewed Pi model fixture is unavailable");
  const sessionManager = SessionManager.create(cwd, sessionsDir, { id });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
  const ui = createUi();
  const extensionErrors = [];
  await session.bindExtensions({
    uiContext: ui.context,
    mode: "tui",
    onError(error) { extensionErrors.push(error); },
  });

  let turn = 0;
  session.agent.streamFunction = (activeModel) => {
    const text = assistantTexts[Math.min(turn, assistantTexts.length - 1)];
    turn += 1;
    const message = assistantMessage(activeModel, text);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  return {
    root: fixtureRoot,
    cwd,
    session,
    ui,
    extensionErrors,
    createAssistantMessageEventStream,
  };
}

async function executeTask36Tool(fixture, toolName, input, idLabel) {
  task36ToolCallSequence += 1;
  const toolCallId = `${idLabel}-${task36ToolCallSequence}`;
  let responseIndex = 0;
  fixture.session.agent.streamFunction = (model) => {
    const message = responseIndex++ === 0
      ? assistantMessage(
        model,
        [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input }],
        "toolUse",
      )
      : assistantMessage(model, "task36 fixture complete");
    const stream = fixture.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  await fixture.session.prompt(`Run Task 3.6 fixture ${toolCallId}`);
  await fixture.session.waitForIdle();
  const result = fixture.session.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
    )?.message;
  assert.ok(result, `missing ${toolName} result for ${toolCallId}`);
  return { result, toolCallId };
}

function installTask36RuntimeBootstrap() {
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, task36BootstrapSymbol), undefined);
  const values = [task36Token, task36LaunchId].sort((left, right) => right.length - left.length);
  const redactExact = Object.freeze((value) => {
    assert.equal(typeof value, "string");
    let redacted = value;
    for (const exact of values) redacted = redacted.split(exact).join(task36Redacted);
    return redacted;
  });
  const runtime = { schemaVersion: 1, mode: "shopify-gateway", redactExact };
  Object.defineProperty(runtime, "toJSON", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(() => { throw new Error("Pi runtime bootstrap is not serializable"); }),
    writable: false,
  });
  Object.freeze(runtime);
  Object.defineProperty(globalThis, task36BootstrapSymbol, {
    configurable: false,
    enumerable: false,
    value: runtime,
    writable: false,
  });
  return runtime;
}

const task36RuntimeBootstrap = installTask36RuntimeBootstrap();

function bindTask36Bridge(factory, cwd) {
  const handlers = new Map();
  factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const notifications = [];
  return {
    handlers,
    notifications,
    context: {
      cwd,
      sessionManager: { getSessionId() { return "task36-direct-session"; } },
      ui: { notify(message, type) { notifications.push({ message, type }); } },
    },
  };
}

function queryRows(dataDir, sql) {
  const { lifecycle } = buildRuntimePaths();
  const result = childProcess.spawnSync(
    path.join(lifecycle, "bin/sqlite3"),
    ["-json", path.join(dataDir, "data.db"), sql],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

function search(dataDir, marker) {
  const { lifecycle } = buildRuntimePaths();
  return childProcess.spawnSync(
    path.join(lifecycle, "bin/cavemem"),
    ["search", marker, "--no-semantic"],
    {
      encoding: "utf8",
      env: { ...process.env, CAVEMEM_DATA_DIR: dataDir, CAVEMEM_NO_AUTOSTART: "1", NO_COLOR: "1" },
    },
  );
}

async function waitFor(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function writeExecutable(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function forceCleanupProcesses(pids) {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await waitFor(
    () => pids.every((pid) => !Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)),
    "fixture processes to exit",
    400,
  );
}

test("production bridge captures Pi lifecycle into the shared searchable Cavemem store", { timeout: 900_000 }, async () => {
  const runtime = buildRuntimePaths();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-lifecycle-"));
  const dataDir = path.join(root, "cavemem");
  fs.mkdirSync(dataDir, { recursive: true });
  const previous = {
    dataDir: process.env.CAVEMEM_DATA_DIR,
    noAutostart: process.env.CAVEMEM_NO_AUTOSTART,
    noColor: process.env.NO_COLOR,
    forceColor: process.env.FORCE_COLOR,
  };
  process.env.CAVEMEM_DATA_DIR = dataDir;
  process.env.CAVEMEM_NO_AUTOSTART = "1";
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;

  let fixture;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtime.extensions, "share/pi-agent/extensions.json"), "utf8"),
    );
    const extensionPath = path.join(runtime.extensions, manifest.extensions.cavemem.entryPath);
    fixture = await createSession({
      root,
      extensionPath,
      assistantTexts: ["task35assistantalpha", "task35assistantbeta"],
    });
    await fixture.session.prompt("task35promptalpha");
    await fixture.session.extensionRunner.emitInput("   ", undefined, "interactive");
    await fixture.session.reload();

    const afterReload = queryRows(
      dataDir,
      "SELECT id, ide, cwd, ended_at FROM sessions ORDER BY id",
    );
    assert.deepEqual(afterReload, [{
      id: "task35-lifecycle-session",
      ide: "pi",
      cwd: fixture.cwd,
      ended_at: null,
    }]);

    await fixture.session.prompt("task35promptbeta");
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
    fixture = undefined;

    assert.deepEqual(
      queryRows(
        dataDir,
        "SELECT session_id, kind, content FROM observations ORDER BY id",
      ),
      [
        { session_id: "task35-lifecycle-session", kind: "user_prompt", content: "task35promptalpha" },
        { session_id: "task35-lifecycle-session", kind: "user_prompt", content: "task35promptbeta" },
      ],
    );
    const summaries = queryRows(
      dataDir,
      "SELECT session_id, scope, content FROM summaries WHERE scope = 'turn' ORDER BY id",
    );
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].session_id, "task35-lifecycle-session");
    assert.equal(summaries[1].session_id, "task35-lifecycle-session");
    assert.match(summaries[0].content, /task35assistantalpha/);
    assert.match(summaries[1].content, /task35assistantbeta/);
    const ended = queryRows(
      dataDir,
      "SELECT id, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id",
    );
    assert.deepEqual(ended, [{ id: "task35-lifecycle-session", ended: 1 }]);

    for (const marker of ["task35promptalpha", "task35promptbeta"]) {
      const result = search(dataDir, marker);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(marker));
      assert.match(result.stdout, /task35-lifecycle-session/);
    }
  } finally {
    if (fixture) {
      fixture.session.dispose();
    }
    for (const [name, value] of [
      ["CAVEMEM_DATA_DIR", previous.dataDir],
      ["CAVEMEM_NO_AUTOSTART", previous.noAutostart],
      ["NO_COLOR", previous.noColor],
      ["FORCE_COLOR", previous.forceColor],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi handlers await one FIFO and use compaction and reload as flush barriers", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  let release;
  let blocked = false;
  const gate = () => new Promise((resolve) => { release = resolve; });
  let activeGate;
  const runHook = async (request) => {
    calls.push(`start:${request.name}`);
    if (blocked && request.name === "user-prompt-submit") await activeGate;
    calls.push(`end:${request.name}`);
  };
  const fixture = await createSession({
    extensionFactories: [{ name: "cavemem-fifo", factory: createCavememBridge({ runHook }) }],
  });
  try {
    assert.deepEqual(calls.map((entry) => entry.replace(/^(?:start|end):/, "")), [
      "session-start",
      "session-start",
    ]);
    calls.length = 0;
    blocked = true;
    activeGate = gate();
    let inputSettled = false;
    let turnSettled = false;
    let compactSettled = false;
    const input = fixture.session.extensionRunner
      .emitInput("task35fifo", undefined, "interactive")
      .finally(() => { inputSettled = true; });
    await waitFor(() => calls.includes("start:user-prompt-submit"), "prompt hook did not start");
    const turn = fixture.session.extensionRunner
      .emit({
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "task35fifostop" }] },
        toolResults: [],
      })
      .finally(() => { turnSettled = true; });
    const compact = fixture.session.extensionRunner
      .emit({ type: "session_before_compact" })
      .finally(() => { compactSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["start:user-prompt-submit"]);
    assert.deepEqual({ inputSettled, turnSettled, compactSettled }, {
      inputSettled: false,
      turnSettled: false,
      compactSettled: false,
    });
    release();
    await Promise.all([input, turn, compact]);
    assert.deepEqual(calls, [
      "start:user-prompt-submit",
      "end:user-prompt-submit",
      "start:stop",
      "end:stop",
    ]);

    calls.length = 0;
    activeGate = gate();
    let reloadSettled = false;
    const active = fixture.session.extensionRunner.emitInput("task35reload", undefined, "interactive");
    await waitFor(() => calls.includes("start:user-prompt-submit"), "reload prompt did not start");
    const reload = fixture.session.extensionRunner
      .emit({ type: "session_shutdown", reason: "reload" })
      .finally(() => { reloadSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reloadSettled, false);
    assert.deepEqual(calls, ["start:user-prompt-submit"]);
    release();
    await Promise.all([active, reload]);
    assert.equal(calls.some((entry) => entry.endsWith("session-end")), false);

    blocked = false;
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(calls.slice(-2), ["start:session-end", "end:session-end"]);
  } finally {
    fixture.session.dispose();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("lifecycle capture uses the process bootstrap synchronously without mutating Pi events", async () => {
  const { extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const bridgeUrl = pathToFileURL(
    path.join(extensions, manifest.extensions.cavemem.entryPath),
  );
  bridgeUrl.search = "task36-lifecycle-redaction";
  const { createCavememBridge } = await import(bridgeUrl.href);
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-lifecycle-workspace",
  );
  const inputHandler = bridge.handlers.get("input");
  const turnHandler = bridge.handlers.get("turn_end");
  assert.equal(typeof inputHandler, "function");
  assert.equal(typeof turnHandler, "function");

  const registeredInput = {
    type: "input",
    text: `prompt prefix-${task36Token}-middle-${task36LaunchId}-suffix`,
    source: "interactive",
  };
  const registeredTurn = {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage(
      { api: "anthropic-messages", provider: "anthropic", id: "task36-model" },
      `stop prefix-${task36LaunchId}-middle-${task36Token}-suffix`,
    ),
    toolResults: [],
  };
  const originalInput = structuredClone(registeredInput);
  const originalTurn = structuredClone(registeredTurn);
  await inputHandler(registeredInput, bridge.context);
  await turnHandler(registeredTurn, bridge.context);

  assert.equal(
    calls[0].payload.prompt,
    `prompt prefix-${task36Redacted}-middle-${task36Redacted}-suffix`,
  );
  assert.equal(
    calls[1].payload.last_assistant_message,
    `stop prefix-${task36Redacted}-middle-${task36Redacted}-suffix`,
  );
  assert.deepEqual(registeredInput, originalInput);
  assert.deepEqual(registeredTurn, originalTurn);
  assert.equal(JSON.stringify(calls).includes(task36Token), false);
  assert.equal(JSON.stringify(calls).includes(task36LaunchId), false);
  assert.deepEqual(bridge.notifications, []);
});

test("fresh bridge factories retain the immutable process capability", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const callsA = [];
  const callsB = [];
  const factoryA = createCavememBridge({ runHook: async (request) => { callsA.push(request); } });
  const factoryB = createCavememBridge({ runHook: async (request) => { callsB.push(request); } });

  const bridgeA = bindTask36Bridge(factoryA, "/task36-bootstrap-a");
  await bridgeA.handlers.get("input")({
    type: "input",
    text: `generation-a-before-${task36Token}-${task36LaunchId}`,
    source: "interactive",
  }, bridgeA.context);
  await bridgeA.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, bridgeA.context);
  const bridgeB = bindTask36Bridge(factoryB, "/task36-bootstrap-b");
  await bridgeB.handlers.get("input")({
    type: "input",
    text: `generation-b-${task36Token}-${task36LaunchId}`,
    source: "interactive",
  }, bridgeB.context);

  assert.equal(callsA[0].payload.prompt, `generation-a-before-${task36Redacted}-${task36Redacted}`);
  assert.equal(callsB[0].payload.prompt, `generation-b-${task36Redacted}-${task36Redacted}`);
  assert.equal(JSON.stringify({ callsA, callsB }).includes(task36Token), false);
  assert.equal(JSON.stringify({ callsA, callsB }).includes(task36LaunchId), false);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, task36BootstrapSymbol).value, task36RuntimeBootstrap);
  assert.deepEqual(bridgeA.notifications, []);
  assert.deepEqual(bridgeB.notifications, []);
});

test("duplicate and interleaved terminal events produce one observation per tool call", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-terminal-workspace",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const endHandler = bridge.handlers.get("tool_execution_end");
  for (const handler of [startHandler, callHandler, resultHandler, endHandler]) {
    assert.equal(typeof handler, "function");
  }

  const inputA = { marker: "task36-terminal-a" };
  const inputB = { marker: "task36-terminal-b" };
  const inputC = { marker: "task36-terminal-c" };
  for (const [toolCallId, input] of [
    ["task36-terminal-a", inputA],
    ["task36-terminal-b", inputB],
    ["task36-terminal-c", inputC],
  ]) {
    startHandler({
      type: "tool_execution_start",
      toolCallId,
      toolName: "task36_probe",
      args: input,
    }, bridge.context);
    callHandler({
      type: "tool_call",
      toolCallId,
      toolName: "task36_probe",
      input,
    }, bridge.context);
  }

  const resultEvent = (toolCallId, input) => ({
    type: "tool_result",
    toolCallId,
    toolName: "task36_probe",
    input,
    content: [{ type: "text", text: `result-${input.marker}` }],
    details: { source: "result" },
    isError: false,
  });
  const endEvent = (toolCallId) => ({
    type: "tool_execution_end",
    toolCallId,
    toolName: "task36_probe",
    result: {
      content: [{ type: "text", text: `fallback-${toolCallId}` }],
      details: { source: "fallback" },
    },
    isError: true,
  });
  const resultA = resultEvent("task36-terminal-a", inputA);
  const resultB = resultEvent("task36-terminal-b", inputB);
  const resultC = resultEvent("task36-terminal-c", inputC);
  const inputD = { marker: "task36-terminal-result-before-start" };
  const resultD = resultEvent("task36-terminal-d", inputD);
  const endA = endEvent("task36-terminal-a");
  const endB = endEvent("task36-terminal-b");
  const endC = endEvent("task36-terminal-c");
  const endD = endEvent("task36-terminal-d");

  const pendingResultA = resultHandler(resultA, bridge.context);
  startHandler({
    type: "tool_execution_start",
    toolCallId: "task36-terminal-a",
    toolName: "task36_probe",
    args: { marker: "task36-duplicate-start" },
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: "task36-terminal-a",
    toolName: "task36_probe",
    input: { marker: "task36-duplicate-call" },
  }, bridge.context);
  await Promise.all([
    pendingResultA,
    endHandler(endB, bridge.context),
    resultHandler(structuredClone(resultA), bridge.context),
    endHandler(structuredClone(endB), bridge.context),
    endHandler(endA, bridge.context),
    resultHandler(resultB, bridge.context),
    endHandler(endC, bridge.context),
    endHandler(structuredClone(endC), bridge.context),
    resultHandler(resultD, bridge.context),
    resultHandler(structuredClone(resultD), bridge.context),
    endHandler(endD, bridge.context),
  ]);
  await resultHandler(structuredClone(resultA), bridge.context);
  await endHandler(structuredClone(endA), bridge.context);
  await resultHandler(structuredClone(resultB), bridge.context);
  await endHandler(structuredClone(endB), bridge.context);
  await endHandler(structuredClone(endC), bridge.context);
  await resultHandler(structuredClone(resultC), bridge.context);
  startHandler({
    type: "tool_execution_start",
    toolCallId: resultD.toolCallId,
    toolName: resultD.toolName,
    args: inputD,
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: resultD.toolCallId,
    toolName: resultD.toolName,
    input: inputD,
  }, bridge.context);
  await resultHandler(resultD, bridge.context);

  const fullRequests = calls.filter(({ name }) => name === "post-tool-use");
  assert.equal(fullRequests.length, 4);
  const requestsById = new Map(fullRequests.map(({ payload }) => [payload.toolCallId, payload]));
  assert.deepEqual(requestsById.get("task36-terminal-a").output.details, { source: "result" });
  assert.deepEqual(requestsById.get("task36-terminal-a").input, inputA);
  assert.deepEqual(requestsById.get("task36-terminal-b").output.details, { source: "result" });
  assert.deepEqual(requestsById.get("task36-terminal-c").output.details, { source: "fallback" });
  assert.deepEqual(requestsById.get("task36-terminal-d").output.details, { source: "result" });
  assert.deepEqual(bridge.notifications, []);
});

test("fallback after tool_call keeps validated input and snapshots completion before yielding", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-fallback-snapshot",
  );
  const rawInput = { phase: "raw", marker: task36Token };
  const validatedInput = { phase: "validated", marker: "validated-only" };
  const result = {
    content: [{ type: "text", text: `fallback-${task36LaunchId}` }],
    details: { phase: "before-yield" },
  };
  bridge.handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: "task36-fallback-snapshot",
    toolName: "task36_probe",
    args: rawInput,
  }, bridge.context);
  bridge.handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "task36-fallback-snapshot",
    toolName: "task36_probe",
    input: validatedInput,
  }, bridge.context);
  const pending = bridge.handlers.get("tool_execution_end")({
    type: "tool_execution_end",
    toolCallId: "task36-fallback-snapshot",
    toolName: "task36_probe",
    result,
    isError: true,
  }, bridge.context);
  rawInput.phase = "mutated-after-handler";
  result.content[0].text = "mutated-after-handler";
  result.details.phase = "mutated-after-handler";
  await pending;

  const payload = calls.find(({ name }) => name === "post-tool-use").payload;
  assert.deepEqual(payload.input, { phase: "validated", marker: "validated-only" });
  assert.deepEqual(payload.output.content, [{
    type: "text",
    text: `fallback-${task36Redacted}`,
  }]);
  assert.deepEqual(payload.output.details, { phase: "before-yield" });
  assert.equal(payload.output.isError, true);
  assert.deepEqual(bridge.notifications, []);
});

test("validated phase accepts a result without retaining caller object identity", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-validated-phase",
  );
  const validatedInput = { phase: "validated", marker: task36Token };
  bridge.handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: "task36-validated-phase",
    toolName: "task36_probe",
    args: { phase: "raw" },
  }, bridge.context);
  bridge.handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "task36-validated-phase",
    toolName: "task36_probe",
    input: validatedInput,
  }, bridge.context);
  validatedInput.phase = "mutated-after-tool-call";
  await bridge.handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: "task36-validated-phase",
    toolName: "task36_probe",
    input: { phase: "different-object" },
    content: [{ type: "text", text: "task36 validated result" }],
    details: null,
    isError: false,
  }, bridge.context);

  const payload = calls.find(({ name }) => name === "post-tool-use").payload;
  assert.deepEqual(payload.input, { phase: "validated", marker: task36Redacted });
  assert.deepEqual(payload.output.content, [{ type: "text", text: "task36 validated result" }]);
  assert.deepEqual(bridge.notifications, []);
});

test("a failed terminal write remains idempotent across duplicate start, call, result, and end", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const sensitive = "task36-failed-write-sensitive-stderr";
  let attempts = 0;
  const bridge = bindTask36Bridge(
    createCavememBridge({
      runHook: async (request) => {
        if (request.name !== "post-tool-use") return;
        attempts += 1;
        throw new Error(sensitive);
      },
    }),
    "/task36-failed-terminal-workspace",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const endHandler = bridge.handlers.get("tool_execution_end");
  const input = { marker: "task36-failed-terminal" };
  const result = {
    type: "tool_result",
    toolCallId: "task36-failed-terminal",
    toolName: "task36_probe",
    input,
    content: [{ type: "text", text: "task36 failed terminal result" }],
    details: { source: "result" },
    isError: false,
  };
  const end = {
    type: "tool_execution_end",
    toolCallId: "task36-failed-terminal",
    toolName: "task36_probe",
    result: {
      content: [{ type: "text", text: "task36 failed terminal fallback" }],
      details: { source: "fallback" },
    },
    isError: true,
  };
  startHandler({
    type: "tool_execution_start",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    args: input,
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    input,
  }, bridge.context);
  await assert.rejects(resultHandler(result, bridge.context), /hook=post-tool-use, kind=hook/);

  startHandler({
    type: "tool_execution_start",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    args: structuredClone(input),
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    input: structuredClone(input),
  }, bridge.context);
  const duplicates = await Promise.allSettled([
    resultHandler(structuredClone(result), bridge.context),
    endHandler(structuredClone(end), bridge.context),
  ]);

  assert.deepEqual(duplicates.map(({ status }) => status), ["fulfilled", "fulfilled"]);
  assert.equal(attempts, 1);
  assert.equal(bridge.notifications.length, 1);
  assert.match(bridge.notifications[0].message, /hook=post-tool-use, kind=hook/);
  assert.equal(JSON.stringify(bridge.notifications).includes(sensitive), false);
});

test("bounded terminal eviction supports generation-safe explicit ID reuse", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-high-volume-workspace",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const endHandler = bridge.handlers.get("tool_execution_end");
  const resultEvent = (toolCallId, input, phase) => ({
    type: "tool_result",
    toolCallId,
    toolName: "task36_probe",
    input,
    content: [{ type: "text", text: `${phase}-${input.marker}` }],
    details: { phase },
    isError: false,
  });
  const begin = (toolCallId, input) => {
    startHandler({
      type: "tool_execution_start",
      toolCallId,
      toolName: "task36_probe",
      args: input,
    }, bridge.context);
    callHandler({
      type: "tool_call",
      toolCallId,
      toolName: "task36_probe",
      input,
    }, bridge.context);
  };
  let firstResult;
  let latestResult;
  for (let index = 0; index < 256; index += 1) {
    const input = { marker: `task36-high-volume-${index}` };
    const result = resultEvent(`task36-high-volume-${index}`, input, "initial");
    if (index === 0) firstResult = result;
    latestResult = result;
    begin(result.toolCallId, input);
    await resultHandler(result, bridge.context);
  }
  assert.equal(calls.filter(({ name }) => name === "post-tool-use").length, 256);

  await resultHandler(structuredClone(latestResult), bridge.context);
  await endHandler({
    type: "tool_execution_end",
    toolCallId: latestResult.toolCallId,
    toolName: latestResult.toolName,
    result: { content: [], details: { phase: "duplicate-latest" } },
    isError: true,
  }, bridge.context);

  begin(firstResult.toolCallId, { marker: "task36-retired-id-still-suppressed" });
  await resultHandler(structuredClone(firstResult), bridge.context);
  assert.equal(calls.filter(({ name }) => name === "post-tool-use").length, 256);

  const evictionInput = { marker: "task36-retirement-eviction" };
  begin("task36-retirement-eviction", evictionInput);
  await resultHandler(
    resultEvent("task36-retirement-eviction", evictionInput, "eviction"),
    bridge.context,
  );

  const reusedInput = { marker: "task36-high-volume-reused-generation" };
  startHandler({
    type: "tool_execution_start",
    toolCallId: firstResult.toolCallId,
    toolName: firstResult.toolName,
    args: reusedInput,
  }, bridge.context);
  await resultHandler(firstResult, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: firstResult.toolCallId,
    toolName: firstResult.toolName,
    input: reusedInput,
  }, bridge.context);
  const reusedResult = resultEvent(firstResult.toolCallId, reusedInput, "reused");
  await resultHandler(reusedResult, bridge.context);
  await resultHandler(structuredClone(firstResult), bridge.context);

  const fullRequests = calls.filter(({ name }) => name === "post-tool-use");
  assert.equal(fullRequests.length, 258);
  assert.equal(
    fullRequests.at(-1).payload.output.content[0].text,
    "reused-task36-high-volume-reused-generation",
  );
  assert.deepEqual(fullRequests.at(-1).payload.output.details, { phase: "reused" });
  assert.deepEqual(bridge.notifications, []);
});

test("active correlation is capped at 256 without eviction", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-active-boundary",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const inputs = [];
  for (let index = 0; index < 256; index += 1) {
    const input = { marker: `task36-active-${index}` };
    inputs.push(input);
    startHandler({
      type: "tool_execution_start",
      toolCallId: `task36-active-${index}`,
      toolName: "task36_probe",
      args: input,
    }, bridge.context);
  }
  startHandler({
    type: "tool_execution_start",
    toolCallId: "task36-active-0",
    toolName: "task36_probe",
    args: { marker: "duplicate-must-not-replace" },
  }, bridge.context);
  assert.throws(
    () => startHandler({
      type: "tool_execution_start",
      toolCallId: "task36-active-overflow",
      toolName: "task36_probe",
      args: { marker: task36Token },
    }, bridge.context),
    /hook=post-tool-use, kind=malformed/,
  );
  assert.equal(bridge.notifications.length, 1);
  assert.equal(JSON.stringify(bridge.notifications).includes(task36Token), false);

  callHandler({
    type: "tool_call",
    toolCallId: "task36-active-0",
    toolName: "task36_probe",
    input: inputs[0],
  }, bridge.context);
  await resultHandler({
    type: "tool_result",
    toolCallId: "task36-active-0",
    toolName: "task36_probe",
    input: inputs[0],
    content: [{ type: "text", text: "first-complete" }],
    details: null,
    isError: false,
  }, bridge.context);

  const overflowInput = { marker: "task36-active-overflow-accepted" };
  startHandler({
    type: "tool_execution_start",
    toolCallId: "task36-active-overflow",
    toolName: "task36_probe",
    args: overflowInput,
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: "task36-active-overflow",
    toolName: "task36_probe",
    input: overflowInput,
  }, bridge.context);
  await resultHandler({
    type: "tool_result",
    toolCallId: "task36-active-overflow",
    toolName: "task36_probe",
    input: overflowInput,
    content: [{ type: "text", text: "overflow-complete" }],
    details: null,
    isError: false,
  }, bridge.context);

  assert.deepEqual(
    calls.filter(({ name }) => name === "post-tool-use").map(({ payload }) => payload.toolCallId),
    ["task36-active-0", "task36-active-overflow"],
  );
});

test("a malformed real Jiti bootstrap fails loading without invoking its accessor", () => {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  const result = childProcess.spawnSync(
    process.execPath,
    [task36LoaderProbePath, pi, extensionPath, "malformed"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.firstLoaded, 0);
  assert.equal(report.firstErrors.length, 1);
  assert.match(report.firstErrors[0].error, /Cavemem runtime bootstrap is malformed/);
  assert.equal(report.accessorTouched, false);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("task36 malformed capability accessor"), false);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("task36 malformed toJSON"), false);
});

test("a real Jiti load fails closed without the process bootstrap", () => {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  const result = childProcess.spawnSync(
    process.execPath,
    [task36LoaderProbePath, pi, extensionPath, "missing"],
    {
      encoding: "utf8",
      env: { ...process.env },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.firstLoaded, 0);
  assert.equal(report.firstErrors.length, 1);
  assert.match(report.firstErrors[0].error, /Cavemem runtime bootstrap is unavailable/);
  assert.equal(report.accessorTouched, false);
});

test("real patched bootstrap and packaged bridge survive DefaultResourceLoader reload", () => {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  const result = childProcess.spawnSync(
    process.execPath,
    [task36LoaderProbePath, pi, extensionPath, "bootstrap"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SHOPIFY_PI_TOKEN: task36Token,
        PI_AGENT_LAUNCH_ID: task36LaunchId,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.firstErrors, []);
  assert.deepEqual(report.secondErrors, []);
  assert.equal(report.firstLoaded, 1);
  assert.equal(report.secondLoaded, 1);
  assert.equal(report.sameCapability, true);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(task36Token), false);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(task36LaunchId), false);
});

test("end-before-start is ignored without tombstoning the ID", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-end-before-start",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const endHandler = bridge.handlers.get("tool_execution_end");
  const toolCallId = "task36-end-before-start";
  const input = { marker: "task36-valid-after-unknown-end" };

  await endHandler({
    type: "tool_execution_end",
    toolCallId,
    toolName: "task36_probe",
    result: { content: [], details: null },
    isError: true,
  }, bridge.context);
  startHandler({
    type: "tool_execution_start",
    toolCallId,
    toolName: "task36_probe",
    args: input,
  }, bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId,
    toolName: "task36_probe",
    input,
  }, bridge.context);
  await resultHandler({
    type: "tool_result",
    toolCallId,
    toolName: "task36_probe",
    input,
    content: [{ type: "text", text: "task36 valid result" }],
    details: { phase: "valid" },
    isError: false,
  }, bridge.context);

  const fullRequests = calls.filter(({ name }) => name === "post-tool-use");
  assert.equal(fullRequests.length, 1);
  assert.deepEqual(fullRequests[0].payload.input, input);
});

test("a stale result between reused start and validated call is ignored", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task36-stale-reuse",
  );
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const resultHandler = bridge.handlers.get("tool_result");
  const reusedId = "task36-stale-reused-id";
  const oldInput = { marker: "task36-stale-old" };
  const resultEvent = (toolCallId, input, phase) => ({
    type: "tool_result",
    toolCallId,
    toolName: "task36_probe",
    input,
    content: [{ type: "text", text: `${phase}-${input.marker}` }],
    details: { phase },
    isError: false,
  });
  const begin = (toolCallId, input) => {
    startHandler({
      type: "tool_execution_start",
      toolCallId,
      toolName: "task36_probe",
      args: input,
    }, bridge.context);
    callHandler({
      type: "tool_call",
      toolCallId,
      toolName: "task36_probe",
      input,
    }, bridge.context);
  };

  begin(reusedId, oldInput);
  await resultHandler(resultEvent(reusedId, oldInput, "old"), bridge.context);
  for (let index = 0; index < 256; index += 1) {
    const input = { marker: `task36-stale-evict-${index}` };
    begin(`task36-stale-evict-${index}`, input);
    await resultHandler(
      resultEvent(`task36-stale-evict-${index}`, input, "evict"),
      bridge.context,
    );
  }

  const newInput = { marker: "task36-stale-new" };
  startHandler({
    type: "tool_execution_start",
    toolCallId: reusedId,
    toolName: "task36_probe",
    args: newInput,
  }, bridge.context);
  await resultHandler(resultEvent(reusedId, oldInput, "late-old"), bridge.context);
  callHandler({
    type: "tool_call",
    toolCallId: reusedId,
    toolName: "task36_probe",
    input: newInput,
  }, bridge.context);
  await resultHandler(resultEvent(reusedId, newInput, "new"), bridge.context);

  const reused = calls
    .filter(({ name, payload }) => name === "post-tool-use" && payload.toolCallId === reusedId);
  assert.equal(reused.length, 2);
  assert.deepEqual(reused.at(-1).payload.input, newInput);
  assert.deepEqual(reused.at(-1).payload.output.details, { phase: "new" });
});

test("real Pi dispatch captures pre-mutation success and every tool failure exactly once", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const { Type } = await loadRuntimeModules();
  assert.throws(() => JSON.stringify(task36RuntimeBootstrap), /not serializable/);

  const calls = [];
  const executions = [];
  const blockedValidatedInputs = [];
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cacheWrite1h: 5,
    reasoning: 6,
    totalTokens: 16,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
  };
  const probeFactory = (pi) => {
    pi.registerTool({
      name: "task36_probe",
      label: "Task 3.6 probe",
      description: "Exercise Task 3.6 capture behavior",
      parameters: Type.Object({
        mode: Type.Union([
          Type.Literal("success"),
          Type.Literal("error"),
          Type.Literal("blocked"),
        ]),
        message: Type.String(),
        launch: Type.Optional(Type.String()),
        count: Type.Optional(Type.Number()),
      }),
      async execute(toolCallId, input) {
        executions.push({ toolCallId, input: structuredClone(input) });
        if (input.mode === "error") throw new Error(`task36 tool error ${input.message}`);
        return {
          content: [{ type: "text", text: `before ${input.message} ${input.launch}` }],
          details: {
            phase: "before",
            [task36Token]: `detail ${task36LaunchId}`,
          },
          usage,
        };
      },
    });
  };
  const laterFactory = (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "task36_probe" && event.input.mode === "blocked") {
        blockedValidatedInputs.push(structuredClone(event.input));
        return { block: true, reason: "task36 blocked before execution" };
      }
      return undefined;
    });
    pi.on("tool_result", (event) => {
      if (event.toolName !== "task36_probe" || event.input.mode !== "success") return undefined;
      event.input.message = "later-mutated-input";
      event.content[0].text = "later-mutated-in-place";
      event.details.phase = "later-mutated-in-place";
      return {
        content: [{ type: "text", text: "later-mutated-return" }],
        details: { phase: "later-mutated-return" },
        isError: true,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    });
  };
  const fixture = await createSession({
    extensionFactories: [
      {
        name: "cavemem-task36-capture",
        factory: createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
      },
      { name: "task36-probe", factory: probeFactory },
      { name: "task36-later", factory: laterFactory },
    ],
  });

  try {
    const success = await executeTask36Tool(
      fixture,
      "task36_probe",
      { mode: "success", message: task36Token, launch: task36LaunchId },
      "task36-success",
    );
    const toolError = await executeTask36Tool(
      fixture,
      "task36_probe",
      { mode: "error", message: task36Token, launch: task36LaunchId },
      "task36-tool-error",
    );
    const blocked = await executeTask36Tool(
      fixture,
      "task36_probe",
      { mode: "blocked", message: "blocked-input", count: "7" },
      "task36-blocked",
    );
    const unavailable = await executeTask36Tool(
      fixture,
      "task36_unavailable",
      { marker: "unavailable-input" },
      "task36-unavailable",
    );
    const invalid = await executeTask36Tool(
      fixture,
      "task36_probe",
      { mode: "success" },
      "task36-validation",
    );

    assert.equal(success.result.isError, true);
    assert.equal(success.result.content[0].text, "later-mutated-return");
    assert.equal(toolError.result.isError, true);
    assert.equal(blocked.result.isError, true);
    assert.equal(unavailable.result.isError, true);
    assert.equal(invalid.result.isError, true);
    assert.deepEqual(executions.map(({ toolCallId }) => toolCallId), [
      success.toolCallId,
      toolError.toolCallId,
    ]);
    assert.deepEqual(blockedValidatedInputs, [{
      mode: "blocked",
      message: "blocked-input",
      count: 7,
    }]);

    const fullRequests = calls.filter(({ name }) => name === "post-tool-use");
    assert.equal(fullRequests.length, 5);
    assert.deepEqual(fullRequests.map(({ captureMode }) => captureMode), Array(5).fill("pi-full-v1"));
    assert.deepEqual(fullRequests.map(({ payload }) => payload.toolCallId), [
      success.toolCallId,
      toolError.toolCallId,
      blocked.toolCallId,
      unavailable.toolCallId,
      invalid.toolCallId,
    ]);
    for (const { payload } of fullRequests) {
      assert.deepEqual(
        Object.keys(payload).sort(),
        ["input", "output", "schemaVersion", "session_id", "toolCallId", "toolName"],
      );
      assert.deepEqual(
        Object.keys(payload.output).sort(),
        payload.output.usage === undefined
          ? ["content", "details", "isError"]
          : ["content", "details", "isError", "usage"],
      );
    }

    const successPayload = fullRequests[0].payload;
    assert.deepEqual(successPayload.input, {
      mode: "success",
      message: task36Redacted,
      launch: task36Redacted,
    });
    assert.deepEqual(successPayload.output.content, [{
      type: "text",
      text: `before ${task36Redacted} ${task36Redacted}`,
    }]);
    assert.deepEqual(successPayload.output.details, {
      phase: "before",
      [task36Redacted]: `detail ${task36Redacted}`,
    });
    assert.equal(successPayload.output.isError, false);
    assert.deepEqual(successPayload.output.usage, {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite1h: 5,
      reasoning: 6,
      totalTokens: 16,
      "cost.input": 0.1,
      "cost.output": 0.2,
      "cost.cacheRead": 0.3,
      "cost.cacheWrite": 0.4,
      "cost.total": 1,
    });

    const errorPayload = fullRequests[1].payload;
    assert.equal(errorPayload.output.isError, true);
    assert.match(errorPayload.output.content[0].text, /task36 tool error \[REDACTED\]/);
    assert.deepEqual(fullRequests[2].payload.input, {
      mode: "blocked",
      message: "blocked-input",
      count: 7,
    });
    assert.match(fullRequests[2].payload.output.content[0].text, /task36 blocked before execution/);
    assert.deepEqual(fullRequests[3].payload.input, { marker: "unavailable-input" });
    assert.match(fullRequests[3].payload.output.content[0].text, /not found/);
    assert.deepEqual(fullRequests[4].payload.input, { mode: "success" });
    assert.equal(fullRequests[4].payload.output.isError, true);
    assert.equal(JSON.stringify(fullRequests).includes(task36Token), false);
    assert.equal(JSON.stringify(fullRequests).includes(task36LaunchId), false);
    assert.deepEqual(fixture.ui.notifications, []);
    assert.deepEqual(fixture.extensionErrors, []);
  } finally {
    fixture.session.dispose();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hook failures are visible, value-free, and do not poison later FIFO work", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const sensitive = "task35-sensitive-child-error";
  let promptCount = 0;
  const runHook = async (request) => {
    if (request.name !== "user-prompt-submit") return;
    promptCount += 1;
    if (promptCount === 1) throw new Error(sensitive);
  };
  const fixture = await createSession({
    extensionFactories: [{ name: "cavemem-failure", factory: createCavememBridge({ runHook }) }],
  });
  try {
    await fixture.session.extensionRunner.emitInput("task35failure", undefined, "interactive");
    await fixture.session.extensionRunner.emitInput("task35recovery", undefined, "interactive");
    assert.equal(promptCount, 2);
    assert.deepEqual(fixture.ui.notifications, [{
      message: "Cavemem capture failed (hook=user-prompt-submit, kind=hook). Verify the shared Cavemem data store and retry.",
      type: "error",
    }]);
    assert.equal(fixture.extensionErrors.length, 1);
    assert.equal(fixture.extensionErrors[0].event, "input");
    assert.equal(fixture.extensionErrors[0].error, fixture.ui.notifications[0].message);
    assert.equal(JSON.stringify({
      notifications: fixture.ui.notifications,
      errors: fixture.extensionErrors,
    }).includes(sensitive), false);
  } finally {
    fixture.session.dispose();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("full-mode process and malformed failures stay sticky, classified, and value-free", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task36-errors-"));
  const logPath = path.join(root, "calls.jsonl");
  const command = writeExecutable(
    root,
    "task36-errors.mjs",
    `import fs from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.once("end", () => {
  const payload = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
    args: process.argv.slice(2),
    exactEnvironmentPresent: Object.hasOwn(process.env, "TASK36_EXACT_SECRET") || Object.hasOwn(process.env, "TASK36_EMBEDDED_SECRET"),
    payload,
  }) + "\\n");
  const failure = payload.input.failure;
  if (failure === "storage") process.stderr.write("pi-full-v1 storage limit exceeded at active SQLite boundary SQLITE_MAX_LENGTH=128\\n");
  else if (failure === "redaction") process.stderr.write("pi-full-v1 privacy canonical rule failed at output.content\\n");
  else if (failure === "malformed") process.stderr.write("pi-full-v1 output.usage must contain only finite numbers\\n");
  else if (failure === "process") process.stderr.write("task36 fixed process failure\\n");
  else process.exit(0);
  process.exit(1);
});`,
  );
  const bridge = bindTask36Bridge(createCavememBridge({ command }), root);
  const startHandler = bridge.handlers.get("tool_execution_start");
  const callHandler = bridge.handlers.get("tool_call");
  const handler = bridge.handlers.get("tool_result");
  for (const task36Handler of [startHandler, callHandler, handler]) {
    assert.equal(typeof task36Handler, "function");
  }

  const previous = {
    exact: process.env.TASK36_EXACT_SECRET,
    embedded: process.env.TASK36_EMBEDDED_SECRET,
    noColor: process.env.NO_COLOR,
    forceColor: process.env.FORCE_COLOR,
  };
  process.env.TASK36_EXACT_SECRET = task36Token;
  process.env.TASK36_EMBEDDED_SECRET = `prefix-${task36LaunchId}-suffix`;
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;

  const event = (toolCallId, failure, overrides = {}) => ({
    type: "tool_result",
    toolCallId,
    toolName: "task36_probe",
    input: { failure, exact: task36Token },
    content: [{ type: "text", text: `content ${task36LaunchId}` }],
    details: { exact: task36Token },
    isError: failure !== "success",
    ...overrides,
  });
  const capture = (result) => {
    startHandler({
      type: "tool_execution_start",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: result.input,
    }, bridge.context);
    callHandler({
      type: "tool_call",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      input: result.input,
    }, bridge.context);
    return handler(result, bridge.context);
  };

  try {
    const cyclic = { marker: task36Token };
    cyclic.self = cyclic;
    await assert.rejects(
      capture(event("task36-cyclic", "cycle", { content: cyclic })),
      /hook=post-tool-use, kind=malformed/,
    );

    let getterRead = false;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterRead = true;
        return task36Token;
      },
    });
    await assert.rejects(
      capture(event("task36-accessor", "accessor", { details: accessor })),
      /hook=post-tool-use, kind=malformed/,
    );
    assert.equal(getterRead, false);

    for (const [failure, kind] of [
      ["storage", "storage"],
      ["redaction", "redaction"],
      ["malformed", "malformed"],
      ["process", "exit"],
    ]) {
      await assert.rejects(
        capture(event(`task36-${failure}`, failure)),
        new RegExp(`hook=post-tool-use, kind=${kind}`),
      );
    }
    await capture(event("task36-success-after-errors", "success", { isError: false }));

    const records = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 5);
    for (const record of records) {
      assert.deepEqual(record.args, [
        "hook",
        "run",
        "post-tool-use",
        "--ide",
        "pi",
        "--capture-mode",
        "pi-full-v1",
      ]);
      assert.equal(record.exactEnvironmentPresent, false);
      assert.equal(record.payload.input.exact, task36Redacted);
      assert.equal(record.payload.output.content[0].text, `content ${task36Redacted}`);
      assert.equal(record.payload.output.details.exact, task36Redacted);
    }
    assert.equal(fs.readFileSync(logPath, "utf8").includes(task36Token), false);
    assert.equal(fs.readFileSync(logPath, "utf8").includes(task36LaunchId), false);
    assert.equal(bridge.notifications.length, 6);
    assert.deepEqual(
      bridge.notifications.map(({ message }) => message.match(/kind=([^)]+)/)?.[1]),
      ["malformed", "malformed", "storage", "redaction", "malformed", "exit"],
    );
    assert.equal(JSON.stringify(bridge.notifications).includes(task36Token), false);
    assert.equal(JSON.stringify(bridge.notifications).includes(task36LaunchId), false);
  } finally {
    for (const [name, value] of [
      ["TASK36_EXACT_SECRET", previous.exact],
      ["TASK36_EMBEDDED_SECRET", previous.embedded],
      ["NO_COLOR", previous.noColor],
      ["FORCE_COLOR", previous.forceColor],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cavemem process nonzero and no-progress failures stay bounded and value-free", async (t) => {
  const { createCavememBridge } = await loadBridgeModule();
  await t.test("nonzero exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-exit-"));
    const command = writeExecutable(
      root,
      "fail.mjs",
      'process.stderr.write("task35-process-secret\\n"); process.exit(23);',
    );
    const fixture = await createSession({
      root,
      extensionFactories: [{
        name: "cavemem-process-exit",
        factory: createCavememBridge({ command, noProgressMs: 500, killGraceMs: 20 }),
      }],
    });
    try {
      assert.equal(fixture.extensionErrors.length, 1);
      assert.match(fixture.extensionErrors[0].error, /hook=session-start, kind=exit/);
      assert.equal(JSON.stringify({
        notifications: fixture.ui.notifications,
        errors: fixture.extensionErrors,
      }).includes("task35-process-secret"), false);
    } finally {
      fixture.session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("completion no-progress", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-timeout-"));
    const pidPath = path.join(root, "pid");
    const command = writeExecutable(
      root,
      "hang.mjs",
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const fixture = await createSession({
      root,
      extensionFactories: [{
        name: "cavemem-process-timeout",
        factory: createCavememBridge({ command, noProgressMs: 500, killGraceMs: 20 }),
      }],
    });
    try {
      assert.ok(Date.now() - started < 2_000, "no-progress handling exceeded its bound");
      assert.equal(fixture.extensionErrors.length, 1);
      assert.match(fixture.extensionErrors[0].error, /hook=session-start, kind=completion-timeout/);
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      await waitFor(() => !isProcessAlive(pid), "timed-out Cavemem process survived escalation");
    } finally {
      fixture.session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("timeout keeps later prompt and shutdown hooks behind child close", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-timeout-fifo-"));
    const markerPath = path.join(root, "first-prompt");
    const pidPath = path.join(root, "pid");
    const logPath = path.join(root, "hooks.log");
    const command = writeExecutable(
      root,
      "timeout-fifo.mjs",
      `import fs from "node:fs";
const hook = process.argv[4];
if (hook === "user-prompt-submit" && !fs.existsSync(${JSON.stringify(markerPath)})) {
  fs.writeFileSync(${JSON.stringify(markerPath)}, "");
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(${JSON.stringify(logPath)}, hook + "\\n");
  process.stdin.once("end", () => process.exit(0));
  process.stdin.resume();
}`,
    );
    const fixture = await createSession({
      root,
      extensionFactories: [{
        name: "cavemem-process-timeout-fifo",
        factory: createCavememBridge({ command, noProgressMs: 500, killGraceMs: 500 }),
      }],
    });
    try {
      fs.writeFileSync(logPath, "");
      const started = Date.now();
      const first = fixture.session.extensionRunner.emitInput(
        "task35-timeout-first",
        undefined,
        "interactive",
      );
      await waitFor(() => fs.existsSync(pidPath), "timed-out prompt hook did not start");
      const firstPid = Number(fs.readFileSync(pidPath, "utf8"));
      const second = fixture.session.extensionRunner.emitInput(
        "task35-timeout-second",
        undefined,
        "interactive",
      );
      const shutdown = fixture.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      await waitFor(
        () => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("user-prompt-submit"),
        "queued prompt hook did not execute",
        400,
      );
      const overlappedTimedOutProcess = isProcessAlive(firstPid);
      await Promise.all([first, second, shutdown]);
      await waitFor(() => !isProcessAlive(firstPid), "timed-out FIFO process survived escalation");

      assert.equal(
        overlappedTimedOutProcess,
        false,
        "queued prompt hook started while the timed-out hook PID was alive",
      );
      assert.deepEqual(
        fs.readFileSync(logPath, "utf8").trim().split("\n"),
        ["user-prompt-submit", "session-end"],
      );
      assert.ok(Date.now() - started < 3_000, "timeout FIFO cleanup exceeded its bound");
      assert.equal(fixture.extensionErrors.length, 1);
      assert.match(fixture.extensionErrors[0].error, /hook=user-prompt-submit, kind=completion-timeout/);
    } finally {
      fixture.session.dispose();
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, "utf8"));
        await waitFor(() => !isProcessAlive(pid), "timed-out FIFO process survived fixture cleanup");
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("timeout reaps descendant-held stdio before later FIFO hooks execute", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-timeout-group-"));
    const markerPath = path.join(root, "first-prompt");
    const pidsPath = path.join(root, "pids.json");
    const logPath = path.join(root, "hooks.log");
    const command = writeExecutable(
      root,
      "timeout-group.mjs",
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const hook = process.argv[4];
if (hook === "user-prompt-submit" && !fs.existsSync(${JSON.stringify(markerPath)})) {
  fs.writeFileSync(${JSON.stringify(markerPath)}, "");
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);"], { stdio: "inherit" });
  fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(${JSON.stringify(logPath)}, hook + "\\n");
  process.stdin.once("end", () => process.exit(0));
  process.stdin.resume();
}`,
    );
    const fixture = await createSession({
      root,
      extensionFactories: [{
        name: "cavemem-process-timeout-group",
        factory: createCavememBridge({ command, noProgressMs: 500, killGraceMs: 300 }),
      }],
    });
    let allHooks;
    let pids = [];
    try {
      fs.writeFileSync(logPath, "");
      const first = fixture.session.extensionRunner.emitInput("task35-group-first", undefined, "interactive");
      await waitFor(() => fs.existsSync(pidsPath), "descendant-holding hook did not start");
      const identities = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
      pids = [identities.leader, identities.descendant];
      const second = fixture.session.extensionRunner.emitInput("task35-group-second", undefined, "interactive");
      const shutdown = fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      allHooks = Promise.all([first, second, shutdown]);
      const completedWithinBound = await settlesWithin(allHooks, 2_500);
      if (!completedWithinBound) {
        await forceCleanupProcesses(pids);
        assert.equal(await settlesWithin(allHooks, 2_000), true, "FIFO did not recover after fixture cleanup");
      }

      assert.equal(completedWithinBound, true, "descendant-held stdio left queued hooks blocked");
      assert.equal(pids.some(isProcessAlive), false, "owned hook process group survived cleanup");
      assert.deepEqual(
        fs.readFileSync(logPath, "utf8").trim().split("\n"),
        ["user-prompt-submit", "session-end"],
      );
    } finally {
      await forceCleanupProcesses(pids);
      if (allHooks) await settlesWithin(allHooks, 2_000);
      fixture.session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("leader close keeps group escalation alive without unrelated handles", async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group escalation is unavailable on Windows");
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-leader-close-"));
    const pidsPath = path.join(root, "pids.json");
    const readyPath = path.join(root, "descendant.ready");
    const termPath = path.join(root, "descendant.term");
    const resultPath = path.join(root, "result.json");
    const descendantSource = `
import fs from "node:fs";
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "term\\n"));
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready\\n");
setInterval(() => {}, 1000);
`;
    const command = writeExecutable(
      root,
      "leader-close.mjs",
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
descendant.unref();
fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
const waiter = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(readyPath)}) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10);
if (!fs.existsSync(${JSON.stringify(readyPath)})) throw new Error("descendant did not become ready");`,
    );
    const { pi, extensions } = buildRuntimePaths();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
    );
    const bridgeUrl = pathToFileURL(
      path.join(extensions, manifest.extensions.cavemem.entryPath),
    ).href;
    const probePath = path.join(root, "probe.mjs");
    fs.writeFileSync(
      probePath,
      `import fs from "node:fs";
await import(${JSON.stringify(pathToFileURL(path.join(
  pi,
  "lib/node_modules/@earendil-works/pi-coding-agent/dist/runtime-bootstrap.js",
)).href)});
const { createCavememBridge } = await import(${JSON.stringify(bridgeUrl)});
const handlers = new Map();
const notifications = [];
createCavememBridge({ command: ${JSON.stringify(command)}, noProgressMs: 5000, killGraceMs: 800 })({
  on(event, handler) { handlers.set(event, handler); },
});
const shutdown = handlers.get("session_shutdown");
if (!shutdown) throw new Error("session_shutdown handler was not registered");
const started = Date.now();
shutdown(
  { type: "session_shutdown", reason: "quit" },
  {
    cwd: ${JSON.stringify(root)},
    sessionManager: { getSessionId() { return "task35-leader-close"; } },
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  },
).then(
  () => {
    const { leader, descendant } = JSON.parse(fs.readFileSync(${JSON.stringify(pidsPath)}, "utf8"));
    let groupProbe = "present";
    try {
      process.kill(-leader, 0);
    } catch (error) {
      groupProbe = error?.code ?? "unknown";
    }
    let descendantAlive = true;
    try {
      process.kill(descendant, 0);
    } catch (error) {
      if (error?.code === "ESRCH") descendantAlive = false;
      else throw error;
    }
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      descendantAlive,
      elapsedMs: Date.now() - started,
      groupProbe,
      notifications,
      outcome: "settled",
    }));
  },
  (error) => fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
    elapsedMs: Date.now() - started,
    message: error?.message,
    notifications,
    outcome: "rejected",
  })),
);`,
      "utf8",
    );

    const started = Date.now();
    const probe = childProcess.spawnSync(process.execPath, [probePath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const probeElapsedMs = Date.now() - started;
    const identities = fs.existsSync(pidsPath)
      ? JSON.parse(fs.readFileSync(pidsPath, "utf8"))
      : {};
    const pids = [identities.leader, identities.descendant];
    const descendantSurvived = Number.isInteger(identities.descendant)
      && isProcessAlive(identities.descendant);
    let groupSurvived = false;
    if (Number.isInteger(identities.leader)) {
      try {
        process.kill(-identities.leader, 0);
        groupSurvived = true;
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    const result = fs.existsSync(resultPath)
      ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
      : undefined;
    const termObserved = fs.existsSync(termPath);

    await forceCleanupProcesses(pids);
    try {
      assert.ok(
        result,
        `isolated bridge exited after ${probeElapsedMs}ms before handler settlement; status=${probe.status}, signal=${probe.signal}, groupAlive=${groupSurvived}, descendantAlive=${descendantSurvived}`,
      );
      assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
      assert.equal(probe.signal, null, `${probe.stdout}${probe.stderr}`);
      assert.equal(result.outcome, "settled", JSON.stringify(result));
      assert.equal(termObserved, true, "stubborn descendant did not observe group TERM");
      assert.equal(result.groupProbe, "ESRCH", JSON.stringify(result));
      assert.equal(result.descendantAlive, false, JSON.stringify(result));
      assert.equal(groupSurvived, false, "owned process group survived settled shutdown");
      assert.equal(descendantSurvived, false, "same-group descendant survived settled shutdown");
      assert.ok(result.elapsedMs >= 800, `group KILL ran before its grace period: ${result.elapsedMs}ms`);
      assert.ok(result.elapsedMs < 4_000, `group cleanup exceeded its bound: ${result.elapsedMs}ms`);
      assert.deepEqual(result.notifications, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("unconfirmed quiescence fails queued hooks without executing them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-timeout-poison-"));
    const markerPath = path.join(root, "first-prompt");
    const pidsPath = path.join(root, "pids.json");
    const logPath = path.join(root, "hooks.log");
    const command = writeExecutable(
      root,
      "timeout-poison.mjs",
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const hook = process.argv[4];
if (hook === "user-prompt-submit" && !fs.existsSync(${JSON.stringify(markerPath)})) {
  fs.writeFileSync(${JSON.stringify(markerPath)}, "");
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);"], { detached: true, stdio: "inherit" });
  descendant.unref();
  fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(${JSON.stringify(logPath)}, hook + "\\n");
  process.stdin.once("end", () => process.exit(0));
  process.stdin.resume();
}`,
    );
    const fixture = await createSession({
      root,
      extensionFactories: [{
        name: "cavemem-process-timeout-poison",
        factory: createCavememBridge({ command, noProgressMs: 500, killGraceMs: 300 }),
      }],
    });
    let allHooks;
    let pids = [];
    try {
      fs.writeFileSync(logPath, "");
      const first = fixture.session.extensionRunner.emitInput("task35-poison-first", undefined, "interactive");
      await waitFor(() => fs.existsSync(pidsPath), "escaped descendant hook did not start");
      const identities = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
      pids = [identities.leader, identities.descendant];
      const second = fixture.session.extensionRunner.emitInput("task35-poison-second", undefined, "interactive");
      const shutdown = fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      allHooks = Promise.all([first, second, shutdown]);
      const completedWithinBound = await settlesWithin(allHooks, 2_500);
      const logBeforeCleanup = fs.readFileSync(logPath, "utf8");
      const escapedDescendantSurvived = isProcessAlive(identities.descendant);
      await forceCleanupProcesses(pids);
      if (!completedWithinBound) {
        assert.equal(await settlesWithin(allHooks, 2_000), true, "poisoned FIFO did not settle after fixture cleanup");
      }

      assert.equal(completedWithinBound, true, "unconfirmed hook quiescence hung queued handlers");
      assert.equal(escapedDescendantSurvived, true, "fixture did not retain stdio outside the owned group");
      assert.equal(logBeforeCleanup, "", "queued hook executed after quiescence became unprovable");
      assert.equal(fixture.extensionErrors.length, 3);
      for (const error of fixture.extensionErrors) {
        assert.match(error.error, /kind=quiescence-timeout/);
      }
    } finally {
      await forceCleanupProcesses(pids);
      if (allHooks) await settlesWithin(allHooks, 2_000);
      fixture.session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
