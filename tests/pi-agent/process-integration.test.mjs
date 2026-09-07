import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const probePath = path.join(testsDir, "fixtures/process-integration/runtime-probe.mjs");
const treeWorkerPath = path.join(testsDir, "fixtures/process-integration/tree-worker.mjs");
const childAgentPath = path.join(testsDir, "fixtures/subagents/fake-pi.mjs");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

let runtimePaths;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-process-integration-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      profilePackage = import (source + "/tests/pi-agent/fixtures/profile-catalog.nix") {
        fixture = "package";
        repoSource = source;
        inherit flake;
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
          pkgs.nono
          pkgs.pi-agent
          profilePackage
          pkgs.pi-agent-extensions
          (import (source + "/tests/pi-agent/fixtures/code-intelligence.nix") { repoRoot = source; }).validServer
        ]`),
      ],
      commandOptions,
    )
    .trim()
    .split("\n")
    .filter(Boolean);
  runtimePaths = {
    nono: path.join(outputs.find((output) => fs.existsSync(path.join(output, "bin/nono"))) ?? "", "bin/nono"),
    pi: outputs.find((output) => fs.existsSync(path.join(output, "bin/pi"))),
    profile: outputs.find((output) => fs.existsSync(path.join(output, "share/pi-agent/nono/profiles/pi-managed.json"))),
    extensions: outputs.find((output) => fs.existsSync(path.join(output, "share/pi-agent/extensions.json"))),
    lsp: outputs.find((output) => fs.existsSync(path.join(output, "bin/typescript-language-server"))),
  };
  for (const [name, output] of Object.entries(runtimePaths)) {
    assert.match(output ?? "", /^\/nix\/store\//, `missing ${name} runtime output`);
  }
  return runtimePaths;
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

async function waitForStableAbsence(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (predicate()) stableSamples = 0;
    else if (++stableSamples >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${label} did not reach stable absence`);
}

function makeSandbox() {
  const stateRoot = path.join(os.homedir(), ".local/state/opencode");
  fs.mkdirSync(stateRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(stateRoot, "pi-agent-process-integration-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "private-tmp");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const cleanupStatePath = path.join(home, ".pi/agent", "process-integration-cleanup.json");
  const environment = {
    ...process.env,
    CAVEMEM_DATA_DIR: path.join(data, "cavemem"),
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NONO_NO_SAVE_PROMPT: "1",
    NONO_NO_UPDATE_CHECK: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PI_AGENT_BASH_TIMEOUT_MS: "250",
    PI_AGENT_LAUNCH_ID: "77777777-7777-4777-8777-777777777777",
    PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
    SHOPIFY_PI_TOKEN: "process-integration-provider-sentinel",
    SHELL: process.env.SHELL ?? "/bin/sh",
    TMPDIR: tmp,
    USER: "pi-agent-process-fixture",
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: path.join(root, "state"),
  };
  for (const directory of [
    home,
    tmp,
    data,
    workspace,
    environment.CAVEMEM_DATA_DIR,
    environment.PI_CODING_AGENT_DIR,
    path.join(tmp, "pi-agent"),
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_STATE_HOME,
  ]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(cleanupStatePath, `${JSON.stringify({ schemaVersion: 1, phase: "created", groups: [], processes: [], registrations: [], probePid: null })}\n`);
  return { cleanupStatePath, environment, root, workspace };
}

function startProbe(runtime, sandbox, probe, childAgent, evidencePath, mode) {
  return childProcess.spawn(
    runtime.nono,
    [
      "run",
      "--silent",
      "--no-audit",
      "--no-rollback",
      "--profile",
      path.join(runtime.profile, "share/pi-agent/nono/profiles/pi-managed.json"),
      "--allow-cwd",
      "--",
      process.execPath,
      probe,
      runtime.pi,
      runtime.extensions,
      path.join(runtime.lsp, "bin/typescript-language-server"),
      childAgent,
      evidencePath,
      ...(mode ? [mode] : []),
    ],
    {
      cwd: sandbox.workspace,
      env: sandbox.environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function readCleanupState(statePath) {
  try {
    return { state: JSON.parse(fs.readFileSync(statePath, "utf8")), error: undefined };
  } catch (error) {
    return { state: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

function readLiveRegistration(sandbox) {
  const { state } = readCleanupState(sandbox.cleanupStatePath);
  const marker = fs.readdirSync(sandbox.workspace)
    .filter((entry) => entry.endsWith(".ready"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sandbox.workspace, entry), "utf8"));
      } catch {
        return undefined;
      }
    })
    .find((entry) => Number.isInteger(entry?.leaderPid));
  const pgid = marker?.leaderPid;
  const registeredProbePid = state?.probePid;
  const persistedRegistration = (state?.registrations ?? []).find((registration) => (
    registration?.pgid === pgid
    && registration?.leaderPid === marker?.leaderPid
    && registration?.descendantPid === marker?.descendantPid
  ));
  const persisted = state?.phase === "running"
    && Number.isInteger(registeredProbePid)
    && state.groups?.includes(pgid)
    && state.processes?.includes(marker?.leaderPid)
    && state.processes?.includes(marker?.descendantPid)
    && persistedRegistration !== undefined;
  if (!persisted || !Number.isInteger(pgid) || !Number.isInteger(marker?.descendantPid) || !Number.isInteger(registeredProbePid)) return undefined;
  return {
    persisted,
    registeredGroups: state.groups,
    registeredProcesses: state.processes,
    pgid,
    leaderPid: marker.leaderPid,
    descendantPid: marker.descendantPid,
    probePid: registeredProbePid,
    groupAlive: processGroupExists(pgid),
    leaderAlive: processExists(marker.leaderPid),
    descendantAlive: processExists(marker.descendantPid),
    probeAlive: processExists(registeredProbePid),
  };
}

function safeSignalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0 || pgid === process.pid) {
    return { pgid, signal, sent: false, error: "unsafe process group id" };
  }
  try {
    process.kill(-pgid, signal);
    return { pgid, signal, sent: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { pgid, signal, sent: false, alreadyGone: true };
    return { pgid, signal, sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function safeSignalProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return { pid, signal, sent: false, error: "unsafe process id" };
  }
  try {
    process.kill(pid, signal);
    return { pid, signal, sent: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { pid, signal, sent: false, alreadyGone: true };
    return { pid, signal, sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function cleanupRegisteredProcesses(statePath, probePid, markerDirectory) {
  const { state, error: stateError } = readCleanupState(statePath);
  const markerGroups = [];
  const markerProcesses = [];
  for (const entry of fs.readdirSync(markerDirectory)) {
    if (!entry.endsWith(".ready")) continue;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(markerDirectory, entry), "utf8"));
      if (Number.isInteger(marker.leaderPid)) markerGroups.push(marker.leaderPid);
      if (Number.isInteger(marker.leaderPid)) markerProcesses.push(marker.leaderPid);
      if (Number.isInteger(marker.descendantPid)) markerProcesses.push(marker.descendantPid);
    } catch {
      // A partial fixture marker is ignored; the persisted registration remains authoritative.
    }
  }
  const persistedGroups = (state?.registrations ?? [])
    .map(({ pgid }) => pgid)
    .filter((pgid) => Number.isInteger(pgid));
  const persistedProcesses = (state?.registrations ?? []).flatMap(({ leaderPid, descendantPid, extraPids = [] }) => [
    leaderPid,
    descendantPid,
    ...extraPids,
  ]).filter((pid) => Number.isInteger(pid));
  const groups = [...new Set([...(state?.groups ?? []), ...persistedGroups, ...markerGroups])];
  const processes = [...new Set([...(state?.processes ?? []), ...persistedProcesses, ...markerProcesses])];
  const probePids = [...new Set([state?.probePid, probePid].filter((pid) => Number.isInteger(pid)))];
  const signals = [
    ...groups.map((pgid) => safeSignalGroup(pgid, "SIGTERM")),
    ...processes.map((pid) => safeSignalProcess(pid, "SIGTERM")),
    ...probePids.map((pid) => safeSignalProcess(pid, "SIGKILL")),
  ];
  const waitGroups = async (timeoutMs) => Promise.all(groups.map(async (pgid) => {
    try {
      await waitForStableAbsence(() => processGroupExists(pgid), `registered group ${pgid}`, timeoutMs);
      return { pgid, gone: true };
    } catch (error) {
      return { pgid, gone: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const waitProcesses = async (timeoutMs) => Promise.all(processes.map(async (pid) => {
    try {
      await waitForStableAbsence(() => processExists(pid), `registered PID ${pid}`, timeoutMs);
      return { pid, gone: true };
    } catch (error) {
      return { pid, gone: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const waitProbes = async (timeoutMs) => Promise.all(probePids.map(async (pid) => {
    try {
      await waitForStableAbsence(() => processExists(pid), `probe PID ${pid}`, timeoutMs);
      return { pid, gone: true };
    } catch (error) {
      return { pid, gone: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  let groupResults = await waitGroups(750);
  let processResults = await waitProcesses(750);
  let probeResults = await waitProbes(750);
  const survivors = () => ({
    groups: groups.filter((pgid) => processGroupExists(pgid)),
    processes: processes.filter((pid) => processExists(pid)),
    probes: probePids.filter((pid) => processExists(pid)),
  });
  let remaining = survivors();
  if (remaining.groups.length > 0 || remaining.processes.length > 0 || remaining.probes.length > 0) {
    signals.push(
      ...remaining.groups.map((pgid) => safeSignalGroup(pgid, "SIGKILL")),
      ...remaining.processes.map((pid) => safeSignalProcess(pid, "SIGKILL")),
      ...remaining.probes.map((pid) => safeSignalProcess(pid, "SIGKILL")),
    );
    groupResults = await waitGroups(5_000);
    processResults = await waitProcesses(5_000);
    probeResults = await waitProbes(5_000);
    remaining = survivors();
  }
  const cleanup = {
    ok: !stateError
      && groupResults.every(({ gone }) => gone)
      && processResults.every(({ gone }) => gone)
      && probeResults.every(({ gone }) => gone)
      && remaining.groups.length === 0
      && remaining.processes.length === 0
      && remaining.probes.length === 0,
    parentOwned: true,
    stateError,
    persistedDiscovery: { groups: persistedGroups, processes: persistedProcesses },
    markerDiscovery: { groups: markerGroups, processes: markerProcesses },
    signals,
    groups: groupResults,
    processes: processResults,
    probes: probeResults,
    survivors: remaining,
  };
  fs.writeFileSync(statePath, `${JSON.stringify({ ...state, phase: "parent-cleaned", parentCleanup: cleanup })}\n`);
  return cleanup;
}

function processTable() {
  return childProcess.execFileSync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,command="],
    { encoding: "utf8" },
  ).split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }
      : undefined;
  }).filter(Boolean);
}

function auditProcessIntegration(sandbox) {
  const { state, error: stateError } = readCleanupState(sandbox.cleanupStatePath);
  const groups = [...new Set([
    ...(state?.groups ?? []),
    ...(state?.registrations ?? []).map(({ pgid }) => pgid),
  ].filter((pgid) => Number.isInteger(pgid)))];
  const pids = [...new Set([
    ...(state?.processes ?? []),
    ...(state?.registrations ?? []).flatMap(({ leaderPid, descendantPid, extraPids = [] }) => [
      leaderPid,
      descendantPid,
      ...extraPids,
    ]),
    state?.probePid,
  ].filter((pid) => Number.isInteger(pid)))];
  const rows = processTable();
  const processProbeCommands = [
    "process-runtime-probe.mjs",
    "tree-worker.mjs",
    "fake-pi/bin/pi.mjs",
    ".task-4-9-descendant-observation.json",
  ];
  const survivors = rows.filter(({ pid, command }) => (
    pids.includes(pid)
    || (command.includes(sandbox.root) && processProbeCommands.some((fragment) => command.includes(fragment)))
  ));
  return {
    ok: !stateError
      && groups.every((pgid) => !processGroupExists(pgid))
      && pids.every((pid) => !processExists(pid))
      && survivors.length === 0,
    stateError,
    groups,
    pids,
    liveGroups: groups.filter((pgid) => processGroupExists(pgid)),
    livePids: pids.filter((pid) => processExists(pid)),
    survivors,
  };
}

function runProbe(runtime, sandbox, evidencePath, mode, timeoutMs = 1_200_000, options = {}) {
  return new Promise((resolve, reject) => {
    const probe = path.join(sandbox.workspace, "process-runtime-probe.mjs");
    const childPackage = path.join(sandbox.workspace, "fake-pi");
    const childAgent = path.join(childPackage, "bin/pi.mjs");
    const treeWorker = path.join(sandbox.workspace, "tree-worker.mjs");
    fs.copyFileSync(probePath, probe);
    fs.mkdirSync(path.dirname(childAgent), { recursive: true });
    fs.copyFileSync(childAgentPath, childAgent);
    fs.writeFileSync(
      path.join(childPackage, "package.json"),
      `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", bin: { pi: "bin/pi.mjs" } })}\n`,
    );
    fs.copyFileSync(treeWorkerPath, treeWorker);
    const child = startProbe(runtime, sandbox, probe, childAgent, evidencePath, mode);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let liveRegistration;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const registrationTimer = options.interruptAfterLiveRegistration
      ? setInterval(() => {
        try {
          const registration = readLiveRegistration(sandbox);
          if (registration && registration.groupAlive && registration.leaderAlive && registration.descendantAlive) {
            liveRegistration = registration;
            interrupted = true;
            clearInterval(registrationTimer);
            child.kill("SIGKILL");
          }
        } catch {
          // Continue polling until the parent observes a complete live registration.
        }
      }, 25)
      : undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* exit handler performs finalization */ }
    }, timeoutMs);
    const finish = async (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (registrationTimer) clearInterval(registrationTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      const cleanup = await cleanupRegisteredProcesses(sandbox.cleanupStatePath, child.pid, sandbox.workspace);
      const audit = auditProcessIntegration(sandbox);
      cleanup.audit = audit;
      if (!cleanup.ok || !audit.ok) {
        const error = new Error(`process integration cleanup failed: ${JSON.stringify({ cleanup, audit })}\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        error.audit = audit;
        reject(error);
        return;
      }
      if (spawnError) {
        spawnError.cleanup = cleanup;
        spawnError.audit = audit;
        reject(spawnError);
        return;
      }
      if (timedOut) {
        const error = new Error(`process integration probe timed out after ${timeoutMs}ms:\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        error.audit = audit;
        reject(error);
        return;
      }
      if (interrupted) {
        const error = new Error(`process integration probe interrupted after live registration:\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        error.audit = audit;
        error.liveRegistration = liveRegistration;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`process integration probe exited ${code ?? signal}:\n${stdout}\n${stderr}`);
        error.cleanup = cleanup;
        reject(error);
        return;
      }
      try {
        const report = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1));
        resolve({ report, cleanup, stderr });
      } catch (error) {
        error.cleanup = cleanup;
        reject(error);
      }
    };
    child.once("error", (error) => { finish(undefined, undefined, error).catch(reject); });
    child.once("exit", (code, signal) => { finish(code, signal).catch(reject); });
  });
}

test("real Pi extension runtime supervises every process group under pi-managed nono", { timeout: 1_200_000 }, async () => {
  const runtime = buildRuntimePaths();
  const sandbox = makeSandbox();
  const evidencePath = path.join(sandbox.workspace, "process-evidence.json");
  try {
    const { report, cleanup, stderr } = await runProbe(runtime, sandbox, evidencePath, undefined);
    assert.equal(cleanup.ok, true, `${stderr}\n${JSON.stringify(cleanup)}`);
    assert.equal(cleanup.parentOwned, true);
    assert.equal(report.sandbox.profile, "pi-managed");
    assert.equal(report.runtime.kind, "pi-coding-agent");
    assert.deepEqual(report.runtime.operations, [
      "subagent.abort",
      "code_health",
      "bg_kill",
      "bg_send",
      "session_shutdown",
    ]);
    assert.deepEqual(report.paths.map(({ name }) => name), [
      "foreground-child-cancellation",
      "lsp-session-shutdown",
      "background-replacement",
      "pty-graceful",
      "pty-forced",
      "background-session-shutdown",
      "lsp-session-replacement",
    ]);
    assert.equal(report.paths.every(({ registered, cleanup: result }) => (
      registered.kind
      && Number.isInteger(registered.pgid)
      && Number.isInteger(registered.leaderPid)
      && Number.isInteger(registered.descendantPid)
      && result.groupGone
      && result.leaderGone
      && result.descendantGone
      && result.extraPidsGone
      && result.survivors.length === 0
    )), true, JSON.stringify(report.paths));
    assert.equal(report.paths.find(({ name }) => name === "pty-graceful").cleanup.finalSignal, "SIGTERM");
    assert.equal(report.paths.find(({ name }) => name === "pty-forced").cleanup.finalSignal, "SIGKILL");
    assert.equal(report.replacement.oldGroupGoneBeforeNewTask, true);
    assert.equal(report.sessionExit.allGroupsGone, true);
    assert.equal(report.sessionExit.allPidsGone, true);
    assert.deepEqual(report.emergencyFinalizer.signals.filter(({ sent }) => sent), []);
    assert.equal(report.summary.allOwnedGroupsGone, true);
    assert.equal(report.summary.allOwnedPidsGone, true);
    assert.equal(fs.existsSync(evidencePath), true);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.deepEqual(evidence.runtime.operations, report.runtime.operations);
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("parent finalizer removes a live registered group when the production probe is interrupted", { timeout: 60_000 }, async () => {
  const runtime = buildRuntimePaths();
  const sandbox = makeSandbox();
  const evidencePath = path.join(sandbox.workspace, "process-failure-evidence.json");
  try {
    await assert.rejects(
      runProbe(runtime, sandbox, evidencePath, "hang-after-registration", 30_000, {
        interruptAfterLiveRegistration: true,
      }),
      (error) => {
        assert.match(error.message, /process integration probe interrupted after live registration/);
        assert.equal(error.liveRegistration.persisted, true, JSON.stringify(error.liveRegistration));
        assert.equal(error.liveRegistration.groupAlive, true);
        assert.equal(error.liveRegistration.leaderAlive, true);
        assert.equal(error.liveRegistration.descendantAlive, true);
        assert.equal(error.liveRegistration.probeAlive, true);
        assert.equal(error.cleanup.ok, true, JSON.stringify(error.cleanup));
        assert.ok(error.cleanup.groups.length > 0, "interrupted probe did not register a process group");
        const groupSignals = error.cleanup.signals.filter(({ pgid }) => pgid === error.liveRegistration.pgid);
        assert.deepEqual(groupSignals.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
        assert.equal(groupSignals.every(({ sent }) => sent), true, JSON.stringify(error.cleanup.signals));
        assert.equal(error.cleanup.groups.every(({ gone }) => gone), true);
        assert.equal(error.cleanup.processes.every(({ gone }) => gone), true);
        assert.equal(error.cleanup.probes.every(({ gone }) => gone), true);
        assert.equal(error.cleanup.groups.some(({ pgid, gone }) => pgid === error.liveRegistration.pgid && gone), true);
        assert.equal(error.cleanup.processes.some(({ pid, gone }) => pid === error.liveRegistration.leaderPid && gone), true);
        assert.equal(error.cleanup.processes.some(({ pid, gone }) => pid === error.liveRegistration.descendantPid && gone), true);
        assert.equal(error.cleanup.probes.some(({ pid, gone }) => pid === error.liveRegistration.probePid && gone), true);
        assert.equal(error.cleanup.survivors.groups.length, 0);
        assert.equal(error.cleanup.survivors.processes.length, 0);
        assert.equal(error.cleanup.survivors.probes.length, 0);
        assert.equal(error.cleanup.persistedDiscovery.groups.length, 2, JSON.stringify(error.cleanup.persistedDiscovery));
        assert.equal(error.cleanup.persistedDiscovery.processes.length, 4, JSON.stringify(error.cleanup.persistedDiscovery));
        assert.deepEqual(
          new Set(error.cleanup.groups.map(({ pgid }) => pgid)),
          new Set(error.liveRegistration.registeredGroups),
        );
        assert.deepEqual(
          new Set(error.cleanup.processes.map(({ pid }) => pid)),
          new Set(error.liveRegistration.registeredProcesses),
        );
        for (const pgid of error.liveRegistration.registeredGroups) {
          assert.equal(
            error.cleanup.signals.some(({ pgid: signaledPgid, signal, sent, alreadyGone }) => (
              signaledPgid === pgid && signal === "SIGTERM" && (sent || alreadyGone)
            )),
            true,
            `parent cleanup did not TERM registered group ${pgid}`,
          );
        }
        assert.equal(error.audit.ok, true, JSON.stringify(error.audit));
        assert.deepEqual(error.audit.liveGroups, []);
        assert.deepEqual(error.audit.livePids, []);
        assert.deepEqual(error.audit.survivors, []);
        return true;
      },
    );
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});
