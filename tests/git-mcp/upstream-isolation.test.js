'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixturePath = path.join(repoRoot, 'tests/git-mcp/fixtures/signing-tools.nix');
const processIdentitySourcePath = path.join(repoRoot, 'tests/git-mcp/fixtures/process-identity.c');
const recordingExecPath = path.join(repoRoot, 'tests/git-mcp/fixtures/recording-exec.js');
const siblingPath = path.join(repoRoot, 'tests/git-mcp/fixtures/sibling-mcp.js');
const signerPath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-signer.nix');
const nixTimeoutMs = 600_000;
const requestTimeoutMs = 30_000;

function nixBuild(expression) {
  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: nixTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ).trim();
}

function buildSigner() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
    in pkgs.callPackage (import ${JSON.stringify(signerPath)}) fixture.nativeToolArgs
  `);
}

function buildGitMcpServer() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    in flake.darwinConfigurations.ShopifyLaptop.pkgs.git-mcp-server
  `);
}

function buildProcessIdentity() {
  return path.join(nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      source = pkgs.writeText "git-mcp-process-identity.c" (
        builtins.readFile ${JSON.stringify(processIdentitySourcePath)}
      );
    in pkgs.runCommand "git-mcp-process-identity" {
      inherit source;
      nativeBuildInputs = [ pkgs.stdenv.cc ];
    } ''
      mkdir -p "$out/bin"
      $CC -std=c11 -Wall -Wextra -Werror "$source" -o "$out/bin/process-identity"
    ''
  `), 'bin/process-identity');
}

function fixtureSummary() {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', `
      let
        flake = builtins.getFlake ${JSON.stringify(repoRoot)};
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
        fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
      in {
        nativeToolPaths = fixture.nativeToolPaths;
        scenario = fixture.scenarios.providerFailure;
      }
    `],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: nixTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ));
}

function resolveCommand(command) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the PATH.
    }
  }
  assert.fail(`${command} is unavailable in the git-mcp check runtime`);
}

function withoutSigningEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (
      name === 'GIT_SIGN_COMMITS'
      || name === 'SSH_SK_PROVIDER'
      || name === 'KEYCHAIN_CERTIFICATES'
      || name === 'GIT_MCP_PROCESS_IDENTITY_HELPER'
      || name === 'GIT_MCP_OWNERSHIP_TOKEN'
      || name.startsWith('GIT_MCP_SIGNING_')
      || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)
    ) {
      delete result[name];
    }
  }
  delete result.SSH_AUTH_SOCK;
  delete result.SSH_AGENT_PID;
  return result;
}

function createSigningState(root, summary) {
  const signingRoot = path.join(root, 'signing');
  const identity = summary.scenario.identitySnapshots.after[0];
  const residentExport = summary.scenario.residentExports[0];
  const identityDir = path.join(signingRoot, 'identities', identity.hash);
  const stubPath = path.join(identityDir, residentExport.stubName);

  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(signingRoot, 'scenario.json'),
    `${JSON.stringify(summary.scenario)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(signingRoot, 'identity-snapshot'), 'after\n', { mode: 0o600 });
  fs.writeFileSync(stubPath, `${residentExport.stub}\n`, { mode: 0o600 });
  fs.writeFileSync(`${stubPath}.pub`, `${residentExport.publicKey}\n`, { mode: 0o644 });

  return { identity, residentExport, signingRoot, stubPath };
}

function runGit(args, cwd, env) {
  const result = childProcess.spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepository(root, env) {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository, { mode: 0o700 });
  runGit(['init', '--quiet', '--initial-branch=main'], repository, env);
  runGit(['config', 'user.name', 'Fixture Git MCP'], repository, env);
  runGit(['config', 'user.email', 'fixture-git-mcp@example.test'], repository, env);
  fs.writeFileSync(path.join(repository, 'initial.txt'), 'initial\n');
  runGit(['add', 'initial.txt'], repository, env);
  runGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'], repository, env);
  fs.writeFileSync(path.join(repository, 'rejected.txt'), 'must remain staged\n');
  runGit(['add', 'rejected.txt'], repository, env);
  return repository;
}

function readCalls(signingRoot) {
  return readJsonLines(path.join(signingRoot, 'calls.jsonl'));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(filePath), `expected fixture file ${filePath}`);
}

async function waitForRecords(filePath, count) {
  const deadline = Date.now() + 3_000;
  let records = [];
  while (Date.now() < deadline) {
    records = readJsonLines(filePath);
    if (records.length >= count) return records;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`expected ${count} process records at ${filePath}, got ${records.length}`);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(exited) {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(exited);
    }
    child.once('close', onClose);
  });
}

function parseProcessIdentity(output, description) {
  const fields = output.trim().split('\t');
  assert.equal(fields.length, 5, `malformed process identity for ${description}: ${output}`);
  return {
    pid: Number(fields[0]),
    processGroup: Number(fields[1]),
    startSeconds: Number(fields[2]),
    startMicroseconds: Number(fields[3]),
    executable: fields[4],
  };
}

function inspectProcessIdentity(identityCommand, pid) {
  const result = childProcess.spawnSync(identityCommand, [String(pid)], { encoding: 'utf8' });
  if (result.status === 3) return null;
  assert.equal(result.status, 0, `cannot inspect process ${pid}: ${result.stderr}`);
  return parseProcessIdentity(result.stdout, `process ${pid}`);
}

function inspectProcessGroup(identityCommand, processGroup) {
  const result = childProcess.spawnSync(
    identityCommand,
    ['--group', String(processGroup)],
    { encoding: 'utf8' },
  );
  if (result.status === 3) return [];
  assert.equal(result.status, 0, `cannot inspect process group ${processGroup}: ${result.stderr}`);
  if (result.stdout.trim() === '') return [];
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => parseProcessIdentity(line, `process group ${processGroup}`));
}

function captureOwnershipRecord(identityCommand, pid, expectedExecutable, role, sessionToken) {
  const identity = inspectProcessIdentity(identityCommand, pid);
  assert.ok(identity, `${role} process ${pid} exited before ownership capture`);
  assert.equal(identity.executable, expectedExecutable, `${role} executable identity`);
  return { ...identity, expectedExecutable, role, sessionToken };
}

async function waitForOwnershipRecord(identityCommand, pid, expectedExecutable, role, sessionToken) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return captureOwnershipRecord(
        identityCommand,
        pid,
        expectedExecutable,
        role,
        sessionToken,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError;
}

function writeOwnershipRecord(filePath, record) {
  fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function scriptInterpreter(scriptPath) {
  const [shebang] = fs.readFileSync(scriptPath, 'utf8').split('\n');
  assert.match(shebang, /^#!/, `${scriptPath} must have a shebang`);
  return fs.realpathSync(shebang.slice(2).trim().split(/\s+/)[0]);
}

function hasProcessIdentity(identity) {
  return identity !== null
    && typeof identity === 'object'
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && Number.isInteger(identity.processGroup)
    && identity.processGroup > 0
    && Number.isInteger(identity.startSeconds)
    && identity.startSeconds >= 0
    && Number.isInteger(identity.startMicroseconds)
    && identity.startMicroseconds >= 0
    && identity.startMicroseconds < 1_000_000
    && typeof identity.executable === 'string'
    && identity.executable !== '';
}

function ownershipMatches(record, observed, sessionToken) {
  return typeof sessionToken === 'string'
    && sessionToken !== ''
    && typeof record?.sessionToken === 'string'
    && record.sessionToken !== ''
    && typeof record?.expectedExecutable === 'string'
    && record.expectedExecutable !== ''
    && hasProcessIdentity(record)
    && hasProcessIdentity(observed)
    && record.sessionToken === sessionToken
    && record.executable === record.expectedExecutable
    && record.pid === observed.pid
    && record.processGroup === observed.processGroup
    && record.startSeconds === observed.startSeconds
    && record.startMicroseconds === observed.startMicroseconds
    && record.executable === observed.executable;
}

function signalOwnedRecord(record, signal, options) {
  const observed = options.inspect(record.pid);
  if (!ownershipMatches(record, observed, options.sessionToken)) return false;
  try {
    options.kill(record.pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function liveOwnedRecords(records, options) {
  return records.filter((record) => ownershipMatches(
    record,
    options.inspect(record.pid),
    options.sessionToken,
  ));
}

function signalOwnedGroup(records, processGroup, signal, options) {
  if (!Number.isInteger(processGroup) || processGroup <= 0) return false;
  const groupRecords = records.filter((record) => record.processGroup === processGroup);
  let groupMembers;
  try {
    groupMembers = options.inspectGroup(processGroup);
  } catch {
    return false;
  }
  if (
    groupRecords.length === 0
    || groupRecords.length !== groupMembers.length
    || !groupRecords.every((record) => (
      ownershipMatches(record, options.inspect(record.pid), options.sessionToken)
    ))
    || !groupRecords.every((record) => groupMembers.some((member) => (
      ownershipMatches(record, member, options.sessionToken)
    )))
    || !groupMembers.every((member) => groupRecords.some((record) => (
      ownershipMatches(record, member, options.sessionToken)
    )))
  ) return false;
  try {
    options.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') return false;
    throw error;
  }
}

async function waitForOwnedExit(records, options, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveOwnedRecords(records, options).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return liveOwnedRecords(records, options).length === 0;
}

async function terminateOwnedProcesses(records, identityCommand, sessionToken) {
  const options = {
    inspect: (pid) => inspectProcessIdentity(identityCommand, pid),
    inspectGroup: (processGroup) => inspectProcessGroup(identityCommand, processGroup),
    kill: process.kill.bind(process),
    sessionToken,
  };
  let survivors = liveOwnedRecords(records, options);
  for (const processGroup of new Set(survivors.map((record) => record.processGroup))) {
    if (!signalOwnedGroup(records, processGroup, 'SIGTERM', options)) {
      for (const record of survivors.filter((entry) => entry.processGroup === processGroup)) {
        signalOwnedRecord(record, 'SIGTERM', options);
      }
    }
  }
  if (!(await waitForOwnedExit(records, options, 3_000))) {
    survivors = liveOwnedRecords(records, options);
    for (const processGroup of new Set(survivors.map((record) => record.processGroup))) {
      signalOwnedGroup(records, processGroup, 'SIGKILL', options);
    }
    for (const record of survivors) signalOwnedRecord(record, 'SIGKILL', options);
  }
  survivors = liveOwnedRecords(records, options);
  assert.deepEqual(
    survivors.map(({ pid, role }) => ({ pid, role })),
    [],
    'owned fixture processes survived cleanup',
  );
}

function validateOwnershipRecord(record, filePath, sessionToken) {
  assert.equal(record.sessionToken, sessionToken, `foreign ownership token in ${filePath}`);
  for (const name of ['pid', 'processGroup', 'startSeconds', 'startMicroseconds']) {
    assert.equal(Number.isInteger(record[name]), true, `invalid ${name} in ${filePath}`);
  }
  for (const name of ['executable', 'expectedExecutable', 'role']) {
    assert.equal(typeof record[name] === 'string' && record[name] !== '', true, `invalid ${name} in ${filePath}`);
  }
  assert.equal(record.executable, record.expectedExecutable, `unexpected executable in ${filePath}`);
}

function fixtureReferencedPids(root) {
  const signingRoot = path.join(root, 'signing');
  const pids = [];
  for (const fileName of ['calls.jsonl', 'events.jsonl']) {
    for (const entry of readJsonLines(path.join(signingRoot, fileName))) pids.push(Number(entry.pid));
  }
  for (const fileName of ['process-tree', 'descendants']) {
    const filePath = path.join(signingRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    pids.push(...fs.readFileSync(filePath, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
  }
  return pids;
}

function discoverOwnershipRecords(root, sessionToken, validateReferences = true) {
  const ownershipDirectory = path.join(root, 'ownership');
  const paths = [
    path.join(ownershipDirectory, 'proxy.jsonl'),
    path.join(ownershipDirectory, 'git-mcp.jsonl'),
    path.join(ownershipDirectory, 'sibling.jsonl'),
    path.join(ownershipDirectory, 'signer.jsonl'),
    path.join(root, 'signing', 'owned-processes.jsonl'),
  ];
  const records = paths.flatMap((filePath) => readJsonLines(filePath).map((record) => {
    validateOwnershipRecord(record, filePath, sessionToken);
    return record;
  }));
  if (validateReferences) {
    const recordedPids = new Set(records.map((record) => record.pid));
    const unownedFixturePids = fixtureReferencedPids(root)
      .filter(Number.isInteger)
      .filter((pid) => !recordedPids.has(pid));
    assert.deepEqual(unownedFixturePids, [], 'fixture PID records lack ownership identity');
  }
  return records;
}

async function cleanupOwnedFixture(root, sessionToken, identityCommand, proxy) {
  const recordsByIdentity = new Map();
  for (let round = 0; round < 3; round += 1) {
    for (const record of discoverOwnershipRecords(root, sessionToken, false)) {
      recordsByIdentity.set(`${record.pid}:${record.startSeconds}:${record.startMicroseconds}`, record);
    }
    await terminateOwnedProcesses([...recordsByIdentity.values()], identityCommand, sessionToken);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const record of discoverOwnershipRecords(root, sessionToken)) {
    recordsByIdentity.set(`${record.pid}:${record.startSeconds}:${record.startMicroseconds}`, record);
  }
  await terminateOwnedProcesses([...recordsByIdentity.values()], identityCommand, sessionToken);
  if (proxy) {
    assert.equal(await waitForChildExit(proxy, 1_000), true, 'mcpproxy child handle did not close');
  }
}

async function runFinalizers(primaryError, finalizers) {
  const cleanupErrors = [];
  for (const finalize of finalizers) {
    try {
      await finalize();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) primaryError.cleanupErrors = cleanupErrors;
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'fixture cleanup failed');
  }
}

async function waitForProxy(proxy, port, apiKey, logs) {
  const deadline = Date.now() + 15_000;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    if (proxy.exitCode !== null || proxy.signalCode !== null) {
      assert.fail(`mcpproxy exited before readiness: ${logs()}`);
    }
    try {
      const [ready, servers] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1_000) }),
        fetch(`http://127.0.0.1:${port}/api/v1/servers`, {
          headers: { 'X-API-Key': apiKey },
          signal: AbortSignal.timeout(1_000),
        }),
      ]);
      const body = servers.ok ? await servers.json() : undefined;
      const connected = body?.data?.servers
        ?.filter((server) => server.connected)
        .map((server) => server.name)
        .sort();
      lastStatus = JSON.stringify({ ready: ready.status, servers: body });
      if (ready.ok && connected?.includes('git-failing') && connected.includes('sibling')) return;
    } catch (error) {
      lastStatus = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`local mcpproxy did not connect both upstreams: ${lastStatus}\n${logs()}`);
}

function parseMessages(text, contentType) {
  if (text.trim() === '') return [];
  if (contentType.includes('text/event-stream')) {
    return text.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

class McpClient {
  constructor(url) {
    this.nextId = 1;
    this.protocolVersion = '2025-06-18';
    this.sessionId = undefined;
    this.url = url;
  }

  async post(method, params, notification = false) {
    const id = notification ? undefined : this.nextId++;
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id }),
        method,
        params,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const responseSession = response.headers.get('mcp-session-id');
    if (responseSession) this.sessionId = responseSession;
    const text = await response.text();
    assert.ok(response.ok, `${method} returned HTTP ${response.status}: ${text}`);
    if (notification) return undefined;
    const message = parseMessages(text, response.headers.get('content-type') || '')
      .find((candidate) => candidate.id === id);
    assert.ok(message, `${method} returned no JSON-RPC response for id ${id}: ${text}`);
    assert.equal(message.error, undefined, `${method} JSON-RPC error: ${JSON.stringify(message.error)}`);
    return message.result;
  }

  async connect() {
    const result = await this.post('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'git-mcp-upstream-isolation-test', version: '1.0.0' },
    });
    this.protocolVersion = result.protocolVersion;
    assert.ok(this.sessionId, 'mcpproxy initialize response omitted mcp-session-id');
    await this.post('notifications/initialized', {}, true);
  }

  async callTool(name, args) {
    return this.post('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.sessionId) return;
    await fetch(this.url, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-session-id': this.sessionId,
        'mcp-protocol-version': this.protocolVersion,
      },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  }
}

function toolResultText(result) {
  return (result.content || [])
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

test('fixture finalization removes temporary state without replacing the primary failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-finalizer-regression-'));
  const primaryError = new Error('primary regression failure');
  const cleanupError = new Error('process cleanup failure');
  let removalAttempted = false;

  await assert.rejects(
    runFinalizers(primaryError, [
      async () => { throw cleanupError; },
      async () => {
        removalAttempted = true;
        fs.rmSync(root, { recursive: true, force: true });
      },
    ]),
    (error) => {
      assert.equal(error, primaryError);
      assert.deepEqual(error.cleanupErrors, [cleanupError]);
      return true;
    },
  );
  assert.equal(removalAttempted, true);
  assert.equal(fs.existsSync(root), false);
});

test('targeted cleanup refuses stale process identity metadata', () => {
  const sessionToken = crypto.randomUUID();
  const observed = {
    pid: 41_001,
    processGroup: 41_001,
    startSeconds: 1_000,
    startMicroseconds: 20,
    executable: '/nix/store/fixture/bin/node',
  };
  const staleRecord = {
    ...observed,
    startMicroseconds: observed.startMicroseconds - 1,
    expectedExecutable: observed.executable,
    role: 'unrelated-reused-process',
    sessionToken,
  };
  const signals = [];

  const signaled = signalOwnedRecord(staleRecord, 'SIGTERM', {
    inspect: () => observed,
    kill: (...args) => signals.push(args),
    sessionToken,
  });

  assert.equal(signaled, false);
  assert.deepEqual(signals, []);
});

test('targeted cleanup refuses a missing session token', () => {
  const observed = {
    pid: 41_001,
    processGroup: 41_001,
    startSeconds: 1_000,
    startMicroseconds: 20,
    executable: '/nix/store/fixture/bin/node',
  };
  const record = {
    ...observed,
    expectedExecutable: observed.executable,
    role: 'unowned-process',
  };
  const signals = [];

  const signaled = signalOwnedRecord(record, 'SIGTERM', {
    inspect: () => observed,
    kill: (...args) => signals.push(args),
  });
  const groupSignaled = signalOwnedGroup(
    [record],
    observed.processGroup,
    'SIGTERM',
    {
      inspect: () => observed,
      inspectGroup: () => [observed],
      kill: (...args) => signals.push(args),
    },
  );

  assert.equal(signaled, false);
  assert.equal(groupSignaled, false);
  assert.deepEqual(signals, []);
});

test('targeted group cleanup refuses stale member identity metadata', () => {
  const sessionToken = crypto.randomUUID();
  const observed = {
    pid: 41_001,
    processGroup: 41_001,
    startSeconds: 1_000,
    startMicroseconds: 20,
    executable: '/nix/store/fixture/bin/node',
  };
  const validRecord = {
    ...observed,
    expectedExecutable: observed.executable,
    role: 'owned-group-member',
    sessionToken,
  };
  const staleObserved = {
    ...observed,
    pid: 41_002,
  };
  const staleRecord = {
    ...staleObserved,
    startMicroseconds: staleObserved.startMicroseconds - 1,
    expectedExecutable: staleObserved.executable,
    role: 'stale-group-member',
    sessionToken,
  };
  const signals = [];

  const signaled = signalOwnedGroup(
    [validRecord, staleRecord],
    observed.processGroup,
    'SIGTERM',
    {
      inspect: (pid) => (pid === observed.pid ? observed : staleObserved),
      inspectGroup: () => [observed, staleObserved],
      kill: (...args) => signals.push(args),
      sessionToken,
    },
  );

  assert.equal(signaled, false);
  assert.deepEqual(signals, []);
});

test('targeted group cleanup refuses unrecorded group members', () => {
  const sessionToken = crypto.randomUUID();
  const observed = {
    pid: 41_001,
    processGroup: 41_001,
    startSeconds: 1_000,
    startMicroseconds: 20,
    executable: '/nix/store/fixture/bin/node',
  };
  const validRecord = {
    ...observed,
    expectedExecutable: observed.executable,
    role: 'owned-group-member',
    sessionToken,
  };
  const unrecordedMember = {
    ...observed,
    pid: 41_002,
    executable: '/nix/store/unrelated/bin/node',
  };
  const signals = [];

  const signaled = signalOwnedGroup(
    [validRecord],
    observed.processGroup,
    'SIGTERM',
    {
      inspect: () => observed,
      inspectGroup: () => [observed, unrecordedMember],
      kill: (...args) => signals.push(args),
      sessionToken,
    },
  );

  assert.equal(signaled, false);
  assert.deepEqual(signals, []);
});

test('recording exec converts a signaled wrapped child into a normal nonzero exit', {
  skip: process.env.GIT_MCP_CHECK_RUNTIME !== '1',
  timeout: 600_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-recording-exec-signal-'));
  const recordPath = path.join(root, 'owned-processes.jsonl');
  const sessionToken = crypto.randomUUID();
  const identityCommand = buildProcessIdentity();
  let wrapper;
  let records = [];

  try {
    wrapper = childProcess.spawn(
      process.execPath,
      [
        recordingExecPath,
        recordPath,
        identityCommand,
        sessionToken,
        'recording-exec-wrapper',
        'recording-exec-child',
        fs.realpathSync(process.execPath),
        process.execPath,
        '-e',
        'setInterval(() => {}, 1_000);',
      ],
      { stdio: 'ignore' },
    );
    records = await waitForRecords(recordPath, 2);
    const wrappedChild = records.find((record) => record.role === 'recording-exec-child');
    assert.ok(wrappedChild, 'recording exec did not capture its child identity');
    assert.equal(
      signalOwnedRecord(wrappedChild, 'SIGTERM', {
        inspect: (pid) => inspectProcessIdentity(identityCommand, pid),
        kill: process.kill.bind(process),
        sessionToken,
      }),
      true,
      'the test signal must target the recorded child identity',
    );
    assert.equal(await waitForChildExit(wrapper, 3_000), true, 'recording exec did not exit');
    assert.equal(wrapper.signalCode, null, 'recording exec forwarded the child signal to itself');
    assert.equal(wrapper.exitCode, 128 + os.constants.signals.SIGTERM);
    assert.deepEqual(
      liveOwnedRecords(records, {
        inspect: (pid) => inspectProcessIdentity(identityCommand, pid),
        sessionToken,
      }),
      [],
      'recording exec left a wrapper or child process alive',
    );
  } finally {
    const cleanupRecords = readJsonLines(recordPath);
    for (const record of cleanupRecords) validateOwnershipRecord(record, recordPath, sessionToken);
    if (cleanupRecords.length > 0) {
      await terminateOwnedProcesses(cleanupRecords, identityCommand, sessionToken);
    }
    if (wrapper) await waitForChildExit(wrapper, 3_000);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('early-failure finalization reaps a separately grouped signer/native worker', {
  skip: process.env.GIT_MCP_CHECK_RUNTIME !== '1',
  timeout: 600_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-early-finalizer-regression-'));
  const signingRoot = path.join(root, 'signing');
  const ownershipPath = path.join(signingRoot, 'owned-processes.jsonl');
  const primaryError = new Error('early task-body failure');
  const sessionToken = crypto.randomUUID();
  const identityCommand = buildProcessIdentity();
  fs.mkdirSync(signingRoot, { mode: 0o700 });
  const worker = childProcess.spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { detached: true, stdio: 'ignore' },
  );
  const ownershipRecord = await waitForOwnershipRecord(
    identityCommand,
    worker.pid,
    fs.realpathSync(process.execPath),
    'signer-native-early-failure',
    sessionToken,
  );
  writeOwnershipRecord(ownershipPath, ownershipRecord);

  try {
    await assert.rejects(
      runFinalizers(primaryError, [
        async () => cleanupOwnedFixture(root, sessionToken, identityCommand),
        async () => { fs.rmSync(root, { recursive: true, force: true }); },
      ]),
      (error) => error === primaryError,
    );
    assert.equal(
      ownershipMatches(
        ownershipRecord,
        inspectProcessIdentity(identityCommand, ownershipRecord.pid),
        sessionToken,
      ),
      false,
      'early finalization left a separately grouped signer/native worker alive',
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      await terminateOwnedProcesses([ownershipRecord], identityCommand, sessionToken);
    }
    await waitForChildExit(worker, 3_000);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed Git signing leaves mcpproxy and an independent sibling upstream available', {
  skip: process.env.GIT_MCP_CHECK_RUNTIME !== '1',
  timeout: 600_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-upstream-isolation-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'proxy-data');
  const tempDir = path.join(root, 'tmp');
  const configPath = path.join(root, 'mcp_config.json');
  const ownershipDirectory = path.join(root, 'ownership');
  const gitOwnershipPath = path.join(ownershipDirectory, 'git-mcp.jsonl');
  const proxyOwnershipPath = path.join(ownershipDirectory, 'proxy.jsonl');
  const siblingOwnershipPath = path.join(ownershipDirectory, 'sibling.jsonl');
  const signerOwnershipPath = path.join(ownershipDirectory, 'signer.jsonl');
  const signerLauncher = path.join(root, 'recording-signer');

  let proxy;
  let client;
  let identityCommand;
  let stdout = '';
  let stderr = '';
  let primaryError;
  const sessionToken = crypto.randomUUID();
  const continuityRoles = new Set([
    'mcpproxy',
    'sibling-wrapper',
    'sibling-server',
  ]);
  let continuityRecords = [];
  try {
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(dataDir, { mode: 0o700 });
    fs.mkdirSync(tempDir, { mode: 0o700 });
    fs.mkdirSync(ownershipDirectory, { mode: 0o700 });
    identityCommand = buildProcessIdentity();
    const gitMcpServer = path.join(buildGitMcpServer(), 'bin/git-mcp-server');
    const signerCommand = path.join(buildSigner(), 'bin/git-mcp-secure-enclave-signer');
    const signerExecutable = scriptInterpreter(signerCommand);
    fs.writeFileSync(
      signerLauncher,
      [
        `#!${process.execPath}`,
        "'use strict';",
        "process.env.RECORDING_EXEC_MODE = 'environment';",
        `require(${JSON.stringify(recordingExecPath)});`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const summary = fixtureSummary();
    const state = createSigningState(root, summary);
    const baseEnvironment = withoutSigningEnvironment(process.env);
    const globalConfig = path.join(root, 'global.gitconfig');
    fs.writeFileSync(globalConfig, '', { mode: 0o600 });
    const gitEnvironment = {
      ...baseEnvironment,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: home,
      TMPDIR: tempDir,
    };
    const repository = createRepository(root, gitEnvironment);
    const headBefore = runGit(['rev-parse', 'HEAD'], repository, gitEnvironment);
    const port = await reserveLoopbackPort();
    const apiKey = 'upstream-isolation-fixture-api-key';
    const gitMcpEnvironment = {
      MCP_SESSION_MODE: 'stateless',
      STORAGE_PROVIDER_TYPE: 'in-memory',
      GIT_SIGN_COMMITS: 'true',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'gpg.format',
      GIT_CONFIG_VALUE_1: 'ssh',
      GIT_CONFIG_KEY_2: 'gpg.ssh.program',
      GIT_CONFIG_VALUE_2: signerLauncher,
      GIT_CONFIG_KEY_3: 'user.signingKey',
      GIT_CONFIG_VALUE_3: state.stubPath,
      SSH_SK_PROVIDER: summary.nativeToolPaths.provider,
      KEYCHAIN_CERTIFICATES: state.identity.hash,
      GIT_MCP_SIGNING_CTK_HASH: state.identity.hash,
      GIT_MCP_SIGNING_PUBLIC_KEY: state.identity.publicKey,
      GIT_MCP_SIGNING_FINGERPRINT: state.identity.fingerprint,
      GIT_MCP_SIGNING_STUB: state.stubPath,
      GIT_MCP_SIGNING_FIXTURE_ROOT: state.signingRoot,
      GIT_MCP_PROCESS_IDENTITY_HELPER: identityCommand,
      GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
      RECORDING_EXEC_RECORD_PATH: signerOwnershipPath,
      RECORDING_EXEC_IDENTITY_COMMAND: identityCommand,
      RECORDING_EXEC_SESSION_TOKEN: sessionToken,
      RECORDING_EXEC_WRAPPER_ROLE: 'signer-wrapper',
      RECORDING_EXEC_CHILD_ROLE: 'signer',
      RECORDING_EXEC_EXPECTED_CHILD_EXECUTABLE: signerExecutable,
      RECORDING_EXEC_COMMAND: signerCommand,
    };
    fs.writeFileSync(configPath, `${JSON.stringify({
      listen: `127.0.0.1:${port}`,
      data_dir: dataDir,
      routing_mode: 'retrieve_tools',
      quarantine_enabled: false,
      api_key: apiKey,
      require_mcp_auth: false,
      logging: { level: 'error', enable_file: false, enable_console: true },
      tool_discovery_interval: '0s',
      mcpServers: [
        {
          name: 'git-failing',
          protocol: 'stdio',
          enabled: true,
          quarantined: false,
          command: process.execPath,
          args: [
            recordingExecPath,
            gitOwnershipPath,
            identityCommand,
            sessionToken,
            'git-mcp-wrapper',
            'git-mcp-server',
            fs.realpathSync(process.execPath),
            gitMcpServer,
          ],
          env: gitMcpEnvironment,
        },
        {
          name: 'sibling',
          protocol: 'stdio',
          enabled: true,
          quarantined: false,
          command: process.execPath,
          args: [
            recordingExecPath,
            siblingOwnershipPath,
            identityCommand,
            sessionToken,
            'sibling-wrapper',
            'sibling-server',
            fs.realpathSync(process.execPath),
            process.execPath,
            siblingPath,
          ],
        },
      ],
    }, null, 2)}\n`, { mode: 0o600 });

    const mcpproxyCommand = resolveCommand('mcpproxy');
    proxy = childProcess.spawn(
      mcpproxyCommand,
      [
        '--config', configPath,
        '--data-dir', dataDir,
        '--log-level', 'error',
        'serve',
        '--listen', `127.0.0.1:${port}`,
        '--disable-management',
        '--enable-socket=false',
        '--require-mcp-auth=false',
      ],
      {
        cwd: root,
        detached: true,
        env: {
          ...baseEnvironment,
          HOME: home,
          XDG_CACHE_HOME: path.join(root, 'cache'),
          XDG_CONFIG_HOME: path.join(root, 'config'),
          XDG_DATA_HOME: path.join(root, 'data'),
          XDG_STATE_HOME: path.join(root, 'state'),
          LANG: 'C',
          LC_ALL: 'C',
          NO_COLOR: '1',
          TMPDIR: tempDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    writeOwnershipRecord(
      proxyOwnershipPath,
      await waitForOwnershipRecord(
        identityCommand,
        proxy.pid,
        fs.realpathSync(mcpproxyCommand),
        'mcpproxy',
        sessionToken,
      ),
    );
    proxy.stdout.setEncoding('utf8');
    proxy.stderr.setEncoding('utf8');
    proxy.stdout.on('data', (chunk) => { stdout += chunk; });
    proxy.stderr.on('data', (chunk) => { stderr += chunk; });
    const logs = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;

    await waitForProxy(proxy, port, apiKey, logs);
    await Promise.all([waitForFile(gitOwnershipPath), waitForFile(siblingOwnershipPath)]);
    client = new McpClient(`http://127.0.0.1:${port}/mcp`);
    await client.connect();
    continuityRecords = discoverOwnershipRecords(root, sessionToken)
      .filter((record) => continuityRoles.has(record.role));
    assert.deepEqual(
      continuityRecords.map(({ role }) => role).sort(),
      [...continuityRoles].sort(),
      'fixture did not capture original mcpproxy and sibling process identities',
    );

    const gitResult = await client.callTool('call_tool_write', {
      name: 'git-failing:git_commit',
      args: { path: repository, message: 'must fail signing' },
      intent_reason: 'Task 3.7 failing-signing isolation regression',
      intent_data_sensitivity: 'internal',
    });
    const gitDiagnostic = toolResultText(gitResult);
    assert.equal(gitResult.isError, true, `Git MCP call unexpectedly succeeded: ${gitDiagnostic}`);
    assert.match(gitDiagnostic, /fixture provider rejected signing; first unlock is required/i);
    await waitForFile(signerOwnershipPath);
    assert.equal(runGit(['rev-parse', 'HEAD'], repository, gitEnvironment), headBefore);
    assert.equal(runGit(['rev-list', '--count', 'HEAD'], repository, gitEnvironment), '1');
    assert.equal(runGit(['log', '-1', '--format=%B'], repository, gitEnvironment), 'initial');
    assert.equal(
      runGit(['status', '--porcelain', '--untracked-files=no'], repository, gitEnvironment),
      'A  rejected.txt',
      'failed signing leaves the change staged instead of committing it unsigned',
    );
    const calls = readCalls(state.signingRoot);
    assert.equal(
      calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'list').length,
      2,
      'explicit and retry attempts each enter signer preflight',
    );
    assert.equal(
      calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length,
      2,
      'explicit and retry attempts each reach delegated signing',
    );
    assert.equal(
      calls.filter((call) => call.tool === 'provider' && call.operation === 'sign').length,
      2,
      'explicit and retry attempts each reach the rejecting provider',
    );
    const events = readJsonLines(path.join(state.signingRoot, 'events.jsonl'));
    const providerResults = events.filter(
      (event) => event.tool === 'provider' && event.operation === 'sign',
    );
    assert.deepEqual(
      providerResults.map((event) => event.status),
      [42, 42],
      'both provider attempts return the fixture rejection status',
    );
    const longLivedRoles = new Set([
      'mcpproxy',
      'git-mcp-wrapper',
      'git-mcp-server',
      'sibling-wrapper',
      'sibling-server',
    ]);
    const ownershipRecords = discoverOwnershipRecords(root, sessionToken);
    for (const role of [
      ...longLivedRoles,
      'signer-wrapper',
      'signer',
    ]) {
      assert.ok(
        ownershipRecords.some((record) => record.role === role),
        `fixture did not capture ownership identity for ${role}`,
      );
    }
    const completedRecords = ownershipRecords
      .filter((record) => !longLivedRoles.has(record.role));
    const completedOptions = {
      inspect: (pid) => inspectProcessIdentity(identityCommand, pid),
      sessionToken,
    };
    assert.deepEqual(
      liveOwnedRecords(completedRecords, completedOptions)
        .map(({ pid, role }) => ({ pid, role })),
      [],
      'signer and native fixture processes remain after Git failure',
    );
    assert.deepEqual(
      liveOwnedRecords(continuityRecords, completedOptions)
        .map(({ pid, role }) => ({ pid, role })),
      continuityRecords.map(({ pid, role }) => ({ pid, role })),
      'failed Git signing interrupted or replaced an original mcpproxy or sibling process',
    );

    const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(health.ok, true, `mcpproxy health failed after Git error: ${await health.text()}`);
    assert.equal(proxy.exitCode, null, `mcpproxy exited after Git error: ${logs()}`);

    const marker = 'sibling-after-signing-failure';
    const siblingResult = await client.callTool('call_tool_read', {
      name: 'sibling:ping',
      args: { marker },
      intent_reason: 'Verify sibling availability after Git signing failure',
      intent_data_sensitivity: 'internal',
    });
    const siblingText = toolResultText(siblingResult);
    assert.equal(siblingResult.isError, undefined, siblingText);
    assert.match(siblingText, new RegExp(`sibling-pong:${marker}`));
    assert.match(siblingText, /signing-env:none/);
  } catch (error) {
    primaryError = error;
  }
  await runFinalizers(primaryError, [
    async () => { if (client) await client.close(); },
    async () => {
      if (identityCommand) {
        await cleanupOwnedFixture(root, sessionToken, identityCommand, proxy);
      }
    },
    async () => { fs.rmSync(root, { recursive: true, force: true }); },
  ]);
});
