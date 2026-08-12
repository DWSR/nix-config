import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const timeoutBinding = "PI_AGENT_BASH_TIMEOUT_MS";
const maxManagedTimeoutMs = 2_147_483_647;
const managedDefaultMs = 400;
const managedDefaultSeconds = managedDefaultMs / 1000;
const invalidBindingDiagnostic =
  "Failed to load extension: Invalid PI_AGENT_BASH_TIMEOUT_MS: expected a decimal integer from 1 through 2147483647 milliseconds";
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
let toolCallSequence = 0;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-bash-timeout-tests";
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

  const outputs = childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          let
            credentialFixture = source + "/tests/pi-agent/fixtures/credential-policy.nix";
            runtimeModule = import credentialFixture {
              fixture = "shopify-runtime-module";
              repoRoot = source;
            };
            managedShell = import credentialFixture {
              fixture = "managed-shell";
              repoRoot = source;
            };
          in
            [ pkgs.pi-agent pkgs.pi-agent-extensions runtimeModule managedShell ]
        `),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.equal(outputs.length, 4, `expected four runtime outputs, got ${outputs.join(", ")}`);
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) =>
      fs.existsSync(path.join(output, "share/pi-agent/extensions.json")),
    ),
    credentialPolicy: outputs.find((output) =>
      fs.existsSync(path.join(output, "lib/pi-agent/credential-policy.mjs")),
    ),
    shell: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi-agent-shell"))),
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
    `${pathToFileURL(path.join(runtime.credentialPolicy, "lib/pi-agent/credential-policy.mjs")).href}?task46`
  );
  return credentialPolicy;
}

async function loadManagedTimeoutModule() {
  const runtime = buildRuntimePaths();
  const { createJiti } = await import(
    pathToFileURL(path.join(runtime.pi, "lib/node_modules/jiti/lib/jiti.mjs"))
  );
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti.import(managedTimeoutModulePath());
}

function timeoutExtensionPath() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts",
  );
}

function managedTimeoutModulePath() {
  return path.join(
    buildRuntimePaths().extensions,
    "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/managed-timeout.ts",
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

async function loadExtensionErrors(bindingValue) {
  const { DefaultResourceLoader, SettingsManager } = await loadRuntimeModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-timeout-load-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const restoreEnvironment = applyEnvironment({
    HOME: path.join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    [timeoutBinding]: bindingValue,
  });

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [timeoutExtensionPath()],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    return structuredClone(resourceLoader.getExtensions().errors);
  } finally {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function createSession({
  role = "rootPi",
  bashDefaultMs = managedDefaultMs,
  hostileSupi = false,
  hostileShellEnvironment = false,
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
  const policy = await loadCredentialPolicy();
  const runtime = buildRuntimePaths();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bash-timeout-${role}-`));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const homeDir = path.join(root, "home");
  for (const directory of [cwd, agentDir, sessionsDir, homeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (hostileSupi) {
    writeJson(path.join(homeDir, ".pi/agent/supi/config.json"), {
      "bash-timeout": { defaultTimeout: 0.025 },
    });
    writeJson(path.join(cwd, ".pi/supi/config.json"), {
      "bash-timeout": { defaultTimeout: 0.05 },
    });
  }
  writeJson(path.join(agentDir, "settings.json"), {
    shellPath: path.join(runtime.shell, "bin/pi-agent-shell"),
  });

  const runtimeInputs = policy.createBashRuntimeInputs({ bashDefaultMs });
  const selectedEnvironment =
    role === "rootPi" ? runtimeInputs.rootPiEnvironment : runtimeInputs.childPiEnvironment;
  const providerSentinel = `task-4.6-${role}-provider-sentinel`;
  const launchSentinel = "4b065e47-3b5f-49df-91ca-2d87bd0ac496";
  const environment = {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    ANTHROPIC_API_KEY: providerSentinel,
    SHOPIFY_PI_TOKEN: providerSentinel,
    PI_AGENT_LAUNCH_ID: launchSentinel,
    ...selectedEnvironment,
  };
  if (hostileShellEnvironment) {
    const bashEnvironment = path.join(root, "hostile-bash-env.sh");
    fs.writeFileSync(
      bashEnvironment,
      `printf 'pre-scrub:%s|%s\\n' "\${SHOPIFY_PI_TOKEN-}" "\${PI_AGENT_BASH_TIMEOUT_MS-}" >&2\n`,
      { mode: 0o600 },
    );
    Object.assign(environment, {
      BASH_ENV: bashEnvironment,
      BASHOPTS: "extglob:sourcepath",
      PS4: `pre-trace:${providerSentinel}|${selectedEnvironment[timeoutBinding]}:`,
      SHELLOPTS: "braceexpand:hashall:interactive-comments:nounset:xtrace",
      DYLD_PRINT_APIS: "1",
      DYLD_PRINT_ENV: "1",
      DYLD_PRINT_LIBRARIES: "1",
      DYLD_INSERT_LIBRARIES: `/nonexistent/${providerSentinel}.dylib`,
      DYLD_LIBRARY_PATH: `/nonexistent/${selectedEnvironment[timeoutBinding]}`,
    });
  }
  const restoreEnvironment = applyEnvironment(environment);

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [timeoutExtensionPath()],
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
      id: `bash-timeout-${role}-${bashDefaultMs}`,
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
    await session.bindExtensions({
      uiContext: createUi(),
      mode: "rpc",
      onError(error) {
        extensionErrors.push(error);
      },
    });
    assert.deepEqual(extensionErrors, []);

    return {
      bashDefaultMs,
      createAssistantMessageEventStream,
      cwd,
      environment,
      launchSentinel,
      providerSentinel,
      restoreEnvironment,
      root,
      role,
      session,
    };
  } catch (error) {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeSession(fixture) {
  try {
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    fixture.session.dispose();
  } finally {
    fixture.restoreEnvironment();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function applyToolCallHook(fixture, toolName, input) {
  toolCallSequence += 1;
  await fixture.session.agent.beforeToolCall({
    assistantMessage: assistantMessage(fixture.session.model, [], "toolUse"),
    toolCall: {
      type: "toolCall",
      id: `bash-timeout-hook-${toolCallSequence}`,
      name: toolName,
      arguments: input,
    },
    args: input,
    context: { messages: [], systemPrompt: "", tools: [] },
  });
  return input;
}

async function executeBashTurn(fixture, input) {
  toolCallSequence += 1;
  const toolCallId = `bash-timeout-exec-${toolCallSequence}`;
  let responseIndex = 0;
  fixture.session.agent.streamFunction = (model) => {
    const message =
      responseIndex++ === 0
        ? assistantMessage(
            model,
            [{ type: "toolCall", id: toolCallId, name: "bash", arguments: input }],
            "toolUse",
          )
        : assistantMessage(model, [{ type: "text", text: "bash fixture complete" }], "stop");
    const stream = fixture.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  await fixture.session.prompt(`Run Bash fixture ${toolCallId}`);
  await fixture.session.waitForIdle();
  const result = fixture.session.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
    )?.message;
  assert.ok(result, `missing Bash result for ${toolCallId}`);
  return result;
}

function resultText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function latestBashToolCall(session) {
  for (const entry of session.sessionManager.getBranch().toReversed()) {
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const toolCall = entry.message.content.find(
      (item) => item.type === "toolCall" && item.name === "bash",
    );
    if (toolCall) return toolCall;
  }
  return undefined;
}

async function waitForFiles(files) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (files.every((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${files.join(", ")}`);
}

test("managed timeout binding rejects missing and invalid values before session creation", async (t) => {
  const cases = [
    ["missing", undefined],
    ["malformed", "task-4.6-malformed-binding-sentinel"],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["overflow", "2147483648"],
  ];

  for (const [name, value] of cases) {
    await t.test(name, async () => {
      const errors = await loadExtensionErrors(value);
      assert.deepEqual(errors, [
        {
          path: timeoutExtensionPath(),
          error: invalidBindingDiagnostic,
        },
      ]);
      assert.doesNotMatch(errors[0].error, /task-4\.6-malformed-binding-sentinel/);
    });
  }
});

test("managed milliseconds round-trip through Pi seconds without timer truncation", async () => {
  assert.equal(Math.trunc((1001 / 1000) * 1000), 1000);
  const { parseManagedTimeoutSeconds } = await loadManagedTimeoutModule();
  const samples = new Set([
    1,
    2,
    999,
    1000,
    1001,
    1002,
    maxManagedTimeoutMs - 1,
    maxManagedTimeoutMs,
  ]);
  const stride = Math.floor(maxManagedTimeoutMs / 4096);
  for (let milliseconds = 1; milliseconds <= maxManagedTimeoutMs; milliseconds += stride) {
    samples.add(milliseconds);
  }
  let state = 0x46c0ffee;
  for (let index = 0; index < 20_000; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples.add(1 + (state % maxManagedTimeoutMs));
  }

  for (const milliseconds of samples) {
    const seconds = parseManagedTimeoutSeconds(String(milliseconds));
    assert.equal(
      Math.trunc(seconds * 1000),
      milliseconds,
      `${milliseconds}ms converted to ${seconds}s`,
    );
  }
});

test("managed root and foreground-child defaults ignore hostile Supi overrides and finish early", async () => {
  for (const role of ["rootPi", "foregroundChildPi"]) {
    const fixture = await createSession({ role, hostileSupi: true });
    try {
      const omitted = await applyToolCallHook(fixture, "bash", { command: "printf omitted" });
      const nullable = await applyToolCallHook(fixture, "bash", {
        command: "printf nullable",
        timeout: null,
      });
      assert.equal(omitted.timeout, managedDefaultSeconds, role);
      assert.equal(nullable.timeout, managedDefaultSeconds, role);

      process.env[timeoutBinding] = "900";
      const readOnce = await applyToolCallHook(fixture, "bash", { command: "printf read-once" });
      assert.equal(readOnce.timeout, managedDefaultSeconds, role);
      process.env[timeoutBinding] = fixture.environment[timeoutBinding];

      const explicit = { command: "printf explicit", timeout: 0.175 };
      await applyToolCallHook(fixture, "bash", explicit);
      assert.equal(explicit.timeout, 0.175, role);

      const invalidExplicit = { command: "printf invalid", timeout: 0 };
      await applyToolCallHook(fixture, "bash", invalidExplicit);
      assert.equal(invalidExplicit.timeout, 0, role);

      for (const toolName of ["read", "bg_start", "bg_wait"]) {
        const input = { path: "fixture", timeout: null };
        await applyToolCallHook(fixture, toolName, input);
        assert.deepEqual(input, { path: "fixture", timeout: null }, `${role}:${toolName}`);
      }

      const result = await executeBashTurn(fixture, {
        command: "sleep 0.12; printf 'early-completion-ok'",
      });
      assert.equal(result.isError, false, `${role}: ${resultText(result)}`);
      assert.equal(resultText(result), "early-completion-ok", role);
    } finally {
      await closeSession(fixture);
    }
  }
});

test("real agent loop treats model timeout null as omitted without conflating explicit zero", async () => {
  const fixture = await createSession();
  try {
    const result = await executeBashTurn(fixture, {
      command: "sleep 0.12; printf 'agent-loop-null-ok'",
      timeout: null,
    });
    assert.equal(result.isError, false, resultText(result));
    assert.equal(resultText(result), "agent-loop-null-ok");
    assert.equal(latestBashToolCall(fixture.session)?.arguments.timeout, managedDefaultSeconds);
  } finally {
    await closeSession(fixture);
  }
});

test("explicit fractional timeout is exact and invalid explicit input remains Pi-owned", async () => {
  const fixture = await createSession();
  try {
    const invalidEffect = path.join(fixture.cwd, "invalid-timeout-effect");
    const invalid = await executeBashTurn(fixture, {
      command: `printf invalid > ${quoteShell(invalidEffect)}`,
      timeout: 0,
    });
    assert.equal(invalid.isError, true);
    assert.match(resultText(invalid), /Invalid timeout: must be a finite number of seconds/);
    assert.equal(fs.existsSync(invalidEffect), false);

    const explicit = await executeBashTurn(fixture, {
      command: "sleep 30",
      timeout: 0.175,
    });
    assert.equal(explicit.isError, true);
    assert.match(resultText(explicit), /Command timed out after 0\.175 seconds/);
    assert.doesNotMatch(resultText(explicit), /after 0\.4 seconds/);
  } finally {
    await closeSession(fixture);
  }
});

test("managed default reports timeout and kills the shell plus its ordinary descendant group", async () => {
  const fixture = await createSession({ bashDefaultMs: 500 });
  try {
    const identityToken = `task-4.6-descendant-${randomUUID()}`;
    const shellIdentityPath = path.join(fixture.cwd, "shell.identity");
    const descendantIdentityPath = path.join(fixture.cwd, "descendant.identity");
    const descendantPidPath = path.join(fixture.cwd, "descendant.pid");
    const sideEffectPath = path.join(fixture.cwd, "descendant-effects.log");
    const writer = [
      `printf '%s:%s\\n' "$0" "$$" > "$1"`,
      `while :; do printf '%s\\n' "$0" >> "$2"; sleep 0.02; done`,
    ].join("\n");
    const command = [
      `printf '%s:%s\\n' ${quoteShell(identityToken)} "$$" > ${quoteShell(shellIdentityPath)}`,
      `/bin/sh -c ${quoteShell(writer)} ${quoteShell(identityToken)} ${quoteShell(descendantIdentityPath)} ${quoteShell(sideEffectPath)} &`,
      "descendant=$!",
      `printf '%s\\n' "$descendant" > ${quoteShell(descendantPidPath)}`,
      'wait "$descendant"',
    ].join("\n");
    const resultPromise = executeBashTurn(fixture, { command });
    await waitForFiles([
      shellIdentityPath,
      descendantIdentityPath,
      descendantPidPath,
      sideEffectPath,
    ]);
    const [shellToken, shellPidText] = fs.readFileSync(shellIdentityPath, "utf8").trim().split(":");
    const [descendantToken, descendantPidText] = fs
      .readFileSync(descendantIdentityPath, "utf8")
      .trim()
      .split(":");
    const shellPid = Number(shellPidText);
    const descendantIdentityPid = Number(descendantPidText);
    const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8").trim());
    assert.equal(shellToken, identityToken);
    assert.equal(descendantToken, identityToken);
    assert.ok(Number.isInteger(shellPid) && shellPid > 0);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.equal(descendantIdentityPid, descendantPid);

    const result = await resultPromise;

    assert.equal(result.isError, true);
    assert.match(resultText(result), /Command timed out after 0\.5 seconds/);
    const stableEffects = fs.readFileSync(sideEffectPath, "utf8");
    assert.ok(stableEffects.split("\n").filter(Boolean).length > 0);
    assert.ok(stableEffects.split("\n").filter(Boolean).every((line) => line === identityToken));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.readFileSync(sideEffectPath, "utf8"), stableEffects);
  } finally {
    await closeSession(fixture);
  }
});

test("Task 4.5 shell hides provider and timeout sentinels from output and pre-main channels", async () => {
  const fixture = await createSession({
    bashDefaultMs: 2_147_483_001,
    hostileShellEnvironment: true,
  });
  try {
    const result = await executeBashTurn(fixture, { command: "/usr/bin/env" });
    const output = resultText(result);
    assert.equal(result.isError, false, output);
    assert.doesNotMatch(output, /pre-(?:scrub|trace)/);
    assert.doesNotMatch(output, /PI_AGENT_BASH_TIMEOUT_MS/);
    assert.doesNotMatch(output, /SHOPIFY_PI_TOKEN|PI_AGENT_LAUNCH_ID|ANTHROPIC_API_KEY/);
    assert.doesNotMatch(output, /DYLD_(?:PRINT|INSERT|LIBRARY)/);
    assert.equal(output.includes(fixture.providerSentinel), false);
    assert.equal(output.includes(fixture.launchSentinel), false);
    assert.equal(output.includes(fixture.environment[timeoutBinding]), false);
  } finally {
    await closeSession(fixture);
  }
});
