import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
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
  runtimeModules = { ...codingAgent, ...ai, ...streams };
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

  return { root: fixtureRoot, cwd, session, ui, extensionErrors };
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
    const { extensions } = buildRuntimePaths();
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
