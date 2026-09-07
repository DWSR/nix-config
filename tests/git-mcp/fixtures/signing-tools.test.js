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
  const requiredScenarios = [
    'identitySnapshots',
    'zeroResidentExports',
    'oneResidentExport',
    'multipleResidentExports',
    'hangCtkListing',
    'hangPreflightProvider',
    'hangPreflightSshKeygen',
    'hangProviderSigning',
    'hangAllPreflightPhases',
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

    childProcess.execFileSync(scAuth, ['list-ctk-identities'], { env, encoding: 'utf8' });
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

  for (const [scenarioName, expectedExports] of [
    ['zeroResidentExports', 0],
    ['oneResidentExport', 1],
    ['multipleResidentExports', 2],
  ]) {
    const scenarioRoot = createScenarioRoot(summary.scenarios[scenarioName]);
    try {
      const scenarioEnv = fixtureEnvironment(scenarioRoot);
      const exportDir = path.join(scenarioRoot, 'exports');
      const snapshot = JSON.parse(childProcess.execFileSync(
        scAuth,
        ['list-ctk-identities'],
        { env: scenarioEnv, encoding: 'utf8' },
      ));
      assert.equal(snapshot.length, 0, `${scenarioName} starts with no identities`);
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
    const before = JSON.parse(childProcess.execFileSync(
      scAuth,
      ['list-ctk-identities'],
      { env: identityEnv, encoding: 'utf8' },
    ));
    childProcess.execFileSync(scAuth, ['create', '--label', 'fixture-primary'], {
      env: identityEnv,
      encoding: 'utf8',
    });
    const after = JSON.parse(childProcess.execFileSync(
      scAuth,
      ['list-ctk-identities'],
      { env: identityEnv, encoding: 'utf8' },
    ));
    assert.deepEqual(before, summary.scenarios.identitySnapshots.identitySnapshots.before);
    assert.deepEqual(after, summary.scenarios.identitySnapshots.identitySnapshots.after);
  } finally {
    fs.rmSync(identityRoot, { recursive: true, force: true });
  }

  const providerFailureRoot = createScenarioRoot(summary.scenarios.providerFailure);
  try {
    assert.throws(
      () => childProcess.execFileSync(
        sshKeygen,
        ['-Y', 'sign', '-n', 'git', '-f', 'fixture-stub'],
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
      args: ['list-ctk-identities'],
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
      const scenarioEnv = fixtureEnvironment(scenarioRoot);
      if (command === sshKeygen) scenarioEnv.SSH_SK_PROVIDER = providerNativePath;
      await terminateHungFixture(command, args, scenarioEnv, scenarioRoot);
      for (const [tool, operation] of calls) assertLoggedCall(scenarioRoot, tool, operation);
      assertHarnessResult(scenarioRoot);
    } finally {
      fs.rmSync(scenarioRoot, { recursive: true, force: true });
    }
  }
});
