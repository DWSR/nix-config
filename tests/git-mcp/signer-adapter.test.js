'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixturePath = path.join(repoRoot, 'tests/git-mcp/fixtures/signing-tools.nix');
const signerPath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-signer.nix');
const nixTimeoutMs = 600_000;
const signingDeadlineMs = 20_000;
const forcedCleanupGraceMs = 1_000;
const schedulingGraceMs = 1_000;

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

function buildSigner() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
      signer = pkgs.callPackage (import ${JSON.stringify(signerPath)}) fixture.nativeToolArgs;
    in signer
  `);
}

function buildSignerWithProviderPath(providerPath) {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
      signer = pkgs.callPackage (import ${JSON.stringify(signerPath)}) (
        fixture.nativeToolArgs // { providerPath = ${JSON.stringify(providerPath)}; }
      );
    in signer
  `);
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
        interceptorPaths = fixture.interceptorPaths;
        scenarios = fixture.scenarios;
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

function createScenarioRoot(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-signer-'));
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario), { mode: 0o600 });
  return root;
}

function createSigningState(root, summary) {
  const identity = summary.scenarios.oneResidentExport.identitySnapshots.after[0];
  const residentExport = summary.scenarios.oneResidentExport.residentExports[0];
  const identityDir = path.join(root, 'identities', identity.hash);
  const stubPath = path.join(identityDir, residentExport.stubName);

  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stubPath, `${residentExport.stub}\n`, { mode: 0o600 });
  fs.writeFileSync(`${stubPath}.pub`, `${residentExport.publicKey}\n`, { mode: 0o644 });
  fs.writeFileSync(
    path.join(root, 'identity-snapshot'),
    'after\n',
    { mode: 0o600 },
  );

  return {
    identity,
    residentExport,
    stubPath,
  };
}

function fixtureEnvironment(root, summary, state) {
  return {
    ...process.env,
    GIT_MCP_SIGNING_FIXTURE_ROOT: root,
    SSH_SK_PROVIDER: summary.nativeToolPaths.provider,
    KEYCHAIN_CERTIFICATES: state.identity.hash,
    GIT_MCP_SIGNING_CTK_HASH: state.identity.hash,
    GIT_MCP_SIGNING_PUBLIC_KEY: state.identity.publicKey,
    GIT_MCP_SIGNING_FINGERPRINT: state.identity.fingerprint,
    GIT_MCP_SIGNING_STUB: state.stubPath,
  };
}

function withoutEnvironment(environment, ...names) {
  const result = { ...environment };
  for (const name of names) delete result[name];
  return result;
}

function runSigner(command, args, env) {
  return childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    input: '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
}

function runBareInterceptedCommand(command, args, env) {
  return childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readCalls(root) {
  const callsPath = path.join(root, 'calls.jsonl');
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readOptionalJsonLines(root, fileName) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoDelegatedSign(root) {
  assert.equal(
    readCalls(root).some((call) => call.tool === 'ssh-keygen' && call.operation === 'sign'),
    false,
    'preflight failure must happen before delegated signing',
  );
}

function assertNoAgentOrFallback(root) {
  const calls = readCalls(root);
  assert.deepEqual(
    readOptionalJsonLines(root, 'agent-calls.jsonl'),
    [],
    'signing must not connect to the controlled SSH agent socket',
  );
  assert.deepEqual(
    readOptionalJsonLines(root, 'fallback-calls.jsonl'),
    [],
    'signing must not invoke the controlled fallback endpoint',
  );
  assert.equal(
    calls.some((call) => call.tool === 'agent' || call.tool === 'fallback'),
    false,
    'signing failure must not invoke an agent or fallback signer',
  );
  assert.equal(
    calls.some((call) => call.provider === '/Applications/1Password.app/Contents/MacOS/op-ssh-sign'),
    false,
    'signing failure must not invoke the global 1Password signer',
  );
}

function interceptionEnvironment(root, summary, state, socketPath) {
  const interceptorBin = path.join(root, 'interceptor-bin');
  fs.mkdirSync(interceptorBin, { mode: 0o700 });
  for (const command of ['fixture-fallback-signer', 'op-ssh-sign', 'ssh-add', 'ssh-agent']) {
    fs.symlinkSync(summary.interceptorPaths.fallback, path.join(interceptorBin, command));
  }

  return {
    ...fixtureEnvironment(root, summary, state),
    SSH_AUTH_SOCK: socketPath,
    SSH_AGENT_PID: 'fixture-agent-socket-trap',
    GIT_MCP_SIGNING_FALLBACK: summary.interceptorPaths.fallback,
    PATH: `${interceptorBin}:${path.dirname(summary.interceptorPaths.fallback)}:${process.env.PATH}`,
  };
}

async function runSignerWithInterception(
  command,
  args,
  root,
  summary,
  state,
  modifyEnvironment = (environment) => environment,
) {
  const agentTrap = await startAgentSocketTrap(root, summary);
  let stopped = false;
  try {
    const environment = modifyEnvironment(
      interceptionEnvironment(root, summary, state, agentTrap.socketPath),
    );
    const result = runSigner(command, args, environment);
    await agentTrap.stop();
    stopped = true;
    assertNoAgentOrFallback(root);
    return result;
  } finally {
    if (!stopped) await agentTrap.stop();
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await wait(10);
  assert.ok(fs.existsSync(filePath), `expected fixture file ${filePath}`);
}

async function startAgentSocketTrap(root, summary) {
  const socketPath = path.join(root, 'agent.sock');
  const recordPath = path.join(root, 'agent-calls.jsonl');
  const readyPath = path.join(root, 'agent-ready');
  const trap = childProcess.spawn(
    summary.interceptorPaths.agentSocketTrap,
    [socketPath, recordPath, readyPath],
    {
      cwd: repoRoot,
      env: { ...process.env, GIT_MCP_SIGNING_FIXTURE_ROOT: root },
      stdio: 'ignore',
    },
  );

  await waitForFile(readyPath);
  return {
    socketPath,
    async stop() {
      if (trap.exitCode === null) trap.kill('SIGTERM');
      await new Promise((resolve) => {
        if (trap.exitCode !== null) {
          resolve();
          return;
        }
        trap.once('close', resolve);
      });
    },
  };
}

async function assertPidGone(pid) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await wait(10);
  }
  assert.fail(`signer worker descendant ${pid} survived timeout cleanup`);
}

async function assertWorkerTreeGone(root, expectedWorkers = 1) {
  const treePath = path.join(root, 'process-tree');
  await waitForFile(treePath);
  const pids = fs.readFileSync(treePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split(' ').map(Number));
  assert.ok(
    pids.length >= expectedWorkers * 2,
    `fixture recorded at least ${expectedWorkers} workers and descendants`,
  );
  for (const pid of pids) await assertPidGone(pid);
}

function runGit(args, cwd, env, timeout = 35_000) {
  return childProcess.spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    input: '',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
}

function createGitGlobalConfig(root, fallbackSigner) {
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(
    globalConfig,
    [
      '[commit]',
      '  gpgSign = false',
      '[gpg]',
      '  format = openpgp',
      '[gpg "ssh"]',
      `  program = ${fallbackSigner}`,
      '[user]',
      '  signingKey = /tmp/global-conflicting-signing-key',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return globalConfig;
}

function globalGitEnvironment(root, state, globalConfig, agentSocketPath) {
  const tempDir = path.join(root, 'git-tmp');
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  return {
    ...interceptionEnvironment(root, summary, state, agentSocketPath),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: tempDir,
  };
}

function scopedGitEnvironment(environment, state) {
  return {
    ...environment,
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gpg.format',
    GIT_CONFIG_VALUE_1: 'ssh',
    GIT_CONFIG_KEY_2: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_2: signerCommand,
    GIT_CONFIG_KEY_3: 'user.signingKey',
    GIT_CONFIG_VALUE_3: state.stubPath,
  };
}

function createGitRepository(root, environment) {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository, { mode: 0o700 });
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['config', 'user.name', 'Fixture Git MCP'],
    ['config', 'user.email', 'fixture-git-mcp@example.test'],
  ]) {
    const result = runGit(args, repository, environment);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }

  fs.writeFileSync(path.join(repository, 'initial.txt'), 'initial\n');
  for (const args of [
    ['add', 'initial.txt'],
    ['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'],
  ]) {
    const result = runGit(args, repository, environment);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  return repository;
}

function stageGitChange(repository, fileName, environment) {
  fs.writeFileSync(path.join(repository, fileName), `${fileName}\n`);
  const result = runGit(['add', fileName], repository, environment);
  assert.equal(result.status, 0, `git add ${fileName}: ${result.stderr}`);
}

function gitHead(repository, environment) {
  const result = runGit(['rev-parse', 'HEAD'], repository, environment);
  assert.equal(result.status, 0, `git rev-parse HEAD: ${result.stderr}`);
  return result.stdout.trim();
}

function gitCommitObject(repository, environment) {
  const result = runGit(['cat-file', 'commit', 'HEAD'], repository, environment);
  assert.equal(result.status, 0, `git cat-file commit HEAD: ${result.stderr}`);
  return result.stdout;
}

function runGitCommitAttempt(repository, environment, explicitSigning, message) {
  const args = ['commit'];
  if (explicitSigning) args.push('--gpg-sign');
  args.push('--quiet', '-m', message);
  const startedAt = Date.now();
  const result = runGit(args, repository, environment);
  return {
    ...result,
    args,
    elapsedMs: Date.now() - startedAt,
  };
}

function assertSignedGitCommit(repository, environment, publicKey) {
  const commitObject = gitCommitObject(repository, environment);
  assert.match(commitObject, /^gpgsig /m, 'Git commit contains an SSH signature header');
  assert.match(
    commitObject,
    new RegExp(`fixture-ssh-signature:${publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'Git commit signature is bound to the configured resident public key',
  );
}

let signerCommand;
let missingProviderSignerCommand;
let summary;
const missingProviderPath = '/definitely-missing-git-mcp-signing-provider';

test.before(() => {
  signerCommand = path.join(buildSigner(), 'bin/git-mcp-secure-enclave-signer');
  missingProviderSignerCommand = path.join(
    buildSignerWithProviderPath(missingProviderPath),
    'bin/git-mcp-secure-enclave-signer',
  );
  buildFixtureBundle();
  summary = fixtureSummary();
});

test('packages the exact 20-second supervisor with one-second forced cleanup', () => {
  const packagedSigner = fs.readFileSync(signerCommand, 'utf8');
  assert.match(
    packagedSigner,
    /^timeout --signal=TERM --kill-after=1s 20s "\$0" --signing-worker "\$@" \|\| timeout_status=\$\?$/m,
  );
});

test('accepts valid unrelated key types and raw CTK table variants before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.rawTableVariants);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    agentTrap = await startAgentSocketTrap(root, summary);
    const rawIdentityRows = summary.scenarios.rawTableVariants.rawIdentityListings.after
      .split('\r\n')
      .slice(1, -1)
      .filter(Boolean)
      .map((row) => row.trim().split(/\s+/));
    const exactMatches = rawIdentityRows.filter(([keyType, hash, protection]) => (
      keyType === 'p-256-ne'
      && protection === 'none'
      && hash.toLowerCase() === state.identity.hash
    ));

    assert.equal(state.identity.hash, state.identity.hash.toLowerCase());
    assert.match(state.identity.hash, /[a-f]/, 'configured hash exercises alphabetic hex normalization');
    assert.equal(exactMatches.length, 1, 'raw CTK table has exactly one eligible configured identity');
    assert.equal(exactMatches[0][1], state.identity.hash.toUpperCase());

    const args = ['-Y', 'sign', '-n', 'git', '-f', state.stubPath];
    const result = runSigner(
      signerCommand,
      args,
      interceptionEnvironment(root, summary, state, agentTrap.socketPath),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture-provider-sign/);
    assert.match(
      result.stdout,
      new RegExp(`fixture-ssh-signature:${state.residentExport.publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
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
    );
    assert.deepEqual(
      calls.find((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').argv,
      args,
    );
    assert.deepEqual(
      calls.find((call) => call.tool === 'sc_auth' && call.operation === 'list').argv,
      ['list-ctk-identities', '-t', 'sha1', '-e', 'hex'],
    );
    assert.equal(
      calls.find((call) => call.tool === 'provider' && call.operation === 'sign').provider,
      summary.nativeToolPaths.provider,
    );
    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('records a bare PATH fallback attempt while signer paths remain fallback-free', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    agentTrap = await startAgentSocketTrap(root, summary);
    const environment = interceptionEnvironment(root, summary, state, agentTrap.socketPath);
    const fallbackResult = runBareInterceptedCommand(
      'op-ssh-sign',
      ['bare-fallback-contract'],
      environment,
    );

    assert.equal(fallbackResult.status, 97);
    assert.match(fallbackResult.stderr, /fixture fallback signer invoked/);
    const [fallbackAttempt] = readOptionalJsonLines(root, 'fallback-calls.jsonl');
    assert.equal(fallbackAttempt.kind, 'fallback-attempt');
    assert.equal(fallbackAttempt.command, 'op-ssh-sign');
    assert.deepEqual(fallbackAttempt.argv, ['bare-fallback-contract']);
    assert.match(fallbackAttempt.pid, /^\d+$/);

    fs.rmSync(path.join(root, 'fallback-calls.jsonl'));
    const signerResult = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      environment,
    );

    assert.equal(signerResult.status, 0, signerResult.stderr);
    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not treat a biometric row for the configured hash as usable identity', async () => {
  const root = createScenarioRoot(summary.scenarios.rawBiometricConfiguredIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match exactly one resident identity/);
    assert.doesNotMatch(result.stderr, /malformed CTK identity state/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a malformed CTK identity row before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.rawMalformedIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed CTK identity state/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a CTK identity row without usable status before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.rawInvalidStatusIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed CTK identity state/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('passes non-signing ssh-keygen operations through unchanged', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const args = ['-Y', 'verify', '-n', 'git', '-f', 'verification-key'];
    const result = runSigner(
      signerCommand,
      args,
      {
        ...process.env,
        GIT_MCP_SIGNING_FIXTURE_ROOT: root,
        SSH_SK_PROVIDER: '/agent-must-not-be-used',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'fixture-ssh-keygen-verified\n');
    assert.equal(result.stderr, 'fixture-native-stderr\n');
    const [call] = readCalls(root);
    assert.equal(readCalls(root).length, 1);
    assert.equal(call.tool, 'ssh-keygen');
    assert.equal(call.operation, 'verify');
    assert.deepEqual(call.argv, args);
    assert.equal(call.provider, '/agent-must-not-be-used');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves native output and every argument for a non-signing passthrough operation', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const args = ['-Q', 'cipher', '-f', '/tmp/key with spaces', '--', 'literal-value'];
    const result = runSigner(
      signerCommand,
      args,
      {
        ...process.env,
        GIT_MCP_SIGNING_FIXTURE_ROOT: root,
        SSH_SK_PROVIDER: '/agent-must-not-be-used',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'fixture-ssh-keygen-passthrough\n');
    assert.equal(result.stderr, 'fixture-native-stderr\n');
    const [call] = readCalls(root);
    assert.equal(readCalls(root).length, 1);
    assert.equal(call.tool, 'ssh-keygen');
    assert.equal(call.operation, 'passthrough');
    assert.deepEqual(call.argv, args);
    assert.equal(call.provider, '/agent-must-not-be-used');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when signer state or provider configuration is missing', async () => {
  const cases = [
    {
      name: 'provider',
      remove: 'SSH_SK_PROVIDER',
      diagnostic: /SSH_SK_PROVIDER/,
    },
    {
      name: 'selector',
      remove: 'KEYCHAIN_CERTIFICATES',
      diagnostic: /KEYCHAIN_CERTIFICATES/,
    },
    {
      name: 'CTK hash',
      remove: 'GIT_MCP_SIGNING_CTK_HASH',
      diagnostic: /CTK identity hash/,
    },
    {
      name: 'public key',
      remove: 'GIT_MCP_SIGNING_PUBLIC_KEY',
      diagnostic: /public key/,
    },
    {
      name: 'fingerprint',
      remove: 'GIT_MCP_SIGNING_FINGERPRINT',
      diagnostic: /fingerprint/,
    },
    {
      name: 'resident stub path',
      remove: 'GIT_MCP_SIGNING_STUB',
      diagnostic: /resident stub path/,
    },
  ];

  for (const { name, remove, diagnostic } of cases) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const state = createSigningState(root, summary);
      const result = await runSignerWithInterception(
        signerCommand,
        ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
        root,
        summary,
        state,
        (environment) => withoutEnvironment(environment, remove),
      );

      assert.notEqual(result.status, 0, `${name} must fail nonzero`);
      assert.match(result.stderr, diagnostic, `${name} diagnostic`);
      assertNoDelegatedSign(root);
      assertNoAgentOrFallback(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects malformed configured identity metadata before delegated signing', async () => {
  const cases = [
    {
      name: 'CTK hash',
      change: (environment) => {
        environment.GIT_MCP_SIGNING_CTK_HASH = 'not-a-hash';
      },
      diagnostic: /CTK identity hash.*malformed/,
    },
    {
      name: 'public key',
      change: (environment) => {
        environment.GIT_MCP_SIGNING_PUBLIC_KEY = 'not-a-public-key';
      },
      diagnostic: /public key.*malformed/,
    },
    {
      name: 'fingerprint',
      change: (environment) => {
        environment.GIT_MCP_SIGNING_FINGERPRINT = 'not-a-fingerprint';
      },
      diagnostic: /fingerprint.*malformed/,
    },
  ];

  for (const { name, change, diagnostic } of cases) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const state = createSigningState(root, summary);
      const result = await runSignerWithInterception(
        signerCommand,
        ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
        root,
        summary,
        state,
        (environment) => {
          change(environment);
          return environment;
        },
      );

      assert.notEqual(result.status, 0, `${name} must fail nonzero`);
      assert.match(result.stderr, diagnostic, `${name} diagnostic`);
      assertNoDelegatedSign(root);
      assertNoAgentOrFallback(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects missing or ambiguous resident-stub arguments before delegated signing', async () => {
  const cases = [
    ['-Y', 'sign', '-n', 'git'],
    ['-Y', 'sign', '-n', 'git', '-f'],
    ['-Y', 'sign', '-n', 'git', '-f', 'first-stub', '-f', 'second-stub'],
  ];

  for (const args of cases) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const state = createSigningState(root, summary);
      const result = await runSignerWithInterception(
        signerCommand,
        args,
        root,
        summary,
        state,
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /exactly one -f|requires the configured resident stub/);
      assertNoDelegatedSign(root);
      assertNoAgentOrFallback(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects a missing resident public key before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.rmSync(`${state.stubPath}.pub`);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident public key/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a malformed resident public key before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.writeFileSync(`${state.stubPath}.pub`, 'not-a-public-key\n', { mode: 0o644 });
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident public key .* malformed/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a provider path that is not the packaged provider', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
      (environment) => ({ ...environment, SSH_SK_PROVIDER: '/wrong/provider' }),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SSH_SK_PROVIDER/);
    assert.match(result.stderr, new RegExp(summary.nativeToolPaths.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an absent packaged provider path before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      missingProviderSignerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
      (environment) => ({ ...environment, SSH_SK_PROVIDER: missingProviderPath }),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`signing provider ${missingProviderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is absent`));
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a selector that does not equal the configured CTK hash', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
      (environment) => ({ ...environment, KEYCHAIN_CERTIFICATES: '2'.repeat(40) }),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KEYCHAIN_CERTIFICATES/);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an ssh-keygen -f path that differs from the configured stub', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', `${state.stubPath}.other`],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /-f/);
    assert.match(result.stderr, new RegExp(state.stubPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing resident stub before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.rmSync(state.stubPath);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(state.stubPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-empty malformed resident stub before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.writeFileSync(state.stubPath, 'not-a-resident-stub\n', { mode: 0o600 });
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident stub|malformed/i);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a public-key mismatch before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
      (environment) => ({
        ...environment,
        GIT_MCP_SIGNING_PUBLIC_KEY: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAwrong',
      }),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public key/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a fingerprint mismatch before delegated signing', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
      (environment) => ({ ...environment, GIT_MCP_SIGNING_FINGERPRINT: 'SHA256:wrong' }),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fingerprint/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a resident stub whose native public key does not match the configured key', async () => {
  const root = createScenarioRoot(summary.scenarios.stubKeyMismatch);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident stub .* does not match configured public key/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a native fingerprint that does not match the configured fingerprint', async () => {
  const root = createScenarioRoot(summary.scenarios.fingerprintOutputMismatch);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident fingerprint .* does not match configured fingerprint/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports first-unlock guidance when CTK identity preflight is rejected', async () => {
  const root = createScenarioRoot(summary.scenarios.ctkListingFailure);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /first unlock after reboot/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the configured CTK identity is absent', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.rmSync(path.join(root, 'identity-snapshot'));
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity|first unlock|bootstrap|recover/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when duplicate raw CTK rows match the configured hash', async () => {
  const root = createScenarioRoot(summary.scenarios.rawDuplicateIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one|ambiguous|identity/i);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on provider rejection without fallback or agent signing', async () => {
  const root = createScenarioRoot(summary.scenarios.providerFailure);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    agentTrap = await startAgentSocketTrap(root, summary);
    const startedAt = Date.now();
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      interceptionEnvironment(root, summary, state, agentTrap.socketPath),
    );

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 5_000, 'provider rejection should fail without waiting for the deadline');
    assert.match(result.stderr, /provider rejected|first unlock/i);
    const calls = readCalls(root);
    assert.equal(calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length, 1);
    assert.equal(calls.filter((call) => call.tool === 'provider' && call.operation === 'sign').length, 1);
    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function assertSignerTimeout(scenarioName, delegatedSignExpected) {
  const root = createScenarioRoot(summary.scenarios[scenarioName]);
  try {
    const state = createSigningState(root, summary);
    const startedAt = Date.now();
    const result = await runSignerWithInterception(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      root,
      summary,
      state,
    );
    const elapsed = Date.now() - startedAt;

    assert.notEqual(result.status, 0, `${scenarioName} must fail nonzero`);
    assert.ok(elapsed < 25_000, `${scenarioName} exceeded bounded deadline: ${elapsed}ms`);
    assert.match(result.stderr, /timed out.*20 seconds|20-second.*timed out/i);
    await assertWorkerTreeGone(root);
    if (delegatedSignExpected) {
      assert.equal(
        readCalls(root).filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length,
        1,
        `${scenarioName} reaches exactly one delegated sign before the provider timeout`,
      );
    } else {
      assertNoDelegatedSign(root);
    }
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('contains every signing preflight and provider timeout within one worker deadline', async () => {
  for (const [scenarioName, delegatedSignExpected] of [
    ['hangCtkListing', false],
    ['hangPreflightProvider', false],
    ['hangPreflightSshKeygen', false],
    ['hangPreflightSshKeygenStub', false],
    ['hangProviderSigning', true],
    ['hangAllPreflightPhases', false],
  ]) {
    await assertSignerTimeout(scenarioName, delegatedSignExpected);
  }
});

test('Git uses the scoped signer for explicit and retry-shaped commit attempts', async () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    const globalConfig = createGitGlobalConfig(root, summary.interceptorPaths.fallback);
    agentTrap = await startAgentSocketTrap(root, summary);
    const unrelatedEnvironment = globalGitEnvironment(
      root,
      state,
      globalConfig,
      agentTrap.socketPath,
    );
    const environment = scopedGitEnvironment(unrelatedEnvironment, state);
    const unrelatedResult = runGit(
      ['config', '--global', '--get', 'gpg.ssh.program'],
      root,
      unrelatedEnvironment,
    );
    assert.equal(unrelatedResult.status, 0, unrelatedResult.stderr);
    assert.equal(
      unrelatedResult.stdout.trim(),
      summary.interceptorPaths.fallback,
      'an unrelated Git process retains the global signer',
    );
    const repository = createGitRepository(root, environment);

    for (const [explicitSigning, fileName] of [
      [true, 'explicit-sign.txt'],
      [false, 'retry-shaped-sign.txt'],
    ]) {
      const headBefore = gitHead(repository, environment);
      stageGitChange(repository, fileName, environment);
      const result = runGitCommitAttempt(
        repository,
        environment,
        explicitSigning,
        `signed ${fileName}`,
      );

      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.elapsedMs < 5_000, `successful commit was unexpectedly slow: ${result.elapsedMs}ms`);
      const headAfter = gitHead(repository, environment);
      assert.notEqual(headAfter, headBefore, `${fileName} advances HEAD`);
      assertSignedGitCommit(repository, environment, state.residentExport.publicKey);
    }

    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
    const signCalls = readCalls(root).filter(
      (call) => call.tool === 'ssh-keygen' && call.operation === 'sign',
    );
    assert.equal(signCalls.length, 2, 'both Git command forms invoke the dedicated signer');
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git signing rejection fails both upstream attempts without creating an unsigned commit', async () => {
  const root = createScenarioRoot(summary.scenarios.providerFailure);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    const globalConfig = createGitGlobalConfig(root, summary.interceptorPaths.fallback);
    agentTrap = await startAgentSocketTrap(root, summary);
    const environment = scopedGitEnvironment(
      globalGitEnvironment(root, state, globalConfig, agentTrap.socketPath),
      state,
    );
    const repository = createGitRepository(root, environment);
    const headBefore = gitHead(repository, environment);
    stageGitChange(repository, 'rejected-sign.txt', environment);

    for (const explicitSigning of [true, false]) {
      const result = runGitCommitAttempt(
        repository,
        environment,
        explicitSigning,
        explicitSigning ? 'rejected explicit sign' : 'rejected retry sign',
      );
      const diagnostics = `${result.stdout}\n${result.stderr}`;

      assert.notEqual(result.status, 0, `${result.args.join(' ')} must fail closed`);
      assert.ok(result.elapsedMs < 5_000, `provider rejection waited too long: ${result.elapsedMs}ms`);
      assert.match(diagnostics, /provider rejected|first unlock/i);
      assert.equal(gitHead(repository, environment), headBefore, 'rejected signing leaves HEAD unchanged');
    }

    assert.equal(
      gitCommitObject(repository, environment).includes('rejected explicit sign'),
      false,
      'the failed explicit attempt did not create a commit',
    );
    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
    assert.equal(
      readCalls(root).filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length,
      2,
      'both upstream attempts reached the dedicated signer',
    );
    assert.equal(
      readCalls(root).filter((call) => call.tool === 'provider' && call.operation === 'sign').length,
      2,
      'both upstream attempts reached the rejecting provider',
    );
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function assertGitTimeoutAttempts({
  scenarioName,
  terminalTool,
  terminalOperation,
  delegatedSignExpected,
}) {
  const root = createScenarioRoot(summary.scenarios[scenarioName]);
  let agentTrap;
  try {
    const state = createSigningState(root, summary);
    const globalConfig = createGitGlobalConfig(root, summary.interceptorPaths.fallback);
    agentTrap = await startAgentSocketTrap(root, summary);
    const environment = scopedGitEnvironment(
      globalGitEnvironment(root, state, globalConfig, agentTrap.socketPath),
      state,
    );
    const repository = createGitRepository(root, environment);
    const headBefore = gitHead(repository, environment);
    stageGitChange(repository, `${scenarioName}.txt`, environment);

    for (const explicitSigning of [true, false]) {
      const result = runGitCommitAttempt(
        repository,
        environment,
        explicitSigning,
        `${scenarioName} timeout`,
      );
      const diagnostics = `${result.stdout}\n${result.stderr}`;

      assert.notEqual(result.status, 0, `${scenarioName} attempt must fail nonzero`);
      assert.ok(
        result.elapsedMs < signingDeadlineMs + forcedCleanupGraceMs + schedulingGraceMs,
        `${scenarioName} ${explicitSigning ? 'explicit' : 'retry'} attempt exceeded the 20-second deadline plus cleanup and scheduling grace: ${result.elapsedMs}ms`,
      );
      assert.match(diagnostics, /timed out.*20 seconds|20-second.*timed out/i);
      assert.equal(gitHead(repository, environment), headBefore, `${scenarioName} leaves HEAD unchanged`);
    }

    const calls = readCalls(root);
    assert.equal(
      calls.filter((call) => (
        call.tool === terminalTool && call.operation === terminalOperation
      )).length,
      2,
      `${scenarioName} reaches ${terminalTool} ${terminalOperation} in both attempts`,
    );
    assert.equal(
      calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length,
      delegatedSignExpected ? 2 : 0,
      `${scenarioName} ${delegatedSignExpected ? 'reaches' : 'stops before'} delegated signing`,
    );
    await assertWorkerTreeGone(root, 2);
    await agentTrap.stop();
    agentTrap = null;
    assertNoAgentOrFallback(root);
  } finally {
    if (agentTrap) await agentTrap.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Git timeout paths stay bounded and descendant-free across both upstream attempts', {
  timeout: 600_000,
}, async () => {
  for (const scenario of [
    {
      scenarioName: 'hangCtkListing',
      terminalTool: 'sc_auth',
      terminalOperation: 'list',
      delegatedSignExpected: false,
    },
    {
      scenarioName: 'hangPreflightProvider',
      terminalTool: 'provider',
      terminalOperation: 'load',
      delegatedSignExpected: false,
    },
    {
      scenarioName: 'hangPreflightSshKeygen',
      terminalTool: 'ssh-keygen',
      terminalOperation: 'fingerprint',
      delegatedSignExpected: false,
    },
    {
      scenarioName: 'hangPreflightSshKeygenStub',
      terminalTool: 'ssh-keygen',
      terminalOperation: 'stub',
      delegatedSignExpected: false,
    },
    {
      scenarioName: 'hangProviderSigning',
      terminalTool: 'provider',
      terminalOperation: 'sign',
      delegatedSignExpected: true,
    },
  ]) {
    await assertGitTimeoutAttempts(scenario);
  }
});
