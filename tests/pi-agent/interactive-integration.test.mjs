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
const probePath = path.join(testsDir, "fixtures/interactive-integration/runtime-probe.mjs");
const mcpServerFixture = path.join(testsDir, "fixtures/mcpproxy-server.mjs");
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
const reviewTools = ["read", "grep", "find", "ls"];
const requiredRegisteredTools = [
  "bash",
  "write",
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
  "ask_user",
  "code_refactor_plan",
  "code_refactor_apply",
  "bg_start",
  "bg_wait",
  "bg_logs",
  "bg_send",
  "plan_mode_question",
  "plan_mode_complete",
];
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
const probeTimeoutMs = 1_200_000;
const cleanupProbeIntervalMs = 25;
const cleanupStableSamples = 3;

let runtimePaths;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-interactive-integration-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
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
        ]`),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(outputs.length, 3, `expected Pi, extension, and LSP outputs, got ${outputs.join(", ")}`);
  runtimePaths = {
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, "share/pi-agent/extensions.json"))),
    lsp: outputs.find((output) => fs.existsSync(path.join(output, "bin/typescript-language-server"))),
  };
  for (const [name, output] of Object.entries(runtimePaths)) {
    assert.match(output ?? "", /^\/nix\/store\//, `missing ${name} runtime output`);
  }
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

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(finish, 5_000);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    }
    child.once("exit", finish);
    try {
      child.kill("SIGKILL");
    } catch {
      finish();
    }
  });
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForStableAbsence(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (predicate()) {
      stableSamples = 0;
    } else {
      stableSamples += 1;
      if (stableSamples >= cleanupStableSamples) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, cleanupProbeIntervalMs));
  }
  return false;
}

function initializeProbeCleanupState(statePath) {
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ schemaVersion: 1, phase: "created", groups: [], processes: [], probePid: null })}\n`,
  );
}

function readProbeCleanupState(statePath) {
  try {
    return { state: JSON.parse(fs.readFileSync(statePath, "utf8")), error: undefined };
  } catch (error) {
    return { state: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

function forceKillKnownGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0 || pgid === process.pid) {
    return { sent: false, error: `unsafe process group id: ${String(pgid)}` };
  }
  try {
    process.kill(-pgid, "SIGKILL");
    return { sent: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { sent: false, alreadyGone: true };
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function forceKillKnownProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return { sent: false, error: `unsafe process id: ${String(pid)}` };
  }
  try {
    process.kill(pid, "SIGKILL");
    return { sent: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { sent: false, alreadyGone: true };
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function cleanupProbeProcesses(statePath, probePid, writeState = fs.writeFileSync) {
  const { state, error: stateError } = readProbeCleanupState(statePath);
  const groups = [...new Set(state?.groups ?? [])];
  const processes = [...new Set(state?.processes ?? [])];
  const groupSignals = groups.map((pgid) => ({ pgid, ...forceKillKnownGroup(pgid) }));
  const processSignals = processes.map((pid) => ({ pid, ...forceKillKnownProcess(pid) }));
  const probeSignal = probePid === undefined
    ? { pid: undefined, sent: false }
    : { pid: probePid, ...forceKillKnownProcess(probePid) };
  const groupResults = await Promise.all(groups.map(async (pgid, index) => ({
    ...groupSignals[index],
    gone: await waitForStableAbsence(() => processGroupExists(pgid)),
  })));
  const processResults = await Promise.all(processes.map(async (pid, index) => ({
    ...processSignals[index],
    gone: await waitForStableAbsence(() => processExists(pid)),
  })));
  const probeGone = probePid === undefined
    ? true
    : await waitForStableAbsence(() => processExists(probePid));
  const probeCleanupReported = state?.probeCleanup !== undefined;
  const probeCleanupOk = !probeCleanupReported || state.probeCleanup.ok === true;
  const cleanup = {
    ok: !stateError
      && groupResults.every(({ gone, error: signalError }) => gone && !signalError)
      && processResults.every(({ gone, error: signalError }) => gone && !signalError)
      && probeGone
      && probeCleanupOk,
    parentOwned: true,
    stateError,
    probeCleanup: state?.probeCleanup ?? { reported: false },
    probeCleanupReported,
    groups: groupResults,
    processes: processResults,
    probe: { ...probeSignal, gone: probeGone },
  };
  writeState(statePath, `${JSON.stringify({ ...state, phase: "parent-cleaned", parentCleanup: cleanup })}\n`);
  return cleanup;
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
    await terminateChild(child);
    throw error;
  }
}

async function stopMcpServer(server) {
  if (!server?.child) return;
  try {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.send({ type: "shutdown" });
      await waitForChildMessage(server.child, (message) => message?.type === "stopped");
    }
  } catch {
    // The final termination path below handles an unresponsive fixture.
  } finally {
    await terminateChild(server.child);
  }
}

async function snapshotMcpServer(server) {
  server.child.send({ type: "snapshot" });
  return waitForChildMessage(server.child, (message) => message?.type === "snapshot");
}

function runProbe(runtime, server, environment, subprocessRoot, options = {}) {
  return new Promise((resolve, reject) => {
    const probeRoot = path.join(subprocessRoot, "interactive-probe-root");
    const cleanupStatePath = path.join(subprocessRoot, "interactive-probe-cleanup.json");
    fs.mkdirSync(probeRoot, { recursive: true });
    initializeProbeCleanupState(cleanupStatePath);
    const child = childProcess.spawn(
      process.execPath,
      [probePath, runtime.pi, runtime.extensions, String(server.port), runtime.lsp],
      {
        cwd: repoRoot,
        env: {
          ...environment,
          ...(options.mode ? { PI_AGENT_INTERACTIVE_PROBE_MODE: options.mode } : {}),
          PI_AGENT_INTERACTIVE_CLEANUP_FILE: cleanupStatePath,
          PI_AGENT_INTERACTIVE_ROOT: probeRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? probeTimeoutMs);
    const finish = async (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const writeState = options.forceCleanupStateWriteError
        ? () => { throw new Error("forced cleanup-state write failure"); }
        : fs.writeFileSync;
      const cleanup = await cleanupProbeProcesses(cleanupStatePath, child.pid, writeState);
      if (!cleanup.ok) {
        const error = new Error(`interactive integration cleanup failed: ${JSON.stringify(cleanup)}\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        reject(error);
        return;
      }
      if (spawnError) {
        spawnError.cleanup = cleanup;
        reject(spawnError);
        return;
      }
      if (timedOut) {
        const error = new Error(`interactive integration probe timed out after ${options.timeoutMs ?? probeTimeoutMs}ms:\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`interactive integration probe exited ${code ?? signal}:\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        reject(error);
        return;
      }
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        assert.ok(lines.length > 0, `interactive integration probe emitted no report:\n${stderr}`);
        resolve({ report: JSON.parse(lines.at(-1)), stderr, cleanup });
      } catch (error) {
        error.cleanup = cleanup;
        reject(error);
      }
    };
    const handleFinish = (...args) => { finish(...args).catch(reject); };
    child.once("error", (error) => { handleFinish(undefined, undefined, error); });
    child.once("exit", (code, signal) => { handleFinish(code, signal); });
  });
}

function failureProbeRuntime() {
  return { pi: process.execPath, extensions: process.execPath, lsp: process.execPath };
}

async function runFailureProbe(options) {
  const subprocessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interactive-integration-failure-"));
  const environment = createProviderFreeEnvironment(subprocessRoot);
  try {
    return await runProbe(failureProbeRuntime(), { port: 1 }, environment, subprocessRoot, options);
  } finally {
    fs.rmSync(subprocessRoot, { recursive: true, force: true });
  }
}

test("fast probe preserves probe-owned cleanup registrations for parent cleanup", async () => {
  const result = await runFailureProbe({ mode: "fast" });
  assert.equal(result.report.mode, "fast");
  assert.ok(result.cleanup.groups.length > 0, "parent cleanup lost registered process groups");
  assert.ok(result.cleanup.processes.length > 0, "parent cleanup lost registered PIDs");
  assert.equal(result.cleanup.groups.every(({ gone }) => gone), true);
  assert.equal(result.cleanup.processes.every(({ gone }) => gone), true);
});

test("timeout probe kills the probe and registered descendants to stable absence", { timeout: 10_000 }, async () => {
  await assert.rejects(
    runFailureProbe({ mode: "timeout", timeoutMs: 100 }),
    (error) => {
      assert.match(error.message, /timed out after 100ms/);
      assert.equal(error.cleanup.ok, true, JSON.stringify(error.cleanup));
      assert.ok(error.cleanup.groups.length > 0, "timeout cleanup lost registered process groups");
      assert.ok(error.cleanup.processes.length > 0, "timeout cleanup lost registered PIDs");
      assert.equal(error.cleanup.groups.every(({ gone }) => gone), true);
      assert.equal(error.cleanup.processes.every(({ gone }) => gone), true);
      assert.equal(error.cleanup.probe.gone, true);
      return true;
    },
  );
});

test("cleanup-state write failures reject without an unhandled rejection or hang", { timeout: 10_000 }, async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await Promise.race([
      runFailureProbe({ mode: "fast", forceCleanupStateWriteError: true })
        .then(() => ({ status: "resolved" }), (error) => ({ status: "rejected", error })),
      new Promise((resolve) => setTimeout(() => resolve({ status: "hung" }), 2_000)),
    ]);
    assert.equal(result.status, "rejected", `cleanup-state write failure ${result.status}`);
    assert.match(result.error.message, /forced cleanup-state write failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("all managed interactive extensions share one Pi session without collisions or leaks", { timeout: 1_200_000 }, async () => {
  let server;
  let subprocessRoot;
  try {
    const runtime = buildRuntimePaths();
    subprocessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interactive-integration-process-"));
    const environment = createProviderFreeEnvironment(subprocessRoot);
    delete environment.FORCE_COLOR;
    server = await startMcpServer(environment);
    const { report, cleanup } = await runProbe(runtime, server, environment, subprocessRoot);
    assert.ok(cleanup, "interactive probe did not return parent-owned cleanup evidence");
    assert.equal(cleanup.ok, true, `interactive probe cleanup failed: ${JSON.stringify(cleanup)}`);
    assert.equal(cleanup.parentOwned, true);
    assert.equal(cleanup.probeCleanup.ok, true, `probe cleanup failed: ${JSON.stringify(cleanup)}`);
    assert.deepEqual(report.extensionOrder, expectedExtensionOrder);
    for (const name of requiredRegisteredTools) {
      assert.equal(report.registeredTools.includes(name), true, `missing registered tool: ${name}`);
    }
    assert.equal(new Set(report.registeredTools).size, report.registeredTools.length);
    assert.deepEqual(report.planTools, expectedPlanTools);
    assert.deepEqual(report.reviewTools, reviewTools);
    assert.deepEqual(report.planDeniedTools, expectedDeniedTools);
    assert.equal(report.planState.phase, "planning");
    assert.equal(report.planCompletion.phase, "awaiting-approval");
    assert.equal(report.planApproval.phase, "approved");
    assert.equal(report.resumedPlanState.phase, "planning");
    assert.deepEqual(report.resumedPlanTools, expectedPlanTools);
    assert.deepEqual(report.resumedRestoredTools, report.normalTools);
    assert.equal(report.resumedUnavailableName, "combined_unavailable_tool");
    assert.deepEqual(report.timestampInitial, report.timestampResumed);
    assert.ok(report.timestampInitial.length > 0, "fresh session persisted no timestamp entries");
    assert.ok(report.timestampInitialPersisted.length > 0, "fresh session persisted no timestamp file entries");
    assert.ok(report.timestampInitialRendered.length > 0, "fresh session rendered no timestamp entries");
    assert.ok(report.timestampResumed.length > 0, "resumed session persisted no timestamp entries");
    assert.ok(report.timestampResumedPersisted.length > 0, "resumed session persisted no timestamp file entries");
    assert.ok(report.timestampResumedRendered.length > 0, "resumed session rendered no timestamp entries");
    assert.equal(report.timestampContextPolluted, false);
    assert.ok(report.modelContextSnapshotCount >= 5, "not every interactive model turn was captured");
    assert.equal(report.timestampContextSnapshotCount, 0, "a model context snapshot contains timestamp text");
    assert.equal(report.questionCancelled, true);
    assert.equal(report.bashTimedOut, true);
    assert.equal(report.backgroundPipeCompleted, true);
    assert.equal(report.ptyStopped, true);
    assert.equal(report.ptyGroupLeaked, false);
    assert.ok(Number.isInteger(report.timeoutDescendant.commandPid));
    assert.ok(Number.isInteger(report.timeoutDescendant.pgid));
    assert.ok(Number.isInteger(report.timeoutDescendant.descendantPid));
    assert.equal(report.timeoutDescendant.pgid, report.timeoutDescendant.commandPid);
    assert.equal(report.timeoutDescendantCleanup.groupGone, true);
    assert.equal(report.timeoutDescendantCleanup.commandGone, true);
    assert.equal(report.timeoutDescendantCleanup.descendantGone, true);
    assert.equal(report.timeoutDescendantCleanup.stableAbsence, true);
    assert.equal(report.timeoutDescendantContinued, false);
    assert.equal(report.lspReady, true);
    assert.equal(report.refactorPreviewWrote, false);
    assert.equal(report.refactorApplyWrote, true);
    assert.equal(report.refactorApplyBlockedInPlan, true);
    assert.equal(report.refactorApplyBlockedInReview, true);
    assert.equal(report.lspGroupsLeaked, false);
    assert.equal(report.lspDescendantsLeaked, false);
    assert.deepEqual(report.unexpectedMutationExecutions, []);
    assert.deepEqual(report.extensionErrors, []);
    assert.equal(report.toolCollision, false);
    const mcpSnapshot = await snapshotMcpServer(server);
    assert.deepEqual(
      mcpSnapshot.activities.filter(({ kind }) => kind === "tool-call" || kind === "upstream-call"),
      [],
    );
  } finally {
    await stopMcpServer(server);
    if (subprocessRoot) fs.rmSync(subprocessRoot, { recursive: true, force: true });
  }
});
