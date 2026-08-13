import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const providerSentinels = {
  ANTHROPIC_API_KEY: "task-4-10-anthropic-provider-sentinel",
  OPENAI_API_KEY: "task-4-10-openai-provider-sentinel",
  PI_AGENT_LAUNCH_ID: "41000000-0000-4000-8000-000000000010",
  SHOPIFY_PI_TOKEN: "task-4-10-shopify-provider-sentinel",
};
const ptyProviderSentinels = {
  ANTHROPIC_API_KEY: "task-4-11-anthropic-provider-sentinel",
  OPENAI_API_KEY: "task-4-11-openai-provider-sentinel",
  PI_AGENT_LAUNCH_ID: "41100000-0000-4000-8000-000000000011",
  SHOPIFY_PI_TOKEN: "task-4-11-shopify-provider-sentinel",
};
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let runtimePaths;
let runtimeModules;
let credentialPolicy;
let sessionSequence = 0;
let toolBatchSequence = 0;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-background-task-tests";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      credentialFixture = source + "/tests/pi-agent/fixtures/credential-policy.nix";
      credentialRuntime = import credentialFixture {
        fixture = "shopify-runtime-module";
        repoRoot = source;
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
        filteredFlakeExpression("[ pkgs.pi-agent pkgs.pi-agent-extensions credentialRuntime ]"),
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
    credentialPolicy: outputs.find((output) =>
      fs.existsSync(path.join(output, "lib/pi-agent/credential-policy.mjs")),
    ),
  };
  for (const [name, output] of Object.entries(runtimePaths)) {
    assert.match(output ?? "", /^\/nix\/store\//, `missing ${name} runtime output`);
  }
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

async function loadCredentialPolicy() {
  if (credentialPolicy) return credentialPolicy;
  const runtime = buildRuntimePaths();
  credentialPolicy = await import(
    `${pathToFileURL(path.join(runtime.credentialPolicy, "lib/pi-agent/credential-policy.mjs")).href}?task410`
  );
  return credentialPolicy;
}

function backgroundExtensionPath() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts",
  );
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

function replaceProcessStream(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, name);
  assert.ok(descriptor?.configurable, `process.${name} is not replaceable`);
  Object.defineProperty(process, name, { configurable: true, value });
  return () => Object.defineProperty(process, name, descriptor);
}

function createTerminalHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  const tuiEvents = [];
  input.isRaw = false;
  input.setRawMode = (raw) => {
    input.isRaw = raw;
    return input;
  };
  output.columns = 96;
  output.rows = 28;
  output.isTTY = true;
  output.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)));
  return {
    input,
    output,
    outputText() {
      return Buffer.concat(outputChunks).toString("utf8");
    },
    tui: {
      requestRender(force) {
        tuiEvents.push(["render", force]);
      },
      start() {
        tuiEvents.push(["start"]);
      },
      stop() {
        tuiEvents.push(["stop"]);
      },
    },
    tuiEvents,
  };
}

async function waitForCondition(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    error.message = `${error.message} probing process group ${pgid}`;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function assertProcessGroupGone(pgid) {
  await waitForCondition(() => !processGroupExists(pgid), `process group ${pgid} to reach ESRCH`);
  assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
}

async function forceCleanupProcessGroups(pgids) {
  for (const pgid of pgids) {
    if (!Number.isInteger(pgid) || pgid <= 0) continue;
    try {
      if (!processGroupExists(pgid)) continue;
    } catch (error) {
      if (error?.code === "EPERM") continue;
      throw error;
    }
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    }
  }
  for (const pgid of pgids) {
    if (!Number.isInteger(pgid) || pgid <= 0) continue;
    await waitForCondition(() => {
      try {
        return !processGroupExists(pgid);
      } catch (error) {
        if (error?.code === "EPERM") return true;
        throw error;
      }
    }, `cleanup of process group ${pgid}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function createUi(options = {}) {
  const notifications = [];
  return {
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
    async custom(factory) {
      if (!options.terminal) return undefined;
      return new Promise((resolve) => {
        factory(options.terminal.tui, {}, {}, resolve);
      });
    },
    notify(message, level) {
      notifications.push({ level, message });
    },
    notifications,
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

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function recordingShellSource(environmentDir) {
  return `#!${process.execPath}
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(
  path.join(${JSON.stringify(environmentDir)}, process.pid + ".json"),
  JSON.stringify(process.env),
);
const result = childProcess.spawnSync("/bin/sh", process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
}

function delayedPtyProviderSource(delayMs) {
  const nodePtyPath = path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/node-pty/lib/index.js",
  );
  return `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const nodePty = require(${JSON.stringify(nodePtyPath)});

export default function delayedPtyProvider(pi) {
  let registered = false;
  pi.on("session_start", () => {
    if (registered) return;
    registered = true;
    pi.events.emit("bg:register", {
      id: "task-411-delayed-pty",
      priority: 1000,
      resolveShell(command, interactive, context) {
        if (!interactive) return null;
        return {
          file: "/bin/sh",
          args: ["-c", command],
          cwd: context.cwd,
          env: { ...process.env },
        };
      },
      ptySpawn(file, args, options) {
        const terminal = nodePty.spawn(file, args, options);
        return new Proxy(terminal, {
          get(target, property) {
            if (property === "onExit") {
              return (listener) => target.onExit((event) => {
                setTimeout(() => listener(event), ${JSON.stringify(delayMs)});
              });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
  });
}
`;
}

function processGroupOperationsWrapperSource(gatePath, logPath) {
  return `
import fs from "node:fs";
import backgroundTasks from ${JSON.stringify(pathToFileURL(backgroundExtensionPath()).href)};

function gateMode() {
  try {
    return fs.readFileSync(${JSON.stringify(gatePath)}, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "real";
    throw error;
  }
}

function runGroupOperation(processGroupId, signal) {
  const mode = gateMode();
  const operation = { mode, processGroupId, signal };
  if (mode === "suppress-term") {
    if (signal === "SIGTERM") {
      fs.appendFileSync(
        ${JSON.stringify(logPath)},
        JSON.stringify({ ...operation, outcome: "suppressed" }) + "\\n",
        "utf8",
      );
      return true;
    }
    try {
      const result = process.kill(-processGroupId, signal);
      fs.appendFileSync(
        ${JSON.stringify(logPath)},
        JSON.stringify({
          ...operation,
          outcome: signal === 0 ? "live" : "delivered",
        }) + "\\n",
        "utf8",
      );
      return result;
    } catch (error) {
      fs.appendFileSync(
        ${JSON.stringify(logPath)},
        JSON.stringify({ ...operation, outcome: "error", code: error?.code ?? null }) + "\\n",
        "utf8",
      );
      throw error;
    }
  }
  fs.appendFileSync(
    ${JSON.stringify(logPath)},
    JSON.stringify(operation) + "\\n",
    "utf8",
  );
  if (mode === "eperm") {
    throw Object.assign(new Error("synthetic process-group EPERM"), { code: "EPERM" });
  }
  if (mode === "live") return true;
  return process.kill(-processGroupId, signal);
}

export default function managedBackgroundTasks(pi) {
  backgroundTasks(pi, {
    localProcessGroupProbe(processGroupId) {
      return runGroupOperation(processGroupId, 0);
    },
    localProcessGroupSignal(processGroupId, signal) {
      return runGroupOperation(processGroupId, signal);
    },
  });
}
`;
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
  const policy = await loadCredentialPolicy();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-background-tasks-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const homeDir = path.join(root, "home");
  const environmentDir = path.join(root, "pipe-environments");
  for (const directory of [cwd, agentDir, sessionsDir, homeDir, environmentDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const recordingShell = path.join(root, "recording-shell.cjs");
  fs.writeFileSync(recordingShell, recordingShellSource(environmentDir), { mode: 0o755 });
  writeJson(path.join(agentDir, "settings.json"), { shellPath: recordingShell });
  const groupOperationsGate = path.join(root, "process-group-operations.gate");
  const groupOperationsLog = path.join(root, "process-group-operations.jsonl");
  const additionalExtensionPaths = [];
  if (options.groupOperationGate) {
    const wrapper = path.join(root, "background-tasks-wrapper.mjs");
    fs.writeFileSync(
      wrapper,
      processGroupOperationsWrapperSource(groupOperationsGate, groupOperationsLog),
      "utf8",
    );
    additionalExtensionPaths.push(wrapper);
  } else {
    additionalExtensionPaths.push(backgroundExtensionPath());
  }
  if (options.delayedPtyExitMs !== undefined) {
    const delayedProvider = path.join(root, "delayed-pty-provider.mjs");
    fs.writeFileSync(delayedProvider, delayedPtyProviderSource(options.delayedPtyExitMs), "utf8");
    additionalExtensionPaths.push(delayedProvider);
  }

  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_AGENT_BASH_TIMEOUT_MS: "4100",
    TASK_4_10_UNLISTED_SENTINEL: "task-4-10-unlisted-sentinel",
    ...providerSentinels,
    ...options.environment,
  });

  try {
    const expectedManagedEnvironment = policy.scrubEnvironment({ ...process.env });
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const restoreStreams = [];
    if (options.terminal) {
      restoreStreams.push(replaceProcessStream("stdin", options.terminal.input));
      restoreStreams.push(replaceProcessStream("stdout", options.terminal.output));
    }
    try {
      await resourceLoader.reload();
    } finally {
      for (const restore of restoreStreams.reverse()) restore();
    }
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "reviewed Pi model fixture is unavailable");
    const sessionManager = SessionManager.create(cwd, sessionsDir, {
      id: `background-tasks-${++sessionSequence}`,
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
    const extensionErrors = [];
    const ui = createUi(options);
    await session.bindExtensions({
      uiContext: ui,
      mode: options.mode ?? "rpc",
      onError(error) {
        extensionErrors.push(error);
      },
    });
    assert.deepEqual(extensionErrors, []);
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(extensionErrors, []);
    const pendingToolOperations = new Set();

    return {
      createAssistantMessageEventStream,
      cwd,
      environmentDir,
      expectedManagedEnvironment,
      extensionErrors,
      groupOperationGate: options.groupOperationGate === true,
      pendingToolOperations,
      readGroupOperations() {
        if (!fs.existsSync(groupOperationsLog)) return [];
        return fs.readFileSync(groupOperationsLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
      restoreEnvironment,
      root,
      session,
      setGroupOperationMode(mode) {
        assert.equal(
          pendingToolOperations.size,
          0,
          "process-group fault gate changed while a tool call was unresolved",
        );
        if (mode === null) {
          fs.rmSync(groupOperationsGate, { force: true });
          return;
        }
        assert.match(mode, /^(?:eperm|live|suppress-term)$/);
        fs.writeFileSync(groupOperationsGate, `${mode}\n`, "utf8");
      },
      ui,
    };
  } catch (error) {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeSession(fixture) {
  if (fixture.closed) return;
  fixture.closed = true;
  try {
    while (fixture.pendingToolOperations.size > 0) {
      const pending = [...fixture.pendingToolOperations];
      await fixture.session.abort().catch(() => {});
      await Promise.allSettled(pending);
    }
    if (fixture.groupOperationGate) fixture.setGroupOperationMode(null);
    try {
      await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      fixture.session.dispose();
    }
  } finally {
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function closeSessionWithEmergencyCleanup(fixture, pgids) {
  try {
    await closeSession(fixture);
  } finally {
    await forceCleanupProcessGroups(pgids);
  }
}

function executeToolBatch(fixture, calls) {
  const operation = executeToolBatchOperation(fixture, calls);
  fixture.pendingToolOperations.add(operation);
  operation.then(
    () => fixture.pendingToolOperations.delete(operation),
    () => fixture.pendingToolOperations.delete(operation),
  );
  return operation;
}

async function executeToolBatchOperation(fixture, calls) {
  const batch = ++toolBatchSequence;
  const toolCalls = calls.map((call, index) => ({
    type: "toolCall",
    id: `background-task-${sessionSequence}-${batch}-${index}`,
    name: call.tool,
    arguments: call.arguments,
  }));
  let responseIndex = 0;
  fixture.session.agent.streamFunction = (model) => {
    const message =
      responseIndex++ === 0
        ? assistantMessage(model, toolCalls, "toolUse")
        : assistantMessage(model, [{ type: "text", text: "background fixture complete" }], "stop");
    const stream = fixture.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  await fixture.session.prompt(`Run managed background fixture ${sessionSequence}`);
  await fixture.session.waitForIdle();
  const branch = fixture.session.sessionManager.getBranch();
  return new Map(
    calls.map((call, index) => {
      const message = branch.findLast(
        (entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === toolCalls[index].id,
      )?.message;
      assert.ok(message, `missing ${call.key} result`);
      assert.equal(message.isError, false, `${call.key}: ${resultText(message)}`);
      return [call.key, message];
    }),
  );
}

async function waitForTaskTerminalOutput(fixture, id, pattern) {
  let result;
  let attempt = 0;
  await waitForCondition(async () => {
    const key = `logs-${++attempt}`;
    const results = await executeToolBatch(fixture, [{
      key,
      tool: "bg_logs",
      arguments: { id, stream: "terminal", tail: 30 },
    }]);
    result = results.get(key);
    return pattern.test(resultText(result));
  }, `task ${id} terminal output ${pattern}`);
  return result;
}

function resultText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function cooperativeCommand(name, peer) {
  return [
    `printf '${name}:started\\n'`,
    `: > .${name}-started`,
    "attempt=0",
    `while [ ! -f .${peer}-started ]; do attempt=$((attempt + 1)); if [ \"$attempt\" -ge 500 ]; then printf '${name}:peer-timeout\\n'; exit 41; fi; sleep 0.01; done`,
    "IFS= read -r value",
    `printf '${name}:input:%s\\n${name}:finished\\n' \"$value\"`,
  ].join("; ");
}

function writeInteractivePtyFixture(fixture) {
  const inputMarker = path.join(fixture.cwd, "pty-tool-input-received");
  const script = path.join(fixture.cwd, "interactive-pty.cjs");
  fs.writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      'const readline = require("node:readline");',
      `const inputMarker = ${JSON.stringify(inputMarker)};`,
      `const names = ${JSON.stringify(Object.keys(ptyProviderSentinels))};`,
      'for (const name of names) process.stdout.write(`${name}=<${process.env[name] ?? ""}>\\n`);',
      'process.stdout.write("pty-ready\\n");',
      'const lines = readline.createInterface({ input: process.stdin, terminal: false });',
      'let received = 0;',
      'lines.on("line", (line) => {',
      '  received += 1;',
      '  process.stdout.write(`${received === 1 ? "pty-attach" : "pty-tool"}:${line}\\n`, () => {',
      '    if (received === 2) fs.writeFileSync(inputMarker, "received\\n");',
      '  });',
      '});',
      'process.on("SIGTERM", () => { process.stdout.write("pty-sigterm\\n"); process.exit(0); });',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );
  return {
    command: `${quoteShell(process.execPath)} ${quoteShell(script)}`,
    inputMarker,
  };
}

function writeStubbornPtyFixture(fixture, name, options = {}) {
  const pidFile = path.join(fixture.cwd, `${name}.pid`);
  const termMarker = options.termMarker ?? path.join(fixture.cwd, `${name}.term`);
  const script = path.join(fixture.cwd, `${name}.cjs`);
  fs.writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      `const termMarker = ${JSON.stringify(termMarker)};`,
      'process.on("SIGTERM", () => { fs.writeFileSync(termMarker, "term\\n"); });',
      'process.on("SIGHUP", () => {});',
      'setInterval(() => {}, 1000);',
      'setImmediate(() => {',
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      '  process.stdout.write("stubborn-ready\\n");',
      '});',
    ].join("\n"),
    "utf8",
  );
  return {
    command: `trap '' TERM HUP; exec ${quoteShell(process.execPath)} ${quoteShell(script)}`,
    pidFile,
    script,
    termMarker,
  };
}

function writeLeaderExitPtyFixture(fixture, name, options = {}) {
  const descendant = writeStubbornPtyFixture(fixture, `${name}-descendant`, options);
  const gate = options.gated ? path.join(fixture.cwd, `${name}.gate`) : null;
  const parts = [
    `(${descendant.command}) &`,
    ...(gate ? [`while [ ! -f ${quoteShell(gate)} ]; do sleep 0.01; done`] : []),
    "exit 0",
  ];
  return {
    ...descendant,
    command: parts.join("\n"),
    gate,
  };
}

async function readFixturePid(pidFile) {
  await waitForCondition(() => fs.existsSync(pidFile), `${path.basename(pidFile)} creation`);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, `invalid fixture PID in ${pidFile}`);
  assert.equal(processExists(pid), true, `fixture process ${pid} is not running`);
  return pid;
}

function assertCapturedManagedEnvironments(fixture, expectedMinimum, boundary) {
  const files = fs.readdirSync(fixture.environmentDir).sort();
  assert.ok(files.length >= expectedMinimum, `expected ${expectedMinimum} ${boundary} environment captures`);
  for (const file of files) {
    const captured = JSON.parse(fs.readFileSync(path.join(fixture.environmentDir, file), "utf8"));
    for (const name of [...Object.keys(ptyProviderSentinels), "PI_AGENT_BASH_TIMEOUT_MS"]) {
      assert.equal(Object.hasOwn(captured, name), false, `${name} crossed the ${boundary} spawn boundary`);
    }
    const {
      __CF_USER_TEXT_ENCODING: darwinInjectedEncoding,
      PWD: nodePtyWorkingDirectory,
      ...managedEnvironment
    } = captured;
    if (darwinInjectedEncoding !== undefined) assert.match(darwinInjectedEncoding, /^0x[0-9A-F]+:/);
    assert.equal(nodePtyWorkingDirectory, fixture.cwd);
    assert.deepEqual(managedEnvironment, fixture.expectedManagedEnvironment);
  }
}

function assertStableId(results, startKey, relatedKeys) {
  const id = results.get(startKey).details.id;
  assert.match(id, /^[a-z0-9]{4}$/);
  for (const key of relatedKeys) {
    assert.equal(results.get(key).details.id, id, `${key} changed task ID`);
  }
  return id;
}

test("managed pipe tasks preserve ordered concurrent control, bounded logs, and scrubbed credentials", { timeout: 120_000 }, async () => {
  const fixture = await createSession();
  try {
    const largeOutputScript = path.join(fixture.cwd, "large-output.cjs");
    fs.writeFileSync(
      largeOutputScript,
      [
        'const line = "x".repeat(1023) + "\\n";',
        'process.stdout.write("discarded-prefix\\n" + line.repeat(4200));',
        'process.stdout.write("retained-tail\\n");',
        ...Object.keys(providerSentinels).map(
          (name) => `process.stdout.write(${JSON.stringify(`${name}=<`)} + (process.env[${JSON.stringify(name)}] ?? "") + ">\\n");`,
        ),
      ].join("\n"),
      "utf8",
    );

    const calls = [
      { key: "alpha-start", tool: "bg_start", arguments: { name: "alpha", command: cooperativeCommand("alpha", "beta") } },
      { key: "alpha-status", tool: "bg_status", arguments: { id: "alpha" } },
      { key: "alpha-send", tool: "bg_send", arguments: { id: "alpha", input: "payload-alpha\n" } },
      { key: "alpha-wait", tool: "bg_wait", arguments: { id: "alpha", timeout: 10 } },
      { key: "alpha-logs", tool: "bg_logs", arguments: { id: "alpha", stream: "stdout", tail: 20 } },
      { key: "beta-start", tool: "bg_start", arguments: { name: "beta", command: cooperativeCommand("beta", "alpha") } },
      { key: "beta-status", tool: "bg_status", arguments: { id: "beta" } },
      { key: "beta-send", tool: "bg_send", arguments: { id: "beta", input: "payload-beta\n" } },
      { key: "beta-wait", tool: "bg_wait", arguments: { id: "beta", timeout: 10 } },
      { key: "beta-logs", tool: "bg_logs", arguments: { id: "beta", stream: "stdout", tail: 20 } },
      { key: "stop-start", tool: "bg_start", arguments: { name: "stop-me", command: "while :; do sleep 1; done" } },
      { key: "stop-status", tool: "bg_status", arguments: { id: "stop-me" } },
      { key: "stop-kill", tool: "bg_kill", arguments: { id: "stop-me" } },
      { key: "stop-wait", tool: "bg_wait", arguments: { id: "stop-me", timeout: 10 } },
      { key: "large-start", tool: "bg_start", arguments: { name: "large-output", command: `${quoteShell(process.execPath)} ${quoteShell(largeOutputScript)}` } },
      { key: "large-wait", tool: "bg_wait", arguments: { id: "large-output", timeout: 20 } },
      { key: "large-logs", tool: "bg_logs", arguments: { id: "large-output", stream: "stdout", tail: 12 } },
    ];
    const results = await executeToolBatch(fixture, calls);

    const alphaId = assertStableId(results, "alpha-start", ["alpha-status", "alpha-send", "alpha-wait", "alpha-logs"]);
    const betaId = assertStableId(results, "beta-start", ["beta-status", "beta-send", "beta-wait", "beta-logs"]);
    assert.notEqual(alphaId, betaId);
    assert.equal(results.get("alpha-status").details.status, "running");
    assert.equal(results.get("beta-status").details.status, "running");
    assert.equal(results.get("alpha-wait").details.status, "completed");
    assert.equal(results.get("beta-wait").details.status, "completed");
    assert.equal(results.get("alpha-wait").details.timedOut, false);
    assert.equal(results.get("beta-wait").details.timedOut, false);
    assert.match(resultText(results.get("alpha-logs")), /alpha:started[\s\S]*alpha:input:payload-alpha[\s\S]*alpha:finished/);
    assert.match(resultText(results.get("beta-logs")), /beta:started[\s\S]*beta:input:payload-beta[\s\S]*beta:finished/);
    assert.doesNotMatch(resultText(results.get("alpha-logs")), /peer-timeout/);
    assert.doesNotMatch(resultText(results.get("beta-logs")), /peer-timeout/);

    assertStableId(results, "stop-start", ["stop-status", "stop-kill", "stop-wait"]);
    assert.equal(results.get("stop-status").details.status, "running");
    assert.equal(results.get("stop-kill").details.status, "stopped");
    assert.equal(results.get("stop-wait").details.status, "stopped");

    const capturedEnvironmentFiles = fs.readdirSync(fixture.environmentDir).sort();
    assert.ok(capturedEnvironmentFiles.length >= 3, "expected real pipe spawn environment captures");
    for (const file of capturedEnvironmentFiles) {
      const captured = JSON.parse(fs.readFileSync(path.join(fixture.environmentDir, file), "utf8"));
      for (const name of [...Object.keys(providerSentinels), "PI_AGENT_BASH_TIMEOUT_MS"]) {
        assert.equal(Object.hasOwn(captured, name), false, `${name} crossed the background pipe spawn boundary`);
      }
      const { __CF_USER_TEXT_ENCODING: darwinInjectedEncoding, ...managedEnvironment } = captured;
      if (darwinInjectedEncoding !== undefined) assert.match(darwinInjectedEncoding, /^0x[0-9A-F]+:/);
      assert.deepEqual(managedEnvironment, fixture.expectedManagedEnvironment);
    }

    assertStableId(results, "large-start", ["large-wait", "large-logs"]);
    assert.equal(results.get("large-wait").details.status, "completed");
    const largeLogs = results.get("large-logs");
    assert.equal(largeLogs.details.truncated, true);
    assert.equal(largeLogs.details.truncation.stdout.truncated, true);
    assert.ok(largeLogs.details.truncation.stdout.retainedBytes <= 4 * 1024 * 1024);
    assert.match(resultText(largeLogs), /stdout output truncated/);
    assert.match(resultText(largeLogs), /retained-tail/);
    assert.doesNotMatch(resultText(largeLogs), /discarded-prefix/);

    const serializedResults = JSON.stringify([...results.values()]);
    for (const sentinel of Object.values(providerSentinels)) {
      assert.equal(serializedResults.includes(sentinel), false, `provider sentinel leaked: ${sentinel}`);
    }
  } finally {
    await closeSession(fixture);
  }
});

test("managed PTY attach, input, Ctrl+] detach, and terminating signal preserve state without credentials", { timeout: 120_000 }, async () => {
  const terminal = createTerminalHarness();
  const fixture = await createSession({
    environment: {
      TASK_4_11_UNLISTED_SENTINEL: "task-4-11-unlisted-sentinel",
      ...ptyProviderSentinels,
    },
    mode: "tui",
    terminal,
  });
  const pgids = [];
  try {
    const interactive = writeInteractivePtyFixture(fixture);
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "interactive-pty", command: interactive.command, pty: true },
    }]);
    const id = assertStableId(started, "start", []);
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    assert.equal(processGroupExists(pgid), true);
    await waitForCondition(
      () => fs.readdirSync(fixture.environmentDir).length === 1,
      "PTY spawn environment capture",
    );

    const attach = fixture.session.prompt(`/bg-attach ${id}`);
    await waitForCondition(
      () => terminal.input.listenerCount("data") > 0,
      "PTY attachment input handler",
    );
    terminal.input.write("attached-via-tui\r");
    await waitForCondition(
      () => terminal.outputText().includes("pty-attach:attached-via-tui"),
      "attached PTY output",
    );
    terminal.input.write("\x1d");
    await attach;

    assert.deepEqual(terminal.tuiEvents.filter(([event]) => event === "stop" || event === "start"), [
      ["stop"],
      ["start"],
    ]);
    assert.ok(fixture.ui.notifications.some(({ message }) => message === 'Detached from "interactive-pty".'));

    const sent = await executeToolBatch(fixture, [
      { key: "status", tool: "bg_status", arguments: { id } },
      { key: "input", tool: "bg_send", arguments: { id, input: "sent-via-tool<Enter>" } },
    ]);
    assert.equal(sent.get("status").details.status, "running");
    assert.equal(sent.get("input").details.mode, "pty");
    assert.equal(processGroupExists(pgid), true, "Ctrl+] detach terminated the PTY group");
    await waitForCondition(() => fs.existsSync(interactive.inputMarker), "PTY tool input marker");

    const logs = await waitForTaskTerminalOutput(fixture, id, /pty-tool:sent-via-tool/);
    const signaled = await executeToolBatch(fixture, [
      { key: "signal", tool: "bg_send", arguments: { id, signal: "SIGTERM" } },
    ]);
    const output = `${terminal.outputText()}\n${resultText(logs)}`;
    assert.match(output, /pty-ready/);
    assert.match(output, /pty-attach:attached-via-tui/);
    assert.match(output, /pty-tool:sent-via-tool/);
    assert.equal(signaled.get("signal").details.status, "stopped");
    assert.equal(signaled.get("signal").details.signal, "SIGTERM");
    await assertProcessGroupGone(pgid);
    assertCapturedManagedEnvironments(fixture, 1, "background PTY");
    for (const sentinel of Object.values(ptyProviderSentinels)) {
      assert.equal(output.includes(sentinel), false, `provider sentinel leaked through PTY output: ${sentinel}`);
    }
    assert.deepEqual(fixture.extensionErrors, []);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("managed PTY kill paths remove stubborn descendant groups and report stopped", { timeout: 120_000 }, async () => {
  const fixture = await createSession({ environment: ptyProviderSentinels, mode: "tui" });
  const pgids = [];
  try {
    const toolFixture = writeStubbornPtyFixture(fixture, "tool-stubborn");
    const toolStart = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "tool-stubborn", command: toolFixture.command, pty: true },
    }]);
    const toolId = toolStart.get("start").details.id;
    const toolPgid = toolStart.get("start").details.pid;
    pgids.push(toolPgid);
    const toolChild = await readFixturePid(toolFixture.pidFile);
    const killed = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id: toolId },
    }]);
    assert.equal(
      killed.get("kill").details.status,
      "stopped",
      resultText(killed.get("kill")),
    );
    await assertProcessGroupGone(toolPgid);
    await waitForCondition(() => !processExists(toolChild), `stubborn child ${toolChild} removal`);

    const commandFixture = writeStubbornPtyFixture(fixture, "command-stubborn");
    const commandStart = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "command-stubborn", command: commandFixture.command, pty: true },
    }]);
    const commandId = commandStart.get("start").details.id;
    const commandPgid = commandStart.get("start").details.pid;
    pgids.push(commandPgid);
    const commandChild = await readFixturePid(commandFixture.pidFile);
    await fixture.session.prompt(`/bg-kill ${commandId}`);
    await assertProcessGroupGone(commandPgid);
    await waitForCondition(() => !processExists(commandChild), `slash-command child ${commandChild} removal`);
    assert.ok(fixture.ui.notifications.some(({ message }) => message.includes(`status: stopped`)));
    assert.deepEqual(fixture.extensionErrors, []);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("managed PTY session shutdown removes every remaining descendant group", { timeout: 120_000 }, async () => {
  const fixture = await createSession({ environment: ptyProviderSentinels });
  const pgids = [];
  try {
    const first = writeStubbornPtyFixture(fixture, "shutdown-first");
    const second = writeStubbornPtyFixture(fixture, "shutdown-second");
    const started = await executeToolBatch(fixture, [
      { key: "first", tool: "bg_start", arguments: { name: "shutdown-first", command: first.command, pty: true } },
      { key: "second", tool: "bg_start", arguments: { name: "shutdown-second", command: second.command, pty: true } },
    ]);
    const firstPgid = started.get("first").details.pid;
    const secondPgid = started.get("second").details.pid;
    pgids.push(firstPgid, secondPgid);
    const firstChild = await readFixturePid(first.pidFile);
    const secondChild = await readFixturePid(second.pidFile);

    await closeSession(fixture);
    await Promise.all(pgids.map(assertProcessGroupGone));
    await waitForCondition(
      () => !processExists(firstChild) && !processExists(secondChild),
      "session-shutdown descendant removal",
    );
    assert.deepEqual(fixture.extensionErrors, []);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("PTY leader exit cleans its group before snapshot restoration and finished-task discard", { timeout: 120_000 }, async () => {
  const fixture = await createSession({ environment: ptyProviderSentinels });
  const pgids = [];
  try {
    const leaderExit = writeLeaderExitPtyFixture(fixture, "leader-exit", { gated: true });
    const started = await executeToolBatch(fixture, [
      { key: "start", tool: "bg_start", arguments: { name: "leader-exit", command: leaderExit.command, pty: true } },
    ]);
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(leaderExit.pidFile);
    const waiting = executeToolBatch(fixture, [
      { key: "wait", tool: "bg_wait", arguments: { id: "leader-exit", timeout: 15 } },
    ]);
    fs.writeFileSync(leaderExit.gate, "exit\n");
    const results = await waiting;

    await fixture.session.extensionRunner.emit({
      type: "session_tree",
      newLeafId: null,
      oldLeafId: null,
    });
    await fixture.session.extensionRunner.emit({
      type: "before_agent_start",
      prompt: "reconcile finished PTY task",
    });

    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `leader-exit descendant ${child} removal`);
    assert.equal(
      results.get("wait").details.status,
      "stopped",
      resultText(results.get("wait")),
    );
    assert.deepEqual(fixture.extensionErrors, []);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("terminating bg_send escalates across the whole resistant PTY group", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const stubborn = writeStubbornPtyFixture(fixture, "signal-stubborn");
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "signal-stubborn", command: stubborn.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(stubborn.pidFile);

    const operationOffset = fixture.readGroupOperations().length;
    let signaled;
    fixture.setGroupOperationMode("suppress-term");
    try {
      signaled = await executeToolBatch(fixture, [{
        key: "signal",
        tool: "bg_send",
        arguments: { id, signal: "SIGTERM" },
      }]);

      const operations = fixture.readGroupOperations().slice(operationOffset);
      const termIndex = operations.findIndex((operation) => operation.signal === "SIGTERM");
      const killIndex = operations.findIndex((operation) => operation.signal === "SIGKILL");
      const liveProbeIndex = operations.findIndex(
        (operation, index) =>
          index > termIndex &&
          index < killIndex &&
          operation.signal === 0 &&
          operation.outcome === "live",
      );
      const esrchProbeIndex = operations.findIndex(
        (operation, index) =>
          index > killIndex &&
          operation.signal === 0 &&
          operation.outcome === "error" &&
          operation.code === "ESRCH",
      );
      assert.deepEqual(
        operations.filter((operation) => operation.signal !== 0),
        [
          {
            mode: "suppress-term",
            processGroupId: pgid,
            signal: "SIGTERM",
            outcome: "suppressed",
          },
          {
            mode: "suppress-term",
            processGroupId: pgid,
            signal: "SIGKILL",
            outcome: "delivered",
          },
        ],
      );
      assert.ok(liveProbeIndex > termIndex, JSON.stringify(operations));
      assert.ok(killIndex > liveProbeIndex, JSON.stringify(operations));
      assert.equal(esrchProbeIndex, operations.length - 1, JSON.stringify(operations));
      assert.equal(fs.existsSync(stubborn.termMarker), false, "suppressed TERM reached the fixture");
    } finally {
      fixture.setGroupOperationMode(null);
    }
    assert.equal(signaled.get("signal").details.status, "stopped");
    assert.equal(signaled.get("signal").details.finalSignal, "SIGKILL");
    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `signal-resistant child ${child} removal`);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("caller abort cannot interrupt PTY TERM-to-KILL safety cleanup", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const stubborn = writeStubbornPtyFixture(fixture, "abort-stubborn");
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "abort-stubborn", command: stubborn.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(stubborn.pidFile);

    const pendingKill = executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id },
    }]);
    await waitForCondition(
      () => fixture.readGroupOperations().some(
        (operation) => operation.processGroupId === pgid && operation.signal === "SIGTERM",
      ),
      "task-scoped process-group TERM observation",
    );
    const outcomes = await Promise.allSettled([pendingKill, fixture.session.abort()]);

    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `aborted-cleanup child ${child} removal`);
    if (outcomes[0].status === "fulfilled") {
      assert.equal(outcomes[0].value.get("kill").details.status, "stopped");
    }
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("transport EPERM remains visible and preserves the PGID through restore and discard for retry", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const leaderExit = writeLeaderExitPtyFixture(fixture, "eperm-leader", { gated: true });
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "eperm-leader", command: leaderExit.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(leaderExit.pidFile);

    fixture.setGroupOperationMode("eperm");
    const waiting = executeToolBatch(fixture, [{
      key: "wait",
      tool: "bg_wait",
      arguments: { id, timeout: 10 },
    }]);
    fs.writeFileSync(leaderExit.gate, "exit\n");
    const waited = await waiting;
    await fixture.session.extensionRunner.emit({
      type: "session_tree",
      newLeafId: null,
      oldLeafId: null,
    });
    await fixture.session.extensionRunner.emit({
      type: "before_agent_start",
      prompt: "do not discard unverifiable PTY group",
    });
    fixture.setGroupOperationMode(null);

    assert.equal(waited.get("wait").details.status, "disconnected");
    assert.match(resultText(waited.get("wait")), /EPERM/);
    const retried = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id },
    }]);
    assert.equal(
      retried.get("kill").details.status,
      "stopped",
      `${resultText(retried.get("kill"))}\n${JSON.stringify(fixture.readGroupOperations())}`,
    );
    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `EPERM retry child ${child} removal`);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("cleanup timeout is explicit and retains the PGID for a real retry", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const stubborn = writeStubbornPtyFixture(fixture, "timeout-stubborn");
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "timeout-stubborn", command: stubborn.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(stubborn.pidFile);

    fixture.setGroupOperationMode("live");
    const timedOut = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id },
    }]);
    fixture.setGroupOperationMode(null);

    assert.match(resultText(timedOut.get("kill")), /timed out/i);
    assert.equal(processGroupExists(pgid), true);
    const retried = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id, force: true },
    }]);
    assert.equal(
      retried.get("kill").details.status,
      "stopped",
      `${resultText(retried.get("kill"))}\n${JSON.stringify(fixture.readGroupOperations())}`,
    );
    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `timeout retry child ${child} removal`);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("retry after retained PGID disappearance waits for delayed transport without fabricating a signal", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    delayedPtyExitMs: 400,
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const stubborn = writeStubbornPtyFixture(fixture, "released-before-retry");
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "released-before-retry", command: stubborn.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(stubborn.pidFile);

    fixture.setGroupOperationMode("live");
    const timedOut = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id },
    }]);
    fixture.setGroupOperationMode(null);
    assert.match(resultText(timedOut.get("kill")), /timed out/i);

    process.kill(-pgid, "SIGKILL");
    await assertProcessGroupGone(pgid);
    const operationOffset = fixture.readGroupOperations().length;
    const retried = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id },
    }]);

    const result = retried.get("kill");
    assert.deepEqual(
      fixture.readGroupOperations().slice(operationOffset),
      [{ mode: "real", processGroupId: pgid, signal: 0 }],
    );
    assert.equal(result.details.status, "stopped", resultText(result));
    assert.doesNotMatch(resultText(result), /Sent SIGTERM/);
    assert.equal(result.details.groupAlreadyReleased, true);
    assert.equal(result.details.signalDelivered, false);
    assert.equal(result.details.signal, "SIGKILL");
    await assertProcessGroupGone(pgid);
    await waitForCondition(() => !processExists(child), `released-before-retry child ${child} removal`);

    const disconnected = writeLeaderExitPtyFixture(fixture, "disconnected-before-retry", { gated: true });
    const disconnectedStart = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "disconnected-before-retry", command: disconnected.command, pty: true },
    }]);
    const disconnectedId = disconnectedStart.get("start").details.id;
    const disconnectedPgid = disconnectedStart.get("start").details.pid;
    pgids.push(disconnectedPgid);
    const disconnectedChild = await readFixturePid(disconnected.pidFile);
    fixture.setGroupOperationMode("eperm");
    const waiting = executeToolBatch(fixture, [{
      key: "wait",
      tool: "bg_wait",
      arguments: { id: disconnectedId, timeout: 10 },
    }]);
    fs.writeFileSync(disconnected.gate, "exit\n");
    const disconnectedWait = await waiting;
    fixture.setGroupOperationMode(null);
    assert.equal(disconnectedWait.get("wait").details.status, "disconnected");

    process.kill(-disconnectedPgid, "SIGKILL");
    await assertProcessGroupGone(disconnectedPgid);
    const disconnectedOperationOffset = fixture.readGroupOperations().length;
    const disconnectedRetry = await executeToolBatch(fixture, [{
      key: "kill",
      tool: "bg_kill",
      arguments: { id: disconnectedId },
    }]);
    const disconnectedResult = disconnectedRetry.get("kill");
    assert.deepEqual(
      fixture.readGroupOperations().slice(disconnectedOperationOffset),
      [{ mode: "real", processGroupId: disconnectedPgid, signal: 0 }],
    );
    assert.equal(disconnectedResult.details.groupAlreadyReleased, true);
    assert.equal(disconnectedResult.details.signalDelivered, false);
    assert.equal(disconnectedResult.details.status, "completed", resultText(disconnectedResult));
    assert.equal(disconnectedResult.details.signal, null);
    assert.doesNotMatch(resultText(disconnectedResult), /Sent SIGTERM/);
    await assertProcessGroupGone(disconnectedPgid);
    await waitForCondition(
      () => !processExists(disconnectedChild),
      `disconnected-before-retry child ${disconnectedChild} removal`,
    );
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("stale PTY release does not fabricate nonterminating signal delivery", { timeout: 120_000 }, async () => {
  const fixture = await createSession({
    delayedPtyExitMs: 2_000,
    environment: ptyProviderSentinels,
    groupOperationGate: true,
  });
  const pgids = [];
  try {
    const stubborn = writeStubbornPtyFixture(fixture, "stale-nonterminating");
    const started = await executeToolBatch(fixture, [{
      key: "start",
      tool: "bg_start",
      arguments: { name: "stale-nonterminating", command: stubborn.command, pty: true },
    }]);
    const id = started.get("start").details.id;
    const pgid = started.get("start").details.pid;
    pgids.push(pgid);
    const child = await readFixturePid(stubborn.pidFile);

    process.kill(-pgid, "SIGKILL");
    await assertProcessGroupGone(pgid);
    const operationOffset = fixture.readGroupOperations().length;
    const outcomes = await executeToolBatch(fixture, [
      {
        key: "signal",
        tool: "bg_send",
        arguments: { id, signal: "SIGCONT" },
      },
      {
        key: "wait",
        tool: "bg_wait",
        arguments: { id, timeout: 10 },
      },
    ]);

    const result = outcomes.get("signal");
    assert.equal(result.details.signalDelivered, false, resultText(result));
    assert.equal(result.details.groupAlreadyReleased, true);
    assert.equal(result.details.status, "stopped", resultText(result));
    assert.equal(result.details.status, outcomes.get("wait").details.status);
    assert.equal(result.details.finalSignal, result.details.signal);
    assert.match(result.details.signal, /^(?:SIGKILL|signal 9)$/);
    assert.notEqual(result.details.signal, "SIGCONT");
    assert.doesNotMatch(resultText(result), /Sent SIGCONT/);
    assert.deepEqual(
      fixture.readGroupOperations().slice(operationOffset),
      [{ mode: "real", processGroupId: pgid, signal: "SIGCONT" }],
    );
    await waitForCondition(() => !processExists(child), `stale nonterminating child ${child} removal`);
  } finally {
    await closeSessionWithEmergencyCleanup(fixture, pgids);
  }
});

test("Task 4.11 fixture teardown nests emergency group cleanup", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.kill\s*=/);
  assert.match(
    source,
    /async function closeSessionWithEmergencyCleanup[\s\S]+try \{[\s\S]+await closeSession\(fixture\);[\s\S]+finally \{[\s\S]+await forceCleanupProcessGroups\(pgids\);/,
  );
});

test("Task 4.10 implementation leaves no feature seam", () => {
  const overlay = fs.readFileSync(path.join(repoRoot, "overlays/pi-agent/default.nix"), "utf8");
  assert.doesNotMatch(overlay, /PI_AGENT_TASK_4_10_BACKGROUND_PIPE/);
});

test("Task 4.11 implementation leaves no feature seam", () => {
  const overlay = fs.readFileSync(path.join(repoRoot, "overlays/pi-agent/default.nix"), "utf8");
  const patch = fs.readFileSync(
    path.join(
      repoRoot,
      "overlays/pi-agent/extensions/patches/pi-background-tasks-managed-pty.patch",
    ),
    "utf8",
  );
  assert.doesNotMatch(`${overlay}\n${patch}`, /PI_AGENT_TASK_4_11_MANAGED_PTY/);
});
