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

function readCalls(root) {
  const callsPath = path.join(root, 'calls.jsonl');
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8')
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await wait(10);
  assert.ok(fs.existsSync(filePath), `expected fixture file ${filePath}`);
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

async function assertWorkerTreeGone(root) {
  const treePath = path.join(root, 'process-tree');
  await waitForFile(treePath);
  const pids = fs.readFileSync(treePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split(' ').map(Number));
  assert.ok(pids.length >= 2, 'fixture recorded the worker and descendant');
  for (const pid of pids) await assertPidGone(pid);
}

let signerCommand;
let summary;

test.before(() => {
  signerCommand = path.join(buildSigner(), 'bin/git-mcp-secure-enclave-signer');
  summary = fixtureSummary();
});

test('accepts valid unrelated key types and raw CTK table variants before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.rawTableVariants);
  try {
    const state = createSigningState(root, summary);
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
    const result = runSigner(signerCommand, args, fixtureEnvironment(root, summary, state));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture-provider-sign/);
    assert.match(result.stdout, /fixture-ssh-signature/);

    const calls = readCalls(root);
    assert.deepEqual(
      calls.map((call) => [call.tool, call.operation]),
      [
        ['sc_auth', 'list'],
        ['ssh-keygen', 'stub'],
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
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not treat a biometric row for the configured hash as usable identity', () => {
  const root = createScenarioRoot(summary.scenarios.rawBiometricConfiguredIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
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

test('rejects a malformed CTK identity row before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.rawMalformedIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed CTK identity state/);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a CTK identity row without usable status before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.rawInvalidStatusIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
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

test('rejects a provider path that is not the packaged provider', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      { ...fixtureEnvironment(root, summary, state), SSH_SK_PROVIDER: '/wrong/provider' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SSH_SK_PROVIDER/);
    assert.match(result.stderr, new RegExp(summary.nativeToolPaths.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a selector that does not equal the configured CTK hash', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      { ...fixtureEnvironment(root, summary, state), KEYCHAIN_CERTIFICATES: '2'.repeat(40) },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KEYCHAIN_CERTIFICATES/);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an ssh-keygen -f path that differs from the configured stub', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', `${state.stubPath}.other`],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /-f/);
    assert.match(result.stderr, new RegExp(state.stubPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing resident stub before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.rmSync(state.stubPath);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(state.stubPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-empty malformed resident stub before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.writeFileSync(state.stubPath, 'not-a-resident-stub\n', { mode: 0o600 });
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resident stub|malformed/i);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a public-key mismatch before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      {
        ...fixtureEnvironment(root, summary, state),
        GIT_MCP_SIGNING_PUBLIC_KEY: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAwrong',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public key/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a fingerprint mismatch before delegated signing', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      { ...fixtureEnvironment(root, summary, state), GIT_MCP_SIGNING_FINGERPRINT: 'SHA256:wrong' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fingerprint/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the configured CTK identity is absent', () => {
  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const state = createSigningState(root, summary);
    fs.rmSync(path.join(root, 'identity-snapshot'));
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity|first unlock|bootstrap|recover/i);
    assertNoDelegatedSign(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when duplicate raw CTK rows match the configured hash', () => {
  const root = createScenarioRoot(summary.scenarios.rawDuplicateIdentity);
  try {
    const state = createSigningState(root, summary);
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one|ambiguous|identity/i);
    assertNoDelegatedSign(root);
    assertNoAgentOrFallback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on provider rejection without fallback or agent signing', () => {
  const root = createScenarioRoot(summary.scenarios.providerFailure);
  try {
    const state = createSigningState(root, summary);
    const startedAt = Date.now();
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      {
        ...fixtureEnvironment(root, summary, state),
        SSH_AUTH_SOCK: '/agent-must-not-be-used',
      },
    );

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 5_000, 'provider rejection should fail without waiting for the deadline');
    assert.match(result.stderr, /provider rejected|first unlock/i);
    assertNoAgentOrFallback(root);
    const calls = readCalls(root);
    assert.equal(calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign').length, 1);
    assert.equal(calls.filter((call) => call.tool === 'provider' && call.operation === 'sign').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function assertSignerTimeout(scenarioName, delegatedSignExpected) {
  const root = createScenarioRoot(summary.scenarios[scenarioName]);
  try {
    const state = createSigningState(root, summary);
    const startedAt = Date.now();
    const result = runSigner(
      signerCommand,
      ['-Y', 'sign', '-n', 'git', '-f', state.stubPath],
      fixtureEnvironment(root, summary, state),
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
    ['hangPreflightProvider', true],
    ['hangPreflightSshKeygen', false],
    ['hangPreflightSshKeygenStub', false],
    ['hangProviderSigning', true],
    ['hangAllPreflightPhases', false],
  ]) {
    await assertSignerTimeout(scenarioName, delegatedSignExpected);
  }
});
