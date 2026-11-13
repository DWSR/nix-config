'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function buildRenderer() {
  const output = childProcess.execFileSync(
    'nix',
    [
      'build',
      '--impure',
      '--no-link',
      '--print-out-paths',
      '--expr',
      `let
        flake = builtins.getFlake (toString ${repoRoot});
        pkgs = flake.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem};
      in pkgs.callPackage ./scripts/fabro-darwin-machines.nix {}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  return path.join(output.trim(), 'bin/fabro-darwin-machines');
}

const renderer = buildRenderer();

function makeInputs(directory) {
  const clientKey = path.join(directory, 'client-key');
  const hostKey = path.join(directory, 'host-key');
  const linuxClientKey = path.join(directory, 'linux-client-key');
  const linuxHostKey = path.join(directory, 'linux-host-key');
  const linuxPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n';
  fs.writeFileSync(clientKey, 'DARWIN PRIVATE CLIENT KEY\n');
  fs.writeFileSync(linuxClientKey, 'LINUX PRIVATE CLIENT KEY\n');
  fs.writeFileSync(hostKey, 'ssh-ed25519 AAAAhostkey darwin-builder\n');
  fs.writeFileSync(linuxHostKey, linuxPublicKey);
  return { clientKey, hostKey, linuxClientKey, linuxHostKey };
}

function rendererArguments({
  output,
  clientKey,
  hostKey,
  linuxClientKey,
  linuxHostKey,
  linuxHostName = 'linux-builder.tuxedo-musical.ts.net',
  linuxSystem = 'aarch64-linux',
  linuxMaxJobs = '4',
}) {
  return [
    '--output', output,
    '--host-name', 'mac-builder.example.ts.net',
    '--ssh-user', 'nix-builder',
    '--system', 'aarch64-darwin',
    '--max-jobs', '4',
    '--speed-factor', '2',
    '--client-key', clientKey,
    '--host-key', hostKey,
    '--linux-host-name', linuxHostName,
    '--linux-system', linuxSystem,
    '--linux-max-jobs', linuxMaxJobs,
    '--linux-client-key', linuxClientKey,
    '--linux-host-key', linuxHostKey,
  ];
}

function runRenderer(args) {
  return childProcess.spawnSync(renderer, args, { encoding: 'utf8' });
}

test('writes both pinned machine entries atomically with mode 0600', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');

  const result = runRenderer(rendererArguments({ output, ...inputs, linuxClientKey: '/run/secrets/build-client-key' }));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    `ssh-ng://nix-builder@mac-builder.example.ts.net aarch64-darwin ${inputs.clientKey} 4 2 - - ${Buffer.from(fs.readFileSync(inputs.hostKey)).toString('base64')}\nssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux /run/secrets/build-client-key 4 1 - - ${Buffer.from(fs.readFileSync(inputs.linuxHostKey)).toString('base64')}\n`,
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(output, 'utf8').includes('PRIVATE CLIENT KEY'));
});

for (const keyName of ['client-key', 'host-key']) {
  for (const state of ['missing', 'empty']) {
    test(`rejects ${state} ${keyName} without changing output`, (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const inputs = makeInputs(directory);
      const pathArgument = inputs[keyName === 'client-key' ? 'clientKey' : 'hostKey'];
      if (state === 'missing') fs.unlinkSync(pathArgument);
      else fs.writeFileSync(pathArgument, '');
      const output = path.join(directory, 'machines');
      fs.writeFileSync(output, 'existing contents\n');

      const result = runRenderer(rendererArguments({ output, ...inputs, linuxClientKey: '/run/secrets/build-client-key' }));

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(pathArgument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing contents\n');
    });
  }
}

for (const [option, value] of [
  ['--linux-host-name', ''],
  ['--linux-host-name', 'linux-builder.example.ts.net;touch'],
  ['--linux-host-name', 'linux-builder.example.ts.net'],
  ['--linux-system', 'aarch64-darwin'],
  ['--linux-max-jobs', '3'],
  ['--linux-client-key', 'relative-key'],
  ['--linux-client-key', '/tmp/linux-builder-client-key'],
  ['--linux-client-key', '/run/secrets/../../etc/key'],
  ['--linux-client-key', '/run/secrets//linux-builder-client-key'],
  ['--linux-client-key', '/run/secrets/../key'],
  ['--linux-client-key', '/nix/store/fake-client-key'],
]) {
  test(`rejects invalid Linux ${option} without replacing the prior output`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const inputs = makeInputs(directory);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');
    const args = rendererArguments({
      output,
      ...inputs,
      linuxClientKey: '/run/secrets/build-client-key',
      ...(option === '--linux-host-name' ? { linuxHostName: value } : {}),
      ...(option === '--linux-system' ? { linuxSystem: value } : {}),
      ...(option === '--linux-max-jobs' ? { linuxMaxJobs: value } : {}),
      ...(option === '--linux-client-key' ? { linuxClientKey: value } : {}),
    });
    if (value === '') args.splice(args.indexOf(option), 2);

    const result = runRenderer(args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /linux/i);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp.')), []);
  });
}

for (const option of ['--linux-host-name', '--linux-system', '--linux-max-jobs', '--linux-client-key', '--linux-host-key']) {
  test(`rejects a missing ${option} without replacing the prior output`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const inputs = makeInputs(directory);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');
    const args = rendererArguments({ output, ...inputs, linuxClientKey: '/run/secrets/build-client-key' });
    args.splice(args.indexOf(option), 2);

    const result = runRenderer(args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required/i);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp.')), []);
  });
}

test('rejects an invalid Ed25519 key-length header without replacing output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  const malformedBlob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 31]),
    Buffer.alloc(32, 1),
    Buffer.from([0]),
  ]).toString('base64');
  fs.writeFileSync(inputs.linuxHostKey, `ssh-ed25519 ${malformedBlob} linux-builder\n`);
  const output = path.join(directory, 'machines');
  fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');

  const result = runRenderer(rendererArguments({ output, ...inputs, linuxClientKey: '/run/secrets/build-client-key' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host key/i);
  assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
});

test('rejects malformed Linux public host-key data without replacing output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  fs.writeFileSync(inputs.linuxHostKey, 'ssh-ed25519 AAAA-not-a-valid-ed25519-key linux-builder\n');
  const output = path.join(directory, 'machines');
  fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');

  const result = runRenderer(rendererArguments({ output, ...inputs, linuxClientKey: '/run/secrets/build-client-key' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host key/i);
  assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
});

for (const linuxKeyName of ['linuxClientKey', 'linuxHostKey']) {
  test(`rejects missing Linux ${linuxKeyName} without replacing output`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const inputs = makeInputs(directory);
    fs.unlinkSync(inputs[linuxKeyName]);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');

    const result = runRenderer(rendererArguments({
      output,
      ...inputs,
      ...(linuxKeyName === 'linuxHostKey' ? { linuxClientKey: '/run/secrets/build-client-key' } : {}),
    }));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /linux|pinned/i);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
  });
}
