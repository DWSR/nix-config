'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixturePath = path.join(repoRoot, 'tests/git-mcp/fixtures/signing-tools.nix');
const adminPath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-admin.nix');
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

function buildAdmin() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
      admin = pkgs.callPackage (import ${JSON.stringify(adminPath)}) fixture.nativeToolArgs;
    in admin
  `);
}

function createScenarioRoot(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-admin-'));
  const stateHome = path.join(root, 'state-home');
  const configHome = path.join(root, 'config-home');
  const tempHome = path.join(root, 'tmp');
  fs.mkdirSync(stateHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario), { mode: 0o600 });
  return { root, stateHome, configHome, tempHome };
}

function fixtureEnvironment(root) {
  return {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: root.stateHome,
    XDG_CONFIG_HOME: root.configHome,
    TMPDIR: root.tempHome,
    GIT_MCP_SIGNING_FIXTURE_ROOT: root.root,
  };
}

function runAdmin(command, args, env) {
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

function managedIdentities(root) {
  const identities = path.join(root.stateHome, 'git-mcp-secure-enclave-signing', 'identities');
  if (!fs.existsSync(identities)) return [];
  return fs.readdirSync(identities).sort();
}

function activeMarkerPath(root) {
  return path.join(
    root.configHome,
    'git-mcp-secure-enclave-signing',
    'active.json',
  );
}

function declarationFrom(result) {
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

let adminCommand;
let summary;

test.before(() => {
  summary = fixtureSummary();
  adminCommand = path.join(buildAdmin(), 'bin/git-mcp-secure-enclave-admin');
});

test('bootstraps one CTK identity and atomically installs verified public artifacts', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const identity = scenario.identitySnapshots.after[0];
  const residentExport = scenario.residentExports[0];
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(declarationFrom(result), {
      identityLabel: identity.label,
      ctkPublicKeyHash: identity.hash,
      sshPublicKey: residentExport.publicKey,
      sshFingerprint: residentExport.fingerprint,
      githubSigningKeyRegistered: false,
    });

    const identityDir = path.join(
      root.stateHome,
      'git-mcp-secure-enclave-signing',
      'identities',
      identity.hash,
    );
    assert.equal(
      fs.readFileSync(path.join(identityDir, residentExport.stubName), 'utf8').trim(),
      residentExport.stub,
    );
    assert.equal(
      fs.readFileSync(path.join(identityDir, `${residentExport.stubName}.pub`), 'utf8').trim(),
      residentExport.publicKey,
    );
    assert.equal(fileMode(identityDir), 0o700);
    assert.equal(fileMode(path.join(identityDir, residentExport.stubName)), 0o600);
    assert.equal(fileMode(path.join(identityDir, `${residentExport.stubName}.pub`)), 0o644);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false, 'bootstrap does not activate declaration');
    assert.deepEqual(fs.readdirSync(root.tempHome), [], 'temporary export data is cleaned up');

    const calls = readCalls(root.root);
    assert.deepEqual(
      calls.map((call) => [call.tool, call.operation]),
      [
        ['sc_auth', 'list'],
        ['sc_auth', 'create'],
        ['sc_auth', 'list'],
        ['sc_auth', 'list-ssh'],
        ['ssh-keygen', 'resident-export'],
        ['provider', 'load'],
        ['ssh-keygen', 'stub'],
        ['ssh-keygen', 'fingerprint'],
        ['ssh-keygen', 'sign'],
        ['provider', 'sign'],
        ['ssh-keygen', 'verify'],
      ],
    );
    const createCall = calls.find((call) => call.tool === 'sc_auth' && call.operation === 'create');
    assert.deepEqual(createCall.argv, [
      'create-ctk-identity',
      '-l',
      identity.label,
      '-k',
      'p-256-ne',
      '-t',
      'none',
    ]);
    const exportCall = calls.find((call) => call.operation === 'resident-export');
    assert.deepEqual(exportCall.argv, ['-K']);
    assert.equal(exportCall.selector, identity.hash, 'resident export is pinned to one CTK hash');
    assert.equal(exportCall.exportEmpty, true, 'resident export starts in an empty directory');
    assert.equal(exportCall.cwd.startsWith(root.tempHome), true);
    const sshListCall = calls.find((call) => call.operation === 'list-ssh');
    assert.deepEqual(sshListCall.argv, ['list-ctk-identities', '-t', 'ssh']);
    const signCall = calls.find((call) => call.operation === 'sign');
    assert.equal(signCall.selector, identity.hash, 'signing carries the new CTK selector');
    const verifyCall = calls.find((call) => call.tool === 'ssh-keygen' && call.operation === 'verify');
    assert.equal(verifyCall.selector, identity.hash);
    assert.ok(
      verifyCall.allowedSigners.includes(residentExport.publicKey),
      'local verification receives an allowed-signers artifact tied to the selected public key',
    );
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('refuses active or non-empty managed state before creating a CTK identity', () => {
  for (const setup of ['active-marker', 'non-empty-identities']) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const identities = path.join(
        root.stateHome,
        'git-mcp-secure-enclave-signing',
        'identities',
      );
      if (setup === 'active-marker') {
        fs.mkdirSync(path.dirname(activeMarkerPath(root)), { recursive: true });
        fs.writeFileSync(activeMarkerPath(root), '{"identityLabel":"active"}\n', { mode: 0o600 });
      } else {
        fs.mkdirSync(identities, { recursive: true });
        fs.writeFileSync(path.join(identities, 'existing-state'), 'preserve\n', { mode: 0o600 });
      }

      const result = runAdmin(
        adminCommand,
        ['bootstrap', '--label', 'new-label'],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, setup);
      assert.match(result.stderr, /active marker|managed identities|decommission|recover/i);
      assert.equal(readCalls(root.root).some((call) => call.operation === 'create'), false);
      assert.equal(fs.existsSync(activeMarkerPath(root)), setup === 'active-marker');
      if (setup === 'non-empty-identities') {
        assert.deepEqual(fs.readdirSync(identities), ['existing-state']);
      } else {
        assert.deepEqual(managedIdentities(root), []);
      }
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('reports the created orphan and installs nothing when local verification fails', () => {
  const scenario = summary.scenarios.providerFailure;
  const root = createScenarioRoot(scenario);
  const identity = scenario.identitySnapshots.after[0];
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
    assert.match(result.stderr, /recover|delete|identity/i);
    assert.deepEqual(managedIdentities(root), []);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.equal(
      readCalls(root.root).some((call) => call.tool === 'ssh-keygen' && call.operation === 'verify'),
      false,
    );
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('selects the export matching the independently listed CTK SSH fingerprint', () => {
  const scenario = summary.scenarios.multipleResidentExportsExpectedSecond;
  const root = createScenarioRoot(scenario);
  const identity = scenario.identitySnapshots.after[0];
  const expectedExport = scenario.residentExports.find(
    (residentExport) => residentExport.publicKey === identity.publicKey,
  );
  const rejectedExport = scenario.residentExports.find(
    (residentExport) => residentExport.publicKey !== identity.publicKey,
  );
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(declarationFrom(result).sshFingerprint, expectedExport.fingerprint);
    const identityDir = path.join(
      root.stateHome,
      'git-mcp-secure-enclave-signing',
      'identities',
      identity.hash,
    );
    assert.equal(
      fs.readFileSync(path.join(identityDir, expectedExport.stubName), 'utf8').trim(),
      expectedExport.stub,
    );
    assert.equal(fs.existsSync(path.join(identityDir, rejectedExport.stubName)), false);

    const calls = readCalls(root.root);
    const fingerprintCalls = calls.filter((call) => call.operation === 'fingerprint');
    assert.equal(fingerprintCalls.length, 2, 'all exported candidates are independently fingerprinted');
    assert.match(fingerprintCalls[0].argv.at(-1), new RegExp(`${rejectedExport.stubName}\\.pub$`));
    assert.match(fingerprintCalls[1].argv.at(-1), new RegExp(`${expectedExport.stubName}\\.pub$`));
    const signCall = calls.find((call) => call.operation === 'sign');
    assert.match(signCall.argv[signCall.argv.indexOf('-f') + 1], new RegExp(`${expectedExport.stubName}$`));
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects zero, mismatched, or ambiguous resident-public-key matches and preserves the orphan diagnostic', () => {
  for (const scenarioName of [
    'zeroResidentExports',
    'mismatchedExpectedFingerprint',
    'ambiguousResidentFingerprint',
  ]) {
    const scenario = summary.scenarios[scenarioName];
    const root = createScenarioRoot(scenario);
    const identity = scenario.identitySnapshots.after[0];
    try {
      const result = runAdmin(
        adminCommand,
        ['bootstrap', '--label', identity.label],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, scenarioName);
      assert.match(result.stderr, /exactly one|ambiguous|resident.*public|export/i);
      assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
      assert.deepEqual(managedIdentities(root), []);
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('reports a known or unknown orphan when post-create CTK state cannot be confirmed', () => {
  for (const scenarioName of ['postCreateListFailure', 'postCreateMalformedIdentity']) {
    const scenario = summary.scenarios[scenarioName];
    const root = createScenarioRoot(scenario);
    const identity = scenario.identitySnapshots.after[0];
    try {
      const result = runAdmin(
        adminCommand,
        ['bootstrap', '--label', identity.label],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, scenarioName);
      assert.match(result.stderr, /orphan CTK identity hash|unknown CTK orphan/i);
      assert.match(result.stderr, /sc_auth.*inspect|decommission|recover/i);
      assert.deepEqual(managedIdentities(root), []);
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
      const calls = readCalls(root.root);
      assert.equal(
        calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'create').length,
        1,
        'post-create failure performs exactly one CTK create call',
      );
      assert.equal(
        calls.some((call) => call.tool === 'ssh-keygen'),
        false,
        'post-create state failures happen before resident export',
      );
      assert.equal(fs.existsSync(activeMarkerPath(root)), false);
      if (scenarioName === 'postCreateMalformedIdentity') {
        assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
      } else {
        assert.match(result.stderr, /unknown CTK orphan/i);
      }
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('refuses a requested label that already existed before CTK creation', () => {
  const scenario = summary.scenarios.staleSameLabel;
  const root = createScenarioRoot(scenario);
  const identity = scenario.identitySnapshots.after.at(-1);
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /label.*already existed|existing.*label/i);
    assert.deepEqual(managedIdentities(root), []);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    const calls = readCalls(root.root);
    assert.equal(
      calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'create').length,
      0,
      'stale same-label state is rejected before CTK creation',
    );
    assert.equal(calls.some((call) => call.tool === 'ssh-keygen'), false);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});
