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
  fs.writeFileSync(clientKey, 'PRIVATE CLIENT KEY\n');
  fs.writeFileSync(hostKey, 'ssh-ed25519 AAAAhostkey builder\n');
  return { clientKey, hostKey };
}

function runRenderer(args) {
  return childProcess.spawnSync(renderer, args, { encoding: 'utf8' });
}

test('writes one pinned machines entry atomically with mode 0600', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { clientKey, hostKey } = makeInputs(directory);
  const output = path.join(directory, 'machines');

  const result = runRenderer([
    '--output', output,
    '--host-name', 'mac-builder.example.ts.net',
    '--ssh-user', 'nix-builder',
    '--system', 'aarch64-darwin',
    '--max-jobs', '4',
    '--speed-factor', '2',
    '--client-key', clientKey,
    '--host-key', hostKey,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    `ssh-ng://nix-builder@mac-builder.example.ts.net aarch64-darwin ${clientKey} 4 2 - - ${Buffer.from('ssh-ed25519 AAAAhostkey builder\n').toString('base64')}\n`,
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
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
      const result = runRenderer([
        '--output', output,
        '--host-name', 'mac-builder.example.ts.net',
        '--ssh-user', 'nix-builder',
        '--system', 'aarch64-darwin',
        '--max-jobs', '4',
        '--speed-factor', '2',
        '--client-key', inputs.clientKey,
        '--host-key', inputs.hostKey,
      ]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(pathArgument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing contents\n');
    });
  }
}
