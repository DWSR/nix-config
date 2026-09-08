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

function buildAdmin(nativeOverrides = {}, packageOverrides = {}) {
  const overrideEntries = Object.entries(nativeOverrides)
    .map(([name, value]) => `${name} = ${JSON.stringify(value)};`)
    .join('\n         ');
  const packageOverrideEntries = Object.entries(packageOverrides)
    .map(([name, expression]) => `${name} = ${expression};`)
    .join('\n         ');
  const nativeArgs = overrideEntries
    ? `fixture.nativeToolArgs // {\n         ${overrideEntries}\n       }`
    : 'fixture.nativeToolArgs';
  const packageArgs = packageOverrideEntries
    ? `${nativeArgs} // {\n         ${packageOverrideEntries}\n       }`
    : nativeArgs;
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fixture = import ${JSON.stringify(fixturePath)} { inherit pkgs; };
      admin = pkgs.callPackage (import ${JSON.stringify(adminPath)}) (${packageArgs});
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

function installEnrollment(root, scenario, options = {}) {
  const identity = options.identity || scenario.identitySnapshots.after[0];
  const residentExport = options.residentExport
    || scenario.residentExports.find((candidate) => candidate.publicKey === identity.publicKey)
    || scenario.residentExports[0];
  const hash = options.hash || identity.hash;
  const stateDir = options.stateDir
    || path.join(root.stateHome, 'git-mcp-secure-enclave-signing');
  const identityDir = path.join(stateDir, 'identities', hash);
  const marker = {
    stateDir,
    identityLabel: options.identityLabel || identity.label,
    ctkPublicKeyHash: hash,
    sshPublicKey: options.sshPublicKey || identity.publicKey,
    sshFingerprint: options.sshFingerprint || identity.sshFingerprint || residentExport.fingerprint,
    githubSigningKeyRegistered: true,
  };

  fs.mkdirSync(path.dirname(activeMarkerPath(root)), { recursive: true });
  fs.writeFileSync(activeMarkerPath(root), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(root.root, 'identity-snapshot'),
    `${options.identitySnapshot || 'after'}\n`,
    { mode: 0o600 },
  );

  if (options.writeArtifacts !== false) {
    fs.mkdirSync(identityDir, { recursive: true });
    if (options.writeStub !== false) {
      fs.writeFileSync(
        path.join(identityDir, 'id_ecdsa_sk_rk'),
        `${options.artifactStub || residentExport.stub}\n`,
        { mode: 0o600 },
      );
    }
    if (options.writePublic !== false) {
      fs.writeFileSync(
        path.join(identityDir, 'id_ecdsa_sk_rk.pub'),
        `${options.artifactPublicKey || residentExport.publicKey}\n`,
        { mode: 0o644 },
      );
    }
  }

  return {
    identity,
    residentExport,
    marker,
    stateDir,
    identityDir,
    stubPath: path.join(identityDir, 'id_ecdsa_sk_rk'),
    publicPath: path.join(identityDir, 'id_ecdsa_sk_rk.pub'),
  };
}

function cloneScenario(scenario, changes = {}) {
  return {
    ...JSON.parse(JSON.stringify(scenario)),
    ...changes,
  };
}

function quoteRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
let missingAdminCommands;
let renameFailureAdminCommand;

test.before(() => {
  summary = fixtureSummary();
  adminCommand = path.join(buildAdmin(), 'bin/git-mcp-secure-enclave-admin');
  renameFailureAdminCommand = path.join(
    buildAdmin({}, {
      coreutils: `pkgs.runCommand "git-mcp-admin-failing-mv-coreutils" {} ''
        mkdir -p $out/bin
        cp -R \${pkgs.coreutils}/bin/. $out/bin/
        rm -f $out/bin/mv
        cat > $out/bin/mv <<'EOF'
        #!/bin/sh
        counter="$GIT_MCP_SIGNING_FIXTURE_ROOT/mv-count"
        count=0
        if [ -r "$counter" ]; then
          count="$(cat "$counter")"
        fi
        count=$((count + 1))
        printf '%s\\n' "$count" > "$counter"
        if [ "$count" -ge 2 ]; then
          printf '%s\\n' 'fixture forced mv failure' >&2
          exit 75
        fi
        exec \${pkgs.coreutils}/bin/mv "$@"
        EOF
        chmod +x $out/bin/mv
      ''`,
    }),
    'bin/git-mcp-secure-enclave-admin',
  );
  missingAdminCommands = {
    provider: path.join(
      buildAdmin({ providerPath: '/nonexistent/git-mcp-admin-provider' }),
      'bin/git-mcp-secure-enclave-admin',
    ),
    scAuth: path.join(
      buildAdmin({ scAuthPath: '/nonexistent/git-mcp-admin-sc-auth' }),
      'bin/git-mcp-secure-enclave-admin',
    ),
    sshKeygen: path.join(
      buildAdmin({ sshKeygenPath: '/nonexistent/git-mcp-admin-ssh-keygen' }),
      'bin/git-mcp-secure-enclave-admin',
    ),
  };
});

test('doctor and probe reject duplicate CTK rows for the active label before signing', () => {
  const scenario = summary.scenarios.staleSameLabel;
  const activeIdentity = scenario.identitySnapshots.after.at(-1);
  const staleIdentity = scenario.identitySnapshots.before[0];
  const expectedDiagnostic = [
    `[git-mcp-secure-enclave-admin] CTK identity label ${activeIdentity.label} has duplicate rows;`,
    `expected exactly one p-256-ne/none row for hash ${activeIdentity.hash},`,
    `observed rows: ${staleIdentity.hash}/p-256-ne/none/${activeIdentity.label};`,
    `${activeIdentity.hash}/p-256-ne/none/${activeIdentity.label}`,
  ].join(' ');

  for (const command of ['doctor', 'probe']) {
    const root = createScenarioRoot(scenario);
    try {
      const enrollment = installEnrollment(root, scenario, { identity: activeIdentity });
      const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
      const identityEntriesBefore = fs.readdirSync(enrollment.identityDir).sort();
      const result = runAdmin(
        adminCommand,
        [command, '--hash', activeIdentity.hash],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, `${command} must fail closed`);
      assert.equal(result.stderr.trim(), expectedDiagnostic, `${command} diagnostic`);
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${command} leaves no temporary output`);
      assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
      assert.deepEqual(
        fs.readdirSync(enrollment.identityDir).sort(),
        identityEntriesBefore,
        `${command} leaves managed identity state unchanged`,
      );

      const calls = readCalls(root.root);
      assert.equal(
        calls.some((call) => call.tool === 'ssh-keygen'),
        false,
        `${command} fails before ssh-keygen stub/sign/verify calls`,
      );
      assert.equal(
        calls.some((call) => call.tool === 'provider'),
        false,
        `${command} fails before provider calls`,
      );
      assert.deepEqual(
        calls.map((call) => [call.tool, call.operation]),
        [['sc_auth', 'list']],
        `${command} validates the full CTK row set before downstream calls`,
      );
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('doctor and probe validate a matching active enrollment without persistent probe data', () => {
  for (const command of ['doctor', 'probe']) {
    const scenario = summary.scenarios.oneResidentExport;
    const root = createScenarioRoot(scenario);
    const enrollment = installEnrollment(root, scenario);
    const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
    const stubBefore = fs.readFileSync(enrollment.stubPath, 'utf8');
    const publicBefore = fs.readFileSync(enrollment.publicPath, 'utf8');
    try {
      const result = runAdmin(
        adminCommand,
        [command, '--hash', enrollment.identity.hash],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${command}.*${enrollment.identity.hash}`));
      assert.match(result.stdout, /verified|healthy/i);
      assert.doesNotMatch(result.stdout, /BEGIN OPENSSH PRIVATE KEY|Zml4dHVyZS1yZXNpZGVudC1oYW5kbGU/);
      assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
      assert.equal(fs.readFileSync(enrollment.stubPath, 'utf8'), stubBefore);
      assert.equal(fs.readFileSync(enrollment.publicPath, 'utf8'), publicBefore);
      assert.deepEqual(fs.readdirSync(root.tempHome), [], 'temporary probe files are cleaned');
      assert.deepEqual(fs.readdirSync(enrollment.identityDir).sort(), [
        'id_ecdsa_sk_rk',
        'id_ecdsa_sk_rk.pub',
      ]);

      const calls = readCalls(root.root);
      assert.ok(calls.some((call) => call.tool === 'sc_auth' && call.operation === 'list'));
      assert.ok(calls.some((call) => call.tool === 'sc_auth' && call.operation === 'list-ssh'));
      const signCalls = calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'sign');
      const verifyCalls = calls.filter((call) => call.tool === 'ssh-keygen' && call.operation === 'verify');
      assert.equal(signCalls.length, 1, `${command} has one local sign call`);
      assert.equal(verifyCalls.length, 1, `${command} has one local verify call`);
      assert.equal(signCalls[0].signingStub, enrollment.stubPath);
      assert.equal(signCalls[0].signingPublicKey, enrollment.marker.sshPublicKey);
      assert.match(
        verifyCalls[0].allowedSigners,
        new RegExp(`${quoteRegex(enrollment.marker.sshPublicKey)}\\s*$`),
      );
      for (const call of calls.filter((entry) => ['ssh-keygen', 'provider'].includes(entry.tool))) {
        assert.equal(call.selector, enrollment.identity.hash, `${call.tool}/${call.operation} selector`);
      }
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('doctor and probe require githubSigningKeyRegistered to be boolean true', () => {
  for (const markerCase of [
    { name: 'false', value: false },
    { name: 'string', value: 'true' },
    { name: 'missing' },
  ]) {
    for (const command of ['doctor', 'probe']) {
      const scenario = summary.scenarios.oneResidentExport;
      const root = createScenarioRoot(scenario);
      try {
        const enrollment = installEnrollment(root, scenario);
        const marker = JSON.parse(fs.readFileSync(activeMarkerPath(root), 'utf8'));
        if (markerCase.name === 'missing') {
          delete marker.githubSigningKeyRegistered;
        } else {
          marker.githubSigningKeyRegistered = markerCase.value;
        }
        fs.writeFileSync(activeMarkerPath(root), `${JSON.stringify(marker)}\n`, { mode: 0o600 });

        const result = runAdmin(
          adminCommand,
          [command, '--hash', enrollment.identity.hash],
          fixtureEnvironment(root),
        );

        assert.equal(result.status, 1, `${command}/${markerCase.name}`);
        assert.equal(
          result.stderr.trim(),
          `[git-mcp-secure-enclave-admin] active enrollment marker ${activeMarkerPath(root)} has invalid githubSigningKeyRegistered; expected boolean true`,
          `${command}/${markerCase.name} diagnostic`,
        );
        assert.deepEqual(readCalls(root.root), []);
      } finally {
        fs.rmSync(root.root, { recursive: true, force: true });
      }
    }
  }
});

test('diagnosis reports the exact missing active marker and leaves state untouched', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  try {
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', scenario.identitySnapshots.after[0].hash],
      fixtureEnvironment(root),
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`active enrollment marker ${quoteRegex(activeMarkerPath(root))} is missing`),
    );
    assert.deepEqual(managedIdentities(root), []);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.deepEqual(readCalls(root.root), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('diagnosis rejects an active marker selecting the wrong hash with expected and observed values', () => {
  const scenario = summary.scenarios.multipleResidentExports;
  const root = createScenarioRoot(scenario);
  const requestedHash = scenario.identitySnapshots.after[0].hash;
  const observedHash = '2222222222222222222222222222222222222222';
  try {
    installEnrollment(root, scenario, { hash: observedHash });
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', requestedHash],
      fixtureEnvironment(root),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(
      `active enrollment marker .* selects CTK hash ${observedHash}.*expected ${requestedHash}`,
    ));
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.equal(readCalls(root.root).length, 0);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('diagnosis reports a missing state directory, resident stub, or public key by exact path', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const missingStateDir = path.join(os.tmpdir(), 'git-mcp-admin-missing-state');
  for (const setup of [
    { name: 'state directory', options: { stateDir: missingStateDir, writeArtifacts: false } },
    { name: 'resident stub', options: { writeStub: false } },
    { name: 'resident public key', options: { writePublic: false } },
  ]) {
    const root = createScenarioRoot(scenario);
    try {
      const enrollment = installEnrollment(root, scenario, setup.options);
      const result = runAdmin(
        adminCommand,
        ['doctor', '--hash', enrollment.identity.hash],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, setup.name);
      const expectedPath = setup.name === 'state directory'
        ? setup.options.stateDir
        : setup.name === 'resident stub' ? enrollment.stubPath : enrollment.publicPath;
      assert.match(result.stderr, new RegExp(quoteRegex(expectedPath)));
      assert.match(result.stderr, /absent|missing|directory/i);
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('diagnosis reports public-key, fingerprint, and CTK identity mismatches exactly', () => {
  const primaryScenario = summary.scenarios.multipleResidentExports;
  const primaryIdentity = primaryScenario.identitySnapshots.after[0];
  const alternateExport = primaryScenario.residentExports.find(
    (residentExport) => residentExport.publicKey !== primaryIdentity.publicKey,
  );
  const cases = [
    {
      name: 'public key',
      scenario: primaryScenario,
      options: {
        artifactPublicKey: alternateExport.publicKey,
        artifactStub: alternateExport.stub,
      },
      pattern: /resident public key .*expected .*observed/i,
    },
    {
      name: 'malformed public key',
      scenario: primaryScenario,
      options: { artifactPublicKey: 'not-an-openssh-public-key' },
      pattern: /resident public key .*malformed.*expected/i,
    },
    {
      name: 'fingerprint',
      scenario: primaryScenario,
      options: { sshFingerprint: 'SHA256:fixturewrong' },
      pattern: /fingerprint.*expected SHA256:fixturewrong.*observed SHA256:fixtureprimary/i,
    },
    {
      name: 'malformed fingerprint',
      scenario: primaryScenario,
      options: { sshFingerprint: 'not-a-fingerprint' },
      pattern: /active enrollment marker .*malformed sshFingerprint.*observed not-a-fingerprint/i,
    },
    {
      name: 'CTK identity',
      scenario: summary.scenarios.biometricConfiguredIdentity,
      options: {},
      pattern: /CTK identity .*expected p-256-ne\/none.*observed .*bio/i,
    },
    {
      name: 'identity label',
      scenario: primaryScenario,
      options: { identityLabel: 'wrong-label' },
      pattern: /CTK identity .*expected p-256-ne\/none label wrong-label.*observed .*fixture-primary/i,
    },
    {
      name: 'malformed resident stub',
      scenario: primaryScenario,
      options: { artifactStub: 'not-a-resident-stub' },
      pattern: /ssh-keygen rejected resident stub/i,
    },
  ];

  for (const mismatch of cases) {
    const root = createScenarioRoot(mismatch.scenario);
    try {
      const enrollment = installEnrollment(root, mismatch.scenario, mismatch.options);
      const result = runAdmin(
        adminCommand,
        ['doctor', '--hash', enrollment.identity.hash],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, mismatch.name);
      assert.match(result.stderr, mismatch.pattern, mismatch.name);
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }

  const selectorScenario = summary.scenarios.selectorMismatch;
  const selectorRoot = createScenarioRoot(selectorScenario);
  try {
    const enrollment = installEnrollment(selectorRoot, selectorScenario);
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', enrollment.identity.hash],
      fixtureEnvironment(selectorRoot),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(
      `selector mismatch: expected ${selectorScenario.expectedSelector}, observed ${enrollment.identity.hash}`,
    ));
    assert.deepEqual(fs.readdirSync(selectorRoot.tempHome), []);
  } finally {
    fs.rmSync(selectorRoot.root, { recursive: true, force: true });
  }

  const missingIdentityScenario = cloneScenario(summary.scenarios.oneResidentExport, {
    identitySnapshots: { before: [], after: [] },
  });
  const root = createScenarioRoot(missingIdentityScenario);
  try {
    const enrollment = installEnrollment(root, missingIdentityScenario, {
      identity: summary.scenarios.oneResidentExport.identitySnapshots.after[0],
    });
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', enrollment.identity.hash],
      fixtureEnvironment(root),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`CTK identity ${enrollment.identity.hash}.*missing`));
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('diagnosis identifies missing native tools by their fixed paths', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const cases = [
    ['provider', missingAdminCommands.provider, '/nonexistent/git-mcp-admin-provider'],
    ['sc_auth', missingAdminCommands.scAuth, '/nonexistent/git-mcp-admin-sc-auth'],
    ['ssh-keygen', missingAdminCommands.sshKeygen, '/nonexistent/git-mcp-admin-ssh-keygen'],
  ];

  for (const [tool, command, missingPath] of cases) {
    const root = createScenarioRoot(scenario);
    try {
      const enrollment = installEnrollment(root, scenario);
      const result = runAdmin(
        command,
        ['doctor', '--hash', enrollment.identity.hash],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, tool);
      assert.match(result.stderr, new RegExp(`${quoteRegex(missingPath)}.*absent|not executable|unreadable`));
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('diagnosis refuses duplicate SSH identity rows for the active label', () => {
  const scenario = summary.scenarios.duplicateSshIdentity;
  const root = createScenarioRoot(scenario);
  try {
    const enrollment = installEnrollment(root, scenario);
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', enrollment.identity.hash],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      `[git-mcp-secure-enclave-admin] CTK SSH identity ${enrollment.identity.label} has duplicate rows; expected exactly one p-256-ne/none fingerprint ${enrollment.marker.sshFingerprint}`,
    );
    assert.equal(
      readCalls(root.root).some((call) => call.tool === 'ssh-keygen' && call.operation === 'sign'),
      false,
      'duplicate rows fail before local signing',
    );
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('diagnosis reports first-unlock listing failure and provider rejection, cleaning probe data on failure', () => {
  const firstUnlockScenario = cloneScenario(summary.scenarios.oneResidentExport, {
    failures: {
      sc_auth: { list: 'fixture sc_auth unavailable before first unlock' },
    },
  });
  const firstUnlockRoot = createScenarioRoot(firstUnlockScenario);
  try {
    const enrollment = installEnrollment(firstUnlockRoot, firstUnlockScenario);
    const result = runAdmin(
      adminCommand,
      ['doctor', '--hash', enrollment.identity.hash],
      fixtureEnvironment(firstUnlockRoot),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /first unlock/i);
    assert.deepEqual(fs.readdirSync(firstUnlockRoot.tempHome), []);
  } finally {
    fs.rmSync(firstUnlockRoot.root, { recursive: true, force: true });
  }

  const providerScenario = summary.scenarios.providerFailure;
  const providerRoot = createScenarioRoot(providerScenario);
  try {
    const enrollment = installEnrollment(providerRoot, providerScenario);
    const result = runAdmin(
      adminCommand,
      ['probe', '--hash', enrollment.identity.hash],
      fixtureEnvironment(providerRoot),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture provider rejected signing/i);
    assert.match(result.stderr, /first unlock/i);
    assert.deepEqual(fs.readdirSync(providerRoot.tempHome), []);
    assert.deepEqual(fs.readdirSync(enrollment.identityDir).sort(), [
      'id_ecdsa_sk_rk',
      'id_ecdsa_sk_rk.pub',
    ]);
  } finally {
    fs.rmSync(providerRoot.root, { recursive: true, force: true });
  }
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

test('stages additive rotation as a distinct unregistered candidate without changing the active enrollment', () => {
  const scenario = summary.scenarios.rotation;
  const root = createScenarioRoot(scenario);
  const activeIdentity = scenario.identitySnapshots.after[0];
  const candidateIdentity = scenario.identitySnapshots.after[1];
  const active = installEnrollment(root, scenario, { identitySnapshot: 'before' });
  const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
  const activeStubBefore = fs.readFileSync(active.stubPath, 'utf8');
  const activePublicBefore = fs.readFileSync(active.publicPath, 'utf8');
  try {
    const result = runAdmin(
      adminCommand,
      ['rotate', '--label', candidateIdentity.label],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(declarationFrom(result), {
      identityLabel: candidateIdentity.label,
      ctkPublicKeyHash: candidateIdentity.hash,
      sshPublicKey: candidateIdentity.publicKey,
      sshFingerprint: candidateIdentity.sshFingerprint,
      githubSigningKeyRegistered: false,
    });
    assert.notEqual(candidateIdentity.hash, activeIdentity.hash, 'rotation uses a new CTK hash');
    assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
    assert.equal(fs.readFileSync(active.stubPath, 'utf8'), activeStubBefore);
    assert.equal(fs.readFileSync(active.publicPath, 'utf8'), activePublicBefore);

    const candidateDir = path.join(
      root.stateHome,
      'git-mcp-secure-enclave-signing',
      'identities',
      candidateIdentity.hash,
    );
    assert.equal(fs.readFileSync(path.join(candidateDir, 'id_ecdsa_sk_rk'), 'utf8').trim(), scenario.residentExports[1].stub);
    assert.equal(
      fs.readFileSync(path.join(candidateDir, 'id_ecdsa_sk_rk.pub'), 'utf8').trim(),
      candidateIdentity.publicKey,
    );
    assert.deepEqual(managedIdentities(root), [activeIdentity.hash, candidateIdentity.hash].sort());
    assert.equal(fileMode(candidateDir), 0o700);
    assert.equal(fileMode(path.join(candidateDir, 'id_ecdsa_sk_rk')), 0o600);
    assert.equal(fileMode(path.join(candidateDir, 'id_ecdsa_sk_rk.pub')), 0o644);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);

    const calls = readCalls(root.root);
    const createCall = calls.find((call) => call.tool === 'sc_auth' && call.operation === 'create');
    assert.deepEqual(createCall.argv, [
      'create-ctk-identity',
      '-l',
      candidateIdentity.label,
      '-k',
      'p-256-ne',
      '-t',
      'none',
    ]);
    const exportCall = calls.find((call) => call.operation === 'resident-export');
    assert.equal(exportCall.selector, candidateIdentity.hash);
    assert.equal(exportCall.exportEmpty, true);
    assert.ok(
      calls.some((call) => call.tool === 'ssh-keygen' && call.operation === 'verify'),
      'rotation verifies the candidate locally before emitting its declaration',
    );
    for (const call of calls.filter((entry) => ['ssh-keygen', 'provider'].includes(entry.tool))) {
      assert.equal(call.selector, candidateIdentity.hash, `${call.tool}/${call.operation} selector`);
    }
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rotation preserves the active enrollment when candidate creation or verification fails', () => {
  const cases = [
    {
      name: 'candidate creation failure',
      scenario: summary.scenarios.rotationCreateFailure,
      pattern: /create|candidate|rotation/i,
    },
    {
      name: 'candidate verification failure',
      scenario: summary.scenarios.rotationVerificationFailure,
      pattern: /local signing|verification|orphan/i,
    },
  ];

  for (const rotationCase of cases) {
    const root = createScenarioRoot(rotationCase.scenario);
    const active = installEnrollment(root, rotationCase.scenario, { identitySnapshot: 'before' });
    const candidateIdentity = rotationCase.scenario.identitySnapshots.after[1];
    const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
    const activeStubBefore = fs.readFileSync(active.stubPath, 'utf8');
    const activePublicBefore = fs.readFileSync(active.publicPath, 'utf8');
    try {
      const result = runAdmin(
        adminCommand,
        ['rotate', '--label', candidateIdentity.label],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, rotationCase.name);
      assert.match(result.stderr, rotationCase.pattern, rotationCase.name);
      assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
      assert.equal(fs.readFileSync(active.stubPath, 'utf8'), activeStubBefore);
      assert.equal(fs.readFileSync(active.publicPath, 'utf8'), activePublicBefore);
      assert.deepEqual(managedIdentities(root), [active.identity.hash]);
      assert.equal(
        fs.existsSync(path.join(
          root.stateHome,
          'git-mcp-secure-enclave-signing',
          'identities',
          candidateIdentity.hash,
        )),
        false,
        `${rotationCase.name} does not install candidate artifacts`,
      );
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${rotationCase.name} cleans temporary data`);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
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

test('recovers a missing resident stub only for the active hash and exact selector', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const enrollment = installEnrollment(root, scenario, { writeArtifacts: false });
  const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
  const residentExport = scenario.residentExports[0];
  try {
    const result = runAdmin(
      adminCommand,
      ['recover-stub', '--hash', enrollment.identity.hash],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recovered|restored/i);
    assert.equal(
      fs.readFileSync(enrollment.stubPath, 'utf8').trim(),
      residentExport.stub,
    );
    assert.equal(
      fs.readFileSync(enrollment.publicPath, 'utf8').trim(),
      residentExport.publicKey,
    );
    assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
    assert.equal(fileMode(enrollment.identityDir), 0o700);
    assert.equal(fileMode(enrollment.stubPath), 0o600);
    assert.equal(fileMode(enrollment.publicPath), 0o644);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);

    const calls = readCalls(root.root);
    const exportCalls = calls.filter(
      (call) => call.tool === 'ssh-keygen' && call.operation === 'resident-export',
    );
    assert.equal(exportCalls.length, 1);
    assert.equal(exportCalls[0].selector, enrollment.identity.hash);
    assert.equal(exportCalls[0].exportEmpty, true);
    assert.ok(
      calls.some((call) => call.tool === 'ssh-keygen' && call.operation === 'stub'),
      'recovery verifies the exported stub public key',
    );
    assert.ok(
      calls.some((call) => call.tool === 'ssh-keygen' && call.operation === 'fingerprint'),
      'recovery verifies the exported public-key fingerprint',
    );
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('recover-stub preserves valid state on missing, ambiguous, and failed recovery', () => {
  const failedExportScenario = cloneScenario(summary.scenarios.oneResidentExport, {
    failures: {
      'ssh-keygen': {
        'resident-export': 'fixture resident export failed',
      },
    },
  });
  const cases = [
    {
      name: 'missing export',
      scenario: summary.scenarios.zeroResidentExports,
      residentExport: summary.scenarios.oneResidentExport.residentExports[0],
      pattern: /exactly one|matching|export/i,
    },
    {
      name: 'ambiguous export',
      scenario: summary.scenarios.ambiguousResidentFingerprint,
      pattern: /exactly one|ambiguous|fingerprint/i,
    },
    {
      name: 'failed export',
      scenario: failedExportScenario,
      pattern: /resident export failed|export/i,
    },
    {
      name: 'public-key mismatch',
      scenario: summary.scenarios.oneResidentExport,
      options: {
        sshPublicKey: summary.scenarios.multipleResidentExports.residentExports[1].publicKey,
      },
      pattern: /identity mismatch|public key/i,
    },
  ];

  for (const recoveryCase of cases) {
    const root = createScenarioRoot(recoveryCase.scenario);
    try {
      const enrollment = installEnrollment(root, recoveryCase.scenario, {
        residentExport: recoveryCase.residentExport,
        ...recoveryCase.options,
      });
      const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
      const stubBefore = fs.readFileSync(enrollment.stubPath, 'utf8');
      const publicBefore = fs.readFileSync(enrollment.publicPath, 'utf8');
      const identityEntriesBefore = fs.readdirSync(enrollment.identityDir).sort();

      const result = runAdmin(
        adminCommand,
        ['recover-stub', '--hash', enrollment.identity.hash],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, recoveryCase.name);
      assert.match(result.stderr, recoveryCase.pattern, recoveryCase.name);
      assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
      assert.equal(fs.readFileSync(enrollment.stubPath, 'utf8'), stubBefore);
      assert.equal(fs.readFileSync(enrollment.publicPath, 'utf8'), publicBefore);
      assert.deepEqual(
        fs.readdirSync(enrollment.identityDir).sort(),
        identityEntriesBefore,
        `${recoveryCase.name} leaves the managed pair unchanged`,
      );
      assert.deepEqual(fs.readdirSync(root.tempHome), []);

      const exportCall = readCalls(root.root).find(
        (call) => call.tool === 'ssh-keygen' && call.operation === 'resident-export',
      );
      if (exportCall) {
        assert.equal(exportCall.selector, enrollment.identity.hash, recoveryCase.name);
      }
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('retains the valid backup when installation and rollback renames both fail', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const enrollment = installEnrollment(root, scenario);
  const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
  const stubBefore = fs.readFileSync(enrollment.stubPath, 'utf8');
  const publicBefore = fs.readFileSync(enrollment.publicPath, 'utf8');
  const identitiesDir = path.dirname(enrollment.identityDir);

  try {
    const result = runAdmin(
      renameFailureAdminCommand,
      ['recover-stub', '--hash', enrollment.identity.hash],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
    assert.equal(fs.existsSync(enrollment.identityDir), false, 'failed rollback does not invent a replacement');

    const entries = fs.readdirSync(identitiesDir).sort();
    const backupEntries = entries.filter((entry) => entry.startsWith('.recover-backup.'));
    const stagingEntries = entries.filter((entry) => entry.startsWith('.recover.'));
    assert.equal(backupEntries.length, 1, 'the old identity has one retained recovery backup');
    assert.deepEqual(stagingEntries, [], 'failed staging directory is cleaned up');

    const backupDir = path.join(identitiesDir, backupEntries[0]);
    assert.match(
      result.stderr,
      new RegExp(
        `previous resident state was retained at ${quoteRegex(backupDir)}\\. Restore it to ${quoteRegex(enrollment.identityDir)}.*retry`,
        'i',
      ),
      'double-rename failure gives exact recovery guidance',
    );
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'id_ecdsa_sk_rk'), 'utf8'),
      stubBefore,
      'the old resident stub remains recoverable in the retained backup',
    );
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'id_ecdsa_sk_rk.pub'), 'utf8'),
      publicBefore,
      'the old public key remains recoverable in the retained backup',
    );
    assert.equal(fs.readFileSync(path.join(root.root, 'mv-count'), 'utf8').trim(), '3');
    assert.deepEqual(fs.readdirSync(root.tempHome), [], 'temporary and untracked staging artifacts are cleaned');
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('recover-stub refuses a requested hash that differs from the active marker', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const enrollment = installEnrollment(root, scenario);
  const requestedHash = '2222222222222222222222222222222222222222';
  const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
  const stubBefore = fs.readFileSync(enrollment.stubPath, 'utf8');
  const publicBefore = fs.readFileSync(enrollment.publicPath, 'utf8');
  try {
    const result = runAdmin(
      adminCommand,
      ['recover-stub', '--hash', requestedHash],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(
      `active enrollment marker .* selects CTK hash ${enrollment.identity.hash}.*expected ${requestedHash}`,
    ));
    assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
    assert.equal(fs.readFileSync(enrollment.stubPath, 'utf8'), stubBefore);
    assert.equal(fs.readFileSync(enrollment.publicPath, 'utf8'), publicBefore);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.deepEqual(readCalls(root.root), []);
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
