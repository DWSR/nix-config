'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');
const legacyProcessIdentitySourcePath = path.join(__dirname, 'process-identity.c');
const legacyProcessOwnershipPath = path.join(__dirname, 'process-ownership.js');
const processControlSourcePath = path.join(__dirname, 'process-control_darwin.go');
const nixTimeoutMs = 600_000;
const harnessResultsFile = 'harness-results.jsonl';
const fixtureStartupTimeoutMs = 5_000;
const agentLifecycleRole = 'agent-socket-trap-lifecycle';
let cachedFixtureBundle;
let cachedFixtureSummary;

function nixEvalJson(expression) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expression],
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
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ).trim();
}

function fixtureSummary() {
  if (cachedFixtureSummary) return cachedFixtureSummary;
  cachedFixtureSummary = nixEvalJson(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.Brandons-MacBook-Pro.pkgs;
      fixture = import ${JSON.stringify(`${repoRoot}/tests/git-mcp/fixtures/signing-tools.nix`)} { inherit pkgs; };
    in
    {
      bundle = builtins.unsafeDiscardStringContext "\${fixture.packages}";
      nativeToolNames = builtins.mapAttrs (_: package: package.name) fixture.nativeTools;
      nativeToolPaths = fixture.nativeToolPaths;
      interceptorPaths = fixture.interceptorPaths;
      agentTrapExecutable = fixture.agentTrapExecutable;
      scenarios = fixture.scenarios;
    }
  `);
  return cachedFixtureSummary;
}

function buildFixtureBundle() {
  if (cachedFixtureBundle) return cachedFixtureBundle;
  const expression = `
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.Brandons-MacBook-Pro.pkgs;
      fixture = import ${JSON.stringify(`${repoRoot}/tests/git-mcp/fixtures/signing-tools.nix`)} {
        inherit pkgs;
        signerPackage = { nativeToolPaths, ... }:
          pkgs.writeShellApplication {
            name = "fixture-signer-probe";
            text = ''
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.scAuth}
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.provider}
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.sshKeygen}
            '';
          };
        adminPackage = { nativeToolPaths, ... }:
          pkgs.writeShellApplication {
            name = "fixture-admin-probe";
            text = ''
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.scAuth}
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.provider}
              printf '%s\\n' \${builtins.toJSON nativeToolPaths.sshKeygen}
            '';
          };
      };
    in fixture.packages
  `;
  cachedFixtureBundle = childProcess.execFileSync(
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
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ).trim();
  return cachedFixtureBundle;
}

function processControlCommand(bundle) {
  return path.join(bundle, 'process-control', 'bin', 'process-control');
}

function runProcessControl(command, arguments_) {
  const result = childProcess.spawnSync(command, arguments_, { encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function runProcessControlAsync(command, arguments_) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, arguments_, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

let fixtureProcessControlCommand;

function createOwnershipContext() {
  assert.ok(fixtureProcessControlCommand, 'process-control fixture is required');
  return {
    processControlCommand: fixtureProcessControlCommand,
    sessionToken: crypto.randomUUID(),
  };
}

test.before(() => {
  fixtureProcessControlCommand = processControlCommand(buildFixtureBundle());
  fs.accessSync(fixtureProcessControlCommand, fs.constants.X_OK);
});

test('exports a Go process-control fixture with validated group cleanup', {
  timeout: 60_000,
}, async () => {
  const bundle = buildFixtureBundle();
  const control = processControlCommand(bundle);
  const root = createScenarioRoot({});
  const sessionToken = crypto.randomUUID();
  const expectedExecutable = fs.realpathSync(process.execPath);
  let worker;
  let primaryError;

  try {
    assert.equal(fs.existsSync(processControlSourcePath), true, 'fixture process control is Go source');
    assert.ok(fs.existsSync(control), 'fixture bundle exports process-control');

    worker = childProcess.spawn(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 10_000);'],
      { detached: true, stdio: 'ignore' },
    );
    assert.ok(worker.pid, 'fixture worker has a PID');

    const identity = runProcessControl(control, ['inspect', String(worker.pid)]);
    assert.equal(identity.status, 0, identity.stderr);
    const fields = identity.stdout.trim().split('\t');
    assert.equal(fields.length, 5, identity.stdout);
    assert.equal(Number(fields[0]), worker.pid);
    assert.equal(fields[4], expectedExecutable);

    const session = runProcessControl(control, ['session', String(worker.pid)]);
    assert.equal(session.status, 0, session.stderr);
    assert.equal(session.stdout.trim(), fields[1], 'detached fixture worker owns its session');

    const group = runProcessControl(control, ['group', fields[1]]);
    assert.equal(group.status, 0, group.stderr);
    assert.ok(group.stdout.split('\n').includes(identity.stdout.trim()), 'group includes the exact worker identity');

    const record = runProcessControl(control, [
      'record',
      '--root', root,
      '--token', sessionToken,
      '--pid', String(worker.pid),
      '--expected-executable', expectedExecutable,
      '--role', 'fixture-contract-worker',
    ]);
    assert.equal(record.status, 0, record.stderr);
    const arbitraryRoleRecord = runProcessControl(control, [
      'record',
      '--root', root,
      '--token', sessionToken,
      '--pid', String(worker.pid),
      '--expected-executable', expectedExecutable,
      '--role', 'arbitrary-role',
    ]);
    assert.equal(arbitraryRoleRecord.status, 0, arbitraryRoleRecord.stderr);
    const arbitraryRoleRelease = runProcessControl(control, [
      'release-record', '--root', root, '--token', sessionToken,
      '--pid', String(worker.pid), '--role', 'arbitrary-role',
    ]);
    assert.equal(arbitraryRoleRelease.status, 64, arbitraryRoleRelease.stderr);
    assert.match(arbitraryRoleRelease.stderr, /release-record role must be agent-socket-trap-lifecycle/);
    assert.equal(
      fs.existsSync(path.join(root, 'ownership-releases', `${worker.pid}.json`)),
      false,
      'ordinary roles cannot create lifecycle release artifacts',
    );
    const capture = runProcessControl(control, [
      'capture-group',
      '--root', root,
      '--token', sessionToken,
      '--anchor', String(worker.pid),
      '--role', 'fixture-contract-group-member',
    ]);
    assert.equal(capture.status, 0, capture.stderr);

    const unrelatedRoleCleanup = runProcessControl(control, [
      'cleanup', '--root', root, '--token', sessionToken,
      '--role', 'fixture-contract-worker', '--timeout-ms', '100',
    ]);
    assert.equal(unrelatedRoleCleanup.status, 64, unrelatedRoleCleanup.stderr);
    assert.match(unrelatedRoleCleanup.stderr, /cleanup role must be agent-socket-trap-lifecycle/);
    assert.equal(runProcessControl(control, ['inspect', String(worker.pid)]).status, 0);

    const arbitraryRoleStates = runProcessControl(control, [
      'states', '--root', root, '--token', sessionToken, '--role', 'arbitrary-role',
    ]);
    assert.equal(arbitraryRoleStates.status, 64, arbitraryRoleStates.stderr);
    assert.match(arbitraryRoleStates.stderr, /states role must be agent-socket-trap-lifecycle/);

    const unfilteredRecords = runProcessControl(control, [
      'records', '--root', root, '--token', sessionToken,
    ]);
    assert.equal(unfilteredRecords.status, 0, unfilteredRecords.stderr);
    assert.ok(
      JSON.parse(unfilteredRecords.stdout).some((record_) => (
        record_.pid === worker.pid && record_.role === 'fixture-contract-worker'
      )),
      'unfiltered records retain the worker ownership record',
    );
    assert.ok(
      JSON.parse(unfilteredRecords.stdout).some((record_) => (
        record_.pid === worker.pid && record_.role === 'arbitrary-role'
      )),
      'an invalid lifecycle release retains the ordinary ownership record',
    );

    const arbitraryRoleRecords = runProcessControl(control, [
      'records', '--root', root, '--token', sessionToken, '--role', 'arbitrary-role',
    ]);
    assert.equal(arbitraryRoleRecords.status, 64, arbitraryRoleRecords.stderr);
    assert.match(arbitraryRoleRecords.stderr, /records role must be agent-socket-trap-lifecycle/);

    const retainedRecords = runProcessControl(control, [
      'records', '--root', root, '--token', sessionToken,
    ]);
    assert.equal(retainedRecords.status, 0, retainedRecords.stderr);
    assert.ok(
      JSON.parse(retainedRecords.stdout).some((record_) => (
        record_.pid === worker.pid && record_.role === 'fixture-contract-worker'
      )),
      'an invalid records role cannot hide the worker ownership record',
    );

    const foreignCleanup = runProcessControl(control, [
      'cleanup', '--root', root, '--token', `${sessionToken}-foreign`, '--timeout-ms', '100',
    ]);
    assert.notEqual(foreignCleanup.status, 0, 'a foreign token must not clean an owned worker');
    assert.match(foreignCleanup.stderr, /foreign .*token/i);
    assert.equal(runProcessControl(control, ['inspect', String(worker.pid)]).status, 0);

    const ownershipDirectory = path.join(root, 'owned-processes');
    const staleRecordPath = fs.readdirSync(ownershipDirectory)
      .map((fileName) => path.join(ownershipDirectory, fileName))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')).role === 'fixture-contract-worker');
    assert.ok(staleRecordPath, 'the Go CLI recorded the direct worker identity');
    const staleRecord = JSON.parse(fs.readFileSync(staleRecordPath, 'utf8'));
    staleRecord.startMicroseconds = (staleRecord.startMicroseconds + 1) % 1_000_000;
    fs.writeFileSync(staleRecordPath, `${JSON.stringify(staleRecord)}\n`, { mode: 0o600 });

    const staleCleanup = runProcessControl(control, [
      'cleanup', '--root', root, '--token', sessionToken, '--pid', String(worker.pid), '--timeout-ms', '100',
    ]);
    assert.notEqual(staleCleanup.status, 0, 'stale identity metadata must not signal a reused PID');
    assert.match(staleCleanup.stderr, /refusing to signal/i);
    assert.equal(runProcessControl(control, ['inspect', String(worker.pid)]).status, 0);
    fs.rmSync(staleRecordPath);

    await runProcessControlAsync(control, [
      'cleanup', '--root', root, '--token', sessionToken, '--timeout-ms', '2_000',
    ]);
    const absent = await inspectAfterChildExit(
      worker,
      () => runProcessControl(control, ['inspect', String(worker.pid)]),
    );
    assert.equal(absent.status, 3, absent.stderr);
    const absentGroup = runProcessControl(control, ['group', fields[1]]);
    assert.equal(absentGroup.status, 3, absentGroup.stderr);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const finalizationErrors = [];
    if (worker) {
      if (fs.existsSync(control)) {
        try {
          await runProcessControlAsync(control, [
            'cleanup', '--root', root, '--token', sessionToken, '--timeout-ms', '2_000',
          ]);
        } catch (error) {
          finalizationErrors.push(error);
        }
      }
      try {
        assert.equal(
          await waitForChildExit(worker, 2_000),
          true,
          'fixture worker child did not exit during finalization',
        );
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (primaryError) {
      if (finalizationErrors.length > 0) primaryError.finalizationErrors = finalizationErrors;
    } else if (finalizationErrors.length === 1) {
      throw finalizationErrors[0];
    } else if (finalizationErrors.length > 1) {
      throw new AggregateError(finalizationErrors, 'fixture process-control finalization failed');
    }
  }
});

test('fixture process control leaves no legacy C or JavaScript ownership helper', () => {
  assert.equal(fs.existsSync(legacyProcessIdentitySourcePath), false);
  assert.equal(fs.existsSync(legacyProcessOwnershipPath), false);
});

function assertLoggedCall(root, tool, operation) {
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    calls.some((call) => call.tool === tool && call.operation === operation),
    `expected ${tool}/${operation} in the fixture call log`,
  );
}

function readJsonLines(root, fileName) {
  return fs.readFileSync(path.join(root, fileName), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readHangEntries(root) {
  const filePath = path.join(root, 'hang-entries');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tool, operation, pid] = line.split('\t');
      return { tool, operation, pid: Number(pid) };
    });
}

async function waitForHangEntries(root, minimumEntries) {
  const deadline = Date.now() + 2_000;
  let entries = [];
  while (Date.now() < deadline) {
    entries = readHangEntries(root);
    if (entries.length >= minimumEntries) return entries;
    await wait(10);
  }
  assert.fail(`expected ${minimumEntries} hang entries, got ${entries.length}`);
}

const identityTableHeader = 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid';

function assertRawIdentityTable(output) {
  assert.ok(output.includes('\r\n'), 'native identity output preserves CRLF row endings');
  assert.equal(output.endsWith('\r\n'), true, 'native identity output preserves its trailing CRLF');
  assert.match(
    output,
    /^\s+Key Type\s+Public Key Hash\s+Prot\s+Label\s+Common Name\s+Email Address\s+Valid To Valid\s+\r\n/,
    'native identity output preserves header whitespace',
  );

  const rows = output.split('\r\n').slice(1, -1).filter(Boolean);
  assert.ok(
    rows.some((row) => {
      const fields = row.trim().split(/\s+/);
      return fields[0] === 'p-384-ne'
        && fields.length === 9
        && fields[5] === 'p384@example.test'
        && fields[8] === 'YES';
    }),
    'raw table includes an unrelated p-384-ne row with an optional email',
  );
  assert.ok(
    rows.some((row) => {
      const fields = row.trim().split(/\s+/);
      return fields[0] === 'p-521' && fields.length === 8 && fields[7] === 'YES';
    }),
    'raw table includes an unrelated p-521 row without an email',
  );
  assert.ok(
    rows.some((row) => {
      const fields = row.trim().split(/\s+/);
      return fields[0] === 'p-256-ne' && fields[2] === 'none' && fields.length === 8;
    }),
    'raw table includes the exact configured p-256-ne row without an email',
  );
}

function parseIdentityTable(output) {
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.shift(), identityTableHeader);
  return lines.map((line) => {
    const fields = line.split(/\s+/);
    assert.equal(fields.length, 8, `documented CTK row has eight populated fields: ${line}`);
    const [keyType, hash, protection, label, commonName, validToDate, validToTime, valid] = fields;
    assert.ok(
      ['p-256', 'p-256-ne', 'p-384', 'p-384-ne', 'p-521'].includes(keyType),
      `documented CTK row has a supported key type: ${line}`,
    );
    assert.match(hash, /^[0-9A-F]{40}$/);
    assert.ok(['bio', 'none'].includes(protection));
    assert.ok(label);
    assert.equal(commonName, 'ssh');
    assert.match(validToDate, /^\d{2}\.\d{2}\.\d{2},$/);
    assert.match(validToTime, /^\d{2}:\d{2}$/);
    assert.equal(valid, 'YES');
    return {
      keyType,
      hash: hash.toLowerCase(),
      protection,
      label,
      commonName,
      validToDate,
      validToTime,
      valid,
    };
  });
}

function expectedIdentityTableRows(identities) {
  return identities.map((identity) => ({
    keyType: identity.keyType || 'p-256-ne',
    hash: identity.hash,
    protection: identity.protection || 'none',
    label: identity.label,
    commonName: identity.commonName || 'ssh',
    validToDate: identity.validToDate || '23.11.26,',
    validToTime: identity.validToTime || '17:09',
    valid: 'YES',
  }));
}

function withoutRawListingSelector(listing, selector, caseInsensitive = false) {
  const expected = caseInsensitive ? selector.toLowerCase() : selector;
  return listing.split(/(?<=\n)/).filter((line) => {
    const observed = line.trim().split(/\s+/)[1];
    if (!observed) return true;
    return (caseInsensitive ? observed.toLowerCase() : observed) !== expected;
  }).join('');
}

function assertHarnessResult(root) {
  const results = readJsonLines(root, harnessResultsFile);
  assert.equal(results.length, 1, 'one harness result is recorded per hang execution');
  const [result] = results;
  assert.equal(result.kind, 'harness-result');
  assert.equal(result.requestedSignal, 'SIGKILL');
  assert.equal(result.child.signal, 'SIGKILL');
  assert.equal(result.child.code, null);
  assert.ok(result.lifecycle.includes('exit'), 'harness result records the child exit lifecycle');
  assert.ok(result.lifecycle.includes('close'), 'harness result records child stream cleanup');
  assert.equal(fs.existsSync(path.join(root, 'events.jsonl')), false, 'killed fixtures do not claim a native result');
  assert.deepEqual(
    [...result.recordedPids].sort((left, right) => left - right),
    [...result.verifiedGonePids].sort((left, right) => left - right),
    'every recorded process is verified gone independently of group cleanup',
  );
  assert.equal(result.nativeResultRecorded, false, 'killed fixtures use the harness result, not native EXIT traps');
}

function createScenarioRoot(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-signing-fixture-'));
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario), { mode: 0o600 });
  return root;
}

function installResidentExport(root, scenario, residentExport = scenario.residentExports[0]) {
  assert.ok(residentExport, 'scenario has a resident export');
  const stubPath = path.join(root, residentExport.stubName);
  fs.writeFileSync(stubPath, `${residentExport.stub}\n`, { mode: 0o600 });
  fs.writeFileSync(`${stubPath}.pub`, `${residentExport.publicKey}\n`, { mode: 0o644 });
  return { stubPath, publicPath: `${stubPath}.pub` };
}

function fixtureEnvironment(root, ownership) {
  return {
    ...process.env,
    GIT_MCP_SIGNING_FIXTURE_ROOT: root,
    ...(ownership ? {
      GIT_MCP_PROCESS_IDENTITY_HELPER: ownership.processControlCommand,
      GIT_MCP_OWNERSHIP_TOKEN: ownership.sessionToken,
    } : {}),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await wait(10);
  }
  assert.ok(fs.existsSync(filePath), `expected fixture file ${filePath}`);
}

function readProcessTree(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split(' ').map(Number))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForProcessTree(filePath, minimumPids) {
  const deadline = Date.now() + 2_000;
  let pids = [];
  while (Date.now() < deadline) {
    pids = readProcessTree(filePath);
    if (pids.length >= minimumPids) return pids;
    await wait(10);
  }
  assert.fail(`expected ${minimumPids} process-tree PIDs in ${filePath}, got ${pids.length}`);
}

test('waits for complete process-tree records after the file is created', async () => {
  const root = createScenarioRoot({});
  const treePath = path.join(root, 'process-tree');
  let writeTree;
  try {
    fs.writeFileSync(treePath, '', { mode: 0o600 });
    writeTree = new Promise((resolve) => {
      setTimeout(() => {
        fs.writeFileSync(treePath, '41001 41002\n', { mode: 0o600 });
        resolve();
      }, 25);
    });

    assert.deepEqual(await waitForProcessTree(treePath, 2), [41001, 41002]);
  } finally {
    await writeTree;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function childExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(exited) {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(exited);
    }
    child.once('close', onClose);
    child.once('error', onError);
    if (childExited(child)) finish(true);
  });
}

function waitForTrackedChildClose(child, lifecycle, timeoutMs) {
  if (lifecycle.close || lifecycle.error) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onClose = () => finish(true);
    const onError = () => finish(true);
    function finish(closed) {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    }
    child.once('close', onClose);
    child.once('error', onError);
    if (lifecycle.close || lifecycle.error) finish(true);
  });
}

async function cleanupAgentSocketTrapLifecycle(root, ownership, trap, lifecycle) {
  await runProcessControlAsync(ownership.processControlCommand, [
    'cleanup', '--root', root, '--token', ownership.sessionToken,
    '--role', agentLifecycleRole, '--timeout-ms', '2_000',
  ]);
  assert.equal(
    await waitForTrackedChildClose(trap, lifecycle, 2_000),
    true,
    'agent socket trap emits close after Go lifecycle cleanup',
  );
  const { stdout } = await runProcessControlAsync(ownership.processControlCommand, [
    'states', '--root', root, '--token', ownership.sessionToken,
    '--role', agentLifecycleRole,
  ]);
  const states = JSON.parse(stdout);
  assert.equal(states.length, 1, 'lifecycle cleanup verifies exactly one lifecycle record');
  assert.deepEqual(
    states.filter((entry) => entry.state !== 'gone'),
    [],
    'lifecycle cleanup leaves no non-gone lifecycle record',
  );
  return states;
}

async function inspectAfterChildExit(child, inspect) {
  assert.equal(
    await waitForChildExit(child, 2_000),
    true,
    'fixture worker child did not exit before raw PID inspection',
  );
  return inspect();
}

test('raw process inspection waits for the child lifecycle', async () => {
  const worker = new EventEmitter();
  worker.exitCode = null;
  worker.signalCode = null;
  let inspected = false;

  const status = inspectAfterChildExit(worker, () => {
    inspected = true;
    return 3;
  });
  assert.equal(inspected, false, 'raw PID inspection must wait for child lifecycle completion');

  worker.exitCode = 0;
  worker.emit('close', 0, null);
  assert.equal(await status, 3);
});

async function waitForWorkerGroupOrChildExit(root, ownership, child, timeoutMs = fixtureStartupTimeoutMs) {
  const workerGroups = runProcessControlAsync(ownership.processControlCommand, [
    'wait-groups',
    '--root', root,
    '--token', ownership.sessionToken,
    '--count', '1',
    '--timeout-ms', String(timeoutMs),
  ]).then(
    ({ stdout }) => ({ groups: JSON.parse(stdout) }),
    (error) => ({ error }),
  );
  const childExit = new Promise((resolve) => {
    if (childExited(child)) {
      resolve({ exited: true });
      return;
    }
    child.once('exit', () => resolve({ exited: true }));
  });
  const result = await Promise.race([workerGroups, childExit]);
  if (result.groups) return result.groups;
  if (result.exited || childExited(child)) return [];
  if (result.error) {
    assert.match(result.error.stderr, /expected 1 complete worker-group records/);
  }
  assert.fail('hung fixture did not publish a complete worker-group record before cleanup');
}

async function waitForOwnedRecord(root, ownership, role, pid, timeoutMs = 2_000) {
  const { stdout } = await runProcessControlAsync(ownership.processControlCommand, [
    'wait-record',
    '--root', root,
    '--token', ownership.sessionToken,
    '--pid', String(pid),
    '--role', role,
    '--timeout-ms', String(timeoutMs),
  ]);
  const record = JSON.parse(stdout);
  assert.equal(record.role, role, `expected durable ownership record for ${role} ${pid}`);
  return record;
}

async function terminateHungFixture(command, args, env, root, {
  beforeWorkerGroupReady,
  afterWorkerGroupReady,
} = {}) {
  const ownership = createOwnershipContext();
  const child = childProcess.spawn(command, args, {
    detached: true,
    env: {
      ...env,
      GIT_MCP_SIGNING_FIXTURE_ROOT: root,
      GIT_MCP_PROCESS_IDENTITY_HELPER: ownership.processControlCommand,
      GIT_MCP_OWNERSHIP_TOKEN: ownership.sessionToken,
      GIT_MCP_FIXTURE_STARTUP_TIMEOUT_MS: String(fixtureStartupTimeoutMs),
    },
    stdio: 'ignore',
  });
  assert.ok(child.pid, 'hung fixture has a process id');
  const lifecycle = ['spawned'];
  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      lifecycle.push('error');
      resolve({ code: null, signal: null, error: { code: error.code, message: error.message } });
    });
    child.once('exit', (code, signal) => {
      lifecycle.push('exit');
      resolve({ code, signal });
    });
  });
  const close = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      lifecycle.push('close');
      resolve({ code, signal });
    });
  });
  const childLifecycle = Promise.all([exit, close]).then(([childExit, childClose]) => ({
    childExit,
    childClose,
  }));
  let descendants = [];
  const verifiedGonePids = [];
  let lifecycleResult;
  let failure;
  try {
    if (beforeWorkerGroupReady) await beforeWorkerGroupReady({ child, ownership, root });
    const groups = await waitForWorkerGroupOrChildExit(root, ownership, child);
    descendants = [...new Set(groups.flatMap((group) => group.members.map((member) => member.pid)))];
    if (groups.length > 0) {
      assert.ok(descendants.length >= 2, 'hung fixture records a worker and descendant');
      if (afterWorkerGroupReady) await afterWorkerGroupReady({ child, groups, ownership, root });
      await runProcessControlAsync(ownership.processControlCommand, [
        'cleanup', '--root', root, '--token', ownership.sessionToken, '--timeout-ms', '2_000',
      ]);
      verifiedGonePids.push(...descendants);
    }
    lifecycleResult = await childLifecycle;
    assert.equal(lifecycleResult.childExit.error, undefined, 'hung fixture child spawned successfully');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await runProcessControlAsync(ownership.processControlCommand, [
        'cleanup', '--root', root, '--token', ownership.sessionToken, '--timeout-ms', '2_000',
      ]);
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
    }
    if (!lifecycleResult) {
      if (await waitForChildExit(child, 2_000)) {
        lifecycleResult = await childLifecycle;
      } else {
        lifecycleResult = {
          childExit: { code: null, signal: null, error: { message: 'child did not exit' } },
          childClose: { code: null, signal: null },
        };
      }
    }
    fs.appendFileSync(
      path.join(root, harnessResultsFile),
      `${JSON.stringify({
        kind: 'harness-result',
        requestedSignal: 'SIGKILL',
        command,
        args,
        child: lifecycleResult.childExit,
        close: lifecycleResult.childClose,
        lifecycle,
        recordedPids: descendants,
        verifiedGonePids,
        nativeResultRecorded: false,
        failure: failure ? { name: failure.name, message: failure.message } : null,
      })}\n`,
      { mode: 0o600 },
    );
    if (failure && !childExited(child)) {
      throw new Error(
        `${failure.message}\nfixture child ${child.pid} lacks a validated ownership record; refusing to signal`,
      );
    }
    if (failure) throw failure;
  }
}

test('terminateHungFixture waits for a complete attested worker group before cleanup', {
  timeout: 60_000,
}, async () => {
  const summary = fixtureSummary();
  const bundle = buildFixtureBundle();
  const scAuth = path.join(bundle, 'native/sc-auth/bin/fixture-sc-auth');
  const root = createScenarioRoot(summary.scenarios.hangCtkListing);
  try {
    await terminateHungFixture(
      scAuth,
      ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'],
      fixtureEnvironment(root),
      root,
    );
    const groupDirectory = path.join(root, 'worker-groups');
    assert.ok(fs.existsSync(groupDirectory), 'fixture publishes worker groups only after registration completes');
    const manifests = fs.readdirSync(groupDirectory)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => JSON.parse(fs.readFileSync(path.join(groupDirectory, fileName), 'utf8')));
    assert.equal(manifests.length, 1, 'one hanging native invocation owns one worker group');
    const [manifest] = manifests;
    assert.equal(manifest.kind, 'worker-group');
    assert.ok(manifest.sessionToken, 'worker group has a nonempty ownership token');
    assert.ok(manifest.members.length >= 2, 'worker group includes its worker and descendant');
    for (const member of manifest.members) {
      assert.equal(member.processGroup, manifest.processGroup, 'member remains scoped to its recorded group');
      for (const field of [
        'pid',
        'processGroup',
        'startSeconds',
        'startMicroseconds',
        'executable',
        'expectedExecutable',
        'role',
        'sessionToken',
      ]) {
        assert.notEqual(member[field], undefined, `member records ${field}`);
      }
    }
    assertHarnessResult(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hang fixtures do not enter their hang before Go publishes worker-group readiness', {
  timeout: 60_000,
}, async () => {
  const summary = fixtureSummary();
  const bundle = buildFixtureBundle();
  const scAuth = path.join(bundle, 'native/sc-auth/bin/fixture-sc-auth');
  const root = createScenarioRoot({
    ...summary.scenarios.hangCtkListing,
    workerGroupPublicationDelayMs: 1_000,
  });
  try {
    await terminateHungFixture(
      scAuth,
      ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'],
      fixtureEnvironment(root),
      root,
      {
        beforeWorkerGroupReady: async () => {
          await waitForFile(path.join(root, 'descendants'));
          await wait(500);
          assert.deepEqual(
            readHangEntries(root),
            [],
            'fixture processes must not enter their hang before Go publishes the worker-group marker',
          );
        },
        afterWorkerGroupReady: async () => {
          const entries = await waitForHangEntries(root, 2);
          assert.equal(entries.length, 2, 'both fixture processes enter their hang after Go publishes readiness');
        },
      },
    );
    assertHarnessResult(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminateHungFixture observes a child that exits before group cleanup', async () => {
  const root = createScenarioRoot({});
  const writerScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const root = process.env.GIT_MCP_SIGNING_FIXTURE_ROOT;",
    "fs.writeFileSync(path.join(root, 'process-tree'), `${process.env.PARENT_PID} ${process.pid}\\n`);",
  ].join('');
  const script = [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const root = process.env.GIT_MCP_SIGNING_FIXTURE_ROOT;",
    `childProcess.spawn(process.execPath, ['-e', ${JSON.stringify(writerScript)}], { env: { ...process.env, PARENT_PID: String(process.pid) }, stdio: 'ignore' });`,
    "fs.writeFileSync(path.join(root, 'process-tree-ready'), 'parent-exited\\n');",
    "process.exit(0);",
  ].join('');

  try {
    let timeoutId;
    try {
      await Promise.race([
        terminateHungFixture(process.execPath, ['-e', script], fixtureEnvironment(root), root),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('terminateHungFixture lost the already-exited child lifecycle')),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    const [result] = readJsonLines(root, harnessResultsFile);
    assert.equal(result.child.code, 0);
    assert.equal(result.child.signal, null);
    assert.ok(result.lifecycle.includes('exit'));
    assert.ok(result.lifecycle.includes('close'));
    assert.deepEqual(
      [...result.recordedPids].sort((left, right) => left - right),
      [...result.verifiedGonePids].sort((left, right) => left - right),
    );
    assert.equal(result.nativeResultRecorded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw identity deletion preserves every unrelated SHA1 and SSH listing row', () => {
  const summary = fixtureSummary();
  const bundle = buildFixtureBundle();
  const scAuth = path.join(bundle, 'native/sc-auth/bin/fixture-sc-auth');
  const identityListArgs = ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'];
  const sshListArgs = ['list-ctk-identities', '-t', 'ssh'];
  const target = summary.scenarios.rawTableVariants.identitySnapshots.after[0];
  const rawSshListing = [
    '  Key Type  Public Key Hash Prot Label Common Name Email Address Valid To Valid  ',
    '  p-384-ne SHA256:fixturep384ne bio fixture-p384 ssh p384@example.test 23.11.26, 17:09 YES  ',
    ' p-384 SHA256:fixturep384 none fixture-p384 ssh 23.11.26, 17:09 YES ',
    ' p-521 SHA256:fixturep521 none fixture-p521 ssh 23.11.26, 17:09 YES ',
    ' p-256 SHA256:fixturep256 none fixture-p256 ssh 23.11.26, 17:09 YES ',
    ` p-256-ne ${target.sshFingerprint} none ${target.label} ssh 23.11.26, 17:09 YES `,
  ].join('\r\n') + '\r\n';
  const expectedSha1 = withoutRawListingSelector(
    summary.scenarios.rawTableVariants.rawIdentityListings.after,
    target.hash,
    true,
  );
  const expectedSsh = withoutRawListingSelector(rawSshListing, target.sshFingerprint);

  for (const sshListingSource of ['rawSshIdentityListings', 'sshIdentityListings']) {
    const scenario = {
      ...summary.scenarios.rawTableVariants,
      rawSshIdentityListings: {},
      sshIdentityListings: {},
      [sshListingSource]: { after: rawSshListing },
    };
    const root = createScenarioRoot(scenario);
    try {
      const env = fixtureEnvironment(root);
      fs.writeFileSync(path.join(root, 'identity-snapshot'), 'after\n', { mode: 0o600 });
      assert.equal(childProcess.execFileSync(scAuth, identityListArgs, { env, encoding: 'utf8' }), scenario.rawIdentityListings.after);
      assert.equal(childProcess.execFileSync(scAuth, sshListArgs, { env, encoding: 'utf8' }), rawSshListing);

      childProcess.execFileSync(
        scAuth,
        ['delete-ctk-identity', '-h', target.hash],
        { env, encoding: 'utf8' },
      );

      assert.equal(
        childProcess.execFileSync(scAuth, identityListArgs, { env, encoding: 'utf8' }),
        expectedSha1,
        `${sshListingSource} deletion preserves unrelated raw SHA1 rows byte-for-byte`,
      );
      assert.equal(
        childProcess.execFileSync(scAuth, sshListArgs, { env, encoding: 'utf8' }),
        expectedSsh,
        `${sshListingSource} deletion preserves unrelated SSH rows byte-for-byte`,
      );
      const deleteCall = readJsonLines(root, 'calls.jsonl')
        .find((call) => call.tool === 'sc_auth' && call.operation === 'delete');
      assert.deepEqual(deleteCall.argv, ['delete-ctk-identity', '-h', target.hash]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const ambiguousRoot = createScenarioRoot({
    ...summary.scenarios.rawTableVariants,
    rawSshIdentityListings: { after: rawSshListing },
  });
  try {
    const env = fixtureEnvironment(ambiguousRoot);
    fs.writeFileSync(path.join(ambiguousRoot, 'identity-snapshot'), 'after\n', { mode: 0o600 });
    childProcess.execFileSync(
      scAuth,
      ['delete-ctk-identity', '-h', '3333333333333333333333333333333333333333'],
      { env, encoding: 'utf8' },
    );
    const ambiguousSshListing = childProcess.spawnSync(
      scAuth,
      sshListArgs,
      { env, encoding: 'utf8' },
    );
    assert.notEqual(ambiguousSshListing.status, 0, 'duplicate labels cannot guess a hash-to-fingerprint mapping');
    assert.equal(ambiguousSshListing.stdout, '');
    assert.match(ambiguousSshListing.stderr, /deleted CTK hash label is ambiguous/);
  } finally {
    fs.rmSync(ambiguousRoot, { recursive: true, force: true });
  }
});

test('signing fixtures expose isolated native scenarios and inspectable calls', async () => {
  const summary = fixtureSummary();
  const identityListArgs = ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'];
  const requiredScenarios = [
    'identitySnapshots',
    'rawTableVariants',
    'zeroResidentExports',
    'oneResidentExport',
    'multipleResidentExports',
    'multipleResidentExportsExpectedSecond',
    'rotation',
    'ambiguousResidentFingerprint',
    'mismatchedExpectedFingerprint',
    'stubKeyMismatch',
    'fingerprintOutputMismatch',
    'ctkListingFailure',
    'staleSameLabel',
    'duplicateSshIdentity',
    'ambiguousIdentity',
    'biometricConfiguredIdentity',
    'rawBiometricConfiguredIdentity',
    'malformedIdentity',
    'rawMalformedIdentity',
    'invalidStatusIdentity',
    'rawInvalidStatusIdentity',
    'rawDuplicateIdentity',
    'selectorMismatch',
    'hangCtkListing',
    'hangPreflightProvider',
    'hangPreflightSshKeygen',
    'hangPreflightSshKeygenStub',
    'hangProviderSigning',
    'hangAllPreflightPhases',
    'postCreateListFailure',
    'postCreateMalformedIdentity',
    'workerTree',
  ];

  for (const scenario of requiredScenarios) {
    assert.ok(summary.scenarios[scenario], `missing fixture scenario: ${scenario}`);
  }

  assert.deepEqual(Object.keys(summary.nativeToolNames).sort(), ['provider', 'scAuth', 'sshKeygen']);
  for (const nativePath of Object.values(summary.nativeToolPaths)) {
    assert.match(nativePath, /^\/nix\/store\//);
  }
  for (const interceptorPath of Object.values(summary.interceptorPaths)) {
    assert.match(interceptorPath, /^\/nix\/store\//);
  }

  const bundle = buildFixtureBundle();
  const scAuth = path.join(bundle, 'native/sc-auth/bin/fixture-sc-auth');
  const sshKeygen = path.join(bundle, 'native/ssh-keygen/bin/fixture-ssh-keygen');
  const provider = path.join(bundle, 'native/provider/bin/fixture-provider');
  const agentSocketTrap = path.join(
    bundle,
    'interceptors/agent-socket-trap/bin/fixture-agent-socket-trap',
  );
  const fallback = path.join(bundle, 'interceptors/fallback/bin/fixture-fallback-signer');
  const providerNativePath = summary.nativeToolPaths.provider;
  const expectedNativePaths = [
    summary.nativeToolPaths.scAuth,
    summary.nativeToolPaths.provider,
    summary.nativeToolPaths.sshKeygen,
  ];
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    assert.ok(fs.existsSync(agentSocketTrap), 'fixture bundle contains the agent socket trap');
    assert.ok(fs.existsSync(fallback), 'fixture bundle contains the fallback endpoint');
    const env = fixtureEnvironment(root);
    for (const packageName of ['signer', 'admin']) {
      const output = childProcess.execFileSync(
        path.join(bundle, packageName, 'bin', `fixture-${packageName}-probe`),
        { encoding: 'utf8' },
      ).trim().split('\n');
      assert.deepEqual(output, expectedNativePaths, `${packageName} paths are injected at build time`);
    }
    const exportDir = path.join(root, 'exports');
    fs.mkdirSync(exportDir);

    childProcess.execFileSync(scAuth, identityListArgs, { env, encoding: 'utf8' });
    childProcess.execFileSync(scAuth, ['export', '--output-dir', exportDir], { env, encoding: 'utf8' });
    childProcess.execFileSync(sshKeygen, ['-lf', path.join(exportDir, 'id_ecdsa_sk_rk.pub')], {
      env: {
        ...env,
        SSH_SK_PROVIDER: provider,
      },
      encoding: 'utf8',
    });

    assertLoggedCall(root, 'sc_auth', 'list');
    assertLoggedCall(root, 'sc_auth', 'export');
    assertLoggedCall(root, 'ssh-keygen', 'fingerprint');
    assert.ok(fs.existsSync(path.join(root, 'events.jsonl')), 'fixture result log exists');
    assert.equal(fs.existsSync(path.join(root, harnessResultsFile)), false);
    assert.ok(fs.existsSync(path.join(exportDir, 'id_ecdsa_sk_rk')));
    assert.ok(fs.existsSync(path.join(exportDir, 'id_ecdsa_sk_rk.pub')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const rawTableRoot = createScenarioRoot(summary.scenarios.rawTableVariants);
  try {
    fs.writeFileSync(path.join(rawTableRoot, 'identity-snapshot'), 'after\n', { mode: 0o600 });
    const rawOutput = childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: fixtureEnvironment(rawTableRoot), encoding: 'utf8' },
    );
    assertRawIdentityTable(rawOutput);
    assert.equal(
      rawOutput,
      summary.scenarios.rawTableVariants.rawIdentityListings.after,
      'fixture emits the declared raw CTK table instead of regenerating JSON rows',
    );
  } finally {
    fs.rmSync(rawTableRoot, { recursive: true, force: true });
  }

  for (const [scenarioName, expectedExports] of [
    ['zeroResidentExports', 0],
    ['oneResidentExport', 1],
    ['multipleResidentExports', 2],
    ['multipleResidentExportsExpectedSecond', 2],
  ]) {
    const scenarioRoot = createScenarioRoot(summary.scenarios[scenarioName]);
    try {
      const scenarioEnv = fixtureEnvironment(scenarioRoot);
      const exportDir = path.join(scenarioRoot, 'exports');
      const snapshot = parseIdentityTable(childProcess.execFileSync(
        scAuth,
        identityListArgs,
        { env: scenarioEnv, encoding: 'utf8' },
      ));
      assert.deepEqual(snapshot, [], `${scenarioName} starts with no identities`);
      childProcess.execFileSync(scAuth, ['export', '--output-dir', exportDir], {
        env: scenarioEnv,
        encoding: 'utf8',
      });
      const exportedFiles = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).sort() : [];
      const expectedFiles = summary.scenarios[scenarioName].residentExports
        .flatMap((residentExport) => [residentExport.stubName, `${residentExport.stubName}.pub`])
        .sort();
      assert.equal(expectedExports, summary.scenarios[scenarioName].residentExports.length);
      assert.deepEqual(exportedFiles, expectedFiles, `${scenarioName} exports are inspectable`);
      if (scenarioName === 'multipleResidentExports') {
        const fingerprints = summary.scenarios[scenarioName].residentExports.map((residentExport) => (
          childProcess.execFileSync(
            sshKeygen,
            ['-lf', path.join(exportDir, `${residentExport.stubName}.pub`)],
            { env: scenarioEnv, encoding: 'utf8' },
          ).trim().split(/\s+/)[1]
        ));
        const expectedFingerprints = summary.scenarios[scenarioName].residentExports
          .map((residentExport) => residentExport.fingerprint);
        assert.deepEqual(fingerprints, expectedFingerprints, 'fingerprints follow each public-key artifact');
        assert.equal(new Set(fingerprints).size, fingerprints.length, 'multiple exports have distinct fingerprints');
      }
      assertLoggedCall(scenarioRoot, 'sc_auth', 'list');
      assertLoggedCall(scenarioRoot, 'sc_auth', 'export');
      assert.ok(readJsonLines(scenarioRoot, 'events.jsonl').every((event) => event.status === 0));
      assert.equal(fs.existsSync(path.join(scenarioRoot, harnessResultsFile)), false);
    } finally {
      fs.rmSync(scenarioRoot, { recursive: true, force: true });
    }
  }

  const identityRoot = createScenarioRoot(summary.scenarios.identitySnapshots);
  try {
    const identityEnv = fixtureEnvironment(identityRoot);
    const before = parseIdentityTable(childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: identityEnv, encoding: 'utf8' },
    ));
    childProcess.execFileSync(scAuth, ['create', '--label', 'fixture-primary'], {
      env: identityEnv,
      encoding: 'utf8',
    });
    const after = parseIdentityTable(childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: identityEnv, encoding: 'utf8' },
    ));
    assert.deepEqual(
      before,
      expectedIdentityTableRows(summary.scenarios.identitySnapshots.identitySnapshots.before),
    );
    assert.deepEqual(
      after,
      expectedIdentityTableRows(summary.scenarios.identitySnapshots.identitySnapshots.after),
    );
  } finally {
    fs.rmSync(identityRoot, { recursive: true, force: true });
  }

  const deletionRoot = createScenarioRoot(summary.scenarios.rotation);
  try {
    const deletionEnv = fixtureEnvironment(deletionRoot);
    const [targetIdentity, replacementIdentity] = summary.scenarios.rotation.identitySnapshots.after;
    fs.writeFileSync(path.join(deletionRoot, 'identity-snapshot'), 'after\n', { mode: 0o600 });
    const beforeDeletion = parseIdentityTable(childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: deletionEnv, encoding: 'utf8' },
    ));
    assert.deepEqual(
      beforeDeletion,
      expectedIdentityTableRows([targetIdentity, replacementIdentity]),
    );

    const deleteAll = childProcess.spawnSync(
      scAuth,
      ['delete-all-ctk-identities'],
      { env: deletionEnv, encoding: 'utf8' },
    );
    assert.equal(deleteAll.status, 64, 'fixture refuses delete-all instead of masking unsafe callers');

    childProcess.execFileSync(
      scAuth,
      ['delete-ctk-identity', '-h', targetIdentity.hash],
      { env: deletionEnv, encoding: 'utf8' },
    );
    const afterDeletion = parseIdentityTable(childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: deletionEnv, encoding: 'utf8' },
    ));
    assert.deepEqual(
      afterDeletion,
      expectedIdentityTableRows([replacementIdentity]),
      'exact deletion removes only the requested CTK identity from subsequent listings',
    );
    const deleteCalls = readJsonLines(deletionRoot, 'calls.jsonl')
      .filter((call) => call.tool === 'sc_auth' && call.operation === 'delete');
    assert.deepEqual(deleteCalls.at(-1).argv, [
      'delete-ctk-identity',
      '-h',
      targetIdentity.hash,
    ]);
  } finally {
    fs.rmSync(deletionRoot, { recursive: true, force: true });
  }

  const incompatibleIdentity = {
    ...summary.scenarios.oneResidentExport.identitySnapshots.after[0],
    keyType: 'p-384-ne',
  };
  const incompatibleRoot = createScenarioRoot({
    ...summary.scenarios.oneResidentExport,
    identitySnapshots: { before: [], after: [incompatibleIdentity] },
  });
  try {
    fs.writeFileSync(path.join(incompatibleRoot, 'identity-snapshot'), 'after\n', { mode: 0o600 });
    const incompatibleRows = parseIdentityTable(childProcess.execFileSync(
      scAuth,
      identityListArgs,
      { env: fixtureEnvironment(incompatibleRoot), encoding: 'utf8' },
    ));
    assert.deepEqual(
      incompatibleRows,
      expectedIdentityTableRows([incompatibleIdentity]),
      'structured fixture identities preserve incompatible key types for fail-closed tests',
    );
  } finally {
    fs.rmSync(incompatibleRoot, { recursive: true, force: true });
  }

  const providerFailureRoot = createScenarioRoot(summary.scenarios.providerFailure);
  try {
    const { stubPath } = installResidentExport(
      providerFailureRoot,
      summary.scenarios.providerFailure,
    );
    assert.throws(
      () => childProcess.execFileSync(
        sshKeygen,
        ['-Y', 'sign', '-n', 'git', '-f', stubPath],
        {
          env: {
            ...fixtureEnvironment(providerFailureRoot),
            SSH_SK_PROVIDER: providerNativePath,
          },
          encoding: 'utf8',
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      ),
      (error) => error.status === 42,
    );
    assertLoggedCall(providerFailureRoot, 'provider', 'sign');
    assert.ok(readJsonLines(providerFailureRoot, 'events.jsonl').some((event) => event.status === 42));
    assert.equal(fs.existsSync(path.join(providerFailureRoot, harnessResultsFile)), false);
  } finally {
    fs.rmSync(providerFailureRoot, { recursive: true, force: true });
  }

  const hangExecutions = [
    {
      scenario: summary.scenarios.hangCtkListing,
      command: scAuth,
      args: identityListArgs,
      calls: [['sc_auth', 'list']],
    },
    {
      scenario: summary.scenarios.hangPreflightProvider,
      command: provider,
      args: ['load'],
      calls: [['provider', 'load']],
    },
    {
      scenario: summary.scenarios.hangPreflightSshKeygen,
      command: sshKeygen,
      args: ['-lf', 'fixture.pub'],
      calls: [['ssh-keygen', 'fingerprint']],
    },
    {
      scenario: summary.scenarios.hangPreflightSshKeygenStub,
      command: sshKeygen,
      args: ['-y', '-f', 'fixture-stub'],
      calls: [['ssh-keygen', 'stub']],
    },
    {
      scenario: summary.scenarios.hangProviderSigning,
      command: sshKeygen,
      args: ['-Y', 'sign', '-n', 'git', '-f', 'fixture-stub'],
      calls: [['ssh-keygen', 'sign'], ['provider', 'sign']],
    },
    {
      scenario: summary.scenarios.workerTree,
      command: sshKeygen,
      args: ['-Y', 'sign', '-n', 'git', '-f', 'fixture-stub'],
      calls: [['ssh-keygen', 'sign']],
    },
  ];

  const allPreflightPhaseCommands = {
    'preflight-provider': {
      command: provider,
      args: ['load'],
      calls: [['provider', 'load']],
    },
    'preflight-ssh-keygen': {
      command: sshKeygen,
      args: ['-lf', 'fixture.pub'],
      calls: [['ssh-keygen', 'fingerprint']],
    },
    'preflight-ssh-keygen-stub': {
      command: sshKeygen,
      args: ['-y', '-f', 'fixture-stub'],
      calls: [['ssh-keygen', 'stub']],
    },
    'provider-sign': {
      command: sshKeygen,
      args: ['-Y', 'sign', '-n', 'git', '-f', 'fixture-stub'],
      calls: [['ssh-keygen', 'sign'], ['provider', 'sign']],
    },
  };
  for (const phase of summary.scenarios.hangAllPreflightPhases.hangs) {
    assert.ok(allPreflightPhaseCommands[phase], `missing command coverage for ${phase}`);
    hangExecutions.push({
      scenario: {
        ...summary.scenarios.hangAllPreflightPhases,
        hangs: [phase],
      },
      ...allPreflightPhaseCommands[phase],
    });
  }

  for (const { scenario, command, args, calls } of hangExecutions) {
    const scenarioRoot = createScenarioRoot(scenario);
    try {
      let invocationArgs = args;
      if (command === sshKeygen && args.includes('sign')) {
        const { stubPath } = installResidentExport(scenarioRoot, scenario);
        invocationArgs = args.map((argument) => (argument === 'fixture-stub' ? stubPath : argument));
      }
      const scenarioEnv = fixtureEnvironment(scenarioRoot);
      if (command === sshKeygen) scenarioEnv.SSH_SK_PROVIDER = providerNativePath;
      await terminateHungFixture(command, invocationArgs, scenarioEnv, scenarioRoot);
      for (const [tool, operation] of calls) assertLoggedCall(scenarioRoot, tool, operation);
      assertHarnessResult(scenarioRoot);
    } finally {
      fs.rmSync(scenarioRoot, { recursive: true, force: true });
    }
  }
});

test('agent and fallback interceptors record only controlled fixture attempts', async () => {
  buildFixtureBundle();
  const summary = fixtureSummary();
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  const socketPath = path.join(root, 'agent.sock');
  const agentRecordPath = path.join(root, 'agent-calls.jsonl');
  const readyPath = path.join(root, 'agent-ready');
  const ownership = createOwnershipContext();
  let trap;
  let lifecycleRecorded = false;
  const lifecycle = { error: null, exit: null, close: null };

  try {
    trap = childProcess.spawn(
      summary.interceptorPaths.agentSocketTrap,
      [socketPath, agentRecordPath, readyPath],
      {
        env: fixtureEnvironment(root, ownership),
        stdio: 'ignore',
      },
    );
    trap.on('error', (error) => { lifecycle.error = error; });
    trap.on('exit', (code, signal) => { lifecycle.exit = { code, signal }; });
    trap.on('close', (code, signal) => { lifecycle.close = { code, signal }; });
    const expectedExecutable = fs.realpathSync(summary.agentTrapExecutable);
    await runProcessControlAsync(ownership.processControlCommand, [
      'record', '--root', root, '--token', ownership.sessionToken,
      '--pid', String(trap.pid), '--expected-executable', expectedExecutable,
      '--role', agentLifecycleRole, '--wait-ms', String(fixtureStartupTimeoutMs),
    ]);
    lifecycleRecorded = true;
    await waitForFile(`${readyPath}.lifecycle-wait`, fixtureStartupTimeoutMs);
    assert.equal(fs.existsSync(readyPath), false, 'agent socket trap waits for its Go lifecycle release');
    assert.equal(fs.existsSync(socketPath), false, 'agent socket trap does not bind before lifecycle release');
    await runProcessControlAsync(ownership.processControlCommand, [
      'release-record', '--root', root, '--token', ownership.sessionToken,
      '--pid', String(trap.pid), '--role', agentLifecycleRole,
    ]);
    await waitForOwnedRecord(root, ownership, 'agent-socket-trap', trap.pid);
    await waitForFile(readyPath);
    assert.equal(lifecycle.error, null, 'agent socket trap spawned successfully');

    await new Promise((resolve, reject) => {
      const client = net.createConnection({ path: socketPath });
      client.once('connect', () => client.end());
      client.once('close', resolve);
      client.once('error', reject);
    });
    await waitForFile(agentRecordPath);

    const fallbackResult = childProcess.spawnSync(
      summary.interceptorPaths.fallback,
      ['fallback-argument'],
      {
        env: fixtureEnvironment(root),
        encoding: 'utf8',
      },
    );
    assert.equal(fallbackResult.status, 97);
    assert.match(fallbackResult.stderr, /fixture fallback signer invoked/);

    const agentAttempts = readJsonLines(root, 'agent-calls.jsonl');
    const fallbackAttempts = readJsonLines(root, 'fallback-calls.jsonl');
    assert.equal(agentAttempts.length, 1);
    assert.equal(agentAttempts[0].kind, 'agent-attempt');
    assert.equal(fallbackAttempts.length, 1);
    assert.deepEqual(fallbackAttempts[0].argv, ['fallback-argument']);
    assert.equal(agentAttempts[0].pid === process.pid, false);
  } finally {
    if (lifecycleRecorded) {
      await cleanupAgentSocketTrapLifecycle(root, ownership, trap, lifecycle);
    }
    if (lifecycleRecorded) {
      const { stdout } = await runProcessControlAsync(ownership.processControlCommand, [
        'states', '--root', root, '--token', ownership.sessionToken,
      ]);
      assert.deepEqual(
        JSON.parse(stdout).filter((entry) => entry.state !== 'gone'),
        [],
        'all valid owned records are gone after lifecycle cleanup',
      );
    }
    if (trap && !lifecycle.close && !lifecycle.error) {
      assert.equal(
        await waitForTrackedChildClose(trap, lifecycle, fixtureStartupTimeoutMs),
        true,
        'agent socket trap closes before its fixture root is removed',
      );
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('role-qualified lifecycle cleanup isolates stale agent startup records', {
  timeout: 30_000,
}, async (t) => {
  buildFixtureBundle();
  const summary = fixtureSummary();

  for (const testCase of [
    { mode: 'synthetic-ownership-record' },
    { mode: 'recycled-ownership-record' },
  ]) {
    await t.test(testCase.mode, async () => {
      const root = createScenarioRoot({
        ...summary.scenarios.oneResidentExport,
        agentSocketTrap: testCase.mode,
      });
      const socketPath = path.join(root, 'agent.sock');
      const agentRecordPath = path.join(root, 'agent-calls.jsonl');
      const readyPath = path.join(root, 'agent-ready');
      const ownership = createOwnershipContext();
      const lifecycle = { error: null, exit: null, close: null };
      let trap;
      let cleaned = false;

      try {
        trap = childProcess.spawn(
          summary.interceptorPaths.agentSocketTrap,
          [socketPath, agentRecordPath, readyPath],
          { env: fixtureEnvironment(root, ownership), stdio: 'ignore' },
        );
        trap.on('error', (error) => { lifecycle.error = error; });
        trap.on('exit', (code, signal) => { lifecycle.exit = { code, signal }; });
        trap.on('close', (code, signal) => { lifecycle.close = { code, signal }; });
        const expectedExecutable = fs.realpathSync(summary.agentTrapExecutable);
        await runProcessControlAsync(ownership.processControlCommand, [
          'record', '--root', root, '--token', ownership.sessionToken,
          '--pid', String(trap.pid), '--expected-executable', expectedExecutable,
          '--role', agentLifecycleRole, '--wait-ms', String(fixtureStartupTimeoutMs),
        ]);
        await waitForFile(`${readyPath}.lifecycle-wait`, fixtureStartupTimeoutMs);
        await runProcessControlAsync(ownership.processControlCommand, [
          'release-record', '--root', root, '--token', ownership.sessionToken,
          '--pid', String(trap.pid), '--role', agentLifecycleRole,
        ]);
        await waitForFile(readyPath);

        const records = JSON.parse((await runProcessControlAsync(ownership.processControlCommand, [
          'records', '--root', root, '--token', ownership.sessionToken,
        ])).stdout);
        assert.equal(records.filter((record) => record.role === agentLifecycleRole).length, 1);
        assert.equal(records.filter((record) => record.role === 'agent-socket-trap').length, 1);

        const rootStates = runProcessControl(ownership.processControlCommand, [
          'states', '--root', root, '--token', ownership.sessionToken,
        ]);
        if (rootStates.status === 0) {
          const ordinaryState = JSON.parse(rootStates.stdout).find(
            (entry) => entry.record.role === 'agent-socket-trap',
          );
          assert.notEqual(ordinaryState.state, 'live', 'synthetic ownership is not reclassified as live');
        } else {
          assert.match(rootStates.stderr, /refusing to signal process instance/);
        }

        await cleanupAgentSocketTrapLifecycle(root, ownership, trap, lifecycle);
        cleaned = true;

        const retainedRecords = JSON.parse((await runProcessControlAsync(ownership.processControlCommand, [
          'records', '--root', root, '--token', ownership.sessionToken,
        ])).stdout);
        assert.equal(
          retainedRecords.filter((record) => record.role === 'agent-socket-trap').length,
          1,
          'role-qualified cleanup neither deletes nor reclassifies the stale ordinary record',
        );
      } finally {
        if (trap && !lifecycle.close && !lifecycle.error) {
          assert.equal(
            await waitForTrackedChildClose(trap, lifecycle, fixtureStartupTimeoutMs),
            true,
            'failed startup trap exits before its isolated root is removed',
          );
        }
        if (cleaned || !trap || lifecycle.close || lifecycle.error) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }
});

test('fake signing binds the stub, public key, and allowed-signers artifact', () => {
  const scenario = fixtureSummary().scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const residentExport = scenario.residentExports[0];
  const identity = scenario.identitySnapshots.after[0];
  try {
    const { stubPath } = installResidentExport(root, scenario);
    const env = {
      ...fixtureEnvironment(root),
      SSH_SK_PROVIDER: fixtureSummary().nativeToolPaths.provider,
    };
    const signature = childProcess.execFileSync(
      path.join(fixtureSummary().nativeToolPaths.sshKeygen),
      ['-Y', 'sign', '-n', 'git', '-f', stubPath],
      { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const signCall = readJsonLines(root, 'calls.jsonl').find(
      (call) => call.tool === 'ssh-keygen' && call.operation === 'sign',
    );
    assert.equal(signCall.signingStub, stubPath);
    assert.equal(signCall.signingPublicKey, residentExport.publicKey);
    assert.match(signature, new RegExp(`fixture-ssh-signature:${residentExport.publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const allowedSignersPath = path.join(root, 'allowed-signers');
    const allowedSigners = `${identity.label} namespaces="git" ${residentExport.publicKey}\n`;
    fs.writeFileSync(allowedSignersPath, allowedSigners, { mode: 0o600 });
    const signaturePath = path.join(root, 'signature');
    fs.writeFileSync(signaturePath, signature, { mode: 0o600 });
    childProcess.execFileSync(
      path.join(fixtureSummary().nativeToolPaths.sshKeygen),
      [
        '-Y',
        'verify',
        '-f',
        allowedSignersPath,
        '-I',
        identity.label,
        '-n',
        'git',
        '-s',
        signaturePath,
      ],
      { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const verifyCall = readJsonLines(root, 'calls.jsonl').find(
      (call) => call.tool === 'ssh-keygen' && call.operation === 'verify',
    );
    assert.equal(verifyCall.allowedSigners, allowedSigners.trim());

    fs.writeFileSync(`${stubPath}.pub`, `${scenario.residentExports[0].publicKey} wrong\n`, { mode: 0o644 });
    assert.throws(
      () => childProcess.execFileSync(
        path.join(fixtureSummary().nativeToolPaths.sshKeygen),
        ['-Y', 'sign', '-n', 'git', '-f', stubPath],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
      (error) => error.status === 45,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
