import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

async function createSession() {
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

  const restoreEnvironment = applyEnvironment({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_AGENT_BASH_TIMEOUT_MS: "4100",
    TASK_4_10_UNLISTED_SENTINEL: "task-4-10-unlisted-sentinel",
    ...providerSentinels,
  });

  try {
    const expectedPipeEnvironment = policy.scrubEnvironment({ ...process.env });
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [backgroundExtensionPath()],
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
      createAssistantMessageEventStream,
      cwd,
      environmentDir,
      expectedPipeEnvironment,
      restoreEnvironment,
      root,
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

async function executeToolBatch(fixture, calls) {
  const toolCalls = calls.map((call, index) => ({
    type: "toolCall",
    id: `background-task-${sessionSequence}-${index}`,
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
      assert.deepEqual(managedEnvironment, fixture.expectedPipeEnvironment);
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

test("Task 4.10 implementation leaves no feature seam", () => {
  const overlay = fs.readFileSync(path.join(repoRoot, "overlays/pi-agent/default.nix"), "utf8");
  assert.doesNotMatch(overlay, /PI_AGENT_TASK_4_10_BACKGROUND_PIPE/);
});
