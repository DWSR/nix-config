import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRoot = path.join(testsDir, "fixtures/plan-mode");
const expectedPlanTools = [
  "read",
  "grep",
  "find",
  "ls",
  "plan_mode_question",
  "plan_mode_complete",
];
const implementationTools = ["write", "mutation_probe", "read", "call_tool_write"];
const validPhases = new Set(["normal", "planning", "awaiting-approval", "approved"]);
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
        name = "nix-config-plan-mode-tests";
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

function createUi(selectAnswers = []) {
  const notifications = [];
  const statuses = new Map();
  const widgets = new Map();
  const answers = [...selectAnswers];
  return {
    notifications,
    statuses,
    widgets,
    context: {
      async select() {
        return answers.shift();
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
      setStatus(key, value) {
        statuses.set(key, value);
      },
      setWidget(key, value) {
        widgets.set(key, value);
      },
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
    timestamp: Date.now(),
  };
}

function setResponses(session, createAssistantMessageEventStream, responses) {
  let index = 0;
  session.agent.streamFunction = (model, context) => {
    const configuredResponse = responses[Math.min(index, responses.length - 1)];
    const response =
      typeof configuredResponse === "function" ? configuredResponse(context) : configuredResponse;
    index += 1;
    const message =
      response.type === "tool"
        ? assistantMessage(
            model,
            [
              {
                type: "toolCall",
                id: `plan-call-${index}`,
                name: response.name,
                arguments: response.arguments,
              },
            ],
            "toolUse",
          )
        : assistantMessage(model, [{ type: "text", text: response.text }], "stop");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
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
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  if (options.settings !== undefined) {
    fs.writeFileSync(
      path.join(agentDir, "pi-plan-mode.json"),
      `${JSON.stringify(options.settings)}\n`,
      "utf8",
    );
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PLAN_MODE_SENTINEL_FILE = path.join(root, "effects.log");
  process.env.ANTHROPIC_API_KEY = "plan-mode-test-key";

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const planExtensionPath = path.join(
    runtime.extensions,
    "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  );
  const extensionPaths = [
    planExtensionPath,
    ...(options.fixtures ?? ["sentinel-tools.ts"]).map((fixture) =>
      path.join(fixtureRoot, fixture),
    ),
  ];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
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
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "reviewed Pi model fixture is unavailable");
  const sessionManager =
    options.sessionFile !== undefined
      ? SessionManager.open(options.sessionFile, sessionsDir, cwd)
      : SessionManager.create(cwd, sessionsDir, { id: options.sessionId ?? "plan-mode-fixture" });
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
  const ui = createUi(options.selectAnswers);
  const extensionErrors = [];
  if (options.activeTools) session.setActiveToolsByName(options.activeTools);
  await session.bindExtensions({
    uiContext: ui.context,
    mode: "rpc",
    onError(error) {
      extensionErrors.push(error);
    },
  });
  setResponses(session, createAssistantMessageEventStream, options.responses ?? [
    { type: "text", text: "ok" },
  ]);
  return {
    root,
    cwd,
    effectsPath: process.env.PI_PLAN_MODE_SENTINEL_FILE,
    session,
    sessionFile: session.sessionFile,
    ui,
    extensionErrors,
    createAssistantMessageEventStream,
  };
}

function planStateEntries(session) {
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
    .map((entry) => structuredClone(entry.data));
}

function latestPlanState(session) {
  const entries = planStateEntries(session);
  assert.ok(entries.length > 0, "plan mode did not persist state");
  return entries.at(-1);
}

function assertStateContract(state, expectedPhase, expectedNames = implementationTools) {
  assert.ok(validPhases.has(state.phase), `unexpected Plan phase: ${state.phase}`);
  assert.equal(state.phase, expectedPhase);
  assert.ok(Array.isArray(state.capturedToolNames));
  assert.ok(state.capturedToolNames.every((name) => typeof name === "string" && name.length > 0));
  assert.equal(new Set(state.capturedToolNames).size, state.capturedToolNames.length);
  assert.deepEqual(state.capturedToolNames, expectedNames);
}

function diagnostics(fixture) {
  return [
    ...fixture.ui.notifications.map(({ message }) => message),
    ...fixture.extensionErrors.map(({ error }) => error),
  ].join("\n");
}

async function shutdown(session, reason = "quit") {
  await session.extensionRunner.emit({ type: "session_shutdown", reason });
  session.dispose();
}

async function completePlan(fixture, plan = "1. Inspect\n2. Implement") {
  setResponses(fixture.session, fixture.createAssistantMessageEventStream, [
    {
      type: "tool",
      name: "plan_mode_complete",
      arguments: { plan },
    },
  ]);
  await fixture.session.prompt("Finish the plan");
  await fixture.session.waitForIdle();
}

async function guardToolCall(fixture, toolName, input = {}) {
  return fixture.session.agent.beforeToolCall({
    assistantMessage: assistantMessage(fixture.session.model, [], "toolUse"),
    toolCall: { type: "toolCall", id: `guard-${toolName}`, name: toolName, arguments: input },
    args: input,
    context: { messages: [], systemPrompt: "", tools: [] },
  });
}

async function applyGuardedCall(fixture, toolName, input = {}) {
  const guard = await guardToolCall(fixture, toolName, input);
  if (!guard?.block) {
    const definition = fixture.session.getToolDefinition(toolName);
    if (definition && !["bash", "edit", "write"].includes(toolName)) {
      await definition.execute(
        `guard-${toolName}`,
        input,
        undefined,
        undefined,
        fixture.session.extensionRunner.createContext(),
      );
    }
  }
  return guard;
}

test("Plan entry captures ordered tools and reselects the six managed names at turn start", async () => {
  const modelToolNames = [];
  const fixture = await createSession({
    activeTools: implementationTools,
    settings: { defaultPlanTools: ["bash", "write", "unknown_probe"] },
  });
  try {
    await fixture.session.prompt("/plan start");
    assert.deepEqual(fixture.session.getActiveToolNames(), expectedPlanTools);
    assertStateContract(latestPlanState(fixture.session), "planning");

    fixture.session.setActiveToolsByName(implementationTools);
    setResponses(fixture.session, fixture.createAssistantMessageEventStream, [
      (context) => {
        modelToolNames.push(context.tools.map(({ name }) => name));
        return { type: "text", text: "inspection complete" };
      },
    ]);
    await fixture.session.prompt("Continue the read-only investigation");
    await fixture.session.waitForIdle();
    assert.deepEqual(fixture.session.getActiveToolNames(), expectedPlanTools);
    assert.deepEqual(modelToolNames, [expectedPlanTools]);
  } finally {
    await shutdown(fixture.session);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Plan tool_call denies and reports every non-allowlisted tool before effects", async () => {
  const fixture = await createSession({ activeTools: implementationTools });
  try {
    await fixture.session.prompt("/plan start");
    const deniedTools = [
      "bash",
      "write",
      "mutation_probe",
      "background_probe",
      "subagent_probe",
      "call_tool_write",
      "call_tool_destructive",
      "code_refactor_apply",
    ];
    for (const toolName of deniedTools) {
      const guard = await applyGuardedCall(fixture, toolName);
      assert.equal(guard?.block, true, `${toolName} was not blocked`);
      assert.match(guard.reason ?? "", new RegExp(toolName.replaceAll("_", "[_]"), "i"));
    }
    for (const toolName of expectedPlanTools) {
      const guard = await guardToolCall(fixture, toolName);
      assert.notEqual(guard?.block, true, `${toolName} was unexpectedly blocked`);
    }
    assert.equal(fs.existsSync(fixture.effectsPath), false);
  } finally {
    await shutdown(fixture.session);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("completed plans remain restricted until approval records approved state and restores tools", async () => {
  const plan = "1. Inspect the current behavior\n2. Apply the approved implementation";
  const fixture = await createSession({ activeTools: implementationTools });
  try {
    await fixture.session.prompt("/plan start");
    await completePlan(fixture, plan);

    assert.deepEqual(fixture.session.getActiveToolNames(), expectedPlanTools);
    const awaitingState = latestPlanState(fixture.session);
    assertStateContract(awaitingState, "awaiting-approval");
    assert.equal(awaitingState.latestPlan, plan);
    const completionResult = fixture.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "plan_mode_complete");
    assert.match(JSON.stringify(completionResult?.message), /Proposed Plan/);
    assert.match(JSON.stringify(completionResult?.message), /approved implementation/);

    setResponses(fixture.session, fixture.createAssistantMessageEventStream, [
      { type: "text", text: "implementation handoff accepted" },
    ]);
    await fixture.session.prompt("/plan implement");
    await fixture.session.waitForIdle();
    assert.deepEqual(fixture.session.getActiveToolNames(), implementationTools);
    assertStateContract(latestPlanState(fixture.session), "approved");

    const phases = planStateEntries(fixture.session).map(({ phase }) => phase);
    const planningIndex = phases.indexOf("planning");
    const awaitingIndex = phases.indexOf("awaiting-approval", planningIndex + 1);
    const approvedIndex = phases.indexOf("approved", awaitingIndex + 1);
    assert.ok(planningIndex >= 0 && awaitingIndex > planningIndex && approvedIndex > awaitingIndex);
  } finally {
    await shutdown(fixture.session);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit exit and cancellation restore the captured ordered names", async () => {
  for (const command of ["exit", "cancel"]) {
    const fixture = await createSession({
      activeTools: implementationTools,
      sessionId: `plan-${command}`,
    });
    try {
      await fixture.session.prompt("/plan start");
      await fixture.session.prompt(`/plan ${command}`);
      assert.deepEqual(fixture.session.getActiveToolNames(), implementationTools, command);
      assertStateContract(latestPlanState(fixture.session), "normal");
    } finally {
      await shutdown(fixture.session);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

for (const command of ["exit", "cancel"]) {
  test(`free-form Plan continuation preserves captured names through ${command}`, async () => {
    const fixture = await createSession({
      activeTools: implementationTools,
      sessionId: `plan-continuation-${command}`,
    });
    try {
      await fixture.session.prompt("/plan start");
      await fixture.session.prompt("/plan Continue investigating the existing implementation");
      await fixture.session.waitForIdle();
      const continuedState = latestPlanState(fixture.session);

      await fixture.session.prompt(`/plan ${command}`);
      const restoredState = latestPlanState(fixture.session);
      assert.deepEqual(
        {
          continuedCapture: continuedState.capturedToolNames,
          restoredTools: fixture.session.getActiveToolNames(),
          restoredPhase: restoredState.phase,
        },
        {
          continuedCapture: implementationTools,
          restoredTools: implementationTools,
          restoredPhase: "normal",
        },
      );
    } finally {
      await shutdown(fixture.session);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("valid planning, awaiting-approval, and approved state resume with captured names", async () => {
  const initial = await createSession({
    activeTools: implementationTools,
    sessionId: "valid-plan-resume",
  });
  const { root, sessionFile } = initial;
  assert.ok(sessionFile);
  await initial.session.prompt("/plan start");
  await initial.session.prompt("Persist planning state");
  await shutdown(initial.session);

  const planning = await createSession({ root, sessionFile, reason: "resume" });
  assert.deepEqual(planning.session.getActiveToolNames(), expectedPlanTools);
  assertStateContract(latestPlanState(planning.session), "planning");
  await completePlan(planning, "1. Resume planning\n2. Await approval");
  await shutdown(planning.session);

  const awaiting = await createSession({ root, sessionFile, reason: "resume" });
  assert.deepEqual(awaiting.session.getActiveToolNames(), expectedPlanTools);
  assertStateContract(latestPlanState(awaiting.session), "awaiting-approval");
  setResponses(awaiting.session, awaiting.createAssistantMessageEventStream, [
    { type: "text", text: "resumed approval accepted" },
  ]);
  await awaiting.session.prompt("/plan implement");
  await awaiting.session.waitForIdle();
  assert.deepEqual(awaiting.session.getActiveToolNames(), implementationTools);
  assertStateContract(latestPlanState(awaiting.session), "approved");
  await shutdown(awaiting.session);

  const approved = await createSession({ root, sessionFile, reason: "resume" });
  try {
    assert.deepEqual(approved.session.getActiveToolNames(), implementationTools);
    assertStateContract(latestPlanState(approved.session), "approved");
  } finally {
    await shutdown(approved.session);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("valid normal state resumes the active ordered names", async () => {
  const initial = await createSession({
    activeTools: implementationTools,
    sessionId: "valid-normal-resume",
  });
  const { root, sessionFile } = initial;
  assert.ok(sessionFile);
  await initial.session.prompt("Persist an ordinary normal session");
  await shutdown(initial.session);

  const resumed = await createSession({ root, sessionFile, reason: "resume" });
  try {
    assert.deepEqual(resumed.session.getActiveToolNames(), implementationTools);
    assertStateContract(latestPlanState(resumed.session), "normal");
  } finally {
    await shutdown(resumed.session);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restoration keeps registered captured names in order and reports unavailable names", async () => {
  const initial = await createSession({
    activeTools: implementationTools,
    sessionId: "unavailable-tool-resume",
  });
  const { root, sessionFile } = initial;
  assert.ok(sessionFile);
  await initial.session.prompt("/plan start");
  await initial.session.prompt("Persist planning state before tool removal");
  await shutdown(initial.session);

  const resumed = await createSession({
    root,
    sessionFile,
    reason: "resume",
    fixtures: [],
  });
  try {
    assert.deepEqual(resumed.session.getActiveToolNames(), expectedPlanTools);
    await resumed.session.prompt("/plan exit");
    assert.deepEqual(resumed.session.getActiveToolNames(), ["write", "read"]);
    assertStateContract(latestPlanState(resumed.session), "normal");
    assert.match(diagnostics(resumed), /unavailable/i);
    assert.match(diagnostics(resumed), /mutation_probe/);
    assert.match(diagnostics(resumed), /call_tool_write/);
  } finally {
    await shutdown(resumed.session);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing and invalid resumed state report normal-mode fallback without a Plan denial", async () => {
  const cases = [
    ["missing", undefined],
    ["unknown phase", { phase: "restricted", capturedToolNames: implementationTools }],
    ["duplicate names", { phase: "planning", capturedToolNames: ["read", "read"] }],
    ["non-array names", { phase: "planning", capturedToolNames: "read" }],
  ];

  for (const [name, persistedState] of cases) {
    const initial = await createSession({
      activeTools: implementationTools,
      sessionId: `fallback-${name.replaceAll(" ", "-")}`,
    });
    const { root, sessionFile } = initial;
    assert.ok(sessionFile);
    await initial.session.prompt("Create a resumable normal session");
    await initial.session.waitForIdle();
    if (persistedState !== undefined) {
      initial.session.sessionManager.appendCustomEntry("plan-mode-state", persistedState);
    }
    initial.session.dispose();

    const resumed = await createSession({
      root,
      sessionFile,
      reason: "resume",
      activeTools: implementationTools,
    });
    try {
      assert.deepEqual(resumed.session.getActiveToolNames(), implementationTools, name);
      assertStateContract(latestPlanState(resumed.session), "normal");
      assert.notEqual((await guardToolCall(resumed, "mutation_probe"))?.block, true, name);
      assert.match(diagnostics(resumed), /normal mode/i, name);
      assert.match(diagnostics(resumed), /not restored|unavailable|invalid/i, name);
    } finally {
      await shutdown(resumed.session);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
