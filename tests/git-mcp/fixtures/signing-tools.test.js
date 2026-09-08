'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');
const nixTimeoutMs = 600_000;
const harnessResultsFile = 'harness-results.jsonl';

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

function fixtureSummary() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(`${repoRoot}/tests/git-mcp/fixtures/signing-tools.nix`)} { inherit pkgs; };
    in
    {
      bundle = builtins.unsafeDiscardStringContext "\${fixture.packages}";
      nativeToolNames = builtins.mapAttrs (_: package: package.name) fixture.nativeTools;
      nativeToolPaths = fixture.nativeToolPaths;
      scenarios = fixture.scenarios;
    }
  `);
}

function buildFixtureBundle() {
  const expression = `
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
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
    assert.equal(keyType, 'p-256-ne');
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
    keyType: 'p-256-ne',
    hash: identity.hash,
    protection: identity.protection || 'none',
    label: identity.label,
    commonName: identity.commonName || 'ssh',
    validToDate: identity.validToDate || '23.11.26,',
    validToTime: identity.validToTime || '17:09',
    valid: 'YES',
  }));
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

function fixtureEnvironment(root) {
  return {
    ...process.env,
    GIT_MCP_SIGNING_FIXTURE_ROOT: root,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await wait(10);
  }
  assert.ok(fs.existsSync(filePath), `expected fixture file ${filePath}`);
}

async function waitForPidGone(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await wait(10);
  }
  assert.fail(`fixture descendant ${pid} survived process-group termination`);
}

function cleanupProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
    return 'signalled';
  } catch (error) {
    if (error.code === 'ESRCH') return 'already-gone';
    if (error.code === 'EPERM') return 'not-signalable';
    throw error;
  }
}

async function terminateHungFixture(command, args, env, root) {
  const child = childProcess.spawn(command, args, {
    detached: true,
    env,
    stdio: 'ignore',
  });
  assert.ok(child.pid, 'hung fixture has a process id');
  const treeFile = path.join(root, 'process-tree');
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
    await waitForFile(treeFile);
    descendants = fs.readFileSync(treeFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => line.split(' ').map((value) => Number(value)));
    assert.ok(descendants.length >= 2, 'hung fixture records a worker and descendant');

    cleanupProcessGroup(child.pid);
    lifecycleResult = await childLifecycle;
    assert.equal(lifecycleResult.childExit.error, undefined, 'hung fixture child spawned successfully');
    for (const pid of descendants) {
      await waitForPidGone(pid);
      verifiedGonePids.push(pid);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    cleanupProcessGroup(child.pid);
    if (!lifecycleResult) lifecycleResult = await childLifecycle;
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
  }
}

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

test('worker-tree cleanup tolerates a process group reaped between repeated cleanup calls', () => {
  const originalKill = process.kill;
  let groupKillCount = 0;

  process.kill = (pid, signal) => {
    if (pid === -1234 && signal === 'SIGKILL') {
      groupKillCount += 1;
      if (groupKillCount === 2) {
        const error = new Error('process group was already reaped');
        error.code = 'EPERM';
        throw error;
      }
    }
    return true;
  };

  try {
    assert.doesNotThrow(() => {
      cleanupProcessGroup(1234);
      cleanupProcessGroup(1234);
    });
  } finally {
    process.kill = originalKill;
  }

  assert.equal(groupKillCount, 2, 'cleanup remains idempotent when the group disappears');
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
    'ambiguousResidentFingerprint',
    'mismatchedExpectedFingerprint',
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

  const bundle = buildFixtureBundle();
  const scAuth = path.join(bundle, 'native/sc-auth/bin/fixture-sc-auth');
  const sshKeygen = path.join(bundle, 'native/ssh-keygen/bin/fixture-ssh-keygen');
  const provider = path.join(bundle, 'native/provider/bin/fixture-provider');
  const providerNativePath = summary.nativeToolPaths.provider;
  const expectedNativePaths = [
    summary.nativeToolPaths.scAuth,
    summary.nativeToolPaths.provider,
    summary.nativeToolPaths.sshKeygen,
  ];
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
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
      { env, encoding: 'utf8' },
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
      { env, encoding: 'utf8' },
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
