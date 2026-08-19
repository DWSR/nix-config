import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [piRoot, extensionRoot] = process.argv.slice(2);
if (!piRoot || !extensionRoot) {
  throw new Error("usage: combined-loader-probe PI_ROOT EXTENSION_ROOT");
}

const trace = [];
Reflect.set(globalThis, Symbol.for("dwsr.pi-agent.managed-loader-trace.v1"), trace);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-combined-loader-probe-"));
const workspace = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
const dataDir = path.join(root, "cavemem");
const sessionsDir = path.join(root, "sessions");
for (const directory of [workspace, agentDir, dataDir, sessionsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
fs.writeFileSync(
  path.join(agentDir, "auth.json"),
  `${JSON.stringify({ anthropic: { type: "api_key", key: "combined-loader-model-stub" } })}\n`,
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(dataDir, "settings.json"),
  `${JSON.stringify({
    dataDir,
    workerPort: 37777,
    logLevel: "error",
    compression: { intensity: "full", expandForModel: true },
    embedding: {
      provider: "none",
      model: "combined-loader-probe",
      batchSize: 16,
      autoStart: false,
      idleShutdownMs: 60_000,
    },
    search: { alpha: 0.5, defaultLimit: 20 },
    privacy: { excludePatterns: [], redactSecrets: true },
    ides: {},
  })}\n`,
);

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

const environmentValues = {
  CAVEMEM_DATA_DIR: dataDir,
  HOME: root,
  LANG: "C",
  LC_ALL: "C",
  LC_CTYPE: "C",
  NO_COLOR: "1",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  SHELL: process.env.SHELL ?? "/bin/zsh",
  TERM: "xterm-256color",
  TMPDIR: root,
  USER: "combined-loader-probe",
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_RUNTIME_DIR: path.join(root, "runtime"),
  XDG_STATE_HOME: path.join(root, "state"),
};
for (const name of [
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]) {
  fs.mkdirSync(environmentValues[name], { recursive: true });
}
const environment = {};
for (const [name, value] of Object.entries(environmentValues)) {
  Object.defineProperty(environment, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}
Object.freeze(environment);
const environmentCapability = { schemaVersion: 1, environment };
Object.defineProperty(environmentCapability, "toJSON", {
  configurable: false,
  enumerable: false,
  value: Object.freeze(() => { throw new Error("Cavemem process environment is not serializable"); }),
  writable: false,
});
Object.freeze(environmentCapability);
Object.defineProperty(globalThis, Symbol.for("dwsr.pi-agent.cavemem-environment.v1"), {
  configurable: false,
  enumerable: false,
  value: environmentCapability,
  writable: false,
});

Object.assign(process.env, {
  ...environmentValues,
  PI_CODING_AGENT_DIR: agentDir,
  PI_AGENT_BASH_TIMEOUT_MS: "4100",
  PI_AGENT_LSP_EXECUTABLES: "{}",
});

const codingAgent = await import(pathToFileURL(
  path.join(piRoot, "lib/node_modules/@earendil-works/pi-coding-agent/index.js"),
));
const ai = await import(pathToFileURL(
  path.join(piRoot, "lib/node_modules/@earendil-works/pi-ai/compat.js"),
));
const streams = await import(pathToFileURL(
  path.join(piRoot, "lib/node_modules/@earendil-works/pi-ai/utils/event-stream.js"),
));
const settingsManager = codingAgent.SettingsManager.create(workspace, agentDir, {
  projectTrusted: true,
});
const loader = new codingAgent.DefaultResourceLoader({
  cwd: workspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [
    path.join(extensionRoot, "lib/pi-agent/extensions/managed-loader.ts"),
  ],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});

let thrown = null;
try {
  await loader.reload();
} catch (error) {
  thrown = error instanceof Error ? error.message : "non-error rejection";
}
const errors = loader.getExtensions().errors.map(({ error }) => error);
let modelCalls = 0;
const modelContext = [];
const modelTools = [];
const notifications = [];
const extensionErrors = [];
let session;
if (thrown === null && errors.length === 0) {
  const modelRuntime = await codingAgent.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = ai.getModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("reviewed Pi model fixture is unavailable");
  const sessionManager = codingAgent.SessionManager.create(workspace, sessionsDir, {
    id: "combined-loader-probe",
  });
  ({ session } = await codingAgent.createAgentSession({
    cwd: workspace,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  }));
  const uiContext = {
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
  };
  await session.bindExtensions({
    uiContext,
    mode: "tui",
    onError(error) {
      extensionErrors.push({
        error: error.error,
        event: error.event,
        extensionPath: error.extensionPath,
      });
    },
  });
  session.agent.streamFunction = (activeModel, context) => {
    modelCalls += 1;
    modelContext.push(JSON.stringify(context.messages));
    modelTools.push(session.getAllTools().map(({ name, description }) => ({ name, description })));
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "combined loader probe response" }],
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
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream = streams.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  try {
    await session.prompt("combined loader probe prompt");
    await session.waitForIdle();
  } catch (error) {
    thrown = error instanceof Error ? error.message : "non-error rejection";
  }
}
const report = {
  errors,
  extensionErrors,
  modelCalls,
  modelContext,
  modelTools,
  notifications,
  trace,
  sessionBranch: session?.sessionManager.getBranch().map((entry) => ({
    role: entry.message?.role,
    text: entry.message?.content
      ?.filter((content) => content.type === "text")
      .map((content) => content.text),
    type: entry.type,
  })) ?? [],
  thrown,
};
if (session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
fs.rmSync(root, { recursive: true, force: true });
fs.writeSync(process.stdout.fd, `${JSON.stringify(report)}\n`);
process.exit(0);
