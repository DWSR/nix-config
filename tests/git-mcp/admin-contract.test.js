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

function runAdmin(command, args, env, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env,
    encoding: 'utf8',
    input: '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
}

function runGit(args, options = {}) {
  return childProcess.execFileSync('git', args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

function acceptanceArgs(hash, commits, includeGithubVerified = true) {
  const args = [
    'record-acceptance',
    '--hash', hash,
    '--unlocked-commit', commits.unlocked,
    '--locked-commit', commits.locked,
    '--sleep-commit', commits.sleep,
    '--reboot-commit', commits.reboot,
    '--github-commit', commits.github,
  ];
  if (includeGithubVerified) args.push('--github-verified');
  return args;
}

function acceptanceEnvironment(root) {
  return {
    ...fixtureEnvironment(root),
    GIT_MCP_ACCEPTANCE_HOST: 'fixture-host',
    GIT_MCP_ACCEPTANCE_OS_VERSION: '26.0.0-fixture',
  };
}

function createAcceptanceRepository(root, enrollment, options = {}) {
  const repository = path.join(root.root, 'acceptance-repository');
  fs.mkdirSync(repository, { recursive: true });
  runGit(['init', '--quiet', '--initial-branch=main'], { cwd: repository });
  runGit(['config', 'user.name', 'Fixture Operator'], { cwd: repository });
  runGit(['config', 'user.email', 'fixture@example.test'], { cwd: repository });

  const environment = {
    ...fixtureEnvironment(root),
    GIT_CONFIG_NOSYSTEM: '1',
    KEYCHAIN_CERTIFICATES: enrollment.identity.hash,
    SSH_SK_PROVIDER: summary.nativeToolPaths.provider,
  };
  const states = ['unlocked', 'locked', 'sleep', 'reboot', 'github'];
  const unsignedStates = new Set(options.unsignedStates || []);
  const mismatchedStates = new Set(options.mismatchedStates || []);
  let mismatchedStubPath;
  if (mismatchedStates.size > 0) {
    const mismatchedExport = (options.scenario || summary.scenarios.multipleResidentExports)
      .residentExports.find((residentExport) => residentExport.publicKey !== enrollment.marker.sshPublicKey);
    assert.ok(mismatchedExport, 'mismatch fixture has an alternate resident export');
    mismatchedStubPath = path.join(root.root, 'mismatched-resident-stub');
    fs.writeFileSync(mismatchedStubPath, `${mismatchedExport.stub}\n`, { mode: 0o600 });
    fs.writeFileSync(`${mismatchedStubPath}.pub`, `${mismatchedExport.publicKey}\n`, { mode: 0o644 });
  }

  const commits = {};
  let parent;
  for (const state of states) {
    const filePath = path.join(repository, `${state}.txt`);
    fs.writeFileSync(filePath, `fixture ${state} acceptance probe\n`);
    runGit(['add', `${state}.txt`], { cwd: repository, env: environment });
    const tree = runGit(['write-tree'], { cwd: repository, env: environment });
    const signingPublicKey = mismatchedStates.has(state)
      ? fs.readFileSync(`${mismatchedStubPath}.pub`, 'utf8').trim()
      : enrollment.marker.sshPublicKey;
    const commitHeaders = [
      `tree ${tree}`,
      ...(parent ? [`parent ${parent}`] : []),
      'author Fixture Operator <fixture@example.test> 1720000000 +0000',
      'committer Fixture Operator <fixture@example.test> 1720000000 +0000',
    ];
    if (!unsignedStates.has(state)) {
      commitHeaders.push(
        'gpgsig -----BEGIN SSH SIGNATURE-----',
        ` fixture-ssh-signature:${signingPublicKey}`,
        ' -----END SSH SIGNATURE-----',
      );
    }
    const rawCommit = `${commitHeaders.join('\n')}\n\nacceptance ${state}\n`;
    const commit = childProcess.execFileSync(
      'git',
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      {
        cwd: repository,
        env: environment,
        input: rawCommit,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    ).trim();
    runGit(['update-ref', 'HEAD', commit], { cwd: repository, env: environment });
    commits[state] = commit;
    parent = commit;
  }

  return { repository, commits };
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

function acceptancePath(stateDir, hash) {
  return path.join(stateDir, 'acceptance', `${hash}.json`);
}

function installLocalIdentity(stateDir, identity, residentExport) {
  const identityDir = path.join(stateDir, 'identities', identity.hash);
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(
    path.join(identityDir, 'id_ecdsa_sk_rk'),
    `${residentExport.stub}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(identityDir, 'id_ecdsa_sk_rk.pub'),
    `${residentExport.publicKey}\n`,
    { mode: 0o644 },
  );
  return identityDir;
}

function installAcceptance(stateDir, hash) {
  fs.mkdirSync(path.dirname(acceptancePath(stateDir, hash)), { recursive: true });
  fs.writeFileSync(acceptancePath(stateDir, hash), '{"schemaVersion":1}\n', { mode: 0o600 });
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

function snapshotTree(entryPath) {
  const stat = fs.lstatSync(entryPath);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return { type: 'symlink', mode, target: fs.readlinkSync(entryPath) };
  }
  if (stat.isFile()) {
    return { type: 'file', mode, contents: fs.readFileSync(entryPath).toString('base64') };
  }
  if (stat.isDirectory()) {
    const entries = Object.fromEntries(
      fs.readdirSync(entryPath).sort().map((entry) => [
        entry,
        snapshotTree(path.join(entryPath, entry)),
      ]),
    );
    return { type: 'directory', mode, entries };
  }
  return { type: 'other', mode };
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

let adminCommand;
let summary;
let missingAdminCommands;
let renameFailureAdminCommand;
let acceptanceFailureAdminCommand;

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
        fail_at="''\${GIT_MCP_SIGNING_FAIL_MV_AT:-2}"
        count=0
        if [ -r "$counter" ]; then
          count="$(cat "$counter")"
        fi
        count=$((count + 1))
        printf '%s\\n' "$count" > "$counter"
        if [ "$count" -ge "$fail_at" ]; then
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
  acceptanceFailureAdminCommand = path.join(
    buildAdmin({}, {
      coreutils: `pkgs.runCommand "git-mcp-admin-acceptance-failing-mv-coreutils" {} ''
        mkdir -p $out/bin
        cp -R \${pkgs.coreutils}/bin/. $out/bin/
        rm -f $out/bin/mv
        cat > $out/bin/mv <<'EOF'
        #!/bin/sh
        printf '%s\\n' 'fixture forced acceptance mv failure' >&2
        exit 75
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
  const expectedDeclaration = {
    identityLabel: identity.label,
    ctkPublicKeyHash: identity.hash,
    sshPublicKey: residentExport.publicKey,
    sshFingerprint: residentExport.fingerprint,
    githubSigningKeyRegistered: false,
  };
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `${JSON.stringify(expectedDeclaration)}\n`,
      'bootstrap emits only the expected public enrollment declaration',
    );
    assert.equal(
      result.stderr,
      scenario.nativeOutput.stderr,
      'bootstrap preserves the fixture native diagnostic on stderr',
    );
    assert.deepEqual(declarationFrom(result), expectedDeclaration);
    const prohibitedOutput = /BEGIN OPENSSH PRIVATE KEY|id_ecdsa_sk_rk|Zml4dHVyZS1yZXNpZGVudC1oYW5kbGU|fixture-resident-handle|generic-password|op:\/\//i;
    assert.doesNotMatch(result.stdout, prohibitedOutput, 'stdout contains only public declaration data');
    assert.doesNotMatch(result.stderr, prohibitedOutput, 'stderr contains no private, stub, or secret material');

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
        ['provider', 'load'],
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

test('bootstraps the requested identity while preserving an unrelated CTK identity', () => {
  const baseScenario = summary.scenarios.oneResidentExport;
  const identity = baseScenario.identitySnapshots.after[0];
  const unrelatedIdentity = summary.scenarios.rotation.identitySnapshots.after[1];
  const scenario = cloneScenario(baseScenario, {
    identitySnapshots: {
      before: [unrelatedIdentity],
      after: [unrelatedIdentity, identity],
    },
  });
  const root = createScenarioRoot(scenario);
  try {
    const result = runAdmin(
      adminCommand,
      ['bootstrap', '--label', identity.label],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(declarationFrom(result).ctkPublicKeyHash, identity.hash);
    assert.deepEqual(managedIdentities(root), [identity.hash]);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);

    const calls = readCalls(root.root);
    assert.equal(
      calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'create').length,
      1,
    );
    assert.equal(
      calls.some((call) => call.tool === 'sc_auth' && call.operation === 'delete'),
      false,
      'bootstrap never deletes the unrelated CTK identity',
    );
    const exportCall = calls.find(
      (call) => call.tool === 'ssh-keygen' && call.operation === 'resident-export',
    );
    assert.equal(exportCall.selector, identity.hash, 'bootstrap selects only the new requested identity');
    assert.notEqual(exportCall.selector, unrelatedIdentity.hash);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects unsafe CTK identity-set transitions before resident export', () => {
  const baseScenario = summary.scenarios.oneResidentExport;
  const identity = baseScenario.identitySnapshots.after[0];
  const existingIdentity = summary.scenarios.rotation.identitySnapshots.after[1];
  const cases = [
    {
      name: 'no new identity',
      identitySnapshots: { before: [], after: [] },
      diagnostic: /exactly one new identity hash/i,
      orphanHashes: [],
    },
    {
      name: 'multiple new identities',
      identitySnapshots: { before: [], after: [identity, existingIdentity] },
      diagnostic: /exactly one new identity hash/i,
      orphanHashes: [identity.hash, existingIdentity.hash],
    },
    {
      name: 'existing identity removed',
      identitySnapshots: { before: [existingIdentity], after: [identity] },
      diagnostic: /lost an existing identity/i,
      orphanHashes: [identity.hash],
    },
    {
      name: 'existing label changed',
      identitySnapshots: {
        before: [existingIdentity],
        after: [{ ...existingIdentity, label: 'fixture-renamed-existing' }, identity],
      },
      diagnostic: /label changed for existing hash/i,
      orphanHashes: [identity.hash],
    },
    {
      name: 'wrong protection',
      identitySnapshots: { before: [], after: [{ ...identity, protection: 'bio' }] },
      diagnostic: /not p-256-ne with protection none/i,
      orphanHashes: [identity.hash],
    },
    {
      name: 'wrong key type',
      identitySnapshots: { before: [], after: [{ ...identity, keyType: 'p-384-ne' }] },
      diagnostic: /not p-256-ne with protection none/i,
      orphanHashes: [identity.hash],
    },
    {
      name: 'wrong new label',
      identitySnapshots: {
        before: [],
        after: [{ ...identity, label: 'fixture-unrequested-label' }],
      },
      diagnostic: /instead of requested label/i,
      orphanHashes: [identity.hash],
    },
  ];

  for (const identitySetCase of cases) {
    const scenario = cloneScenario(baseScenario, {
      identitySnapshots: identitySetCase.identitySnapshots,
    });
    const root = createScenarioRoot(scenario);
    try {
      const result = runAdmin(
        adminCommand,
        ['bootstrap', '--label', identity.label],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, identitySetCase.name);
      assert.equal(result.stdout, '', `${identitySetCase.name} emits no declaration`);
      assert.match(result.stderr, identitySetCase.diagnostic, identitySetCase.name);
      for (const orphanHash of identitySetCase.orphanHashes) {
        assert.match(result.stderr, new RegExp(`orphan.*${orphanHash}`), identitySetCase.name);
      }
      assert.deepEqual(managedIdentities(root), [], identitySetCase.name);
      assert.equal(fs.existsSync(activeMarkerPath(root)), false, identitySetCase.name);
      assert.deepEqual(fs.readdirSync(root.tempHome), [], identitySetCase.name);
      const calls = readCalls(root.root);
      assert.equal(
        calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'create').length,
        1,
        `${identitySetCase.name} performs one CTK create operation`,
      );
      assert.equal(
        calls.some((call) => call.tool === 'ssh-keygen'),
        false,
        `${identitySetCase.name} fails before resident export`,
      );
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('reports a created orphan and leaves no partial state when atomic bootstrap installation fails', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const identity = scenario.identitySnapshots.after[0];
  try {
    const result = runAdmin(
      renameFailureAdminCommand,
      ['bootstrap', '--label', identity.label],
      {
        ...fixtureEnvironment(root),
        GIT_MCP_SIGNING_FAIL_MV_AT: '1',
      },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '', 'failed bootstrap emits no enrollment declaration');
    assert.match(result.stderr, /cannot atomically install resident artifacts/i);
    assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
    assert.deepEqual(managedIdentities(root), []);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.equal(fs.readFileSync(path.join(root.root, 'mv-count'), 'utf8').trim(), '1');
    assert.equal(
      readCalls(root.root).filter(
        (call) => call.tool === 'ssh-keygen' && call.operation === 'verify',
      ).length,
      1,
      'atomic installation is attempted only after local verification',
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

test('decommission refuses the identity selected by the active marker before native deletion', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  const enrollment = installEnrollment(root, scenario);
  installAcceptance(enrollment.stateDir, enrollment.identity.hash);
  const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
  const identityEntriesBefore = fs.readdirSync(enrollment.identityDir).sort();
  try {
    const result = runAdmin(
      adminCommand,
      ['decommission', '--hash', enrollment.identity.hash, '--fingerprint', enrollment.marker.sshFingerprint],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /active enrollment marker .* selects target|refus/i);
    assert.deepEqual(readCalls(root.root), [], 'active target is refused before native calls');
    assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
    assert.deepEqual(fs.readdirSync(enrollment.identityDir).sort(), identityEntriesBefore);
    assert.equal(fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), true);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('decommission removes only an exact inactive identity with an absent or replacement marker', () => {
  const scenario = summary.scenarios.rotation;
  const target = scenario.identitySnapshots.after[0];
  const replacement = scenario.identitySnapshots.after[1];
  const targetExport = scenario.residentExports.find((residentExport) => residentExport.publicKey === target.publicKey);
  const replacementExport = scenario.residentExports.find(
    (residentExport) => residentExport.publicKey === replacement.publicKey,
  );

  for (const markerMode of ['absent', 'replacement']) {
    const root = createScenarioRoot(scenario);
    try {
      const active = installEnrollment(root, scenario, {
        identity: markerMode === 'replacement' ? replacement : target,
        identitySnapshot: 'after',
      });
      const stateDir = active.stateDir;
      const targetDir = markerMode === 'replacement'
        ? installLocalIdentity(stateDir, target, targetExport)
        : active.identityDir;
      if (markerMode === 'absent') installLocalIdentity(stateDir, replacement, replacementExport);
      if (markerMode === 'absent') fs.rmSync(activeMarkerPath(root));
      installAcceptance(stateDir, target.hash);
      installAcceptance(stateDir, replacement.hash);

      const result = runAdmin(
        adminCommand,
        ['decommission', '--hash', target.hash, '--fingerprint', target.sshFingerprint],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 0, `${markerMode}: ${result.stderr}`);
      assert.match(result.stdout, /GitHub.*signing key.*remove/i, `${markerMode} GitHub guidance`);
      assert.match(result.stdout, /platform.*identity|CTK.*identity.*cleanup/i, `${markerMode} platform guidance`);
      assert.equal(fs.existsSync(targetDir), false, `${markerMode} removes the requested identity directory`);
      assert.equal(fs.existsSync(acceptancePath(stateDir, target.hash)), false, `${markerMode} removes target acceptance`);
      assert.equal(
        fs.existsSync(path.join(stateDir, 'identities', replacement.hash)),
        true,
        `${markerMode} preserves the replacement identity directory`,
      );
      assert.equal(
        fs.existsSync(acceptancePath(stateDir, replacement.hash)),
        true,
        `${markerMode} preserves the replacement acceptance record`,
      );
      if (markerMode === 'replacement') {
        const marker = JSON.parse(fs.readFileSync(activeMarkerPath(root), 'utf8'));
        assert.equal(marker.ctkPublicKeyHash, replacement.hash, 'replacement remains selected');
      } else {
        assert.equal(fs.existsSync(activeMarkerPath(root)), false, 'absent marker remains absent');
      }
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${markerMode} cleans temporary data`);

      const calls = readCalls(root.root);
      const deleteCalls = calls.filter((call) => call.tool === 'sc_auth' && call.operation === 'delete');
      assert.equal(deleteCalls.length, 1, `${markerMode} performs one exact native deletion`);
      assert.deepEqual(deleteCalls[0].argv, ['delete-ctk-identity', '-h', target.hash]);
      assert.equal(
        calls.some((call) => call.argv.includes('delete-all-ctk-identities')),
        false,
        `${markerMode} never invokes delete-all`,
      );
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('decommission rejects malformed or mismatched hash/fingerprint confirmation without state changes', () => {
  const scenario = summary.scenarios.rotation;
  const replacement = scenario.identitySnapshots.after[1];
  const target = scenario.identitySnapshots.after[0];
  const cases = [
    {
      name: 'malformed hash',
      hash: 'not-a-ctk-hash',
      fingerprint: target.sshFingerprint,
      pattern: /hash .*malformed|40 lowercase hexadecimal/i,
    },
    {
      name: 'malformed fingerprint',
      hash: target.hash,
      fingerprint: 'not-a-fingerprint',
      pattern: /fingerprint .*malformed|SHA256/i,
    },
    {
      name: 'observed fingerprint mismatch',
      hash: target.hash,
      fingerprint: replacement.sshFingerprint,
      pattern: /fingerprint mismatch|expected .*observed/i,
    },
  ];

  for (const decommissionCase of cases) {
    const root = createScenarioRoot(scenario);
    try {
      const active = installEnrollment(root, scenario, { identity: replacement, identitySnapshot: 'after' });
      const targetExport = scenario.residentExports.find(
        (residentExport) => residentExport.publicKey === target.publicKey,
      );
      installLocalIdentity(active.stateDir, target, targetExport);
      installAcceptance(active.stateDir, target.hash);
      const stateBefore = fs.readdirSync(path.join(active.stateDir, 'identities')).sort();
      const acceptanceBefore = fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort();

      const result = runAdmin(
        adminCommand,
        ['decommission', '--hash', decommissionCase.hash, '--fingerprint', decommissionCase.fingerprint],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, decommissionCase.name);
      assert.match(result.stderr, decommissionCase.pattern, decommissionCase.name);
      assert.deepEqual(
        fs.readdirSync(path.join(active.stateDir, 'identities')).sort(),
        stateBefore,
        `${decommissionCase.name} preserves identity state`,
      );
      assert.deepEqual(
        fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort(),
        acceptanceBefore,
        `${decommissionCase.name} preserves acceptance state`,
      );
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${decommissionCase.name} cleans temporary data`);
      assert.equal(
        readCalls(root.root).some((call) => call.tool === 'sc_auth' && call.operation === 'delete'),
        false,
        `${decommissionCase.name} does not delete a native identity`,
      );
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('decommission preserves valid local state when exact native deletion fails', () => {
  const scenario = cloneScenario(summary.scenarios.rotation, {
    failures: {
      sc_auth: {
        delete: 'fixture exact CTK deletion failed',
      },
    },
  });
  const target = scenario.identitySnapshots.after[0];
  const replacement = scenario.identitySnapshots.after[1];
  const root = createScenarioRoot(scenario);
  try {
    const active = installEnrollment(root, scenario, { identity: replacement, identitySnapshot: 'after' });
    const targetExport = scenario.residentExports.find(
      (residentExport) => residentExport.publicKey === target.publicKey,
    );
    installLocalIdentity(active.stateDir, target, targetExport);
    installAcceptance(active.stateDir, target.hash);
    const identitiesBefore = fs.readdirSync(path.join(active.stateDir, 'identities')).sort();
    const acceptanceBefore = fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort();

    const result = runAdmin(
      adminCommand,
      ['decommission', '--hash', target.hash, '--fingerprint', target.sshFingerprint],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /deletion failed|local state was preserved/i);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'identities')).sort(), identitiesBefore);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort(), acceptanceBefore);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
    assert.equal(
      readCalls(root.root).filter((call) => call.tool === 'sc_auth' && call.operation === 'delete').length,
      1,
    );
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('decommission refuses absent, non-directory, or symlinked acceptance state before native deletion', () => {
  const scenario = summary.scenarios.rotation;
  const target = scenario.identitySnapshots.after[0];
  const replacement = scenario.identitySnapshots.after[1];
  const targetExport = scenario.residentExports.find(
    (residentExport) => residentExport.publicKey === target.publicKey,
  );

  for (const acceptanceState of ['absent', 'file', 'symlink']) {
    const root = createScenarioRoot(scenario);
    try {
      const active = installEnrollment(root, scenario, { identity: replacement, identitySnapshot: 'after' });
      installLocalIdentity(active.stateDir, target, targetExport);
      const acceptanceDir = path.join(active.stateDir, 'acceptance');
      const outsideAcceptanceDir = path.join(root.root, 'outside-acceptance');
      if (acceptanceState === 'file') {
        fs.writeFileSync(acceptanceDir, 'preserve\n', { mode: 0o600 });
      } else if (acceptanceState === 'symlink') {
        fs.mkdirSync(outsideAcceptanceDir, { recursive: true });
        fs.writeFileSync(path.join(outsideAcceptanceDir, `${target.hash}.json`), 'preserve\n', { mode: 0o600 });
        fs.symlinkSync(outsideAcceptanceDir, acceptanceDir, 'dir');
      }
      const markerBefore = fs.readFileSync(activeMarkerPath(root), 'utf8');
      const identityEntriesBefore = fs.readdirSync(path.join(active.stateDir, 'identities')).sort();

      const result = runAdmin(
        adminCommand,
        ['decommission', '--hash', target.hash, '--fingerprint', target.sshFingerprint],
        fixtureEnvironment(root),
      );

      assert.equal(result.status, 1, acceptanceState);
      assert.match(
        result.stderr,
        new RegExp(`managed acceptance directory .*${acceptanceState === 'symlink' ? 'symlinked' : 'absent|not a directory'}`),
        acceptanceState,
      );
      assert.equal(fs.readFileSync(activeMarkerPath(root), 'utf8'), markerBefore);
      assert.deepEqual(
        fs.readdirSync(path.join(active.stateDir, 'identities')).sort(),
        identityEntriesBefore,
        `${acceptanceState} preserves identity state`,
      );
      assert.equal(
        readCalls(root.root).some((call) => call.tool === 'sc_auth' && call.operation === 'delete'),
        false,
        `${acceptanceState} refuses before native deletion`,
      );
      if (acceptanceState === 'symlink') {
        assert.equal(fs.lstatSync(acceptanceDir).isSymbolicLink(), true);
        assert.equal(fs.existsSync(path.join(outsideAcceptanceDir, `${target.hash}.json`)), true);
      } else if (acceptanceState === 'file') {
        assert.equal(fs.statSync(acceptanceDir).isFile(), true);
      } else {
        assert.equal(fs.existsSync(acceptanceDir), false);
      }
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${acceptanceState} cleans temporary data`);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }
});

test('decommission rejects duplicate SHA1 label mapping before SSH lookup and preserves state', () => {
  const scenario = summary.scenarios.staleSameLabel;
  const target = scenario.identitySnapshots.after.at(-1);
  const stale = scenario.identitySnapshots.before[0];
  const root = createScenarioRoot(scenario);
  try {
    const active = installEnrollment(root, scenario, { identity: stale, identitySnapshot: 'after' });
    installLocalIdentity(active.stateDir, target, scenario.residentExports[0]);
    installAcceptance(active.stateDir, target.hash);
    const expectedDiagnostic = [
      `[git-mcp-secure-enclave-admin] CTK identity label ${target.label} has duplicate SHA1 rows and is ambiguous;`,
      `expected exactly one p-256-ne/none row for hash ${target.hash},`,
      `observed rows: ${stale.hash}/p-256-ne/none/${target.label};`,
      `${target.hash}/p-256-ne/none/${target.label}`,
    ].join(' ');
    const identityEntriesBefore = fs.readdirSync(path.join(active.stateDir, 'identities')).sort();
    const acceptanceEntriesBefore = fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort();

    const result = runAdmin(
      adminCommand,
      ['decommission', '--hash', target.hash, '--fingerprint', target.sshFingerprint],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), expectedDiagnostic);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'identities')).sort(), identityEntriesBefore);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort(), acceptanceEntriesBefore);
    const calls = readCalls(root.root);
    assert.equal(
      calls.some((call) => call.tool === 'sc_auth' && call.operation === 'list-ssh'),
      false,
      'duplicate SHA1 labels are rejected before SSH fingerprint lookup',
    );
    assert.equal(
      calls.some((call) => call.tool === 'sc_auth' && call.operation === 'delete'),
      false,
      'duplicate SHA1 labels are rejected before native deletion',
    );
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('decommission reports an absent target with bootstrap and recovery guidance', () => {
  const scenario = summary.scenarios.rotation;
  const target = {
    hash: '2222222222222222222222222222222222222222',
    label: 'fixture-lost',
    publicKey: scenario.identitySnapshots.after[0].publicKey,
  };
  const replacement = scenario.identitySnapshots.after[1];
  const root = createScenarioRoot(scenario);
  try {
    const active = installEnrollment(root, scenario, { identity: replacement, identitySnapshot: 'after' });
    installLocalIdentity(active.stateDir, target, scenario.residentExports[0]);
    installAcceptance(active.stateDir, target.hash);
    const identityEntriesBefore = fs.readdirSync(path.join(active.stateDir, 'identities')).sort();
    const acceptanceEntriesBefore = fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort();

    const result = runAdmin(
      adminCommand,
      ['decommission', '--hash', target.hash, '--fingerprint', 'SHA256:fixturealternate'],
      fixtureEnvironment(root),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`CTK identity ${target.hash} is absent`));
    assert.match(result.stderr, new RegExp(`recover-stub --hash ${target.hash}`));
    assert.match(result.stderr, /bootstrap --label <new-label>/);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'identities')).sort(), identityEntriesBefore);
    assert.deepEqual(fs.readdirSync(path.join(active.stateDir, 'acceptance')).sort(), acceptanceEntriesBefore);
    assert.equal(
      readCalls(root.root).some((call) => call.tool === 'sc_auth' && call.operation === 'delete'),
      false,
    );
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('refuses active, symlinked, or non-empty managed state before creating a CTK identity', () => {
  for (const setup of ['active-marker', 'symlinked-state', 'non-empty-identities']) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const stateDir = path.join(
        root.stateHome,
        'git-mcp-secure-enclave-signing',
      );
      const identities = path.join(
        stateDir,
        'identities',
      );
      let preservedBytes;
      let preservedDirectory;
      let preservedPath;
      let preservedMode;
      let symlinkTarget;
      if (setup === 'active-marker') {
        preservedBytes = '{"identityLabel":"active"}\n';
        preservedPath = activeMarkerPath(root);
        preservedMode = 0o600;
        fs.mkdirSync(path.dirname(activeMarkerPath(root)), { recursive: true });
        fs.writeFileSync(preservedPath, preservedBytes, { mode: preservedMode });
        fs.chmodSync(preservedPath, preservedMode);
      } else if (setup === 'symlinked-state') {
        symlinkTarget = path.join(root.root, 'outside-state');
        preservedDirectory = symlinkTarget;
        preservedBytes = 'preserve symlink target\n';
        preservedPath = path.join(symlinkTarget, 'existing-state');
        preservedMode = 0o640;
        fs.mkdirSync(symlinkTarget, { mode: 0o750 });
        fs.chmodSync(symlinkTarget, 0o750);
        fs.writeFileSync(preservedPath, preservedBytes, { mode: preservedMode });
        fs.chmodSync(preservedPath, preservedMode);
        fs.symlinkSync(symlinkTarget, stateDir, 'dir');
      } else {
        preservedDirectory = identities;
        preservedBytes = 'preserve managed identity state\n';
        preservedPath = path.join(identities, 'existing-state');
        preservedMode = 0o640;
        fs.mkdirSync(identities, { recursive: true, mode: 0o750 });
        fs.chmodSync(identities, 0o750);
        fs.writeFileSync(preservedPath, preservedBytes, { mode: preservedMode });
        fs.chmodSync(preservedPath, preservedMode);
      }
      const stateTreeBefore = snapshotTree(root.stateHome);
      const symlinkTargetTreeBefore = symlinkTarget ? snapshotTree(symlinkTarget) : null;

      const result = runAdmin(
        adminCommand,
        ['bootstrap', '--label', 'new-label'],
        fixtureEnvironment(root),
      );

      assert.notEqual(result.status, 0, setup);
      assert.equal(result.stdout, '', `${setup} emits no declaration`);
      assert.match(result.stderr, /active.*marker|symlinked|managed identities|decommission|recover/i);
      assert.deepEqual(readCalls(root.root), [], `${setup} refuses before all native calls`);
      assert.deepEqual(
        snapshotTree(root.stateHome),
        stateTreeBefore,
        `${setup} preserves the complete managed state tree`,
      );
      assert.equal(fs.existsSync(activeMarkerPath(root)), setup === 'active-marker');
      assert.equal(fs.readFileSync(preservedPath, 'utf8'), preservedBytes, `${setup} preserves exact bytes`);
      assert.equal(fileMode(preservedPath), preservedMode, `${setup} preserves file mode`);
      if (setup === 'non-empty-identities') {
        assert.deepEqual(fs.readdirSync(identities), ['existing-state']);
        assert.equal(fileMode(preservedDirectory), 0o750, 'managed identities mode is unchanged');
      } else if (setup === 'symlinked-state') {
        assert.equal(fs.lstatSync(stateDir).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(stateDir), symlinkTarget, 'managed state symlink target is unchanged');
        assert.equal(fileMode(preservedDirectory), 0o750, 'symlink target directory mode is unchanged');
        assert.deepEqual(
          snapshotTree(symlinkTarget),
          symlinkTargetTreeBefore,
          'symlink target tree is unchanged',
        );
      } else {
        assert.equal(fs.existsSync(stateDir), false, 'active-marker refusal does not create stateDir');
        assert.deepEqual(managedIdentities(root), []);
      }
      assert.deepEqual(fs.readdirSync(root.tempHome), []);
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
    assert.equal(result.stdout, '', 'failed local verification emits no declaration');
    assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
    assert.match(result.stderr, /recover|delete|identity/i);
    assert.deepEqual(managedIdentities(root), []);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false);
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
    assert.deepEqual(fs.readdirSync(identityDir).sort(), [
      'id_ecdsa_sk_rk',
      'id_ecdsa_sk_rk.pub',
    ]);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);

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
      assert.equal(result.stdout, '', `${scenarioName} emits no declaration`);
      assert.match(result.stderr, /exactly one|ambiguous|resident.*public|export/i);
      assert.match(result.stderr, new RegExp(`orphan.*${identity.hash}`));
      assert.deepEqual(managedIdentities(root), []);
      assert.equal(fs.existsSync(activeMarkerPath(root)), false);
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
      assert.equal(result.stdout, '', `${scenarioName} emits no declaration`);
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
    assert.equal(result.stdout, '', 'pre-existing label refusal emits no declaration');
    assert.match(result.stderr, /label.*already existed|existing.*label/i);
    assert.deepEqual(managedIdentities(root), []);
    assert.equal(fs.existsSync(activeMarkerPath(root)), false);
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

test('records complete acceptance evidence only after verifying every signed commit', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  try {
    const enrollment = installEnrollment(root, scenario);
    const { repository, commits } = createAcceptanceRepository(root, enrollment);
    const result = runAdmin(
      adminCommand,
      acceptanceArgs(enrollment.identity.hash, commits),
      acceptanceEnvironment(root),
      { cwd: repository },
    );

    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(record, {
      schemaVersion: 1,
      host: 'fixture-host',
      macOSVersion: '26.0.0-fixture',
      ctkPublicKeyHash: enrollment.identity.hash,
      sshFingerprint: enrollment.marker.sshFingerprint,
      probes: {
        unlocked: { commit: commits.unlocked, result: 'verified' },
        locked: { commit: commits.locked, result: 'verified' },
        sleep: { commit: commits.sleep, result: 'verified' },
        reboot: { commit: commits.reboot, result: 'verified' },
      },
      github: {
        commit: commits.github,
        verified: true,
        result: 'verified',
      },
      result: 'pass',
      recordedAt: record.recordedAt,
    });
    assert.match(record.recordedAt, /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(
      fs.readFileSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash), 'utf8').trim(),
      JSON.stringify(record),
    );
    assert.equal(fileMode(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(acceptancePath(enrollment.stateDir, enrollment.identity.hash))), [
      `${enrollment.identity.hash}.json`,
    ]);
    assert.deepEqual(fs.readdirSync(root.tempHome), [], 'diagnostic and verification artifacts are temporary');
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /BEGIN OPENSSH PRIVATE KEY/);
    assert.doesNotMatch(serialized, /Zml4dHVyZS1yZXNpZGVudC1oYW5kbGU/);
    assert.doesNotMatch(serialized, /id_ecdsa_sk_rk/);

    const revalidated = runAdmin(
      adminCommand,
      acceptanceArgs(record.ctkPublicKeyHash, {
        unlocked: record.probes.unlocked.commit,
        locked: record.probes.locked.commit,
        sleep: record.probes.sleep.commit,
        reboot: record.probes.reboot.commit,
        github: record.github.commit,
      }),
      acceptanceEnvironment(root),
      { cwd: repository },
    );
    assert.equal(revalidated.status, 0, revalidated.stderr);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects duplicate acceptance commit references before verification and preserves prior evidence', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  try {
    const enrollment = installEnrollment(root, scenario);
    const { repository, commits } = createAcceptanceRepository(root, enrollment);
    const acceptanceDir = path.dirname(acceptancePath(enrollment.stateDir, enrollment.identity.hash));
    const priorEvidence = '{"schemaVersion":1,"result":"previous"}\n';
    fs.mkdirSync(acceptanceDir, { recursive: true });
    fs.writeFileSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash), priorEvidence, { mode: 0o600 });

    const duplicateCommit = commits.unlocked;
    const result = runAdmin(
      adminCommand,
      acceptanceArgs(enrollment.identity.hash, {
        unlocked: duplicateCommit,
        locked: duplicateCommit,
        sleep: duplicateCommit,
        reboot: duplicateCommit,
        github: duplicateCommit,
      }),
      acceptanceEnvironment(root),
      { cwd: repository },
    );

    assert.equal(result.status, 1, 'duplicate commit references must fail');
    assert.match(result.stderr, /duplicate|distinct/i);
    assert.equal(
      fs.readFileSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash), 'utf8'),
      priorEvidence,
      'duplicate references preserve the previous acceptance record',
    );
    assert.deepEqual(fs.readdirSync(acceptanceDir), [`${enrollment.identity.hash}.json`]);
    assert.deepEqual(fs.readdirSync(root.tempHome), [], 'duplicate references create no temporary artifacts');
    assert.deepEqual(readCalls(root.root), [], 'duplicate references fail before native verification');
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects every incomplete acceptance command and requires explicit GitHub verification', () => {
  const fields = [
    ['--hash', '--unlocked-commit'],
    ['--unlocked-commit', '--locked-commit'],
    ['--locked-commit', '--sleep-commit'],
    ['--sleep-commit', '--reboot-commit'],
    ['--reboot-commit', '--github-commit'],
    ['--github-commit', '--github-verified'],
  ];
  const commits = {
    unlocked: 'a'.repeat(40),
    locked: 'b'.repeat(40),
    sleep: 'c'.repeat(40),
    reboot: 'd'.repeat(40),
    github: 'e'.repeat(40),
  };

  for (const [missingFlag, followingFlag] of fields) {
    const root = createScenarioRoot(summary.scenarios.oneResidentExport);
    try {
      const args = acceptanceArgs('a'.repeat(40), commits);
      const missingIndex = args.indexOf(missingFlag);
      args.splice(missingIndex, followingFlag === '--github-verified' ? 1 : 2);
      const result = runAdmin(adminCommand, args, acceptanceEnvironment(root));

      assert.equal(result.status, 1, `missing ${missingFlag}`);
      assert.match(result.stderr, /usage|missing|required|github-verified/i, missingFlag);
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${missingFlag} creates no staging output`);
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true });
    }
  }

  const root = createScenarioRoot(summary.scenarios.oneResidentExport);
  try {
    const result = runAdmin(
      adminCommand,
      acceptanceArgs('a'.repeat(40), commits, false),
      acceptanceEnvironment(root),
    );
    assert.equal(result.status, 1, 'GitHub attestation is mandatory');
    assert.match(result.stderr, /usage|github-verified|explicit|attestation/i);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects missing state commits and inactive or mismatched active enrollment without writing evidence', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  try {
    const enrollment = installEnrollment(root, scenario);
    const { repository, commits } = createAcceptanceRepository(root, enrollment);
    for (const state of ['unlocked', 'locked', 'sleep', 'reboot', 'github']) {
      const missingCommit = { ...commits, [state]: 'f'.repeat(40) };
      const result = runAdmin(
        adminCommand,
        acceptanceArgs(enrollment.identity.hash, missingCommit),
        acceptanceEnvironment(root),
        { cwd: repository },
      );

      assert.equal(result.status, 1, `${state} missing commit`);
      assert.match(result.stderr, new RegExp(`${state}|missing|unsigned|verify`, 'i'), state);
      assert.equal(
        fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)),
        false,
        `${state} missing commit writes no evidence`,
      );
      assert.deepEqual(fs.readdirSync(root.tempHome), [], `${state} missing commit cleans staging output`);
    }

    const wrongHash = '1'.repeat(40);
    const inactive = runAdmin(
      adminCommand,
      acceptanceArgs(wrongHash, commits),
      acceptanceEnvironment(root),
      { cwd: repository },
    );
    assert.equal(inactive.status, 1, 'requested hash must be active');
    assert.match(inactive.stderr, /active enrollment marker .*selects CTK hash|expected/i);
    assert.equal(fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), false);

    const marker = JSON.parse(fs.readFileSync(activeMarkerPath(root), 'utf8'));
    marker.githubSigningKeyRegistered = false;
    fs.writeFileSync(activeMarkerPath(root), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    const unregistered = runAdmin(
      adminCommand,
      acceptanceArgs(enrollment.identity.hash, commits),
      acceptanceEnvironment(root),
      { cwd: repository },
    );
    assert.equal(unregistered.status, 1, 'unregistered enrollment is inactive');
    assert.match(unregistered.stderr, /githubSigningKeyRegistered|registered/i);
    assert.equal(fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), false);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});

test('rejects unsigned and active-key-mismatched commits', () => {
  const unsignedScenario = summary.scenarios.oneResidentExport;
  const unsignedRoot = createScenarioRoot(unsignedScenario);
  try {
    const enrollment = installEnrollment(unsignedRoot, unsignedScenario);
    const { repository, commits } = createAcceptanceRepository(unsignedRoot, enrollment, {
      unsignedStates: ['locked'],
    });
    const result = runAdmin(
      adminCommand,
      acceptanceArgs(enrollment.identity.hash, commits),
      acceptanceEnvironment(unsignedRoot),
      { cwd: repository },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /locked|unsigned|signature|verify/i);
    assert.equal(fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), false);
    assert.deepEqual(fs.readdirSync(unsignedRoot.tempHome), []);
  } finally {
    fs.rmSync(unsignedRoot.root, { recursive: true, force: true });
  }

  const mismatchScenario = summary.scenarios.multipleResidentExports;
  const mismatchRoot = createScenarioRoot(mismatchScenario);
  try {
    const enrollment = installEnrollment(mismatchRoot, mismatchScenario);
    const { repository, commits } = createAcceptanceRepository(mismatchRoot, enrollment, {
      mismatchedStates: ['sleep'],
      scenario: mismatchScenario,
    });
    const result = runAdmin(
      adminCommand,
      acceptanceArgs(enrollment.identity.hash, commits),
      acceptanceEnvironment(mismatchRoot),
      { cwd: repository },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /sleep|active|signature|verify|allowed/i);
    assert.equal(fs.existsSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash)), false);
    assert.deepEqual(fs.readdirSync(mismatchRoot.tempHome), []);
  } finally {
    fs.rmSync(mismatchRoot.root, { recursive: true, force: true });
  }
});

test('preserves prior acceptance evidence when atomic replacement fails and leaves no staging artifact', () => {
  const scenario = summary.scenarios.oneResidentExport;
  const root = createScenarioRoot(scenario);
  try {
    const enrollment = installEnrollment(root, scenario);
    const { repository, commits } = createAcceptanceRepository(root, enrollment);
    const acceptanceDir = path.dirname(acceptancePath(enrollment.stateDir, enrollment.identity.hash));
    fs.mkdirSync(acceptanceDir, { recursive: true });
    const priorEvidence = '{"schemaVersion":1,"result":"previous"}\n';
    fs.writeFileSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash), priorEvidence, { mode: 0o600 });

    const result = runAdmin(
      acceptanceFailureAdminCommand,
      acceptanceArgs(enrollment.identity.hash, commits),
      acceptanceEnvironment(root),
      { cwd: repository },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /atomic|acceptance|staging|failure/i);
    assert.equal(
      fs.readFileSync(acceptancePath(enrollment.stateDir, enrollment.identity.hash), 'utf8'),
      priorEvidence,
      'the previous acceptance record survives a failed replacement',
    );
    assert.deepEqual(fs.readdirSync(acceptanceDir), [`${enrollment.identity.hash}.json`]);
    assert.deepEqual(fs.readdirSync(root.tempHome), []);
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true });
  }
});
