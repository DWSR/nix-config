import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderFreeEnvironment } from "./fixtures/extension-manifest/subprocess-environment.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const probePath = path.join(testsDir, "fixtures/plan-integration/runtime-probe.mjs");
const mcpServerFixture = path.join(testsDir, "fixtures/mcpproxy-server.mjs");
const fakePiFixture = path.join(testsDir, "fixtures/subagents/fake-pi.mjs");
const expectedExtensionOrder = [
  "agentmemory",
  "mcp",
  "subagents",
  "plan",
  "timestamps",
  "bashTimeout",
  "questions",
  "codeIntelligence",
  "backgroundTasks",
];
const expectedPlanTools = [
  "read",
  "grep",
  "find",
  "ls",
  "plan_mode_question",
  "plan_mode_complete",
];
const expectedRegisteredTools = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "memory_health",
  "memory_search",
  "memory_save",
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
  "subagent",
  "subagent_wait",
  "plan_mode_question",
  "plan_mode_complete",
  "ask_user",
  "code_resolve",
  "code_inspect",
  "code_orientation",
  "code_graph",
  "code_find",
  "code_health",
  "code_refactor_plan",
  "code_refactor_apply",
  "bg_start",
  "bg_wait",
  "bg_status",
  "bg_logs",
  "bg_send",
  "bg_kill",
  "subagent_supervisor",
  "intercom",
];
const expectedNormalTools = expectedRegisteredTools.filter(
  (name) => !["grep", "find", "ls", "plan_mode_question", "plan_mode_complete"].includes(name),
);
const expectedDeniedTools = [
  "bash",
  "write",
  "bg_start",
  "subagent",
  "call_tool_write",
  "call_tool_destructive",
  "code_refactor_apply",
];
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

let runtimePaths;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-plan-integration-tests";
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

function waitForChildMessage(child, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for MCP fixture"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`MCP fixture exited before readiness: ${code ?? signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function startMcpServer(environment) {
  const runtime = buildRuntimePaths();
  const serverModule = path.join(
    runtime.extensions,
    "lib/node_modules/@modelcontextprotocol/server/dist/index.mjs",
  );
  const child = childProcess.fork(mcpServerFixture, [], {
    cwd: repoRoot,
    env: {
      ...environment,
      PI_AGENT_MCP_SERVER_MODULE: serverModule,
      PI_AGENT_MCP_FIXTURE_VARIANT: "exact",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const ready = await waitForChildMessage(child, (message) => message?.type === "ready");
    assert.equal(Number.isInteger(ready.port), true, stderr);
    return { child, port: ready.port, stderr: () => stderr };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function snapshotMcpServer(server) {
  server.child.send({ type: "snapshot" });
  return waitForChildMessage(server.child, (message) => message?.type === "snapshot");
}

async function stopMcpServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.send({ type: "shutdown" });
  await waitForChildMessage(server.child, (message) => message?.type === "stopped").catch(() => {
    server.child.kill("SIGKILL");
  });
}

function runProbe(runtime, server, environment) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [probePath, runtime.pi, runtime.extensions, String(server.port), fakePiFixture],
      {
        cwd: repoRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_200_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Plan integration probe exited ${code ?? signal}:\n${stdout}\n${stderr}`));
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      try {
        assert.ok(lines.length > 0, `Plan integration probe emitted no report:\n${stderr}`);
        resolve({ report: JSON.parse(lines.at(-1)), stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function assertPlanSnapshot(snapshot, label) {
  assert.deepEqual(snapshot.activeTools, expectedPlanTools, `${label} active tools`);
  assert.deepEqual(snapshot.modelTools, expectedPlanTools, `${label} model tools`);
}

function assertNormalSnapshot(snapshot, label) {
  assert.deepEqual(snapshot.activeTools, expectedNormalTools, `${label} active tools`);
  assert.deepEqual(snapshot.modelTools, expectedNormalTools, `${label} model tools`);
}

function assertDenials(denials, label) {
  assert.deepEqual(denials.map(({ toolName }) => toolName), expectedDeniedTools, label);
  for (const denial of denials) {
    assert.equal(denial.block, true, `${label}: ${denial.toolName} was not blocked`);
    assert.match(denial.reason, /Plan mode denied .* before execution\./i, label);
    assert.match(denial.reason, new RegExp(denial.toolName, "i"), label);
  }
}

function assertNormalGuards(guards, label) {
  assert.ok(Array.isArray(guards), `${label}: missing guard results`);
  assert.deepEqual(guards.map(({ toolName }) => toolName), expectedDeniedTools, label);
  for (const guard of guards) {
    assert.notEqual(guard.block, true, `${label}: ${guard.toolName} remained blocked`);
  }
}

test("assembled manifest enforces the complete cooperative Plan workflow before effects", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const subprocessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-integration-process-"));
  const environment = { ...createProviderFreeEnvironment(subprocessRoot) };
  delete environment.FORCE_COLOR;
  const server = await startMcpServer(environment);
  try {
    const { report, stderr } = await runProbe(runtime, server, environment);
    const diagnostics = stderr.trim().split("\n").filter(Boolean);
    assert.equal(
      diagnostics.every((line) => (
        line.startsWith("[MCP-UI] MCP: direct tools frozen after initial sync")
          && line.endsWith("use mcp({ connect: \"server\" }) to rediscover")
      )),
      true,
      stderr,
    );
    assert.deepEqual(report.extensionOrder, expectedExtensionOrder);
    assert.deepEqual(report.registeredTools, expectedRegisteredTools);
    assertNormalSnapshot(report.normal, "normal");
    assertPlanSnapshot(report.plan, "Plan");
    assertPlanSnapshot(report.resumedPlanning, "resumed Plan");
    assertNormalSnapshot(report.invalidFallback, "invalid-state fallback");
    assertNormalSnapshot(report.missingFallback, "missing-state fallback");

    assertDenials(report.plan.denials, "Plan denials");
    assertDenials(report.resumedPlanning.denials, "resumed Plan denials");
    assert.equal(report.completion.phase, "awaiting-approval");
    assert.equal(report.completion.presentation.includes("Proposed Plan"), true);
    assert.equal(report.completion.notification.includes("ready for approval"), true);
    assert.deepEqual(report.completion.activeTools, expectedPlanTools);
    assert.deepEqual(report.resumedAwaitingApproval.activeTools, expectedPlanTools);
    assert.equal(report.resumedAwaitingApproval.phase, "awaiting-approval");
    assert.deepEqual(report.approval.activeTools, expectedNormalTools);
    assert.deepEqual(report.approval.modelTools, expectedNormalTools);
    assert.equal(report.approval.phase, "approved");
    assertNormalSnapshot(report.resumedApproved, "resumed approved");
    assert.equal(report.resumedApproved.phase, "approved");
    assert.deepEqual(report.explicitExit.activeTools, expectedNormalTools);
    assert.equal(report.explicitExit.phase, "normal");
    assert.deepEqual(report.cancellation.activeTools, expectedNormalTools);
    assert.equal(report.cancellation.phase, "normal");
    assert.deepEqual(report.resumedNormal.activeTools, expectedNormalTools);
    assert.equal(report.resumedNormal.phase, "normal");
    assert.deepEqual(report.unavailableRestoration.activeTools, expectedNormalTools);
    assert.match(report.unavailableRestoration.notification, /unavailable.*task_4_13_unavailable_tool/i);
    assert.equal(report.invalidFallback.phase, "normal");
    assert.match(report.invalidFallback.notification, /invalid.*not restored.*normal mode/i);
    assertNormalGuards(report.invalidFallback.guards, "invalid-state fallback guards");
    assert.equal(report.missingFallback.phase, "normal");
    assert.match(report.missingFallback.notification, /unavailable.*not restored.*normal mode/i);
    assertNormalGuards(report.missingFallback.guards, "missing-state fallback guards");

    assert.deepEqual(report.effects.executionAttempts, []);
    assert.deepEqual(report.effects.files, []);
    assert.deepEqual(report.effects.subagentLaunches, []);
    assert.equal(report.effects.refactorUnchanged, true);
    assert.deepEqual(report.extensionErrors, []);

    const mcpSnapshot = await snapshotMcpServer(server);
    assert.deepEqual(
      mcpSnapshot.activities.filter(({ kind }) => kind === "tool-call" || kind === "upstream-call"),
      [],
    );
  } finally {
    await stopMcpServer(server);
    fs.rmSync(subprocessRoot, { recursive: true, force: true });
  }
});
