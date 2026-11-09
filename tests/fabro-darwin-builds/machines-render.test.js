'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const linuxDefaults = {
  hostName: 'linux-builder.tuxedo-musical.ts.net',
  sshUser: 'builder',
  system: 'aarch64-linux',
  maxJobs: '4',
  speedFactor: '1',
};
const linuxHostPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM linux-builder\n';

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
  const hostKey = path.join(directory, 'darwin-host-key');
  const linuxClientKey = '/run/secrets/linux-builder-client-key';
  const linuxHostKey = path.join(directory, 'ssh_host_ed25519_key.pub');
  const privatePinDirectory = path.join(directory, 'private-pin');
  fs.mkdirSync(privatePinDirectory);
  const linuxPrivateHostKey = path.join(privatePinDirectory, 'ssh_host_ed25519_key.pub');
  const linuxMalformedHostKey = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(clientKey, 'DARWIN PRIVATE CLIENT KEY POISON\n');
  fs.writeFileSync(hostKey, 'ssh-ed25519 AAAAhostkey darwin-builder\n');
  fs.writeFileSync(path.join(directory, 'linux-client-key-fixture'), 'LINUX PRIVATE CLIENT KEY POISON\n');
  fs.writeFileSync(linuxHostKey, linuxHostPublicKey);
  fs.writeFileSync(linuxPrivateHostKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE HOST KEY POISON\n');
  fs.writeFileSync(linuxMalformedHostKey, 'ssh-ed25519 not-a-valid-key linux-builder\n');
  return { clientKey, hostKey, linuxClientKey, linuxHostKey, linuxPrivateHostKey, linuxMalformedHostKey };
}

function rendererArgs(output, inputs, overrides = {}) {
  const linux = { ...linuxDefaults, ...overrides };
  const args = [
    '--output', output,
    '--host-name', 'mac-builder.example.ts.net',
    '--ssh-user', 'nix-builder',
    '--system', 'aarch64-darwin',
    '--max-jobs', '4',
    '--speed-factor', '2',
    '--client-key', inputs.clientKey,
    '--host-key', inputs.hostKey,
    '--linux-host-name', linux.hostName,
    '--linux-ssh-user', linux.sshUser,
    '--linux-system', linux.system,
    '--linux-max-jobs', linux.maxJobs,
    '--linux-speed-factor', linux.speedFactor,
    '--linux-client-key', linux.clientKey ?? inputs.linuxClientKey,
    '--linux-host-key', linux.hostKey ?? inputs.linuxHostKey,
  ];
  return args;
}

function runRenderer(args) {
  return childProcess.spawnSync(renderer, args, { encoding: 'utf8' });
}

function expectedDarwinLine(inputs) {
  return `ssh-ng://nix-builder@mac-builder.example.ts.net aarch64-darwin ${inputs.clientKey} 4 2 - - ${Buffer.from('ssh-ed25519 AAAAhostkey darwin-builder\n').toString('base64')}\n`;
}

function expectedLinuxLine(inputs) {
  return `ssh-ng://builder@${linuxDefaults.hostName} aarch64-linux ${inputs.linuxClientKey} 4 1 - - ${Buffer.from(linuxHostPublicKey).toString('base64')}\n`;
}

test('atomically writes the unchanged Darwin entry followed by the pinned Linux entry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');

  const result = runRenderer(rendererArgs(output, inputs));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), expectedDarwinLine(inputs) + expectedLinuxLine(inputs));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('machines.tmp.')));
  const contents = fs.readFileSync(output, 'utf8');
  assert.doesNotMatch(contents, /DARWIN PRIVATE CLIENT KEY POISON|LINUX PRIVATE CLIENT KEY POISON/);
});

for (const keyName of ['client-key', 'host-key']) {
  for (const state of ['missing', 'empty']) {
    test(`rejects ${state} Darwin ${keyName} without changing output`, (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const inputs = makeInputs(directory);
      const pathArgument = inputs[keyName === 'client-key' ? 'clientKey' : 'hostKey'];
      if (state === 'missing') fs.unlinkSync(pathArgument);
      else fs.writeFileSync(pathArgument, '');

      const output = path.join(directory, 'machines');
      fs.writeFileSync(output, 'prior complete output\n');
      const result = runRenderer(rendererArgs(output, inputs));

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(pathArgument), result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete output\n');
    });
  }
}

const invalidLinuxInputs = [
  ['wrong endpoint', { hostName: 'other-builder.example.ts.net' }],
  ['wrong SSH user', { sshUser: 'root' }],
  ['non-native system', { system: 'x86_64-linux' }],
  ['wrong job count', { maxJobs: '3' }],
  ['wrong speed factor', { speedFactor: '2' }],
  ['relative runtime key path', { clientKey: 'run/secrets/linux-builder-client-key' }],
  ['wrong runtime directory', { clientKey: '/tmp/linux-builder-client-key' }],
  ['store key path', { clientKey: '/nix/store/private-key' }],
  ['missing runtime key', { clientKey: '/tmp/fabro-machines-missing-key' }],
  ['missing public host-key pin', { hostKey: '/tmp/fabro-machines-missing-host-key.pub' }],
];

for (const [name, overrides] of invalidLinuxInputs) {
  test(`rejects ${name} without replacing the prior complete output`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const inputs = makeInputs(directory);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete output\n');

    const result = runRenderer(rendererArgs(output, inputs, overrides));

    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete output\n');
  });
}

test('rejects malformed or private Linux host-key material without leaking it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');
  fs.writeFileSync(output, 'prior complete output\n');

  for (const hostKey of [inputs.linuxPrivateHostKey, inputs.linuxMalformedHostKey]) {
    const result = runRenderer(rendererArgs(output, inputs, { hostKey }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /BEGIN OPENSSH PRIVATE KEY|PRIVATE CLIENT KEY POISON/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete output\n');
  }
});

test('requires every Linux record input before touching the output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');
  fs.writeFileSync(output, 'prior complete output\n');
  const completeArgs = rendererArgs(output, inputs);
  const linuxOptions = [
    '--linux-host-name', '--linux-ssh-user', '--linux-system', '--linux-max-jobs',
    '--linux-speed-factor', '--linux-client-key', '--linux-host-key',
  ];

  for (const option of linuxOptions) {
    const args = [...completeArgs];
    args.splice(args.indexOf(option), 2);
    const result = runRenderer(args);
    assert.notEqual(result.status, 0, `${option} unexpectedly optional`);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete output\n');
  }
});
