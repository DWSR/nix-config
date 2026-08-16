import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
const task37AttributionProbePath = path.join(
  testsDir,
  "fixtures/cavemem-bridge/child-attribution-probe.mjs",
);
const task37EnvironmentProbePath = path.join(
  testsDir,
  "fixtures/cavemem-bridge/managed-environment-probe.mjs",
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
let task37PolicyContract;

const task36Token = "task36-shopify-token-sentinel-0123456789";
const task36LaunchId = "12345678-1234-4abc-8def-1234567890ab";
const task36Redacted = "[REDACTED]";
const task36BootstrapSymbol = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const task37EnvironmentSymbol = Symbol.for("dwsr.pi-agent.cavemem-environment.v1");
const task37ManagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task37-managed-"));
const task37ManagedDataDir = path.join(task37ManagedRoot, "cavemem");
const task37EnvironmentSerializationError = "Cavemem process environment is not serializable";
const task37AllowedEnvironmentNames = [
  "CAVEMEM_DATA_DIR",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

test.after(() => {
  fs.rmSync(task37ManagedRoot, { recursive: true, force: true });
});

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
        paths = [ pkgs.cavemem pkgs.mcpproxy-go pkgs.nodejs pkgs.sqlite ];
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

function getTask37PolicyContract() {
  if (task37PolicyContract) return task37PolicyContract;
  task37PolicyContract = JSON.parse(
    childProcess.execFileSync(
      "nix",
      [
        "eval",
        "--json",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          let
            policy = import (source + "/home-manager/common/pi-agent/credential-policy.nix") {
              inherit pkgs;
              inherit (pkgs) lib;
            };
          in {
            allowlist = policy.cavememEnvironmentAllowlist;
            sensitiveNames = policy.shellRemoveNames;
            timeoutName = policy.bashTimeoutBinding.environmentName;
          }
        `),
      ],
      commandOptions,
    ),
  );
  return task37PolicyContract;
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

async function createTask37Runtime({ runHook, sourceId = "task37-runtime-source" }) {
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createAgentSessionRuntime,
    createAssistantMessageEventStream,
    getModel,
  } = await loadRuntimeModules();
  assert.equal(typeof createAgentSessionRuntime, "function");
  const { createCavememBridge } = await loadBridgeModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task37-runtime-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  for (const directory of [cwd, agentDir, sessionsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "reviewed Pi model fixture is unavailable");
  const ui = createUi();
  const extensionErrors = [];
  let responseIndex = 0;

  const bridgeFactory = createCavememBridge({ runHook });
  const compactFactory = (pi) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "task37 compacted session marker",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { fixture: "task37" },
      },
    }));
  };
  const createRuntime = async ({
    cwd: activeCwd,
    agentDir: activeAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.create(activeCwd, activeAgentDir, {
      projectTrusted: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: activeCwd,
      agentDir: activeAgentDir,
      settingsManager,
      extensionFactories: [
        { name: "cavemem-task37-runtime", factory: bridgeFactory },
        { name: "task37-compaction", factory: compactFactory },
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(activeAgentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const result = await createAgentSession({
      cwd: activeCwd,
      agentDir: activeAgentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent,
    });
    result.session.agent.streamFunction = (activeModel) => {
      responseIndex += 1;
      const message = assistantMessage(activeModel, `task37 runtime response ${responseIndex}`);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    return {
      ...result,
      services: { agentDir: activeAgentDir, cwd: activeCwd },
      diagnostics: [],
    };
  };
  const sourceManager = SessionManager.create(cwd, sessionsDir, { id: sourceId });
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: sourceManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
  const bind = async (session) => {
    await session.bindExtensions({
      uiContext: ui.context,
      mode: "tui",
      onError(error) { extensionErrors.push(error); },
    });
  };
  await bind(runtime.session);
  runtime.setRebindSession(bind);
  return {
    agentDir,
    cwd,
    extensionErrors,
    model,
    root,
    runtime,
    sessionsDir,
    ui,
  };
}

function appendTask37Turn(sessionManager, model, marker, size = 0) {
  const suffix = size > 0 ? `-${"x".repeat(size)}` : "";
  const userEntryId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: `${marker}-user${suffix}` }],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage(assistantMessage(model, `${marker}-assistant${suffix}`));
  return userEntryId;
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

function completeCavememSettings(dataDir, overrides = {}) {
  return {
    dataDir,
    workerPort: overrides.workerPort ?? 37777,
    logLevel: "error",
    compression: {
      intensity: "full",
      expandForModel: true,
    },
    embedding: {
      provider: "none",
      model: "task37-none",
      batchSize: 16,
      autoStart: false,
      idleShutdownMs: 60_000,
      ...overrides.embedding,
    },
    search: {
      alpha: 0.5,
      defaultLimit: 20,
    },
    privacy: {
      excludePatterns: [],
      redactSecrets: true,
    },
    ides: {},
  };
}

function resetTask37ManagedDataDir() {
  fs.rmSync(task37ManagedDataDir, { recursive: true, force: true });
  fs.mkdirSync(task37ManagedDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(task37ManagedDataDir, "settings.json"),
    `${JSON.stringify(completeCavememSettings(task37ManagedDataDir), null, 2)}\n`,
  );
}

function installTask37EnvironmentCapability() {
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, task37EnvironmentSymbol), undefined);
  resetTask37ManagedDataDir();
  const environment = {};
  const values = {
    CAVEMEM_DATA_DIR: task37ManagedDataDir,
    HOME: path.join(task37ManagedRoot, "home"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TERM: "xterm-256color",
    TMPDIR: path.join(task37ManagedRoot, "tmp"),
    USER: "task37",
    XDG_CACHE_HOME: path.join(task37ManagedRoot, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(task37ManagedRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(task37ManagedRoot, "xdg-data"),
    XDG_STATE_HOME: path.join(task37ManagedRoot, "xdg-state"),
  };
  for (const directory of [
    values.HOME,
    values.TMPDIR,
    values.XDG_CACHE_HOME,
    values.XDG_CONFIG_HOME,
    values.XDG_DATA_HOME,
    values.XDG_STATE_HOME,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(environment, name, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  Object.freeze(environment);
  const capability = { schemaVersion: 1, environment };
  Object.defineProperty(capability, "toJSON", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(() => { throw new Error(task37EnvironmentSerializationError); }),
    writable: false,
  });
  Object.freeze(capability);
  Object.defineProperty(globalThis, task37EnvironmentSymbol, {
    configurable: false,
    enumerable: false,
    value: capability,
    writable: false,
  });
  return capability;
}

const task37EnvironmentCapability = installTask37EnvironmentCapability();

function bindTask36Bridge(factory, cwd, options = {}) {
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
      sessionManager: options.sessionManager ?? {
        getHeader() { return null; },
        getSessionFile() { return undefined; },
        getSessionId() { return options.sessionId ?? "task36-direct-session"; },
      },
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
  const environment = { ...process.env };
  delete environment.CAVEMEM_NO_AUTOSTART;
  delete environment.FORCE_COLOR;
  return childProcess.spawnSync(
    path.join(lifecycle, "bin/cavemem"),
    ["search", marker, "--no-semantic"],
    {
      encoding: "utf8",
      env: { ...environment, CAVEMEM_DATA_DIR: dataDir, NO_COLOR: "1" },
    },
  );
}

function assertTreeValueFree(root, values) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      assertTreeValueFree(entryPath, values);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(entryPath);
    for (const value of values.filter(Boolean)) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `sensitive value persisted in ${entryPath}`);
    }
  }
}

function task37ProbeEnvironment(dataDir, overrides = {}) {
  const environment = { ...process.env, CAVEMEM_DATA_DIR: dataDir, NO_COLOR: "1", ...overrides };
  delete environment.CAVEMEM_NO_AUTOSTART;
  delete environment.FORCE_COLOR;
  return environment;
}

function runTask37AttributionProbe(mode, overrides = {}) {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-cavemem-task37-${mode}-`));
  const dataDir = path.join(root, "cavemem");
  fs.mkdirSync(dataDir, { recursive: true });
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  const result = childProcess.spawnSync(
    process.execPath,
    [task37AttributionProbePath, pi, extensionPath, mode],
    {
      encoding: "utf8",
      env: task37ProbeEnvironment(dataDir, {
        SHOPIFY_PI_TOKEN: task36Token,
        PI_AGENT_LAUNCH_ID: task36LaunchId,
        ...overrides,
      }),
    },
  );
  return {
    dataDir,
    report: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
    result,
    root,
  };
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttp(url, processHandle, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      assert.fail(`mcpproxy exited before readiness with status ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("mcpproxy did not become ready");
}

function toolResultText(result) {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map(({ text }) => text)
    .join("\n");
}

async function searchThroughLocalMcpproxy(dataDir, marker) {
  const { lifecycle } = buildRuntimePaths();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task37-mcpproxy-"));
  const proxyDataDir = path.join(root, "proxy-data");
  const configPath = path.join(root, "mcp_config.json");
  fs.mkdirSync(proxyDataDir, { recursive: true });
  const port = await reserveLoopbackPort();
  fs.writeFileSync(configPath, `${JSON.stringify({
    listen: `127.0.0.1:${port}`,
    data_dir: proxyDataDir,
    routing_mode: "retrieve_tools",
    quarantine_enabled: false,
    require_mcp_auth: false,
    logging: {
      level: "error",
      enable_file: false,
      enable_console: false,
    },
    tool_discovery_interval: "0s",
    mcpServers: [{
      name: "cavemem",
      protocol: "stdio",
      enabled: true,
      quarantined: false,
      command: path.join(lifecycle, "bin/cavemem"),
      args: ["mcp"],
      env: { CAVEMEM_DATA_DIR: dataDir },
    }],
  }, null, 2)}\n`);
  const proxy = childProcess.spawn(
    path.join(lifecycle, "bin/mcpproxy"),
    [
      "--config",
      configPath,
      "--data-dir",
      proxyDataDir,
      "--log-level",
      "error",
      "serve",
      "--listen",
      `127.0.0.1:${port}`,
      "--disable-management",
      "--enable-socket=false",
      "--require-mcp-auth=false",
    ],
    {
      detached: process.platform !== "win32",
      env: {
        HOME: root,
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  proxy.stdout.setEncoding("utf8");
  proxy.stderr.setEncoding("utf8");
  proxy.stdout.on("data", (chunk) => { stdout += chunk; });
  proxy.stderr.on("data", (chunk) => { stderr += chunk; });
  let client;
  let completed = false;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/healthz`, proxy);
    const sdkRoot = path.join(
      lifecycle,
      "lib/node_modules/cavemem/node_modules/@modelcontextprotocol/sdk/dist/esm",
    );
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import(pathToFileURL(path.join(sdkRoot, "client/index.js")).href),
      import(pathToFileURL(path.join(sdkRoot, "client/streamableHttp.js")).href),
    ]);
    client = new Client({ name: "pi-agent-task37-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    let discovered;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await client.callTool({
        name: "retrieve_tools",
        arguments: { query: "cavemem search", limit: 5 },
      });
      const text = toolResultText(result);
      if (text.includes("cavemem:search")) {
        discovered = text;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(discovered, "mcpproxy did not discover the local Cavemem search tool");
    const result = await client.callTool({
      name: "call_tool_read",
      arguments: {
        name: "cavemem:search",
        args: { query: marker, limit: 20 },
        intent_reason: "Task 3.7 hermetic Cavemem discovery test",
        intent_data_sensitivity: "internal",
      },
    });
    completed = true;
    return { discovered, root, search: toolResultText(result), stderr, stdout };
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (proxy.exitCode === null) {
      try {
        if (process.platform === "win32") proxy.kill("SIGTERM");
        else process.kill(-proxy.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await Promise.race([
        new Promise((resolve) => proxy.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (proxy.exitCode === null) {
      try {
        if (process.platform === "win32") proxy.kill("SIGKILL");
        else process.kill(-proxy.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await Promise.race([
        new Promise((resolve) => proxy.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!completed) fs.rmSync(root, { recursive: true, force: true });
  }
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
  const dataDir = task37ManagedDataDir;
  resetTask37ManagedDataDir();
  const previous = {
    dataDir: process.env.CAVEMEM_DATA_DIR,
    noColor: process.env.NO_COLOR,
    forceColor: process.env.FORCE_COLOR,
  };
  process.env.CAVEMEM_DATA_DIR = dataDir;
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

    const observations = queryRows(
      dataDir,
      "SELECT session_id, kind, content FROM observations ORDER BY id",
    );
    assert.deepEqual(observations.map((row) => row.kind === "tool_use"
      ? {
        session_id: row.session_id,
        kind: row.kind,
        toolName: JSON.parse(row.content).toolName,
        input: JSON.parse(row.content).input,
      }
      : row), [
      { session_id: "task35-lifecycle-session", kind: "user_prompt", content: "task35promptalpha" },
      {
        session_id: "task35-lifecycle-session",
        kind: "tool_use",
        toolName: "pi_session_lineage",
        input: { source: "reload" },
      },
      { session_id: "task35-lifecycle-session", kind: "user_prompt", content: "task35promptbeta" },
    ]);
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

test("bridge source never reopens parentSession or generically redacts canonical envelopes", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "overlays/pi-agent/extensions/cavemem/index.ts.in"),
    "utf8",
  );
  assert.doesNotMatch(source, /from "node:fs"/);
  assert.doesNotMatch(source, /\bparentSession\b/);
  assert.doesNotMatch(source, /snapshotRedactedJson\(\s*(?:observation|payload)/);
});

test("real Pi runtime preserves identities and orders resume, reload, compact, fork, and new transitions", async () => {
  const records = [];
  let blockedPrompt;
  let releaseBlockedPrompt;
  const runHook = async (request) => {
    records.push({ phase: "start", request: structuredClone(request) });
    if (request.name === "user-prompt-submit" && request.payload.prompt === blockedPrompt) {
      await new Promise((resolve) => { releaseBlockedPrompt = resolve; });
    }
    records.push({ phase: "end", request: structuredClone(request) });
  };
  const fixture = await createTask37Runtime({ runHook });
  const { SessionManager } = await loadRuntimeModules();
  const started = () => records
    .filter(({ phase }) => phase === "start")
    .map(({ request }) => request);
  const lineage = (request) => ({
    name: request.name,
    sessionId: request.payload.session_id,
    source: request.payload.source,
    toolName: request.payload.toolName,
    input: request.payload.input,
  });
  let disposed = false;
  try {
    assert.equal(fixture.runtime.session.sessionManager.getSessionId(), "task37-runtime-source");
    appendTask37Turn(fixture.runtime.session.sessionManager, fixture.model, "task37-source");
    const destinationManager = SessionManager.create(
      fixture.cwd,
      fixture.sessionsDir,
      { id: "task37-runtime-destination" },
    );
    appendTask37Turn(destinationManager, fixture.model, "task37-destination");
    const destinationFile = destinationManager.getSessionFile();
    assert.ok(destinationFile && fs.existsSync(destinationFile));

    records.length = 0;
    blockedPrompt = "task37-resume-barrier";
    const acceptedBeforeResume = fixture.runtime.session.extensionRunner.emitInput(
      blockedPrompt,
      undefined,
      "interactive",
    );
    await waitFor(
      () => started().some(({ name }) => name === "user-prompt-submit"),
      "resume barrier prompt did not start",
    );
    let resumeSettled = false;
    const resume = fixture.runtime.switchSession(destinationFile).finally(() => {
      resumeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resumeSettled, false);
    assert.deepEqual(started().map(({ name }) => name), ["user-prompt-submit"]);
    releaseBlockedPrompt();
    await Promise.all([acceptedBeforeResume, resume]);
    assert.equal(fixture.runtime.session.sessionManager.getSessionId(), "task37-runtime-destination");
    assert.deepEqual(started().map(lineage), [
      {
        name: "user-prompt-submit",
        sessionId: "task37-runtime-source",
        source: undefined,
        toolName: undefined,
        input: undefined,
      },
      {
        name: "session-start",
        sessionId: "task37-runtime-destination",
        source: "resume",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: "task37-runtime-destination",
        source: undefined,
        toolName: "pi_session_lineage",
        input: { source: "resume" },
      },
    ]);

    records.length = 0;
    const reloadId = fixture.runtime.session.sessionManager.getSessionId();
    await fixture.runtime.session.reload();
    assert.equal(fixture.runtime.session.sessionManager.getSessionId(), reloadId);
    assert.deepEqual(started().map(lineage), [
      {
        name: "session-start",
        sessionId: reloadId,
        source: "reload",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: reloadId,
        source: undefined,
        toolName: "pi_session_lineage",
        input: { source: "reload" },
      },
    ]);

    for (let index = 0; index < 8; index += 1) {
      appendTask37Turn(
        fixture.runtime.session.sessionManager,
        fixture.model,
        `task37-compact-${index}`,
        12_000,
      );
    }
    records.length = 0;
    blockedPrompt = "task37-compact-barrier";
    const acceptedBeforeCompact = fixture.runtime.session.extensionRunner.emitInput(
      blockedPrompt,
      undefined,
      "interactive",
    );
    await waitFor(
      () => started().some(({ name }) => name === "user-prompt-submit"),
      "compact barrier prompt did not start",
    );
    let compactSettled = false;
    const compact = fixture.runtime.session.compact().finally(() => {
      compactSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compactSettled, false);
    releaseBlockedPrompt();
    await Promise.all([acceptedBeforeCompact, compact]);
    assert.equal(fixture.runtime.session.sessionManager.getSessionId(), reloadId);
    assert.equal(
      fixture.runtime.session.sessionManager.getBranch().at(-1)?.type,
      "compaction",
    );
    assert.deepEqual(started().map(lineage), [
      {
        name: "user-prompt-submit",
        sessionId: reloadId,
        source: undefined,
        toolName: undefined,
        input: undefined,
      },
      {
        name: "session-start",
        sessionId: reloadId,
        source: "compact",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: reloadId,
        source: undefined,
        toolName: "pi_session_lineage",
        input: { source: "compact" },
      },
    ]);

    records.length = 0;
    const parentId = fixture.runtime.session.sessionManager.getSessionId();
    const forkEntryId = fixture.runtime.session.sessionManager.getLeafId();
    assert.ok(forkEntryId);
    await fixture.runtime.fork(forkEntryId, { position: "at" });
    const childId = fixture.runtime.session.sessionManager.getSessionId();
    assert.notEqual(childId, parentId);
    assert.match(childId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(started().map(lineage), [
      {
        name: "session-start",
        sessionId: childId,
        source: "fork",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: childId,
        source: undefined,
        toolName: "pi_session_lineage",
        input: { source: "fork", parentSessionId: parentId },
      },
    ]);

    records.length = 0;
    const secondParentId = childId;
    const secondForkEntryId = fixture.runtime.session.sessionManager.getLeafId();
    assert.ok(secondForkEntryId);
    await fixture.runtime.fork(secondForkEntryId, { position: "at" });
    const grandchildId = fixture.runtime.session.sessionManager.getSessionId();
    assert.notEqual(grandchildId, secondParentId);
    assert.deepEqual(started().map(lineage), [
      {
        name: "session-start",
        sessionId: grandchildId,
        source: "fork",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: grandchildId,
        source: undefined,
        toolName: "pi_session_lineage",
        input: { source: "fork", parentSessionId: secondParentId },
      },
    ]);

    records.length = 0;
    await fixture.runtime.newSession();
    const newId = fixture.runtime.session.sessionManager.getSessionId();
    assert.notEqual(newId, grandchildId);
    assert.deepEqual(started().map(lineage), [
      {
        name: "session-start",
        sessionId: newId,
        source: "new",
        toolName: undefined,
        input: undefined,
      },
    ]);

    assert.equal(fixture.ui.notifications.length, 0);
    assert.deepEqual(fixture.extensionErrors, []);
    await fixture.runtime.dispose();
    disposed = true;
  } finally {
    if (!disposed) await fixture.runtime.dispose();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an aborted fork stage is replaced before the next valid fork", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  let sessionId = "task37-aborted-fork-parent";
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task37/aborted-fork",
    {
      sessionManager: {
        getHeader() { return null; },
        getSessionFile() { return `/task37/${sessionId}.jsonl`; },
        getSessionId() { return sessionId; },
      },
    },
  );
  const beforeFork = bridge.handlers.get("session_before_fork");
  const shutdown = bridge.handlers.get("session_shutdown");
  const start = bridge.handlers.get("session_start");
  try {
    await shutdown(
      { type: "session_shutdown", reason: "fork", targetSessionFile: "/task37/aborted-child.jsonl" },
      bridge.context,
    );

    sessionId = "task37-valid-fork-parent";
    await beforeFork(
      { type: "session_before_fork", entryId: "task37-entry", position: "at" },
      bridge.context,
    );
    await shutdown(
      { type: "session_shutdown", reason: "fork", targetSessionFile: "/task37/valid-child.jsonl" },
      bridge.context,
    );

    sessionId = "task37-valid-fork-child";
    await start({ type: "session_start", reason: "fork" }, bridge.context);
    assert.deepEqual(calls.map(({ name, payload }) => ({
      name,
      sessionId: payload.session_id,
      toolName: payload.toolName,
      input: payload.input,
    })), [
      {
        name: "session-start",
        sessionId: "task37-valid-fork-child",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: "task37-valid-fork-child",
        toolName: "pi_session_lineage",
        input: { source: "fork", parentSessionId: "task37-valid-fork-parent" },
      },
    ]);
  } finally {
    await shutdown({ type: "session_shutdown", reason: "reload" }, bridge.context).catch(() => undefined);
  }
});

test("initial CLI startup never reopens parentSession or invents fork/resume lineage", async () => {
  const { SessionManager } = await loadRuntimeModules();
  const { createCavememBridge } = await loadBridgeModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task37-initial-"));
  const cwd = path.join(root, "workspace");
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const parent = SessionManager.create(cwd, sessionsDir, { id: "task37-initial-parent" });
    appendTask37Turn(parent, { api: "anthropic-messages", provider: "anthropic", id: "task37-model" }, "initial-parent");
    const parentFile = parent.getSessionFile();
    assert.ok(parentFile && fs.existsSync(parentFile));
    const initialFork = SessionManager.forkFrom(
      parentFile,
      cwd,
      sessionsDir,
      { id: "task37-initial-child" },
    );
    const forkCalls = [];
    const forkBridge = bindTask36Bridge(
      createCavememBridge({ runHook: async (request) => { forkCalls.push(request); } }),
      cwd,
      { sessionManager: initialFork },
    );
    await forkBridge.handlers.get("session_start")(
      { type: "session_start", reason: "startup" },
      forkBridge.context,
    );
    assert.deepEqual(forkCalls.map(({ name, payload }) => ({
      name,
      sessionId: payload.session_id,
      source: payload.source,
      toolName: payload.toolName,
    })), [{
      name: "session-start",
      sessionId: "task37-initial-child",
      source: "startup",
      toolName: undefined,
    }]);

    const resumeCalls = [];
    const initialResume = SessionManager.open(parentFile, sessionsDir);
    const resumeBridge = bindTask36Bridge(
      createCavememBridge({ runHook: async (request) => { resumeCalls.push(request); } }),
      cwd,
      { sessionManager: initialResume },
    );
    await resumeBridge.handlers.get("session_start")(
      { type: "session_start", reason: "startup" },
      resumeBridge.context,
    );
    assert.deepEqual(resumeCalls.map(({ name, payload }) => ({
      name,
      source: payload.source,
      toolName: payload.toolName,
    })), [{ name: "session-start", source: "startup", toolName: undefined }]);

    const sensitive = "task37-parent-header-must-not-be-read";
    const noReadCalls = [];
    const noReadBridge = bindTask36Bridge(
      createCavememBridge({ runHook: async (request) => { noReadCalls.push(request); } }),
      cwd,
      {
        sessionManager: {
          getHeader() { throw new Error(sensitive); },
          getSessionFile() { return path.join(root, sensitive); },
          getSessionId() { return "task37-no-parent-read"; },
        },
      },
    );
    await noReadBridge.handlers.get("session_start")(
      { type: "session_start", reason: "startup" },
      noReadBridge.context,
    );
    assert.deepEqual(noReadCalls.map(({ name }) => name), ["session-start"]);
    assert.equal(JSON.stringify(noReadBridge.notifications).includes(sensitive), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic lineage IDs are deterministic, bounded, and isolated from actual tool correlation", async () => {
  const { createCavememBridge } = await loadBridgeModule();
  const calls = [];
  const bridge = bindTask36Bridge(
    createCavememBridge({ runHook: async (request) => { calls.push(request); } }),
    "/task37/synthetic-correlation",
    { sessionId: "task37-synthetic-session" },
  );
  const sessionStart = bridge.handlers.get("session_start");
  await sessionStart({ type: "session_start", reason: "reload" }, bridge.context);
  await sessionStart({ type: "session_start", reason: "reload" }, bridge.context);
  const synthetic = calls.filter(
    ({ name, payload }) => name === "post-tool-use" && payload.toolName === "pi_session_lineage",
  );
  assert.equal(synthetic.length, 2);
  const [reusedId, secondId] = synthetic.map(({ payload }) => payload.toolCallId);
  assert.match(reusedId, /^pi-synthetic-v1:pi_session_lineage:/);
  assert.match(secondId, /^pi-synthetic-v1:pi_session_lineage:/);
  assert.equal(reusedId, secondId);
  assert.ok(Buffer.byteLength(reusedId) <= 160);

  const input = { marker: "task37-real-tool-with-synthetic-id" };
  bridge.handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: reusedId,
    toolName: "pi_session_lineage",
    args: input,
  }, bridge.context);
  bridge.handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: reusedId,
    toolName: "pi_session_lineage",
    input,
  }, bridge.context);
  await bridge.handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: reusedId,
    toolName: "pi_session_lineage",
    input,
    content: [{ type: "text", text: "task37 actual tool result" }],
    details: { source: "actual-tool" },
    isError: false,
  }, bridge.context);

  const colliding = calls.filter(
    ({ name, payload }) => name === "post-tool-use" && payload.toolCallId === reusedId,
  );
  assert.equal(colliding.length, 3);
  assert.deepEqual(colliding[0].payload.input, { source: "reload" });
  assert.deepEqual(colliding[1].payload.input, { source: "reload" });
  assert.deepEqual(colliding[2].payload.input, input);
  assert.deepEqual(colliding[2].payload.output.details, { source: "actual-tool" });
  assert.deepEqual(bridge.notifications, []);
});

test("child attribution is atomic, bounded, exact-redacted, and ignored without its discriminator", () => {
  const valid = runTask37AttributionProbe("valid");
  try {
    assert.equal(valid.result.status, 0, valid.result.stderr);
    assert.ok(valid.report);
    assert.equal(valid.report.error, undefined);
    assert.equal(valid.report.accessorTouched, false);
    assert.deepEqual(valid.report.calls.map(({ name, payload }) => ({
      name,
      sessionId: payload.session_id,
      toolName: payload.toolName,
      input: payload.input,
    })), [
      {
        name: "session-start",
        sessionId: "task37-attribution-child",
        toolName: undefined,
        input: undefined,
      },
      {
        name: "post-tool-use",
        sessionId: "task37-attribution-child",
        toolName: "pi_child_attribution",
        input: {
          parentSessionId: `task37-parent-${task36Redacted}`,
          runId: "task37-run",
          agent: `task37-agent-${task36Redacted}`,
          childIndex: "7",
        },
      },
    ]);
    assert.equal(`${valid.result.stdout}\n${valid.result.stderr}`.includes(task36Token), false);
    assert.equal(`${valid.result.stdout}\n${valid.result.stderr}`.includes(task36LaunchId), false);
  } finally {
    fs.rmSync(valid.root, { recursive: true, force: true });
  }

  const canonicalKeys = runTask37AttributionProbe("canonical-envelope-token", {
    SHOPIFY_PI_TOKEN: "schemaVersion",
  });
  try {
    assert.equal(canonicalKeys.result.status, 0, canonicalKeys.result.stderr);
    assert.equal(canonicalKeys.report.error, undefined);
    const request = canonicalKeys.report.calls.find(
      ({ payload }) => payload.toolName === "pi_child_attribution",
    );
    assert.ok(request);
    assert.deepEqual(Object.keys(request.payload).sort(), [
      "input",
      "output",
      "schemaVersion",
      "session_id",
      "toolCallId",
      "toolName",
    ]);
    assert.deepEqual(Object.keys(request.payload.input).sort(), [
      "agent",
      "childIndex",
      "parentSessionId",
      "runId",
    ]);
    assert.deepEqual(Object.keys(request.payload.output).sort(), [
      "content",
      "details",
      "isError",
    ]);
    const actualTool = canonicalKeys.report.calls.find(
      ({ payload }) => payload.toolCallId === "task37-canonical-call",
    );
    assert.ok(actualTool);
    assert.deepEqual(Object.keys(actualTool.payload).sort(), [
      "input",
      "output",
      "schemaVersion",
      "session_id",
      "toolCallId",
      "toolName",
    ]);
    assert.deepEqual(actualTool.payload.input, {
      [task36Redacted]: "task37 caller-owned key",
    });
    assert.deepEqual(actualTool.payload.output.details, {
      [task36Redacted]: "task37 caller-owned details",
    });
  } finally {
    fs.rmSync(canonicalKeys.root, { recursive: true, force: true });
  }

  const canonicalToolKeys = runTask37AttributionProbe("canonical-envelope-token", {
    SHOPIFY_PI_TOKEN: "tool",
  });
  try {
    assert.equal(canonicalToolKeys.result.status, 0, canonicalToolKeys.result.stderr);
    assert.equal(canonicalToolKeys.report.error, undefined);
    const requests = canonicalToolKeys.report.calls.filter(({ name }) => name === "post-tool-use");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(Object.keys(request.payload).sort(), [
        "input",
        "output",
        "schemaVersion",
        "session_id",
        "toolCallId",
        "toolName",
      ]);
    }
  } finally {
    fs.rmSync(canonicalToolKeys.root, { recursive: true, force: true });
  }

  const postRedactionOverflow = runTask37AttributionProbe("post-redaction-overflow", {
    SHOPIFY_PI_TOKEN: "x",
  });
  try {
    assert.equal(postRedactionOverflow.result.status, 0, postRedactionOverflow.result.stderr);
    assert.match(postRedactionOverflow.report.error, /hook=post-tool-use, kind=attribution/);
    assert.deepEqual(
      postRedactionOverflow.report.calls.map(({ name }) => name),
      ["session-start"],
    );
  } finally {
    fs.rmSync(postRedactionOverflow.root, { recursive: true, force: true });
  }

  const postRedactionAggregate = runTask37AttributionProbe("post-redaction-aggregate", {
    SHOPIFY_PI_TOKEN: "x",
  });
  try {
    assert.equal(postRedactionAggregate.result.status, 0, postRedactionAggregate.result.stderr);
    assert.match(postRedactionAggregate.report.error, /hook=post-tool-use, kind=attribution/);
    assert.deepEqual(
      postRedactionAggregate.report.calls.map(({ name }) => name),
      ["session-start"],
    );
  } finally {
    fs.rmSync(postRedactionAggregate.root, { recursive: true, force: true });
  }

  const dynamicKeyOverflow = runTask37AttributionProbe("dynamic-key-overflow", {
    SHOPIFY_PI_TOKEN: "x",
  });
  try {
    assert.equal(dynamicKeyOverflow.result.status, 0, dynamicKeyOverflow.result.stderr);
    assert.match(dynamicKeyOverflow.report.error, /hook=post-tool-use, kind=malformed/);
    assert.equal(
      dynamicKeyOverflow.report.calls.some(
        ({ payload }) => payload.toolCallId === "task37-dynamic-key-overflow",
      ),
      false,
    );
  } finally {
    fs.rmSync(dynamicKeyOverflow.root, { recursive: true, force: true });
  }

  const dynamicKeyCollision = runTask37AttributionProbe("dynamic-key-collision", {
    SHOPIFY_PI_TOKEN: "schemaVersion",
  });
  try {
    assert.equal(dynamicKeyCollision.result.status, 0, dynamicKeyCollision.result.stderr);
    assert.match(dynamicKeyCollision.report.error, /hook=post-tool-use, kind=malformed/);
    assert.equal(
      dynamicKeyCollision.report.calls.some(
        ({ payload }) => payload.toolCallId === "task37-dynamic-key-collision",
      ),
      false,
    );
  } finally {
    fs.rmSync(dynamicKeyCollision.root, { recursive: true, force: true });
  }

  const reloadAndNew = runTask37AttributionProbe("startup-reload-new-id");
  try {
    assert.equal(reloadAndNew.result.status, 0, reloadAndNew.result.stderr);
    assert.equal(reloadAndNew.report.error, undefined);
    const attributions = reloadAndNew.report.calls.filter(
      ({ payload }) => payload.toolName === "pi_child_attribution",
    );
    assert.deepEqual(
      attributions.map(({ payload }) => payload.session_id),
      ["task37-attribution-child", "task37-attribution-child-next"],
    );
    assert.equal(new Set(attributions.map(({ payload }) => payload.toolCallId)).size, 2);
    for (const { payload } of attributions) {
      assert.match(payload.toolCallId, /^pi-synthetic-v1:pi_child_attribution:[0-9a-f]{64}$/);
      assert.ok(Buffer.byteLength(payload.toolCallId) <= 128);
    }
  } finally {
    fs.rmSync(reloadAndNew.root, { recursive: true, force: true });
  }

  const boundedEviction = runTask37AttributionProbe("attribution-eviction");
  try {
    assert.equal(boundedEviction.result.status, 0, boundedEviction.result.stderr);
    assert.equal(boundedEviction.report.error, undefined);
    const attributions = boundedEviction.report.calls.filter(
      ({ payload }) => payload.toolName === "pi_child_attribution",
    );
    assert.equal(attributions.length, 258);
    const ids = attributions.map(({ payload }) => payload.toolCallId);
    assert.equal(new Set(ids).size, 257);
    assert.equal(ids[0], ids.at(-1));
  } finally {
    fs.rmSync(boundedEviction.root, { recursive: true, force: true });
  }

  const customRunnerWithoutDataDir = runTask37AttributionProbe("valid", {
    CAVEMEM_DATA_DIR: undefined,
  });
  try {
    assert.equal(customRunnerWithoutDataDir.result.status, 0, customRunnerWithoutDataDir.result.stderr);
    assert.equal(customRunnerWithoutDataDir.report.error, undefined);
    assert.deepEqual(
      customRunnerWithoutDataDir.report.calls.map(({ name }) => name),
      ["session-start", "post-tool-use"],
    );
  } finally {
    fs.rmSync(customRunnerWithoutDataDir.root, { recursive: true, force: true });
  }

  const absent = runTask37AttributionProbe("absent-with-hostile-extras");
  try {
    assert.equal(absent.result.status, 0, absent.result.stderr);
    assert.equal(absent.report.accessorTouched, false);
    assert.equal(absent.report.error, undefined);
    assert.deepEqual(absent.report.calls.map(({ name }) => name), ["session-start"]);
  } finally {
    fs.rmSync(absent.root, { recursive: true, force: true });
  }

  const malicious = "task37-malformed-attribution-sensitive-value";
  for (const mode of [
    "partial",
    "mismatch",
    "bad-index",
    "overlong",
    "accessor",
    "nonstring",
  ]) {
    const fixture = runTask37AttributionProbe(mode, {
      TASK37_MALICIOUS_ATTRIBUTION: malicious,
    });
    try {
      assert.equal(fixture.result.status, 0, fixture.result.stderr);
      assert.match(fixture.report.error, /hook=post-tool-use, kind=attribution/);
      assert.deepEqual(fixture.report.calls.map(({ name }) => name), ["session-start"]);
      assert.equal(JSON.stringify(fixture.report).includes(malicious), false);
      assert.equal(`${fixture.result.stdout}\n${fixture.result.stderr}`.includes(malicious), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("production hook and inherited worker receive exactly the managed scrubbed environment", () => {
  const runtime = buildRuntimePaths();
  const contract = getTask37PolicyContract();
  assert.deepEqual(contract.allowlist, task37AllowedEnvironmentNames);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cavemem-task37-environment-"));
  const dataDir = path.join(root, "cavemem");
  const outputPath = path.join(dataDir, "environment-records.jsonl");
  const safeValues = {
    CAVEMEM_DATA_DIR: dataDir,
    COLORTERM: "truecolor",
    HOME: path.join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    LOGNAME: "task37",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TERM: "xterm-256color",
    TERM_PROGRAM: "task37-terminal",
    TMPDIR: path.join(root, "tmp"),
    USER: "task37",
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  };
  for (const name of [
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "CAVEMEM_DATA_DIR",
  ]) {
    fs.mkdirSync(safeValues[name], { recursive: true });
  }
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    `${JSON.stringify(completeCavememSettings(dataDir), null, 2)}\n`,
  );
  const command = writeExecutable(
    root,
    "task37-hook-worker-environment.mjs",
    `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const output = path.join(process.env.CAVEMEM_DATA_DIR, "environment-records.jsonl");
if (process.argv[2] === "--worker") {
  fs.appendFileSync(output, JSON.stringify({ role: "worker", hook: process.argv[3], environment: process.env }) + "\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.once("end", () => {
  const hook = process.argv[4];
  fs.appendFileSync(output, JSON.stringify({ role: "hook", hook, args: process.argv.slice(2), environment: process.env, payload: JSON.parse(input) }) + "\\n");
  const worker = spawnSync(process.execPath, [process.argv[1], "--worker", hook], { stdio: "ignore" });
  process.exit(worker.status ?? 1);
});`,
  );
  const forbidden = "task37-forbidden-child-environment-value";
  const sensitiveEnvironment = Object.fromEntries(
    contract.sensitiveNames.map((name) => [name, forbidden]),
  );
  const parentSessionId = `task37-environment-parent-${task36Token}`;
  const probeEnvironment = task37ProbeEnvironment(dataDir, {
    ...safeValues,
    ...sensitiveEnvironment,
    ANTHROPIC_API_KEY: forbidden,
    NODE_OPTIONS: "--no-warnings",
    NODE_PATH: forbidden,
    PI_AGENT_BASH_TIMEOUT_MS: forbidden,
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: parentSessionId,
    PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: parentSessionId,
    PI_SUBAGENT_RUN_ID: "task37-environment-run",
    PI_SUBAGENT_CHILD_AGENT: `task37-environment-agent-${task36LaunchId}`,
    PI_SUBAGENT_CHILD_INDEX: "4",
    SHOPIFY_PI_TOKEN: task36Token,
    PI_AGENT_LAUNCH_ID: task36LaunchId,
    TASK37_UNLISTED: forbidden,
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtime.extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(runtime.extensions, manifest.extensions.cavemem.entryPath);
  const result = childProcess.spawnSync(
    process.execPath,
    [task37EnvironmentProbePath, runtime.pi, extensionPath, command],
    { encoding: "utf8", env: probeEnvironment },
  );
  try {
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, undefined);
    assert.deepEqual(report.notifications, []);
    const records = fs.readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.deepEqual(records.map(({ role, hook }) => ({ role, hook })), [
      { role: "hook", hook: "session-start" },
      { role: "worker", hook: "session-start" },
      { role: "hook", hook: "post-tool-use" },
      { role: "worker", hook: "post-tool-use" },
    ]);
    for (const record of records) {
      const environment = { ...record.environment };
      if (process.platform === "darwin") delete environment.__CF_USER_TEXT_ENCODING;
      assert.deepEqual(environment, safeValues);
      assert.equal(environment.CAVEMEM_DATA_DIR, dataDir);
      for (const name of [
        ...contract.sensitiveNames,
        "CAVEMEM_NO_AUTOSTART",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PI_AGENT_BASH_TIMEOUT_MS",
        "PI_SUBAGENT_CHILD",
        "PI_SUBAGENT_PARENT_SESSION",
        "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
        "PI_SUBAGENT_RUN_ID",
        "PI_SUBAGENT_CHILD_AGENT",
        "PI_SUBAGENT_CHILD_INDEX",
        "TASK37_UNLISTED",
      ]) {
        assert.equal(Object.hasOwn(record.environment, name), false, name);
      }
    }
    const attribution = records.find(
      ({ role, payload }) => role === "hook" && payload?.toolName === "pi_child_attribution",
    );
    assert.ok(attribution);
    assert.deepEqual(attribution.payload.input, {
      parentSessionId: `task37-environment-parent-${task36Redacted}`,
      runId: "task37-environment-run",
      agent: `task37-environment-agent-${task36Redacted}`,
      childIndex: "4",
    });
    const output = `${result.stdout}\n${result.stderr}\n${fs.readFileSync(outputPath, "utf8")}`;
    for (const value of [forbidden, task36Token, task36LaunchId]) {
      assert.equal(output.includes(value), false);
    }

    const recordsBeforeMissingDataDir = fs.readFileSync(outputPath, "utf8");
    const missingDataDirEnvironment = { ...probeEnvironment };
    delete missingDataDirEnvironment.CAVEMEM_DATA_DIR;
    const missingDataDir = childProcess.spawnSync(
      process.execPath,
      [task37EnvironmentProbePath, runtime.pi, extensionPath, command],
      { encoding: "utf8", env: missingDataDirEnvironment },
    );
    assert.equal(missingDataDir.status, 0, missingDataDir.stderr);
    const missingReport = JSON.parse(missingDataDir.stdout);
    assert.match(missingReport.error, /hook=session-start, kind=environment/);
    assert.equal(missingReport.notifications.length, 0);
    assert.equal(fs.readFileSync(outputPath, "utf8"), recordsBeforeMissingDataDir);
    for (const value of [forbidden, task36Token, task36LaunchId]) {
      assert.equal(`${missingDataDir.stdout}\n${missingDataDir.stderr}`.includes(value), false);
    }

    const relativeSpawnMarker = path.join(root, "relative-runner-spawned");
    const relativeCommand = writeExecutable(
      root,
      "task37-relative-data-dir.mjs",
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(relativeSpawnMarker)}, "spawned");
process.stdin.once("end", () => process.exit(0));
process.stdin.resume();`,
    );
    const relativeDataDir = childProcess.spawnSync(
      process.execPath,
      [task37EnvironmentProbePath, runtime.pi, extensionPath, relativeCommand],
      {
        encoding: "utf8",
        env: { ...probeEnvironment, CAVEMEM_DATA_DIR: "relative/cavemem" },
      },
    );
    assert.equal(relativeDataDir.status, 0, relativeDataDir.stderr);
    const relativeReport = JSON.parse(relativeDataDir.stdout);
    assert.match(relativeReport.error, /hook=session-start, kind=environment/);
    assert.deepEqual(relativeReport.notifications, []);
    assert.equal(fs.existsSync(relativeSpawnMarker), false);
    assertTreeValueFree(root, [forbidden, task36Token, task36LaunchId]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real Cavemem keeps new, resume, and fork sessions resumable until terminal quit", { timeout: 900_000 }, async () => {
  const { createCavememBridge } = await loadBridgeModule();
  resetTask37ManagedDataDir();
  const bind = (sessionId) => bindTask36Bridge(
    createCavememBridge(),
    task37ManagedRoot,
    { sessionId },
  );
  const source = bind("task37-resumable-source");
  const destination = bind("task37-resumable-destination");
  const child = bind("task37-resumable-child");
  const next = bind("task37-resumable-next");

  await source.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    source.context,
  );
  await source.handlers.get("input")(
    { type: "input", text: "task37 source accepted before resume", source: "interactive" },
    source.context,
  );
  await source.handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "resume" },
    source.context,
  );
  await destination.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    destination.context,
  );

  await destination.handlers.get("session_before_fork")(
    { type: "session_before_fork", entryId: "task37-entry", position: "at" },
    destination.context,
  );
  await destination.handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "fork" },
    destination.context,
  );
  await child.handlers.get("session_start")(
    { type: "session_start", reason: "fork" },
    child.context,
  );
  await child.handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    child.context,
  );
  await next.handlers.get("session_start")(
    { type: "session_start", reason: "new" },
    next.context,
  );

  const expectedOpen = [
    "task37-resumable-child",
    "task37-resumable-destination",
    "task37-resumable-next",
    "task37-resumable-source",
  ].map((id) => ({ id, ended: 0 }));
  assert.deepEqual(
    queryRows(
      task37ManagedDataDir,
      "SELECT id, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id",
    ),
    expectedOpen,
  );

  await next.handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    next.context,
  );
  assert.deepEqual(
    queryRows(
      task37ManagedDataDir,
      "SELECT id, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id",
    ),
    expectedOpen.map((row) => row.id === "task37-resumable-next"
      ? { ...row, ended: 1 }
      : row),
  );
  for (const bridge of [source, destination, child, next]) {
    assert.deepEqual(bridge.notifications, []);
  }
});

test("child attribution survives shutdown and is searchable through a hermetic mcpproxy Cavemem upstream", { timeout: 900_000 }, async () => {
  const runtime = buildRuntimePaths();
  resetTask37ManagedDataDir();
  const marker = "task37-mcpproxy-attribution-marker";
  const childId = "task37-production-child";
  const parentSessionId = `task37-production-parent-${task36Token}`;
  const previous = Object.fromEntries([
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_PARENT_SESSION",
    "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
    "PI_SUBAGENT_RUN_ID",
    "PI_SUBAGENT_CHILD_AGENT",
    "PI_SUBAGENT_CHILD_INDEX",
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: parentSessionId,
    PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: parentSessionId,
    PI_SUBAGENT_RUN_ID: marker,
    PI_SUBAGENT_CHILD_AGENT: `task37-production-agent-${task36LaunchId}`,
    PI_SUBAGENT_CHILD_INDEX: "3",
  });
  let fixture;
  let proxyResult;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtime.extensions, "share/pi-agent/extensions.json"), "utf8"),
    );
    fixture = await createSession({
      id: childId,
      extensionPath: path.join(runtime.extensions, manifest.extensions.cavemem.entryPath),
      assistantTexts: ["task37 shutdown flush response"],
    });
    await fixture.session.reload();
    await fixture.session.prompt("task37 shutdown flush prompt");
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
    fixture = undefined;

    const rows = queryRows(
      task37ManagedDataDir,
      "SELECT session_id, kind, content, metadata FROM observations ORDER BY id",
    );
    const attributions = rows.filter((row) => {
      const metadata = JSON.parse(row.metadata ?? "null");
      return metadata?.tool === "pi_child_attribution";
    });
    assert.equal(attributions.length, 1, JSON.stringify(rows));
    const [attribution] = attributions;
    assert.equal(attribution.session_id, childId);
    assert.equal(attribution.kind, "tool_use");
    const attributionContent = JSON.parse(attribution.content);
    assert.match(
      attributionContent.toolCallId,
      /^pi-synthetic-v1:pi_child_attribution:[0-9a-f]{64}$/,
    );
    assert.deepEqual(attributionContent.input, {
      parentSessionId: `task37-production-parent-${task36Redacted}`,
      runId: marker,
      agent: `task37-production-agent-${task36Redacted}`,
      childIndex: "3",
    });
    assert.deepEqual(
      queryRows(
        task37ManagedDataDir,
        "SELECT id, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id",
      ),
      [{ id: childId, ended: 1 }],
    );

    proxyResult = await searchThroughLocalMcpproxy(task37ManagedDataDir, marker);
    assert.match(proxyResult.discovered, /cavemem:search/);
    assert.match(proxyResult.search, new RegExp(marker));
    assert.match(proxyResult.search, new RegExp(childId));
    const status = childProcess.spawnSync(
      path.join(runtime.lifecycle, "bin/cavemem"),
      ["status"],
      {
        encoding: "utf8",
        env: { ...task37EnvironmentCapability.environment },
      },
    );
    assert.equal(status.status, 0, status.stderr);
    const observable = [
      status.stdout,
      status.stderr,
      proxyResult.stdout,
      proxyResult.stderr,
      proxyResult.search,
    ].join("\n");
    for (const value of [task36Token, task36LaunchId]) {
      assert.equal(observable.includes(value), false);
    }
    assertTreeValueFree(task37ManagedDataDir, [task36Token, task36LaunchId]);
    assertTreeValueFree(proxyResult.root, [task36Token, task36LaunchId]);
  } finally {
    if (fixture) fixture.session.dispose();
    if (proxyResult?.root) fs.rmSync(proxyResult.root, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

test("every Jiti load requires a descriptor-safe Cavemem environment capability", () => {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  for (const [mode, message] of [
    ["missing-environment", /Cavemem process environment is unavailable/],
    ["malformed-environment", /Cavemem process environment is malformed/],
    ["relative-environment", /hook=session-start, kind=environment/],
    ["nul-environment", /hook=session-start, kind=environment/],
  ]) {
    const result = childProcess.spawnSync(
      process.execPath,
      [task36LoaderProbePath, pi, extensionPath, mode],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.firstLoaded, 0);
    assert.equal(report.firstErrors.length, 1);
    assert.match(report.firstErrors[0].error, message);
    assert.equal(report.accessorTouched, false);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes("task37 malformed environment accessor"), false);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes("task37 malformed environment toJSON"), false);
  }
});

test("preclaimed or malformed loader-stable bridge state fails value-free without accessors", () => {
  const { pi, extensions } = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  const extensionPath = path.join(extensions, manifest.extensions.cavemem.entryPath);
  for (const mode of ["preclaimed-state", "malformed-state"]) {
    const result = childProcess.spawnSync(
      process.execPath,
      [task36LoaderProbePath, pi, extensionPath, mode],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.firstLoaded, 0);
    assert.equal(report.firstErrors.length, 1);
    assert.match(
      report.firstErrors[0].error,
      /Cavemem (?:lineage stage|bridge runtime state) is malformed/,
    );
    assert.equal(report.accessorTouched, false);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes("task37 preclaimed state accessor"), false);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes("task37 malformed state accessor"), false);
  }
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
        CAVEMEM_DATA_DIR: task37ManagedDataDir,
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
