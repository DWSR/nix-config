'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const syntheticSecrets = Object.freeze({
  'mcpproxy-api-key': 'runtime-fixture-api-key',
  'mcp-github-token': 'runtime-fixture-github-token',
  'agentmemory-bearer': 'runtime-fixture-agentmemory-bearer',
});
const expectedServers = Object.freeze(['agentmemory', 'github', 'time', 'git-mcp']);
const cleanupTimeoutMs = 10_000;
const processProbeTimeoutMs = 250;

function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function renderRuntimeConfig(homeDirectory, configHome, listenPort) {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [
      flake.outputs.overlays.unstable-packages
      flake.outputs.overlays.custom-packages
    ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = ${JSON.stringify(homeDirectory)};
        home.stateVersion = "26.05";
        xdg.configHome = ${JSON.stringify(configHome)};
        home.mcp = {
          listenPort = ${listenPort};
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets = {
            "mcpproxy-api-key" = "fixture-api-key-reference";
            "mcp-github-token" = "fixture-github-token-reference";
            "agentmemory-bearer" = "fixture-agentmemory-reference";
          };
        };
        programs.agentmemory = {
          enable = true;
          dataDir = ${JSON.stringify(path.join(homeDirectory, 'agentmemory-data'))};
          runtimeDir = ${JSON.stringify(path.join(homeDirectory, 'agentmemory-runtime'))};
          logDir = ${JSON.stringify(path.join(homeDirectory, 'agentmemory-logs'))};
          bearerReference = "agentmemory-bearer";
        };
      }
    ];
  }).config;
  sourceConfigPath = ${JSON.stringify(path.join(configHome, 'mcpproxy', 'mcp_config.json'))};
  runtimeConfigPath = ${JSON.stringify(path.join(homeDirectory, '.mcpproxy', 'runtime-config', 'mcp_config.json'))};
  mcpConfigText = builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text;
  programArguments = map builtins.unsafeDiscardStringContext hm.launchd.agents.mcpproxy.config.ProgramArguments;
  wrapperPath = builtins.head hm.launchd.agents.mcpproxy.config.ProgramArguments;
in builtins.toJSON {
  configText = mcpConfigText;
  configHash = hm.launchd.agents.mcpproxy.config.EnvironmentVariables.MCPPROXY_CONFIG_HASH;
  inherit sourceConfigPath runtimeConfigPath;
  inherit programArguments;
  wrapperText = builtins.unsafeDiscardStringContext (builtins.readFile wrapperPath);
})`;

  return JSON.parse(execFileSync(
    'nix',
    ['eval', '--impure', '--raw', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  ));
}

function writeFakeSecurity(root) {
  const securityPath = path.join(root, 'fake-security');
  fs.writeFileSync(
    securityPath,
    `#!/bin/sh
case "\${5:-}" in
  mcpproxy-api-key) printf '%s' '${syntheticSecrets['mcpproxy-api-key']}' ;;
  mcp-github-token) printf '%s' '${syntheticSecrets['mcp-github-token']}' ;;
  agentmemory-bearer) printf '%s' '${syntheticSecrets['agentmemory-bearer']}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return securityPath;
}

function redact(text) {
  return Object.values(syntheticSecrets).reduce(
    (value, secret) => value.replaceAll(secret, '[REDACTED]'),
    String(text || ''),
  );
}

function deadlineError(operation) {
  return new Error(`${operation} exceeded teardown deadline`);
}

function processRecords(deadline = Date.now() + processProbeTimeoutMs, command = 'ps') {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) throw deadlineError('process discovery');
  let output;
  try {
    output = execFileSync(
      command,
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

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function listeningRecords(port, deadline = Date.now() + processProbeTimeoutMs, command = 'lsof') {
  if (!Number.isInteger(port) || port <= 0) return [];
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) throw deadlineError(`listener discovery for port ${port}`);
  let output;
  try {
    output = execFileSync(
      command,
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
      return [];
    }
    if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
      throw deadlineError(`listener discovery for port ${port}`);
    }
    throw error;
  }
  return output.split('\n').flatMap((line) => {
    const pid = Number(line.trim());
    return Number.isInteger(pid) && pid > 1 ? [{ pid, port }] : [];
  });
}

function listenForPort(port, deadline) {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`port ${port} availability check exceeded teardown deadline`));
  }
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settle(new Error(`port ${port} availability check exceeded teardown deadline`));
      try {
        server.close(() => {});
      } catch {
        // The probe may not have reached the listening state.
      }
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
    const onError = (error) => settle(error);
    const onListening = () => settle(undefined, server);
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeProbeServer(server, deadline) {
  if (!server.listening) return Promise.resolve();
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) {
    return Promise.reject(new Error('port availability probe close exceeded teardown deadline'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // The probe is already being abandoned at the deadline.
      }
      reject(new Error('port availability probe close exceeded teardown deadline'));
    }, timeoutMs);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function assertPortAvailable(port, deadline) {
  let lastError;
  while (remainingMs(deadline) > 0) {
    try {
      const server = await listenForPort(port, deadline);
      await closeProbeServer(server, deadline);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
      const delayMs = Math.min(50, remainingMs(deadline));
      if (delayMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `port ${port} remained occupied before teardown deadline: ${lastError?.message || 'unknown error'}`,
  );
}

function processMatchesIdentity(record, identityMarkers, commandIdentity) {
  if (commandIdentity && record.command === commandIdentity) return true;
  return identityMarkers.some((marker) => {
    if (!marker || !record?.command) return false;
    const escaped = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"'])`).test(record.command);
  });
}

function discoverOwnedRecords(records, {
  processGroupId,
  rootPid,
  identityMarkers = [],
  commandIdentity,
  capturedRecords = [],
  listenerPids,
} = {}) {
  const identityGroupId = Number.isInteger(processGroupId) && processGroupId > 1
    ? processGroupId
    : undefined;
  const capturedByPid = new Map(
    capturedRecords
      .filter((record) => Number.isInteger(record?.pid) && record.pid > 1)
      .map((record) => [record.pid, record]),
  );
  const ownedPids = new Set();
  const ownedGroups = new Set();

  const addCapturedIdentity = (record) => {
    const current = records.find((candidate) => candidate.pid === record.pid);
    if (
      current
      && current.processGroupId === record.processGroupId
      && current.command === record.command
    ) {
      ownedPids.add(current.pid);
      if (current.processGroupId > 1) ownedGroups.add(current.processGroupId);
    }
  };
  for (const record of capturedByPid.values()) addCapturedIdentity(record);

  const rootRecord = records.find((record) => record.pid === rootPid);
  const rootMatchesIdentity = rootRecord && (
    processMatchesIdentity(rootRecord, identityMarkers, commandIdentity)
    || (!identityMarkers.length && !commandIdentity)
  );
  if (!capturedByPid.size && rootMatchesIdentity && identityGroupId === rootRecord.processGroupId) {
    ownedPids.add(rootRecord.pid);
    ownedGroups.add(identityGroupId);
  }

  for (const record of records) {
    if (
      ownedGroups.has(record.processGroupId)
      && processMatchesIdentity(record, identityMarkers, commandIdentity)
    ) {
      ownedPids.add(record.pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        (ownedPids.has(record.parentPid) || ownedGroups.has(record.processGroupId))
        && !ownedPids.has(record.pid)
      ) {
        ownedPids.add(record.pid);
        changed = true;
      }
    }
  }
  const owned = records.filter((record) => (
    ownedGroups.has(record.processGroupId)
    || ownedPids.has(record.pid)
  ) && !record.state.startsWith('Z'));
  if (listenerPids && !owned.some((record) => listenerPids.includes(record.pid))) return [];
  return owned;
}

function ownedRecords(root, processGroupId, rootPid, {
  deadline = Date.now() + processProbeTimeoutMs,
  identityMarkers = [],
  commandIdentity,
  capturedRecords = [],
  processCommand = 'ps',
  listenerCommand = 'lsof',
  expectedPort,
} = {}) {
  const records = processRecords(deadline, processCommand);
  const listenerPids = Number.isInteger(expectedPort) && expectedPort > 0
    ? listeningRecords(expectedPort, deadline, listenerCommand).map(({ pid }) => pid)
    : [];
  const markers = [root, ...identityMarkers].filter(
    (marker, index, all) => marker && all.indexOf(marker) === index,
  );
  return discoverOwnedRecords(records, {
    processGroupId,
    rootPid,
    identityMarkers: markers,
    commandIdentity,
    capturedRecords,
    listenerPids,
  });
}

function signalProcessGroup(processGroupId, signal, deadline) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1 || processGroupId === process.pid) return;
  if (deadline !== undefined && remainingMs(deadline) <= 0) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function signalOwnedRecords(records, signal, deadline) {
  for (const processGroupId of new Set(records.map((record) => record.processGroupId))) {
    signalProcessGroup(processGroupId, signal, deadline);
  }
  for (const record of records) {
    if (deadline !== undefined && remainingMs(deadline) <= 0) return;
    if (record.pid <= 1 || record.pid === process.pid) continue;
    try {
      process.kill(record.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function signalCurrentOwnedRecords(root, port, proxy, signal, deadline, ownership) {
  const current = ownedRecords(root, ownership.processGroupId, proxy.pid, {
    ...ownership,
    expectedPort: port,
  });
  if (current.length === 0) return [];
  signalOwnedRecords(current, signal, deadline);
  return current;
}

function refreshProxyOwnership(proxy, root, port, deadline, {
  processCommand = 'ps',
  listenerCommand = 'lsof',
} = {}) {
  if (!proxy?.pid || !Number.isInteger(port) || port <= 0) return;
  const records = processRecords(deadline, processCommand);
  const listenerPids = new Set(listeningRecords(port, deadline, listenerCommand).map(({ pid }) => pid));
  const current = records.find((record) => record.pid === proxy.pid);
  if (
    !current
    || !listenerPids.has(current.pid)
    || !processMatchesIdentity(current, [root, ...(proxy.identityMarkers || [])], proxy.commandIdentity)
  ) return;
  proxy.processGroupId = current.processGroupId;
  proxy.commandIdentity = current.command;
  proxy.ownedRecords = [current];
}

function cleanupEvidence(
  root,
  port,
  configPaths,
  proxy,
  deadline = Date.now() + processProbeTimeoutMs,
  { processCommand = 'ps', listenerCommand = 'lsof' } = {},
) {
  let processes;
  const probeErrors = [];
  if (remainingMs(deadline) <= 0) {
    probeErrors.push('process probe skipped: teardown deadline exhausted');
    processes = [];
  } else {
    try {
      processes = processRecords(deadline, processCommand);
    } catch (error) {
      probeErrors.push(`process probe failed: ${error instanceof Error ? error.message : String(error)}`);
      processes = [];
    }
  }

  let listeners;
  if (remainingMs(deadline) <= 0) {
    probeErrors.push('listener probe skipped: teardown deadline exhausted');
    listeners = [];
  } else {
    try {
      listeners = listeningRecords(port, deadline, listenerCommand);
    } catch (error) {
      probeErrors.push(`listener probe failed: ${error instanceof Error ? error.message : String(error)}`);
      listeners = [];
    }
  }

  const listenerPids = new Set(listeners.map(({ pid }) => pid));
  const ownership = {
    processGroupId: proxy?.processGroupId ?? proxy?.pid,
    rootPid: proxy?.pid,
    identityMarkers: [root, ...(proxy?.identityMarkers || [])],
    commandIdentity: proxy?.commandIdentity,
    capturedRecords: proxy?.ownedRecords || [],
  };
  const owned = discoverOwnedRecords(processes, ownership);
  const relevantProcesses = [
    ...owned,
    ...processes.filter((record) => listenerPids.has(record.pid)),
  ].filter((record, index, all) => all.findIndex((candidate) => candidate.pid === record.pid) === index);
  const processReport = relevantProcesses.length > 0
    ? relevantProcesses.map((record) => (
      `${record.pid}/${record.processGroupId} state=${record.state} command=${record.command}`
    )).join('; ')
    : 'none';
  const listenerReport = listeners.length > 0
    ? listeners.map(({ pid }) => `${pid}:${port}`).join(', ')
    : 'none';
  const paths = [root, ...(configPaths || [])]
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index)
    .map((candidate) => `${candidate}=${fs.existsSync(candidate) ? 'present' : 'missing'}`)
    .join(', ');
  const probeReport = probeErrors.length > 0 ? `; ${probeErrors.join('; ')}` : '';
  return `cleanup evidence retained at ${root}; surviving processes=[${redact(processReport)}]; `
    + `listeners on port ${port}=[${redact(listenerReport)}]; config paths=[${paths}]${probeReport}`;
}

async function terminateProxy(
  proxy,
  root,
  port,
  {
    timeoutMs = cleanupTimeoutMs,
    deadline: suppliedDeadline,
    processCommand = 'ps',
  } = {},
) {
  const deadline = suppliedDeadline ?? Date.now() + timeoutMs;
  const groupId = proxy.processGroupId ?? proxy.pid;
  const ownership = {
    deadline,
    processGroupId: groupId,
    identityMarkers: proxy.identityMarkers || [],
    commandIdentity: proxy.commandIdentity,
    capturedRecords: proxy.ownedRecords || [],
    processCommand,
    expectedPort: port,
  };
  let survivors = signalCurrentOwnedRecords(root, port, proxy, 'SIGTERM', deadline, ownership);

  while (survivors.length > 0 && remainingMs(deadline) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs(deadline))));
    survivors = ownedRecords(root, groupId, proxy.pid, ownership);
  }

  if (survivors.length > 0) {
    survivors = signalCurrentOwnedRecords(root, port, proxy, 'SIGKILL', deadline, ownership);
  }

  while (survivors.length > 0 && remainingMs(deadline) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs(deadline))));
    survivors = ownedRecords(root, groupId, proxy.pid, ownership);
  }

  const cleanupErrors = [];
  if (survivors.length > 0) {
    cleanupErrors.push(`isolated mcpproxy process group survived teardown: ${redact(JSON.stringify(survivors))}`);
  }
  if (remainingMs(deadline) <= 0) {
    cleanupErrors.push(deadlineError('port availability check').message);
  } else {
    try {
      await assertPortAvailable(port, deadline);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('; '));
}

async function cleanupRuntimeFixture(root, temporary) {
  const timeoutMs = temporary.cleanupTimeoutMs ?? cleanupTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const {
    processCommand = 'ps',
    listenerCommand = 'lsof',
  } = temporary.probeCommands || {};
  let cleanupError;
  if (temporary.proxy) {
    try {
      if (!Number.isInteger(temporary.port)) {
        throw new Error('runtime teardown cannot verify an unallocated port');
      }
      refreshProxyOwnership(temporary.proxy, root, temporary.port, deadline, {
        processCommand,
        listenerCommand,
      });
      await terminateProxy(
        temporary.proxy,
        root,
        temporary.port,
        { timeoutMs, deadline, processCommand },
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!cleanupError) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`${message}; ${cleanupEvidence(
      root,
      temporary.port,
      temporary.configPaths,
      temporary.proxy,
      deadline,
      { processCommand, listenerCommand },
    )}`);
  }
}

async function startAdversarialListener(port, commandMarker) {
  const argumentsList = [
    '-e',
    "const net = require('node:net'); const server = net.createServer(); server.listen(Number(process.argv[1]), '127.0.0.1', () => process.stdout.write('ready\\n'));",
    String(port),
  ];
  if (commandMarker) argumentsList.push(commandMarker);
  const listener = spawn(
    process.execPath,
    argumentsList,
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  listener.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (!chunk.includes('ready')) return;
      listener.stdout.removeListener('data', onData);
      resolve();
    };
    listener.stdout.on('data', onData);
    listener.once('error', reject);
    listener.once('exit', (code, signal) => {
      reject(new Error(`adversarial listener exited before readiness (${code ?? signal})`));
    });
  });
  return listener;
}

async function startSignalResistantListener(port, commandMarker) {
  const listener = spawn(
    process.execPath,
    [
      '-e',
      "const net = require('node:net'); const server = net.createServer(); process.on('SIGTERM', () => server.close()); server.listen(Number(process.argv[1]), '127.0.0.1', () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000);",
      String(port),
      commandMarker,
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  listener.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (!chunk.includes('ready')) return;
      listener.stdout.removeListener('data', onData);
      resolve();
    };
    listener.stdout.on('data', onData);
    listener.once('error', reject);
    listener.once('exit', (code, signal) => {
      reject(new Error(`signal-resistant listener exited before readiness (${code ?? signal})`));
    });
  });
  return listener;
}

async function stopDetachedProcess(child) {
  if (!child?.pid) return;
  signalProcessGroup(child.pid, 'SIGKILL');
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
  }
  try {
    child.kill('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
  }
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve();
      }, 1_000);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', onExit);
    });
  }
  child.stdout?.destroy();
}

function serverNames(body) {
  const servers = body?.data?.servers || body?.servers || body?.data;
  return Array.isArray(servers) ? servers.map((server) => server.name).filter(Boolean).sort() : [];
}

async function waitFor(url, proxy, output, options, predicate, label) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1_000) });
      const body = await response.text();
      if (response.ok) {
        const parsed = body ? JSON.parse(body) : {};
        if (predicate(parsed)) return parsed;
        lastError = 'response did not satisfy readiness predicate';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (proxy.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} did not become ready (${lastError})\n${redact(output.stderr)}`);
}

test('runtime teardown rejects an unowned survivor that keeps the allocated port open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-survivor-'));
  const port = await freePort();
  let listener;

  try {
    listener = await startAdversarialListener(port);
    await assert.rejects(
      () => terminateProxy({ pid: -1, exitCode: 0 }, root, port, { timeoutMs: 250 }),
      /port .* remained occupied|listener teardown incomplete/,
    );
    assert.equal(listener.exitCode, null, 'teardown must not kill an unowned listener');
  } finally {
    await stopDetachedProcess(listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown does not kill a valid same-command process group with a root-substring lookalike', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-ownership-'));
  const ownedPort = await freePort();
  const lookalikePort = await freePort();
  let ownedListener;
  let lookalikeListener;

  try {
    ownedListener = await startAdversarialListener(ownedPort, root);
    lookalikeListener = await startAdversarialListener(lookalikePort, `${root}-lookalike`);
    const records = processRecords();
    const ownedRecord = records.find((record) => record.pid === ownedListener.pid);
    const lookalikeRecord = records.find((record) => record.pid === lookalikeListener.pid);

    assert.ok(ownedRecord?.processGroupId > 1, 'owned listener must have a real process group');
    assert.ok(lookalikeRecord?.processGroupId > 1, 'lookalike listener must have a real process group');
    assert.notEqual(ownedRecord.processGroupId, lookalikeRecord.processGroupId);

    await terminateProxy(
      {
        pid: ownedListener.pid,
        processGroupId: ownedRecord.processGroupId,
        identityMarkers: [root],
        exitCode: null,
      },
      root,
      ownedPort,
      { timeoutMs: 2_000 },
    );

    const ownedProcess = processRecords().find((record) => record.pid === ownedListener.pid);
    assert.ok(
      !ownedProcess || ownedProcess.state.startsWith('Z'),
      'teardown must terminate the owned process group',
    );
    assert.equal(lookalikeListener.exitCode, null, 'teardown must not signal the lookalike process group');
    assert.ok(listeningRecords(lookalikePort).some(({ pid }) => pid === lookalikeListener.pid));
  } finally {
    await stopDetachedProcess(lookalikeListener);
    await stopDetachedProcess(ownedListener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown does not kill an exact marker match in a separate process group', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-exact-marker-'));
  const ownedPort = await freePort();
  const separatePort = await freePort();
  let ownedListener;
  let separateListener;

  try {
    ownedListener = await startAdversarialListener(ownedPort, root);
    separateListener = await startAdversarialListener(separatePort, root);
    const records = processRecords();
    const ownedRecord = records.find((record) => record.pid === ownedListener.pid);
    const separateRecord = records.find((record) => record.pid === separateListener.pid);

    assert.ok(ownedRecord?.processGroupId > 1, 'owned listener must have a real process group');
    assert.ok(separateRecord?.processGroupId > 1, 'separate listener must have a real process group');
    assert.notEqual(ownedRecord.processGroupId, separateRecord.processGroupId);

    await terminateProxy(
      {
        pid: ownedListener.pid,
        processGroupId: ownedRecord.processGroupId,
        identityMarkers: [root],
        commandIdentity: ownedRecord.command,
        ownedRecords: [ownedRecord],
        exitCode: null,
      },
      root,
      ownedPort,
      { timeoutMs: 2_000 },
    );

    assert.equal(separateListener.exitCode, null, 'an exact marker match in another group must survive');
    assert.ok(listeningRecords(separatePort).some(({ pid }) => pid === separateListener.pid));
  } finally {
    await stopDetachedProcess(separateListener);
    await stopDetachedProcess(ownedListener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown does not signal a process group reused by a stale record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-stale-group-'));
  const expectedPort = await freePort();
  const reusedPort = await freePort();
  let reusedListener;

  try {
    reusedListener = await startAdversarialListener(reusedPort, root);
    const currentRecord = processRecords().find((record) => record.pid === reusedListener.pid);
    assert.ok(currentRecord?.processGroupId > 1, 'reused listener must have a real process group');

    const stalePid = 999_999_999;
    const staleCommand = `${currentRecord.command} stale-record`;
    await terminateProxy(
      {
        pid: stalePid,
        processGroupId: currentRecord.processGroupId,
        identityMarkers: [root],
        commandIdentity: staleCommand,
        ownedRecords: [{
          pid: stalePid,
          processGroupId: currentRecord.processGroupId,
          command: staleCommand,
        }],
        exitCode: null,
      },
      root,
      expectedPort,
      { timeoutMs: 2_000 },
    );

    assert.equal(reusedListener.exitCode, null, 'a reused stale PGID must not receive teardown signals');
    assert.ok(listeningRecords(reusedPort).some(({ pid }) => pid === reusedListener.pid));
  } finally {
    await stopDetachedProcess(reusedListener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown does not escalate to SIGKILL after expected-port ownership is lost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-port-reuse-'));
  const port = await freePort();
  let listener;

  try {
    listener = await startSignalResistantListener(port, root);
    const record = processRecords().find((candidate) => candidate.pid === listener.pid);
    assert.ok(record?.processGroupId > 1, 'signal-resistant listener must have a real process group');

    await terminateProxy(
      {
        pid: listener.pid,
        processGroupId: record.processGroupId,
        identityMarkers: [root],
        commandIdentity: record.command,
        ownedRecords: [record],
        exitCode: null,
      },
      root,
      port,
      { timeoutMs: 2_000 },
    );

    assert.equal(listener.exitCode, null, 'SIGKILL must not target a process after its port ownership changes');
    assert.deepEqual(listeningRecords(port), []);
  } finally {
    await stopDetachedProcess(listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown does not run process or listener evidence probes after its deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-deadline-'));
  const probeBin = path.join(root, 'probe-bin');
  const probeLog = path.join(root, 'probe.log');
  const port = await freePort();
  const delayedProbe = (name) => `#!/bin/sh
printf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(probeLog)}
while :; do :; done
`;

  try {
    fs.mkdirSync(probeBin, { recursive: true, mode: 0o700 });
    for (const name of ['ps', 'lsof']) {
      const probePath = path.join(probeBin, name);
      fs.writeFileSync(probePath, delayedProbe(name), { mode: 0o700 });
    }
    const startedAt = Date.now();
    await assert.rejects(
      () => cleanupRuntimeFixture(root, {
        proxy: { pid: -1, exitCode: 0 },
        port,
        configPaths: [],
        cleanupTimeoutMs: 500,
        probeCommands: {
          processCommand: path.join(probeBin, 'ps'),
          listenerCommand: path.join(probeBin, 'lsof'),
        },
      }),
      (error) => {
        assert.match(error.message, /cleanup evidence retained at/);
        assert.match(error.message, /deadline|probe/i);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 900, 'teardown evidence must remain bounded by its deadline');
    assert.deepEqual(
      fs.readFileSync(probeLog, 'utf8').trim().split('\n'),
      ['ps'],
      'listener evidence must not invoke lsof after the process probe consumes the deadline',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime teardown retains cleanup evidence when a listener survives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-evidence-'));
  const configPath = path.join(root, 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, '{}', { mode: 0o600 });
  const port = await freePort();
  let listener;

  try {
    listener = await startAdversarialListener(port);
    const temporary = {
      proxy: { pid: -1, exitCode: 0 },
      port,
      configPaths: [configPath],
      cleanupTimeoutMs: 250,
    };
    await assert.rejects(
      () => cleanupRuntimeFixture(root, temporary),
      (error) => {
        assert.match(error.message, /cleanup evidence retained at/);
        assert.ok(error.message.includes(root));
        assert.ok(
          error.message.includes(String(listener.pid))
          || /listener probe (?:failed|skipped)/.test(error.message),
        );
        assert.ok(error.message.includes(configPath));
        return true;
      },
    );
    assert.equal(fs.existsSync(root), true);
  } finally {
    await stopDetachedProcess(listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated mcpproxy wrapper refreshes an isolated runtime copy and exposes the cutover inventory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-mcp-runtime-'));
  const configHome = path.join(root, 'config');
  const temporaryDataHome = path.join(root, 'data-home');
  const temporaryStateHome = path.join(root, 'state-home');
  const temporary = {
    proxy: undefined,
    port: undefined,
    configPaths: [],
    cleanupTimeoutMs,
    primaryError: undefined,
    cleanupError: undefined,
  };

  try {
    fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(temporaryDataHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(temporaryStateHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const port = await freePort();
    temporary.port = port;
    const rendered = renderRuntimeConfig(root, configHome, port);
    const securityPath = writeFakeSecurity(root);
    const expectedHash = crypto.createHash('sha256').update(rendered.configText).digest('hex');

    assert.equal(rendered.configHash, expectedHash);
    assert.doesNotMatch(rendered.configText, /op:\/\/|runtime-fixture|obsidianVaultPath|mcp-obsidian/i);
    assert.doesNotMatch(rendered.configText, /memory-sync|cavemem-import-vault/i);
    assert.match(rendered.configText, /"name":"agentmemory"/);
    assert.match(rendered.configText, /"name":"github"/);
    assert.match(rendered.configText, /"name":"time"/);
    assert.match(rendered.configText, /"name":"git-mcp"/);
    assert.doesNotMatch(rendered.configText, /"name":"obsidian"/);

    fs.mkdirSync(path.dirname(rendered.sourceConfigPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(rendered.sourceConfigPath, rendered.configText, { mode: 0o600 });
    const wrapperPath = path.join(root, 'mcpproxy-wrapper');
    temporary.configPaths = [rendered.sourceConfigPath, rendered.runtimeConfigPath, wrapperPath];
    fs.writeFileSync(
      wrapperPath,
      rendered.wrapperText.replaceAll('/usr/bin/security', securityPath),
      { mode: 0o700 },
    );

    const output = { stdout: '', stderr: '' };
    const wrapperArguments = rendered.programArguments.slice(1);
    temporary.proxy = spawn(wrapperPath, wrapperArguments, {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: temporaryDataHome,
        XDG_STATE_HOME: temporaryStateHome,
        TMPDIR: path.join(root, 'tmp'),
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    temporary.proxy.processGroupId = temporary.proxy.pid;
    temporary.proxy.identityMarkers = [rendered.runtimeConfigPath];
    const proxyRecord = processRecords(Date.now() + processProbeTimeoutMs)
      .find((record) => record.pid === temporary.proxy.pid);
    if (proxyRecord) {
      temporary.proxy.processGroupId = proxyRecord.processGroupId;
      temporary.proxy.commandIdentity = proxyRecord.command;
      temporary.proxy.ownedRecords = [proxyRecord];
    }
    temporary.proxy.stdout.setEncoding('utf8');
    temporary.proxy.stderr.setEncoding('utf8');
    temporary.proxy.stdout.on('data', (chunk) => { output.stdout += chunk; });
    temporary.proxy.stderr.on('data', (chunk) => { output.stderr += chunk; });

    await waitFor(
      `http://127.0.0.1:${port}/healthz`,
      temporary.proxy,
      output,
      {},
      () => true,
      'mcpproxy healthz',
    );
    await waitFor(
      `http://127.0.0.1:${port}/readyz`,
      temporary.proxy,
      output,
      {},
      () => true,
      'mcpproxy readyz',
    );
    const inventory = await waitFor(
      `http://127.0.0.1:${port}/api/v1/servers`,
      temporary.proxy,
      output,
      { headers: { 'X-API-Key': syntheticSecrets['mcpproxy-api-key'] } },
      (body) => expectedServers.every((name) => serverNames(body).includes(name)),
      'mcpproxy inventory',
    );

    const names = serverNames(inventory);
    assert.ok(expectedServers.every((name) => names.includes(name)));
    assert.equal(names.includes('obsidian'), false);
    assert.equal(fs.readFileSync(rendered.sourceConfigPath, 'utf8'), rendered.configText);
    const runtimeConfig = JSON.parse(fs.readFileSync(rendered.runtimeConfigPath, 'utf8'));
    assert.equal(runtimeConfig.listen, `127.0.0.1:${port}`);
    assert.equal(runtimeConfig.data_dir, path.join(root, '.mcpproxy'));
    assert.deepEqual(
      runtimeConfig.mcpServers.map((server) => server.name).sort(),
      names,
    );
    assert.equal(runtimeConfig.mcpServers.some((server) => server.name === 'obsidian'), false);
    assert.equal(fs.statSync(rendered.runtimeConfigPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(root, '.agentmemory')), false);
    assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /runtime-fixture-(?:api-key|github-token|agentmemory-bearer)/);
  } catch (error) {
    temporary.primaryError = error;
  } finally {
    try {
      await cleanupRuntimeFixture(root, temporary);
    } catch (error) {
      temporary.cleanupError = error;
    }
  }

  if (temporary.primaryError) {
    if (temporary.cleanupError) temporary.primaryError.cleanupError = temporary.cleanupError;
    throw temporary.primaryError;
  }
  if (temporary.cleanupError) throw temporary.cleanupError;
});
