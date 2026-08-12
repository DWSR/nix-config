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

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let runtimePaths;
let runtimeModules;
let toolCallSequence = 0;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-question-tests";
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

function questionPackageRoot() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@mrclrchtr/supi-ask-user",
  );
}

function questionExtensionPath() {
  return path.join(questionPackageRoot(), "src/extension.ts");
}

function applyEnvironment(overrides) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

class ControlledEditor {
  text = "";
  onChange;
  onSubmit;
  onEscape;

  render() {
    return [`CONTROLLED_EDITOR:${this.text}`];
  }

  invalidate() {}

  getText() {
    return this.text;
  }

  getExpandedText() {
    return this.text;
  }

  setText(value) {
    this.text = value;
  }

  handleInput(data) {
    if (data === "\r") {
      this.onSubmit?.(this.text);
      return;
    }
    if (data === "\u001b") {
      this.onEscape?.();
      return;
    }
    this.text += data;
    this.onChange?.(this.text);
  }
}

function createUi(interact, options = {}) {
  const editor = new ControlledEditor();
  const notifications = [];
  let customCalls = 0;
  let beforeResolve;
  let formStartedResolve;
  const formStarted = new Promise((resolve) => {
    formStartedResolve = resolve;
  });
  const tui = { requestRender() {} };
  const theme = new Proxy(
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      inverse: (text) => text,
    },
    { get: (target, property) => target[property] ?? ((text) => text) },
  );
  const keybindings = { matches: () => false };

  const context = {
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
    custom(factory) {
      customCalls += 1;
      return new Promise((resolve, reject) => {
        let component;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          beforeResolve?.(value);
          component?.dispose?.();
          resolve(value);
        };
        try {
          component = factory(tui, theme, keybindings, finish);
          formStartedResolve(component);
          if (interact) {
            queueMicrotask(() => {
              Promise.resolve(interact(component)).catch((error) => {
                component?.dispose?.();
                reject(error);
              });
            });
          }
        } catch (error) {
          reject(error);
        }
      });
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
      return options.useProductionEditor ? undefined : () => editor;
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
    theme,
  };

  return {
    context,
    editor,
    formStarted,
    notifications,
    setBeforeResolve(callback) {
      beforeResolve = callback;
    },
    usesProductionEditor: options.useProductionEditor === true,
    get customCalls() {
      return customCalls;
    },
  };
}

function press(...keys) {
  return (component) => {
    for (const key of keys) component.handleInput(key);
  };
}

function paste(text) {
  return `\u001b[200~${text}\u001b[201~`;
}

async function waitForForm(ui) {
  let timeout;
  try {
    return await Promise.race([
      ui.formStarted,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("ask_user form did not start")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant",
    content,
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
    ...(stopReason === "aborted" ? { errorMessage: "Request aborted by user" } : {}),
    timestamp: Date.now(),
  };
}

async function createSession(interact, options = {}) {
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createAssistantMessageEventStream,
    getModel,
  } = await loadRuntimeModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-questions-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const homeDir = path.join(root, "home");
  for (const directory of [cwd, agentDir, sessionsDir, homeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (options.globalSupiConfig) {
    writeJson(path.join(homeDir, ".pi/agent/supi/config.json"), options.globalSupiConfig);
  }
  if (options.projectSupiConfig) {
    writeJson(path.join(cwd, ".pi/supi/config.json"), options.projectSupiConfig);
  }
  if (options.projectTrusted) {
    writeJson(path.join(cwd, ".pi/settings.json"), {});
  }
  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    ANTHROPIC_API_KEY: "question-test-key",
  });

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: options.projectTrusted === true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [questionExtensionPath()],
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
    const sessionManager = SessionManager.create(cwd, sessionsDir, {
      id: `questions-${Date.now()}-${toolCallSequence}`,
    });
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
    const ui = createUi(interact, options);
    const extensionErrors = [];
    await session.bindExtensions({
      uiContext: ui.context,
      mode: "tui",
      onError(error) {
        extensionErrors.push(error);
      },
    });
    assert.deepEqual(extensionErrors, []);

    return {
      createAssistantMessageEventStream,
      restoreEnvironment,
      root,
      session,
      ui,
    };
  } catch (error) {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeSession(fixture) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
  } finally {
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function beginQuestionTurn(fixture, params) {
  toolCallSequence += 1;
  const toolCallId = `ask-user-${toolCallSequence}`;
  const streamObservations = [];
  let responseIndex = 0;
  fixture.session.agent.streamFunction = (model, context, options) => {
    streamObservations.push({
      signalAborted: options.signal?.aborted ?? false,
      toolNames: context.tools?.map(({ name }) => name) ?? [],
    });
    let message;
    if (options.signal?.aborted) {
      message = assistantMessage(model, [], "aborted");
    } else if (responseIndex++ === 0) {
      message = assistantMessage(
        model,
        [{ type: "toolCall", id: toolCallId, name: "ask_user", arguments: params }],
        "toolUse",
      );
    } else {
      message = assistantMessage(model, [{ type: "text", text: "question fixture complete" }], "stop");
    }
    const stream = fixture.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  return {
    promptPromise: fixture.session.prompt(`Run question fixture ${toolCallId}`),
    streamObservations,
    toolCallId,
  };
}

async function runQuestionTurn(fixture, params) {
  const turn = beginQuestionTurn(fixture, params);
  await turn.promptPromise;
  await fixture.session.waitForIdle();
  return finishQuestionTurn(fixture, turn);
}

function finishQuestionTurn(fixture, turn) {
  const branch = fixture.session.sessionManager.getBranch();
  const callIndex = branch.findIndex(
    (entry) =>
      entry.message?.role === "assistant" &&
      entry.message.content?.some(
        (item) => item.type === "toolCall" && item.id === turn.toolCallId,
      ),
  );
  assert.notEqual(callIndex, -1, `missing assistant call for ${turn.toolCallId}`);
  const entries = branch.slice(callIndex);
  const toolResult = entries.find(
    (entry) =>
      entry.message?.role === "toolResult" && entry.message.toolCallId === turn.toolCallId,
  )?.message;
  assert.ok(toolResult, `missing tool result for ${turn.toolCallId}`);
  return { ...turn, entries, toolResult };
}

function responseById(result, questionId) {
  const response = result.details.responses.find((candidate) => candidate.questionId === questionId);
  assert.ok(response, `missing response for ${questionId}`);
  return response;
}

function resultText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function installForbiddenEffectGuard() {
  const calls = [];
  const restorers = [];
  const patch = (target, property, label) => {
    const original = target[property];
    if (typeof original !== "function") return;
    target[property] = function forbiddenQuestionEffect(..._args) {
      calls.push(label);
      throw new Error(`forbidden question extension effect: ${label}`);
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

function sourceFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(child);
    }
  }
  return files.sort();
}

function simpleChoiceParams() {
  return {
    title: "Runtime selection",
    questions: [
      {
        type: "choice",
        id: "runtime",
        header: "Runtime",
        prompt: "Which runtime?",
        options: [
          { value: "node", label: "Node.js" },
          { value: "deno", label: "Deno" },
        ],
        recommendation: "deno",
      },
    ],
  };
}

function questionToolContract(session) {
  const definition = session.getToolDefinition("ask_user");
  assert.ok(definition, "ask_user was not registered outside Plan mode");
  return {
    description: definition.description,
    executionMode: definition.executionMode,
    label: definition.label,
    parameters: JSON.parse(JSON.stringify(definition.parameters)),
    promptGuidelines: definition.promptGuidelines,
    promptSnippet: definition.promptSnippet,
  };
}

function hostilePromptConfig(sentinel) {
  return {
    "ask-user": {
      tools: {
        ask_user: {
          promptSurface: {
            description: sentinel,
            promptGuidelines: [sentinel],
            promptSnippet: sentinel,
          },
        },
      },
    },
  };
}

function assertCancelledTurn(turn) {
  assert.equal(turn.toolResult.isError, true);
  assert.deepEqual(turn.toolResult.details, {});
  assert.match(resultText(turn.toolResult), /interaction was cancelled/i);
  const serialized = JSON.stringify(turn.entries);
  assert.doesNotMatch(serialized, /"outcome":"(?:submitted|needs_discussion)"/);
  assert.doesNotMatch(serialized, /"responses":/);
  assert.equal(
    turn.entries.some((entry) => entry.type === "custom" && entry.customType === "ask_user"),
    false,
  );
  const finalAssistant = turn.entries
    .filter((entry) => entry.message?.role === "assistant")
    .at(-1)?.message;
  assert.equal(finalAssistant?.stopReason, "aborted");
  assert.equal(turn.streamObservations.at(-1)?.signalAborted, true);
}

async function assertNoDecisionLabel(fixture, turn) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entry = fixture.session.sessionManager
    .getBranch()
    .find(
      (candidate) =>
        candidate.message?.role === "toolResult" &&
        candidate.message.toolCallId === turn.toolCallId,
    );
  assert.ok(entry, `missing persisted tool result for ${turn.toolCallId}`);
  assert.equal(fixture.session.sessionManager.getLabel(entry.id), undefined);
}

test("pinned question extension is explicit, outside Plan, and free of ambient effects", async () => {
  const packageRoot = questionPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const source = sourceFiles(path.join(packageRoot, "src"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const managedPlanSource = fs.readFileSync(
    path.join(
      buildRuntimePaths().extensions,
      "lib/node_modules/@narumitw/pi-plan-mode/src/managed-plan-mode.ts",
    ),
    "utf8",
  );
  const planNames = managedPlanSource.match(/const MANAGED_PLAN_TOOL_NAMES = \[(.*?)\] as const;/s)?.[1];

  assert.equal(packageJson.name, "@mrclrchtr/supi-ask-user");
  assert.equal(packageJson.version, "4.6.0");
  assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(packageJson.dependencies, { "@mrclrchtr/supi-core": "4.6.0" });
  assert.doesNotMatch(
    source,
    /(?:from\s+|import\s*\(\s*)["'](?:node:)?(?:child_process|cluster|worker_threads|https?|http2|net|tls|dgram|dns)(?:\/[^"']*)?["']/u,
  );
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|EventSource|spawn|execFile|execSync|fork)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:telemetry|analytics|sentry|posthog|opentelemetry)\b/iu);
  assert.doesNotMatch(source, /\b(?:discoverAndLoadExtensions|installPackage|npm\s+install)\b/u);
  assert.doesNotMatch(source, /resolveToolPromptSurface|notifyToolPromptSurfaceDiagnostics/u);
  assert.ok(planNames, "managed Plan tool-name contract is missing");
  assert.doesNotMatch(planNames, /ask_user/);

  const fixture = await createSession(press("\r", "\r"));
  try {
    assert.deepEqual(fixture.session.extensionRunner.getExtensionPaths(), [questionExtensionPath()]);
    assert.ok(fixture.session.getActiveToolNames().includes("ask_user"));
    const definition = fixture.session.getToolDefinition("ask_user");
    assert.ok(definition, "ask_user was not registered outside Plan mode");
    assert.equal(definition.executionMode, "sequential");
    assert.equal(definition.parameters.properties.questions.minItems, 1);
    assert.equal(definition.parameters.properties.questions.maxItems, 10);
  } finally {
    await closeSession(fixture);
  }
});

test("hostile global and trusted project Supi config cannot alter the managed tool contract", async () => {
  const baseline = await createSession();
  let expected;
  try {
    expected = questionToolContract(baseline.session);
  } finally {
    await closeSession(baseline);
  }

  for (const scope of ["global", "project"]) {
    const sentinel = `TASK_4_7_HOSTILE_${scope.toUpperCase()}_PROMPT`;
    const config = hostilePromptConfig(sentinel);
    const fixture = await createSession(undefined, {
      ...(scope === "global" ? { globalSupiConfig: config } : { projectSupiConfig: config }),
      projectTrusted: scope === "project",
    });
    try {
      const actual = questionToolContract(fixture.session);
      assert.deepEqual(actual, expected);
      assert.doesNotMatch(JSON.stringify(actual), new RegExp(sentinel));
      assert.deepEqual(fixture.ui.notifications, []);
    } finally {
      await closeSession(fixture);
    }
  }
});

test("single choice submits option identity and recommendation metadata through real Pi", async () => {
  buildRuntimePaths();
  const effectGuard = installForbiddenEffectGuard();
  let fixture;
  try {
    fixture = await createSession(press("\r", "\r"));
    const turn = await runQuestionTurn(fixture, simpleChoiceParams());
    assert.equal(turn.toolResult.isError, false);
    assert.equal(turn.toolResult.details.outcome, "submitted");
    assert.deepEqual(turn.toolResult.details.questions[0].recommendedIndexes, [1]);
    assert.deepEqual(responseById(turn.toolResult, "runtime").answer, {
      kind: "choice",
      answered: true,
      options: [{ value: "deno", label: "Deno", selected: true }],
    });
    assert.match(resultText(turn.toolResult), /Runtime: Deno/);
    assert.deepEqual(effectGuard.calls, []);
  } finally {
    effectGuard.restore();
    if (fixture) await closeSession(fixture);
  }
});

test("multiple choice preserves stable answer order and valid empty selection", async () => {
  const selectedFixture = await createSession(press("\r", "\r"));
  try {
    const turn = await runQuestionTurn(selectedFixture, {
      questions: [
        {
          type: "choice",
          id: "checks",
          header: "Checks",
          prompt: "Which checks?",
          multi: true,
          recommendation: ["format", "lint"],
          options: [
            { value: "lint", label: "Lint" },
            { value: "test", label: "Test" },
            { value: "format", label: "Format" },
          ],
        },
      ],
    });
    assert.deepEqual(turn.toolResult.details.questions[0].recommendedIndexes, [2, 0]);
    assert.deepEqual(responseById(turn.toolResult, "checks").answer, {
      kind: "choice",
      answered: true,
      options: [
        { value: "lint", label: "Lint", selected: true },
        { value: "format", label: "Format", selected: true },
      ],
    });
  } finally {
    await closeSession(selectedFixture);
  }

  const emptyFixture = await createSession(press("\r", "\r"));
  try {
    const turn = await runQuestionTurn(emptyFixture, {
      questions: [
        {
          type: "choice",
          id: "optional-checks",
          header: "Optional checks",
          prompt: "Select checks or leave unanswered.",
          multi: true,
          options: [
            { value: "lint", label: "Lint" },
            { value: "test", label: "Test" },
          ],
        },
      ],
    });
    assert.equal(turn.toolResult.details.outcome, "needs_discussion");
    assert.deepEqual(responseById(turn.toolResult, "optional-checks").answer, {
      kind: "choice",
      answered: false,
      options: [],
    });
  } finally {
    await closeSession(emptyFixture);
  }
});

test("production Pi editor preserves exact Unicode while empty and whitespace remain unanswered", async () => {
  const exactText = "  café 👩🏽‍💻\nline two  ";
  const exactFixture = await createSession(press(paste(exactText), "\r", "\r"), {
    useProductionEditor: true,
  });
  try {
    assert.equal(exactFixture.ui.usesProductionEditor, true);
    const turn = await runQuestionTurn(exactFixture, {
      questions: [
        { type: "text", id: "notes", header: "Notes", prompt: "Enter exact notes." },
      ],
    });
    assert.equal(turn.toolResult.details.outcome, "submitted");
    assert.deepEqual(responseById(turn.toolResult, "notes").answer, {
      kind: "text",
      answered: true,
      value: exactText,
    });
  } finally {
    await closeSession(exactFixture);
  }

  for (const [label, input] of [
    ["empty", ""],
    ["whitespace", " \t  "],
  ]) {
    const fixture = await createSession(press(paste(input), "\r", "\r"), {
      useProductionEditor: true,
    });
    try {
      const turn = await runQuestionTurn(fixture, {
        questions: [
          { type: "text", id: label, header: label, prompt: `Submit ${label} text.` },
        ],
      });
      assert.equal(turn.toolResult.details.outcome, "needs_discussion");
      assert.deepEqual(responseById(turn.toolResult, label).answer, {
        kind: "text",
        answered: false,
      });
    } finally {
      await closeSession(fixture);
    }
  }
});

test("mixed forms preserve question order and answer association", async () => {
  const fixture = await createSession(
    press(
      "\u001b[B",
      "\r",
      " ",
      "\u001b[B",
      " ",
      "\r",
      "exact Ω",
      "\r",
      "\r",
    ),
  );
  try {
    const turn = await runQuestionTurn(fixture, {
      title: "Mixed decision",
      questions: [
        {
          type: "choice",
          id: "runtime",
          header: "Runtime",
          prompt: "Choose one.",
          options: [
            { value: "node", label: "Node.js" },
            { value: "deno", label: "Deno" },
          ],
        },
        {
          type: "choice",
          id: "checks",
          header: "Checks",
          prompt: "Choose several.",
          multi: true,
          options: [
            { value: "lint", label: "Lint" },
            { value: "test", label: "Test" },
          ],
        },
        { type: "text", id: "notes", header: "Notes", prompt: "Add notes." },
      ],
    });
    assert.deepEqual(
      turn.toolResult.details.questions.map(({ id }) => id),
      ["runtime", "checks", "notes"],
    );
    assert.deepEqual(
      turn.toolResult.details.responses.map(({ questionId }) => questionId),
      ["runtime", "checks", "notes"],
    );
    assert.deepEqual(responseById(turn.toolResult, "runtime").answer.options, [
      { value: "deno", label: "Deno", selected: true },
    ]);
    assert.deepEqual(
      responseById(turn.toolResult, "checks").answer.options.map(({ value }) => value),
      ["lint", "test"],
    );
    assert.equal(responseById(turn.toolResult, "notes").answer.value, "exact Ω");
  } finally {
    await closeSession(fixture);
  }
});

test("UI cancellation aborts the active Pi turn without a fabricated answer", async () => {
  const fixture = await createSession(press("\u001b"));
  try {
    const turn = await runQuestionTurn(fixture, simpleChoiceParams());
    assertCancelledTurn(turn);
    await assertNoDecisionLabel(fixture, turn);
  } finally {
    await closeSession(fixture);
  }
});

test("a final-submit AbortSignal race cannot persist a successful answer", async () => {
  const fixture = await createSession(press("\r", "\r"));
  try {
    fixture.ui.setBeforeResolve(() => fixture.session.agent.abort());
    const turn = await runQuestionTurn(fixture, simpleChoiceParams());
    assertCancelledTurn(turn);
    await assertNoDecisionLabel(fixture, turn);
  } finally {
    await closeSession(fixture);
  }
});

test("AbortSignal cancellation aborts the active Pi turn without partial success", async () => {
  const fixture = await createSession();
  try {
    const pendingTurn = beginQuestionTurn(fixture, simpleChoiceParams());
    await waitForForm(fixture.ui);
    await fixture.session.abort();
    await pendingTurn.promptPromise;
    const turn = finishQuestionTurn(fixture, pendingTurn);
    assertCancelledTurn(turn);
    await assertNoDecisionLabel(fixture, turn);
  } finally {
    await closeSession(fixture);
  }
});

test("real schema rejects malformed forms without leaking question content", async () => {
  const leakedAnswer = "TASK_4_7_PRIVATE_ANSWER_SENTINEL";
  const malformed = [
    {
      diagnostic: /Invalid ask_user questionnaire schema/,
      params: {
        questions: [
          { type: "password", id: "bad", header: "Bad", prompt: leakedAnswer },
        ],
      },
    },
    {
      diagnostic: /Invalid ask_user questionnaire schema/,
      params: { questions: [] },
    },
    {
      diagnostic: /Invalid ask_user questionnaire schema/,
      params: {
        questions: [
          {
            type: "choice",
            id: "too-few-options",
            header: "Options",
            prompt: leakedAnswer,
            options: [{ value: "only", label: "Only" }],
          },
        ],
      },
    },
    {
      diagnostic: /Invalid ask_user questionnaire schema/,
      params: {
        questions: [
          {
            type: "choice",
            id: "too-many-options",
            header: "Options",
            prompt: leakedAnswer,
            options: Array.from({ length: 13 }, (_, index) => ({
              value: `option-${index}`,
              label: `Option ${index}`,
            })),
          },
        ],
      },
    },
    {
      diagnostic: /Invalid ask_user questionnaire schema/,
      params: {
        questions: Array.from({ length: 11 }, (_, index) => ({
          type: "text",
          id: `question-${index}`,
          header: `Question ${index}`,
          prompt: leakedAnswer,
        })),
      },
    },
    {
      diagnostic: /Invalid ask_user questionnaire:/,
      params: {
        questions: [
          {
            type: "choice",
            id: "invalid-recommendation",
            header: "Recommendation",
            prompt: "Choose one.",
            recommendation: leakedAnswer,
            options: [
              { value: "one", label: "One" },
              { value: "two", label: "Two" },
            ],
          },
        ],
      },
    },
  ];
  const fixture = await createSession();
  try {
    for (const { diagnostic, params } of malformed) {
      const turn = await runQuestionTurn(fixture, params);
      assert.equal(turn.toolResult.isError, true);
      assert.match(resultText(turn.toolResult), diagnostic);
      assert.doesNotMatch(resultText(turn.toolResult), new RegExp(leakedAnswer));
      assert.deepEqual(turn.toolResult.details, {});
    }
    assert.equal(fixture.ui.customCalls, 0);
  } finally {
    await closeSession(fixture);
  }
});
