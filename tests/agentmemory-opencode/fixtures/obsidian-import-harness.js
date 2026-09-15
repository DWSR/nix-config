'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const HARNESS_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const PROCESS_PROBE_TIMEOUT_MS = 250;
const CLEANUP_POLL_MS = 50;
const TERM_GRACE_MS = 1_000;
const STABLE_ABSENCE_SAMPLES = 2;
let harnessTurn = Promise.resolve();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deadlineError(operation) {
  return new Error(`${operation}: teardown deadline exhausted`);
}

function redact(value, secrets) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

function processIsAlive(pid, deadline = Date.now() + PROCESS_PROBE_TIMEOUT_MS) {
  try {
    process.kill(pid, 0);
    const processInfo = listProcesses(deadline)
      .find(({ pid: candidatePid }) => candidatePid === pid);
    return !processInfo || !processInfo.state?.startsWith('Z');
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function processGroupIsAlive(processGroupId, deadline = Date.now() + PROCESS_PROBE_TIMEOUT_MS) {
  try {
    process.kill(-processGroupId, 0);
    const processes = listProcesses(deadline);
    return processes.some((processInfo) => (
      processInfo.processGroupId === processGroupId
      && !processInfo.state?.startsWith('Z')
    ));
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function listProcesses(deadline = Date.now() + PROCESS_PROBE_TIMEOUT_MS) {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) throw deadlineError('process discovery');
  let output;
  try {
    output = execFileSync(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,stat=,command='],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
      },
    );
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
      throw deadlineError('process discovery');
    }
    throw error;
  }
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      state: match[4],
      command: match[5],
    }];
  });
}

function listListeningProcesses(ports, deadline = Date.now() + PROCESS_PROBE_TIMEOUT_MS) {
  const listeners = [];
  for (const port of ports) {
    const timeoutMs = remainingMs(deadline);
    if (timeoutMs <= 0) throw deadlineError(`listener discovery for port ${port}`);
    let output;
    try {
      output = execFileSync(
        'lsof',
        ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        {
          encoding: 'utf8',
          maxBuffer: 256 * 1024,
          timeout: timeoutMs,
        },
      );
    } catch (error) {
      if (error?.status === 1) {
        if (remainingMs(deadline) <= 0) throw deadlineError(`listener discovery for port ${port}`);
        continue;
      }
      if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
        throw deadlineError(`listener discovery for port ${port}`);
      }
      throw error;
    }
    for (const line of output.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1) listeners.push({ pid, port });
    }
  }
  return listeners;
}

function processIdentityIsAlive(identity, deadline = Date.now() + PROCESS_PROBE_TIMEOUT_MS) {
  return listProcesses(deadline).some((process) => processMatchesIdentity(process, [identity]));
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function listenOnPort(port, deadline = Date.now() + HARNESS_TIMEOUT_MS) {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) throw deadlineError(`port ${port} availability check`);
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      try {
        server.close(() => {});
      } catch {
        // The server may not have reached the listening state.
      }
      reject(deadlineError(`port ${port} availability check`));
    }, timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => {
      settle(error);
    };
    const onListening = () => {
      settle(undefined, server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function assertPortAvailable(port, deadline = Date.now() + HARNESS_TIMEOUT_MS) {
  let lastError;
  while (remainingMs(deadline) > 0) {
    try {
      const server = await listenOnPort(port, deadline);
      await closeServerWithDeadline(server, deadline);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE' && !/teardown deadline exhausted/.test(error?.message || '')) {
        throw error;
      }
      const delayMs = Math.min(CLEANUP_POLL_MS, remainingMs(deadline));
      if (delayMs <= 0) break;
      await sleep(delayMs);
    }
  }
  throw new Error(
    `port ${port} remained occupied before teardown deadline: ${lastError?.message || 'unknown error'}`,
  );
}

async function freePort() {
  const deadline = Date.now() + HARNESS_TIMEOUT_MS;
  const server = await listenOnPort(0, deadline);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await closeServerWithDeadline(server, deadline);
  return port;
}

async function waitForJson(url, child, output, bearer, label, predicate) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        let body;
        try {
          body = JSON.parse(bodyText);
        } catch {
          lastError = 'response was not JSON';
          body = undefined;
        }
        if (body !== undefined && predicate(body)) return body;
        if (body !== undefined) lastError = 'response did not satisfy readiness predicate';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(
    `${label} did not become ready (${lastError})\nstderr:\n${redact(output.stderr, [bearer])}`,
  );
}

async function waitForAgentMemoryReady(baseUrl, child, output, bearer) {
  const health = await waitForJson(
    `${baseUrl}/agentmemory/health`,
    child,
    output,
    bearer,
    'authenticated AgentMemory health',
    (body) => body && ['healthy', 'degraded'].includes(body.status),
  );
  const readiness = await waitForJson(
    `${baseUrl}/agentmemory/mcp/tools`,
    child,
    output,
    bearer,
    'authenticated AgentMemory MCP readiness',
    (body) => Array.isArray(body) || Boolean(body && Array.isArray(body.tools)),
  );
  return { health, readiness };
}

function signalProcessGroup(processGroupId, signal) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1 || processGroupId === process.pid) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processMatchesIdentity(processInfo, identityMarkers) {
  return identityMarkers.some((marker) => {
    if (!marker || !processInfo?.command) return false;
    const escaped = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"'])`).test(processInfo.command);
  });
}

function normalizeListenerRecords(listeners) {
  if (!Array.isArray(listeners)) return [];
  return listeners.flatMap((listener) => {
    if (Number.isInteger(listener) && listener > 1) return [{ pid: listener, port: undefined }];
    if (!listener || !Number.isInteger(listener.pid) || listener.pid <= 1) return [];
    return [{ pid: listener.pid, port: listener.port }];
  });
}

function identityMarkersFor(daemon) {
  return [
    daemon.identity,
    ...(daemon.identityMarkers || []),
  ].filter((marker, index, markers) => marker && markers.indexOf(marker) === index);
}

function discoverOwnedProcessRecords(daemon, processes, listeners) {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const identityMarkers = identityMarkersFor(daemon);
  const ownedListenerPids = new Set([
    ...(daemon.ownedListenerPids || []),
    ...(daemon.ownedListenerRecords || []).map(({ pid }) => pid),
  ]);
  const ownedPids = new Set();
  const ownedGroups = new Set();
  const owned = new Map();

  const addProcess = (processInfo) => {
    if (
      !processInfo
      || processInfo.pid <= 1
      || processInfo.pid === process.pid
      || processInfo.state?.startsWith('Z')
    ) return false;
    if (!ownedPids.has(processInfo.pid)) {
      ownedPids.add(processInfo.pid);
      owned.set(processInfo.pid, {
        pid: processInfo.pid,
        processGroupId: processInfo.processGroupId,
        identity: daemon.identity,
        state: processInfo.state,
        command: processInfo.command,
      });
      ownedGroups.add(processInfo.processGroupId);
      return true;
    }
    return false;
  };

  for (const processGroupId of [
    daemon.processGroupId,
    ...(daemon.ownedProcessGroups || []).map(({ processGroupId: groupId }) => groupId),
    ...(daemon.ownedProcessRecords || []).map(({ processGroupId: groupId }) => groupId),
  ]) {
    if (Number.isInteger(processGroupId) && processGroupId > 1 && processGroupId !== process.pid) {
      ownedGroups.add(processGroupId);
    }
  }

  for (const pid of daemon.ownedPids || []) {
    const processInfo = byPid.get(pid);
    if (processInfo) addProcess(processInfo);
  }

  for (const processInfo of processes) {
    if (
      processMatchesIdentity(processInfo, identityMarkers)
    ) {
      addProcess(processInfo);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (
        ownedPids.has(processInfo.parentPid)
        || ownedGroups.has(processInfo.processGroupId)
      ) {
        changed = addProcess(processInfo) || changed;
      }
    }
  }

  const listenerRecords = normalizeListenerRecords(listeners);
  for (const listener of listenerRecords) {
    const processInfo = byPid.get(listener.pid);
    if (!processInfo) continue;
    if (
      ownedPids.has(listener.pid)
      || processMatchesIdentity(processInfo, identityMarkers)
      || ownedGroups.has(processInfo.processGroupId)
      || ownedListenerPids.has(listener.pid)
    ) {
      addProcess(processInfo);
    }
  }

  const records = [...owned.values()].sort((left, right) => left.pid - right.pid);
  const groups = [...new Set(records.map(({ processGroupId }) => processGroupId))]
    .filter((processGroupId) => processGroupId > 1)
    .sort((left, right) => left - right)
    .map((processGroupId) => ({ processGroupId, identity: daemon.identity }));
  const ownedListeners = listenerRecords.filter(({ pid }) => ownedPids.has(pid));
  return { records, groups, listeners: ownedListeners };
}

function refreshOwnedProcessRecords(daemon, deadline) {
  const errors = [];
  let processes;
  let listeners = [];
  if (remainingMs(deadline) > 0) {
    try {
      processes = typeof daemon.processProbe === 'function'
        ? daemon.processProbe(deadline)
        : listProcesses(deadline);
    } catch (error) {
      errors.push(`process discovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push('process discovery: teardown deadline exhausted');
  }

  if (remainingMs(deadline) > 0) {
    try {
      listeners = typeof daemon.listenerProbe === 'function'
        ? daemon.listenerProbe(deadline)
        : listListeningProcesses(daemon.ports, deadline);
    } catch (error) {
      errors.push(`listener discovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push('listener discovery: teardown deadline exhausted');
  }

  const discovered = processes
    ? discoverOwnedProcessRecords(daemon, processes, listeners)
    : {
      records: daemon.ownedProcessRecords || [],
      groups: daemon.ownedProcessGroups || [],
      listeners: daemon.ownedListenerRecords || [],
    };
  const snapshot = {
    ...discovered,
    probeErrors: errors,
    observedAt: Date.now(),
  };
  daemon.ownedProcessRecords = snapshot.records;
  daemon.ownedProcessGroups = snapshot.groups;
  daemon.ownedListenerRecords = snapshot.listeners;
  daemon.ownedPids = snapshot.records.map(({ pid }) => pid);
  daemon.initialOwnershipSnapshot ||= snapshot;
  daemon.lastOwnershipSnapshot = snapshot;
  return snapshot;
}

function signalOwnedProcesses(daemon, snapshot, signal) {
  const signaledGroups = new Set();
  for (const group of snapshot.groups) {
    const member = snapshot.records.find((record) => record.processGroupId === group.processGroupId);
    if (!member || member.pid <= 1 || member.pid === process.pid) continue;
    signalProcessGroup(group.processGroupId, signal);
    signaledGroups.add(group.processGroupId);
  }
  for (const record of snapshot.records) {
    if (
      record.pid <= 1
      || record.pid === process.pid
      || (signaledGroups.has(record.processGroupId) && signal !== 'SIGKILL')
    ) continue;
    try {
      process.kill(record.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

async function waitForChildExit(child, deadline) {
  if (!child || child.exitCode !== null) return true;
  while (remainingMs(deadline) > 0) {
    if (child.exitCode !== null || !processIsAlive(child.pid, deadline)) return true;
    await sleep(Math.min(CLEANUP_POLL_MS, remainingMs(deadline)));
  }
  return child.exitCode !== null;
}

function hasOwnedSurvivors(snapshot) {
  return snapshot.probeErrors.length > 0
    || snapshot.records.length > 0
    || snapshot.listeners.length > 0;
}

async function waitForOwnedAbsence(daemon, deadline, phaseDeadline) {
  let stableSamples = 0;
  let snapshot = daemon.lastOwnershipSnapshot || refreshOwnedProcessRecords(daemon, deadline);
  while (remainingMs(deadline) > 0 && Date.now() < phaseDeadline) {
    snapshot = refreshOwnedProcessRecords(daemon, deadline);
    if (!hasOwnedSurvivors(snapshot)) {
      stableSamples += 1;
      if (stableSamples >= STABLE_ABSENCE_SAMPLES) return snapshot;
    } else {
      stableSamples = 0;
    }
    const delayMs = Math.min(
      CLEANUP_POLL_MS,
      remainingMs(deadline),
      Math.max(0, phaseDeadline - Date.now()),
    );
    if (delayMs > 0) await sleep(delayMs);
  }
  return snapshot;
}

function ownershipReport(daemon, snapshot, reason) {
  const records = snapshot.records.map(({ pid, processGroupId, identity, state, command }) => (
    `${pid}/${processGroupId} identity=${identity}${state ? ` state=${state}` : ''}${command ? ` command=${command}` : ''}`
  ));
  const listeners = snapshot.listeners.map(({ pid, port }) => `${pid}${port ? `:${port}` : ''}`);
  const probes = snapshot.probeErrors.length > 0 ? ` probes=${snapshot.probeErrors.join(' | ')}` : '';
  const ports = daemon.lastPortErrors?.length > 0
    ? ` port-checks=${daemon.lastPortErrors.join(' | ')}`
    : '';
  return `${reason}; owned processes=[${records.join('; ')}]; `
    + `owned groups=[${snapshot.groups.map(({ processGroupId }) => processGroupId).join(', ')}]; `
    + `owned listeners=[${listeners.join(', ')}]${probes}${ports}`;
}

async function stopOwnedDaemon(daemon, { deadline = undefined } = {}) {
  if (daemon.closed) return;

  const teardownDeadline = deadline
    ?? daemon.cleanupDeadline
    ?? Date.now() + (daemon.cleanupTimeoutMs || CLEANUP_TIMEOUT_MS);
  daemon.lastPortErrors = [];
  let snapshot = refreshOwnedProcessRecords(daemon, teardownDeadline);
  try {
    signalOwnedProcesses(daemon, snapshot, 'SIGTERM');
    const termDeadline = Math.min(teardownDeadline, Date.now() + TERM_GRACE_MS);
    await waitForChildExit(daemon.child, termDeadline);
    snapshot = await waitForOwnedAbsence(
      daemon,
      teardownDeadline,
      termDeadline,
    );

    if (hasOwnedSurvivors(snapshot) && remainingMs(teardownDeadline) > 0) {
      snapshot = refreshOwnedProcessRecords(daemon, teardownDeadline);
      signalOwnedProcesses(daemon, snapshot, 'SIGKILL');
      await waitForChildExit(daemon.child, teardownDeadline);
      snapshot = await waitForOwnedAbsence(daemon, teardownDeadline, teardownDeadline);
    }

    if (remainingMs(teardownDeadline) > 0) {
      snapshot = refreshOwnedProcessRecords(daemon, teardownDeadline);
    }
    if (hasOwnedSurvivors(snapshot)) {
      throw new Error(ownershipReport(daemon, snapshot, 'owned AgentMemory teardown deadline exhausted'));
    }

    if (daemon.ports.length > 0) {
      if (remainingMs(teardownDeadline) <= 0) {
        throw new Error(ownershipReport(daemon, snapshot, 'owned AgentMemory teardown deadline exhausted'));
      }
      const portResults = await Promise.allSettled(
        daemon.ports.map((port) => assertPortAvailable(port, teardownDeadline)),
      );
      daemon.lastPortErrors = portResults.flatMap((result, index) => (
        result.status === 'rejected'
          ? [`${daemon.ports[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []
      ));
      if (daemon.lastPortErrors.length > 0) {
        throw new Error(ownershipReport(daemon, snapshot, 'owned AgentMemory listener teardown incomplete'));
      }
    }
    daemon.cleanupIncomplete = false;
    daemon.closed = true;
  } catch (error) {
    daemon.cleanupIncomplete = true;
    daemon.lastOwnershipReport = ownershipReport(
      daemon,
      snapshot,
      error instanceof Error ? error.message : String(error),
    );
    throw new Error(daemon.lastOwnershipReport);
  }
}

function assertNoSecretOnDisk(root, bearer) {
  const visit = (currentPath) => {
    for (const name of fs.readdirSync(currentPath)) {
      const entryPath = path.join(currentPath, name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(entryPath);
      } else if (stat.isFile()) {
        const contents = fs.readFileSync(entryPath);
        assert.equal(
          contents.includes(Buffer.from(bearer)),
          false,
          `temporary harness file contains the bearer: ${path.relative(root, entryPath)}`,
        );
      }
    }
  };
  visit(root);
}

async function closeServerWithDeadline(server, deadline = Date.now() + HARNESS_TIMEOUT_MS) {
  if (!server.listening) return;
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) throw deadlineError('server close');
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      settle(deadlineError('server close'));
    }, timeoutMs);
    server.close((error) => settle(error || undefined));
  });
}

function createObsidianImportHarness({ bearer, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-import-harness-'));
  const vaultPath = path.join(root, 'vault');
  const memoriesPath = path.join(vaultPath, 'memories');
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const logDir = path.join(root, 'logs');
  const configDir = path.join(root, 'config');
  const tempDir = path.join(root, 'tmp');
  const securityPath = path.join(root, 'security');
  const securityLog = path.join(root, 'security-invocations.log');
  const harnessBearer = bearer || `obsidian-harness-bearer-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;

  for (const directory of [memoriesPath, dataDir, runtimeDir, logDir, configDir, tempDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    securityPath,
    '#!/bin/sh\n'
      + 'set -eu\n'
      + ': "${AGENTMEMORY_IMPORT_SECURITY_LOG:?}"\n'
      + 'printf "%s\\n" "$*" >> "$AGENTMEMORY_IMPORT_SECURITY_LOG"\n'
      + 'if [ "${AGENTMEMORY_IMPORT_SECURITY_FAIL:-0}" = 1 ]; then exit 1; fi\n'
      + 'printf "%s\\n" "${AGENTMEMORY_IMPORT_TEST_BEARER:-}"\n',
    { mode: 0o700 },
  );
  fs.chmodSync(securityPath, 0o700);

  let endpoint;
  let daemon;
  let closed = false;
  const harness = {
    root,
    vaultPath,
    memoriesPath,
    dataDir,
    runtimeDir,
    logDir,
    configDir,
    tempDir,
    securityPath,
    securityLog,
    bearer: harnessBearer,
    cleanupTimeoutMs,
    writeNote(name, contents) {
      if (!name.endsWith('.md') || name.includes('/') || name.includes('\\')) {
        throw new Error(`fixture note must be a direct Markdown child: ${name}`);
      }
      fs.writeFileSync(path.join(memoriesPath, name), contents);
    },
    importerEnvironment(overrides = {}) {
      return {
        AGENTMEMORY_IMPORT_SECURITY_BIN: securityPath,
        AGENTMEMORY_IMPORT_SECURITY_LOG: securityLog,
        AGENTMEMORY_IMPORT_TEST_BEARER: harnessBearer,
        AGENTMEMORY_IMPORT_SECURITY_FAIL: '0',
        AGENTMEMORY_SECRET: '',
        AGENTMEMORY_URL: 'http://127.0.0.1:1',
        ...overrides,
      };
    },
    async close() {
      if (closed) return;
      const deadline = Date.now() + cleanupTimeoutMs;
      let firstError;
      if (daemon) {
        try {
          await stopOwnedDaemon(daemon, { deadline });
        } catch (error) {
          firstError = error;
        }
      }
      if (endpoint) {
        try {
          await endpoint.close(deadline);
        } catch (error) {
          firstError ||= error;
        }
      }

      const daemonSurvived = daemon && (
        daemon.cleanupIncomplete
        || daemon.lastOwnershipSnapshot?.records.length > 0
        || daemon.lastOwnershipSnapshot?.listeners.length > 0
        || daemon.lastOwnershipSnapshot?.probeErrors.length > 0
      );
      if (!daemonSurvived) {
        try {
          assertNoSecretOnDisk(root, harnessBearer);
        } catch (error) {
          firstError ||= error;
        }
      }
      if (!firstError && !daemonSurvived) {
        fs.rmSync(root, { recursive: true, force: true });
        closed = true;
      }
      if (firstError) throw firstError;
    },
  };

  Object.defineProperty(harness, 'endpoint', {
    get: () => endpoint,
    set: (value) => { endpoint = value; },
  });
  Object.defineProperty(harness, 'daemon', {
    get: () => daemon,
    set: (value) => { daemon = value; },
  });
  return harness;
}

async function startMockImportEndpoint(harness, handler) {
  if (typeof handler !== 'function') throw new TypeError('mock import endpoint handler is required');
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks);
      let payload = null;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        // The harness records malformed requests and lets the handler decide the response.
      }
      const requestInfo = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        payload,
        bodyBytes: raw.byteLength,
      };
      requests.push(requestInfo);
      try {
        const result = await handler(requestInfo);
        const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        response.writeHead(result.status || 200, { 'content-type': 'application/json' });
        response.end(body);
      } catch {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture endpoint handler failed' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    closed: false,
    async close(deadline = Date.now() + HARNESS_TIMEOUT_MS) {
      if (endpoint.closed) return;
      await closeServerWithDeadline(server, deadline);
      await assertPortAvailable(endpoint.port, deadline);
      endpoint.closed = true;
    },
  };
  harness.endpoint = endpoint;
  return endpoint;
}

async function startPackagedAgentMemory(harness, packagePath) {
  if (!harness || typeof harness.root !== 'string') throw new TypeError('harness is required');
  if (!packagePath) throw new TypeError('packaged AgentMemory path is required');

  const ports = [];
  for (let index = 0; index < 4; index += 1) ports.push(await freePort());
  const [restPort, streamPort, viewerPort, enginePort] = ports;
  const output = { stdout: '', stderr: '' };
  const daemon = spawn(
    path.join(packagePath, 'bin/agentmemory'),
    ['--port', String(restPort), '--data-dir', harness.dataDir],
    {
      cwd: harness.root,
      detached: true,
      env: {
        ...process.env,
        HOME: harness.root,
        USERPROFILE: harness.root,
        TMPDIR: harness.tempDir,
        XDG_CONFIG_HOME: harness.configDir,
        AGENTMEMORY_PROVIDER: 'noop',
        AGENTMEMORY_SECRET: harness.bearer,
        AGENTMEMORY_SECRET_REFERENCE: '',
        AGENTMEMORY_DATA_DIR: harness.dataDir,
        AGENTMEMORY_RUNTIME_DIR: harness.runtimeDir,
        AGENTMEMORY_LOG_DIR: harness.logDir,
        AGENTMEMORY_AUTO_COMPRESS: 'false',
        CONSOLIDATION_ENABLED: 'false',
        GRAPH_EXTRACTION_ENABLED: 'false',
        III_REST_PORT: String(restPort),
        III_STREAM_PORT: String(streamPort),
        III_VIEWER_PORT: String(viewerPort),
        III_ENGINE_PORT: String(enginePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.ok(daemon.pid, 'packaged AgentMemory daemon must have a PID');
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { output.stdout += chunk; });
  daemon.stderr.on('data', (chunk) => { output.stderr += chunk; });

  const record = {
    child: daemon,
    pid: daemon.pid,
    processGroupId: daemon.pid,
    identity: harness.root,
    identityMarkers: [
      harness.root,
      harness.dataDir,
      harness.runtimeDir,
      harness.logDir,
      harness.configDir,
      harness.tempDir,
    ],
    ownedPids: [daemon.pid],
    ownedProcessRecords: [{ pid: daemon.pid, processGroupId: daemon.pid, identity: harness.root }],
    ownedProcessGroups: [{ processGroupId: daemon.pid, identity: harness.root }],
    ownedListenerRecords: [],
    ports,
    restPort,
    baseUrl: `http://127.0.0.1:${restPort}`,
    dataDir: harness.dataDir,
    runtimeDir: harness.runtimeDir,
    logDir: harness.logDir,
    output,
    cleanupTimeoutMs: harness.cleanupTimeoutMs,
    closed: false,
    async close() {
      await stopOwnedDaemon(record);
    },
  };
  harness.daemon = record;

  try {
    await waitForAgentMemoryReady(record.baseUrl, daemon, output, harness.bearer);
    const startupDeadline = Date.now() + HARNESS_TIMEOUT_MS;
    const startupOwnership = refreshOwnedProcessRecords(record, startupDeadline);
    if (startupOwnership.probeErrors.length > 0) {
      throw new Error(ownershipReport(record, startupOwnership, 'unable to discover packaged AgentMemory ownership'));
    }
    return record;
  } catch (error) {
    try {
      await stopOwnedDaemon(record);
    } catch (cleanupError) {
      throw new Error(
        `${redact(error instanceof Error ? error.message : error, [harness.bearer])}; `
          + `daemon cleanup failed: ${redact(cleanupError.message, [harness.bearer])}`,
      );
    }
    throw new Error(redact(error instanceof Error ? error.message : error, [harness.bearer]));
  }
}

async function withObsidianImportHarness(callback, options = {}) {
  const previousTurn = harnessTurn;
  let releaseTurn;
  harnessTurn = new Promise((resolve) => { releaseTurn = resolve; });
  await previousTurn;
  let harness;
  try {
    harness = createObsidianImportHarness(options);
    return await callback(harness);
  } finally {
    try {
      if (harness) await harness.close();
    } finally {
      releaseTurn();
    }
  }
}

module.exports = {
  assertPortAvailable,
  createObsidianImportHarness,
  isProcessAlive: processIsAlive,
  isProcessGroupAlive: processGroupIsAlive,
  isProcessIdentityAlive: processIdentityIsAlive,
  listListeningProcesses,
  startMockImportEndpoint,
  startPackagedAgentMemory,
  stopOwnedDaemon,
  withObsidianImportHarness,
};
