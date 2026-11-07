'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const validatorSource = path.join(repoRoot, 'scripts/fabro-darwin-live-failure-validate.nix');
const pinnedHostKeyBlob = [
  'AAAAC3NzaC1lZD', 'I1NTE5AAAAID1A', 'F8PoQ4lakrcKp0', '0bfrycmCzPLsSW', 'jMDNVfEq9GYM',
].join('');
const pinnedHostKeyText = `ssh-ed25519 ${pinnedHostKeyBlob} mac-builder\n`;
const pinnedHostKey = Buffer.from(pinnedHostKeyText).toString('base64');
const testHostKeyBlob = [
  'AAAAC3NzaC1lZD', 'I1NTE5AAAAINda', 'mAGCsQq31Uv+08', 'lkBzoO4XLz2qYj', 'Ja8CGmj3B1Ea',
].join('');
const testHostKeyText = `ssh-ed25519 ${testHostKeyBlob} fabro-live-failure-test\n`;
const testHostKey = Buffer.from(testHostKeyText).toString('base64');
let executable;

function buildValidator() {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.callPackage ${JSON.stringify(path.join(repoRoot, 'scripts/fabro-darwin-live-failure-validate.nix'))} {}`;
  return childProcess.execFileSync('nix', [
    'build', '--impure', '--no-link', '--print-out-paths', '--expr', expression,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes' },
  }).trim() + '/bin/fabro-darwin-live-failure-validate';
}

function cliFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-live-failure-cli-'));
  const calls = path.join(directory, 'lima-calls');
  const lima = path.join(directory, 'lima-vmctl');
  fs.writeFileSync(lima, '#!/bin/sh\nprintf called >> "$LIMA_CALLS"\n');
  fs.chmodSync(lima, 0o755);
  const run = args => childProcess.spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, LIMA_VMCTL: lima, LIMA_CALLS: calls },
  });
  return { calls, run };
}

function interruptedMachinesFixture({ stageSuffix, stagedContents } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-interrupted-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  const backup = `${machines}.fabro-live-failure-validation-backup`;
  const variant = `${machines}.fabro-live-failure-validation-override`;
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);

  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(override.status, 0, override.stderr);
  fs.unlinkSync(machines);

  const stage = `${machines}.fabro-live-failure-validation-stage.${stageSuffix || 'A1b2C3'}`;
  fs.mkdirSync(stage);
  const stagedOriginal = path.join(stage, 'current');
  fs.writeFileSync(stagedOriginal, stagedContents ?? original, { mode: 0o600 });
  fs.chmodSync(stagedOriginal, 0o600);

  return { directory, machines, original, backup, variant, stage, stagedOriginal };
}

test.before(() => {
  executable = buildValidator();
});

test('live failure validator help is safe and documents the operator gates', () => {
  const fixture = cliFixture();
  const result = fixture.run(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--confirm-live-state-changes/);
  assert.match(result.stdout, /--restore-only/);
  assert.equal(fs.existsSync(fixture.calls), false);
});

test('live failure validator refuses live work without the explicit acknowledgement', () => {
  const fixture = cliFixture();
  const result = fixture.run([]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-live-state-changes/);
  assert.equal(fs.existsSync(fixture.calls), false);
});

test('live failure validator refuses confirmed work without a TTY', () => {
  const fixture = cliFixture();
  const result = fixture.run(['--confirm-live-state-changes']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TTY|terminal/i);
  assert.equal(fs.existsSync(fixture.calls), false);
});

test('journal cursor parser accepts one cursor and fails closed when unavailable or ambiguous', () => {
  const cursor = 's=0123456789abcdef;i=42;b=abcdef0123456789;m=123;t=456;x=789';
  const parsed = childProcess.spawnSync(executable, ['--test-parse-journal-cursor'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: `-- cursor: ${cursor}\n`,
  });
  const missing = childProcess.spawnSync(executable, ['--test-parse-journal-cursor'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'journal has no cursor\n',
  });
  const duplicate = childProcess.spawnSync(executable, ['--test-parse-journal-cursor'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: `-- cursor: ${cursor}\n-- cursor: ${cursor}\n`,
  });

  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, `${cursor}\n`);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, '');
});

test('journal cursor command suppresses the no-entries banner before parsing', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const command = source.match(/^\s+journal_cursor_remote='([^']+)'$/m);
  assert.ok(command, 'journal cursor command is defined');
  const cursor = 's=0123456789abcdef;i=42;b=abcdef0123456789;m=123;t=456;x=789';
  const captured = childProcess.spawnSync('bash', ['-c', `
    journalctl() {
      local quiet=false
      for arg in "$@"; do
        case "$arg" in --quiet|-q) quiet=true ;; esac
      done
      if [[ "$quiet" != true ]]; then
        printf '%s\\n' '-- No entries --'
      fi
      printf '%s\\n' '-- cursor: ${cursor}'
    }
    ${command[1]}
  `], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(captured.status, 0, captured.stderr);

  const parsed = childProcess.spawnSync(executable, ['--test-parse-journal-cursor'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: captured.stdout,
  });

  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, `${cursor}\n`);
  assert.equal(captured.stdout, `-- cursor: ${cursor}\n`);
});

test('expected-failure classifiers accept journal-only diagnostics with empty command output', () => {
  const host = 'mac-builder.tuxedo-musical.ts.net';
  const cases = [
    {
      expectation: 'failure',
      diagnostic: `Warning: Identity file /run/secrets/build-client-key not accessible: No such file or directory.\nnix-builder@${host}: Permission denied (publickey).\n`,
      output: 'EXPECTED_FAILURE',
    },
    {
      expectation: 'client-key-failure',
      diagnostic: `nix-builder@${host}: Permission denied (publickey).\n`,
      output: 'CLIENT_KEY_REJECTED',
    },
    {
      expectation: 'host-key-failure',
      diagnostic: `Host key verification failed for ${host}.\n`,
      output: 'HOST_KEY_MISMATCH',
    },
    {
      expectation: 'acl-failure',
      diagnostic: `ssh: connect to host ${host} port 22: Connection timed out\n`,
      output: 'ACL_TRANSPORT_FAILURE',
    },
  ];

  for (const { expectation, diagnostic, output } of cases) {
    const result = childProcess.spawnSync(executable, [
      '--classify-journal-probe', expectation, host,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: diagnostic,
    });

    assert.equal(result.status, 0, `${expectation}: ${result.stderr}`);
    assert.equal(result.stdout, `${output}\n`);
    assert.equal(result.stdout.includes(diagnostic), false);
  }
});

test('journal cursor and classifier plumbing is limited to expected-failure probes', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const probe = source.slice(source.indexOf('    run_probe() {'), source.indexOf('\n    if [[ "$restore_only"'));
  const journalCapture = source.slice(source.indexOf('    journal_cursor_remote='), source.indexOf('    backup_path()'));
  const cursor = probe.indexOf('journal_cursor="$(capture_journal_cursor)"');
  const dispatch = probe.indexOf('remote_root_script "$guest_name" "$remote_script"');
  const fetch = probe.indexOf('fetch_journal_after_cursor "$journal_cursor"');
  const commandOnly = probe.indexOf('diagnostics="$(<"$tmp_output")"');

  assert.match(journalCapture, /journalctl --unit=nix-daemon\.service --lines=0 --show-cursor --no-pager/);
  assert.match(journalCapture, /journalctl --unit=nix-daemon\.service --after-cursor="\$1" --output=cat --no-pager/);
  assert.ok(cursor >= 0 && cursor < dispatch);
  assert.ok(fetch > dispatch && fetch < commandOnly);
  assert.match(probe, /if is_expected_failure "\$expectation"/);
  assert.match(probe, /expected_failure_matches (?:acl-failure|client-key-failure|host-key-failure|failure)/);
  assert.ok(commandOnly > fetch);
  assert.match(probe.slice(commandOnly - 35, commandOnly + 80), /else\s+diagnostics="\$\(<"\$tmp_output"\)"/);
  assert.match(source, /chmod 0600 "\$tmp_output"[\s\S]*?chmod 0600 "\$tmp_journal"/);
  assert.match(source, /rm -f -- "\$tmp_journal"/);
});

test('ACL diagnostic classifier rejects SSH authentication failure naming the builder', () => {
  const result = childProcess.spawnSync(executable, [
    '--classify-acl-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host mac-builder.tuxedo-musical.ts.net port 22: Permission denied (publickey).\n',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'NOT_ACL_TRANSPORT_FAILURE\n');
});

test('ACL diagnostic classifier accepts a transport failure naming the builder', () => {
  const result = childProcess.spawnSync(executable, [
    '--classify-acl-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host mac-builder.tuxedo-musical.ts.net port 22: Connection timed out\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ACL_TRANSPORT_FAILURE\n');
});

test('client-key diagnostic classifier accepts only a builder-named public-key rejection', () => {
  const accepted = childProcess.spawnSync(executable, [
    '--classify-client-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host mac-builder.tuxedo-musical.ts.net: Permission denied (publickey).\n',
  });
  const transport = childProcess.spawnSync(executable, [
    '--classify-client-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host mac-builder.tuxedo-musical.ts.net port 22: Connection timed out\n',
  });
  const wrongHost = childProcess.spawnSync(executable, [
    '--classify-client-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host other-builder: Permission denied (publickey).\n',
  });
  const genericAuthentication = childProcess.spawnSync(executable, [
    '--classify-client-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'ssh: connect to host mac-builder.tuxedo-musical.ts.net: No more authentication methods to try.\n',
  });

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'CLIENT_KEY_REJECTED\n');
  assert.equal(transport.status, 1);
  assert.equal(wrongHost.status, 1);
  assert.equal(genericAuthentication.status, 1);
  assert.equal(genericAuthentication.stdout, 'NOT_CLIENT_KEY_REJECTION\n');
});

test('host-key diagnostic classifier accepts only a builder-named host-key mismatch', () => {
  const accepted = childProcess.spawnSync(executable, [
    '--classify-host-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'Host key verification failed for mac-builder.tuxedo-musical.ts.net.\n',
  });
  const authFailure = childProcess.spawnSync(executable, [
    '--classify-host-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'Permission denied (publickey) for mac-builder.tuxedo-musical.ts.net.\n',
  });
  const wrongHost = childProcess.spawnSync(executable, [
    '--classify-host-key-probe', 'mac-builder.tuxedo-musical.ts.net',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: 'Host key verification failed for other-builder.\n',
  });

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'HOST_KEY_MISMATCH\n');
  assert.equal(authFailure.status, 1);
  assert.equal(wrongHost.status, 1);
});

test('machines override changes one field and restores from its same-directory backup', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-override-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);

  const clientKeyOverride = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const alteredClientLine = fs.readFileSync(machines, 'utf8');
  const clientFields = alteredClientLine.trim().split(/\s+/);
  const originalFields = original.trim().split(/\s+/);
  const backup = `${machines}.fabro-live-failure-validation-backup`;
  const variant = `${machines}.fabro-live-failure-validation-override`;

  assert.equal(clientKeyOverride.status, 0, clientKeyOverride.stderr);
  assert.equal(clientFields[2], '/dev/null');
  assert.equal(Buffer.from(originalFields[7], 'base64').toString(), pinnedHostKeyText);
  clientFields[2] = originalFields[2];
  assert.deepEqual(clientFields, originalFields);
  assert.equal(alteredClientLine, original.replace('/run/secrets/build-client-key', '/dev/null'));
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.equal(fs.readFileSync(variant, 'utf8'), alteredClientLine);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);

  const clientRestore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(clientRestore.status, 0, clientRestore.stderr);
  assert.equal(fs.readFileSync(machines, 'utf8'), original);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(variant), false);

  const hostKeyOverride = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'host-key', testHostKey,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(hostKeyOverride.status, 0, hostKeyOverride.stderr);
  const hostFields = fs.readFileSync(machines, 'utf8').trim().split(/\s+/);
  assert.equal(hostFields[7], testHostKey);
  assert.notEqual(hostFields[7], originalFields[7]);
  assert.equal(Buffer.from(hostFields[7], 'base64').toString(), testHostKeyText);
  hostFields[7] = originalFields[7];
  assert.deepEqual(hostFields, originalFields);
  assert.equal(fs.readFileSync(machines, 'utf8'), original.replace(pinnedHostKey, testHostKey));

  const hostRestore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(hostRestore.status, 0, hostRestore.stderr);
  assert.equal(fs.readFileSync(machines, 'utf8'), original);
});

test('machines test modes reject a production path before mutation', () => {
  const productionPath = `/run/fabro-machines-unsafe-${process.pid}`;
  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', productionPath, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', productionPath,
  ], { cwd: repoRoot, encoding: 'utf8' });
  const overriddenTmpdir = childProcess.spawnSync(executable, [
    '--test-machines-override', productionPath, 'client-key', '/dev/null',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: '/run' },
  });

  assert.notEqual(override.status, 0);
  assert.match(override.stderr, /temporary fixture|TMPDIR/i);
  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /temporary fixture|TMPDIR/i);
  assert.notEqual(overriddenTmpdir.status, 0);
  assert.match(overriddenTmpdir.stderr, /temporary directory|TMPDIR/i);
  assert.equal(fs.existsSync(productionPath), false);
  assert.equal(fs.existsSync(`${productionPath}.fabro-live-failure-validation-backup`), false);
});

test('machines restore recreates an absent source from its validated helper artifacts', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-absent-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);

  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(override.status, 0, override.stderr);
  fs.unlinkSync(machines);

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(fs.readFileSync(machines, 'utf8'), original);
  assert.equal(fs.existsSync(`${machines}.fabro-live-failure-validation-backup`), false);
  assert.equal(fs.existsSync(`${machines}.fabro-live-failure-validation-override`), false);
});

test('machines restore recovers an interrupted override with its original staged in the transaction directory', () => {
  const fixture = interruptedMachinesFixture();
  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', fixture.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(fs.readFileSync(fixture.machines, 'utf8'), fixture.original);
  assert.equal(fs.statSync(fixture.machines).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(fixture.backup), false);
  assert.equal(fs.existsSync(fixture.variant), false);
  assert.equal(fs.existsSync(fixture.stage), false);
  assert.deepEqual(fs.readdirSync(fixture.directory), ['fabro-machines-fixture']);
});

test('machines restore preserves an unexpected source and all recovery artifacts', () => {
  const fixture = interruptedMachinesFixture();
  const unexpected = fixture.original.replace('/run/secrets/build-client-key', '/tmp/operator-edit');
  fs.writeFileSync(fixture.machines, unexpected, { mode: 0o600 });
  fs.chmodSync(fixture.machines, 0o600);

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', fixture.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /unexpected source|differs from both|refusing to overwrite/i);
  assert.equal(fs.readFileSync(fixture.machines, 'utf8'), unexpected);
  assert.equal(fs.readFileSync(fixture.backup, 'utf8'), fixture.original);
  assert.equal(fs.readFileSync(fixture.stagedOriginal, 'utf8'), fixture.original);
  assert.equal(fs.existsSync(fixture.variant), true);
  assert.equal(fs.existsSync(fixture.stage), true);
});

test('machines restore refuses a staged file that matches neither original nor exact variant', () => {
  const fixture = interruptedMachinesFixture();
  const unexpected = fixture.original.replace('/run/secrets/build-client-key', '/tmp/staged-edit');
  fs.writeFileSync(fixture.stagedOriginal, unexpected, { mode: 0o600 });
  fs.chmodSync(fixture.stagedOriginal, 0o600);

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', fixture.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /staged.*differs|staged.*neither|unexpected staged/i);
  assert.equal(fs.existsSync(fixture.machines), false);
  assert.equal(fs.readFileSync(fixture.backup, 'utf8'), fixture.original);
  assert.equal(fs.readFileSync(fixture.stagedOriginal, 'utf8'), unexpected);
  assert.equal(fs.existsSync(fixture.variant), true);
  assert.equal(fs.existsSync(fixture.stage), true);
});

test('machines restore refuses malformed staging directory names and unknown children', () => {
  const badName = interruptedMachinesFixture({ stageSuffix: 'manual-recovery' });
  const badNameRestore = childProcess.spawnSync(executable, [
    '--test-machines-restore', badName.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.notEqual(badNameRestore.status, 0);
  assert.match(badNameRestore.stderr, /staging.*name|invalid.*staging/i);
  assert.equal(fs.readFileSync(badName.stagedOriginal, 'utf8'), badName.original);
  assert.equal(fs.readFileSync(badName.backup, 'utf8'), badName.original);

  const unknownChild = interruptedMachinesFixture();
  const unexpectedChild = path.join(unknownChild.stage, 'operator-notes');
  fs.writeFileSync(unexpectedChild, 'preserve me');
  const unknownChildRestore = childProcess.spawnSync(executable, [
    '--test-machines-restore', unknownChild.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.notEqual(unknownChildRestore.status, 0);
  assert.match(unknownChildRestore.stderr, /unexpected staging.*child|unsupported staging.*entry/i);
  assert.equal(fs.readFileSync(unexpectedChild, 'utf8'), 'preserve me');
  assert.equal(fs.readFileSync(unknownChild.stagedOriginal, 'utf8'), unknownChild.original);
  assert.equal(fs.readFileSync(unknownChild.backup, 'utf8'), unknownChild.original);
});

test('machines restore refuses symlinked staging children without following or cleaning them', () => {
  const fixture = interruptedMachinesFixture();
  fs.unlinkSync(fixture.stagedOriginal);
  fs.symlinkSync(fixture.backup, fixture.stagedOriginal);

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', fixture.machines,
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /staging child.*regular non-symlink|symlink/i);
  assert.equal(fs.lstatSync(fixture.stagedOriginal).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(fixture.backup, 'utf8'), fixture.original);
  assert.equal(fs.existsSync(fixture.variant), true);
  assert.equal(fs.existsSync(fixture.stage), true);
});

test('machines restore preserves a target that reappears at the no-clobber install', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-reappeared-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  const unexpected = original.replace('/run/secrets/build-client-key', '/tmp/concurrent-edit');
  const marker = path.join(directory, 'reappearance-injected');
  const bashEnv = path.join(directory, 'inject-reappeared-target.bash');
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);
  fs.writeFileSync(bashEnv, [
    'ln() {',
    '  if [[ "$#" -eq 4 && "$1" == "-T" && "$2" == "--" && "$4" == "$FABRO_TEST_REAPPEAR_TARGET" && ! -e "$FABRO_TEST_REAPPEAR_MARKER" ]]; then',
    '    printf "%s" "$FABRO_TEST_REAPPEAR_CONTENT" > "$FABRO_TEST_REAPPEAR_TARGET"',
    '    : > "$FABRO_TEST_REAPPEAR_MARKER"',
    '  fi',
    '  command ln "$@"',
    '}',
    '',
  ].join('\n'), { mode: 0o600 });

  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(override.status, 0, override.stderr);
  fs.unlinkSync(machines);

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: bashEnv,
      FABRO_TEST_REAPPEAR_TARGET: machines,
      FABRO_TEST_REAPPEAR_CONTENT: unexpected,
      FABRO_TEST_REAPPEAR_MARKER: marker,
    },
  });

  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /reappeared|manual recovery/i);
  assert.equal(fs.readFileSync(machines, 'utf8'), unexpected);
  assert.equal(fs.readFileSync(`${machines}.fabro-live-failure-validation-backup`, 'utf8'), original);
  assert.equal(fs.existsSync(`${machines}.fabro-live-failure-validation-override`), true);
  assert.equal(fs.existsSync(marker), true);
  assert.ok(fs.readdirSync(directory).some(file => file.startsWith('fabro-machines-fixture.fabro-live-failure-validation-stage.')));
});

test('machines restore refuses a changed source reappearing after disappearance', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-conflict-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  const unexpected = `${original.replace('/run/secrets/build-client-key', '/tmp/operator-edit')}`;
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);

  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(override.status, 0, override.stderr);
  fs.unlinkSync(machines);
  fs.writeFileSync(machines, unexpected, { mode: 0o600 });

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /refus|unexpected|changed/i);
  assert.equal(fs.readFileSync(machines, 'utf8'), unexpected);
  assert.equal(fs.readFileSync(`${machines}.fabro-live-failure-validation-backup`, 'utf8'), original);
  assert.equal(fs.existsSync(`${machines}.fabro-live-failure-validation-override`), true);
});

test('machines override and restore install with atomic no-clobber links', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const overrideRemote = source.slice(source.indexOf("machines_override_remote=\"$(cat <<'MACHINES_OVERRIDE'"), source.indexOf('MACHINES_OVERRIDE\n    )"'));
  const restoreRemote = source.slice(source.indexOf("machines_restore_remote=\"$(cat <<'MACHINES_RESTORE'"), source.indexOf('MACHINES_RESTORE\n    )"'));

  assert.match(overrideRemote, /ln -T -- "\$install_temp" "\$machine_file"/);
  assert.match(restoreRemote, /ln -T -- "\$restore_temp" "\$machine_file"/);
  assert.doesNotMatch(overrideRemote, /mv -f/);
  assert.doesNotMatch(restoreRemote, /mv -f/);
});

test('machines restore refuses a changed helper override marker', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fabro-machines-marker-conflict-'));
  const machines = path.join(directory, 'fabro-machines-fixture');
  const original = `ssh-ng://builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 1 1 - - ${pinnedHostKey}\n`;
  fs.writeFileSync(machines, original, { mode: 0o600 });
  fs.chmodSync(machines, 0o600);

  const override = childProcess.spawnSync(executable, [
    '--test-machines-override', machines, 'client-key', '/dev/null',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(override.status, 0, override.stderr);
  const variant = `${machines}.fabro-live-failure-validation-override`;
  const expectedOverride = fs.readFileSync(variant, 'utf8');
  fs.writeFileSync(variant, expectedOverride.replace('/dev/null', '/tmp/not-helper-generated'), { mode: 0o600 });

  const restore = childProcess.spawnSync(executable, [
    '--test-machines-restore', machines,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /exact helper-generated test variants/i);
  assert.equal(fs.readFileSync(machines, 'utf8'), expectedOverride);
  assert.equal(fs.existsSync(`${machines}.fabro-live-failure-validation-backup`), true);
});

test('builder non-Running classifier distinguishes logged-out and Running states', () => {
  const loggedOut = childProcess.spawnSync(executable, ['--check-builder-not-running'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ BackendState: 'NeedsLogin' }),
  });
  const running = childProcess.spawnSync(executable, ['--check-builder-not-running'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ BackendState: 'Running' }),
  });
  const invalidStates = [
    '{}',
    JSON.stringify({ BackendState: null }),
    JSON.stringify({ BackendState: '' }),
    JSON.stringify({ BackendState: 7 }),
    JSON.stringify({ BackendState: {} }),
  ].map(input => childProcess.spawnSync(executable, ['--check-builder-not-running'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
  }));

  assert.equal(loggedOut.status, 0, loggedOut.stderr);
  assert.equal(loggedOut.stdout, 'BUILDER_NOT_RUNNING\n');
  assert.equal(running.status, 1);
  for (const invalid of invalidStates) {
    assert.equal(invalid.status, 1, `unexpectedly accepted invalid state: ${invalid.stdout}`);
    assert.equal(invalid.stdout, 'BUILDER_STILL_RUNNING\n');
  }
});

test('test directory package metadata does not hide test discovery behind one main file', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const discoverySource = fs.readFileSync(path.join(__dirname, 'test-discovery.js'), 'utf8');
  const testFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js'));

  assert.equal(packageJson.main, 'test-discovery.js');
  assert.match(discoverySource, /name\.endsWith\('\.test\.js'\)/);
  assert.match(discoverySource, /require\(path\.join\(__dirname, file\)\)/);
  assert.ok(testFiles.length > 1);
});

test('OAuth probe logs out while hidden before its fresh auth-log baseline', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const oauthFlow = source.slice(source.indexOf("confirm_step 'Temporarily hide the builder OAuth"));
  const hidden = oauthFlow.indexOf('hide_path_remote');
  const logout = oauthFlow.indexOf('tailscale logout');
  const nonRunning = oauthFlow.indexOf('builder_backend_not_running');
  const baseline = oauthFlow.indexOf('auth_log_start=');
  const wait = oauthFlow.indexOf('sleep 65');
  const logCheck = oauthFlow.indexOf('auth_log_result=');
  const restore = oauthFlow.indexOf('restore_backup "$builder_name" "$oauth_path"');
  const rejoin = oauthFlow.indexOf('builder_self_has_required_tag "$identity_json"');

  assert.ok(hidden >= 0 && hidden < logout);
  assert.ok(logout < nonRunning && nonRunning < baseline);
  assert.ok(baseline < wait && wait < logCheck && logCheck < restore && restore < rejoin);
  assert.match(oauthFlow, /BackendState.*Running|BackendState != Running|BackendState != "Running"/);
});

test('machines probes restore immediately and require unique recovery before clearing recovery state', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const clientFlow = source.slice(source.indexOf("confirm_step 'Temporarily point the guest machines client-key"), source.indexOf("confirm_step 'Temporarily replace the guest machines pinned host key"));
  const hostFlow = source.slice(source.indexOf("confirm_step 'Temporarily replace the guest machines pinned host key"), source.indexOf("confirm_step 'Temporarily hide the builder OAuth"));
  for (const flow of [clientFlow, hostFlow]) {
    const mutation = flow.indexOf('override_machines_file');
    const failedProbe = Math.max(flow.indexOf('run_probe client-key-failure'), flow.indexOf('run_probe host-key-failure'));
    const restore = flow.indexOf('restore_machines_file');
    const clearRecovery = flow.indexOf('machines_restore_pending=false', restore);
    const recovery = flow.indexOf('run_probe success');
    assert.ok(mutation >= 0 && mutation < failedProbe);
    assert.ok(failedProbe < restore && restore < clearRecovery && clearRecovery < recovery);
    assert.match(flow.slice(recovery), /run_probe success/);
  }
});

test('builder rejoin identity rejects a peer tag when the local builder is untagged', () => {
  const fixture = {
    status: {
      BackendState: 'Running',
      Self: { TailscaleIPs: ['100.100.100.10'] },
      Peer: {
        'node-key:peer': {
          HostName: 'another-builder',
          Tags: ['tag:nix-remote-builder'],
        },
      },
    },
    whois: {
      Node: {
        Name: 'mac-builder.tuxedo-musical.ts.net.',
        Addresses: ['100.100.100.10/32'],
        Tags: [],
      },
    },
  };
  const result = childProcess.spawnSync(executable, ['--check-builder-self-identity'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(fixture),
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'BUILDER_SELF_TAG_NOT_VERIFIED\n');
});

test('builder rejoin identity accepts the local mac-builder identity with the required tag', () => {
  const fixture = {
    status: {
      BackendState: 'Running',
      Self: { TailscaleIPs: ['100.100.100.10'] },
      Peer: {},
    },
    whois: {
      Node: {
        Name: 'mac-builder.tuxedo-musical.ts.net.',
        Addresses: ['100.100.100.10/32'],
        Tags: ['tag:nix-remote-builder'],
      },
    },
  };
  const result = childProcess.spawnSync(executable, ['--check-builder-self-identity'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'BUILDER_SELF_TAG_VERIFIED\n');
});

test('ACL denial remains active until the ACL recovery probe succeeds', () => {
  const source = fs.readFileSync(validatorSource, 'utf8');
  const aclFlow = source.slice(source.indexOf('    acl_denied_active=true'));
  const recoveryProbe = aclFlow.indexOf('run_probe success "" \'Guest ACL recovery probe\'');
  const clearActiveDenial = aclFlow.indexOf('acl_denied_active=false');

  assert.notEqual(recoveryProbe, -1);
  assert.notEqual(clearActiveDenial, -1);
  assert.ok(recoveryProbe < clearActiveDenial,
    'the ACL-denied flag must only clear after run_probe returns successfully');
});
