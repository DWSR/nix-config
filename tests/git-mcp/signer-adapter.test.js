'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixturePath = path.join(repoRoot, 'tests/git-mcp/fixtures/signing-tools.nix');
const signerPath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-signer.nix');
const nixTimeoutMs = 600_000;
const commandTimeoutMs = 30_000;
const maxBuffer = 64 * 1024 * 1024;
const fixtureOwnershipTimeoutMs = 2_000;
const fixtureLifecycleHandoffTimeoutMs = 5_000;
const fixtureCleanupTimeoutMs = 2_000;
const publicSignerName = 'git-mcp-secure-enclave-signer';
const privateWorkerName = 'git-mcp-secure-enclave-signer-worker';
const agentLifecycleRole = 'agent-socket-trap-lifecycle';

let fixture;
let signerPackage;
let signerCommand;
let workerCommand;
let fixtureProcessControlCommand;

function nixBuild(expression) {
  return childProcess.execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '--impure',
      '--expr',
      expression,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: nixTimeoutMs,
      maxBuffer,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ).trim();
}

function buildFixtureBundle() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
    in fixture.packages
  `);
}

function buildSigner() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} {
        inherit pkgs;
        signerPackage = import ${JSON.stringify(signerPath)};
      };
    in fixture.signerPackage
  `);
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
        agentTrapExecutable = fixture.agentTrapExecutable;
        nativeToolPaths = fixture.nativeToolPaths;
        interceptorPaths = fixture.interceptorPaths;
        scenarios = fixture.scenarios;
      }
    `],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: nixTimeoutMs,
      maxBuffer,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ));
}

function createScenarioRoot(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-signer-'));
  fs.writeFileSync(path.join(root, 'scenario.json'), `${JSON.stringify(scenario)}\n`, { mode: 0o600 });
  return root;
}

function withScenario(scenario, callback) {
  const root = createScenarioRoot(scenario);
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createSigningState(root) {
  const identity = fixture.scenarios.oneResidentExport.identitySnapshots.after[0];
  const residentExport = fixture.scenarios.oneResidentExport.residentExports[0];
  const identityDir = path.join(root, 'identities', identity.hash);
  const stubPath = path.join(identityDir, residentExport.stubName);

  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stubPath, `${residentExport.stub}\n`, { mode: 0o600 });
  fs.writeFileSync(`${stubPath}.pub`, `${residentExport.publicKey}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'identity-snapshot'), 'after\n', { mode: 0o600 });

  return { identity, residentExport, stubPath };
}

function fixtureEnvironment(root, state, additional = {}) {
  return {
    ...process.env,
    GIT_MCP_SIGNING_FIXTURE_ROOT: root,
    SSH_SK_PROVIDER: fixture.nativeToolPaths.provider,
    KEYCHAIN_CERTIFICATES: state.identity.hash,
    GIT_MCP_SIGNING_CTK_HASH: state.identity.hash,
    GIT_MCP_SIGNING_PUBLIC_KEY: state.identity.publicKey,
    GIT_MCP_SIGNING_FINGERPRINT: state.identity.fingerprint,
    GIT_MCP_SIGNING_STUB: state.stubPath,
    ...additional,
  };
}

function runCommand(command, arguments_, { cwd = repoRoot, env = process.env } = {}) {
  return childProcess.spawnSync(command, arguments_, {
    cwd,
    env,
    encoding: 'utf8',
    input: '',
    maxBuffer,
    timeout: commandTimeoutMs,
  });
}

function createChildClosePromise(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function waitForChildClose(close, timeoutMilliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    close.then(() => finish(true));
  });
}

test('fixture cleanup invokes state inspection only after ChildProcess close', async () => {
  const child = new EventEmitter();
  child.on('error', () => {});
  const close = createChildClosePromise(child);
  let stateCallbackCalls = 0;
  const states = waitForChildClose(close, 50).then((closed) => {
    if (closed) stateCallbackCalls += 1;
    return closed;
  });

  child.exitCode = 1;
  child.signalCode = 'SIGTERM';
  child.emit('exit', 1, 'SIGTERM');
  child.emit('error', new Error('fixture child error'));
  await new Promise(queueMicrotask);

  assert.equal(stateCallbackCalls, 0, 'exit, status fields, and error do not permit state inspection');

  child.emit('close', 1, 'SIGTERM');

  assert.equal(await states, true, 'close permits state inspection');
  assert.equal(stateCallbackCalls, 1, 'state inspection runs once after close');
});

test('fixture cleanup retains a close observed before its later bounded wait', async () => {
  const child = new EventEmitter();
  const close = createChildClosePromise(child);

  child.emit('close', 0, null);

  assert.equal(await waitForChildClose(close, 50), true);
});

async function waitForFile(filePath, timeoutMilliseconds = fixtureOwnershipTimeoutMs) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out after ${timeoutMilliseconds}ms waiting for ${filePath}`);
}

function executeFixtureProcessControl(arguments_) {
  return new Promise((resolve) => {
    childProcess.execFile(
      fixtureProcessControlCommand,
      arguments_,
      { encoding: 'utf8', maxBuffer },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

function commandFailure(result) {
  return result.stderr.trim() || result.error?.message || `status ${result.error?.code ?? 'unknown'}`;
}

function trapDiagnostics(trap) {
  const details = [`pid=${trap.child.pid ?? 'unavailable'}`];
  if (trap.diagnostics.error) details.push(`spawn-error=${trap.diagnostics.error.message}`);
  if (trap.diagnostics.exit) {
    details.push(
      `exit=${trap.diagnostics.exit.code ?? 'null'}/${trap.diagnostics.exit.signal ?? 'none'}`,
    );
  }
  if (trap.diagnostics.stderr.trim()) details.push(`stderr=${trap.diagnostics.stderr.trim()}`);
  if (trap.diagnostics.stdout.trim()) details.push(`stdout=${trap.diagnostics.stdout.trim()}`);
  return details.join('; ');
}

function trapStartupError(trap, message) {
  return new Error(`fixture agent socket trap startup failed: ${message}; ${trapDiagnostics(trap)}`);
}

test('startup errors retain readiness evidence when fake-agent stderr arrives later', async () => {
  const diagnostics = { error: null, exit: null, stderr: '', stdout: '' };
  const trap = { child: { pid: 12345 }, diagnostics };
  const startupError = trapStartupError(
    trap,
    'socket readiness appeared before durable Go ownership attestation',
  );

  await new Promise(queueMicrotask);
  diagnostics.stderr = 'fixture agent socket trap intentionally skipped durable ownership registration\n';

  assert.match(
    startupError.message,
    /socket readiness appeared before durable Go ownership attestation/,
  );
  assert.doesNotMatch(startupError.message, /intentionally skipped durable ownership registration/);
  assert.match(diagnostics.stderr, /intentionally skipped durable ownership registration/);
});

function spawnAgentSocketTrap({ root, sessionToken, socketPath, recordPath, readyPath, environment }) {
  const expectedExecutable = fs.realpathSync(fixture.agentTrapExecutable);
  const child = childProcess.spawn(
    fixture.interceptorPaths.agentSocketTrap,
    [socketPath, recordPath, readyPath],
    { cwd: repoRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const close = createChildClosePromise(child);
  const diagnostics = {
    error: null,
    exit: null,
    close: null,
    stderr: '',
    stdout: '',
  };
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  let terminalRecorded = false;
  const recordTerminal = (event) => {
    if (terminalRecorded) return;
    terminalRecorded = true;
    resolveTerminal(event);
  };

  child.stdout?.on('data', (chunk) => { diagnostics.stdout += chunk; });
  child.stderr?.on('data', (chunk) => { diagnostics.stderr += chunk; });
  child.once('error', (error) => {
    diagnostics.error = error;
    recordTerminal({ type: 'error', error });
  });
  child.once('exit', (code, signal) => {
    diagnostics.exit = { code, signal };
    recordTerminal({ type: 'exit', code, signal });
  });
  child.once('close', (code, signal) => {
    diagnostics.close = { code, signal };
  });

  const lifecycleRecord = child.pid
    ? executeFixtureProcessControl([
      'record', '--root', root, '--token', sessionToken,
      '--pid', String(child.pid), '--expected-executable', expectedExecutable,
      '--role', agentLifecycleRole, '--wait-ms', String(fixtureLifecycleHandoffTimeoutMs),
    ])
    : Promise.resolve({
      error: new Error('fixture agent socket trap did not provide a PID'),
      stdout: '',
      stderr: '',
    });

  return {
    child,
    close,
    diagnostics,
    expectedExecutable,
    lifecycleRecord,
    lifecycleWaitPath: `${readyPath}.lifecycle-wait`,
    ownershipAttestationPath: `${readyPath}.ownership.json`,
    readyPath,
    recordPath,
    root,
    sessionToken,
    socketPath,
    attested: false,
    terminal,
  };
}

function signalAgentSocketTrapLifecycleRelease(trap) {
  return executeFixtureProcessControl([
    'release-record', '--root', trap.root, '--token', trap.sessionToken,
    '--pid', String(trap.child.pid), '--role', agentLifecycleRole,
  ]);
}

async function awaitTrapOperation(trap, operation, result) {
  const outcome = await Promise.race([
    result.then((commandResult) => ({ type: 'command', commandResult })),
    trap.terminal.then((terminal) => ({ type: 'terminal', terminal })),
  ]);
  if (outcome.type === 'terminal') {
    throw trapStartupError(trap, `child ended before ${operation}`);
  }
  if (outcome.commandResult.error) {
    throw trapStartupError(trap, `${operation} failed: ${commandFailure(outcome.commandResult)}`);
  }
  if (trap.diagnostics.error || trap.diagnostics.exit) {
    throw trapStartupError(trap, `child ended during ${operation}`);
  }
  return outcome.commandResult;
}

function waitForTrapReadiness(trap) {
  const state = () => {
    const ready = fs.existsSync(trap.readyPath);
    const ownershipAttested = fs.existsSync(trap.ownershipAttestationPath);
    if (ready && !ownershipAttested) {
      return 'socket readiness appeared before durable Go ownership attestation';
    }
    return ready && ownershipAttested ? 'ready' : null;
  };
  const initialState = state();
  if (initialState === 'ready') return Promise.resolve();
  if (initialState) return Promise.reject(trapStartupError(trap, initialState));
  if (trap.diagnostics.error || trap.diagnostics.exit) {
    return Promise.reject(trapStartupError(trap, 'child ended before startup readiness'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let poller;
    let watcher;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      watcher?.close();
      trap.child.off('error', onTerminal);
      trap.child.off('exit', onTerminal);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const currentState = state();
      if (currentState === 'ready') finish();
      else if (currentState) finish(trapStartupError(trap, currentState));
    };
    const onTerminal = () => finish(trapStartupError(trap, 'child ended before startup readiness'));

    try {
      watcher = fs.watch(path.dirname(trap.readyPath), { persistent: false }, check);
    } catch (error) {
      finish(trapStartupError(trap, `cannot watch startup directory: ${error.message}`));
      return;
    }
    trap.child.once('error', onTerminal);
    trap.child.once('exit', onTerminal);
    timer = setTimeout(
      () => finish(trapStartupError(
        trap,
        `timed out after ${fixtureOwnershipTimeoutMs}ms waiting for socket readiness and durable Go ownership attestation`,
      )),
      fixtureOwnershipTimeoutMs,
    );
    poller = setInterval(check, 10);
    check();
  });
}

test('agent trap withholds readiness until its Go lifecycle release is signaled', { concurrency: false }, async () => {
  const root = createScenarioRoot(fixture.scenarios.oneResidentExport);
  const state = createSigningState(root);
  const sessionToken = crypto.randomUUID();
  const agentSocket = path.join(root, 'agent.sock');
  const agentRecords = path.join(root, 'agent-calls.jsonl');
  const agentReady = path.join(root, 'agent-ready');
  const environment = fixtureEnvironment(root, state, {
    GIT_MCP_PROCESS_IDENTITY_HELPER: fixtureProcessControlCommand,
    GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
  });
  let agent;

  try {
    agent = spawnAgentSocketTrap({
      root,
      sessionToken,
      socketPath: agentSocket,
      recordPath: agentRecords,
      readyPath: agentReady,
      environment,
    });
    await awaitTrapOperation(agent, 'durable lifecycle ownership capture', agent.lifecycleRecord);
    await waitForFile(agent.lifecycleWaitPath, fixtureLifecycleHandoffTimeoutMs);

    assert.equal(
      fs.existsSync(agentReady),
      false,
      'fixture agent must not publish readiness before the lifecycle release',
    );
    assert.equal(fs.existsSync(agentSocket), false, 'fixture agent must not bind its socket before release');
    assert.equal(
      await waitForChildClose(agent.close, fixtureLifecycleHandoffTimeoutMs + fixtureCleanupTimeoutMs),
      true,
      'fixture agent must close after its bounded lifecycle-release wait expires',
    );
    assert.match(
      agent.diagnostics.stderr,
      /lifecycle release timed out after 5000ms/,
      'fixture agent reports its bounded lifecycle-release failure',
    );
  } finally {
    if (agent) await finalizeAgentSocketTrap(agent);
    else fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent trap readiness survives a missed socket-ready directory event', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-agent-trap-readiness-'));
  const readyPath = path.join(root, 'agent-ready');
  const ownershipAttestationPath = `${readyPath}.ownership.json`;
  const originalWatch = fs.watch;
  let watcherClosed = false;
  let onChange;

  try {
    fs.watch = (_directory, _options, listener) => {
      onChange = listener;
      return { close: () => { watcherClosed = true; } };
    };
    const readiness = waitForTrapReadiness({
      child: new EventEmitter(),
      diagnostics: { error: null, exit: null, stderr: '', stdout: '' },
      ownershipAttestationPath,
      readyPath,
    });

    assert.equal(typeof onChange, 'function', 'readiness installs a directory watcher');
    fs.writeFileSync(ownershipAttestationPath, '{}\n');
    onChange('rename', path.basename(ownershipAttestationPath));
    fs.writeFileSync(readyPath, '');

    await readiness;
    assert.equal(watcherClosed, true, 'readiness closes its watcher after observing both files');
  } finally {
    fs.watch = originalWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function parseOwnershipStates(trap, result, phase) {
  if (result.error) {
    throw trapStartupError(trap, `${phase} failed: ${commandFailure(result)}`);
  }
  try {
    const states = JSON.parse(result.stdout);
    if (!Array.isArray(states)) throw new Error('process-control returned a non-array state document');
    return states;
  } catch (error) {
    throw trapStartupError(trap, `${phase} returned invalid JSON: ${error.message}`);
  }
}

function requireLiveAgentRecord(trap, states, role) {
  const matches = states.filter((entry) => entry.record?.role === role);
  if (matches.length !== 1) {
    throw trapStartupError(
      trap,
      `expected one ${role} record, found ${matches.length} in [${states.map((entry) => entry.record?.role).join(', ')}]`,
    );
  }
  const [{ record, state }] = matches;
  if (
    state !== 'live'
    || record.pid !== trap.child.pid
    || record.sessionToken !== trap.sessionToken
    || record.executable !== trap.expectedExecutable
    || record.expectedExecutable !== trap.expectedExecutable
  ) {
    throw trapStartupError(
      trap,
      `${role} record did not match the live expected identity: ${JSON.stringify({ record, state })}`,
    );
  }
  return record;
}

async function attestAgentSocketTrap(trap) {
  await awaitTrapOperation(
    trap,
    'durable lifecycle ownership capture',
    trap.lifecycleRecord,
  );
  await awaitTrapOperation(
    trap,
    'durable lifecycle release',
    signalAgentSocketTrapLifecycleRelease(trap),
  );
  await waitForTrapReadiness(trap);

  let attestation;
  try {
    attestation = JSON.parse(fs.readFileSync(trap.ownershipAttestationPath, 'utf8'));
  } catch (error) {
    throw trapStartupError(trap, `cannot read ownership attestation: ${error.message}`);
  }
  if (
    attestation.pid !== trap.child.pid
    || attestation.sessionToken !== trap.sessionToken
    || attestation.expectedExecutable !== trap.expectedExecutable
  ) {
    throw trapStartupError(
      trap,
      `ownership attestation did not match expected identity: ${JSON.stringify(attestation)}`,
    );
  }

  let socket;
  try {
    socket = fs.lstatSync(trap.socketPath);
  } catch (error) {
    throw trapStartupError(trap, `socket readiness file did not name a socket: ${error.message}`);
  }
  if (!socket.isSocket()) {
    throw trapStartupError(trap, `startup path is not a Unix socket: ${trap.socketPath}`);
  }

  const states = parseOwnershipStates(
    trap,
    await executeFixtureProcessControl([
      'states', '--root', trap.root, '--token', trap.sessionToken,
    ]),
    'durable ownership verification',
  );
  const records = {
    lifecycleRecord: requireLiveAgentRecord(trap, states, agentLifecycleRole),
    trapRecord: requireLiveAgentRecord(trap, states, 'agent-socket-trap'),
  };
  trap.attested = true;
  return records;
}

async function finalizeAgentSocketTrap(trap) {
  const finalizationErrors = [];
  let initialStates = [];
  let finalStates = [];
  let ownsTrap = false;

  try {
    const lifecycleResult = await trap.lifecycleRecord;
    if (lifecycleResult.error) {
      finalizationErrors.push(new Error(`lifecycle ownership capture failed: ${commandFailure(lifecycleResult)}`));
    }
  } catch (error) {
    finalizationErrors.push(error);
  }

  try {
    initialStates = parseOwnershipStates(
      trap,
      await executeFixtureProcessControl([
        'states', '--root', trap.root, '--token', trap.sessionToken,
        '--role', agentLifecycleRole,
      ]),
      'pre-cleanup ownership verification',
    );
    const lifecycleRecords = initialStates.filter(({ record }) => (
      record.role === agentLifecycleRole
      && record.pid === trap.child.pid
      && record.sessionToken === trap.sessionToken
      && record.executable === trap.expectedExecutable
      && record.expectedExecutable === trap.expectedExecutable
    ));
    ownsTrap = lifecycleRecords.length === 1 && lifecycleRecords[0].state === 'live';
    if (lifecycleRecords.length !== 1) {
      finalizationErrors.push(new Error(
        `fixture agent socket trap ${trap.child.pid} has ${lifecycleRecords.length} exact lifecycle ownership records`,
      ));
    }
    if (!ownsTrap && !trap.diagnostics.close) {
      finalizationErrors.push(new Error(
        `fixture agent socket trap ${trap.child.pid} lacks a live durable Go lifecycle ownership record; refusing raw-PID cleanup`,
      ));
    }
  } catch (error) {
    finalizationErrors.push(error);
  }

  const cleanup = await executeFixtureProcessControl([
    'cleanup', '--root', trap.root, '--token', trap.sessionToken,
    '--role', agentLifecycleRole, '--timeout-ms', String(fixtureCleanupTimeoutMs),
  ]);
  if (cleanup.error) {
    finalizationErrors.push(new Error(`Go fixture cleanup failed: ${commandFailure(cleanup)}`));
  }

  const closed = await waitForChildClose(trap.close, fixtureCleanupTimeoutMs);
  if (!closed) {
    finalizationErrors.push(new Error(
      `fixture agent socket trap ${trap.child.pid} did not close after Go fixture cleanup`,
    ));
  }

  if (closed) {
    try {
      const stateArguments = [
        'states', '--root', trap.root, '--token', trap.sessionToken,
      ];
      if (!trap.attested) stateArguments.push('--role', agentLifecycleRole);
      finalStates = parseOwnershipStates(
        trap,
        await executeFixtureProcessControl(stateArguments),
        'post-cleanup ownership verification',
      );
      const lifecycleRecords = finalStates.filter(({ record }) => record.role === agentLifecycleRole);
      if (lifecycleRecords.length !== 1) {
        finalizationErrors.push(new Error(
          `Go fixture cleanup did not retain exactly one lifecycle ownership record: ${JSON.stringify(finalStates)}`,
        ));
      }
      const remaining = finalStates.filter((entry) => entry.state !== 'gone');
      if (remaining.length > 0) {
        finalizationErrors.push(new Error(
          `Go fixture cleanup left owned processes: ${JSON.stringify(remaining)}`,
        ));
      }
    } catch (error) {
      finalizationErrors.push(error);
    }
  }

  if (finalizationErrors.length > 0) {
    throw new AggregateError(finalizationErrors, 'fixture agent socket trap finalization failed');
  }
  fs.rmSync(trap.root, { recursive: true, force: true });
  return {
    childClosed: closed,
    finalStates,
    initialStates,
    ownsTrap,
  };
}

async function withFixtureFinalization(operation, finalizers) {
  let primaryError;
  try {
    return await operation();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const finalizationErrors = [];
    for (const finalize of finalizers) {
      try {
        await finalize();
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    if (primaryError) {
      if (finalizationErrors.length > 0) {
        primaryError.fixtureFinalization = finalizationErrors.map((error) => error.message).join('\n');
      }
    } else if (finalizationErrors.length === 1) {
      throw finalizationErrors[0];
    } else if (finalizationErrors.length > 1) {
      throw new AggregateError(finalizationErrors, 'fixture finalization failed');
    }
  }
}

function assertNoSpawnError(result) {
  assert.equal(result.error, undefined, result.error?.message);
}

function readJsonLines(root, fileName) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readCalls(root) {
  return readJsonLines(root, 'calls.jsonl');
}

function resetFixtureRecords(root) {
  for (const fileName of ['calls.jsonl', 'events.jsonl', 'fallback-calls.jsonl']) {
    fs.rmSync(path.join(root, fileName), { force: true });
  }
}

function callsWithoutPids(calls) {
  return calls.map(({ pid, ...call }) => call);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertPassthroughMatchesNative(root, arguments_, environment, cwd, description) {
  const nativeResult = runCommand(fixture.nativeToolPaths.sshKeygen, arguments_, {
    cwd,
    env: environment,
  });
  assertNoSpawnError(nativeResult);
  assert.equal(nativeResult.status, 0, `${description}: fixture ssh-keygen failed: ${nativeResult.stderr}`);
  const nativeCalls = readCalls(root);

  resetFixtureRecords(root);
  const signerResult = runCommand(signerCommand, arguments_, { cwd, env: environment });
  assertNoSpawnError(signerResult);
  assert.equal(signerResult.status, nativeResult.status, `${description}: exit status`);
  assert.equal(signerResult.stdout, nativeResult.stdout, `${description}: stdout`);
  assert.equal(signerResult.stderr, nativeResult.stderr, `${description}: stderr`);

  const signerCalls = readCalls(root);
  assert.deepEqual(
    callsWithoutPids(signerCalls),
    callsWithoutPids(nativeCalls),
    `${description}: public signer must make the same native calls as direct ssh-keygen`,
  );
  const sshKeygenCall = signerCalls.find((call) => call.tool === 'ssh-keygen');
  assert.ok(sshKeygenCall, `${description}: fixture ssh-keygen call`);
  assert.deepEqual(sshKeygenCall.argv, arguments_, `${description}: argv`);
  assert.equal(sshKeygenCall.provider, environment.SSH_SK_PROVIDER, `${description}: SSH_SK_PROVIDER`);
  assert.equal(
    sshKeygenCall.selector,
    environment.KEYCHAIN_CERTIFICATES,
    `${description}: KEYCHAIN_CERTIFICATES`,
  );
  assert.equal(sshKeygenCall.cwd, cwd, `${description}: cwd`);
}

function controlledFallbackEnvironment(root, state) {
  const fallbackBin = path.join(root, 'controlled-fallback-bin');
  const agentSocket = path.join(root, 'unavailable-agent.sock');
  fs.mkdirSync(fallbackBin, { mode: 0o700 });
  fs.symlinkSync(
    fixture.interceptorPaths.fallback,
    path.join(fallbackBin, 'op-ssh-sign'),
  );

  return {
    agentSocket,
    environment: fixtureEnvironment(root, state, {
      SSH_AUTH_SOCK: agentSocket,
      GIT_MCP_SIGNING_FALLBACK: fixture.interceptorPaths.fallback,
      PATH: `${fallbackBin}:${process.env.PATH || ''}`,
    }),
  };
}

function gitSigningEnvironment(root, state, globalConfig, additional = {}) {
  const environment = fixtureEnvironment(root, state);
  for (const name of Object.keys(environment)) {
    if (
      name === 'GIT_CONFIG_GLOBAL'
      || name === 'GIT_CONFIG_NOSYSTEM'
      || name === 'GIT_SIGN_COMMITS'
      || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)
    ) {
      delete environment[name];
    }
  }

  return {
    ...environment,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gpg.format',
    GIT_CONFIG_VALUE_1: 'ssh',
    GIT_CONFIG_KEY_2: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_2: signerCommand,
    GIT_CONFIG_KEY_3: 'user.signingKey',
    GIT_CONFIG_VALUE_3: state.stubPath,
    SSH_AUTH_SOCK: path.join(root, 'unavailable-agent.sock'),
    ...additional,
  };
}

function runGit(arguments_, cwd, env) {
  return runCommand('git', arguments_, { cwd, env });
}

function gitOutput(arguments_, cwd, env) {
  const result = runGit(arguments_, cwd, env);
  assertNoSpawnError(result);
  assert.equal(result.status, 0, `git ${arguments_.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function createGitRepository(root, env) {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository, { mode: 0o700 });
  gitOutput(['init', '--quiet', '--initial-branch=main'], repository, env);
  gitOutput(['config', 'user.name', 'Fixture Git MCP'], repository, env);
  gitOutput(['config', 'user.email', 'fixture-git-mcp@example.test'], repository, env);
  fs.writeFileSync(path.join(repository, 'initial.txt'), 'initial\n');
  gitOutput(['add', 'initial.txt'], repository, env);
  gitOutput(['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'], repository, env);
  fs.writeFileSync(path.join(repository, 'commit.txt'), 'signed fixture commit\n');
  gitOutput(['add', 'commit.txt'], repository, env);
  return repository;
}

function writeConflictingGlobalConfig(root) {
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, [
    '[user]',
    '  name = Conflicting Global Signer',
    '  email = conflicting-global@example.test',
    '  signingKey = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGlobalConflict',
    '[commit]',
    '  gpgSign = false',
    '[gpg]',
    '  format = openpgp',
    `  program = ${fixture.interceptorPaths.fallback}`,
    '[gpg "ssh"]',
    `  program = ${fixture.interceptorPaths.fallback}`,
    '',
  ].join('\n'), { mode: 0o600 });
  return globalConfig;
}

test.before(() => {
  const fixtureBundle = buildFixtureBundle();
  fixtureProcessControlCommand = path.join(
    fixtureBundle,
    'process-control',
    'bin',
    'process-control',
  );
  fs.accessSync(fixtureProcessControlCommand, fs.constants.X_OK);
  fixture = fixtureSummary();
  signerPackage = buildSigner();
  signerCommand = path.join(signerPackage, 'bin', publicSignerName);
  workerCommand = path.join(signerPackage, 'libexec', privateWorkerName);
});

test('packages only the public Go signer and fixed private worker entrypoints', () => {
  const binDirectory = path.join(signerPackage, 'bin');
  const libexecDirectory = path.join(signerPackage, 'libexec');

  assert.deepEqual(fs.readdirSync(binDirectory).sort(), [publicSignerName]);
  assert.deepEqual(fs.readdirSync(libexecDirectory).sort(), [privateWorkerName]);
  fs.accessSync(signerCommand, fs.constants.X_OK);
  fs.accessSync(workerCommand, fs.constants.X_OK);

  for (const forbiddenPublicEntry of [
    'git-mcp-secure-enclave-signer-launcher',
    'git-mcp-secure-enclave-signer-supervisor',
    privateWorkerName,
  ]) {
    assert.equal(
      fs.existsSync(path.join(binDirectory, forbiddenPublicEntry)),
      false,
      `package must not expose legacy ${forbiddenPublicEntry} in bin`,
    );
  }
});

test('rejects direct private-worker execution before any fixture native call', () => {
  withScenario(fixture.scenarios.oneResidentExport, (root) => {
    const state = createSigningState(root);
    const result = runCommand(
      workerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath, 'payload'],
      { env: fixtureEnvironment(root, state) },
    );

    assertNoSpawnError(result);
    assert.notEqual(result.status, 0, 'direct private worker execution must fail closed');
    assert.match(result.stderr, /one-shot capability.*public signer/i);
    assert.deepEqual(readCalls(root), [], 'direct private worker execution must not reach native preflight');
  });
});

test('passes every non-signing form through with native argv, output, environment, and cwd', () => {
  withScenario(fixture.scenarios.oneResidentExport, (root) => {
    const state = createSigningState(root);
    const cwd = path.join(root, 'working-directory');
    const allowedSigners = path.join(root, 'allowed-signers');
    fs.mkdirSync(cwd, { mode: 0o700 });
    fs.writeFileSync(
      allowedSigners,
      `fixture namespaces="git" ${state.residentExport.publicKey}\n`,
      { mode: 0o600 },
    );
    const environment = fixtureEnvironment(root, state, {
      GIT_MCP_SIGNER_TEST_PASSTHROUGH: 'preserve-this-environment-exactly',
    });
    const cases = [
      {
        name: 'verification marker values',
        arguments: [
          '-Y', 'verify', '-n', '--signing-worker',
          '-I', '--git-mcp-secure-enclave-signer-worker', '-f', allowedSigners,
        ],
      },
      {
        name: 'unsupported equals sign form',
        arguments: ['-Y=sign', '-n', 'git', '-f', state.stubPath, 'payload'],
      },
      {
        name: 'end-of-options sign-looking values',
        arguments: ['--', '-Y', 'sign', '-n', 'git', '-f', state.stubPath, 'payload'],
      },
      {
        name: 'another Y operation',
        arguments: ['-Y', 'find-principals', '-f', allowedSigners],
      },
      {
        name: 'selector-looking option values',
        arguments: [
          '-n', '-Ysign', '-I', '--signing-worker',
          '-f', '--git-mcp-secure-enclave-signer-worker', '-O', '-Y', '-Q', 'cipher',
        ],
      },
    ];

    for (const testCase of cases) {
      resetFixtureRecords(root);
      assertPassthroughMatchesNative(
        root,
        testCase.arguments,
        environment,
        fs.realpathSync(cwd),
        testCase.name,
      );
    }
  });
});

test('routes supported signing forms through the fixed injected provider without fallback', () => {
  const forms = [
    { name: '-Y sign', arguments: ['-Y', 'sign'], namespace: '--signing-worker' },
    { name: '-Ysign', arguments: ['-Ysign'], namespace: 'sign' },
  ];

  for (const form of forms) {
    withScenario(fixture.scenarios.oneResidentExport, (root) => {
      const state = createSigningState(root);
      const { agentSocket, environment } = controlledFallbackEnvironment(root, state);
      const arguments_ = [
        ...form.arguments,
        '-n', form.namespace,
        '-f', state.stubPath,
        'payload',
      ];
      const result = runCommand(signerCommand, arguments_, { env: environment });

      assertNoSpawnError(result);
      assert.equal(result.status, 0, `${form.name}: ${result.stderr}`);
      assert.match(result.stdout, /fixture-provider-sign/);
      assert.match(
        result.stdout,
        new RegExp(`fixture-ssh-signature:${escapeRegExp(state.residentExport.publicKey)}`),
      );

      const calls = readCalls(root);
      assert.deepEqual(
        calls.map((call) => [call.tool, call.operation]),
        [
          ['sc_auth', 'list'],
          ['ssh-keygen', 'stub'],
          ['provider', 'load'],
          ['ssh-keygen', 'fingerprint'],
          ['ssh-keygen', 'sign'],
          ['provider', 'sign'],
        ],
        `${form.name}: fixed preflight and signing sequence`,
      );
      const [signingCall] = calls.filter(
        (call) => call.tool === 'ssh-keygen' && call.operation === 'sign',
      );
      assert.deepEqual(signingCall.argv, arguments_, `${form.name}: signing argv`);
      assert.equal(
        signingCall.provider,
        fixture.nativeToolPaths.provider,
        `${form.name}: fixed provider`,
      );
      assert.equal(signingCall.selector, state.identity.hash, `${form.name}: configured selector`);
      assert.equal(fs.existsSync(agentSocket), false, `${form.name}: does not require an agent socket`);
      assert.deepEqual(
        readJsonLines(root, 'fallback-calls.jsonl'),
        [],
        `${form.name}: controlled fallback path was not invoked`,
      );
    });
  }
});

test('fails a public preflight before delegated signing with an actionable non-secret diagnostic', () => {
  withScenario(fixture.scenarios.oneResidentExport, (root) => {
    const state = createSigningState(root);
    const result = runCommand(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath, 'payload'],
      {
        env: fixtureEnvironment(root, state, {
          SSH_SK_PROVIDER: '/controlled/wrong-provider',
        }),
      },
    );

    assertNoSpawnError(result);
    assert.notEqual(result.status, 0, 'invalid provider configuration must fail closed');
    assert.match(result.stderr, /SSH_SK_PROVIDER.*restore.*retry/i);
    assert.doesNotMatch(result.stderr, /BEGIN OPENSSH PRIVATE KEY|fixture-resident-handle/i);
    assert.deepEqual(readCalls(root), [], 'preflight failure must happen before delegated signing');
  });
});

test('Git command-scoped Go signing overrides conflicting global values and records a matching SSH signature', () => {
  withScenario(fixture.scenarios.oneResidentExport, (root) => {
    const state = createSigningState(root);
    const globalConfig = writeConflictingGlobalConfig(root);
    const environment = gitSigningEnvironment(root, state, globalConfig, {
      GIT_MCP_SIGNING_FIXTURE_GIT_SSH_SIGNATURE: '1',
    });
    const repository = createGitRepository(root, environment);
    const headBefore = gitOutput(['rev-parse', 'HEAD'], repository, environment);

    assert.equal(gitOutput(['config', '--get', 'commit.gpgSign'], repository, environment), 'true');
    assert.equal(gitOutput(['config', '--get', 'gpg.format'], repository, environment), 'ssh');
    assert.equal(gitOutput(['config', '--get', 'gpg.ssh.program'], repository, environment), signerCommand);
    assert.equal(gitOutput(['config', '--get', 'user.signingKey'], repository, environment), state.stubPath);

    const attempts = [
      { name: 'explicit', arguments: ['commit', '--gpg-sign', '-m', 'signed fixture commit'] },
      { name: 'retry-shaped', arguments: ['commit', '-m', 'retry-shaped signed fixture commit'] },
    ];
    for (const [index, attempt] of attempts.entries()) {
      if (index > 0) {
        fs.writeFileSync(path.join(repository, 'retry.txt'), 'retry-shaped signed fixture commit\n');
        gitOutput(['add', 'retry.txt'], repository, environment);
      }

      const attemptHead = index === 0 ? headBefore : gitOutput(['rev-parse', 'HEAD'], repository, environment);
      resetFixtureRecords(root);
      const commit = runGit(attempt.arguments, repository, environment);
      assertNoSpawnError(commit);
      assert.equal(commit.status, 0, `${attempt.name}: ${commit.stderr}`);
      assert.notEqual(gitOutput(['rev-parse', 'HEAD'], repository, environment), attemptHead);

      const publicKey = escapeRegExp(state.residentExport.publicKey);
      const rawCommit = gitOutput(['cat-file', '-p', 'HEAD'], repository, environment);
      assert.match(
        rawCommit,
        new RegExp(
          `gpgsig -----BEGIN SSH SIGNATURE-----\\n fixture-ssh-signature:${publicKey}\\n -----END SSH SIGNATURE-----`,
        ),
        `${attempt.name}: commit carries the fixture SSH signature for the configured public key`,
      );
      assert.deepEqual(
        readCalls(root).map((call) => [call.tool, call.operation]),
        [
          ['sc_auth', 'list'],
          ['ssh-keygen', 'stub'],
          ['provider', 'load'],
          ['ssh-keygen', 'fingerprint'],
          ['ssh-keygen', 'sign'],
          ['provider', 'sign'],
        ],
        `${attempt.name}: Git must reach the public Go signer and its fixed native signing path`,
      );

      const signature = rawCommit.match(
        /gpgsig (-----BEGIN SSH SIGNATURE-----)\n ([^\n]+)\n (-----END SSH SIGNATURE-----)/,
      );
      assert.ok(signature, `${attempt.name}: Git commit contains an SSH signature payload`);
      const signaturePath = path.join(root, `${attempt.name}.sig`);
      const allowedSignersPath = path.join(root, `${attempt.name}.allowed-signers`);
      fs.writeFileSync(signaturePath, `${signature[1]}\n${signature[2]}\n${signature[3]}\n`, { mode: 0o600 });
      fs.writeFileSync(
        allowedSignersPath,
        `${state.identity.label} namespaces="git" ${state.residentExport.publicKey}\n`,
        { mode: 0o600 },
      );
      const verification = runCommand(
        fixture.nativeToolPaths.sshKeygen,
        ['-Y', 'verify', '-f', allowedSignersPath, '-I', state.identity.label, '-n', 'git', '-s', signaturePath],
        { cwd: repository, env: environment },
      );
      assertNoSpawnError(verification);
      assert.equal(verification.status, 0, `${attempt.name}: fixture SSH verification: ${verification.stderr}`);
    }
    assert.deepEqual(readJsonLines(root, 'fallback-calls.jsonl'), []);
    assert.equal(fs.existsSync(environment.SSH_AUTH_SOCK), false, 'Git signing does not require an agent socket');
  });
});

test('Git explicit and retry-shaped signing rejection attempts fail closed without fallback', async () => {
  const root = createScenarioRoot(fixture.scenarios.providerFailure);
  const state = createSigningState(root);
  const globalConfig = writeConflictingGlobalConfig(root);
  const sessionToken = crypto.randomUUID();
  const agentSocket = path.join(root, 'agent.sock');
  const agentRecords = path.join(root, 'agent-calls.jsonl');
  const agentReady = path.join(root, 'agent-ready');
  const environment = gitSigningEnvironment(root, state, globalConfig, {
    GIT_MCP_PROCESS_IDENTITY_HELPER: fixtureProcessControlCommand,
    GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
    SSH_AUTH_SOCK: agentSocket,
  });
  let agent;

  await withFixtureFinalization(
    async () => {
      agent = spawnAgentSocketTrap({
        root,
        sessionToken,
        socketPath: agentSocket,
        recordPath: agentRecords,
        readyPath: agentReady,
        environment,
      });
      assert.ok(agent.child.pid, 'fixture agent socket trap has a PID');
      await attestAgentSocketTrap(agent);

      const repository = createGitRepository(root, environment);
      const headBefore = gitOutput(['rev-parse', 'HEAD'], repository, environment);
      const attempts = [
        { name: 'explicit', arguments: ['commit', '--gpg-sign', '-m', 'rejected fixture commit'] },
        { name: 'retry-shaped', arguments: ['commit', '-m', 'retry-shaped rejected fixture commit'] },
      ];

      for (const attempt of attempts) {
        resetFixtureRecords(root);
        const result = runGit(attempt.arguments, repository, environment);
        assertNoSpawnError(result);
        assert.notEqual(result.status, 0, `${attempt.name}: signing rejection must fail Git`);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /fixture provider rejected signing; first unlock is required/i,
          `${attempt.name}: Git preserves the actionable native rejection`,
        );
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /Apple signing provider rejected the request; complete the first unlock after reboot and retry/i,
          `${attempt.name}: public signer adds actionable recovery guidance`,
        );
        assert.equal(gitOutput(['rev-parse', 'HEAD'], repository, environment), headBefore);
        assert.equal(gitOutput(['status', '--short'], repository, environment), 'A  commit.txt');
        assert.deepEqual(
          readCalls(root).map((call) => [call.tool, call.operation]),
          [
            ['sc_auth', 'list'],
            ['ssh-keygen', 'stub'],
            ['provider', 'load'],
            ['ssh-keygen', 'fingerprint'],
            ['ssh-keygen', 'sign'],
            ['provider', 'sign'],
          ],
          `${attempt.name}: public Go signer reaches the configured provider instead of a fallback`,
        );
      }

      assert.deepEqual(readJsonLines(root, 'fallback-calls.jsonl'), []);
      assert.deepEqual(readJsonLines(root, 'agent-calls.jsonl'), [], 'Git signing rejection does not contact the agent socket');
    },
    [async () => {
      if (agent) await finalizeAgentSocketTrap(agent);
      else fs.rmSync(root, { recursive: true, force: true });
    }],
  );
});

test('agent trap startup rejects unowned or delayed registration and finalizes through Go', async (t) => {
  const cases = [
    {
      mode: 'raw-pid-before-ready',
      diagnostic: /socket readiness appeared before durable Go ownership attestation/,
      trapDiagnostic: /intentionally skipped durable ownership registration/,
    },
    {
      mode: 'delay-ownership-record',
      diagnostic: /timed out after 2000ms waiting for socket readiness and durable Go ownership attestation/,
      trapDiagnostic: /intentionally delaying durable ownership registration/,
    },
    {
      mode: 'synthetic-ownership-record',
      diagnostic: /socket readiness file did not name a socket/,
    },
    {
      mode: 'recycled-ownership-record',
      diagnostic: /socket readiness file did not name a socket/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.mode, async () => {
      const root = createScenarioRoot({
        ...fixture.scenarios.providerFailure,
        agentSocketTrap: testCase.mode,
      });
      const sessionToken = crypto.randomUUID();
      const agentSocket = path.join(root, 'agent.sock');
      const agentRecords = path.join(root, 'agent-calls.jsonl');
      const agentReady = path.join(root, 'agent-ready');
      const environment = fixtureEnvironment(root, createSigningState(root), {
        GIT_MCP_PROCESS_IDENTITY_HELPER: fixtureProcessControlCommand,
        GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
      });
      let agent;
      let cleanupEvidence;
      let primaryError;

      await assert.rejects(
        withFixtureFinalization(
          async () => {
            agent = spawnAgentSocketTrap({
              root,
              sessionToken,
              socketPath: agentSocket,
              recordPath: agentRecords,
              readyPath: agentReady,
              environment,
            });
            await attestAgentSocketTrap(agent);
          },
          [async () => {
            cleanupEvidence = await finalizeAgentSocketTrap(agent);
          }],
        ),
        (error) => {
          primaryError = error;
          assert.match(error.message, testCase.diagnostic);
          return true;
        },
      );

       assert.equal(primaryError.fixtureFinalization, undefined, 'primary startup error remains intact');
       assert.equal(cleanupEvidence.ownsTrap, true, 'finalizer uses a durable Go-owned trap identity');
       assert.equal(cleanupEvidence.childClosed, true, 'Go cleanup awaits the failed startup trap close');
       assert.deepEqual(
        cleanupEvidence.finalStates.filter((entry) => entry.state !== 'gone'),
        [],
        'Go cleanup verifies that no owned trap record remains live',
      );
      if (testCase.trapDiagnostic) {
        assert.match(
          agent.diagnostics.stderr,
          testCase.trapDiagnostic,
          'fake-agent diagnostics arrive only after Go cleanup and ChildProcess close are proven',
        );
      }
      assert.equal(fs.existsSync(root), false, 'fixture root is removed only after verified Go cleanup');
    });
  }
});

test('Git bounds every fixture-native hang for explicit and retry-shaped signing attempts', {
  timeout: 360_000,
}, () => {
  const hangCases = [
    {
      name: 'CTK listing',
      scenario: fixture.scenarios.hangCtkListing,
      calls: [['sc_auth', 'list']],
    },
    {
      name: 'resident stub preflight',
      scenario: fixture.scenarios.hangPreflightSshKeygenStub,
      calls: [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
      ],
    },
    {
      name: 'provider preflight',
      scenario: fixture.scenarios.hangPreflightProvider,
      calls: [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
        ['provider', 'load'],
      ],
    },
    {
      name: 'public-key fingerprint preflight',
      scenario: fixture.scenarios.hangPreflightSshKeygen,
      calls: [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
        ['provider', 'load'],
        ['ssh-keygen', 'fingerprint'],
      ],
    },
    {
      name: 'SSH signing invocation',
      scenario: fixture.scenarios.workerTree,
      calls: [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
        ['provider', 'load'],
        ['ssh-keygen', 'fingerprint'],
        ['ssh-keygen', 'sign'],
      ],
    },
    {
      name: 'provider signing',
      scenario: fixture.scenarios.hangProviderSigning,
      calls: [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
        ['provider', 'load'],
        ['ssh-keygen', 'fingerprint'],
        ['ssh-keygen', 'sign'],
        ['provider', 'sign'],
      ],
    },
  ];
  const coveredHangs = new Set(hangCases.flatMap(({ scenario }) => scenario.hangs));
  const supportedHangs = new Set(
    Object.values(fixture.scenarios).flatMap((scenario) => scenario.hangs || []),
  );
  assert.deepEqual([...coveredHangs].sort(), [...supportedHangs].sort());

  for (const hangCase of hangCases) {
    for (const attempt of [
      { name: 'explicit', arguments: ['commit', '--gpg-sign', '-m', 'timeout fixture commit'] },
      { name: 'retry-shaped', arguments: ['commit', '-m', 'retry-shaped timeout fixture commit'] },
    ]) {
      withScenario(hangCase.scenario, (root) => {
        const state = createSigningState(root);
        const globalConfig = writeConflictingGlobalConfig(root);
        const sessionToken = crypto.randomUUID();
        const environment = gitSigningEnvironment(root, state, globalConfig, {
          GIT_MCP_PROCESS_IDENTITY_HELPER: fixtureProcessControlCommand,
          GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
        });
        const repository = createGitRepository(root, environment);
        const headBefore = gitOutput(['rev-parse', 'HEAD'], repository, environment);
        let primaryError;

        try {
          resetFixtureRecords(root);
          const started = process.hrtime.bigint();
          const result = runGit(attempt.arguments, repository, environment);
          const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;

          assertNoSpawnError(result);
          assert.notEqual(result.status, 0, `${hangCase.name}/${attempt.name}: timeout must fail Git`);
          assert.match(
            `${result.stdout}\n${result.stderr}`,
            /immutable 20-second work deadline/i,
            `${hangCase.name}/${attempt.name}: public signer reports its timeout taxonomy`,
          );
          assert.ok(
            elapsedMilliseconds <= 22_000,
            `${hangCase.name}/${attempt.name}: public Git attempt exceeded the 22-second ceiling (${elapsedMilliseconds.toFixed(1)}ms)`,
          );
          assert.equal(gitOutput(['rev-parse', 'HEAD'], repository, environment), headBefore);
          assert.equal(gitOutput(['status', '--short'], repository, environment), 'A  commit.txt');
          assert.deepEqual(
            readCalls(root).map((call) => [call.tool, call.operation]),
            hangCase.calls,
            `${hangCase.name}/${attempt.name}: terminal fixture tools receive only the expected calls`,
          );

          const groupDirectory = path.join(root, 'worker-groups');
          const manifests = fs.readdirSync(groupDirectory)
            .filter((fileName) => fileName.endsWith('.json'))
            .map((fileName) => JSON.parse(fs.readFileSync(path.join(groupDirectory, fileName), 'utf8')));
          assert.equal(manifests.length, 1, `${hangCase.name}/${attempt.name}: one owned worker group`);
          for (const manifest of manifests) {
            assert.equal(manifest.kind, 'worker-group');
            assert.equal(manifest.sessionToken, sessionToken);
            assert.equal(manifest.session, manifest.processGroup);
            assert.ok(manifest.members.length >= 2, 'fixture records worker and descendant ownership');
            const group = runCommand(fixtureProcessControlCommand, ['group', String(manifest.processGroup)]);
            assertNoSpawnError(group);
            assert.equal(group.status, 3, `${hangCase.name}/${attempt.name}: owned worker group survives signer return: ${group.stderr}`);
          }

          const states = runCommand(fixtureProcessControlCommand, [
            'states', '--root', root, '--token', sessionToken,
          ]);
          assertNoSpawnError(states);
          assert.equal(states.status, 0, states.stderr);
          assert.deepEqual(
            JSON.parse(states.stdout).filter((entry) => entry.state !== 'gone'),
            [],
            `${hangCase.name}/${attempt.name}: no owned fixture process remains`,
          );
          assert.deepEqual(readJsonLines(root, 'fallback-calls.jsonl'), []);
          assert.equal(fs.existsSync(environment.SSH_AUTH_SOCK), false, 'timeout path does not require an agent socket');
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          const cleanup = runCommand(fixtureProcessControlCommand, [
            'cleanup', '--root', root, '--token', sessionToken, '--timeout-ms', '2_000',
          ]);
          if (primaryError) {
            if (cleanup.error || cleanup.status !== 0) {
              primaryError.fixtureFinalization = cleanup.error?.message || cleanup.stderr;
            }
          } else {
            assertNoSpawnError(cleanup);
            assert.equal(cleanup.status, 0, cleanup.stderr);
          }
        }
      });
    }
  }
});

test('a failed assertion finalizes a fixture-native worker group through Go process control', {
  timeout: 30_000,
}, async () => {
  const root = createScenarioRoot(fixture.scenarios.hangCtkListing);
  const state = createSigningState(root);
  const sessionToken = crypto.randomUUID();
  const environment = fixtureEnvironment(root, state, {
    GIT_MCP_PROCESS_IDENTITY_HELPER: fixtureProcessControlCommand,
    GIT_MCP_OWNERSHIP_TOKEN: sessionToken,
  });
  let child;
  let childClose;
  let cleanupSucceeded = false;
  let finalStates = [];
  let rootRemoved = false;

  try {
    await assert.rejects(
      (async () => {
        let primaryError;
        try {
          child = childProcess.spawn(
            fixture.nativeToolPaths.scAuth,
            ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'],
            { detached: true, env: environment, stdio: 'ignore' },
          );
          childClose = createChildClosePromise(child);
          assert.ok(child.pid, 'fixture-native CTK listing has a PID');
          const groups = runCommand(fixtureProcessControlCommand, [
            'wait-groups', '--root', root, '--token', sessionToken, '--count', '1',
            '--timeout-ms', String(fixtureLifecycleHandoffTimeoutMs),
          ]);
          assertNoSpawnError(groups);
          assert.equal(groups.status, 0, groups.stderr);
          assert.fail('deliberate assertion after fixture-native worker startup');
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          const cleanup = await executeFixtureProcessControl([
            'cleanup', '--root', root, '--token', sessionToken, '--timeout-ms', '2_000',
          ]);
          const finalizationErrors = [];
          if (cleanup.error) finalizationErrors.push(cleanup.stderr || cleanup.error.message);

          const closed = !child || await waitForChildClose(childClose, fixtureCleanupTimeoutMs);
          if (!closed) {
            finalizationErrors.push('fixture-native CTK listing did not close after Go process-control cleanup');
          }

          if (closed) {
            try {
              const states = runCommand(fixtureProcessControlCommand, [
                'states', '--root', root, '--token', sessionToken,
              ]);
              assertNoSpawnError(states);
              assert.equal(states.status, 0, states.stderr);
              finalStates = JSON.parse(states.stdout);
              assert.deepEqual(
                finalStates.filter((entry) => entry.state !== 'gone'),
                [],
                'Go cleanup leaves no owned fixture process after the detached child closes',
              );
            } catch (error) {
              finalizationErrors.push(error);
            }
          }

          if (finalizationErrors.length === 0) {
            try {
              fs.rmSync(root, { recursive: true, force: true });
              rootRemoved = true;
            } catch (error) {
              finalizationErrors.push(error);
            }
          }

          cleanupSucceeded = finalizationErrors.length === 0;
          if (finalizationErrors.length > 0) {
            const finalization = finalizationErrors
              .map((error) => error.message || String(error))
              .join('; ');
            if (primaryError) primaryError.fixtureFinalization = finalization;
            else throw new Error(finalization);
          }
        }
      })(),
      /deliberate assertion after fixture-native worker startup/,
    );
    assert.equal(cleanupSucceeded, true, 'Go process-control cleanup runs after a failed assertion');
    assert.deepEqual(finalStates.filter((entry) => entry.state !== 'gone'), []);
    assert.equal(rootRemoved, true, 'fixture root is removed only after final state verification');
    assert.equal(fs.existsSync(root), false, 'fixture root is removed after the child closes');
  } finally {
    if (!child) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
