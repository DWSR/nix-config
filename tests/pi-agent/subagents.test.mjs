import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fakePiFixture = path.join(testsDir, "fixtures/subagents/fake-pi.mjs");
const expectedReaderTools = [
  "read",
  "grep",
  "find",
  "ls",
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "read_cache",
];
const expectedWorkerTools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const readerMcpSelectors = [
  "mcpproxy/retrieve_tools",
  "mcpproxy/describe_tool",
  "mcpproxy/call_tool_read",
  "mcpproxy/read_cache",
];
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let runtimePaths;
let jiti;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-subagent-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
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
  const outputs = childProcess.execFileSync(
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
  ).trim().split("\n").filter(Boolean);
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, "share/pi-agent/extensions.json"))),
  };
  assert.match(runtimePaths.pi ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.extensions ?? "", /^\/nix\/store\//);
  return runtimePaths;
}

async function loadSubagentModule(relativePath) {
  const runtime = buildRuntimePaths();
  const piModules = path.join(runtime.pi, "lib/node_modules");
  if (!jiti) {
    const { createJiti } = await import(pathToFileURL(path.join(piModules, "jiti/lib/jiti.mjs")));
    jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@earendil-works/pi-agent-core": path.join(piModules, "@earendil-works/pi-agent-core/dist/index.js"),
        "@earendil-works/pi-ai": path.join(piModules, "@earendil-works/pi-ai/dist/index.js"),
        "@earendil-works/pi-ai/compat": path.join(piModules, "@earendil-works/pi-ai/dist/compat.js"),
        "@earendil-works/pi-coding-agent": path.join(piModules, "@earendil-works/pi-coding-agent/dist/index.js"),
        "@earendil-works/pi-tui": path.join(piModules, "@earendil-works/pi-tui/dist/index.js"),
        typebox: path.join(runtime.extensions, "lib/node_modules/typebox/build/index.mjs"),
        "typebox/compile": path.join(runtime.extensions, "lib/node_modules/typebox/build/compile/index.mjs"),
      },
    });
  }
  return jiti.import(path.join(runtime.extensions, "lib/node_modules/pi-subagents", relativePath));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForValue(readValue, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("timed out waiting for subagent fixture state");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupExists(processGroupId) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killFixturePid(pid) {
  if (!Number.isInteger(pid) || pid < 1 || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function readFixtureTrees(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter((entry) => entry.endsWith(".tree"))
    .map((entry) => {
      const fixtureFile = path.join(logDir, entry);
      return { ...readJson(fixtureFile), fixtureFile };
    });
}

function disarmFixtureTree(tree) {
  fs.rmSync(tree.fixtureFile, { force: true });
}

async function emergencyCleanupFixtureTrees(logDir) {
  const trees = readFixtureTrees(logDir);
  for (const tree of trees) {
    killFixturePid(tree.descendantPid);
    killFixturePid(tree.parentPid);
  }
  if (trees.length > 0) {
    await waitForValue(() => trees.every((tree) => !processExists(tree.parentPid) && !processExists(tree.descendantPid)) ? true : undefined, 5000).catch(() => undefined);
  }
}

async function settleWithin(promise, timeoutMs) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    ),
    delay(timeoutMs).then(() => ({ settled: false })),
  ]);
}

function expectedCatalog() {
  return {
    schemaVersion: 1,
    reader: {
      model: "host-managed-default",
      maxTurns: 8,
      maxToolCalls: 32,
      workspace: "parent-read",
      tools: expectedReaderTools,
      extensions: ["agentmemory", "mcp"],
      mcp: "read-only",
    },
    worker: {
      model: "host-managed-default",
      maxTurns: 12,
      maxToolCalls: 64,
      workspace: "parent-readwrite",
      tools: expectedWorkerTools,
      extensions: ["agentmemory"],
      mcp: "none",
    },
  };
}

test("built closure publishes the immutable two-role managed catalog", () => {
  assert.doesNotMatch(
    fs.readFileSync(path.join(repoRoot, "overlays/pi-agent/default.nix"), "utf8"),
    /task41ManagedSubagents/,
  );
  const runtime = buildRuntimePaths();
  const policyPath = path.join(runtime.extensions, "share/pi-agent/subagents.json");
  assert.deepEqual(readJson(policyPath), expectedCatalog());
  assert.deepEqual(
    fs.readdirSync(path.join(runtime.extensions, "lib/node_modules/pi-subagents/managed-agents")).sort(),
    ["reader.md", "worker.md"],
  );
  const provenance = readJson(path.join(runtime.extensions, "share/pi-agent/extensions-provenance.json"));
  assert.deepEqual(provenance.patches.managedSubagents, {
    file: "pi-subagents-managed-children.patch",
    package: "pi-subagents@0.40.0",
    task: "pi-agent-integration 4.1",
  });
  assert.deepEqual(provenance.patches.managedSubagentsLifecycle, {
    file: "pi-subagents-managed-lifecycle.patch",
    package: "pi-subagents@0.40.0",
    task: "pi-agent-integration 4.2",
  });
});

test("managed discovery ignores mutable user and project agents and settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-agent-discovery-"));
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".pi/agents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    subagents: { defaultModel: "hostile/model", agentOverrides: { reader: { tools: ["write"] } } },
  }));
  fs.writeFileSync(path.join(agentDir, "agents/hostile.md"), "---\nname: hostile\ndescription: hostile\ntools: bash\n---\nhostile\n");
  fs.writeFileSync(path.join(workspace, ".pi/agents/project.md"), "---\nname: project\ndescription: project\ntools: write\n---\nproject\n");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { discoverAgents } = await loadSubagentModule("src/agents/agents.ts");
    const discovered = discoverAgents(workspace, "both");
    assert.deepEqual(discovered.agents.map(({ name }) => name), ["reader", "worker"]);
    const [reader, worker] = discovered.agents;
    assert.equal(reader.model, undefined);
    assert.equal(worker.model, undefined);
    assert.deepEqual(reader.defaultTurnBudget, { maxTurns: 8, graceTurns: 0 });
    assert.deepEqual(worker.defaultTurnBudget, { maxTurns: 12, graceTurns: 0 });
    assert.deepEqual(reader.toolBudget, { hard: 32, block: "*" });
    assert.deepEqual(worker.toolBudget, { hard: 64, block: "*" });
    assert.deepEqual(reader.tools, expectedReaderTools.slice(0, 4));
    assert.deepEqual(reader.mcpDirectTools, readerMcpSelectors);
    assert.deepEqual(worker.tools, expectedWorkerTools);
    assert.deepEqual(worker.mcpDirectTools, undefined);
    assert.equal(discovered.projectAgentsDir, null);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed launch plans impose exact tool and extension ceilings", async () => {
  const runtime = buildRuntimePaths();
  const { discoverAgents } = await loadSubagentModule("src/agents/agents.ts");
  const { resolvePiLaunchToolPlan } = await loadSubagentModule("src/runs/shared/pi-args.ts");
  const agents = discoverAgents(repoRoot, "both").agents;
  const plans = Object.fromEntries(agents.map((agent) => [agent.name, resolvePiLaunchToolPlan({
    agentName: agent.name,
    tools: agent.tools,
    extensions: agent.extensions,
    subagentOnlyExtensions: agent.subagentOnlyExtensions,
    mcpDirectTools: agent.mcpDirectTools,
    cwd: repoRoot,
  })]));
  const agentmemory = path.join(runtime.extensions, "lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts");
  const mcp = path.join(runtime.extensions, "lib/pi-agent/extensions/mcpproxy/index.ts");
  assert.deepEqual(plans.reader.effectiveToolAllowlist, expectedReaderTools);
  assert.deepEqual(plans.worker.effectiveToolAllowlist, expectedWorkerTools);
  assert.deepEqual(plans.reader.effectiveMcpSelections, readerMcpSelectors.map((selector, index) => ({
    selector,
    name: expectedReaderTools[index + 4],
  })));
  assert.ok(plans.reader.extensionArgs.includes(agentmemory));
  assert.ok(plans.reader.extensionArgs.includes(mcp));
  assert.ok(plans.worker.extensionArgs.includes(agentmemory));
  assert.equal(plans.worker.extensionArgs.includes(mcp), false);
  for (const plan of Object.values(plans)) {
    assert.equal(plan.disableAmbientExtensions, true);
    assert.equal(plan.extensionArgs.some((entry) => /pi-subagents\/index\.ts$/.test(entry)), false);
  }
});

test("managed policy rejects every caller-owned resource override", async () => {
  const { validateManagedExecutionRequest } = await loadSubagentModule("src/managed-policy.ts");
  const cases = [
    [{ agent: "reader", task: "x", model: "hostile/model" }, "model"],
    [{ agent: "reader", task: "x", thinking: "high" }, "thinking"],
    [{ agent: "reader", task: "x", turnBudget: { maxTurns: 99 } }, "turnBudget"],
    [{ agent: "worker", task: "x", toolBudget: { hard: 99 } }, "toolBudget"],
    [{ agent: "reader", task: "x", usageBudget: { tokens: { hard: 99 } } }, "usageBudget"],
    [{ agent: "worker", task: "x", cwd: "/tmp" }, "cwd"],
    [{ agent: "reader", task: "x", tools: ["write"] }, "tools"],
    [{ agent: "reader", task: "x", workspace: "parent-readwrite" }, "workspace"],
    [{ agent: "reader", task: "x", context: "fork" }, "context"],
    [{ tasks: [{ agent: "worker", task: "x" }], worktree: true }, "worktree"],
    [{ agent: "reader", task: "x", extensions: ["hostile.ts"] }, "extensions"],
    [{ agent: "worker", task: "x", mcp: "read-only" }, "mcp"],
    [{ agent: "worker", task: "x", mcpDirectTools: ["mcpproxy/call_tool_write"] }, "mcpDirectTools"],
    [{ agent: "reader", task: "x", depth: 9 }, "depth"],
    [{ agent: "reader", task: "x", maxSubagentDepth: 9 }, "maxSubagentDepth"],
    [{ agent: "reader", task: "x", skill: "hostile" }, "skill"],
    [{ agent: "worker", task: "x", output: "/tmp/out" }, "output"],
    [{ agent: "reader", task: "x", agentScope: "project" }, "agentScope"],
    [{ tasks: [{ agent: "reader", task: "x", model: "hostile/model" }] }, "tasks[0].model"],
    [{ chain: [{ agent: "worker", task: "x", cwd: "/tmp" }] }, "chain[0].cwd"],
    [{ chain: [{ agent: "reader", task: "x", output: "leak.md" }] }, "chain[0].output"],
    [{ agent: "hostile", task: "x" }, "agent"],
  ];
  for (const [params, field] of cases) {
    assert.match(validateManagedExecutionRequest(params) ?? "", new RegExp(field.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  }
  assert.equal(validateManagedExecutionRequest({ agent: "reader", task: "read it" }), undefined);
  assert.equal(validateManagedExecutionRequest({ tasks: [{ agent: "reader", task: "a" }, { agent: "worker", task: "b" }] }), undefined);
});

test("managed chain validation rejects nested named-output handoffs value-safely", async () => {
  const { validateManagedExecutionRequest } = await loadSubagentModule("src/managed-policy.ts");
  const sentinel = "reviewer-round-one-named-output-sentinel";
  const error = validateManagedExecutionRequest({
    chain: [
      { agent: "reader", task: "first", as: "first" },
      { parallel: [{ agent: "worker", task: `consume {outputs.${sentinel}}` }] },
    ],
  });
  assert.match(error ?? "", /chain\[1\]\.parallel\[0\]\.task/);
  assert.doesNotMatch(error ?? "", new RegExp(sentinel));
});

test("managed maximum depth is one without ambient override authority", async () => {
  const previous = process.env.PI_SUBAGENT_MAX_DEPTH;
  try {
    const [{ loadConfig }, { getSubagentDepthEnv, resolveCurrentMaxSubagentDepth }] = await Promise.all([
      loadSubagentModule("src/extension/config.ts"),
      loadSubagentModule("src/shared/types.ts"),
    ]);
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    assert.equal(loadConfig().maxSubagentDepth, 1);
    assert.equal(resolveCurrentMaxSubagentDepth(), 1);
    assert.equal(getSubagentDepthEnv().PI_SUBAGENT_MAX_DEPTH, "1");
    assert.equal(resolveCurrentMaxSubagentDepth(99), 1);
    assert.equal(getSubagentDepthEnv(99).PI_SUBAGENT_MAX_DEPTH, "1");

    process.env.PI_SUBAGENT_MAX_DEPTH = "99";
    assert.equal(resolveCurrentMaxSubagentDepth(), 1);
    assert.equal(getSubagentDepthEnv().PI_SUBAGENT_MAX_DEPTH, "1");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
    else process.env.PI_SUBAGENT_MAX_DEPTH = previous;
  }
});

function createEventBus() {
  const handlers = new Map();
  let subscriptions = 0;
  let emissions = [];
  return {
    on(name, handler) {
      subscriptions += 1;
      const entries = handlers.get(name) ?? new Set();
      entries.add(handler);
      handlers.set(name, entries);
      return () => entries.delete(handler);
    },
    emit(name, payload) {
      emissions.push({ name, payload });
      for (const handler of handlers.get(name) ?? []) handler(payload);
    },
    resetActivity() {
      subscriptions = 0;
      emissions = [];
    },
    snapshotActivity() {
      return { emissions: [...emissions], subscriptions };
    },
  };
}

function fakeUi() {
  return {
    async confirm() { return false; },
    async custom() { return undefined; },
    notify() {},
    setToolsExpanded() {},
  };
}

async function loadExtensionRuntime() {
  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];
  const tools = [];
  const events = createEventBus();
  const pi = {
    events,
    getAllTools: () => tools,
    getSessionName: () => undefined,
    getThinkingLevel: () => "off",
    on(name, handler) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    registerCommand(name, command) { commands.set(name, command); },
    registerMessageRenderer() {},
    registerShortcut() {},
    registerTool(tool) { tools.push(tool); },
    sendMessage(message) { sentMessages.push(message); },
    sendUserMessage() {},
  };
  const { default: registerSubagentExtension } = await loadSubagentModule("src/extension/index.ts");
  registerSubagentExtension(pi);
  return {
    commands,
    events,
    sentMessages,
    tools,
    async emit(name, event, ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

async function withExecutor(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-subagents-"));
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
  const logDir = path.join(root, "launches");
  const fakePackage = path.join(root, "fake-pi");
  const fakeCli = path.join(fakePackage, "bin/pi.mjs");
  for (const directory of [workspace, agentDir, sessionsDir, logDir, path.dirname(fakeCli)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(parentSessionFile, "{\"type\":\"session\",\"id\":\"parent-session\"}\n");
  fs.writeFileSync(path.join(fakePackage, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    bin: { pi: "bin/pi.mjs" },
  }));
  fs.copyFileSync(fakePiFixture, fakeCli);
  fs.chmodSync(fakeCli, 0o755);

  const savedArgv1 = process.argv[1];
  const environment = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_MAX_DEPTH: "3",
    PI_SUBAGENT_FIXTURE_LOG_DIR: logDir,
    SHOPIFY_PI_TOKEN: "task-4-1-provider-token-sentinel",
    PI_AGENT_LAUNCH_ID: "40414141-4141-4414-8141-404141414141",
  };
  const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
  const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
  process.argv[1] = fakeCli;
  Object.assign(process.env, environment);
  process.env.PI_SUBAGENT_PI_BINARY = path.join(root, "must-not-run");

  try {
    const [{ discoverAgents }, { loadConfig }, { createSubagentExecutor }, managedPolicy] = await Promise.all([
      loadSubagentModule("src/agents/agents.ts"),
      loadSubagentModule("src/extension/config.ts"),
      loadSubagentModule("src/runs/foreground/subagent-executor.ts"),
      loadSubagentModule("src/managed-policy.ts"),
    ]);
    const events = createEventBus();
    managedPolicy.beginManagedChildSession();
    const state = {
      baseCwd: workspace,
      currentSessionId: "parent-session",
      artifactDirPreference: "session",
      parentSessionFile,
      subagentInProgress: false,
      subagentSpawns: { sessionId: "parent-session", count: 0, configuredLimit: null, granted: 0, grantHistory: [] },
      asyncJobs: new Map(),
      fleetJobs: new Map(),
      foregroundRuns: new Map(),
      foregroundControls: new Map(),
      lastForegroundControlId: null,
      pendingForegroundControlNotices: new Map(),
      cleanupTimers: new Map(),
      lastUiContext: null,
      poller: null,
      completionSeen: new Map(),
      watcher: null,
      watcherRestartTimer: null,
      resultFileCoalescer: { schedule: () => false, clear() {} },
    };
    const executor = createSubagentExecutor({
      pi: { events, getSessionName: () => undefined },
      state,
      config: loadConfig(),
      asyncByDefault: false,
      waitToolEnabled: false,
      tempArtifactsDir: path.join(root, "temp-artifacts"),
      getSubagentSessionRoot(file) {
        return file ? path.join(path.dirname(file), path.basename(file, ".jsonl")) : path.join(root, "missing-parent");
      },
      expandTilde(value) { return value; },
      discoverAgents,
      handleScheduledRunAction: options.handleScheduledRunAction,
      allowMutatingManagementActions: false,
    });
    const model = { provider: "fixture", id: "host-model", api: "openai-completions", reasoning: false };
    const ctx = {
      cwd: workspace,
      hasUI: false,
      model,
      modelRegistry: { getAvailable: () => [model] },
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
      ui: fakeUi(),
    };
    await run({ executor, ctx, root, workspace, agentDir, sessionsDir, parentSessionFile, logDir, managedPolicy, state });
  } finally {
    await emergencyCleanupFixtureTrees(logDir);
    process.argv[1] = savedArgv1;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readLaunches(logDir) {
  return fs.readdirSync(logDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readJson(path.join(logDir, entry)))
    .sort((left, right) => Number(left.attribution.childIndex) - Number(right.attribution.childIndex));
}

test("single worker inherits provider/model, bounded resources, child attribution, and parent-session state", async () => {
  await withExecutor(async ({ executor, ctx, workspace, parentSessionFile, logDir }) => {
    const result = await executor.execute("single", { agent: "worker", task: "single-worker", agentContract: { version: 1 } }, new AbortController().signal, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "result:single-worker");
    assert.equal(result.details.results.length, 1);
    const child = result.details.results[0];
    assert.equal(child.model, "fixture/host-model");
    assert.deepEqual(result.details.turnBudget, { maxTurns: 12, graceTurns: 0 });
    assert.deepEqual(result.details.toolBudget, { hard: 64, block: "*" });
    assert.ok(child.sessionFile.startsWith(path.join(path.dirname(parentSessionFile), "parent")));
    assert.ok(result.details.artifacts.dir.startsWith(path.join(path.dirname(parentSessionFile), "parent")));
    const artifactFiles = result.details.artifacts.files.flatMap((files) => Object.values(files));
    assert.ok(artifactFiles.length > 0);
    assert.equal(artifactFiles.every((file) => file.startsWith(path.join(path.dirname(parentSessionFile), "parent"))), true);
    assert.equal(artifactFiles.some((file) => fs.existsSync(file)), true);
    assert.equal(fs.existsSync(path.join(workspace, ".pi-subagents")), false);
    const [launch] = readLaunches(logDir);
    assert.equal(launch.cwd, fs.realpathSync(workspace));
    assert.equal(launch.tools, expectedWorkerTools.join(","));
    assert.deepEqual(JSON.parse(launch.toolBudget), { hard: 64, block: "*" });
    assert.deepEqual(launch.providerResources, { launchId: true, token: true });
    assert.deepEqual(launch.attribution, { child: "1", childIndex: "0", parentSession: "parent-session", runId: result.details.runId });
    assert.equal(launch.piBinaryOverridePresent, false);
    assert.equal(launch.depth, "1");
    assert.equal(launch.maxDepth, "1");
  });
});

test("parallel children preserve successes and failures independently", async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    const result = await executor.execute("parallel", {
      tasks: [
        { agent: "reader", task: "parallel-reader" },
        { agent: "worker", task: "[fail] parallel-worker" },
        { agent: "reader", task: "parallel-reader-two" },
      ],
      concurrency: 3,
      agentContract: { version: 1 },
    }, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.mode, "parallel");
    assert.deepEqual(result.details.results.map(({ exitCode }) => exitCode === 0), [true, false, true]);
    assert.match(result.details.results[1].error, /fixture failure/);
    assert.match(result.content[0].text, /2\/3 succeeded/);
    assert.equal(new Set(result.details.results.map(({ sessionFile }) => sessionFile)).size, 3);
    assert.deepEqual(readLaunches(logDir).map(({ agent }) => agent), ["reader", "worker", "reader"]);
  });
});

test("chain passes only explicitly declared immediate predecessor output", async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    const result = await executor.execute("chain", {
      chain: [
        { agent: "reader", task: "chain-first" },
        { agent: "worker", task: "chain-second<{previous}>" },
        { agent: "reader", task: "chain-third-no-predecessor" },
      ],
      agentContract: { version: 1 },
    }, new AbortController().signal, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.results.length, 3);
    const launches = readLaunches(logDir);
    assert.match(launches[1].task, /^chain-second<result:chain-first>/);
    assert.doesNotMatch(launches[1].task, /chain-third/);
    assert.equal(launches[2].task.startsWith("chain-third-no-predecessor"), true);
    assert.doesNotMatch(launches[2].task, /result:chain-second/);
    assert.doesNotMatch(launches[2].task, /result:chain-first/);
  });
});

test("successful chain keeps progress state under the owning parent session", async () => {
  await withExecutor(async ({ executor, ctx, workspace, parentSessionFile }) => {
    const result = await executor.execute("chain-state", {
      chain: [
        {
          parallel: [
            { agent: "reader", task: "chain-state-reader", progress: true },
            { agent: "worker", task: "chain-state-worker", progress: true },
          ],
          concurrency: 2,
        },
        { agent: "reader", task: "chain-state-final<{previous}>" },
      ],
      agentContract: { version: 1 },
    }, new AbortController().signal, undefined, ctx);
    assert.equal(result.isError, undefined);
    const progressMatch = /📋 Progress: ([^\n]+)/.exec(result.content[0].text);
    assert.ok(progressMatch);
    const progressPath = progressMatch[1];
    const parentRoot = path.join(path.dirname(parentSessionFile), "parent");
    assert.deepEqual({
      parentOwned: progressPath.startsWith(`${parentRoot}${path.sep}`),
      content: fs.existsSync(progressPath) ? fs.readFileSync(progressPath, "utf8") : null,
      workspaceStateExists: fs.existsSync(path.join(workspace, ".pi-subagents")),
    }, {
      parentOwned: true,
      content: "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n",
      workspaceStateExists: false,
    });
  });
});

test("reader hard turn budget stops at eight and both roles carry exact tool budgets", async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    const result = await executor.execute("budget", { agent: "reader", task: "[turn-budget] reader", agentContract: { version: 1 } }, new AbortController().signal, undefined, ctx);
    const child = result.details.results[0];
    assert.equal(child.turnBudgetExceeded, true);
    assert.equal(child.turnBudget.maxTurns, 8);
    assert.equal(child.turnBudget.graceTurns, 0);
    assert.equal(child.usage.turns, 8);
    const [launch] = readLaunches(logDir);
    assert.deepEqual(JSON.parse(launch.toolBudget), { hard: 32, block: "*" });
  });
  const { shouldBlockToolForBudget } = await loadSubagentModule("src/runs/shared/tool-budget.ts");
  assert.equal(shouldBlockToolForBudget({ hard: 32, block: "*" }, "read", 32), false);
  assert.equal(shouldBlockToolForBudget({ hard: 32, block: "*" }, "read", 33), true);
  assert.equal(shouldBlockToolForBudget({ hard: 64, block: "*" }, "write", 64), false);
  assert.equal(shouldBlockToolForBudget({ hard: 64, block: "*" }, "write", 65), true);
});

test("executor rejects hostile overrides before child or artifact creation", async () => {
  await withExecutor(async ({ executor, ctx, logDir, workspace }) => {
    for (const params of [
      { agent: "reader", task: "x", model: "hostile/model" },
      { agent: "worker", task: "x", cwd: "/tmp" },
      { tasks: [{ agent: "reader", task: "x", output: "/tmp/leak" }] },
      { chain: [{ agent: "worker", task: "x", toolBudget: { hard: 999 } }] },
      { agent: "reader", task: "x", agentScope: "project" },
      { tasks: [{ agent: "worker", task: "x" }], worktree: true },
      { agent: "hostile", task: "x" },
    ]) {
      const result = await executor.execute("hostile", params, new AbortController().signal, undefined, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Managed subagent policy rejects call-level override/);
    }
    assert.deepEqual(fs.readdirSync(logDir), []);
    assert.equal(fs.existsSync(path.join(workspace, ".pi-subagents")), false);
  });
});

test("reader loads AgentMemory and read-only MCP while worker loads AgentMemory only", async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    await executor.execute("resources", {
      tasks: [{ agent: "reader", task: "reader-resources" }, { agent: "worker", task: "worker-resources" }],
      agentContract: { version: 1 },
    }, new AbortController().signal, undefined, ctx);
    const runtime = buildRuntimePaths();
    const agentmemory = path.join(runtime.extensions, "lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts");
    const mcp = path.join(runtime.extensions, "lib/pi-agent/extensions/mcpproxy/index.ts");
    const [reader, worker] = readLaunches(logDir);
    assert.equal(reader.noAmbientExtensions, true);
    assert.equal(worker.noAmbientExtensions, true);
    assert.ok(reader.extensions.includes(agentmemory));
    assert.ok(reader.extensions.includes(mcp));
    assert.ok(worker.extensions.includes(agentmemory));
    assert.equal(worker.extensions.includes(mcp), false);
    assert.equal(reader.tools, expectedReaderTools.join(","));
    assert.equal(worker.tools, expectedWorkerTools.join(","));
    assert.equal(reader.mcpDirectTools, readerMcpSelectors.join(","));
    assert.equal(worker.mcpDirectTools, "__none__");
    assert.equal(reader.extensions.some((entry) => /(?:plan|stamp|timeout|ask-user|code-intelligence|background-tasks|pi-subagents\/index)/.test(entry)), false);
    assert.equal(worker.extensions.some((entry) => /(?:mcpproxy|plan|stamp|timeout|ask-user|code-intelligence|background-tasks|pi-subagents\/index)/.test(entry)), false);
  });
});

test("managed policy rejects async, detached, and scheduled requests value-safely", async () => {
  const { validateManagedExecutionRequest } = await loadSubagentModule("src/managed-policy.ts");
  const sentinel = "task-4-2-denied-mode-value-sentinel";
  const cases = [
    [{ agent: "reader", task: sentinel, async: true }, "asynchronous"],
    [{ action: "resume", id: sentinel }, "asynchronous"],
    [{ action: "steer", id: sentinel, message: sentinel }, "asynchronous"],
    [{ action: "append-step", id: sentinel, task: sentinel }, "asynchronous"],
    [{ agent: "worker", task: sentinel, detached: true }, "detached"],
    [{ agent: "reader", task: sentinel, schedule: `+${sentinel}` }, "scheduled"],
    [{ action: "schedule", schedule: `+${sentinel}`, agent: "reader", task: sentinel }, "scheduled"],
    [{ action: "schedule-list", message: sentinel }, "scheduled"],
  ];
  for (const [params, kind] of cases) {
    const error = validateManagedExecutionRequest(params);
    assert.match(error ?? "", new RegExp(`Managed subagent policy rejects ${kind} child execution`));
    assert.doesNotMatch(error ?? "", new RegExp(sentinel));
  }
  assert.equal(validateManagedExecutionRequest({ agent: "reader", task: "foreground", async: false }), undefined);
});

test("denied execution modes create no child, artifact, timer, or session state", async () => {
  let scheduledHandlerCalls = 0;
  await withExecutor(async ({ executor, ctx, logDir, parentSessionFile, state }) => {
    const cases = [
      { agent: "reader", task: "denied-async", async: true, clarify: true },
      { action: "resume", id: "denied-async-resume" },
      { agent: "worker", task: "denied-detached", detached: true },
      { action: "schedule", schedule: "+1h", agent: "reader", task: "denied-scheduled" },
    ];
    for (const params of cases) {
      const result = await executor.execute("denied", params, new AbortController().signal, undefined, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Managed subagent policy rejects (?:asynchronous|detached|scheduled) child execution/);
    }
    assert.deepEqual(fs.readdirSync(logDir), []);
    assert.equal(fs.existsSync(path.join(path.dirname(parentSessionFile), "parent")), false);
    assert.equal(state.asyncJobs.size, 0);
    assert.equal(state.cleanupTimers.size, 0);
    assert.equal(state.foregroundRuns.size, 0);
    assert.equal(state.foregroundControls.size, 0);
    assert.equal(scheduledHandlerCalls, 0);
  }, {
    async handleScheduledRunAction() {
      scheduledHandlerCalls += 1;
      return { content: [{ type: "text", text: "must not run" }], details: { mode: "management", results: [] } };
    },
  });
});

test("slash --bg modes are rejected before session and bridge side effects", async () => {
  await withExecutor(async ({ ctx }) => {
    const runtime = await loadExtensionRuntime();
    const notifications = [];
    let rewrites = 0;
    const slashCtx = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        _rewriteFile() { rewrites += 1; },
        flushed: false,
      },
      ui: {
        ...fakeUi(),
        notify(message, level) { notifications.push({ level, message }); },
      },
    };
    await runtime.emit("session_start", { reason: "new" }, slashCtx);
    runtime.events.resetActivity();
    runtime.sentMessages.length = 0;

    const cases = [
      ["run", "reader denied --bg"],
      ["chain", 'reader "first" -> worker "second" --bg'],
      ["run-chain", "missing -- denied --bg"],
      ["parallel", 'reader "first" -> worker "second" --bg'],
    ];
    const observations = [];
    for (const [command, args] of cases) {
      notifications.length = 0;
      rewrites = 0;
      runtime.events.resetActivity();
      runtime.sentMessages.length = 0;
      await runtime.commands.get(command).handler(args, slashCtx);
      await delay(20);
      const activity = runtime.events.snapshotActivity();
      observations.push({
        command,
        bridgeEvents: activity.emissions
          .map(({ name }) => name)
          .filter((name) => name.startsWith("subagent:slash:")),
        messages: runtime.sentMessages.length,
        notification: notifications.at(-1)?.message,
        rewrites,
        subscriptions: activity.subscriptions,
      });
    }

    assert.deepEqual(observations, cases.map(([command]) => ({
      command,
      bridgeEvents: [],
      messages: 0,
      notification: "Managed subagent policy rejects asynchronous child execution.",
      rewrites: 0,
      subscriptions: 0,
    })));
    await runtime.emit("session_shutdown", { reason: "quit" }, slashCtx);
  });
});

test("prompt workflow background flags reject before missing, list, or error effects", async () => {
  await withExecutor(async ({ ctx, logDir, parentSessionFile, workspace }) => {
    const runtime = await loadExtensionRuntime();
    const notifications = [];
    let cwdReads = 0;
    const workflowCtx = {
      ...ctx,
      ui: {
        ...fakeUi(),
        notify(message, level) { notifications.push({ level, message }); },
      },
    };
    Object.defineProperty(workflowCtx, "cwd", {
      configurable: true,
      enumerable: true,
      get() {
        cwdReads += 1;
        return ctx.cwd;
      },
    });

    const cases = ["--bg", "--async"].flatMap((flag) => [
      { args: flag, command: "prompt-workflow", flag, route: "missing" },
      { args: `list ${flag}`, command: "prompt-workflow", flag, route: "list" },
      { args: `missing ${flag}`, command: "prompt-workflow", flag, route: "error" },
      { args: ` -- ${flag}`, command: "chain-prompts", flag, route: "missing" },
      { args: `list -- ${flag}`, command: "chain-prompts", flag, route: "list" },
      { args: `missing -- ${flag}`, command: "chain-prompts", flag, route: "error" },
    ]);
    const observations = [];
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;
    let timers = 0;
    globalThis.setInterval = (...args) => {
      timers += 1;
      return originalSetInterval(...args);
    };
    globalThis.setTimeout = (...args) => {
      timers += 1;
      return originalSetTimeout(...args);
    };
    try {
      for (const fixture of cases) {
        cwdReads = 0;
        notifications.length = 0;
        runtime.events.resetActivity();
        runtime.sentMessages.length = 0;
        timers = 0;
        let denial;
        try {
          await runtime.commands.get(fixture.command).handler(fixture.args, workflowCtx);
        } catch (error) {
          denial = error instanceof Error ? error.message : String(error);
        }
        const activity = runtime.events.snapshotActivity();
        observations.push({
          command: fixture.command,
          cwdReads,
          denial,
          emissions: activity.emissions.length,
          flag: fixture.flag,
          messages: runtime.sentMessages.length,
          notifications: notifications.length,
          route: fixture.route,
          subscriptions: activity.subscriptions,
          timers,
        });
      }
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(observations, cases.map(({ command, flag, route }) => ({
      command,
      cwdReads: 0,
      denial: "Managed subagent policy rejects asynchronous child execution.",
      emissions: 0,
      flag,
      messages: 0,
      notifications: 0,
      route,
      subscriptions: 0,
      timers: 0,
    })));
    assert.deepEqual(fs.readdirSync(logDir), []);
    assert.equal(fs.existsSync(path.join(path.dirname(parentSessionFile), "parent")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".pi-subagents")), false);
  });
});

test("registered tool rejects a denied mode before changing UI state", async () => {
  await withExecutor(async ({ ctx }) => {
    const runtime = await loadExtensionRuntime();
    let toolCollapseCalls = 0;
    const toolCtx = {
      ...ctx,
      hasUI: true,
      ui: {
        ...fakeUi(),
        setToolsExpanded() { toolCollapseCalls += 1; },
        setWidget() {},
      },
    };
    await runtime.emit("session_start", { reason: "new" }, toolCtx);
    const tool = runtime.tools.find(({ name }) => name === "subagent");
    assert.ok(tool);
    const result = await tool.execute(
      "managed-tool-denial",
      { agent: "reader", task: "denied", async: true },
      new AbortController().signal,
      undefined,
      toolCtx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /rejects asynchronous child execution/);
    assert.equal(toolCollapseCalls, 0);
    await runtime.emit("session_shutdown", { reason: "quit" }, toolCtx);
  });
});

test("slash, prompt, and RPC bridges reject managed modes before controller startup", async (t) => {
  const [slashBridgeModule, promptBridgeModule, rpcModule, sharedTypes] = await Promise.all([
    loadSubagentModule("src/slash/slash-bridge.ts"),
    loadSubagentModule("src/slash/prompt-template-bridge.ts"),
    loadSubagentModule("src/extension/rpc.ts"),
    loadSubagentModule("src/shared/types.ts"),
  ]);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionFile: () => null,
      getSessionId: () => "bridge-session",
    },
  };

  await t.test("slash bridge", async () => {
    const events = createEventBus();
    let executeCalls = 0;
    const bridge = slashBridgeModule.registerSlashSubagentBridge({
      events,
      getContext: () => ctx,
      async execute() {
        executeCalls += 1;
        return { content: [{ type: "text", text: "must not execute" }], details: { mode: "single", results: [] } };
      },
    });
    events.resetActivity();
    events.emit(sharedTypes.SLASH_SUBAGENT_REQUEST_EVENT, {
      requestId: "managed-slash-denial",
      params: { agent: "reader", task: "denied", async: true },
      ctx,
    });
    const response = await waitForValue(() => events.snapshotActivity().emissions
      .find(({ name }) => name === sharedTypes.SLASH_SUBAGENT_RESPONSE_EVENT)?.payload);
    const names = events.snapshotActivity().emissions.map(({ name }) => name);
    assert.equal(executeCalls, 0);
    assert.equal(names.includes(sharedTypes.SLASH_SUBAGENT_STARTED_EVENT), false);
    assert.match(response.errorText, /rejects asynchronous child execution/);
    bridge.dispose();
  });

  await t.test("prompt bridge", async () => {
    const events = createEventBus();
    let executeCalls = 0;
    const bridge = promptBridgeModule.registerPromptTemplateDelegationBridge({
      events,
      getContext: () => ctx,
      async execute() {
        executeCalls += 1;
        return { content: [{ type: "text", text: "must not execute" }], details: { mode: "single", results: [] } };
      },
    });
    events.resetActivity();
    events.emit(promptBridgeModule.PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
      requestId: "managed-prompt-denial",
      agent: "reader",
      task: "denied",
      context: "fork",
      model: "fixture/host-model",
      cwd: ctx.cwd,
    });
    const response = await waitForValue(() => events.snapshotActivity().emissions
      .find(({ name }) => name === promptBridgeModule.PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT)?.payload);
    const names = events.snapshotActivity().emissions.map(({ name }) => name);
    assert.equal(executeCalls, 0);
    assert.equal(names.includes(promptBridgeModule.PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT), false);
    assert.match(response.errorText, /Managed subagent policy rejects call-level override/);
    bridge.dispose();
  });

  await t.test("RPC bridge", async () => {
    const events = createEventBus();
    let executeCalls = 0;
    const bridge = rpcModule.registerSubagentRpcBridge({
      events,
      getContext: () => ctx,
      async execute() {
        executeCalls += 1;
        return { content: [{ type: "text", text: "must not execute" }], details: { mode: "single", results: [] } };
      },
    });
    events.resetActivity();
    events.emit(rpcModule.SUBAGENT_RPC_REQUEST_EVENT, {
      version: rpcModule.SUBAGENT_RPC_PROTOCOL_VERSION,
      requestId: "managed-rpc-denial",
      method: "spawn",
      params: { agent: "reader", task: "denied" },
    });
    const response = await waitForValue(() => events.snapshotActivity().emissions
      .find(({ name }) => name === rpcModule.subagentRpcReplyEvent("managed-rpc-denial"))?.payload);
    assert.equal(executeCalls, 0);
    assert.equal(response.success, false);
    assert.equal(response.error.code, "invalid_params");
    assert.match(response.error.message, /rejects asynchronous child execution/);
    bridge.dispose();
  });
});

test("managed child import cannot register the subagent controller recursively", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-nested-controller-"));
  const agentDir = path.join(root, "agent");
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let propertyReads = 0;
  try {
    const { default: registerSubagentExtension } = await loadSubagentModule("src/extension/index.ts");
    registerSubagentExtension(new Proxy({}, {
      get() {
        propertyReads += 1;
        throw new Error("child controller touched the extension API");
      },
    }));
    assert.equal(propertyReads, 0);
    assert.equal(fs.existsSync(agentDir), false);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested child attempts are denied before process or session creation", async () => {
  await withExecutor(async ({ executor, ctx, logDir, parentSessionFile }) => {
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "1";
    try {
      const result = await executor.execute("nested", {
        agent: "reader",
        task: "must-not-start",
      }, new AbortController().signal, undefined, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Nested subagent call blocked \(depth=1, max=1\)/);
      assert.deepEqual(fs.readdirSync(logDir), []);
      assert.equal(fs.existsSync(path.join(path.dirname(parentSessionFile), "parent")), false);
    } finally {
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    }
  });
});

test("shutdown closes the foreground spawn gate until a clean session starts", async () => {
  await withExecutor(async ({ managedPolicy }) => {
    await managedPolicy.terminateManagedForegroundChildren();
    assert.throws(
      () => managedPolicy.assertManagedForegroundSpawnAllowed(),
      /Managed subagent child spawn rejected during session shutdown/,
    );
    managedPolicy.beginManagedChildSession();
    assert.doesNotThrow(() => managedPolicy.assertManagedForegroundSpawnAllowed());
  });
});

test("the first ESRCH permanently releases a managed PGID generation", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group ownership is not available on Windows");
    return;
  }
  const managedPolicy = await loadSubagentModule("src/managed-policy.ts");
  const cases = [
    {
      name: "probe release",
      expected: [[-910_001, 0]],
      respond(calls) {
        if (calls.length === 1) throw Object.assign(new Error("released"), { code: "ESRCH" });
        throw new Error("reused PGID was probed");
      },
      pid: 910_001,
    },
    {
      name: "signal release",
      expected: [[-910_002, 0], [-910_002, "SIGTERM"]],
      respond(calls) {
        if (calls.length === 1) return true;
        if (calls.length === 2) throw Object.assign(new Error("released"), { code: "ESRCH" });
        throw new Error("reused PGID was probed or signaled");
      },
      pid: 910_002,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      managedPolicy.beginManagedChildSession();
      const originalKill = process.kill;
      const calls = [];
      process.kill = (target, signal) => {
        calls.push([target, signal]);
        return fixture.respond(calls);
      };
      try {
        const child = managedPolicy.registerManagedForegroundChild({
          pid: fixture.pid,
          kill() { throw new Error("PID fallback must not be used for a POSIX group"); },
        });
        await child.terminate();
        await child.release();
        await child.leaderExited();
        assert.deepEqual(calls, fixture.expected);
      } finally {
        process.kill = originalKill;
      }
    });
  }
});

test("a spawn error before PID assignment creates no managed group ownership", async () => {
  const managedPolicy = await loadSubagentModule("src/managed-policy.ts");
  managedPolicy.beginManagedChildSession();
  let fallbackSignals = 0;
  const child = managedPolicy.registerManagedForegroundChild({
    kill() {
      fallbackSignals += 1;
      return false;
    },
  });
  await child.leaderExited();
  await child.release();
  await child.terminate();
  await managedPolicy.terminateManagedForegroundChildren();
  assert.equal(fallbackSignals, 0);
  managedPolicy.beginManagedChildSession();
});

async function startManagedTree(executor, ctx, logDir, label) {
  const controller = new AbortController();
  const previousTree = process.env.PI_SUBAGENT_FIXTURE_TREE;
  process.env.PI_SUBAGENT_FIXTURE_TREE = "1";
  let execution;
  let tree;
  try {
    execution = executor.execute(label, {
      agent: "worker",
      task: `[managed-tree] ${label}`,
      agentContract: { version: 1 },
    }, controller.signal, undefined, ctx);
    tree = await waitForValue(() => {
      const [entry] = readFixtureTrees(logDir);
      return entry;
    }).catch((error) => {
      const entries = fs.existsSync(logDir) ? fs.readdirSync(logDir).sort() : [];
      throw new Error(`${error.message}; fixture entries: ${JSON.stringify(entries)}`, { cause: error });
    });
  } finally {
    if (previousTree === undefined) delete process.env.PI_SUBAGENT_FIXTURE_TREE;
    else process.env.PI_SUBAGENT_FIXTURE_TREE = previousTree;
  }
  await waitForValue(() => processExists(tree.parentPid) && processExists(tree.descendantPid) ? true : undefined);
  return { controller, execution, tree };
}

test("explicit cancellation releases the owned process group without signaling an unrelated process", { timeout: 30_000 }, async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    const unrelatedReady = path.join(logDir, "unrelated.ready");
    const unrelatedSignals = path.join(logDir, "unrelated.signals");
    const unrelated = childProcess.spawn(process.execPath, [fakePiFixture, "--managed-unrelated", unrelatedReady, unrelatedSignals], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    try {
      await waitForValue(() => fs.existsSync(unrelatedReady) ? true : undefined);
      const { controller, execution, tree } = await startManagedTree(executor, ctx, logDir, "cancel-tree");
      const ownedGroupBefore = process.platform === "win32" ? true : processGroupExists(tree.parentPid);
      controller.abort(new Error("fixture cancellation"));
      const outcome = await settleWithin(execution, 6000);
      const observed = {
        descendantAlive: processExists(tree.descendantPid),
        groupAlive: process.platform === "win32" ? false : processGroupExists(tree.parentPid),
        parentAlive: processExists(tree.parentPid),
        settled: outcome.settled,
        unrelatedAlive: processExists(unrelated.pid),
        unrelatedSignals: fs.existsSync(unrelatedSignals) ? fs.readFileSync(unrelatedSignals, "utf8") : "",
      };
      const termRecipients = new Set(
        fs.readFileSync(tree.signalFile, "utf8")
          .trim()
          .split("\n")
          .filter((entry) => entry.endsWith(":SIGTERM"))
          .map((entry) => Number(entry.slice(0, entry.indexOf(":")))),
      );
      assert.equal(ownedGroupBefore, true);
      assert.deepEqual([...termRecipients].sort((left, right) => left - right), [tree.parentPid, tree.descendantPid].sort((left, right) => left - right));
      assert.deepEqual(observed, {
        descendantAlive: false,
        groupAlive: false,
        parentAlive: false,
        settled: true,
        unrelatedAlive: true,
        unrelatedSignals: "",
      });
      disarmFixtureTree(tree);
    } finally {
      if (process.platform !== "win32" && processGroupExists(unrelated.pid)) {
        try { process.kill(-unrelated.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      } else {
        killFixturePid(unrelated.pid);
      }
    }
  });
});

test("foreground detach callbacks cannot transfer managed child ownership", { timeout: 30_000 }, async () => {
  await withExecutor(async ({ executor, ctx, logDir, state }) => {
    const { controller, execution, tree } = await startManagedTree(executor, ctx, logDir, "detach-tree");
    const [control] = state.foregroundControls.values();
    assert.ok(control);
    assert.equal(control.detach?.(), false);
    assert.equal(processExists(tree.parentPid), true);
    assert.equal(processExists(tree.descendantPid), true);
    controller.abort(new Error("fixture cleanup"));
    const outcome = await settleWithin(execution, 6000);
    assert.equal(outcome.settled, true);
    assert.equal(processExists(tree.parentPid), false);
    assert.equal(processExists(tree.descendantPid), false);
    assert.equal(process.platform === "win32" ? false : processGroupExists(tree.parentPid), false);
    disarmFixtureTree(tree);
  });
});

test("leader exit and child errors release ordinary descendants in the registered group", { timeout: 30_000 }, async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    for (const fixture of [
      { label: "leader-exit", expectedExitCode: 0, suffix: "" },
      { label: "child-error", expectedExitCode: 7, suffix: " [fail]" },
    ]) {
      const result = await executor.execute(fixture.label, {
        agent: "worker",
        task: `[managed-tree-exit] ${fixture.label}${fixture.suffix}`,
        agentContract: { version: 1 },
      }, new AbortController().signal, undefined, ctx);
      const [tree] = readFixtureTrees(logDir);
      assert.ok(tree);
      const termRecipients = new Set(
        fs.readFileSync(tree.signalFile, "utf8")
          .trim()
          .split("\n")
          .filter((entry) => entry.endsWith(":SIGTERM"))
          .map((entry) => Number(entry.slice(0, entry.indexOf(":")))),
      );
      assert.equal(tree.processGroupId, tree.parentPid);
      assert.equal(result.details.results[0].exitCode, fixture.expectedExitCode);
      assert.deepEqual([...termRecipients], [tree.descendantPid]);
      assert.equal(processExists(tree.parentPid), false);
      assert.equal(processExists(tree.descendantPid), false);
      assert.equal(processGroupExists(tree.processGroupId), false);
      disarmFixtureTree(tree);
    }
  });
});

test("parent shutdown escalates and releases every managed child process group", { timeout: 30_000 }, async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    const runtime = await loadExtensionRuntime();
    const { execution, tree } = await startManagedTree(executor, ctx, logDir, "shutdown-tree");
    const shutdownOutcome = await settleWithin(runtime.emit("session_shutdown", { reason: "quit" }, ctx), 6000);
    const executionOutcome = await settleWithin(execution, 1000);
    assert.deepEqual({
      child: processExists(tree.parentPid),
      descendant: processExists(tree.descendantPid),
      group: process.platform === "win32" ? false : processGroupExists(tree.parentPid),
      executionSettled: executionOutcome.settled,
      shutdownSettled: shutdownOutcome.settled,
    }, {
      child: false,
      descendant: false,
      group: false,
      executionSettled: true,
      shutdownSettled: true,
    });
    disarmFixtureTree(tree);
  });
});

test("session shutdown awaits child cleanup for Pi terminating signals and detach is disabled", () => {
  const runtime = buildRuntimePaths();
  const packageRoot = path.join(runtime.extensions, "lib/node_modules/pi-subagents");
  const extensionSource = fs.readFileSync(path.join(packageRoot, "src/extension/index.ts"), "utf8");
  const policySource = fs.readFileSync(path.join(packageRoot, "src/managed-policy.ts"), "utf8");
  const slashSource = fs.readFileSync(path.join(packageRoot, "src/slash/slash-commands.ts"), "utf8");
  const piSource = fs.readFileSync(
    path.join(runtime.pi, "lib/node_modules/@earendil-works/pi-coding-agent/src/modes/interactive/interactive-mode.ts"),
    "utf8",
  );
  assert.match(piSource, /const signals: NodeJS\.Signals\[\] = \["SIGTERM"\][\s\S]+signals\.push\("SIGHUP"\)/);
  assert.match(piSource, /if \(options\?\.fromSignal\)[\s\S]+await this\.runtimeHost\.dispose\(\)/);
  assert.match(extensionSource, /pi\.on\("session_shutdown", async[\s\S]+await terminateManagedForegroundChildren\(\)/);
  const detachCommand = slashSource.slice(slashSource.indexOf('pi.registerCommand("subagents-detach"'), slashSource.indexOf('pi.registerCommand("subagents-stop"'));
  assert.match(detachCommand, /Managed subagent policy rejects detached child execution/);
  assert.doesNotMatch(detachCommand, /control\.detach/);
  assert.doesNotMatch(`${policySource}\n${extensionSource}\n${slashSource}`, /PI_AGENT_TASK_4_2_MANAGED_CHILDREN|managedChildLifecycleEnabled/);
});
