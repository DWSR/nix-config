import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixturePath = path.join(
  testsDir,
  "fixtures/cavemem/storage-full-envelope.json",
);
const patchPath = path.join(
  repoRoot,
  "overlays/cavemem-pi-full-storage-policy-v1.patch",
);
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 900_000,
};

let bundledModules;
let runtimeRoot;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-cavemem-storage-test";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      integrationPatchNames = [
        "cavemem-pi-full-privacy-v1.patch"
        "cavemem-pi-full-storage-policy-v1.patch"
        "cavemem-pi-full-storage-limit-v1.patch"
      ];
      cavememWithStoragePolicy = pkgs.cavemem.overrideAttrs (old: {
        patches =
          builtins.filter
            (patch: !(builtins.elem (builtins.baseNameOf (toString patch)) integrationPatchNames))
            (old.patches or [ ])
          ++ [ (source + "/overlays/cavemem-pi-full-storage-policy-v1.patch") ];
      });
    in
      ${body}
  `;
}

function getRuntimeRoot() {
  runtimeRoot ??= childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          pkgs.buildEnv {
            name = "pi-agent-cavemem-storage-test-runtime";
            paths = [ cavememWithStoragePolicy pkgs.sqlite pkgs.nodejs ];
          }
        `),
      ],
      commandOptions,
    )
    .trim();
  assert.match(runtimeRoot, /^\/nix\/store\//);
  assert.equal(runtimeRoot.includes("\n"), false);
  return runtimeRoot;
}

function cavememPath() {
  return path.join(getRuntimeRoot(), "bin/cavemem");
}

function sqlitePath() {
  return path.join(getRuntimeRoot(), "bin/sqlite3");
}

function dataEnvironment(dataDir, overrides = {}) {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  return {
    ...environment,
    CAVEMEM_DATA_DIR: dataDir,
    CAVEMEM_NO_AUTOSTART: "1",
    NO_COLOR: "1",
    ...overrides,
  };
}

function autostartEnvironment(dataDir, overrides = {}) {
  const environment = dataEnvironment(dataDir, overrides);
  delete environment.CAVEMEM_NO_AUTOSTART;
  return environment;
}

async function withDataDir(operation) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-cavemem-storage-"),
  );
  try {
    return await operation(dataDir);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

function completeSettings(dataDir, overrides = {}) {
  return {
    dataDir,
    workerPort: overrides.workerPort ?? 37777,
    logLevel: "error",
    compression: {
      intensity: "full",
      expandForModel: true,
    },
    embedding: {
      provider: "none",
      model: "storage-policy-none",
      batchSize: 16,
      autoStart: false,
      idleShutdownMs: 60_000,
      ...overrides.embedding,
    },
    search: {
      alpha: 0.5,
      defaultLimit: 20,
    },
    privacy: {
      excludePatterns: [],
      redactSecrets: true,
    },
    ides: {},
  };
}

function writeSettings(dataDir, overrides) {
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    `${JSON.stringify(completeSettings(dataDir, overrides), null, 2)}\n`,
  );
}

function makeFullPayload(marker, sessionId = `storage-${marker}`) {
  const payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  payload.session_id = sessionId;
  payload.toolCallId = `call-${marker}`;
  payload.input.marker = marker;
  payload.output.content.long =
    `${payload.output.content.longSeed}${marker}\n`.repeat(180) +
    payload.output.content.tail;
  delete payload.output.content.longSeed;
  return payload;
}

function expectedFullContent(payload) {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    input: payload.input,
    output: payload.output,
  });
}

function makeControlPayload(marker, sessionId = `storage-${marker}`) {
  return {
    session_id: sessionId,
    tool_name: "Read",
    tool_input: {
      request: `please basically just inspect ${marker} db env cfg`,
      path: "/tmp/storage-policy-control",
    },
    tool_response: {
      message: `I think perhaps ${marker} db env cfg is ready`,
    },
  };
}

function runHook(
  dataDir,
  payload,
  { autoStart = false, environment = {}, full = false } = {},
) {
  const args = ["hook", "run", "post-tool-use", "--ide", "pi"];
  if (full) args.push("--capture-mode", "pi-full-v1");
  return childProcess.spawnSync(cavememPath(), args, {
    encoding: "utf8",
    env: autoStart
      ? autostartEnvironment(dataDir, environment)
      : dataEnvironment(dataDir, environment),
    input: JSON.stringify(payload),
    maxBuffer: 64 * 1024 * 1024,
  });
}

function assertHookSucceeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

function queryRows(dataDir, sql) {
  const result = childProcess.spawnSync(
    sqlitePath(),
    ["-json", path.join(dataDir, "data.db"), sql],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

function executeSql(dataDir, sql) {
  const result = childProcess.spawnSync(
    sqlitePath(),
    [path.join(dataDir, "data.db"), sql],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function observationRows(dataDir) {
  return queryRows(
    dataDir,
    "SELECT id, session_id, kind, content, compressed, intensity, metadata " +
      "FROM observations ORDER BY id",
  );
}

function runCavemem(dataDir, args) {
  const result = childProcess.spawnSync(cavememPath(), args, {
    encoding: "utf8",
    env: dataEnvironment(dataDir),
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function assertExactBytes(actual, expected, label) {
  assert.equal(
    Buffer.from(actual).equals(Buffer.from(expected)),
    true,
    `${label} changed persisted bytes`,
  );
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

async function loadBundledModules() {
  if (bundledModules !== undefined) return bundledModules;
  const dist = path.join(getRuntimeRoot(), "lib/node_modules/cavemem/dist");
  const files = fs
    .readdirSync(dist)
    .filter((name) => /^(?:chunk|server)-.+\.js$/.test(name));
  const modules = await Promise.all(
    files.map((name) => import(pathToFileURL(path.join(dist, name)).href)),
  );
  const core = modules.find(
    (module) =>
      typeof module.MemoryStore === "function" &&
      typeof module.defaultSettings === "object",
  );
  const worker = modules.find(
    (module) => typeof module.buildApp === "function",
  );
  assert.ok(core, "bundled core module was not found");
  assert.ok(worker, "bundled worker module was not found");
  bundledModules = { core, worker };
  return bundledModules;
}

function startMcp(dataDir) {
  const child = childProcess.spawn(cavememPath(), ["mcp"], {
    env: dataEnvironment(dataDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let stderr = "";
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error !== undefined) {
      waiter.reject(new Error(JSON.stringify(message.error)));
    } else {
      waiter.resolve(message.result);
    }
  });
  child.on("exit", (status, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(
        new Error(`cavemem mcp exited ${status ?? signal}: ${stderr.trim()}`),
      );
    }
    pending.clear();
  });

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`cavemem mcp timed out for ${method}: ${stderr.trim()}`),
        );
      }, 10_000);
      pending.set(id, { reject, resolve, timeout });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  return {
    initialize: async () => {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cavemem-storage-test", version: "0.0.0" },
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        })}\n`,
      );
    },
    call: async (name, args) => {
      const result = await request("tools/call", {
        name,
        arguments: args,
      });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      const text = result.content?.find((entry) => entry.type === "text")?.text;
      assert.equal(typeof text, "string");
      return JSON.parse(text);
    },
    close: async () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
        }, 250);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePort() {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  assert.notEqual(address, null);
  const port = address.port;
  await closeServer(server);
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(assertion, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("condition timed out");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function startWorker(dataDir, environment = {}) {
  const child = childProcess.spawn(cavememPath(), ["worker", "run"], {
    env: dataEnvironment(dataDir, environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitForWorkerHealth(port, worker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(
        `worker exited before health check: ${worker.stderr().trim()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = new Error(`worker health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error("worker health check timed out");
}

function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      signal: child.signalCode,
      status: child.exitCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("worker did not fail during startup"));
    }, timeoutMs);
    const onExit = (status, signal) => {
      clearTimeout(timeout);
      resolve({ signal, status });
    };
    child.once("exit", onExit);
  });
}

function runCavememAsync(dataDir, args, timeoutMs = 15_000, environment = {}) {
  const child = childProcess.spawn(cavememPath(), args, {
    env: dataEnvironment(dataDir, environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cavemem ${args.join(" ")} did not exit`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({ signal, status, stderr, stdout });
    });
  });
}

function daemonChildTracker(dataDir, name) {
  const pidPath = path.join(dataDir, `${name}.pid`);
  const preloadPath = path.join(dataDir, `${name}.cjs`);
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function trackedSpawn(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (Array.isArray(args) && args.at(-2) === 'worker' && args.at(-1) === 'run' && child.pid) {
    fs.writeFileSync(process.env.CAVEMEM_TEST_CHILD_PID_PATH, String(child.pid));
  }
  return child;
};
syncBuiltinESMExports();
`,
  );
  return {
    environment: {
      CAVEMEM_TEST_CHILD_PID_PATH: pidPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
        .filter(Boolean)
        .join(" "),
    },
    pid: () => {
      if (!fs.existsSync(pidPath)) return null;
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
  };
}

function daemonChildrenTracker(dataDir, name) {
  const pidPath = path.join(dataDir, `${name}.pids`);
  const preloadPath = path.join(dataDir, `${name}.cjs`);
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function trackedSpawn(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (Array.isArray(args) && args.at(-2) === 'worker' && args.at(-1) === 'run' && child.pid) {
    fs.appendFileSync(process.env.CAVEMEM_TEST_CHILD_PIDS_PATH, String(child.pid) + '\\n');
  }
  return child;
};
syncBuiltinESMExports();
`,
  );
  return {
    environment: {
      CAVEMEM_TEST_CHILD_PIDS_PATH: pidPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
        .filter(Boolean)
        .join(" "),
    },
    pids: () => {
      if (!fs.existsSync(pidPath)) return [];
      return fs
        .readFileSync(pidPath, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    },
  };
}

function autoStartSpawnTracker(dataDir, name) {
  const logPath = path.join(dataDir, `${name}.spawns`);
  const preloadPath = path.join(dataDir, `${name}.cjs`);
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function trackedSpawn(command, args, options) {
  if (Array.isArray(args) && args.at(-2) === 'worker' && args.at(-1) === 'start') {
    fs.appendFileSync(process.env.CAVEMEM_TEST_AUTOSTART_LOG, 'worker-start\\n');
    return { unref() {} };
  }
  return originalSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
`,
  );
  return {
    environment: {
      CAVEMEM_TEST_AUTOSTART_LOG: logPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
        .filter(Boolean)
        .join(" "),
    },
    count: () => {
      if (!fs.existsSync(logPath)) return 0;
      return fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split(/\n+/)
        .filter(Boolean).length;
    },
  };
}

function publicationControl(dataDir, name, mode) {
  const markerPath = path.join(dataDir, `${name}.published`);
  const releasePath = path.join(dataDir, `${name}.release`);
  const preloadPath = path.join(dataDir, `${name}.cjs`);
  const pidPath = path.join(dataDir, "worker.pid");
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalExistsSync = fs.existsSync;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
const waitArray = new Int32Array(new SharedArrayBuffer(4));
let triggered = false;
function isWorkerRun() {
  return process.argv.at(-2) === 'worker' && process.argv.at(-1) === 'run';
}
function afterPublication() {
  if (triggered || !isWorkerRun()) return;
  triggered = true;
  originalWriteFileSync(process.env.CAVEMEM_TEST_PUBLICATION_MARKER, 'published');
  if (${JSON.stringify(mode)} === 'fail') {
    throw new Error('PRIVATE_PUBLICATION_FAILURE_SENTINEL');
  }
  while (!originalExistsSync(process.env.CAVEMEM_TEST_PUBLICATION_RELEASE)) {
    Atomics.wait(waitArray, 0, 0, 20);
  }
}
fs.writeFileSync = function controlledWrite(file, ...args) {
  const result = originalWriteFileSync.call(this, file, ...args);
  if (path.resolve(String(file)) === process.env.CAVEMEM_TEST_WORKER_PID_PATH) {
    afterPublication();
  }
  return result;
};
fs.renameSync = function controlledRename(source, destination) {
  const result = originalRenameSync.call(this, source, destination);
  if (path.resolve(String(destination)) === process.env.CAVEMEM_TEST_WORKER_PID_PATH) {
    afterPublication();
  }
  return result;
};
syncBuiltinESMExports();
`,
  );
  return {
    environment: {
      CAVEMEM_TEST_PUBLICATION_MARKER: markerPath,
      CAVEMEM_TEST_PUBLICATION_RELEASE: releasePath,
      CAVEMEM_TEST_WORKER_PID_PATH: pidPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
    },
    release: () => fs.writeFileSync(releasePath, "release"),
    wait: () =>
      waitFor(() => {
        assert.equal(fs.existsSync(markerPath), true);
      }),
  };
}

function mismatchedReadyIpc(dataDir) {
  const preloadPath = path.join(dataDir, "mismatched-ready-ipc.cjs");
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const originalSend = process.send;
if (typeof originalSend === 'function') {
  process.send = function mismatchedReady(message, ...args) {
    if (
      process.argv.at(-2) === 'worker' &&
      process.argv.at(-1) === 'run' &&
      message &&
      message.type === 'cavemem-worker-ready'
    ) {
      message = { ...message, nonce: '00000000-0000-4000-8000-000000000000' };
    }
    return originalSend.call(this, message, ...args);
  };
}
`,
  );
  return { NODE_OPTIONS: `--require=${preloadPath}` };
}

function signalTracker(dataDir, name) {
  const logPath = path.join(dataDir, `${name}.signals`);
  const preloadPath = path.join(dataDir, `${name}.cjs`);
  fs.writeFileSync(
    preloadPath,
    `'use strict';
const fs = require('node:fs');
const originalKill = process.kill;
process.kill = function trackedKill(pid, signal) {
  if ((signal === 'SIGTERM' || signal === 'SIGKILL') && pid !== process.pid) {
    fs.appendFileSync(process.env.CAVEMEM_TEST_SIGNAL_LOG, String(pid) + ':' + signal + '\\n');
  }
  return originalKill.call(this, pid, signal);
};
`,
  );
  return {
    environment: {
      CAVEMEM_TEST_SIGNAL_LOG: logPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
    },
    signals: () =>
      fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf8").trim().split(/\n+/).filter(Boolean)
        : [],
  };
}

function mergeTestEnvironments(...environments) {
  const merged = {};
  const nodeOptions = [];
  for (const environment of environments) {
    for (const [key, value] of Object.entries(environment)) {
      if (key === "NODE_OPTIONS") nodeOptions.push(value);
      else merged[key] = value;
    }
  }
  if (nodeOptions.length > 0) merged.NODE_OPTIONS = nodeOptions.join(" ");
  return merged;
}

function parseWorkerReceipt(contents) {
  const receipt = JSON.parse(contents);
  assert.deepEqual(Object.keys(receipt).sort(), ["nonce", "pid", "port"]);
  assert.equal(Number.isSafeInteger(receipt.pid) && receipt.pid > 0, true);
  assert.match(
    receipt.nonce,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    Number.isSafeInteger(receipt.port) &&
      receipt.port > 0 &&
      receipt.port <= 65_535,
    true,
  );
  return receipt;
}

function workerReceipt(dataDir) {
  const pidPath = path.join(dataDir, "worker.pid");
  if (!fs.existsSync(pidPath)) return null;
  return parseWorkerReceipt(fs.readFileSync(pidPath, "utf8"));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function workerPortIsOpen(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function workerPortAcceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readyWorkerReceipt(dataDir, port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const receipt = workerReceipt(dataDir);
  assert.notEqual(receipt, null);
  assert.equal(
    response.headers.get("x-cavemem-worker-pid"),
    String(receipt.pid),
  );
  assert.equal(
    response.headers.get("x-cavemem-worker-nonce"),
    receipt.nonce,
  );
  assert.equal(receipt.port, port);
  return receipt;
}

async function workerResponse(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    return {
      body: await response.text(),
      nonce: response.headers.get("x-cavemem-worker-nonce"),
      pid: response.headers.get("x-cavemem-worker-pid"),
      status: response.status,
    };
  } catch {
    return null;
  }
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function seedEmbeddingPolicyRows(dataDir, fullId, controlId, orphanId) {
  executeSql(
    dataDir,
    "INSERT INTO embeddings(observation_id, model, dim, vec) " +
      `VALUES (${fullId}, 'stale-full-vector', 3, X'0000803f0000003f0000803e'); ` +
      "INSERT INTO embeddings(observation_id, model, dim, vec) " +
      `VALUES (${controlId}, 'compressed-control-vector', 3, X'0000803f0000003f0000803e'); ` +
      "PRAGMA foreign_keys = OFF; " +
      "INSERT INTO embeddings(observation_id, model, dim, vec) " +
      `VALUES (${orphanId}, 'orphan-vector', 3, X'0000803f0000003f0000803e')`,
  );
}

function embeddingRows(dataDir) {
  return queryRows(
    dataDir,
    "SELECT observation_id, model FROM embeddings ORDER BY observation_id",
  );
}

test("storage policy patch is independent from privacy and schema", () => {
  assert.match(process.execPath, /^\/nix\/store\//);
  const patch = fs.readFileSync(patchPath, "utf8");
  const changedPaths = [
    ...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(changedPaths, [
    [
      "apps/cli/src/commands/lifecycle.ts",
      "apps/cli/src/commands/lifecycle.ts",
    ],
    ["apps/cli/src/commands/worker.ts", "apps/cli/src/commands/worker.ts"],
    ["apps/cli/src/commands/status.ts", "apps/cli/src/commands/status.ts"],
    ["apps/worker/src/server.ts", "apps/worker/src/server.ts"],
    ["packages/core/src/memory-store.ts", "packages/core/src/memory-store.ts"],
    ["packages/storage/src/storage.ts", "packages/storage/src/storage.ts"],
    ["packages/hooks/src/auto-spawn.ts", "packages/hooks/src/auto-spawn.ts"],
  ]);

  const addedCode = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  assert.doesNotMatch(
    addedCode,
    /redact|privacy|captureMode|PiFullToolObservation|SCHEMA_SQL|CREATE TABLE|ALTER TABLE/i,
  );
});

test(
  "top-level status requires a matching receipt and ready health identity",
  { timeout: 900_000 },
  async (t) => {
    await t.test("matching ready worker", async () => {
      await withDataDir(async (dataDir) => {
        const workerPort = await reservePort();
        writeSettings(dataDir, { workerPort });
        const worker = startWorker(dataDir);
        try {
          await waitForWorkerHealth(workerPort, worker);
          const receipt = await readyWorkerReceipt(dataDir, workerPort);
          const result = runCavemem(dataDir, ["status"]);
          assert.match(
            result.stdout,
            new RegExp(`worker:\\s+running \\(pid ${receipt.pid},`),
          );
          assert.match(
            result.stdout,
            new RegExp(`http://127\\.0\\.0\\.1:${workerPort}`),
          );
        } finally {
          await stopChild(worker.child);
        }
      });
    });

    const cases = [
      {
        name: "numeric live PID",
        receipt: () => String(process.pid),
      },
      {
        name: "malformed receipt",
        receipt: () => "not-a-worker-receipt\n",
      },
      {
        name: "stale strict receipt",
        receipt: (port) =>
          JSON.stringify({ pid: 99_999_999, nonce: crypto.randomUUID(), port }),
      },
      {
        name: "pre-ready listener",
        receipt: (port) =>
          JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), port }),
        response: { status: 503 },
      },
      {
        name: "unrelated listener",
        receipt: (port) =>
          JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), port }),
        response: {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-cavemem-worker-nonce": crypto.randomUUID(),
            "x-cavemem-worker-pid": String(process.pid),
          },
        },
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, { workerPort });
          fs.writeFileSync(
            path.join(dataDir, "worker.pid"),
            fixture.receipt(workerPort),
          );
          let server;
          try {
            if (fixture.response !== undefined) {
              server = http.createServer((_request, response) => {
                response.writeHead(
                  fixture.response.status,
                  fixture.response.headers ?? { "content-type": "text/plain" },
                );
                response.end(
                  fixture.response.status === 503
                    ? "worker not ready\n"
                    : '{"ok":true}',
                );
              });
              await listen(server, workerPort);
            }
            const result = runCavemem(dataDir, ["status"]);
            assert.doesNotMatch(result.stdout, /worker:\s+running/);
            assert.match(result.stdout, /worker:\s+not running/);
          } finally {
            if (server !== undefined) await closeServer(server);
          }
        });
      });
    }
  },
);

test(
  "default hooks do not spawn worker launchers for a matching ready owner",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "local",
          model: "Xenova/all-MiniLM-L6-v2",
          batchSize: 16,
          autoStart: true,
          idleShutdownMs: 60_000,
        },
      });
      const worker = startWorker(dataDir);
      const tracker = autoStartSpawnTracker(dataDir, "ready-owner-autostart");
      try {
        await waitForWorkerHealth(workerPort, worker);
        await readyWorkerReceipt(dataDir, workerPort);
        assertHookSucceeded(
          runHook(dataDir, makeControlPayload("ready-owner-one"), {
            autoStart: true,
            environment: tracker.environment,
          }),
        );
        assertHookSucceeded(
          runHook(dataDir, makeControlPayload("ready-owner-two"), {
            autoStart: true,
            environment: tracker.environment,
          }),
        );
        assert.equal(tracker.count(), 0);
      } finally {
        await stopChild(worker.child);
      }
    });
  },
);

test(
  "default hook auto-start distinguishes free ports from occupied startup leases",
  { timeout: 900_000 },
  async (t) => {
    const cases = [
      {
        expectedSpawns: 1,
        name: "numeric live PID on a free port",
        receipt: () => String(process.pid),
      },
      {
        expectedSpawns: 1,
        name: "malformed receipt on a free port",
        receipt: () => "not-a-worker-receipt\n",
      },
      {
        expectedSpawns: 1,
        name: "stale strict receipt on a free port",
        receipt: (port) =>
          JSON.stringify({ pid: 99_999_999, nonce: crypto.randomUUID(), port }),
      },
      {
        expectedSpawns: 0,
        name: "pre-ready listener",
        receipt: (port) =>
          JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), port }),
        response: { status: 503 },
      },
      {
        expectedSpawns: 0,
        name: "unrelated listener",
        receipt: (port) =>
          JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), port }),
        response: { status: 200 },
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      await t.test(fixture.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: "local",
              model: "Xenova/all-MiniLM-L6-v2",
              batchSize: 16,
              autoStart: true,
              idleShutdownMs: 60_000,
            },
          });
          fs.writeFileSync(
            path.join(dataDir, "worker.pid"),
            fixture.receipt(workerPort),
          );
          const tracker = autoStartSpawnTracker(
            dataDir,
            `ownership-autostart-${index}`,
          );
          let server;
          try {
            if (fixture.response !== undefined) {
              server = http.createServer((_request, response) => {
                response.writeHead(fixture.response.status, {
                  "content-type":
                    fixture.response.status === 200
                      ? "application/json"
                      : "text/plain",
                });
                response.end(
                  fixture.response.status === 503
                    ? "worker not ready\n"
                    : '{"ok":true}',
                );
              });
              await listen(server, workerPort);
            }
            assertHookSucceeded(
              runHook(dataDir, makeControlPayload(`ownership-${index}`), {
                autoStart: true,
                environment: tracker.environment,
              }),
            );
            assert.equal(tracker.count(), fixture.expectedSpawns);
          } finally {
            if (server !== undefined) await closeServer(server);
          }
        });
      });
    }
  },
);

test(
  "full rows round-trip on core, MCP, worker, and CLI retrieval surfaces",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      writeSettings(dataDir);
      const fullPayload = makeFullPayload(
        "storagegrammar",
        "storage-retrieval",
      );
      const fullContent = expectedFullContent(fullPayload);
      assert.ok(Buffer.byteLength(fullContent) > 4_000);
      const controlPayload = makeControlPayload(
        "storagecontrolterm",
        "storage-retrieval",
      );
      assertHookSucceeded(runHook(dataDir, fullPayload, { full: true }));
      assertHookSucceeded(runHook(dataDir, controlPayload));

      const persisted = observationRows(dataDir);
      const fullRow = persisted.find((row) => row.compressed === 0);
      const controlRow = persisted.find((row) => row.compressed === 1);
      assert.ok(fullRow);
      assert.ok(controlRow);
      assert.equal(fullRow.intensity, null);
      assertExactBytes(fullRow.content, fullContent, "SQLite row");

      const { core, worker } = await loadBundledModules();
      const settings = structuredClone(core.defaultSettings);
      settings.dataDir = dataDir;
      settings.compression.expandForModel = true;
      settings.embedding.provider = "none";
      const store = new core.MemoryStore({
        dbPath: path.join(dataDir, "data.db"),
        settings,
      });
      try {
        for (const options of [{}, { expand: true }, { expand: false }]) {
          const row = store.getObservations([fullRow.id], options)[0];
          assert.ok(row);
          assertExactBytes(row.content, fullContent, "core getObservations");
          assert.equal(row.compressed, false);
        }

        const coreControlRaw = store.getObservations([controlRow.id], {
          expand: false,
        })[0];
        const coreControlExpanded = store.getObservations([controlRow.id], {
          expand: true,
        })[0];
        assertExactBytes(
          coreControlRaw.content,
          controlRow.content,
          "compressed core raw retrieval",
        );
        assert.notEqual(coreControlExpanded.content, controlRow.content);
        assert.match(coreControlExpanded.content, /database/);
        assert.equal(coreControlRaw.compressed, true);
        assert.equal(coreControlExpanded.compressed, false);

        const timeline = store.timeline("storage-retrieval", undefined, 20);
        const timelineFull = timeline.find((row) => row.id === fullRow.id);
        assert.ok(timelineFull);
        assertExactBytes(timelineFull.content, fullContent, "core timeline");

        const app = worker.buildApp(store);
        const apiResponse = await app.request(
          "/api/sessions/storage-retrieval/observations?limit=20",
        );
        assert.equal(apiResponse.status, 200);
        const apiRows = await apiResponse.json();
        const apiFull = apiRows.find((row) => row.id === fullRow.id);
        const apiControl = apiRows.find((row) => row.id === controlRow.id);
        assert.ok(apiFull);
        assert.ok(apiControl);
        assertExactBytes(apiFull.content, fullContent, "worker JSON");
        assertExactBytes(
          apiControl.content,
          coreControlExpanded.content,
          "worker compressed control",
        );

        const htmlResponse = await app.request("/sessions/storage-retrieval");
        assert.equal(htmlResponse.status, 200);
        const html = await htmlResponse.text();
        assert.equal(html.includes(escapeHtml(fullContent)), true);
        assert.equal(
          html.includes(escapeHtml(coreControlExpanded.content)),
          true,
        );

        const searchResponse = await app.request(
          "/api/search?q=storagegrammar&limit=20",
        );
        assert.equal(searchResponse.status, 200);
        const searchRows = await searchResponse.json();
        const searchFull = searchRows.find((row) => row.id === fullRow.id);
        assert.ok(searchFull);
        assert.match(searchFull.snippet, /storagegrammar/);
        assert.doesNotMatch(searchFull.snippet, /database/);
      } finally {
        store.close();
      }

      const mcp = startMcp(dataDir);
      try {
        await mcp.initialize();
        for (const args of [
          { ids: [fullRow.id] },
          { ids: [fullRow.id], expand: true },
          { ids: [fullRow.id], expand: false },
        ]) {
          const rows = await mcp.call("get_observations", args);
          assert.equal(rows.length, 1);
          assertExactBytes(
            rows[0].content,
            fullContent,
            "MCP get_observations",
          );
        }

        const mcpControlRaw = await mcp.call("get_observations", {
          ids: [controlRow.id],
          expand: false,
        });
        const mcpControlExpanded = await mcp.call("get_observations", {
          ids: [controlRow.id],
          expand: true,
        });
        assertExactBytes(
          mcpControlRaw[0].content,
          controlRow.content,
          "MCP compressed control raw retrieval",
        );
        assert.notEqual(mcpControlExpanded[0].content, controlRow.content);
        assert.match(mcpControlExpanded[0].content, /database/);

        const timeline = await mcp.call("timeline", {
          session_id: "storage-retrieval",
          limit: 20,
        });
        assert.equal(
          timeline.some((row) => row.id === fullRow.id),
          true,
        );
        const search = await mcp.call("search", {
          query: "storagegrammar",
          limit: 20,
        });
        assert.equal(
          search.some((row) => row.id === fullRow.id),
          true,
        );
      } finally {
        await mcp.close();
      }

      const cliSearch = runCavemem(dataDir, [
        "search",
        "storagegrammar",
        "--limit",
        "20",
        "--no-semantic",
      ]);
      assert.match(cliSearch.stdout, new RegExp(`^${fullRow.id}\\t`, "m"));
      assert.match(cliSearch.stdout, /storagegrammar/);
      assert.doesNotMatch(cliSearch.stdout, /database/);
    });
  },
);

test(
  "full rows never enter live or backfill embedding and stale vectors are removed",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const requests = [];
      const fakeEmbeddingServer = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/api/embeddings");
            const payload = JSON.parse(body);
            requests.push(payload.prompt);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ embedding: [1, 0.5, 0.25] }));
          } catch (error) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: error.message }));
          }
        });
      });
      await listen(fakeEmbeddingServer);
      const embeddingAddress = fakeEmbeddingServer.address();
      assert.notEqual(embeddingAddress, null);
      const workerPort = await reservePort();
      const model = "storage-policy-fake-model";
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "ollama",
          model,
          endpoint: `http://127.0.0.1:${embeddingAddress.port}`,
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });

      let worker;
      try {
        const stalePayload = makeFullPayload("fullstaleterm");
        const missingPayload = makeFullPayload("fullmissingterm");
        const controlPayload = makeControlPayload("backfillcontrolterm");
        assertHookSucceeded(runHook(dataDir, stalePayload, { full: true }));
        assertHookSucceeded(runHook(dataDir, missingPayload, { full: true }));
        assertHookSucceeded(runHook(dataDir, controlPayload));

        const rows = observationRows(dataDir);
        const staleFull = rows.find(
          (row) => row.session_id === stalePayload.session_id,
        );
        const missingFull = rows.find(
          (row) => row.session_id === missingPayload.session_id,
        );
        const control = rows.find(
          (row) => row.session_id === controlPayload.session_id,
        );
        assert.ok(staleFull);
        assert.ok(missingFull);
        assert.ok(control);
        assert.equal(staleFull.compressed, 0);
        assert.equal(missingFull.compressed, 0);
        assert.equal(control.compressed, 1);

        executeSql(
          dataDir,
          "INSERT INTO embeddings(observation_id, model, dim, vec) " +
            `VALUES (${staleFull.id}, '${model}', 3, X'0000803f0000003f0000803e')`,
        );

        const { core } = await loadBundledModules();
        const settings = structuredClone(core.defaultSettings);
        settings.dataDir = dataDir;
        settings.embedding.provider = "ollama";
        settings.embedding.model = model;
        const store = new core.MemoryStore({
          dbPath: path.join(dataDir, "data.db"),
          settings,
        });
        try {
          assert.deepEqual(
            store.storage
              .allEmbeddings({ model, dim: 3 })
              .map((entry) => entry.observation_id),
            [],
          );
          assert.deepEqual(
            store.storage.allEmbeddings().map((entry) => entry.observation_id),
            [],
          );
          assert.deepEqual(
            store.storage
              .observationsMissingEmbeddings(20, model)
              .map((row) => row.id),
            [control.id],
          );
          assert.deepEqual(
            store.storage
              .observationsMissingEmbeddings(20)
              .map((row) => row.id),
            [control.id],
          );
          store.storage.putEmbedding(
            missingFull.id,
            model,
            new Float32Array([1, 0.5, 0.25]),
          );
          assert.deepEqual(
            queryRows(
              dataDir,
              `SELECT observation_id FROM embeddings WHERE observation_id = ${missingFull.id}`,
            ),
            [],
          );
          assert.throws(
            () =>
              store.storage.putEmbedding(
                Number.MAX_SAFE_INTEGER,
                model,
                new Float32Array([1, 0.5, 0.25]),
              ),
            /FOREIGN KEY constraint failed/,
          );
        } finally {
          store.close();
        }

        worker = childProcess.spawn(cavememPath(), ["worker", "run"], {
          env: dataEnvironment(dataDir),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let workerStderr = "";
        worker.stderr.setEncoding("utf8");
        worker.stderr.on("data", (chunk) => {
          workerStderr += chunk;
        });
        worker.on("exit", (status, signal) => {
          if (status !== 0 && signal === null) {
            workerStderr += `\nworker exited ${status}`;
          }
        });

        await waitFor(() => {
          assert.equal(worker.exitCode, null, workerStderr);
          const embeddings = queryRows(
            dataDir,
            "SELECT observation_id, model, dim FROM embeddings ORDER BY observation_id",
          );
          assert.deepEqual(embeddings, [
            { observation_id: control.id, model, dim: 3 },
          ]);
        }, 15_000);

        const backfillPrompts = requests.filter((prompt) => prompt !== " ");
        assert.equal(backfillPrompts.length, 1);
        assert.match(backfillPrompts[0], /backfillcontrolterm/);
        assert.match(backfillPrompts[0], /database/);
        assert.equal(
          backfillPrompts.some((prompt) =>
            /full(?:stale|missing)term/.test(prompt),
          ),
          false,
        );

        const liveFullPayload = makeFullPayload("livefullterm");
        assertHookSucceeded(runHook(dataDir, liveFullPayload, { full: true }));
        const liveFull = observationRows(dataDir).find(
          (row) => row.session_id === liveFullPayload.session_id,
        );
        assert.ok(liveFull);
        const requestCountBeforeFullWait = requests.length;
        await delay(2_500);
        assert.equal(requests.length, requestCountBeforeFullWait);
        assert.deepEqual(
          queryRows(
            dataDir,
            `SELECT observation_id FROM embeddings WHERE observation_id = ${liveFull.id}`,
          ),
          [],
        );

        const liveControlPayload = makeControlPayload("livecompressedterm");
        assertHookSucceeded(runHook(dataDir, liveControlPayload));
        const liveControl = observationRows(dataDir).find(
          (row) => row.session_id === liveControlPayload.session_id,
        );
        assert.ok(liveControl);
        await waitFor(() => {
          assert.deepEqual(
            queryRows(
              dataDir,
              `SELECT observation_id FROM embeddings WHERE observation_id = ${liveControl.id}`,
            ),
            [{ observation_id: liveControl.id }],
          );
        }, 10_000);

        const livePrompt = requests.find((prompt) =>
          prompt.includes("livecompressedterm"),
        );
        assert.equal(typeof livePrompt, "string");
        assert.match(livePrompt, /database/);
        assert.equal(
          requests.some((prompt) => prompt.includes("livefullterm")),
          false,
        );

        const finalEmbeddings = queryRows(
          dataDir,
          "SELECT e.observation_id, o.compressed " +
            "FROM embeddings e JOIN observations o ON o.id = e.observation_id " +
            "ORDER BY e.observation_id",
        );
        assert.equal(finalEmbeddings.length, 2);
        assert.equal(
          finalEmbeddings.every((row) => row.compressed === 1),
          true,
        );

        const finalStore = new core.MemoryStore({
          dbPath: path.join(dataDir, "data.db"),
          settings,
        });
        try {
          const expectedIds = [control.id, liveControl.id].sort(
            (left, right) => left - right,
          );
          assert.deepEqual(
            finalStore.storage
              .allEmbeddings()
              .map((entry) => entry.observation_id)
              .sort((left, right) => left - right),
            expectedIds,
          );
          assert.deepEqual(
            finalStore.storage
              .allEmbeddings({ model, dim: 3 })
              .map((entry) => entry.observation_id)
              .sort((left, right) => left - right),
            expectedIds,
          );
        } finally {
          finalStore.close();
        }

        const fullSearch = runCavemem(dataDir, [
          "search",
          "fullstaleterm",
          "--limit",
          "20",
          "--no-semantic",
        ]);
        assert.match(fullSearch.stdout, new RegExp(`^${staleFull.id}\\t`, "m"));
      } finally {
        if (worker !== undefined) await stopChild(worker);
        await closeServer(fakeEmbeddingServer);
      }
    });
  },
);

test(
  "worker removes stale full-row vectors when embedding is disabled or unavailable",
  { timeout: 900_000 },
  async (t) => {
    const fixtures = [
      { name: "provider none", provider: "none" },
      { name: "default local provider unavailable", provider: "local" },
    ];

    for (const [index, fixture] of fixtures.entries()) {
      await t.test(fixture.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: fixture.provider,
              model:
                fixture.provider === "local"
                  ? "Xenova/all-MiniLM-L6-v2"
                  : "cleanup-provider-none",
              batchSize: 16,
              autoStart: false,
              idleShutdownMs: 60_000,
            },
          });

          const fullPayload = makeFullPayload(`cleanup-full-${index}`);
          const controlPayload = makeControlPayload(`cleanup-control-${index}`);
          assertHookSucceeded(runHook(dataDir, fullPayload, { full: true }));
          assertHookSucceeded(runHook(dataDir, controlPayload));
          const rows = observationRows(dataDir);
          const full = rows.find(
            (row) => row.session_id === fullPayload.session_id,
          );
          const control = rows.find(
            (row) => row.session_id === controlPayload.session_id,
          );
          assert.ok(full);
          assert.ok(control);
          const orphanId = 900_000 + index;
          seedEmbeddingPolicyRows(dataDir, full.id, control.id, orphanId);

          const worker = startWorker(dataDir);
          try {
            await waitForWorkerHealth(workerPort, worker);
            assert.deepEqual(embeddingRows(dataDir), [
              {
                observation_id: control.id,
                model: "compressed-control-vector",
              },
              { observation_id: orphanId, model: "orphan-vector" },
            ]);
            const state = await fetch(
              `http://127.0.0.1:${workerPort}/api/state`,
            );
            assert.equal(state.status, 200);
            assert.deepEqual(await state.json(), { running: false });
            assert.equal(
              worker.stderr().includes("embedder unavailable"),
              fixture.provider === "local",
            );
          } finally {
            await stopChild(worker.child);
          }
        });
      });
    }
  },
);

test(
  "worker fails visibly and value-free when stale-vector cleanup fails",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "none",
          model: "cleanup-error-provider-none",
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });

      const fullPayload = makeFullPayload("cleanup-error-full");
      const controlPayload = makeControlPayload("cleanup-error-control");
      assertHookSucceeded(runHook(dataDir, fullPayload, { full: true }));
      assertHookSucceeded(runHook(dataDir, controlPayload));
      const rows = observationRows(dataDir);
      const full = rows.find(
        (row) => row.session_id === fullPayload.session_id,
      );
      const control = rows.find(
        (row) => row.session_id === controlPayload.session_id,
      );
      assert.ok(full);
      assert.ok(control);
      const orphanId = 910_000;
      seedEmbeddingPolicyRows(dataDir, full.id, control.id, orphanId);
      const sensitiveSentinel = "PRIVATE_CLEANUP_TOKEN_SENTINEL";
      const privateDbPath = path.join(dataDir, "data.db");
      executeSql(
        dataDir,
        "CREATE TRIGGER fail_uncompressed_embedding_cleanup " +
          "BEFORE DELETE ON embeddings " +
          `WHEN OLD.observation_id = ${full.id} ` +
          `BEGIN SELECT RAISE(ABORT, ${sqlString(
            `${sensitiveSentinel} ${privateDbPath}`,
          )}); END`,
      );

      const worker = startWorker(dataDir);
      try {
        const exit = await waitForChildExit(worker.child);
        assert.deepEqual(exit, { signal: null, status: 1 });
        assert.equal(worker.stdout(), "");
        assert.equal(
          worker.stderr(),
          "cavemem error: worker storage-policy cleanup failed\n",
        );
        for (const value of [
          sensitiveSentinel,
          privateDbPath,
          fullPayload.session_id,
          fullPayload.input.marker,
          controlPayload.session_id,
          controlPayload.tool_input.request,
          "stale-full-vector",
          "compressed-control-vector",
          "orphan-vector",
        ]) {
          assert.equal(worker.stderr().includes(value), false);
        }
        assert.equal(fs.existsSync(path.join(dataDir, "worker.pid")), false);
        assert.deepEqual(embeddingRows(dataDir), [
          { observation_id: full.id, model: "stale-full-vector" },
          {
            observation_id: control.id,
            model: "compressed-control-vector",
          },
          { observation_id: orphanId, model: "orphan-vector" },
        ]);
      } finally {
        await stopChild(worker.child);
      }
    });
  },
);

test(
  "daemon launchers clear stale receipts and fail value-free when cleanup fails",
  { timeout: 900_000 },
  async (t) => {
    const launchers = [
      { args: ["start"], name: "cavemem start" },
      { args: ["worker", "start"], name: "cavemem worker start" },
    ];
    const pidfileStates = [
      {
        contents: (port) =>
          JSON.stringify({ pid: 99_999_999, nonce: crypto.randomUUID(), port }),
        name: "dead",
      },
      { contents: () => "not-a-worker-receipt\n", name: "malformed" },
    ];
    let fixtureIndex = 0;

    for (const launcher of launchers) {
      for (const pidfileState of pidfileStates) {
        const index = fixtureIndex++;
        await t.test(
          `${launcher.name} with ${pidfileState.name} pidfile`,
          async () => {
            await withDataDir(async (dataDir) => {
              const workerPort = await reservePort();
              writeSettings(dataDir, {
                workerPort,
                embedding: {
                  provider: "none",
                  model: `daemon-cleanup-error-${index}`,
                  batchSize: 16,
                  autoStart: false,
                  idleShutdownMs: 60_000,
                },
              });

              const fullPayload = makeFullPayload(`daemon-error-full-${index}`);
              const controlPayload = makeControlPayload(
                `daemon-error-control-${index}`,
              );
              assertHookSucceeded(
                runHook(dataDir, fullPayload, { full: true }),
              );
              assertHookSucceeded(runHook(dataDir, controlPayload));
              const rows = observationRows(dataDir);
              const full = rows.find(
                (row) => row.session_id === fullPayload.session_id,
              );
              const control = rows.find(
                (row) => row.session_id === controlPayload.session_id,
              );
              assert.ok(full);
              assert.ok(control);
              const orphanId = 920_000 + index;
              seedEmbeddingPolicyRows(dataDir, full.id, control.id, orphanId);
              const sensitiveSentinel = `PRIVATE_DAEMON_TOKEN_SENTINEL_${index}`;
              const privateDbPath = path.join(dataDir, "data.db");
              executeSql(
                dataDir,
                "CREATE TRIGGER fail_uncompressed_embedding_cleanup " +
                  "BEFORE DELETE ON embeddings " +
                  `WHEN OLD.observation_id = ${full.id} ` +
                  `BEGIN SELECT RAISE(ABORT, ${sqlString(
                    `${sensitiveSentinel} ${privateDbPath}`,
                  )}); END`,
              );
              const pidPath = path.join(dataDir, "worker.pid");
              fs.writeFileSync(pidPath, pidfileState.contents(workerPort));
              const tracker = daemonChildTracker(
                dataDir,
                `cleanup-failure-child-${index}`,
              );

              const result = await runCavememAsync(
                dataDir,
                launcher.args,
                15_000,
                tracker.environment,
              );
              const observedPid = tracker.pid();
              assert.notEqual(
                observedPid,
                null,
                "daemon child pid was not captured",
              );
              try {
                await waitFor(() => {
                  assert.equal(isProcessAlive(observedPid), false);
                });
                assert.equal(result.signal, null);
                assert.equal(result.status, 1);
                assert.equal(result.stdout, "");
                assert.equal(
                  result.stderr,
                  "cavemem error: worker failed to start\n",
                );
                assert.equal(fs.existsSync(pidPath), false);
                assert.equal(await workerPortIsOpen(workerPort), false);
                assert.deepEqual(embeddingRows(dataDir), [
                  { observation_id: full.id, model: "stale-full-vector" },
                  {
                    observation_id: control.id,
                    model: "compressed-control-vector",
                  },
                  { observation_id: orphanId, model: "orphan-vector" },
                ]);
                for (const output of [result.stdout, result.stderr]) {
                  assert.equal(output.includes(sensitiveSentinel), false);
                  assert.equal(output.includes(privateDbPath), false);
                }
              } finally {
                if (isProcessAlive(observedPid)) {
                  process.kill(observedPid, "SIGTERM");
                }
              }
            });
          },
        );
      }
    }
  },
);

test(
  "both daemon launchers replace a live-unrelated receipt on a free worker port",
  { timeout: 900_000 },
  async (t) => {
    const launchers = [
      { args: ["start"], name: "cavemem start", reportsUrl: true },
      {
        args: ["worker", "start"],
        name: "cavemem worker start",
        reportsUrl: false,
      },
    ];

    for (const [index, launcher] of launchers.entries()) {
      await t.test(launcher.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: "none",
              model: `unrelated-live-pid-${index}`,
              batchSize: 16,
              autoStart: false,
              idleShutdownMs: 60_000,
            },
          });
          const pidPath = path.join(dataDir, "worker.pid");
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: process.pid,
              nonce: crypto.randomUUID(),
              port: workerPort,
            }),
          );
          const tracker = daemonChildTracker(dataDir, `unrelated-child-${index}`);
          let spawnedPid;

          try {
            const result = await runCavememAsync(
              dataDir,
              launcher.args,
              15_000,
              tracker.environment,
            );
            spawnedPid = tracker.pid();
            assert.notEqual(spawnedPid, null, "launcher did not spawn a worker");
            assert.notEqual(spawnedPid, process.pid);
            assert.equal(result.signal, null);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.equal(
              result.stdout,
              launcher.reportsUrl
                ? `started (pid ${spawnedPid}) http://127.0.0.1:${workerPort}\n`
                : `started (pid ${spawnedPid})\n`,
            );
            const receipt = workerReceipt(dataDir);
            assert.notEqual(receipt, null);
            assert.equal(receipt.pid, spawnedPid);
            assert.deepEqual(
              await readyWorkerReceipt(dataDir, workerPort),
              receipt,
            );
            assert.equal(isProcessAlive(process.pid), true);
          } finally {
            if (
              spawnedPid !== undefined &&
              spawnedPid !== null &&
              spawnedPid !== process.pid &&
              isProcessAlive(spawnedPid)
            ) {
              process.kill(spawnedPid, "SIGTERM");
              await waitFor(() => {
                assert.equal(isProcessAlive(spawnedPid), false);
              });
            }
          }
        });
      });
    }
  },
);

test(
  "matching receipt and ready health report already running without spawning",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "none",
          model: "matching-ready-receipt",
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });
      const initialTracker = daemonChildTracker(dataDir, "matching-ready-initial");
      let initialPid;

      try {
        const initial = await runCavememAsync(
          dataDir,
          ["start"],
          15_000,
          initialTracker.environment,
        );
        initialPid = initialTracker.pid();
        assert.notEqual(initialPid, null);
        assert.equal(initial.status, 0, initial.stderr);
        const receipt = await readyWorkerReceipt(dataDir, workerPort);
        assert.equal(receipt.pid, initialPid);
        const status = await runCavememAsync(dataDir, ["worker", "status"]);
        assert.equal(status.status, 0, status.stderr);
        assert.equal(status.stderr, "");
        assert.equal(status.stdout, `running (pid ${initialPid})\n`);

        for (const [index, args] of [
          ["start"],
          ["worker", "start"],
        ].entries()) {
          const tracker = daemonChildTracker(
            dataDir,
            `matching-ready-loser-${index}`,
          );
          const result = await runCavememAsync(
            dataDir,
            args,
            15_000,
            tracker.environment,
          );
          assert.equal(result.signal, null);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, "");
          assert.equal(result.stdout, `already running (pid ${initialPid})\n`);
          assert.equal(tracker.pid(), null);
          assert.deepEqual(workerReceipt(dataDir), receipt);
        }
      } finally {
        if (initialPid !== undefined && initialPid !== null && isProcessAlive(initialPid)) {
          process.kill(initialPid, "SIGTERM");
          await waitFor(() => {
            assert.equal(isProcessAlive(initialPid), false);
          });
        }
      }
    });
  },
);

test(
  "a nonce-mismatched readiness message leaves no receipt, child, or listener",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "none",
          model: "mismatched-ready-message",
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });
      const tracker = daemonChildTracker(dataDir, "mismatched-ready-child");
      const environment = mergeTestEnvironments(
        tracker.environment,
        mismatchedReadyIpc(dataDir),
      );
      let spawnedPid;

      try {
        const result = await runCavememAsync(
          dataDir,
          ["start"],
          15_000,
          environment,
        );
        spawnedPid = tracker.pid();
        assert.notEqual(spawnedPid, null);
        await waitFor(() => {
          assert.equal(isProcessAlive(spawnedPid), false);
        }, 2_000);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "cavemem error: worker failed to start\n");
        assert.equal(fs.existsSync(path.join(dataDir, "worker.pid")), false);
        assert.equal(await workerPortAcceptsConnections(workerPort), false);
      } finally {
        if (spawnedPid !== undefined && spawnedPid !== null && isProcessAlive(spawnedPid)) {
          process.kill(spawnedPid, "SIGTERM");
          await waitFor(() => {
            assert.equal(isProcessAlive(spawnedPid), false);
          });
        }
      }
    });
  },
);

test(
  "unrelated port ownership rejects both bind losers without state mutation",
  { timeout: 900_000 },
  async (t) => {
    const launchers = [
      { args: ["start"], name: "cavemem start" },
      { args: ["worker", "start"], name: "cavemem worker start" },
    ];

    for (const [index, launcher] of launchers.entries()) {
      await t.test(launcher.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: "none",
              model: `unrelated-port-${index}`,
              batchSize: 16,
              autoStart: false,
              idleShutdownMs: 60_000,
            },
          });
          const fullPayload = makeFullPayload(`unrelated-port-full-${index}`);
          const controlPayload = makeControlPayload(
            `unrelated-port-control-${index}`,
          );
          assertHookSucceeded(runHook(dataDir, fullPayload, { full: true }));
          assertHookSucceeded(runHook(dataDir, controlPayload));
          const rows = observationRows(dataDir);
          const full = rows.find(
            (row) => row.session_id === fullPayload.session_id,
          );
          const control = rows.find(
            (row) => row.session_id === controlPayload.session_id,
          );
          assert.ok(full);
          assert.ok(control);
          const orphanId = 940_000 + index;
          seedEmbeddingPolicyRows(dataDir, full.id, control.id, orphanId);

          const pidPath = path.join(dataDir, "worker.pid");
          const originalReceipt = JSON.stringify({
            pid: process.pid,
            nonce: crypto.randomUUID(),
            port: workerPort,
          });
          fs.writeFileSync(pidPath, originalReceipt);
          const unrelatedServer = http.createServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
          });
          await listen(unrelatedServer, workerPort);
          const tracker = daemonChildTracker(dataDir, `port-loser-${index}`);
          let spawnedPid;

          try {
            const result = await runCavememAsync(
              dataDir,
              launcher.args,
              15_000,
              tracker.environment,
            );
            spawnedPid = tracker.pid();
            assert.notEqual(spawnedPid, null);
            await waitFor(() => {
              assert.equal(isProcessAlive(spawnedPid), false);
            });
            assert.equal(result.signal, null);
            assert.equal(result.status, 1);
            assert.equal(result.stdout, "");
            assert.equal(result.stderr, "cavemem error: worker failed to start\n");
            assert.equal(fs.readFileSync(pidPath, "utf8"), originalReceipt);
            assert.deepEqual(embeddingRows(dataDir), [
              { observation_id: full.id, model: "stale-full-vector" },
              {
                observation_id: control.id,
                model: "compressed-control-vector",
              },
              { observation_id: orphanId, model: "orphan-vector" },
            ]);
            assert.equal(isProcessAlive(process.pid), true);
            assert.equal(await workerPortAcceptsConnections(workerPort), true);
            assert.deepEqual(
              fs
                .readdirSync(dataDir)
                .filter((name) => /^\.?worker\.pid\./.test(name)),
              [],
            );
          } finally {
            if (spawnedPid !== undefined && spawnedPid !== null && isProcessAlive(spawnedPid)) {
              process.kill(spawnedPid, "SIGTERM");
            }
            await closeServer(unrelatedServer);
          }
        });
      });
    }
  },
);

test(
  "neither daemon launcher reports a receipt-published pre-ready worker as ready",
  { timeout: 900_000 },
  async (t) => {
    const launchers = [
      { args: ["start"], name: "cavemem start" },
      { args: ["worker", "start"], name: "cavemem worker start" },
    ];

    for (const [index, launcher] of launchers.entries()) {
      await t.test(launcher.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: "none",
              model: `publication-contention-${index}`,
              batchSize: 16,
              autoStart: false,
              idleShutdownMs: 60_000,
            },
          });
          const publication = publicationControl(
            dataDir,
            `publication-contention-${index}`,
            "pause",
          );
          const winnerTracker = daemonChildTracker(
            dataDir,
            `publication-winner-${index}`,
          );
          const loserTracker = daemonChildTracker(
            dataDir,
            `publication-loser-${index}`,
          );
          const winnerEnvironment = mergeTestEnvironments(
            winnerTracker.environment,
            publication.environment,
          );
          let winnerLaunch;
          let winnerPid;
          let loserPid;

          try {
            winnerLaunch = runCavememAsync(
              dataDir,
              ["start"],
              30_000,
              winnerEnvironment,
            );
            await publication.wait();
            winnerPid = winnerTracker.pid();
            assert.notEqual(winnerPid, null);
            const publicationReceipt = workerReceipt(dataDir);
            assert.notEqual(publicationReceipt, null);
            assert.equal(publicationReceipt.pid, winnerPid);
            assert.equal(publicationReceipt.port, workerPort);

            const loserResult = await runCavememAsync(
              dataDir,
              launcher.args,
              15_000,
              loserTracker.environment,
            );
            loserPid = loserTracker.pid();
            publication.release();
            const winnerResult = await winnerLaunch;

            assert.notEqual(loserPid, null, "competing launcher did not probe by spawning");
            await waitFor(() => {
              assert.equal(isProcessAlive(loserPid), false);
            });
            assert.equal(loserResult.signal, null);
            assert.equal(loserResult.status, 1);
            assert.equal(loserResult.stdout, "");
            assert.equal(
              loserResult.stderr,
              "cavemem error: worker failed to start\n",
            );
            assert.equal(loserResult.stdout.includes("already running"), false);
            assert.deepEqual(workerReceipt(dataDir), publicationReceipt);

            assert.equal(winnerResult.signal, null);
            assert.equal(winnerResult.status, 0, winnerResult.stderr);
            assert.deepEqual(
              await readyWorkerReceipt(dataDir, workerPort),
              publicationReceipt,
            );
          } finally {
            publication.release();
            await Promise.allSettled(
              [winnerLaunch].filter((launch) => launch !== undefined),
            );
            for (const pid of [loserPid, winnerPid]) {
              if (pid !== undefined && pid !== null && isProcessAlive(pid)) {
                process.kill(pid, "SIGTERM");
              }
            }
          }
        });
      });
    }
  },
);

test(
  "both daemon launchers clean an attempted atomic receipt publication after failure",
  { timeout: 900_000 },
  async (t) => {
    const launchers = [
      { args: ["start"], name: "cavemem start" },
      { args: ["worker", "start"], name: "cavemem worker start" },
    ];

    for (const [index, launcher] of launchers.entries()) {
      await t.test(launcher.name, async () => {
        await withDataDir(async (dataDir) => {
          const workerPort = await reservePort();
          writeSettings(dataDir, {
            workerPort,
            embedding: {
              provider: "none",
              model: `publication-failure-${index}`,
              batchSize: 16,
              autoStart: false,
              idleShutdownMs: 60_000,
            },
          });
          const publication = publicationControl(
            dataDir,
            `publication-failure-${index}`,
            "fail",
          );
          const tracker = daemonChildTracker(
            dataDir,
            `publication-failure-child-${index}`,
          );
          const environment = mergeTestEnvironments(
            tracker.environment,
            publication.environment,
          );
          const result = await runCavememAsync(
            dataDir,
            launcher.args,
            15_000,
            environment,
          );
          const observedPid = tracker.pid();
          assert.notEqual(observedPid, null);
          await waitFor(() => {
            assert.equal(isProcessAlive(observedPid), false);
          });

          assert.equal(result.signal, null);
          assert.equal(result.status, 1);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr, "cavemem error: worker failed to start\n");
          assert.equal(
            `${result.stdout}${result.stderr}`.includes(
              "PRIVATE_PUBLICATION_FAILURE_SENTINEL",
            ),
            false,
          );
          assert.equal(fs.existsSync(path.join(dataDir, "worker.pid")), false);
          assert.equal(await workerPortAcceptsConnections(workerPort), false);
          assert.deepEqual(
            fs
              .readdirSync(dataDir)
              .filter((name) => /^\.?worker\.pid\./.test(name)),
            [],
          );
        });
      });
    }
  },
);

test(
  "SIGTERM compare-removes readiness while retaining the listener during embedding stop",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      let releaseBlockedEmbedding;
      const fakeEmbeddingServer = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const prompt = JSON.parse(body).prompt;
          const reply = () => {
            if (response.writableEnded || response.destroyed) return;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ embedding: [1, 0.5, 0.25] }));
          };
          if (prompt === " ") reply();
          else releaseBlockedEmbedding = reply;
        });
      });
      await listen(fakeEmbeddingServer);
      const embeddingAddress = fakeEmbeddingServer.address();
      assert.notEqual(embeddingAddress, null);
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "ollama",
          model: "blocked-shutdown-model",
          endpoint: `http://127.0.0.1:${embeddingAddress.port}`,
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });
      assertHookSucceeded(runHook(dataDir, makeControlPayload("blocked-stop")));
      const worker = startWorker(dataDir);

      try {
        await waitForWorkerHealth(workerPort, worker);
        await waitFor(() => {
          assert.equal(typeof releaseBlockedEmbedding, "function");
        });
        const pid = worker.child.pid;
        assert.notEqual(pid, undefined);
        const receipt = workerReceipt(dataDir);
        assert.notEqual(receipt, null);
        assert.equal(receipt.pid, pid);
        assert.deepEqual(await readyWorkerReceipt(dataDir, workerPort), receipt);

        worker.child.kill("SIGTERM");
        await waitFor(async () => {
          assert.equal(fs.existsSync(path.join(dataDir, "worker.pid")), false);
          assert.deepEqual(await workerResponse(workerPort), {
            body: "worker not ready\n",
            nonce: null,
            pid: null,
            status: 503,
          });
        }, 2_000);
        assert.equal(isProcessAlive(pid), true);
        assert.equal(await workerPortAcceptsConnections(workerPort), true);

        releaseBlockedEmbedding();
        const exit = await waitForChildExit(worker.child, 5_000);
        assert.deepEqual(exit, { signal: null, status: 0 });
        assert.equal(fs.existsSync(path.join(dataDir, "worker.pid")), false);
        assert.equal(await workerPortAcceptsConnections(workerPort), false);
      } finally {
        releaseBlockedEmbedding?.();
        await stopChild(worker.child);
        await closeServer(fakeEmbeddingServer);
      }
    });
  },
);

test(
  "restart waits for an idle Ollama worker and spawns one ready replacement",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      const fakeEmbeddingServer = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ embedding: [1, 0.5, 0.25] }));
        });
      });
      await listen(fakeEmbeddingServer);
      const embeddingAddress = fakeEmbeddingServer.address();
      assert.notEqual(embeddingAddress, null);
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "ollama",
          model: "idle-restart-model",
          endpoint: `http://127.0.0.1:${embeddingAddress.port}`,
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });
      const initialTracker = daemonChildTracker(dataDir, "idle-restart-initial");
      const replacementTracker = daemonChildrenTracker(
        dataDir,
        "idle-restart-replacement",
      );
      let initialPid;
      let replacementPid;

      try {
        const startResult = await runCavememAsync(
          dataDir,
          ["start"],
          15_000,
          initialTracker.environment,
        );
        initialPid = initialTracker.pid();
        assert.notEqual(initialPid, null);
        assert.equal(startResult.status, 0, startResult.stderr);
        await waitFor(async () => {
          assert.equal(await workerPortIsOpen(workerPort), true);
        });

        const restartResult = await runCavememAsync(
          dataDir,
          ["restart"],
          20_000,
          replacementTracker.environment,
        );
        const replacements = replacementTracker.pids();
        assert.equal(replacements.length, 1);
        [replacementPid] = replacements;
        assert.notEqual(replacementPid, initialPid);
        assert.equal(restartResult.signal, null);
        assert.equal(restartResult.status, 0, restartResult.stderr);
        assert.equal(restartResult.stderr, "");
        assert.equal(
          restartResult.stdout,
          `restarted (pid ${replacementPid}) http://127.0.0.1:${workerPort}\n`,
        );
        await waitFor(() => {
          assert.equal(isProcessAlive(initialPid), false);
        });
        const receipt = workerReceipt(dataDir);
        assert.notEqual(receipt, null);
        assert.equal(receipt.pid, replacementPid);
        assert.deepEqual(await readyWorkerReceipt(dataDir, workerPort), receipt);
      } finally {
        for (const pid of [replacementPid, initialPid]) {
          if (pid !== undefined && pid !== null && isProcessAlive(pid)) {
            process.kill(pid, "SIGTERM");
          }
        }
        await closeServer(fakeEmbeddingServer);
      }
    });
  },
);

test(
  "restart escalates only a verified blocked owner before one replacement",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      let blockedRequests = 0;
      const fakeEmbeddingServer = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const prompt = JSON.parse(body).prompt;
          if (prompt !== " ") blockedRequests += 1;
          if (prompt !== " " && blockedRequests === 1) return;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ embedding: [1, 0.5, 0.25] }));
        });
      });
      await listen(fakeEmbeddingServer);
      const embeddingAddress = fakeEmbeddingServer.address();
      assert.notEqual(embeddingAddress, null);
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "ollama",
          model: "blocked-restart-model",
          endpoint: `http://127.0.0.1:${embeddingAddress.port}`,
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });
      assertHookSucceeded(runHook(dataDir, makeControlPayload("blocked-restart")));
      const initialTracker = daemonChildTracker(dataDir, "blocked-restart-initial");
      const replacementTracker = daemonChildrenTracker(
        dataDir,
        "blocked-restart-replacement",
      );
      const signals = signalTracker(dataDir, "blocked-restart");
      let initialPid;
      let replacementPid;

      try {
        const startResult = await runCavememAsync(
          dataDir,
          ["start"],
          15_000,
          initialTracker.environment,
        );
        initialPid = initialTracker.pid();
        assert.notEqual(initialPid, null);
        assert.equal(startResult.status, 0, startResult.stderr);
        await waitFor(() => {
          assert.equal(blockedRequests, 1);
        });

        const restartEnvironment = mergeTestEnvironments(
          replacementTracker.environment,
          signals.environment,
        );
        const restartResult = await runCavememAsync(
          dataDir,
          ["restart"],
          20_000,
          restartEnvironment,
        );
        const replacements = replacementTracker.pids();
        assert.equal(replacements.length, 1);
        [replacementPid] = replacements;
        assert.equal(restartResult.signal, null);
        assert.equal(restartResult.status, 0, restartResult.stderr);
        assert.equal(
          restartResult.stdout,
          `restarted (pid ${replacementPid}) http://127.0.0.1:${workerPort}\n`,
        );
        assert.deepEqual(signals.signals(), [
          `${initialPid}:SIGTERM`,
          `${initialPid}:SIGKILL`,
        ]);
        assert.equal(isProcessAlive(initialPid), false);
        const receipt = workerReceipt(dataDir);
        assert.notEqual(receipt, null);
        assert.equal(receipt.pid, replacementPid);
        assert.deepEqual(await readyWorkerReceipt(dataDir, workerPort), receipt);
        await waitFor(() => {
          assert.equal(blockedRequests >= 2, true);
        });
      } finally {
        for (const pid of [replacementPid, initialPid]) {
          if (pid !== undefined && pid !== null && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        await closeServer(fakeEmbeddingServer);
      }
    });
  },
);

test(
  "a bound warming worker owns stale pidfile cleanup before final publication",
  { timeout: 900_000 },
  async () => {
    await withDataDir(async (dataDir) => {
      let releaseFirstWarmup;
      let warmupRequests = 0;
      const fakeEmbeddingServer = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          warmupRequests += 1;
          const reply = () => {
            if (response.writableEnded) return;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ embedding: [1, 0.5, 0.25] }));
          };
          if (warmupRequests === 1) {
            releaseFirstWarmup = reply;
          } else {
            reply();
          }
        });
      });
      await listen(fakeEmbeddingServer);
      const embeddingAddress = fakeEmbeddingServer.address();
      assert.notEqual(embeddingAddress, null);
      const workerPort = await reservePort();
      writeSettings(dataDir, {
        workerPort,
        embedding: {
          provider: "ollama",
          model: "compressed-control-vector",
          endpoint: `http://127.0.0.1:${embeddingAddress.port}`,
          batchSize: 16,
          autoStart: false,
          idleShutdownMs: 60_000,
        },
      });

      const fullPayload = makeFullPayload("concurrent-cleanup-full");
      const controlPayload = makeControlPayload("concurrent-cleanup-control");
      assertHookSucceeded(runHook(dataDir, fullPayload, { full: true }));
      assertHookSucceeded(runHook(dataDir, controlPayload));
      const rows = observationRows(dataDir);
      const full = rows.find(
        (row) => row.session_id === fullPayload.session_id,
      );
      const control = rows.find(
        (row) => row.session_id === controlPayload.session_id,
      );
      assert.ok(full);
      assert.ok(control);
      const orphanId = 930_000;
      seedEmbeddingPolicyRows(dataDir, full.id, control.id, orphanId);
      executeSql(
        dataDir,
        `UPDATE embeddings SET model = 'compressed-control-vector' WHERE observation_id = ${orphanId}`,
      );
      const pidPath = path.join(dataDir, "worker.pid");
      fs.writeFileSync(pidPath, "malformed-before-overlap\n");

      const winnerTracker = daemonChildTracker(dataDir, "overlap-winner");
      const loserTracker = daemonChildTracker(dataDir, "overlap-loser");
      let winnerLaunch;
      let loserLaunch;
      try {
        winnerLaunch = runCavememAsync(
          dataDir,
          ["start"],
          30_000,
          winnerTracker.environment,
        );
        await waitFor(() => {
          assert.equal(typeof releaseFirstWarmup, "function");
        });
        const gatedResponse = await workerResponse(workerPort);
        const pidfileRemovedBeforeLoser = !fs.existsSync(pidPath);

        loserLaunch = runCavememAsync(
          dataDir,
          ["worker", "start"],
          15_000,
          loserTracker.environment,
        );
        const loserResult = await loserLaunch;
        const requestsBeforeRelease = warmupRequests;
        const pidfileAbsentAfterLoser = !fs.existsSync(pidPath);
        releaseFirstWarmup();
        const winnerResult = await winnerLaunch;
        const winnerPid = winnerTracker.pid();
        const loserPid = loserTracker.pid();

        assert.deepEqual(gatedResponse, {
          body: "worker not ready\n",
          nonce: null,
          pid: null,
          status: 503,
        });
        assert.equal(pidfileRemovedBeforeLoser, true);
        assert.equal(requestsBeforeRelease, 1);
        assert.equal(loserResult.signal, null);
        assert.equal(loserResult.status, 1);
        assert.equal(loserResult.stdout, "");
        assert.equal(
          loserResult.stderr,
          "cavemem error: worker failed to start\n",
        );
        assert.equal(pidfileAbsentAfterLoser, true);
        assert.notEqual(loserPid, null);
        await waitFor(() => {
          assert.equal(isProcessAlive(loserPid), false);
        });

        assert.equal(winnerResult.signal, null);
        assert.equal(winnerResult.status, 0, winnerResult.stderr);
        assert.equal(winnerResult.stderr, "");
        assert.notEqual(winnerPid, null);
        assert.equal(
          winnerResult.stdout,
          `started (pid ${winnerPid}) http://127.0.0.1:${workerPort}\n`,
        );
        assert.equal(isProcessAlive(winnerPid), true);
        const receipt = workerReceipt(dataDir);
        assert.notEqual(receipt, null);
        assert.equal(receipt.pid, winnerPid);
        assert.equal(receipt.port, workerPort);
        assert.deepEqual(await readyWorkerReceipt(dataDir, workerPort), receipt);
        assert.equal(await workerPortIsOpen(workerPort), true);
        assert.deepEqual(embeddingRows(dataDir), [
          {
            observation_id: control.id,
            model: "compressed-control-vector",
          },
          {
            observation_id: orphanId,
            model: "compressed-control-vector",
          },
        ]);
        process.kill(winnerPid, "SIGTERM");
        await waitFor(() => {
          assert.equal(isProcessAlive(winnerPid), false);
          assert.equal(fs.existsSync(pidPath), false);
        });
        assert.equal(await workerPortIsOpen(workerPort), false);
      } finally {
        releaseFirstWarmup?.();
        for (const tracker of [loserTracker, winnerTracker]) {
          const pid = tracker.pid();
          if (pid !== null && isProcessAlive(pid)) process.kill(pid, "SIGTERM");
        }
        await Promise.allSettled(
          [loserLaunch, winnerLaunch].filter((launch) => launch !== undefined),
        );
        await closeServer(fakeEmbeddingServer);
      }
    });
  },
);
