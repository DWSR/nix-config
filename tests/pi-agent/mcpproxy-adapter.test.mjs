import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const serverFixturePath = path.join(testsDir, "fixtures/mcpproxy-server.mjs");
const fatalLoadFixturePath = path.join(testsDir, "fixtures/mcpproxy-fatal-load.ts");
const directToolNames = [
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
];
const oversizedVariantReasons = Object.freeze({
  "oversized-depth": "JSON_DEPTH_LIMIT",
  "oversized-string": "JSON_STRING_LIMIT",
  "oversized-container": "JSON_CONTAINER_LIMIT",
  "oversized-shared-nodes": "JSON_NODE_LIMIT",
  "oversized-shared-text": "JSON_TEXT_LIMIT",
});
const attackerSentinels = [
  "sensitive-key-sentinel",
  "sensitive-dialect-sentinel",
  "sensitive-annotation-sentinel",
  "sensitive-shared-text-sentinel",
];
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
        name = "nix-config-mcpproxy-adapter-tests";
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

function wrapperPath() {
  const runtime = buildRuntimePaths();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtime.extensions, "share/pi-agent/extensions.json"), "utf8"),
  );
  return path.join(runtime.extensions, manifest.extensions.mcp.entryPath);
}

async function loadRuntimeModules() {
  if (runtimeModules) return runtimeModules;
  const nodeModules = path.join(buildRuntimePaths().pi, "lib/node_modules");
  const codingAgent = await import(
    pathToFileURL(path.join(nodeModules, "@earendil-works/pi-coding-agent/index.js"))
  );
  const ai = await import(pathToFileURL(path.join(nodeModules, "@earendil-works/pi-ai/compat.js")));
  runtimeModules = { ...codingAgent, ...ai };
  return runtimeModules;
}

async function loadWrapperModule() {
  const runtime = buildRuntimePaths();
  const piNodeModules = path.join(runtime.pi, "lib/node_modules");
  const jitiPath = path.join(piNodeModules, "jiti/lib/jiti.mjs");
  const { createJiti } = await import(pathToFileURL(jitiPath));
  return createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-ai/compat": path.join(
        piNodeModules,
        "@earendil-works/pi-ai/compat.js",
      ),
      "@earendil-works/pi-ai": path.join(piNodeModules, "@earendil-works/pi-ai/index.js"),
      "@earendil-works/pi-coding-agent": path.join(
        piNodeModules,
        "@earendil-works/pi-coding-agent/index.js",
      ),
      "@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works/pi-tui/index.js"),
      typebox: path.join(runtime.extensions, "lib/node_modules/typebox/build/index.mjs"),
    },
  }).import(wrapperPath());
}

async function loadAdapterModule() {
  const runtime = buildRuntimePaths();
  const piNodeModules = path.join(runtime.pi, "lib/node_modules");
  const { createJiti } = await import(
    pathToFileURL(path.join(piNodeModules, "jiti/lib/jiti.mjs"))
  );
  return createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-ai/compat": path.join(
        piNodeModules,
        "@earendil-works/pi-ai/compat.js",
      ),
      "@earendil-works/pi-ai": path.join(piNodeModules, "@earendil-works/pi-ai/index.js"),
      "@earendil-works/pi-coding-agent": path.join(
        piNodeModules,
        "@earendil-works/pi-coding-agent/index.js",
      ),
      "@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works/pi-tui/index.js"),
      typebox: path.join(runtime.extensions, "lib/node_modules/typebox/build/index.mjs"),
    },
  }).import(path.join(runtime.extensions, "lib/node_modules/pi-mcp-adapter/index.ts"));
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
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

function waitForChildMessage(child, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("deterministic MCP server message timed out"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(`deterministic MCP server exited ${code ?? signal}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("close", onClose);
    }
    child.on("message", onMessage);
    child.on("close", onClose);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("deterministic MCP server did not exit"));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
  });
}

async function waitForCondition(predicate, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
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

async function startFixtureServer(variant) {
  const runtime = buildRuntimePaths();
  const child = childProcess.spawn(process.execPath, [serverFixturePath], {
    cwd: repoRoot,
    env: {
      HOME: os.tmpdir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PI_AGENT_MCP_FIXTURE_VARIANT: variant,
      PI_AGENT_MCP_TOOLS_LIST_DELAY_MS: ["exact", "warm-missing"].includes(variant)
        ? "1000"
        : "0",
      PI_AGENT_MCP_SERVER_MODULE: path.join(
        runtime.extensions,
        "lib/node_modules/@modelcontextprotocol/server/dist/index.mjs",
      ),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const activities = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => {
    if (message?.type === "activity") activities.push(message.activity);
  });
  let ready;
  try {
    ready = await waitForChildMessage(
      child,
      (message) => message?.type === "ready" || message?.type === "fatal",
    );
  } catch (error) {
    child.kill("SIGTERM");
    await waitForChildExit(child, 2_000).catch(async () => {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    });
    throw error;
  }
  if (ready.type === "fatal") {
    child.kill("SIGTERM");
    await waitForChildExit(child, 2_000).catch(async () => {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    });
    throw new Error(`deterministic MCP server failed: ${ready.message}${stderr}`);
  }
  assert.equal(Number.isInteger(ready.port) && ready.port > 0, true);
  return { activities, child, port: ready.port, stderr: () => stderr };
}

async function stopFixtureServer(fixture) {
  const { child } = fixture;
  const pid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = waitForChildMessage(child, (message) => message?.type === "stopped", 5_000);
    child.send({ type: "shutdown" });
    await stopped.catch(() => undefined);
  }
  await waitForChildExit(child, 2_000).catch(async () => {
    child.kill("SIGTERM");
    await waitForChildExit(child, 2_000).catch(async () => {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    });
  });
  assert.equal(child.exitCode === 0 || child.signalCode === "SIGTERM", true, fixture.stderr());
  assert.equal(isProcessAlive(pid), false, `deterministic MCP server ${pid} leaked`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function installFixtureFetchRedirect(port) {
  const originalFetch = globalThis.fetch;
  const redirect = (value) => {
    const url = new URL(value instanceof Request ? value.url : value);
    if (url.hostname !== "127.0.0.1" || url.port !== "8080") return null;
    url.port = String(port);
    return url;
  };

  const fixtureFetch = (input, init) => {
    const redirected = redirect(input);
    if (!redirected) return originalFetch(input, init);
    if (input instanceof Request) {
      return originalFetch(new Request(redirected, input), init);
    }
    return originalFetch(input instanceof URL ? redirected : redirected.href, init);
  };
  globalThis.fetch = fixtureFetch;
  return () => {
    if (globalThis.fetch === fixtureFetch) globalThis.fetch = originalFetch;
  };
}

async function createLoaderFixture(variant, options = {}) {
  const server = await startFixtureServer(variant);
  const restoreFetch = installFixtureFetchRedirect(server.port);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mcpproxy-loader-${variant}-`));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const homeDir = path.join(root, "home");
  for (const directory of [cwd, agentDir, homeDir]) fs.mkdirSync(directory, { recursive: true });
  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    MCP_DIRECT_TOOLS: "ambient-direct-tool-sentinel",
  });
  try {
    const { DefaultResourceLoader, SettingsManager } = await loadRuntimeModules();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: options.useWrapper === false ? [] : [wrapperPath()],
      extensionFactories: options.extensionFactories ?? [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    return {
      agentDir,
      resourceLoader,
      restoreEnvironment,
      restoreFetch,
      root,
      server,
    };
  } catch (error) {
    restoreFetch();
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    await stopFixtureServer(server);
    throw error;
  }
}

async function createCountingAdapterFactory(registrationBatches) {
  const wrapper = await loadWrapperModule();
  return {
    name: "counted-mcpproxy-adapter",
    factory: async (pi) => {
      const registrations = [];
      registrationBatches.push(registrations);
      const countedPi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property !== "registerTool") return Reflect.get(target, property, receiver);
          return (definition) => {
            registrations.push(definition);
            return target.registerTool(definition);
          };
        },
      });
      await wrapper.default(countedPi);
    },
  };
}

async function closeLoaderFixture(fixture) {
  try {
    for (const extension of fixture.resourceLoader.getExtensions().extensions) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "quit" });
      }
    }
  } finally {
    fixture.restoreFetch();
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
    await stopFixtureServer(fixture.server);
  }
}

function runHeadlessExtensionLoad() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcpproxy-headless-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const homeDir = path.join(root, "home");
  for (const directory of [cwd, agentDir, homeDir]) fs.mkdirSync(directory, { recursive: true });
  try {
    return childProcess.spawnSync(
      path.join(buildRuntimePaths().pi, "bin/pi"),
      [
        "--offline",
        "--approve",
        "--no-extensions",
        "--extension",
        fatalLoadFixturePath,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--print",
        "--no-session",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
        "--api-key",
        "headless-extension-load-test",
        "extension load must fail before this prompt",
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          HOME: homeDir,
          LANG: "C",
          LC_ALL: "C",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: root,
          PI_CODING_AGENT_DIR: agentDir,
          MCP_DIRECT_TOOLS: "ambient-direct-tool-sentinel",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function createSessionFixture(variant, options = {}) {
  const server = await startFixtureServer(variant);
  const restoreFetch = installFixtureFetchRedirect(server.port);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mcpproxy-${variant}-`));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const homeDir = path.join(root, "home");
  for (const directory of [cwd, agentDir, sessionsDir, homeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    MCP_DIRECT_TOOLS: "ambient-direct-tool-sentinel",
    ANTHROPIC_API_KEY: "mcpproxy-adapter-test-key",
  });

  const ambientConfig = {
    mcpServers: {
      ambient: {
        url: "http://127.0.0.1:9/mcp",
        lifecycle: "eager",
        directTools: true,
      },
    },
  };
  writeJson(path.join(homeDir, ".config/mcp/mcp.json"), ambientConfig);
  writeJson(path.join(agentDir, "mcp.json"), ambientConfig);
  writeJson(path.join(cwd, ".mcp.json"), ambientConfig);
  writeJson(path.join(cwd, ".pi/mcp.json"), ambientConfig);
  assert.equal(fs.existsSync(path.join(agentDir, "mcp-cache.json")), false);

  let session;
  try {
    const {
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
      createAgentSession,
      getModel,
    } = await loadRuntimeModules();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const wrapperPaths = options.useWrapper === false ? [] : [wrapperPath()];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: wrapperPaths,
      extensionFactories: options.extensionFactories ?? [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    if (variant === "warm-missing") {
      await waitForCondition(
        () => fs.existsSync(path.join(agentDir, "mcp-cache.json"))
          && server.activities.some((activity) => (
            activity.kind === "protocol"
            && activity.method === "tools/list"
            && activity.listCall === 1
          )),
        "load-time initialization did not seed the warm metadata cache",
      );
    }
    await options.afterResourceLoad?.({ agentDir, resourceLoader, server });

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "reviewed Pi model fixture is unavailable");
    const sessionManager = SessionManager.create(cwd, sessionsDir, {
      id: `mcpproxy-${variant}`,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      noTools: "builtin",
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    }));
    const extensionErrors = [];
    await session.bindExtensions({
      mode: "rpc",
      onError(error) { extensionErrors.push(error); },
    });

    return {
      agentDir,
      extensionErrors,
      restoreEnvironment,
      restoreFetch,
      resourceLoader,
      root,
      server,
      session,
    };
  } catch (error) {
    session?.dispose();
    restoreFetch();
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    await stopFixtureServer(server);
    throw error;
  }
}

async function closeSessionFixture(fixture) {
  try {
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
  } finally {
    fixture.restoreFetch();
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
    await stopFixtureServer(fixture.server);
  }
}

async function withSessionVariant(variant, operation, options = {}) {
  const fixture = await createSessionFixture(variant, options);
  try {
    return await operation(fixture);
  } finally {
    await closeSessionFixture(fixture);
  }
}

function textPayload(result) {
  const text = result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  return JSON.parse(text);
}

async function executeTool(fixture, name, args) {
  const definition = fixture.session.getToolDefinition(name);
  assert.ok(definition, `${name} was not registered`);
  return definition.execute(
    `task-3-8-${name}`,
    args,
    undefined,
    undefined,
    fixture.session.extensionRunner.createContext(),
  );
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to throw");
}

function assertFixedSchemaFailure(operation, reason, sentinels = []) {
  const error = captureError(operation);
  assert.equal(error instanceof RangeError, false);
  assert.equal(error instanceof Error, true);
  assert.equal(error.message, reason);
  const rendered = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  for (const sentinel of sentinels) assert.equal(rendered.includes(sentinel), false);
}

function schemaAtNestedDepth(nestedArrays) {
  let value = true;
  for (let index = 0; index < nestedArrays; index += 1) value = [value];
  return { type: "object", "x-depth": value };
}

function schemaWithNodeCount(nodeCount) {
  const groups = Array.from({ length: 1_024 }, () => []);
  let remaining = nodeCount - 3 - groups.length;
  assert.equal(remaining >= 0, true);
  for (let index = 0; index < remaining; index += 1) {
    groups[index % groups.length].push(null);
  }
  return { type: "object", "x-nodes": groups };
}

function schemaWithAggregateTextBytes(textBytes) {
  const keys = ["x-text-a", "x-text-b", "x-text-c", "x-text-d"];
  const schema = { type: "object" };
  let remaining = textBytes - Buffer.byteLength("type") - Buffer.byteLength("object");
  for (const key of keys) remaining -= Buffer.byteLength(key);
  for (const key of keys) {
    const length = Math.min(65_536, remaining);
    schema[key] = "x".repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(
    Object.entries(schema).reduce((total, [key, value]) => (
      total + Buffer.byteLength(key) + Buffer.byteLength(value)
    ), 0),
    textBytes,
  );
  return schema;
}

function assertSanitizedAdapterError(message, reason) {
  assert.match(message, new RegExp(`mcpproxy/(?:${directToolNames.join("|")}): ${reason}`));
  for (const sentinel of attackerSentinels) assert.equal(message.includes(sentinel), false);
}

test("repository wrapper closes the real 2.20.1 adapter configuration", async () => {
  const wrapper = await loadWrapperModule();
  assert.deepEqual([...wrapper.MCPPROXY_DIRECT_TOOL_NAMES], directToolNames);
  assert.deepEqual(wrapper.MCPPROXY_ADAPTER_DIRECT_TOOLS, [{
    server: "mcpproxy",
    tools: directToolNames,
  }]);
  assertDeepFrozen(wrapper.MCPPROXY_DIRECT_TOOL_NAMES);
  assertDeepFrozen(wrapper.MCPPROXY_ADAPTER_DIRECT_TOOLS);
  assertDeepFrozen(wrapper.MANAGED_MCP_SURFACE_CONTRACT);
  assertDeepFrozen(wrapper.MCPPROXY_ADAPTER_CONFIG);
  assert.deepEqual(wrapper.MCPPROXY_ADAPTER_CONFIG, {
    mcpServers: {
      mcpproxy: {
        url: "http://127.0.0.1:8080/mcp",
        auth: false,
        oauth: false,
        lifecycle: "eager",
        idleTimeout: 0,
        exposeResources: false,
        directTools: directToolNames,
        toolPrefix: "none",
        includeTools: directToolNames,
      },
    },
    settings: {
      toolPrefix: "none",
      hostConfigDiscovery: "off",
      idleTimeout: 0,
      directTools: false,
      scriptMode: false,
      disableProxyTool: true,
      freezeDirectTools: true,
      autoAuth: false,
      sampling: false,
      samplingAutoApprove: false,
      elicitation: false,
    },
  });
});

test("exported managed MCP surface validator is exact and allows declared unrelated tools", async () => {
  const { validateManagedMcpSurface } = await loadWrapperModule();
  const unrelated = ["read", "plan_mode_question", "background_tasks"];
  const valid = validateManagedMcpSurface([...directToolNames, ...unrelated], unrelated);
  assert.deepEqual(valid, [...directToolNames, ...unrelated]);
  assert.equal(Object.isFrozen(valid), true);

  assert.throws(
    () => validateManagedMcpSurface(directToolNames.slice(1), unrelated),
    /missing=.*retrieve_tools/,
  );
  assert.throws(
    () => validateManagedMcpSurface([...directToolNames, "retrieve_tools"], unrelated),
    /duplicate=.*retrieve_tools/,
  );
  for (const forbidden of [
    "mcp",
    "mcpScript",
    "code_execution",
    "mcpproxy_code_execution",
    "mcpproxy_retrieve_tools",
    "mcp__mcpproxy_retrieve_tools",
  ]) {
    assert.throws(
      () => validateManagedMcpSurface([...directToolNames, forbidden], unrelated),
      /forbidden=/,
    );
  }
  assert.throws(
    () => validateManagedMcpSurface([...directToolNames, "undeclared_extension_tool"], unrelated),
    /unexpected=.*undeclared_extension_tool/,
  );
});

test("strict schema preparation accepts every exact resource boundary and rejects one over", async () => {
  const { cloneAndValidateDirectToolInputSchema } = await loadAdapterModule();
  assert.equal(typeof cloneAndValidateDirectToolInputSchema, "function");

  const exactKey = "\u00e9".repeat(128);
  const exactObject = { type: "object" };
  for (let index = 0; index < 1_023; index += 1) exactObject[`x${index}`] = null;
  const exactSchemas = [
    schemaAtNestedDepth(31),
    schemaWithNodeCount(4_096),
    { type: "object", "x-container": Array.from({ length: 1_024 }, () => null) },
    exactObject,
    { type: "object", "x-string": "\u00e9".repeat(32_768) },
    { type: "object", [exactKey]: null },
    schemaWithAggregateTextBytes(256 * 1_024),
  ];
  for (const schema of exactSchemas) {
    const clone = cloneAndValidateDirectToolInputSchema(schema);
    assert.notEqual(clone, schema);
    assert.equal(clone.type, "object");
  }

  const oneOverCases = [
    [schemaAtNestedDepth(32), "JSON_DEPTH_LIMIT"],
    [schemaWithNodeCount(4_097), "JSON_NODE_LIMIT"],
    [
      { type: "object", "x-container": Array.from({ length: 1_025 }, () => null) },
      "JSON_CONTAINER_LIMIT",
    ],
    [
      Object.fromEntries([
        ["type", "object"],
        ...Array.from({ length: 1_024 }, (_, index) => [`x${index}`, null]),
      ]),
      "JSON_CONTAINER_LIMIT",
    ],
    [{ type: "object", "x-string": `${"\u00e9".repeat(32_768)}a` }, "JSON_STRING_LIMIT"],
    [{ type: "object", [`${exactKey}a`]: null }, "JSON_KEY_LIMIT"],
    [schemaWithAggregateTextBytes((256 * 1_024) + 1), "JSON_TEXT_LIMIT"],
  ];
  for (const [schema, reason] of oneOverCases) {
    assertFixedSchemaFailure(() => cloneAndValidateDirectToolInputSchema(schema), reason);
  }
});

test("strict schema preparation is iterative, descriptor-safe, and value-free", async () => {
  const { cloneAndValidateDirectToolInputSchema } = await loadAdapterModule();

  let accessorCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "sensitive-accessor-key", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "object";
    },
  });
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(accessor),
    "JSON_ACCESSOR_NOT_ALLOWED",
    ["sensitive-accessor-key"],
  );
  assert.equal(accessorCalls, 0);

  let toJsonCalls = 0;
  const toJsonAccessor = { type: "object" };
  Object.defineProperty(toJsonAccessor, "toJSON", {
    enumerable: true,
    get() {
      toJsonCalls += 1;
      return () => ({ type: "object" });
    },
  });
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(toJsonAccessor),
    "JSON_ACCESSOR_NOT_ALLOWED",
  );
  assert.equal(toJsonCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({ type: "object" }, {
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error("sensitive-proxy-sentinel");
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error("sensitive-proxy-sentinel");
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error("sensitive-proxy-sentinel");
    },
  });
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(proxy),
    "JSON_PROXY_NOT_ALLOWED",
    ["sensitive-proxy-sentinel"],
  );
  assert.equal(proxyTrapCalls, 0);

  const cycle = { type: "object" };
  cycle.properties = { cycle };
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(cycle),
    "JSON_REPEATED_REFERENCE",
  );
  const aliased = { type: "string" };
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({
      type: "object",
      properties: { first: aliased, second: aliased },
    }),
    "JSON_REPEATED_REFERENCE",
  );

  const symbolSchema = { type: "object" };
  symbolSchema[Symbol("schema-marker")] = true;
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(symbolSchema),
    "JSON_SYMBOL_NOT_ALLOWED",
  );
  const exoticSchema = Object.create({ inherited: true });
  exoticSchema.type = "object";
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(exoticSchema),
    "JSON_EXOTIC_PROTOTYPE",
  );
  const exoticArray = [];
  Object.setPrototypeOf(exoticArray, null);
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({ type: "object", value: exoticArray }),
    "JSON_EXOTIC_PROTOTYPE",
  );

  const sparse = new Array(2);
  sparse[0] = true;
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({ type: "object", value: sparse }),
    "JSON_SPARSE_ARRAY",
  );
  const arrayProperty = [true];
  arrayProperty.extra = false;
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({ type: "object", value: arrayProperty }),
    "JSON_ARRAY_PROPERTY",
  );

  for (const invalid of [undefined, () => undefined, 1n, Symbol("value")]) {
    assertFixedSchemaFailure(
      () => cloneAndValidateDirectToolInputSchema({ type: "object", value: invalid }),
      "JSON_NON_VALUE",
    );
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertFixedSchemaFailure(
      () => cloneAndValidateDirectToolInputSchema({ type: "object", value: invalid }),
      "JSON_NON_FINITE_NUMBER",
    );
  }
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({ type: "string" }),
    "SCHEMA_ROOT_TYPE",
  );
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({
      type: "object",
      properties: { "sensitive-key-sentinel": 7 },
    }),
    "SCHEMA_INVALID",
    ["sensitive-key-sentinel"],
  );
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({
      $schema: "sensitive-dialect-sentinel",
      type: "object",
    }),
    "SCHEMA_DIALECT_UNSUPPORTED",
    ["sensitive-dialect-sentinel"],
  );

  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema(schemaAtNestedDepth(5_000)),
    "JSON_DEPTH_LIMIT",
  );
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({
      type: "object",
      "x-annotation": "sensitive-annotation-sentinel".padEnd(4 * 1_024 * 1_024, "x"),
    }),
    "JSON_STRING_LIMIT",
    ["sensitive-annotation-sentinel"],
  );
  assertFixedSchemaFailure(
    () => cloneAndValidateDirectToolInputSchema({
      type: "object",
      "x-container": Array.from({ length: 100_000 }, () => null),
    }),
    "JSON_CONTAINER_LIMIT",
  );

  const source = {
    type: "object",
    properties: {
      marker: { type: "string", const: "live" },
    },
  };
  const clone = cloneAndValidateDirectToolInputSchema(source);
  source.properties.marker.const = "mutated";
  assert.equal(clone.properties.marker.const, "live");
  assert.notEqual(clone, source);
  assert.equal(Object.getPrototypeOf(clone), null);
  assert.equal(Object.getPrototypeOf(clone.properties), null);

  const pollution = Object.create(null);
  for (const key of ["__proto__", "constructor", "prototype"]) {
    Object.defineProperty(pollution, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { polluted: key },
    });
  }
  const pollutionClone = cloneAndValidateDirectToolInputSchema({
    type: "object",
    "x-pollution": pollution,
  });
  assert.equal(Object.getPrototypeOf(pollutionClone), null);
  assert.equal(Object.getPrototypeOf(pollutionClone["x-pollution"]), null);
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.equal(Object.hasOwn(pollutionClone["x-pollution"], key), true);
    assert.equal(pollutionClone["x-pollution"][key].polluted, key);
  }
  assert.equal({}.polluted, undefined);
});

test("invalid live schemas fail cold before any direct tool registration", async () => {
  for (const variant of [
    "invalid-schema",
    "unsupported-dialect",
    "invalid-root-schema",
    "missing-description",
  ]) {
    const registrationBatches = [];
    const extensionFactory = await createCountingAdapterFactory(registrationBatches);
    const fixture = await createLoaderFixture(variant, {
      useWrapper: false,
      extensionFactories: [extensionFactory],
    });
    try {
      assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
      assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
      assert.match(
        fixture.resourceLoader.getExtensions().errors[0].error,
        /MCP direct tool (?:metadata|schema) mismatch/,
      );
      for (const sentinel of attackerSentinels) {
        assert.equal(fixture.resourceLoader.getExtensions().errors[0].error.includes(sentinel), false);
      }
      assert.equal(registrationBatches.length, 1);
      assert.equal(registrationBatches[0].length, 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registrationBatches[0].length, 0);
    } finally {
      await closeLoaderFixture(fixture);
    }
  }
});

test("cold oversized live records fail atomically with fixed bounded errors", async () => {
  for (const [variant, reason] of Object.entries(oversizedVariantReasons)) {
    const registrationBatches = [];
    const extensionFactory = await createCountingAdapterFactory(registrationBatches);
    const fixture = await createLoaderFixture(variant, {
      useWrapper: false,
      extensionFactories: [extensionFactory],
    });
    try {
      assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
      assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
      assertSanitizedAdapterError(
        fixture.resourceLoader.getExtensions().errors[0].error,
        reason,
      );
      assert.equal(registrationBatches.length, 1);
      assert.equal(registrationBatches[0].length, 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registrationBatches[0].length, 0);
    } finally {
      await closeLoaderFixture(fixture);
    }
  }
});

test("built managed adapter has no MCP_DIRECT_TOOLS environment fallback", () => {
  const adapterRoot = path.join(buildRuntimePaths().extensions, "lib/node_modules/pi-mcp-adapter");
  for (const source of ["index.ts", "init.ts"]) {
    const contents = fs.readFileSync(path.join(adapterRoot, source), "utf8");
    assert.doesNotMatch(contents, /MCP_DIRECT_TOOLS/);
  }
});

test("cold invalid live metadata fails extension loading and headless startup", async () => {
  for (const variant of ["missing", "prefixed", "duplicate", "failure"]) {
    const fixture = await createLoaderFixture(variant);
    try {
      assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
      assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
      assert.match(
        fixture.resourceLoader.getExtensions().errors[0].error,
        /MCP direct tool metadata mismatch|deterministic tools\/list failure/,
      );
    } finally {
      await closeLoaderFixture(fixture);
    }
  }

  const headless = runHeadlessExtensionLoad();
  assert.equal(headless.status, 1, headless.stderr);
  assert.match(headless.stderr, /Failed to load extension/);
  assert.match(headless.stderr, /MCP direct tool metadata mismatch/);
});

test("delayed eager initialization never mutates process-global direct-tool selection", async () => {
  await withSessionVariant("exact", async (fixture) => {
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
    assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
  }, {
    afterResourceLoad({ resourceLoader, server }) {
      assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
      assert.deepEqual(
        resourceLoader.getExtensions().extensions.flatMap((extension) => (
          [...extension.tools.keys()]
        )),
        directToolNames,
      );
      assert.equal(
        server.activities.filter((activity) => (
          activity.kind === "protocol" && activity.method === "tools/list"
        )).length,
        1,
      );
    },
  });
});

test("cold agent start exposes six direct tools and completes discover flows", async () => {
  await withSessionVariant("exact", async (fixture) => {
    assert.deepEqual(fixture.extensionErrors, []);
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
    assert.equal(new Set(fixture.session.getActiveToolNames()).size, 6);
    assert.deepEqual(
      fixture.session.getAllTools()
        .filter(({ sourceInfo }) => /[/\\]mcpproxy[/\\]index\.ts$/.test(sourceInfo.path))
        .map(({ name }) => name),
      directToolNames,
    );
    assert.equal(fixture.session.getToolDefinition("mcp"), undefined);
    assert.equal(fixture.session.getToolDefinition("mcpScript"), undefined);
    assert.equal(fixture.session.getActiveToolNames().includes("mcp"), false);
    assert.equal(fixture.session.getActiveToolNames().includes("mcpScript"), false);
    assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
    assert.equal(
      fixture.server.activities.filter((activity) => (
        activity.kind === "protocol" && activity.method === "tools/list"
      )).length,
      1,
    );

    const cache = JSON.parse(
      fs.readFileSync(path.join(fixture.agentDir, "mcp-cache.json"), "utf8"),
    );
    assert.deepEqual(cache.servers.mcpproxy.tools.map(({ name }) => name), directToolNames);

    const initialHttp = fixture.server.activities.filter((activity) => activity.kind === "http");
    const initialize = initialHttp.find((activity) => activity.rpcMethod === "initialize");
    assert.ok(initialize, "eager initialization did not reach the server before a prompt");
    assert.equal(Object.hasOwn(initialize.clientCapabilities ?? {}, "sampling"), false);
    assert.equal(Object.hasOwn(initialize.clientCapabilities ?? {}, "elicitation"), false);
    assert.equal(initialHttp.every(({ path: requestPath }) => requestPath === "/mcp"), true);
    assert.equal(initialHttp.every(({ hasAuthorization }) => hasAuthorization === false), true);
    assert.equal(initialHttp.some(({ rpcMethod }) => rpcMethod === "resources/list"), false);
    assert.equal(initialHttp.some(({ rpcMethod }) => rpcMethod === "prompts/list"), false);
    assert.deepEqual(
      fixture.server.activities.filter((activity) => activity.kind === "tool-call"),
      [],
    );

    const retrieved = textPayload(await executeTool(fixture, "retrieve_tools", {
      query: "fixture record",
      limit: 5,
    }));
    assert.equal(retrieved.tools[0].name, "fixture:get_record");
    assert.equal(retrieved.tools[0].call_with, "call_tool_read");

    const described = textPayload(await executeTool(fixture, "describe_tool", {
      tool_ids: [retrieved.tools[0].name],
    }));
    assert.deepEqual(described.tools[0].inputSchema.required, ["id"]);

    const read = textPayload(await executeTool(fixture, "call_tool_read", {
      name: retrieved.tools[0].name,
      args: { id: "task-3-8" },
      intent_reason: "deterministic Task 3.8 read flow",
      intent_data_sensitivity: "internal",
    }));
    assert.deepEqual(read.result, {
      fixture: "task-3.8-read-result",
      id: "task-3-8",
    });
    assert.deepEqual(
      fixture.server.activities
        .filter((activity) => activity.kind === "tool-call")
        .map(({ name }) => name),
      ["retrieve_tools", "describe_tool", "call_tool_read"],
    );

    await fixture.session.reload({
      beforeSessionStart() {
        assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
      },
    });
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
    assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
    assert.equal(
      fixture.server.activities.filter((activity) => (
        activity.kind === "protocol" && activity.method === "tools/list"
      )).length,
      2,
    );
  });

  await withSessionVariant("unrelated", async (fixture) => {
    assert.deepEqual(fixture.extensionErrors, []);
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
    const cache = JSON.parse(
      fs.readFileSync(path.join(fixture.agentDir, "mcp-cache.json"), "utf8"),
    );
    assert.equal(cache.servers.mcpproxy.tools.some(({ name }) => (
      name === "unrelated_server_tool"
    )), true);
    assert.equal(fixture.session.getToolDefinition("unrelated_server_tool"), undefined);
  });

});

test("warm valid runner reload fails fatally on live drift without stale reactivation", async () => {
  await withSessionVariant("warm-missing", async (fixture) => {
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
    await fixture.session.reload();
    assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
    assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
    assert.match(
      fixture.resourceLoader.getExtensions().errors[0].error,
      /MCP direct tool metadata mismatch/,
    );
    assert.deepEqual(fixture.session.getActiveToolNames(), []);
    assert.deepEqual(
      fixture.session.getAllTools().filter(({ name }) => directToolNames.includes(name)),
      [],
    );
  });
});

test("warm invalid live schema fails before registration without stale definitions", async () => {
  const registrationBatches = [];
  const extensionFactory = await createCountingAdapterFactory(registrationBatches);
  await withSessionVariant("warm-invalid-schema", async (fixture) => {
    assert.equal(registrationBatches.length, 1);
    assert.equal(registrationBatches[0].length, 6);
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);

    await fixture.session.reload();
    assert.equal(registrationBatches.length, 2);
    assert.equal(registrationBatches[1].length, 0);
    assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
    assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
    assert.match(
      fixture.resourceLoader.getExtensions().errors[0].error,
      /MCP direct tool schema mismatch/,
    );
    assert.deepEqual(fixture.session.getActiveToolNames(), []);
    assert.deepEqual(
      fixture.session.getAllTools().filter(({ name }) => directToolNames.includes(name)),
      [],
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registrationBatches[1].length, 0);
  }, {
    useWrapper: false,
    extensionFactories: [extensionFactory],
  });
});

test("warm oversized live records fail atomically without stale definitions", async () => {
  for (const [variant, reason] of Object.entries(oversizedVariantReasons)) {
    const registrationBatches = [];
    const extensionFactory = await createCountingAdapterFactory(registrationBatches);
    await withSessionVariant(`warm-${variant}`, async (fixture) => {
      assert.equal(registrationBatches.length, 1);
      assert.equal(registrationBatches[0].length, 6);
      assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);

      await fixture.session.reload();
      assert.equal(registrationBatches.length, 2);
      assert.equal(registrationBatches[1].length, 0);
      assert.equal(fixture.resourceLoader.getExtensions().extensions.length, 0);
      assert.equal(fixture.resourceLoader.getExtensions().errors.length, 1);
      assertSanitizedAdapterError(
        fixture.resourceLoader.getExtensions().errors[0].error,
        reason,
      );
      assert.deepEqual(fixture.session.getActiveToolNames(), []);
      assert.deepEqual(
        fixture.session.getAllTools().filter(({ name }) => directToolNames.includes(name)),
        [],
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registrationBatches[1].length, 0);
    }, {
      useWrapper: false,
      extensionFactories: [extensionFactory],
    });
  }
});

test("valid warm schema drift registers the cloned live definition", async () => {
  const registrationBatches = [];
  const extensionFactory = await createCountingAdapterFactory(registrationBatches);
  await withSessionVariant("warm-schema-drift", async (fixture) => {
    const first = registrationBatches[0].find(({ name }) => name === "retrieve_tools");
    assert.ok(first);
    assert.equal(first.parameters.properties.live_schema_version, undefined);

    await fixture.session.reload();
    assert.deepEqual(fixture.resourceLoader.getExtensions().errors, []);
    assert.equal(registrationBatches.length, 2);
    assert.equal(registrationBatches[1].length, 6);
    const live = registrationBatches[1].find(({ name }) => name === "retrieve_tools");
    assert.ok(live);
    assert.deepEqual(live.parameters.properties.live_schema_version, {
      type: "string",
      const: "live-v2",
    });
    assert.equal(live.parameters.required.includes("live_schema_version"), true);
    assert.deepEqual(fixture.session.getActiveToolNames(), directToolNames);
  }, {
    useWrapper: false,
    extensionFactories: [extensionFactory],
  });
});

test("two typed adapter factories keep immutable direct-tool selections isolated across reload", async () => {
  const { createMcpAdapter } = await loadAdapterModule();
  const makeConfig = (server, tool) => ({
    mcpServers: {
      [server]: {
        url: "http://127.0.0.1:8080/mcp",
        auth: false,
        oauth: false,
        lifecycle: "eager",
        idleTimeout: 0,
        exposeResources: false,
        directTools: [tool],
        toolPrefix: "none",
        includeTools: [tool],
      },
    },
    settings: {
      toolPrefix: "none",
      idleTimeout: 0,
      scriptMode: false,
      disableProxyTool: true,
      freezeDirectTools: true,
      autoAuth: false,
      sampling: false,
      elicitation: false,
    },
  });
  const firstSelection = [{ server: "proxy-a", tools: ["retrieve_tools"] }];
  const secondSelection = [{ server: "proxy-b", tools: ["describe_tool"] }];
  const first = createMcpAdapter({
    config: makeConfig("proxy-a", "retrieve_tools"),
    directTools: firstSelection,
  });
  const second = createMcpAdapter({
    config: makeConfig("proxy-b", "describe_tool"),
    directTools: secondSelection,
  });
  firstSelection[0].tools.push("read_cache");
  secondSelection[0].tools.push("call_tool_read");

  await withSessionVariant("unrelated", async (fixture) => {
    assert.deepEqual(fixture.extensionErrors, []);
    assert.deepEqual(
      fixture.session.getActiveToolNames().sort(),
      ["describe_tool", "retrieve_tools"],
    );
    assert.equal(
      fixture.server.activities.filter((activity) => (
        activity.kind === "protocol" && activity.method === "tools/list"
      )).length,
      2,
    );
    assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
    await fixture.session.reload({
      beforeSessionStart() {
        assert.equal(process.env.MCP_DIRECT_TOOLS, "ambient-direct-tool-sentinel");
      },
    });
    assert.deepEqual(
      fixture.session.getActiveToolNames().sort(),
      ["describe_tool", "retrieve_tools"],
    );
    assert.equal(
      fixture.server.activities.filter((activity) => (
        activity.kind === "protocol" && activity.method === "tools/list"
      )).length,
      4,
    );
  }, {
    useWrapper: false,
    extensionFactories: [
      { name: "typed-direct-a", factory: first },
      { name: "typed-direct-b", factory: second },
    ],
  });
});
