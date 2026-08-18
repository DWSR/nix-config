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
      },
    });
  }
  return jiti.import(path.join(runtime.extensions, "lib/node_modules/pi-subagents", relativePath));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
      extensions: ["cavemem", "mcp"],
      mcp: "read-only",
    },
    worker: {
      model: "host-managed-default",
      maxTurns: 12,
      maxToolCalls: 64,
      workspace: "parent-readwrite",
      tools: expectedWorkerTools,
      extensions: ["cavemem"],
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
  const cavemem = path.join(runtime.extensions, "lib/pi-agent/extensions/cavemem/index.ts");
  const mcp = path.join(runtime.extensions, "lib/pi-agent/extensions/mcpproxy/index.ts");
  assert.deepEqual(plans.reader.effectiveToolAllowlist, expectedReaderTools);
  assert.deepEqual(plans.worker.effectiveToolAllowlist, expectedWorkerTools);
  assert.deepEqual(plans.reader.effectiveMcpSelections, readerMcpSelectors.map((selector, index) => ({
    selector,
    name: expectedReaderTools[index + 4],
  })));
  assert.ok(plans.reader.extensionArgs.includes(cavemem));
  assert.ok(plans.reader.extensionArgs.includes(mcp));
  assert.ok(plans.worker.extensionArgs.includes(cavemem));
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
  return {
    on(name, handler) {
      const entries = handlers.get(name) ?? new Set();
      entries.add(handler);
      handlers.set(name, entries);
      return () => entries.delete(handler);
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler(payload);
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

async function withExecutor(run) {
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
    const [{ discoverAgents }, { loadConfig }, { createSubagentExecutor }] = await Promise.all([
      loadSubagentModule("src/agents/agents.ts"),
      loadSubagentModule("src/extension/config.ts"),
      loadSubagentModule("src/runs/foreground/subagent-executor.ts"),
    ]);
    const events = createEventBus();
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
    await run({ executor, ctx, root, workspace, agentDir, sessionsDir, parentSessionFile, logDir });
  } finally {
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

test("reader loads Cavemem and read-only MCP while worker loads Cavemem only", async () => {
  await withExecutor(async ({ executor, ctx, logDir }) => {
    await executor.execute("resources", {
      tasks: [{ agent: "reader", task: "reader-resources" }, { agent: "worker", task: "worker-resources" }],
      agentContract: { version: 1 },
    }, new AbortController().signal, undefined, ctx);
    const runtime = buildRuntimePaths();
    const cavemem = path.join(runtime.extensions, "lib/pi-agent/extensions/cavemem/index.ts");
    const mcp = path.join(runtime.extensions, "lib/pi-agent/extensions/mcpproxy/index.ts");
    const [reader, worker] = readLaunches(logDir);
    assert.equal(reader.noAmbientExtensions, true);
    assert.equal(worker.noAmbientExtensions, true);
    assert.ok(reader.extensions.includes(cavemem));
    assert.ok(reader.extensions.includes(mcp));
    assert.ok(worker.extensions.includes(cavemem));
    assert.equal(worker.extensions.includes(mcp), false);
    assert.equal(reader.tools, expectedReaderTools.join(","));
    assert.equal(worker.tools, expectedWorkerTools.join(","));
    assert.equal(reader.mcpDirectTools, readerMcpSelectors.join(","));
    assert.equal(worker.mcpDirectTools, "__none__");
    assert.equal(reader.extensions.some((entry) => /(?:plan|stamp|timeout|ask-user|code-intelligence|background-tasks|pi-subagents\/index)/.test(entry)), false);
    assert.equal(worker.extensions.some((entry) => /(?:mcpproxy|plan|stamp|timeout|ask-user|code-intelligence|background-tasks|pi-subagents\/index)/.test(entry)), false);
  });
});
