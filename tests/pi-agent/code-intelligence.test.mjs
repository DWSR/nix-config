import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const managedPatchPath = path.join(
  repoRoot,
  "overlays/pi-agent/extensions/patches/supi-code-intelligence-managed-lsp-lifecycle.patch",
);
const managedBinding = "PI_AGENT_LSP_EXECUTABLES";
const expectedCodeTools = [
  "code_find",
  "code_graph",
  "code_health",
  "code_inspect",
  "code_orientation",
  "code_refactor_apply",
  "code_refactor_plan",
  "code_resolve",
];
const sourceText = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  "}",
  "",
  'export const result = greet("world");',
  "",
].join("\n");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let runtimePaths;
let runtimeModules;
let credentialPolicyModule;
let toolCallSequence = 0;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-code-intelligence-tests";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import (source + "/tests/pi-agent/fixtures/code-intelligence.nix") {
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
        filteredFlakeExpression(`[
          pkgs.pi-agent
          pkgs.pi-agent-extensions
          fixture.validServer
          fixture.failingServer
          fixture.crashingServer
          fixture.isolatedCrashingServer
          fixture.stallingServer
          fixture.credentialRuntimeModule
          fixture.healthyManagedConfig
          fixture.degradedManagedConfig
          fixture.crashingManagedConfig
          fixture.isolatedManagedConfig
        ]`),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.equal(outputs.length, 12, `expected twelve runtime outputs, got ${outputs.join(", ")}`);
  const configs = outputs
    .filter((output) => fs.statSync(output).isFile())
    .map((output) => ({ output, value: JSON.parse(fs.readFileSync(output, "utf8")) }));
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) =>
      fs.existsSync(path.join(output, "share/pi-agent/extensions.json")),
    ),
    validServer: outputs.find((output) =>
      fs.existsSync(path.join(output, "bin/typescript-language-server")),
    ),
    failingServer: outputs.find((output) =>
      fs.existsSync(path.join(output, "bin/pyright-langserver")) &&
      fs.readFileSync(path.join(output, "bin/pyright-langserver"), "utf8").includes(
        "TASK_4_8_FAILED_SERVER_STDERR_SENTINEL",
      ),
    ),
    crashingServer: outputs.find(
      (output) =>
        fs.existsSync(path.join(output, "bin/pyright-langserver")) &&
        fs
          .readFileSync(path.join(output, "bin/pyright-langserver"), "utf8")
          .includes("TASK_4_8_RUNTIME_CRASH_SENTINEL"),
    ),
    isolatedCrashingServer: outputs.find((output) =>
      fs.existsSync(path.join(output, "bin/rust-analyzer")),
    ),
    stallingServer: outputs.find((output) => fs.existsSync(path.join(output, "bin/gopls"))),
    credentialRuntime: outputs.find((output) =>
      fs.existsSync(path.join(output, "lib/pi-agent/credential-policy.mjs")),
    ),
    healthyConfig: configs.find(
      ({ value }) => Object.keys(value.lspExecutables).length === 1,
    ),
  };
  runtimePaths.degradedConfig = configs.find(
    ({ value }) =>
      Object.keys(value.lspExecutables).sort().join(",") === "python,typescript" &&
      value.lspExecutables.python ===
      path.join(runtimePaths.failingServer, "bin/pyright-langserver"),
  );
  runtimePaths.crashingConfig = configs.find(
    ({ value }) =>
      Object.keys(value.lspExecutables).sort().join(",") === "python,typescript" &&
      value.lspExecutables.python ===
      path.join(runtimePaths.crashingServer, "bin/pyright-langserver"),
  );
  runtimePaths.isolatedConfig = configs.find(
    ({ value }) =>
      Object.keys(value.lspExecutables).sort().join(",") === "python,rust,typescript" &&
      value.lspExecutables.rust ===
      path.join(runtimePaths.isolatedCrashingServer, "bin/rust-analyzer"),
  );
  assert.match(runtimePaths.pi ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.extensions ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.validServer ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.failingServer ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.crashingServer ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.isolatedCrashingServer ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.stallingServer ?? "", /^\/nix\/store\//);
  assert.match(runtimePaths.credentialRuntime ?? "", /^\/nix\/store\//);
  assert.ok(runtimePaths.healthyConfig);
  assert.ok(runtimePaths.degradedConfig);
  assert.ok(runtimePaths.crashingConfig);
  assert.ok(runtimePaths.isolatedConfig);
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

async function loadCredentialPolicyModule() {
  if (credentialPolicyModule) return credentialPolicyModule;
  credentialPolicyModule = await import(
    pathToFileURL(
      path.join(buildRuntimePaths().credentialRuntime, "lib/pi-agent/credential-policy.mjs"),
    )
  );
  return credentialPolicyModule;
}

function codeIntelligenceRoot() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@mrclrchtr/supi-code-intelligence",
  );
}

function codeIntelligenceExtensionPath() {
  return path.join(codeIntelligenceRoot(), "src/extension.ts");
}

function planModeExtensionPath() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  );
}

function codeIntelligenceSourcePath(relativePath) {
  return path.join(codeIntelligenceRoot(), "src", relativePath);
}

function nestedLspRoot() {
  return path.join(codeIntelligenceRoot(), "node_modules/@mrclrchtr/supi-lsp");
}

function nestedLspCoreRoot() {
  return path.join(nestedLspRoot(), "node_modules/@mrclrchtr/supi-core");
}

function canonicalBinding(entries) {
  const sorted = Object.create(null);
  for (const name of Object.keys(entries).sort()) sorted[name] = entries[name];
  return JSON.stringify(sorted);
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

function createUi() {
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
    async custom() {
      return undefined;
    },
    notify() {},
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

function makeAmbientServer(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nprintf ambient > ${JSON.stringify(marker)}\nexit 97\n`, {
    mode: 0o755,
  });
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
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pi-code-intelligence-"),
  );
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const homeDir = path.join(root, "home");
  const ambientBin = path.join(root, "ambient-bin");
  const ambientMarker = path.join(root, "ambient-server-ran");
  for (const directory of [cwd, agentDir, sessionsDir, homeDir, ambientBin]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, "source.ts"), sourceText, "utf8");
  fs.writeFileSync(path.join(cwd, "implementation.ts"), "export class Greeter {}\n", "utf8");
  fs.writeFileSync(path.join(cwd, "ambient.py"), "print('ambient')\n", "utf8");
  fs.writeFileSync(path.join(cwd, "source.rs"), "pub fn fixture() {}\n", "utf8");
  fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname = 'fixture'\nversion = '0.1.0'\n");
  writeJson(path.join(cwd, "package.json"), { name: "managed-lsp-fixture", private: true });
  fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname = 'ambient'\n", "utf8");
  writeJson(path.join(cwd, ".pi/settings.json"), {});

  const ambientTypescript = path.join(ambientBin, "typescript-language-server");
  const ambientPython = path.join(ambientBin, "pyright-langserver");
  makeAmbientServer(ambientTypescript, ambientMarker);
  makeAmbientServer(ambientPython, ambientMarker);
  const hostileConfig = {
    lsp: {
      servers: {
        typescript: { command: ambientTypescript, args: ["TASK_4_8_AMBIENT_ARG_SENTINEL"] },
        python: { command: ambientPython },
        ambient: {
          command: ambientTypescript,
          args: [],
          fileTypes: ["ts"],
          rootMarkers: ["package.json"],
        },
      },
    },
  };
  writeJson(path.join(homeDir, ".pi/agent/supi/config.json"), hostileConfig);
  writeJson(path.join(cwd, ".pi/supi/config.json"), hostileConfig);

  const config =
    options.config === "degraded"
      ? runtime.degradedConfig.value
      : options.config === "crashing"
        ? runtime.crashingConfig.value
        : options.config === "isolated"
          ? runtime.isolatedConfig.value
      : runtime.healthyConfig.value;
  const binding = Object.hasOwn(options, "binding")
    ? options.binding
    : canonicalBinding(config.lspExecutables);
  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    ANTHROPIC_API_KEY: "code-intelligence-test-key",
    PATH: `${ambientBin}${path.delimiter}${process.env.PATH ?? ""}`,
    [managedBinding]: binding,
    ...(options.environment ?? {}),
  });

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [
        ...(options.planMode === true ? [planModeExtensionPath()] : []),
        codeIntelligenceExtensionPath(),
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
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "reviewed Pi model fixture is unavailable");
    const sessionManager = SessionManager.create(cwd, sessionsDir, {
      id: `code-intelligence-${Date.now()}-${toolCallSequence}`,
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
    if (options.activeTools) session.setActiveToolsByName(options.activeTools);
    await session.bindExtensions({
      uiContext: createUi(),
      mode: "rpc",
      onError(error) {
        extensionErrors.push(error);
      },
    });
    assert.deepEqual(extensionErrors, []);
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(extensionErrors, []);
    return {
      ambientMarker,
      config,
      createAssistantMessageEventStream,
      cwd,
      extensionErrors,
      restoreEnvironment,
      root,
      session,
      spawnEnvironment: { ...process.env },
    };
  } catch (error) {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeSession(fixture, options = {}) {
  try {
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
  } finally {
    fixture.restoreEnvironment();
    if (options.preserveRoot !== true) {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function executeTool(fixture, name, args) {
  toolCallSequence += 1;
  const toolCallId = `code-intelligence-${toolCallSequence}`;
  let responseIndex = 0;
  fixture.session.agent.streamFunction = (model) => {
    const message =
      responseIndex++ === 0
        ? assistantMessage(
            model,
            [{ type: "toolCall", id: toolCallId, name, arguments: args }],
            "toolUse",
          )
        : assistantMessage(model, [{ type: "text", text: "fixture complete" }], "stop");
    const stream = fixture.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  await fixture.session.prompt(`Run ${name} fixture ${toolCallId}`);
  await fixture.session.waitForIdle();
  const result = fixture.session.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
    )?.message;
  assert.ok(result, `missing ${name} result for ${toolCallId}`);
  return result;
}

function resultText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processGroupExists(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForCondition(predicate, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, `timed out waiting for ${description}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readLifecycle(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
}

function collectTreeText(directory) {
  const chunks = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(collectTreeText(target));
    else if (entry.isFile()) chunks.push(fs.readFileSync(target).toString("utf8"));
  }
  return chunks.join("\n");
}

function assertNoSentinels(value, sentinels, label) {
  for (const sentinel of sentinels) {
    assert.doesNotMatch(value, new RegExp(sentinel), `${label} contained ${sentinel}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function createManagerHarness(createClient) {
  const runtime = buildRuntimePaths();
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pi-lsp-manager-concurrency-"),
  );
  const source = path.join(root, "source.ts");
  fs.writeFileSync(source, sourceText);
  writeJson(path.join(root, "package.json"), { name: "lsp-manager-concurrency", private: true });
  const configLoader = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/config/config.ts"));
  const managerModule = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/manager/manager.ts"));
  const restoreEnvironment = applyEnvironment({
    [managedBinding]: canonicalBinding(runtime.healthyConfig.value.lspExecutables),
  });
  let config;
  try {
    config = configLoader.loadConfig(root);
  } finally {
    restoreEnvironment();
  }
  return {
    manager: new managerModule.LspManager(config, root, { createClient }),
    root,
    source,
  };
}

function fakeManagerClient(name, root, options = {}) {
  const client = {
    hasRegisteredProcessGroup: false,
    name,
    openFiles: [path.join(root, "source.ts")],
    ready: true,
    root,
    serverCapabilities: {},
    shutdownCalls: 0,
    startCalls: 0,
    status: "initializing",
    didOpen() {},
    async shutdown() {
      client.shutdownCalls += 1;
      if (options.shutdown) return options.shutdown(client);
      client.hasRegisteredProcessGroup = false;
      client.status = "shutdown";
    },
    async start() {
      client.startCalls += 1;
      if (options.start) return options.start(client);
      client.hasRegisteredProcessGroup = true;
      client.status = "running";
    },
  };
  return client;
}

function createLifecyclePi() {
  const handlers = new Map();
  return {
    handlers,
    pi: {
      on(name, handler) {
        handlers.set(name, handler);
      },
    },
  };
}

function assertObservedManagedEnvironment(observed, expected, label) {
  const normalized = { ...observed };
  const platformEncoding = normalized.__CF_USER_TEXT_ENCODING;
  delete normalized.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(normalized, expected, label);
  if (platformEncoding !== undefined) assert.equal(typeof platformEncoding, "string", label);
}

async function applyGuardedTool(fixture, toolName, input) {
  const toolCallId = `guard-${toolName}-${++toolCallSequence}`;
  const guard = await fixture.session.agent.beforeToolCall({
    assistantMessage: assistantMessage(fixture.session.model, [], "toolUse"),
    toolCall: { type: "toolCall", id: toolCallId, name: toolName, arguments: input },
    args: input,
    context: { messages: [], systemPrompt: "", tools: [] },
  });
  let result;
  if (!guard?.block) {
    const definition = fixture.session.getToolDefinition(toolName);
    assert.ok(definition, `missing ${toolName} definition`);
    result = await definition.execute(
      toolCallId,
      input,
      undefined,
      undefined,
      fixture.session.extensionRunner.createContext(),
    );
  }
  return { guard, result };
}

function captureRpcRequests(stream, methods) {
  const wanted = new Set(methods);
  const found = new Map();
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${[...wanted].join(", ")}`));
    }, 1_000);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
        if (!match) {
          cleanup();
          reject(new Error("missing Content-Length"));
          return;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return;
        const message = JSON.parse(
          buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
        );
        buffer = buffer.subarray(bodyStart + length);
        if (wanted.has(message.method)) found.set(message.method, message);
        if ([...wanted].every((method) => found.has(method))) {
          cleanup();
          resolve(found);
          return;
        }
      }
    };
    stream.on("data", onData);
  });
}

function writeRpcMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function planId(result) {
  const match = /\*\*Plan ID:\*\* `([^`]+)`/.exec(resultText(result));
  assert.ok(match, `missing plan ID in ${resultText(result)}`);
  return match[1];
}

function renamePlanArguments(newName) {
  return {
    target: { anchor: { file: "source.ts", line: 1, character: 17 } },
    operation: { rename_symbol: { newName } },
  };
}

async function loadTypeScriptModule(file) {
  const piNodeModules = path.join(buildRuntimePaths().pi, "lib/node_modules");
  const { createJiti } = await import(
    pathToFileURL(path.join(piNodeModules, "jiti/lib/jiti.mjs"))
  );
  return createJiti(import.meta.url, {
    alias: {
      "@earendil-works/pi-agent-core": path.join(
        piNodeModules,
        "@earendil-works/pi-agent-core/dist/index.js",
      ),
      "@earendil-works/pi-ai": path.join(piNodeModules, "@earendil-works/pi-ai/dist/index.js"),
      "@earendil-works/pi-ai/compat": path.join(
        piNodeModules,
        "@earendil-works/pi-ai/dist/compat.js",
      ),
      "@earendil-works/pi-coding-agent": path.join(
        piNodeModules,
        "@earendil-works/pi-coding-agent/dist/index.js",
      ),
      "@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works/pi-tui/dist/index.js"),
    },
    moduleCache: false,
  }).import(file);
}

test("Task 4.9 is unconditional and cleanup stays within registered process groups", () => {
  const patch = fs.readFileSync(managedPatchPath, "utf8");
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");

  assert.doesNotMatch(patch, /MANAGED_CODE_INTELLIGENCE_ENABLED/);
  assert.doesNotMatch(patch, /PI_AGENT_TASK_4_9_ENABLED|TASK_4_9_ENABLED/);
  assert.doesNotMatch(additions, /\bsetsid\b|\bpgrep\b|\/proc\/|process[-_ ]tree|pid scan/i);
  assert.doesNotMatch(
    additions,
    /\b(?:fetch|WebSocket|EventSource|telemetry|analytics|sentry|posthog|installPackage)\b|npm\s+install/i,
  );
});

test("managed extension exposes exactly eight code tools and no ambient server extras", async () => {
  const fixture = await createSession();
  try {
    assert.deepEqual(
      fixture.session.getActiveToolNames().filter((name) => name.startsWith("code_")).sort(),
      expectedCodeTools,
    );
    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers"],
    });
    assert.equal(health.isError, false, resultText(health));
    assert.match(resultText(health), /typescript/);
    assert.doesNotMatch(resultText(health), /python|ambient|TASK_4_8_AMBIENT/);
    assert.equal(fs.existsSync(fixture.ambientMarker), false);
  } finally {
    await closeSession(fixture);
  }
});

test("managed executable binding is byte-canonical and isolates invalid entries", async () => {
  const runtime = buildRuntimePaths();
  const configModule = await loadTypeScriptModule(
    path.join(nestedLspRoot(), "src/config/managed-executables.ts"),
  );
  const configLoader = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/config/config.ts"));
  assert.equal(configModule.MANAGED_LSP_EXECUTABLES_BINDING, managedBinding);

  const restoreValid = applyEnvironment({
    [managedBinding]: canonicalBinding(runtime.healthyConfig.value.lspExecutables),
  });
  try {
    const loaded = configLoader.loadConfig(repoRoot);
    assert.deepEqual(Object.keys(loaded.servers), ["typescript"]);
    assert.equal(
      loaded.servers.typescript.command,
      runtime.healthyConfig.value.lspExecutables.typescript,
    );
  } finally {
    restoreValid();
  }

  const sentinel = "TASK_4_8_CONFIG_VALUE_SENTINEL";
  const validBinding = canonicalBinding(runtime.healthyConfig.value.lspExecutables);
  const globallyRejected = [
    undefined,
    sentinel,
    JSON.stringify([sentinel]),
    `${validBinding}\n`,
    `{ "typescript":${JSON.stringify(runtime.healthyConfig.value.lspExecutables.typescript)}}`,
    `{"typescript":${JSON.stringify(runtime.healthyConfig.value.lspExecutables.typescript)},"typescript":${JSON.stringify(runtime.healthyConfig.value.lspExecutables.typescript)}}`,
  ];
  for (const binding of globallyRejected) {
    const restore = applyEnvironment({ [managedBinding]: binding });
    try {
      assert.throws(
        () => configLoader.loadConfig(repoRoot),
        (error) => {
          assert.match(error.message, /managed LSP executable map/i);
          assert.doesNotMatch(error.message, new RegExp(sentinel));
          assert.doesNotMatch(error.message, /\/tmp\/|typescript-language-server/);
          return true;
        },
      );
    } finally {
      restore();
    }
  }

  const missingPython =
    "/nix/store/00000000000000000000000000000000-missing/bin/pyright-langserver";
  const isolatedBindings = [
    {
      binding: canonicalBinding({ python: missingPython }),
      expected: [{ cause: "unavailable-executable", name: "python" }],
    },
    {
      binding: canonicalBinding({ typescript: `/tmp/${sentinel}` }),
      expected: [{ cause: "invalid-path", name: "typescript" }],
    },
    {
      binding: canonicalBinding({ ambient: runtime.healthyConfig.value.lspExecutables.typescript }),
      expected: [{ cause: "unknown-server" }],
    },
  ];
  for (const { binding, expected } of isolatedBindings) {
    const restore = applyEnvironment({ [managedBinding]: binding });
    try {
      const loaded = configLoader.loadConfig(repoRoot);
      assert.deepEqual(Object.keys(loaded.servers), []);
      assert.deepEqual(
        loaded.unavailableServers.map(({ cause, name }) => ({ cause, ...(name ? { name } : {}) })),
        expected,
      );
    } finally {
      restore();
    }
  }
});

test("managed catalog lookup isolates prototype names while a healthy server remains ready", async () => {
  const runtime = buildRuntimePaths();
  const configLoader = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/config/config.ts"));
  const executable = runtime.healthyConfig.value.lspExecutables.typescript;
  const entries = Object.create(null);
  entries.constructor = executable;
  entries.prototype = executable;
  entries.__proto__ = executable;
  entries.typescript = executable;
  const binding = canonicalBinding(entries);

  const restore = applyEnvironment({ [managedBinding]: binding });
  try {
    const loaded = configLoader.loadConfig(repoRoot);
    assert.deepEqual(Object.keys(loaded.servers), ["typescript"]);
    assert.deepEqual(
      loaded.unavailableServers.map(({ cause, fileTypes, name }) => ({
        cause,
        fileTypes,
        ...(name === undefined ? {} : { name }),
      })),
      [
        { cause: "unknown-server", fileTypes: [] },
        { cause: "unknown-server", fileTypes: [] },
        { cause: "unknown-server", fileTypes: [] },
      ],
    );
  } finally {
    restore();
  }

  const fixture = await createSession({ binding });
  try {
    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers"],
    });
    const output = resultText(health);
    assert.equal(health.isError, false, output);
    assert.match(output, /typescript[\s\S]*ready/i);
    assert.doesNotMatch(output, /constructor|prototype|__proto__|\/nix\/store\//);
  } finally {
    await closeSession(fixture);
  }
});

test("managed catalog accepts valid own keys from a null-prototype catalog", async () => {
  const runtime = buildRuntimePaths();
  const configModule = await loadTypeScriptModule(
    path.join(nestedLspRoot(), "src/config/managed-executables.ts"),
  );
  const configLoader = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/config/config.ts"));
  const executable = runtime.healthyConfig.value.lspExecutables.typescript;
  const restore = applyEnvironment({
    [managedBinding]: canonicalBinding(runtime.healthyConfig.value.lspExecutables),
  });
  let fixed;
  try {
    fixed = configLoader.loadConfig(repoRoot).servers.typescript;
  } finally {
    restore();
  }

  for (const name of ["constructor", "prototype"]) {
    const catalog = Object.create(null);
    catalog[name] = fixed;
    const entries = Object.create(null);
    entries[name] = executable;
    const loaded = configModule.loadManagedLspServers(catalog, canonicalBinding(entries));
    assert.deepEqual(Object.keys(loaded.servers), [name]);
    assert.equal(loaded.servers[name].command, executable);
    assert.deepEqual(loaded.unavailableServers, []);
  }

  const catalog = Object.create(null);
  catalog.__proto__ = fixed;
  const entries = Object.create(null);
  entries.__proto__ = executable;
  const loaded = configModule.loadManagedLspServers(catalog, canonicalBinding(entries));
  assert.deepEqual(Object.keys(loaded.servers), []);
  assert.deepEqual(loaded.unavailableServers, [
    { cause: "unknown-server", fileTypes: [] },
  ]);
});

test("known LSP locations and diagnostics flow through orientation, resolve, inspect, graph, find, and health", async () => {
  const fixture = await createSession();
  try {
    const orientation = await executeTool(fixture, "code_orientation", {
      focus: { path: "source.ts" },
    });
    assert.equal(orientation.isError, false, resultText(orientation));
    assert.match(resultText(orientation), /source\.ts/);

    const resolved = await executeTool(fixture, "code_resolve", {
      target: { symbol: { query: "greet" } },
    });
    assert.equal(resolved.isError, false, resultText(resolved));
    assert.deepEqual(
      {
        file: resolved.details.data.targets[0].file,
        line: resolved.details.data.targets[0].displayLine,
        character: resolved.details.data.targets[0].displayCharacter,
      },
      { file: "source.ts", line: 1, character: 17 },
    );
    const handle = resolved.details.data.targets[0].targetId;

    const fileSymbols = await executeTool(fixture, "code_resolve", {
      target: { file: "source.ts" },
    });
    assert.equal(fileSymbols.isError, false, resultText(fileSymbols));
    assert.ok(
      fileSymbols.details.data.targets.some(
        (target) =>
          target.name === "greet" && target.displayLine === 1 && target.displayCharacter === 17,
      ),
    );

    const inspect = await executeTool(fixture, "code_inspect", {
      point: { file: "source.ts", line: 5, character: 23 },
    });
    assert.equal(inspect.isError, false, resultText(inspect));
    assert.match(resultText(inspect), /Hover[\s\S]*source\.ts:5:23/);
    assert.match(resultText(inspect), /Definition[\s\S]*source\.ts:1:17/);
    assert.match(resultText(inspect), /Diagnostics[\s\S]*source\.ts:5:23/);

    const graph = await executeTool(fixture, "code_graph", {
      target: { handle },
      relations: ["references", "implements"],
    });
    assert.equal(graph.isError, false, resultText(graph));
    assert.match(resultText(graph), /source\.ts:5:23/);
    assert.match(resultText(graph), /implementation\.ts:1:14/);

    const find = await executeTool(fixture, "code_find", {
      query: "greet",
      mode: "semantic",
    });
    assert.equal(find.isError, false, resultText(find));
    assert.match(resultText(find), /source\.ts:1:17/);

    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["diagnostics", "servers"],
      level: "detailed",
    });
    assert.equal(health.isError, false, resultText(health));
    assert.match(resultText(health), /typescript[\s\S]*ready/i);
    assert.match(resultText(health), /source\.ts[\s\S]*L5:23[\s\S]*Known managed fixture diagnostic/);
  } finally {
    await closeSession(fixture);
  }
});

test("one managed server failure is value-free and leaves structural and healthy server tools active", async () => {
  const fixture = await createSession({ config: "degraded" });
  try {
    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers"],
    });
    const output = resultText(health);
    assert.equal(health.isError, false, output);
    assert.match(output, /typescript[\s\S]*ready/i);
    assert.match(output, /python[\s\S]*(?:start-failed|initialize-failed)/i);
    assert.doesNotMatch(
      output,
      /TASK_4_8_FAILED_SERVER|TASK_4_8_FAILED_SERVER_STDERR|pyright-langserver|\/nix\/store\//,
    );

    const orientation = await executeTool(fixture, "code_orientation", {
      focus: { path: "source.ts" },
    });
    assert.equal(orientation.isError, false, resultText(orientation));
    assert.match(resultText(orientation), /source\.ts/);
  } finally {
    await closeSession(fixture);
  }
});

test("an immediate managed server crash reports runtime-error without routing to it", async () => {
  const fixture = await createSession({ config: "crashing" });
  try {
    const crashMarker = path.join(fixture.cwd, ".task-4-8-crashed");
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(crashMarker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(crashMarker), true, "crashing server did not exit");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers"],
    });
    const output = resultText(health);
    assert.equal(health.isError, false, output);
    assert.match(output, /python[\s\S]*runtime-error/i);
    assert.match(output, /typescript[\s\S]*ready/i);
    assert.doesNotMatch(output, /TASK_4_8_RUNTIME_CRASH|pyright-langserver|\/nix\/store\//);

    const orientation = await executeTool(fixture, "code_orientation", {
      focus: { path: "source.ts" },
    });
    assert.equal(orientation.isError, false, resultText(orientation));
    const resolved = await executeTool(fixture, "code_resolve", {
      target: { symbol: { query: "greet" } },
    });
    assert.equal(resolved.isError, false, resultText(resolved));
    assert.equal(resolved.details.data.targets[0].file, "source.ts");
  } finally {
    await closeSession(fixture);
  }
});

test("one invalid managed entry leaves a healthy server ready", async () => {
  const runtime = buildRuntimePaths();
  const fixture = await createSession({
    binding: canonicalBinding({
      python: "/nix/store/00000000000000000000000000000000-missing/bin/pyright-langserver",
      typescript: runtime.healthyConfig.value.lspExecutables.typescript,
    }),
  });
  try {
    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers"],
    });
    const output = resultText(health);
    assert.equal(health.isError, false, output);
    assert.match(output, /typescript[\s\S]*ready/i);
    assert.match(output, /python[\s\S]*unavailable-executable/i);
    assert.doesNotMatch(output, /00000000000000000000000000000000|\/nix\/store\//);
  } finally {
    await closeSession(fixture);
  }
});

test("healthy, failing, and crashing package servers isolate failures with the exact scrubbed environment", { timeout: 20_000 }, async () => {
  const policy = await loadCredentialPolicyModule();
  const environment = Object.fromEntries(
    policy.sensitiveNames.map((name, index) => [name, `TASK_4_9_CREDENTIAL_${index}_${name}`]),
  );
  const sentinels = Object.values(environment);
  const fixture = await createSession({ config: "isolated", environment });
  try {
    const observationFiles = [
      ".task-4-9-server-observation.json",
      ".task-4-9-descendant-observation.json",
      ".task-4-9-failing-observation.json",
      ".task-4-9-crashing-observation.json",
    ].map((name) => path.join(fixture.cwd, name));
    await waitForCondition(
      () => observationFiles.every((file) => fs.existsSync(file)),
      "all managed server environment observations",
    );
    const expectedEnvironment = policy.scrubEnvironment(fixture.spawnEnvironment);
    const managedEnvironment = await loadTypeScriptModule(
      path.join(nestedLspRoot(), "src/client/managed-environment.ts"),
    );
    assert.deepEqual(
      managedEnvironment.scrubManagedEnvironment(fixture.spawnEnvironment),
      expectedEnvironment,
      "the LSP spawn environment must equal the credential-policy projection",
    );
    for (const file of observationFiles) {
      const observed = readJson(file).environment;
      for (const name of policy.sensitiveNames) {
        assert.equal(Object.hasOwn(observed, name), false, `${name} reached ${path.basename(file)}`);
      }
      assertObservedManagedEnvironment(observed, expectedEnvironment, path.basename(file));
    }

    const crashMarker = path.join(fixture.cwd, ".task-4-8-crashed");
    await waitForCondition(() => fs.existsSync(crashMarker), "the independent crashing server");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await executeTool(fixture, "code_health", {
      scope: "source.ts",
      include: ["servers", "diagnostics"],
      level: "detailed",
    });
    const healthText = resultText(health);
    assert.equal(health.isError, false, healthText);
    assert.match(healthText, /typescript[\s\S]*ready/i);
    assert.match(healthText, /python[\s\S]*(?:start-failed|initialize-failed)/i);
    assert.match(healthText, /rust[\s\S]*runtime-error/i);
    assert.doesNotMatch(healthText, /TASK_4_8_(?:FAILED_SERVER|RUNTIME_CRASH)|\/nix\/store\//);

    const readResult = await executeTool(fixture, "read", { path: "source.ts" });
    assert.equal(readResult.isError, false, resultText(readResult));
    assert.match(resultText(readResult), /export function greet/);
    assert.equal(fs.existsSync(fixture.ambientMarker), false);

    const externallyVisible = [
      healthText,
      resultText(readResult),
      JSON.stringify(fixture.extensionErrors),
      JSON.stringify(fixture.session.sessionManager.getBranch()),
      collectTreeText(fixture.root),
    ].join("\n");
    assertNoSentinels(externallyVisible, sentinels, "LSP output, logs, diagnostics, and state");
  } finally {
    await closeSession(fixture);
  }
});

test("session shutdown observes shutdown then exit and releases the registered group and ordinary descendant", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const fixture = await createSession();
  const observationPath = path.join(fixture.cwd, ".task-4-9-server-observation.json");
  let observation;
  try {
    await waitForCondition(() => fs.existsSync(observationPath), "healthy LSP process observation");
    observation = readJson(observationPath);
    await waitForCondition(
      () => fs.existsSync(path.join(fixture.cwd, ".task-4-9-descendant-observation.json")),
      "healthy LSP ordinary descendant",
    );
    assert.equal(processGroupExists(observation.pid), true);
    assert.equal(processExists(observation.descendantPid), true);

    await closeSession(fixture, { preserveRoot: true });
    const lifecycle = readLifecycle(path.join(fixture.cwd, ".task-4-9-lsp-lifecycle.jsonl"));
    const shutdownIndex = lifecycle.indexOf("shutdown");
    const exitIndex = lifecycle.indexOf("exit");
    assert.ok(shutdownIndex >= 0, `missing shutdown request: ${lifecycle.join(", ")}`);
    assert.ok(exitIndex > shutdownIndex, `exit did not follow shutdown: ${lifecycle.join(", ")}`);
    assert.equal(processGroupExists(observation.pid), false);
    assert.equal(processExists(observation.pid), false);
    assert.equal(processExists(observation.descendantPid), false);
  } finally {
    if (observation && processGroupExists(observation.pid)) {
      try {
        process.kill(-observation.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stalled protocol cleanup attempts exit then bounded TERM and KILL for the registered PGID", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const runtime = buildRuntimePaths();
  const policy = await loadCredentialPolicyModule();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-lsp-stalling-"));
  const environment = Object.fromEntries(
    policy.sensitiveNames.map((name, index) => [name, `TASK_4_9_STALL_CREDENTIAL_${index}`]),
  );
  const restoreEnvironment = applyEnvironment({
    ...environment,
  });
  const clientModule = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/client/client.ts"));
  const signals = [];
  let observation;
  const client = new clientModule.LspClient(
    "go",
    {
      command: path.join(runtime.stallingServer, "bin/gopls"),
      fileTypes: ["go"],
      rootMarkers: ["go.mod"],
    },
    root,
    {
      probe(processGroupId) {
        return process.kill(-processGroupId, 0);
      },
      signal(processGroupId, signal) {
        signals.push({ processGroupId, signal });
        return process.kill(-processGroupId, signal);
      },
    },
  );
  try {
    await client.start();
    const observationPath = path.join(root, ".task-4-9-stalling-observation.json");
    const descendantPath = path.join(root, ".task-4-9-stalling-descendant-observation.json");
    await waitForCondition(
      () => fs.existsSync(observationPath) && fs.existsSync(descendantPath),
      "stalling LSP process observations",
    );
    observation = readJson(observationPath);
    const expectedEnvironment = policy.scrubEnvironment({ ...process.env });
    for (const file of [observationPath, descendantPath]) {
      assertObservedManagedEnvironment(
        readJson(file).environment,
        expectedEnvironment,
        path.basename(file),
      );
    }
    assert.equal(processGroupExists(observation.pid), true);

    await client.shutdown();
    const lifecycle = readLifecycle(path.join(root, ".task-4-9-stalling-lifecycle.jsonl"));
    assert.ok(lifecycle.indexOf("shutdown") >= 0, lifecycle.join(", "));
    assert.ok(lifecycle.indexOf("exit") > lifecycle.indexOf("shutdown"), lifecycle.join(", "));
    assert.deepEqual(
      signals.map(({ processGroupId, signal }) => ({ processGroupId, signal })),
      [
        { processGroupId: observation.pid, signal: "SIGTERM" },
        { processGroupId: observation.pid, signal: "SIGKILL" },
      ],
    );
    assert.equal(processGroupExists(observation.pid), false);
    assert.equal(processExists(observation.pid), false);
    assert.equal(processExists(observation.descendantPid), false);
  } finally {
    if (observation && processGroupExists(observation.pid)) {
      try {
        process.kill(-observation.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first ESRCH permanently releases one registered ownership generation", async () => {
  const processGroups = await loadTypeScriptModule(
    path.join(nestedLspRoot(), "src/client/process-group.ts"),
  );
  const operations = [];
  let firstProbe = true;
  const group = new processGroups.RegisteredProcessGroup(4242, {
    probe(processGroupId) {
      operations.push({ operation: "probe", processGroupId });
      if (firstProbe) {
        firstProbe = false;
        throw Object.assign(new Error("TASK_4_9_ESRCH_VALUE_SENTINEL"), { code: "ESRCH" });
      }
      return true;
    },
    signal(processGroupId, signal) {
      operations.push({ operation: "signal", processGroupId, signal });
      return true;
    },
  });

  const first = await group.terminate({ gracefulMs: 0, termMs: 0, killMs: 0 });
  const second = await group.terminate({ gracefulMs: 0, termMs: 0, killMs: 0 });
  assert.deepEqual(first, { finalSignal: null, groupAlreadyReleased: true });
  assert.deepEqual(second, { finalSignal: null, groupAlreadyReleased: true });
  assert.deepEqual(operations, [{ operation: "probe", processGroupId: 4242 }]);
});

test("concurrent restarts are single-flight and retain every registered ownership generation", async () => {
  const shutdownGate = deferred();
  const clients = [];
  let initialShutdown;
  const harness = await createManagerHarness((name, _config, root) => {
    const index = clients.length;
    const client = fakeManagerClient(name, root, {
      shutdown:
        index === 0
          ? async (current) => {
              initialShutdown ??= shutdownGate.promise.then(() => {
                current.hasRegisteredProcessGroup = false;
                current.status = "shutdown";
              });
              return initialShutdown;
            }
          : undefined,
    });
    clients.push(client);
    return client;
  });
  try {
    await harness.manager.startServerForRoot("typescript", harness.root);
    const first = harness.manager.restartClientsForFiles([harness.source]);
    const second = harness.manager.restartClientsForFiles([harness.source]);
    await waitForCondition(() => clients[0].shutdownCalls > 0, "the initial restart shutdown");
    shutdownGate.resolve();
    const restarted = await Promise.all([first, second]);
    const retained = await harness.manager.startServerForRoot("typescript", harness.root);
    const summary = {
      created: clients.length - 1,
      retained: harness.manager.getStatus().servers.length,
      lostOwned: clients.slice(1).filter(
        (client) => client.hasRegisteredProcessGroup && client !== retained,
      ).length,
      results: restarted.map((entries) => entries.length),
    };
    assert.deepEqual(summary, {
      created: 1,
      retained: 1,
      lostOwned: 0,
      results: [1, 1],
    });
  } finally {
    await harness.manager.shutdownAll().catch(() => undefined);
    for (const client of clients) client.hasRegisteredProcessGroup = false;
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("failed replacement startup remains reachable until a later cleanup retry succeeds", async () => {
  const clients = [];
  const harness = await createManagerHarness((name, _config, root) => {
    const index = clients.length;
    const client = fakeManagerClient(name, root, {
      start:
        index === 0
          ? undefined
          : async (current) => {
              current.hasRegisteredProcessGroup = true;
              current.status = "error";
              throw new Error("TASK_4_9_REPLACEMENT_START_FAILURE_SENTINEL");
            },
    });
    clients.push(client);
    return client;
  });
  try {
    await harness.manager.startServerForRoot("typescript", harness.root);
    const restarted = await harness.manager.restartClientsForFiles([harness.source]);
    const replacement = clients[1];
    const retainedBeforeCleanup = harness.manager.getStatus().servers.length;
    await harness.manager.shutdownAll();
    assert.deepEqual(
      {
        cleanupCalls: replacement.shutdownCalls,
        ownedAfterCleanup: replacement.hasRegisteredProcessGroup,
        restarted,
        retainedBeforeCleanup,
      },
      {
        cleanupCalls: 1,
        ownedAfterCleanup: false,
        restarted: [],
        retainedBeforeCleanup: 1,
      },
    );
  } finally {
    for (const client of clients) client.hasRegisteredProcessGroup = false;
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("manager shutdown fences a late replacement completion and awaits its cleanup", async () => {
  const startGate = deferred();
  const clients = [];
  const harness = await createManagerHarness((name, _config, root) => {
    const index = clients.length;
    const client = fakeManagerClient(name, root, {
      start:
        index === 0
          ? undefined
          : async (current) => {
              current.hasRegisteredProcessGroup = true;
              await startGate.promise;
              current.status = "running";
            },
    });
    clients.push(client);
    return client;
  });
  try {
    await harness.manager.startServerForRoot("typescript", harness.root);
    const restartPromise = harness.manager.restartClientsForFiles([harness.source]);
    await waitForCondition(() => clients.length === 2, "the delayed replacement client");
    let shutdownSettled = false;
    const shutdownPromise = harness.manager.shutdownAll().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shutdownSettledBeforeRelease = shutdownSettled;
    startGate.resolve();
    const [restarted] = await Promise.all([restartPromise, shutdownPromise]);
    assert.deepEqual(
      {
        lostOwned: clients.filter((client) => client.hasRegisteredProcessGroup).length,
        retained: harness.manager.getStatus().servers.length,
        restarted,
        shutdownSettledBeforeRelease,
      },
      {
        lostOwned: 0,
        retained: 0,
        restarted: [],
        shutdownSettledBeforeRelease: false,
      },
    );
  } finally {
    startGate.resolve();
    for (const client of clients) client.hasRegisteredProcessGroup = false;
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("concurrent session starts followed by one shutdown release every acquired lease", async () => {
  const lifecycle = await loadTypeScriptModule(
    codeIntelligenceSourcePath("substrate/lsp/lifecycle.ts"),
  );
  const stateModule = await loadTypeScriptModule(
    codeIntelligenceSourcePath("substrate/lsp/state.ts"),
  );
  const { handlers, pi } = createLifecyclePi();
  const state = stateModule.createLspAdapterState();
  const controller = {
    kind: "ready",
    workspaceRuntime: { getProjectServers: () => [] },
  };
  let acquired = 0;
  let active = 0;
  let released = 0;
  let hostShutdowns = 0;
  lifecycle.registerLspSessionLifecycle(pi, state, undefined, {
    async acquireWorkspaceProviderHost(cwd) {
      acquired += 1;
      active += 1;
      let leaseReleased = false;
      return {
        cwd,
        lspController: controller,
        sentinelSnapshot: new Map(),
        async release() {
          if (leaseReleased) return;
          leaseReleased = true;
          released += 1;
          active -= 1;
          if (active === 0) hostShutdowns += 1;
        },
      };
    },
  });
  const context = { cwd: repoRoot, isProjectTrusted: () => true };
  await Promise.all([
    handlers.get("session_start")({ type: "session_start", reason: "reload" }, context),
    handlers.get("session_start")({ type: "session_start", reason: "reload" }, context),
  ]);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  assert.deepEqual(
    {
      acquired,
      active,
      hostShutdowns,
      leaseRetained: state.providerLease !== null,
      released,
    },
    {
      acquired,
      active: 0,
      hostShutdowns: 1,
      leaseRetained: false,
      released: acquired,
    },
  );
});

test("workspace host release is transactional and the same lease retries failed cleanup", async () => {
  const host = await loadTypeScriptModule(
    codeIntelligenceSourcePath("substrate/workspace-provider-host.ts"),
  );
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-lsp-host-release-"));
  const controllers = [];
  const dependencies = {
    createLspController() {
      const controller = {
        kind: "ready",
        owned: true,
        shutdownCalls: 0,
        async shutdown() {
          controller.shutdownCalls += 1;
          if (controllers.length === 1 && controller.shutdownCalls === 1) {
            throw new Error("TASK_4_9_HOST_CLEANUP_FAILURE_SENTINEL");
          }
          controller.owned = false;
        },
        async start() {},
      };
      controllers.push(controller);
      return controller;
    },
    createTreeController() {
      return { async shutdown() {}, async start() {} };
    },
    getRuntime() {
      return {};
    },
    scanSentinels() {
      return new Map();
    },
  };
  host.resetWorkspaceProviderHostsForTests();
  try {
    const lease = await host.acquireWorkspaceProviderHost(
      root,
      { projectTrusted: true },
      dependencies,
    );
    await assert.rejects(lease.release(), /TASK_4_9_HOST_CLEANUP_FAILURE_SENTINEL/);
    await lease.release();
    const nextLease = await host.acquireWorkspaceProviderHost(
      root,
      { projectTrusted: true },
      dependencies,
    );
    await nextLease.release();
    assert.deepEqual(
      {
        firstOwned: controllers[0].owned,
        firstShutdownCalls: controllers[0].shutdownCalls,
        hostGenerations: controllers.length,
      },
      {
        firstOwned: false,
        firstShutdownCalls: 2,
        hostGenerations: 2,
      },
    );
  } finally {
    for (const controller of controllers) controller.owned = false;
    host.resetWorkspaceProviderHostsForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("late stale session acquisitions cannot publish after shutdown", async () => {
  const lifecycle = await loadTypeScriptModule(
    codeIntelligenceSourcePath("substrate/lsp/lifecycle.ts"),
  );
  const stateModule = await loadTypeScriptModule(
    codeIntelligenceSourcePath("substrate/lsp/state.ts"),
  );
  const { handlers, pi } = createLifecyclePi();
  const state = stateModule.createLspAdapterState();
  const pending = [];
  const leases = [];
  let active = 0;
  let released = 0;
  lifecycle.registerLspSessionLifecycle(pi, state, undefined, {
    acquireWorkspaceProviderHost(cwd) {
      const gate = deferred();
      pending.push(gate);
      return gate.promise.then(() => {
        active += 1;
        let leaseReleased = false;
        const lease = {
          cwd,
          lspController: { kind: "ready", workspaceRuntime: { getProjectServers: () => [] } },
          sentinelSnapshot: new Map(),
          async release() {
            if (leaseReleased) return;
            leaseReleased = true;
            active -= 1;
            released += 1;
          },
        };
        leases.push(lease);
        return lease;
      });
    },
  });
  const context = { cwd: repoRoot, isProjectTrusted: () => true };
  const firstStart = handlers.get("session_start")(
    { type: "session_start", reason: "reload" },
    context,
  );
  await waitForCondition(() => pending.length === 1, "the first delayed lease acquisition");
  const secondStart = handlers.get("session_start")(
    { type: "session_start", reason: "reload" },
    context,
  );
  const shutdown = handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const gate of pending) gate.resolve();
  await Promise.allSettled([firstStart, secondStart, shutdown]);
  for (const gate of pending) gate.resolve();
  assert.deepEqual(
    {
      acquired: leases.length,
      active,
      leaseRetained: state.providerLease !== null,
      released,
    },
    {
      acquired: leases.length,
      active: 0,
      leaseRetained: false,
      released: leases.length,
    },
  );
});

test("unsupported WorkspaceEdit responses are rejected whole before a plan is stored", async () => {
  const fixture = await createSession();
  try {
    const source = path.join(fixture.cwd, "source.ts");
    const implementation = path.join(fixture.cwd, "implementation.ts");
    const beforeSource = fs.readFileSync(source);
    const beforeImplementation = fs.readFileSync(implementation);
    for (const scenario of [
      "documentChanges",
      "mixedEncodings",
      "resourceOperation",
      "annotatedEdit",
      "multipleFiles",
      "emptySecondFile",
      "malformedEdit",
    ]) {
      const result = await executeTool(
        fixture,
        "code_refactor_plan",
        renamePlanArguments(scenario),
      );
      assert.equal(result.isError, true, `${scenario}: ${resultText(result)}`);
      assert.doesNotMatch(resultText(result), /Plan ID/i);
      assert.deepEqual(fs.readFileSync(source), beforeSource);
      assert.deepEqual(fs.readFileSync(implementation), beforeImplementation);
    }
  } finally {
    await closeSession(fixture);
  }
});

test("write targets use canonical workspace identity and reject realpath escapes", async () => {
  const fixture = await createSession();
  try {
    const source = path.join(fixture.cwd, "source.ts");
    const outside = path.join(fixture.root, "outside.ts");
    const outsideDirectory = path.join(fixture.root, "outside");
    const escaped = path.join(outsideDirectory, "outside.ts");
    const alias = path.join(fixture.cwd, "alias.ts");
    fs.writeFileSync(outside, "export const outside = true;\n");
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(escaped, "export const escaped = true;\n");
    fs.symlinkSync(outsideDirectory, path.join(fixture.cwd, "escape"));
    fs.symlinkSync(source, alias);
    const beforeOutside = fs.readFileSync(outside);
    const beforeEscaped = fs.readFileSync(escaped);

    for (const scenario of ["outsideTraversal", "outsideSymlinkParent"]) {
      const rejected = await executeTool(
        fixture,
        "code_refactor_plan",
        renamePlanArguments(scenario),
      );
      assert.equal(rejected.isError, true, `${scenario}: ${resultText(rejected)}`);
      assert.doesNotMatch(resultText(rejected), /outside\.ts|outsideTraversal|outsideSymlinkParent/);
    }
    assert.deepEqual(fs.readFileSync(outside), beforeOutside);
    assert.deepEqual(fs.readFileSync(escaped), beforeEscaped);

    const plan = await executeTool(
      fixture,
      "code_refactor_plan",
      renamePlanArguments("insideSymlinkAlias"),
    );
    assert.equal(plan.isError, false, resultText(plan));
    assert.match(resultText(plan), /source\.ts/);
    assert.doesNotMatch(resultText(plan), /alias\.ts/);
    const applied = await executeTool(fixture, "code_refactor_apply", { planId: planId(plan) });
    assert.equal(applied.isError, false, resultText(applied));
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(source, "utf8"), sourceText.replaceAll("greet", "insideSymlinkAlias"));
  } finally {
    await closeSession(fixture);
  }
});

test("refactor write targets reject raw query and fragment aliases", async () => {
  const fixture = await createSession();
  try {
    const source = path.join(fixture.cwd, "source.ts");
    const before = fs.readFileSync(source);
    for (const scenario of [
      "emptyQueryAlias",
      "queryAlias",
      "emptyFragmentAlias",
      "fragmentAlias",
    ]) {
      const rejected = await executeTool(
        fixture,
        "code_refactor_plan",
        renamePlanArguments(scenario),
      );
      assert.equal(rejected.isError, true, `${scenario}: ${resultText(rejected)}`);
      assert.doesNotMatch(resultText(rejected), /Plan ID|TASK_4_8_(?:QUERY|FRAGMENT)_ALIAS/);
      assert.deepEqual(fs.readFileSync(source), before);
    }
  } finally {
    await closeSession(fixture);
  }
});

test("refactor preview is byte-preserving and apply requires one fresh matching plan", async () => {
  const fixture = await createSession();
  try {
    const source = path.join(fixture.cwd, "source.ts");
    const before = fs.readFileSync(source);
    const plan = await executeTool(fixture, "code_refactor_plan", {
      target: { anchor: { file: "source.ts", line: 1, character: 17 } },
      operation: { rename_symbol: { newName: "salute" } },
    });
    assert.equal(plan.isError, false, resultText(plan));
    assert.match(resultText(plan), /This is a preview\. No files were changed/);
    assert.match(resultText(plan), /source\.ts` L1:17 → L1:22/);
    assert.match(resultText(plan), /source\.ts` L5:23 → L5:28/);
    assert.deepEqual(fs.readFileSync(source), before);

    const mismatched = await executeTool(fixture, "code_refactor_apply", {
      planId: "plan-not-from-this-session",
    });
    assert.match(resultText(mismatched), /plan is unavailable in this session/i);
    assert.deepEqual(fs.readFileSync(source), before);

    fs.appendFileSync(source, "// stale fixture\n");
    const staleBytes = fs.readFileSync(source);
    const stale = await executeTool(fixture, "code_refactor_apply", { planId: planId(plan) });
    assert.match(resultText(stale), /plan is stale/i);
    assert.deepEqual(fs.readFileSync(source), staleBytes);

    fs.writeFileSync(source, before);
    const freshPlan = await executeTool(fixture, "code_refactor_plan", {
      target: { anchor: { file: "source.ts", line: 1, character: 17 } },
      operation: { rename_symbol: { newName: "salute" } },
    });
    const freshPlanId = planId(freshPlan);
    assert.deepEqual(fs.readFileSync(source), before);

    const applied = await executeTool(fixture, "code_refactor_apply", { planId: freshPlanId });
    const appliedBytes = fs.readFileSync(source);
    assert.equal(applied.isError, false, resultText(applied));
    assert.equal(appliedBytes.toString("utf8"), sourceText.replaceAll("greet", "salute"));

    const repeated = await executeTool(fixture, "code_refactor_apply", { planId: freshPlanId });
    assert.match(resultText(repeated), /plan is unavailable in this session/i);
    assert.deepEqual(fs.readFileSync(source), appliedBytes);
  } finally {
    await closeSession(fixture);
  }
});

test("refactor apply is call-time denied with zero writes in Plan and review while review keeps read and preview tools", async () => {
  const reviewTools = [
    "read",
    ...expectedCodeTools.filter((name) => name !== "code_refactor_apply"),
  ];
  for (const mode of ["plan", "review"]) {
    const fixture = await createSession({
      activeTools: mode === "review" ? reviewTools : undefined,
      planMode: mode === "plan",
    });
    try {
      const source = path.join(fixture.cwd, "source.ts");
      const before = fs.readFileSync(source);
      const health = await executeTool(fixture, "code_health", {
        scope: "source.ts",
        include: ["servers"],
      });
      assert.equal(health.isError, false, `${mode}: ${resultText(health)}`);
      const preview = await executeTool(
        fixture,
        "code_refactor_plan",
        renamePlanArguments(`blockedIn${mode[0].toUpperCase()}${mode.slice(1)}`),
      );
      assert.equal(preview.isError, false, `${mode}: ${resultText(preview)}`);
      assert.deepEqual(fs.readFileSync(source), before, `${mode} preview wrote the target`);

      if (mode === "plan") {
        await fixture.session.prompt("/plan start");
        assert.equal(fixture.session.getActiveToolNames().includes("code_refactor_apply"), false);
      } else {
        assert.deepEqual(fixture.session.getActiveToolNames(), reviewTools);
      }

      const { guard } = await applyGuardedTool(fixture, "code_refactor_apply", {
        planId: planId(preview),
      });
      assert.equal(guard?.block, true, `${mode} did not deny refactor apply at call time`);
      assert.match(guard.reason ?? "", /code_refactor_apply|refactor apply|current mode/i);
      assert.deepEqual(fs.readFileSync(source), before, `${mode} refactor apply changed the target`);
    } finally {
      await closeSession(fixture);
    }
  }
});

test("raw-byte and inode staleness preserve the current target", async () => {
  const plans = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-plans.ts"));
  const apply = await loadTypeScriptModule(
    codeIntelligenceSourcePath("analysis/refactor/managed-apply.ts"),
  );
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-refactor-stale-"));
  const file = path.join(root, "source.ts");
  const edit = {
    edits: [
      {
        file,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "salute",
      },
    ],
  };
  try {
    const invalidBefore = Buffer.concat([Buffer.from("greet\n"), Buffer.from([0x80])]);
    fs.writeFileSync(file, invalidBefore);
    const rawFingerprint = plans.computeFileFingerprint(file);
    const invalidCurrent = Buffer.concat([Buffer.from("greet\n"), Buffer.from([0x81])]);
    fs.writeFileSync(file, invalidCurrent);
    const rawStale = await apply.applyWorkspaceEdit(edit, {
      workspaceRoot: fs.realpathSync.native(root),
      expectedFingerprint: rawFingerprint,
    });
    assert.equal(rawStale.kind, "error");
    assert.deepEqual(fs.readFileSync(file), invalidCurrent);

    const bytes = Buffer.from("greet\n");
    fs.writeFileSync(file, bytes);
    const identityFingerprint = plans.computeFileFingerprint(file);
    const displaced = path.join(root, "displaced.ts");
    fs.renameSync(file, displaced);
    fs.writeFileSync(file, bytes);
    const identityStale = await apply.applyWorkspaceEdit(edit, {
      workspaceRoot: fs.realpathSync.native(root),
      expectedFingerprint: identityFingerprint,
    });
    assert.equal(identityStale.kind, "error");
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one-file replacement preserves UTF-16 ranges and NUL bytes across atomic staging", async () => {
  const plans = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-plans.ts"));
  const apply = await loadTypeScriptModule(
    codeIntelligenceSourcePath("analysis/refactor/managed-apply.ts"),
  );
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-refactor-utf16-"));
  const file = path.join(root, "source.ts");
  const before = 'const value = "😀\0old";\n';
  try {
    fs.writeFileSync(file, before);
    const result = await apply.applyWorkspaceEdit(
      {
        edits: [
          {
            file,
            range: { start: { line: 0, character: 18 }, end: { line: 0, character: 21 } },
            newText: "new",
          },
        ],
      },
      {
        workspaceRoot: fs.realpathSync.native(root),
        expectedFingerprint: plans.computeFileFingerprint(file),
      },
    );
    assert.equal(result.kind, "applied");
    assert.equal(fs.readFileSync(file, "utf8"), 'const value = "😀\0new";\n');

    const longFile = path.join(root, `${"a".repeat(230)}.ts`);
    const longBytes = Buffer.from("greet\n");
    fs.writeFileSync(longFile, longBytes);
    const failed = await apply.applyWorkspaceEdit(
      {
        edits: [
          {
            file: longFile,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: "salute",
          },
        ],
      },
      {
        workspaceRoot: fs.realpathSync.native(root),
        expectedFingerprint: plans.computeFileFingerprint(longFile),
      },
    );
    assert.equal(failed.kind, "error");
    assert.deepEqual(fs.readFileSync(longFile), longBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic replacement preserves target access metadata under a restrictive umask", async () => {
  const plans = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-plans.ts"));
  const apply = await loadTypeScriptModule(
    codeIntelligenceSourcePath("analysis/refactor/managed-apply.ts"),
  );
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-refactor-metadata-"));
  const file = path.join(root, "source.ts");
  const before = Buffer.from("greet\n");
  try {
    fs.writeFileSync(file, before);
    const initial = fs.statSync(file);
    const supplementaryGid = process
      .getgroups?.()
      .find((gid) => gid !== initial.gid);
    if (supplementaryGid !== undefined) {
      try {
        fs.chownSync(file, initial.uid, supplementaryGid);
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      }
    }
    fs.chmodSync(file, 0o666);
    const expected = fs.statSync(file);
    const previousUmask = process.umask(0o077);
    let result;
    try {
      result = await apply.applyWorkspaceEdit(
        {
          edits: [
            {
              file,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "salute",
            },
          ],
        },
        {
          workspaceRoot: fs.realpathSync.native(root),
          expectedFingerprint: plans.computeFileFingerprint(file),
        },
      );
    } finally {
      process.umask(previousUmask);
    }

    const actual = fs.statSync(file);
    assert.equal(result.kind, "applied");
    assert.equal(fs.readFileSync(file, "utf8"), "salute\n");
    assert.equal(actual.mode & 0o7777, expected.mode & 0o7777);
    assert.equal(actual.uid, expected.uid);
    assert.equal(actual.gid, expected.gid);
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes(".supi-refactor-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed staged metadata verification leaves the original target unchanged", async () => {
  const plans = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-plans.ts"));
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-refactor-mode-failure-"));
  const file = path.join(root, "source.ts");
  const before = Buffer.from("greet\n");
  fs.writeFileSync(file, before);
  fs.chmodSync(file, 0o666);
  const expected = fs.statSync(file);

  const originalFchmodSync = fs.fchmodSync;
  const previousUmask = process.umask(0o077);
  let requestedMode;
  let stagedMode;
  try {
    fs.fchmodSync = (descriptor, mode) => {
      requestedMode = mode;
      stagedMode = fs.fstatSync(descriptor).mode & 0o7777;
    };
    syncBuiltinESMExports();
    const apply = await loadTypeScriptModule(
      codeIntelligenceSourcePath("analysis/refactor/managed-apply.ts"),
    );
    const result = await apply.applyWorkspaceEdit(
      {
        edits: [
          {
            file,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: "salute",
          },
        ],
      },
      {
        workspaceRoot: fs.realpathSync.native(root),
        expectedFingerprint: plans.computeFileFingerprint(file),
      },
    );

    const actual = fs.statSync(file);
    assert.equal(result.kind, "error");
    assert.equal(requestedMode, 0o666);
    assert.equal(stagedMode, 0o600);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(actual.dev, expected.dev);
    assert.equal(actual.ino, expected.ino);
    assert.equal(actual.mode, expected.mode);
    assert.equal(actual.uid, expected.uid);
    assert.equal(actual.gid, expected.gid);
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes(".supi-refactor-")),
      [],
    );
  } finally {
    fs.fchmodSync = originalFchmodSync;
    syncBuiltinESMExports();
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UUID plans reject collisions and concurrent apply claims exactly once", async () => {
  const plans = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-plans.ts"));
  const workflow = await loadTypeScriptModule(codeIntelligenceSourcePath("session/refactor-workflow.ts"));
  const firstId = plans.generatePlanId();
  const secondId = plans.generatePlanId();
  assert.match(firstId, /^plan-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(firstId, secondId);
  const collisionStore = new Map();
  const first = { id: firstId };
  plans.storePlan(collisionStore, first);
  assert.throws(() => plans.storePlan(collisionStore, { id: firstId }), /collision/i);
  assert.equal(collisionStore.get(firstId), first);

  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-refactor-claim-"));
  const file = path.join(root, "source.ts");
  try {
    fs.writeFileSync(file, "greet\n");
    const id = plans.generatePlanId();
    const plan = {
      id,
      operation: "rename_symbol",
      newName: "salute",
      targetFile: file,
      targetLine: 1,
      targetCharacter: 1,
      workspaceRoot: fs.realpathSync.native(root),
      edits: {
        edits: [
          {
            file,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: "salute",
          },
        ],
      },
      fileFingerprints: [plans.computeFileFingerprint(file)],
      createdAt: Date.now(),
    };
    const store = new Map();
    plans.storePlan(store, plan);
    const deps = { claimPlan: (planIdValue) => plans.claimPlan(store, planIdValue) };
    const outcomes = await Promise.all([
      workflow.runRefactorApplyWorkflow({ planId: id }, deps),
      workflow.runRefactorApplyWorkflow({ planId: id }, deps),
    ]);
    assert.deepEqual(
      outcomes.map(({ kind }) => kind).sort(),
      ["completed", "invalid-input"],
    );
    assert.equal(fs.readFileSync(file, "utf8"), "salute\n");
    assert.equal(store.has(id), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read locations normalize local file URIs, allow external files, and reject other schemes", async () => {
  const runtime = buildRuntimePaths();
  for (const modulePath of [
    path.join(codeIntelligenceRoot(), "node_modules/@mrclrchtr/supi-core/src/path-utils.ts"),
    path.join(nestedLspCoreRoot(), "src/path-utils.ts"),
  ]) {
    const locations = await loadTypeScriptModule(modulePath);
    const external = path.join(runtime.validServer, "bin/typescript-language-server");
    assert.equal(locations.uriToFile(pathToFileURL(external).href), external);
    assert.equal(locations.uriToFile("file:/tmp/task-4-8/../external.ts"), "/tmp/external.ts");
    assert.equal(locations.uriToFile("file://localhost/tmp/external.ts"), "/tmp/external.ts");
    for (const uri of [
      "https://TASK_4_8_LOCATION_VALUE_SENTINEL.invalid/source.ts",
      "untitled:TASK_4_8_LOCATION_VALUE_SENTINEL",
      "file:///tmp/source.ts?",
      "file:///tmp/source.ts?TASK_4_8_LOCATION_VALUE_SENTINEL",
      "file:///tmp/source.ts#",
      "file:///tmp/source.ts#TASK_4_8_LOCATION_VALUE_SENTINEL",
      "file:///tmp/%00TASK_4_8_LOCATION_VALUE_SENTINEL",
      "file://remote.invalid/tmp/TASK_4_8_LOCATION_VALUE_SENTINEL",
    ]) {
      assert.throws(
        () => locations.uriToFile(uri),
        (error) => {
          assert.equal(error.message, "Unsupported source location.");
          assert.doesNotMatch(error.message, /TASK_4_8_LOCATION_VALUE_SENTINEL/);
          return true;
        },
      );
    }
  }

  const fixture = await createSession();
  try {
    const empty = await executeTool(fixture, "code_find", {
      query: "fixture-null-response",
      mode: "semantic",
    });
    assert.equal(empty.isError, false, resultText(empty));

    const rejected = await executeTool(fixture, "code_find", {
      query: "fixture-non-file-location",
      mode: "semantic",
    });
    assert.equal(rejected.isError, true, resultText(rejected));
    assert.match(resultText(rejected), /malformed-response/i);
    assert.doesNotMatch(resultText(rejected), /TASK_4_8_NON_FILE_LOCATION_SENTINEL|https:/i);
  } finally {
    await closeSession(fixture);
  }
});

test("JSON-RPC transport correlates out-of-order responses and ignores a late timed-out reply", async () => {
  const transport = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/client/transport.ts"));
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new transport.JsonRpcClient(input, output, { timeoutMs: 500 });
  try {
    const firstRequests = captureRpcRequests(output, ["fixture/first", "fixture/second"]);
    const first = client.sendRequest("fixture/first");
    const second = client.sendRequest("fixture/second");
    const requests = await firstRequests;
    writeRpcMessage(input, {
      jsonrpc: "2.0",
      id: requests.get("fixture/second").id,
      result: "second-result",
    });
    writeRpcMessage(input, {
      jsonrpc: "2.0",
      id: requests.get("fixture/first").id,
      result: "first-result",
    });
    assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);

    const lateRequest = captureRpcRequests(output, ["fixture/late"]);
    const late = client.sendRequest("fixture/late", undefined, { timeoutMs: 10 });
    const lateId = (await lateRequest).get("fixture/late").id;
    await assert.rejects(late, /timed out/i);
    writeRpcMessage(input, { jsonrpc: "2.0", id: lateId, result: "too-late" });

    const finalRequest = captureRpcRequests(output, ["fixture/final"]);
    const final = client.sendRequest("fixture/final");
    const finalId = (await finalRequest).get("fixture/final").id;
    writeRpcMessage(input, { jsonrpc: "2.0", id: finalId, result: "final-result" });
    assert.equal(await final, "final-result");
  } finally {
    client.dispose();
    input.destroy();
    output.destroy();
  }
});

test("malformed bindings and LSP errors report identity and cause without source values", async () => {
  const sentinel = "TASK_4_8_FAILURE_VALUE_SENTINEL";
  const clientModule = await loadTypeScriptModule(path.join(nestedLspRoot(), "src/client/failure.ts"));
  assert.equal(
    clientModule.formatLspFailure(
      "typescript",
      "workspace/symbol",
      new Error(`Request workspace/symbol timed out after 25ms: ${sentinel}`),
    ),
    "typescript: workspace/symbol failed (timeout).",
  );
  assert.equal(
    clientModule.formatLspFailure(
      "typescript",
      "workspace/symbol",
      new SyntaxError(`Unexpected token ${sentinel}`),
    ),
    "typescript: workspace/symbol failed (malformed-response).",
  );

  const malformedFixture = await createSession({ binding: `{${sentinel}` });
  try {
    assert.deepEqual(
      malformedFixture.session
        .getActiveToolNames()
        .filter((name) => name.startsWith("code_"))
        .sort(),
      expectedCodeTools,
    );
    const orientation = await executeTool(malformedFixture, "code_orientation", {
      focus: { path: "source.ts" },
    });
    assert.equal(orientation.isError, false, resultText(orientation));
    const health = await executeTool(malformedFixture, "code_health", {
      include: ["servers"],
    });
    assert.match(resultText(health), /managed LSP executable map/i);
    assert.doesNotMatch(resultText(health), new RegExp(sentinel));
  } finally {
    await closeSession(malformedFixture);
  }

  const fixture = await createSession();
  try {
    for (const [query, cause, leaked] of [
      ["fixture-server-error", "server-error", "TASK_4_8_SERVER_ERROR"],
      ["fixture-malformed-response", "malformed-response", "TASK_4_8_MALFORMED_RESPONSE"],
    ]) {
      const result = await executeTool(fixture, "code_find", { query, mode: "semantic" });
      assert.equal(result.isError, true);
      assert.match(resultText(result), new RegExp(`typescript.*${cause}`, "i"));
      assert.doesNotMatch(resultText(result), new RegExp(leaked));
      assert.doesNotMatch(resultText(result), new RegExp(query));
    }
  } finally {
    await closeSession(fixture);
  }
});
