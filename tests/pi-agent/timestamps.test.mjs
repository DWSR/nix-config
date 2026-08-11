import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const stampEntryType = "pi-stamp";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let runtimePaths;
let runtimeModules;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-timestamp-tests";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
    in
      ${body}
  `;
}

function buildRuntimePaths() {
  if (runtimePaths) return runtimePaths;
  if (process.env.PI_AGENT_TEST_PI_PATH && process.env.PI_AGENT_TEST_EXTENSIONS_PATH) {
    runtimePaths = {
      pi: process.env.PI_AGENT_TEST_PI_PATH,
      extensions: process.env.PI_AGENT_TEST_EXTENSIONS_PATH,
    };
    return runtimePaths;
  }

  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression("[ pkgs.pi-agent pkgs.pi-agent-extensions ]"),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, 2, `expected Pi and extension outputs, got ${outputs.join(", ")}`);
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) =>
      fs.existsSync(path.join(output, "share/pi-agent/extensions.json")),
    ),
  };
  assert.match(runtimePaths.pi ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.extensions ?? "", /^\/nix\/store\//);
  return runtimePaths;
}

async function loadRuntimeModules() {
  if (runtimeModules) return runtimeModules;
  const runtime = buildRuntimePaths();
  const nodeModules = path.join(runtime.pi, "lib/node_modules");
  const codingAgent = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js"))
  );
  const ai = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js")));
  const streams = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/utils/event-stream.js"))
  );
  runtimeModules = { ...codingAgent, ...ai, ...streams };
  return runtimeModules;
}

function createUi() {
  const notifications = [];
  return {
    notifications,
    context: {
      async select() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
      async editor() {
        return undefined;
      },
      async custom() {
        return undefined;
      },
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
      onTerminalInput() {
        return () => {};
      },
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
      getEditorText() {
        return "";
      },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() {
        return undefined;
      },
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: false, error: "unavailable in fixture" };
      },
      getToolsExpanded() {
        return false;
      },
      setToolsExpanded() {},
      theme: {},
    },
  };
}

function assistantMessage(model, text, timestamp) {
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
    timestamp,
  };
}

async function createSession(options = {}) {
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
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-timestamps-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.ANTHROPIC_API_KEY = "timestamp-test-key";

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const stampExtensionPath = path.join(
    runtime.extensions,
    "lib/node_modules/@narumitw/pi-stamp/src/index.ts",
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [stampExtensionPath],
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
  const sessionManager =
    options.sessionFile === undefined
      ? SessionManager.create(cwd, sessionsDir, { id: "timestamp-fixture" })
      : SessionManager.open(options.sessionFile, sessionsDir, cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    sessionStartEvent: {
      type: "session_start",
      reason: options.reason ?? (options.sessionFile ? "resume" : "startup"),
      ...(options.sessionFile ? { previousSessionFile: options.sessionFile } : {}),
    },
  });
  const ui = createUi();
  const extensionErrors = [];
  await session.bindExtensions({
    uiContext: ui.context,
    mode: "tui",
    onError(error) {
      extensionErrors.push(error);
    },
  });

  const providerMessageSnapshots = [];
  session.agent.streamFunction = (activeModel, context) => {
    providerMessageSnapshots.push(JSON.stringify(context.messages));
    const message = assistantMessage(
      activeModel,
      options.assistantText ?? "Timestamp response fixture",
      options.assistantTimestamp ?? Date.now(),
    );
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  return {
    root,
    session,
    sessionFile: session.sessionFile,
    ui,
    extensionErrors,
    providerMessageSnapshots,
  };
}

function stampEntries(session) {
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === stampEntryType)
    .map((entry) => structuredClone(entry));
}

function stampIdentities(entries) {
  return entries.map(({ data }) => ({ role: data?.role, timestamp: data?.timestamp }));
}

function readPersistedStampEntries(sessionFile) {
  return fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "custom" && entry.customType === stampEntryType);
}

function renderStampRows(session, entries) {
  const renderer = session.extensionRunner.getEntryRenderer(stampEntryType);
  if (!renderer) return [];
  const theme = { fg: (_color, text) => text };
  return entries.flatMap((entry) => {
    const component = renderer(entry, { expanded: false }, theme);
    if (!component) return [];
    return component
      .render(80)
      .map((line) => stripVTControlCharacters(line).trim())
      .filter(Boolean);
  });
}

function ordinaryMessages(session) {
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter((message) => message.role === "user" || message.role === "assistant");
}

function messageContent(messages) {
  return messages.map(({ role, content }) => ({ role, content }));
}

function containsStampText(text, expectedRows) {
  return text.includes(stampEntryType) || expectedRows.some((row) => text.includes(row));
}

function contextSnapshot(session, expectedRows) {
  const messages = ordinaryMessages(session);
  const messageBytes = JSON.stringify(messages);
  const contextBytes = JSON.stringify(session.sessionManager.buildSessionContext().messages);
  return {
    matchesMessageEntries: contextBytes === messageBytes,
    content: messageContent(JSON.parse(contextBytes)),
    containsStampText: containsStampText(contextBytes, expectedRows),
  };
}

function transcriptOrder(session) {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      return [`message:${entry.message.role}`];
    }
    if (entry.type === "custom" && entry.customType === stampEntryType) {
      return [`stamp:${entry.data?.role}`];
    }
    return [];
  });
}

function localTimeLabel(timestamp) {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function installForbiddenEffectGuard() {
  const calls = [];
  const restorers = [];
  const patch = (target, property, label) => {
    const original = target[property];
    if (typeof original !== "function") return;
    target[property] = function forbiddenEffect(..._args) {
      calls.push(label);
      throw new Error(`forbidden timestamp extension effect: ${label}`);
    };
    restorers.push(() => {
      target[property] = original;
    });
  };

  for (const property of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
    patch(childProcess, property, `child_process.${property}`);
  }
  for (const [module, properties, name] of [
    [http, ["get", "request"], "http"],
    [https, ["get", "request"], "https"],
    [http2, ["connect"], "http2"],
    [net, ["connect", "createConnection"], "net"],
    [tls, ["connect"], "tls"],
    [dgram, ["createSocket"], "dgram"],
    [dns, ["lookup", "resolve", "resolve4", "resolve6"], "dns"],
  ]) {
    for (const property of properties) patch(module, property, `${name}.${property}`);
  }
  patch(globalThis, "fetch", "global.fetch");
  patch(globalThis, "WebSocket", "global.WebSocket");
  patch(globalThis, "EventSource", "global.EventSource");

  return {
    calls,
    restore() {
      for (const restore of restorers.reverse()) restore();
    },
  };
}

async function shutdown(session, reason = "quit") {
  await session.extensionRunner.emit({ type: "session_shutdown", reason });
  session.dispose();
}

test("pinned timestamp extension source has only presentation and local settings effects", () => {
  const runtime = buildRuntimePaths();
  const packageRoot = path.join(
    runtime.extensions,
    "lib/node_modules/@narumitw/pi-stamp",
  );
  const sourceRoot = path.join(packageRoot, "src");
  const source = fs
    .readdirSync(sourceRoot)
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => fs.readFileSync(path.join(sourceRoot, entry), "utf8"))
    .join("\n");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

  assert.equal(packageJson.name, "@narumitw/pi-stamp");
  assert.equal(packageJson.version, "0.49.3");
  assert.deepEqual(packageJson.dependencies, { "@narumitw/pi-tui-kit": "^0.49.1" });
  assert.doesNotMatch(
    source,
    /(?:from\s+|import\s*\(\s*)["'](?:node:)?(?:child_process|cluster|worker_threads|https?|http2|net|tls|dgram|dns)(?:\/[^"']*)?["']/u,
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|EventSource|spawn|spawnSync|exec|execFile|execFileSync|execSync|fork|connect|createConnection|request)\s*\(/u,
  );
  assert.doesNotMatch(source, /\b(?:telemetry|analytics|sentry|posthog|opentelemetry)\b/iu);
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|setImmediate|watch|watchFile)\s*\(/u);
  assert.doesNotMatch(source, /\.registerTool\s*\(/u);
});

test("real TUI timestamps remain local, persisted, and outside model context", async () => {
  const userText = "Timestamp request fixture";
  const assistantText = "Timestamp response fixture";
  const userTimestamp = Date.UTC(2024, 6, 1, 12, 34, 56);
  const assistantTimestamp = userTimestamp + 4_000;
  const expectedRows = [localTimeLabel(userTimestamp), localTimeLabel(assistantTimestamp)];
  const expectedContent = [
    { role: "user", content: [{ type: "text", text: userText }] },
    { role: "assistant", content: [{ type: "text", text: assistantText }] },
  ];
  const expectedContext = {
    matchesMessageEntries: true,
    content: expectedContent,
    containsStampText: false,
  };
  const expectedIdentities = [
    { role: "user", timestamp: userTimestamp },
    { role: "assistant", timestamp: assistantTimestamp },
  ];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const originalDateNow = Date.now;
  let initial;
  let resumed;
  let initialShutdown = false;
  let resumedShutdown = false;
  let actual;

  await loadRuntimeModules();
  const effectGuard = installForbiddenEffectGuard();
  try {
    Date.now = () => userTimestamp;
    initial = await createSession({ assistantText, assistantTimestamp });
    await initial.session.prompt(userText);
    await initial.session.waitForIdle();
    Date.now = originalDateNow;

    const freshEntries = stampEntries(initial.session);
    const freshSessionBytes = fs.readFileSync(initial.sessionFile, "utf8");
    const fresh = {
      rows: renderStampRows(initial.session, freshEntries),
      identities: stampIdentities(freshEntries),
      persistedIdentities: stampIdentities(readPersistedStampEntries(initial.sessionFile)),
      transcriptOrder: transcriptOrder(initial.session),
      context: contextSnapshot(initial.session, expectedRows),
    };

    await initial.session.reload();
    const reloadedEntries = stampEntries(initial.session);
    const reloadedSessionBytes = fs.readFileSync(initial.sessionFile, "utf8");
    const reloaded = {
      rows: renderStampRows(initial.session, reloadedEntries),
      identities: stampIdentities(reloadedEntries),
      dataMatchesFresh: JSON.stringify(reloadedEntries.map(({ data }) => data)) ===
        JSON.stringify(freshEntries.map(({ data }) => data)),
      sessionBytesMatchFresh: reloadedSessionBytes === freshSessionBytes,
      context: contextSnapshot(initial.session, expectedRows),
    };

    const { root, sessionFile } = initial;
    await shutdown(initial.session);
    initialShutdown = true;
    resumed = await createSession({
      root,
      sessionFile,
      reason: "resume",
      assistantText,
      assistantTimestamp,
    });
    const resumedEntries = stampEntries(resumed.session);
    const resumedSessionBytes = fs.readFileSync(sessionFile, "utf8");
    const resumedState = {
      rows: renderStampRows(resumed.session, resumedEntries),
      identities: stampIdentities(resumedEntries),
      persistedIdentities: stampIdentities(readPersistedStampEntries(sessionFile)),
      dataMatchesFresh: JSON.stringify(resumedEntries.map(({ data }) => data)) ===
        JSON.stringify(freshEntries.map(({ data }) => data)),
      sessionBytesMatchFresh: resumedSessionBytes === freshSessionBytes,
      context: contextSnapshot(resumed.session, expectedRows),
    };

    await shutdown(resumed.session);
    resumedShutdown = true;
    const providerMessageBytes = initial.providerMessageSnapshots[0] ?? "[]";
    actual = {
      fresh,
      reloaded,
      resumed: resumedState,
      providerContext: {
        content: messageContent(JSON.parse(providerMessageBytes)),
        containsStampText: containsStampText(providerMessageBytes, expectedRows),
      },
      extensionErrors: [...initial.extensionErrors, ...resumed.extensionErrors],
      notifications: [...initial.ui.notifications, ...resumed.ui.notifications],
      forbiddenEffects: [...effectGuard.calls],
    };
  } finally {
    Date.now = originalDateNow;
    if (resumed && !resumedShutdown) await shutdown(resumed.session);
    if (initial && !initialShutdown) await shutdown(initial.session);
    effectGuard.restore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    if (initial?.root) fs.rmSync(initial.root, { recursive: true, force: true });
  }

  assert.deepEqual(actual, {
    fresh: {
      rows: expectedRows,
      identities: expectedIdentities,
      persistedIdentities: expectedIdentities,
      transcriptOrder: ["message:user", "stamp:user", "message:assistant", "stamp:assistant"],
      context: expectedContext,
    },
    reloaded: {
      rows: expectedRows,
      identities: expectedIdentities,
      dataMatchesFresh: true,
      sessionBytesMatchFresh: true,
      context: expectedContext,
    },
    resumed: {
      rows: expectedRows,
      identities: expectedIdentities,
      persistedIdentities: expectedIdentities,
      dataMatchesFresh: true,
      sessionBytesMatchFresh: true,
      context: expectedContext,
    },
    providerContext: {
      content: expectedContent.slice(0, 1),
      containsStampText: false,
    },
    extensionErrors: [],
    notifications: [],
    forbiddenEffects: [],
  });
});
