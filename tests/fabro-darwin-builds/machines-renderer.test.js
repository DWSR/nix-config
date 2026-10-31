'use strict';

// Behaviour tests for `scripts/fabro-darwin-machines.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 1.1; design "Component
// Contracts → Guest Dispatch → `fabro-darwin-machines`"; requirements 3.2,
// 6.1, 6.2, 6.6, 6.7, 6.12).
//
// The renderer turns the two runtime secrets into the single machines-file line
// the guest's nix-daemon reads. Every case drives the built script against a
// temp directory, so the assertions cover the artifact the unit actually runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

let cachedRendererBin = null;

function buildRendererBin() {
  if (cachedRendererBin) return cachedRendererBin;
  const expr = `let flake = builtins.getFlake (toString ${repoRoot}); pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage ${repoRoot}/scripts/fabro-darwin-machines.nix { }`;
  const out = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim().split('\n').pop();
  cachedRendererBin = path.join(out, 'bin', 'fabro-darwin-machines');
  return cachedRendererBin;
}

function makeWorkspace({ clientKey = 'CLIENT-KEY-CONTENT\n', hostKey = 'ssh-ed25519 AAAAHOSTKEY test@mac-builder\n', omitClientKey = false, omitHostKey = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-darwin-machines-'));
  const clientKeyPath = path.join(dir, 'build-client-key');
  const hostKeyPath = path.join(dir, 'build-host-key');
  const outputPath = path.join(dir, 'machines');
  if (!omitClientKey) fs.writeFileSync(clientKeyPath, clientKey);
  if (!omitHostKey) fs.writeFileSync(hostKeyPath, hostKey);
  return { dir, clientKeyPath, hostKeyPath, outputPath };
}

function renderArgs(workspace, overrides = {}) {
  const values = {
    '--output': workspace.outputPath,
    '--host-name': 'mac-builder.tuxedo-musical.ts.net',
    '--ssh-user': 'nix-builder',
    '--system': 'aarch64-darwin',
    '--max-jobs': '4',
    '--speed-factor': '2',
    '--client-key': workspace.clientKeyPath,
    '--host-key': workspace.hostKeyPath,
    ...overrides,
  };
  const args = [];
  for (const [flag, value] of Object.entries(values)) {
    if (value === undefined) continue;
    args.push(flag, value);
  }
  return args;
}

function runRenderer(args) {
  return childProcess.spawnSync(buildRendererBin(), args, {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  });
}

function base64OfFile(file) {
  return Buffer.from(fs.readFileSync(file)).toString('base64');
}

test('renderer writes the exact single machines line with mode 0600', () => {
  const workspace = makeWorkspace();
  const result = runRenderer(renderArgs(workspace));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const expected = [
    'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net',
    'aarch64-darwin',
    workspace.clientKeyPath,
    '4',
    '2',
    '-',
    '-',
    base64OfFile(workspace.hostKeyPath),
  ].join(' ');

  const contents = fs.readFileSync(workspace.outputPath, 'utf8');
  assert.equal(contents, `${expected}\n`);
  assert.equal(contents.trimEnd().split('\n').length, 1, 'expected exactly one line');
  assert.equal(fs.statSync(workspace.outputPath).mode & 0o777, 0o600);
});

test('renderer leaves the machines file owned by root when run as root', (t) => {
  if (process.getuid?.() !== 0) {
    t.skip('requires root, as the systemd unit runs the renderer');
    return;
  }
  const workspace = makeWorkspace();
  const result = runRenderer(renderArgs(workspace));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const stats = fs.statSync(workspace.outputPath);
  assert.equal(stats.uid, 0);
  assert.equal(stats.gid, 0);
});

test('renderer references the client key by path and never its contents', () => {
  const clientKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nSUPERSECRET\n';
  const workspace = makeWorkspace({ clientKey });
  const result = runRenderer(renderArgs(workspace));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const contents = fs.readFileSync(workspace.outputPath, 'utf8');
  assert.ok(contents.includes(workspace.clientKeyPath));
  assert.ok(!contents.includes('SUPERSECRET'));
  assert.ok(!contents.includes('BEGIN OPENSSH'));
});

test('renderer pins the host key value and never falls back to a dash', () => {
  const workspace = makeWorkspace();
  const result = runRenderer(renderArgs(workspace));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const fields = fs.readFileSync(workspace.outputPath, 'utf8').trimEnd().split(' ');
  assert.equal(fields.length, 8);
  assert.equal(fields[5], '-');
  assert.equal(fields[6], '-');
  assert.notEqual(fields[7], '-');
  assert.equal(fields[7], base64OfFile(workspace.hostKeyPath));
});

test('missing client key fails naming the path and leaves the output unchanged', () => {
  const workspace = makeWorkspace({ omitClientKey: true });
  fs.writeFileSync(workspace.outputPath, 'previous\n');
  const result = runRenderer(renderArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(workspace.clientKeyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(workspace.outputPath, 'utf8'), 'previous\n');
});

test('empty client key fails naming the path and leaves the output unchanged', () => {
  const workspace = makeWorkspace({ clientKey: '' });
  fs.writeFileSync(workspace.outputPath, 'previous\n');
  const result = runRenderer(renderArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(workspace.clientKeyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(workspace.outputPath, 'utf8'), 'previous\n');
});

test('missing host key fails naming the path and leaves the output unchanged', () => {
  const workspace = makeWorkspace({ omitHostKey: true });
  fs.writeFileSync(workspace.outputPath, 'previous\n');
  const result = runRenderer(renderArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(workspace.hostKeyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(workspace.outputPath, 'utf8'), 'previous\n');
});

test('empty host key fails naming the path and leaves the output unchanged', () => {
  const workspace = makeWorkspace({ hostKey: '' });
  fs.writeFileSync(workspace.outputPath, 'previous\n');
  const result = runRenderer(renderArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(workspace.hostKeyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(workspace.outputPath, 'utf8'), 'previous\n');
});

test('failed render creates no output file when none existed', () => {
  const workspace = makeWorkspace({ omitHostKey: true });
  const result = runRenderer(renderArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(workspace.outputPath), false);
});

test('renderer rejects a missing argument instead of emitting a partial line', () => {
  const workspace = makeWorkspace();
  const result = runRenderer(renderArgs(workspace, { '--host-name': undefined }));

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(workspace.outputPath), false);
});
