'use strict';

// Task 7 contract: the live-validation harness must be a real, operator-gated
// command. These tests build the same derivation an operator runs and exercise
// every offline mode, so the harness's machine-record, host-key, and failure
// classifiers are proven without a provisioned builder, tailnet, or secret.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const scriptNix = path.join(repoRoot, 'scripts/linux-builder-live-validate.nix');
const scriptShell = path.join(repoRoot, 'scripts/linux-builder-live-validate.sh');
const fixturePinPath = path.join(
  repoRoot,
  'tests/linux-nix-remote-builder/fixtures/ssh_host_ed25519_key.pub',
);
const fixturePin = fs.readFileSync(fixturePinPath, 'utf8');
const fixturePinBase64 = Buffer.from(fixturePin).toString('base64');

const darwinEndpoint = 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net';
const darwinSystem = 'aarch64-darwin';
const fabroDarwinClientKey = '/run/secrets/build-client-key';
const personalDarwinClientKey = '/run/secrets/mac-builder-ssh-private-key';
const linuxEndpoint = 'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net';
const linuxSystem = 'aarch64-linux';
const linuxClientKey = '/run/secrets/linux-builder-client-key';
const builderHost = 'linux-builder.tuxedo-musical.ts.net';

let executable;

function buildValidator() {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.callPackage ${JSON.stringify(scriptNix)} {}`;
  return (
    childProcess
      .execFileSync(
        'nix',
        ['build', '--impure', '--no-link', '--print-out-paths', '--expr', expression],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 240_000,
          env: { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes' },
        },
      )
      .trim() + '/bin/linux-builder-live-validate'
  );
}

function run(args, options = {}) {
  return childProcess.spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(contents) {
  const directory = temporaryDirectory('linux-builder-live-fixture-');
  const file = path.join(directory, 'fixture');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function machineRecord({
  endpoint = darwinEndpoint,
  system = darwinSystem,
  keyPath = fabroDarwinClientKey,
  jobs = '4',
  speed = '2',
  hostKey = fixturePinBase64,
} = {}) {
  return `${endpoint} ${system} ${keyPath} ${jobs} ${speed} - - ${hostKey}`;
}

function personalDarwinRecord(overrides = {}) {
  return machineRecord({
    keyPath: personalDarwinClientKey,
    jobs: '8',
    speed: '1',
    ...overrides,
  });
}

function linuxRecord(overrides = {}) {
  return machineRecord({
    endpoint: linuxEndpoint,
    system: linuxSystem,
    keyPath: linuxClientKey,
    jobs: '4',
    speed: '1',
    ...overrides,
  });
}

function validMachines(profile = 'fabro') {
  const darwin = profile === 'personal' ? personalDarwinRecord() : machineRecord();
  return `${darwin}\n${linuxRecord()}\n`;
}

function fakeLima() {
  const directory = temporaryDirectory('linux-builder-live-lima-');
  const calls = path.join(directory, 'lima-calls');
  const lima = path.join(directory, 'lima-vmctl');
  fs.writeFileSync(lima, `#!/bin/sh\nprintf called >> ${JSON.stringify(calls)}\n`, {
    mode: 0o755,
  });
  return { calls, lima };
}

const unsupportedDiagnostic = `error: Cannot build '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-probe.drv'.
       Reason: local builds are disabled (max-jobs = 0)
       Hint: set 'max-jobs' to a non-zero value to enable local builds, or configure remote builders via 'builders'
       Reason: platform mismatch
       Required system: 'x86_64-linux'
       Current system: 'aarch64-linux'
`;

const noFallbackDiagnostic = `cannot build on 'ssh-ng://builder@${builderHost}': error: failed to start SSH connection to '${builderHost}'
Failed to find a machine for remote build!
derivation: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-probe.drv
required (system, features): (aarch64-linux, [])
1 available machines:
(systems, maxjobs, supportedFeatures, mandatoryFeatures)
([aarch64-linux], 4, [], [])
error: Cannot build '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-probe.drv'.
       Reason: local builds are disabled (max-jobs = 0)
`;

test.before(() => {
  executable = buildValidator();
});

test('help is safe, lists every offline mode, and does not touch Lima', () => {
  const lima = fakeLima();
  const result = run(['--help'], { env: { LIMA_VMCTL: lima.lima } });

  assert.equal(result.status, 0, result.stderr);
  for (const needle of [
    '--confirm-live-state-changes',
    '--check-machine-record',
    '--check-host-key-pin',
    '--classify-unsupported-platform',
    '--classify-no-fallback',
  ]) {
    assert.match(result.stdout, new RegExp(needle));
  }
  assert.equal(fs.existsSync(lima.calls), false, '--help must not invoke Lima');
});

test('live work requires the explicit live-state acknowledgement', () => {
  const lima = fakeLima();
  const result = run([], { env: { LIMA_VMCTL: lima.lima } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-live-state-changes/);
  assert.equal(fs.existsSync(lima.calls), false, 'unconfirmed live work must not invoke Lima');
});

test('confirmed live work still refuses a non-interactive shell', () => {
  const lima = fakeLima();
  const result = run(['--confirm-live-state-changes'], { env: { LIMA_VMCTL: lima.lima } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TTY|terminal|personal Mac/i);
  assert.equal(fs.existsSync(lima.calls), false, 'non-interactive live work must not invoke Lima');
});

test('host-key pin validation accepts the checked-in fixture', () => {
  const result = run(['--check-host-key-pin', fixturePinPath]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SHA256:/);
});

test('host-key pin validation rejects missing, multi-line, and non-Ed25519 pins', () => {
  const missing = run(['--check-host-key-pin', path.join(temporaryDirectory('pin-missing-'), 'nope')]);
  assert.notEqual(missing.status, 0);

  const multiLine = run([
    '--check-host-key-pin',
    writeFile(`${fixturePin}${fixturePin}`),
  ]);
  assert.notEqual(multiLine.status, 0);

  const rsa = run([
    '--check-host-key-pin',
    writeFile('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ builder\n'),
  ]);
  assert.notEqual(rsa.status, 0);

  const badBase64 = run([
    '--check-host-key-pin',
    writeFile('ssh-ed25519 not-base64! builder\n'),
  ]);
  assert.notEqual(badBase64.status, 0);
});

test('machine-record validation accepts the Fabro Darwin and Linux records', () => {
  const result = run(['--check-machine-record', writeFile(validMachines())]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fabro profile/);
  assert.match(result.stdout, /Darwin/);
  assert.match(result.stdout, /Linux/);
});

test('machine-record validation accepts the personal Mac Darwin profile', () => {
  const result = run([
    '--check-machine-record',
    writeFile(validMachines('personal')),
    '--profile',
    'personal',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /personal profile/);
  assert.match(result.stdout, /Darwin/);
  assert.match(result.stdout, /Linux/);
});

test('machine-record validation rejects the wrong Darwin profile', () => {
  const result = run([
    '--check-machine-record',
    writeFile(validMachines('personal')),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fabro Darwin/);
});

test('machine-record validation rejects a missing Linux record', () => {
  const result = run(['--check-machine-record', writeFile(`${machineRecord()}\n`)]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /two|Linux|record/i);
});

test('machine-record validation rejects a wrong Linux system', () => {
  const result = run([
    '--check-machine-record',
    writeFile(`${machineRecord()}\n${linuxRecord({ system: 'aarch64-darwin' })}\n`),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux.*aarch64-linux|aarch64-linux.*Linux/);
});

test('machine-record validation rejects a non-runtime Linux key path', () => {
  const result = run([
    '--check-machine-record',
    writeFile(`${machineRecord()}\n${linuxRecord({ keyPath: '/tmp/linux-builder-client-key' })}\n`),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /client-key|runtime path|\/run\/secrets/);
});

test('machine-record validation rejects a wrong Linux job count or speed factor', () => {
  const jobs = run([
    '--check-machine-record',
    writeFile(`${machineRecord()}\n${linuxRecord({ jobs: '2' })}\n`),
  ]);
  assert.notEqual(jobs.status, 0);

  const speed = run([
    '--check-machine-record',
    writeFile(`${machineRecord()}\n${linuxRecord({ speed: '2' })}\n`),
  ]);
  assert.notEqual(speed.status, 0);
});

test('machine-record validation rejects a changed Darwin route', () => {
  const endpoint = run([
    '--check-machine-record',
    writeFile(`${machineRecord({ endpoint: 'ssh-ng://nix-builder@mac-builder.example.ts.net' })}\n${linuxRecord()}\n`),
  ]);
  assert.notEqual(endpoint.status, 0);
  assert.match(endpoint.stderr, /Darwin/);

  const system = run([
    '--check-machine-record',
    writeFile(`${machineRecord({ system: 'aarch64-linux' })}\n${linuxRecord()}\n`),
  ]);
  assert.notEqual(system.status, 0);
  assert.match(system.stderr, /Darwin/);
});

test('machine-record validation rejects malformed and unparseable records', () => {
  const sevenFields = run([
    '--check-machine-record',
    writeFile(`${machineRecord().split(' ').slice(0, 7).join(' ')}\n${linuxRecord()}\n`),
  ]);
  assert.notEqual(sevenFields.status, 0);

  const badHostKey = run([
    '--check-machine-record',
    writeFile(`${machineRecord()}\n${linuxRecord({ hostKey: 'not-base64' })}\n`),
  ]);
  assert.notEqual(badHostKey.status, 0);

  const extraLine = run([
    '--check-machine-record',
    writeFile(`${validMachines()}${linuxRecord()}\n`),
  ]);
  assert.notEqual(extraLine.status, 0);
});

test('unsupported-platform classifier accepts a platform-mismatch diagnostic', () => {
  const result = run(['--classify-unsupported-platform', 'aarch64-linux'], {
    input: unsupportedDiagnostic,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /x86_64-linux/);

  const darwinStyle = run(['--classify-unsupported-platform', 'aarch64-darwin'], {
    input: "error: a 'x86_64-linux' with features {} is required to build '/nix/store/aaaa-probe.drv', but I am a 'aarch64-darwin'.\n",
  });
  assert.equal(darwinStyle.status, 0, darwinStyle.stderr);
});

test('unsupported-platform classifier rejects success and unrelated failures', () => {
  const success = run(['--classify-unsupported-platform', 'aarch64-linux'], {
    input: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-probe\n',
  });
  assert.notEqual(success.status, 0);

  const noMismatch = run(['--classify-unsupported-platform', 'aarch64-linux'], {
    input: "error: x86_64-linux aarch64-linux hash mismatch\n",
  });
  assert.notEqual(noMismatch.status, 0);

  const wrongClient = run(['--classify-unsupported-platform', 'aarch64-linux'], {
    input: "error: a 'x86_64-linux' is required to build '/nix/store/aaaa-probe.drv', but I am a 'aarch64-darwin'.\n",
  });
  assert.notEqual(wrongClient.status, 0);
});

test('no-fallback classifier accepts a builder transport failure with local builds disabled', () => {
  const result = run(['--classify-no-fallback', builderHost], {
    input: noFallbackDiagnostic,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /linux-builder/);
});

test('no-fallback classifier rejects success and diagnostics that do not name the builder', () => {
  const success = run(['--classify-no-fallback', builderHost], {
    input: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-probe\n',
  });
  assert.notEqual(success.status, 0);

  const unrelated = run(['--classify-no-fallback', builderHost], {
    input: 'error: hash mismatch in fixed-output derivation\n',
  });
  assert.notEqual(unrelated.status, 0);

  const otherHost = run(['--classify-no-fallback', builderHost], {
    input: "cannot build on 'ssh-ng://builder@other.example': error: failed to start SSH connection\n",
  });
  assert.notEqual(otherHost.status, 0);
});

test('the harness contains no secret material or 1Password references', () => {
  for (const file of [scriptNix, scriptShell]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /BEGIN (OPENSSH|RSA|EC|PRIVATE) PRIVATE KEY/);
    assert.doesNotMatch(text, /op:\/\//);
    assert.doesNotMatch(text, /tskey-/);
  }
});
