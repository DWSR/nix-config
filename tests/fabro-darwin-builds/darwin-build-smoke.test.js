'use strict';

// Behaviour tests for `scripts/fabro-darwin-build-smoke.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 5.1; design "Component
// Contracts → Verification → `fabro-darwin-build-smoke`"; requirements 6.12,
// 8.5, 8.6, 8.7).
//
// The smoke proves the sandbox → guest daemon → builder path. Each case
// drives the built script against a stub `podman`, so the assertions cover the
// artifact the guest installs rather than the shell source: preflight names
// missing material, a successful run prints every step banner and the store
// path, and a failed step returns non-zero.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-darwin-build-smoke-'));
const paths = {
  clientKey: path.join(workspace, 'build-client-key'),
  hostKey: path.join(workspace, 'build-host-key'),
  machines: path.join(workspace, 'machines'),
  digest: path.join(workspace, 'digest'),
  storeOutput: path.join(workspace, 'store-output'),
  podmanLog: path.join(workspace, 'podman.log'),
};

const MACHINES_LINE =
  'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ' +
  '/run/secrets/build-client-key 4 2 - - AAAAHOSTKEY';

let cachedSmokeBin = null;

function buildSmokeBin() {
  if (cachedSmokeBin) return cachedSmokeBin;

  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  stubPodman = pkgs.writeShellScriptBin "podman" ''
    set -eu
    printf '%s\\n' "$*" | tr '\\n' ' ' >> "$STUB_LOG"
    printf '\\n' >> "$STUB_LOG"
    if [ "$STUB_FAIL" = "1" ]; then
      exit 1
    fi
    printf '%s\\n' "$STUB_STORE_PATH"
  '';
in
pkgs.callPackage ${repoRoot}/scripts/fabro-darwin-build-smoke.nix {
  name = "localhost/fabro-sandbox";
  clientKeyPath = ${JSON.stringify(paths.clientKey)};
  hostKeyPath = ${JSON.stringify(paths.hostKey)};
  machinesFile = ${JSON.stringify(paths.machines)};
  digestFile = ${JSON.stringify(paths.digest)};
  targetSystem = "aarch64-darwin";
  podman = stubPodman;
}
`;

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

  cachedSmokeBin = path.join(out, 'bin', 'fabro-darwin-build-smoke');
  return cachedSmokeBin;
}

function resetWorkspace() {
  fs.writeFileSync(paths.clientKey, 'CLIENT-KEY-CONTENT\n');
  fs.writeFileSync(paths.hostKey, 'ssh-ed25519 AAAAHOSTKEY test@mac-builder\n');
  fs.writeFileSync(paths.machines, `${MACHINES_LINE}\n`);
  fs.writeFileSync(paths.digest, 'sha256:defaultdigest\n');
  fs.writeFileSync(paths.storeOutput, 'ok\n');
  fs.rmSync(paths.podmanLog, { force: true });
}

function runSmoke(args = [], env = {}) {
  assert.ok(fs.existsSync(buildSmokeBin()), 'the smoke binary must be built');
  return childProcess.spawnSync(buildSmokeBin(), args, {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: {
      ...process.env,
      STUB_LOG: paths.podmanLog,
      STUB_STORE_PATH: paths.storeOutput,
      STUB_FAIL: '',
      ...env,
    },
  });
}

function podmanCalls() {
  if (!fs.existsSync(paths.podmanLog)) return [];
  return fs
    .readFileSync(paths.podmanLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.beforeEach(resetWorkspace);

test('a missing Build Client Key fails preflight naming the path', () => {
  fs.rmSync(paths.clientKey);
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[preflight\]/);
  assert.match(output(result), new RegExp(escapeRegExp(paths.clientKey)));
  assert.deepEqual(podmanCalls(), [], 'preflight must fail before any sandbox runs');
});

test('an empty Build Client Key fails preflight naming the path', () => {
  fs.writeFileSync(paths.clientKey, '');
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), new RegExp(escapeRegExp(paths.clientKey)));
  assert.deepEqual(podmanCalls(), []);
});

test('a missing pinned Builder Host Key fails preflight naming the path', () => {
  fs.rmSync(paths.hostKey);
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[preflight\]/);
  assert.match(output(result), new RegExp(escapeRegExp(paths.hostKey)));
  assert.deepEqual(podmanCalls(), []);
});

test('a missing machines file fails preflight naming the path', () => {
  fs.rmSync(paths.machines);
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), new RegExp(escapeRegExp(paths.machines)));
  assert.deepEqual(podmanCalls(), []);
});

test('a machines file without an aarch64-darwin entry fails preflight', () => {
  fs.writeFileSync(
    paths.machines,
    'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-linux /run/secrets/build-client-key 4 2 - - AAAA\n',
  );
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[preflight\]/);
  assert.match(output(result), new RegExp(escapeRegExp(paths.machines)));
  assert.deepEqual(podmanCalls(), [], 'a wrong-system machines file must not reach the build step');
});

test('a successful run prints every step banner and the store path', () => {
  const ref = 'localhost/fabro-sandbox@sha256:explicit';
  const result = runSmoke([ref]);

  assert.equal(result.status, 0, output(result));
  for (const step of ['preflight', 'build', 'report']) {
    assert.match(result.stdout, new RegExp(`\\[${step}\\]`), `missing the ${step} banner`);
  }
  assert.ok(result.stdout.includes(paths.storeOutput), 'the store path must be reported');

  const calls = podmanCalls();
  assert.equal(calls.length, 1, `expected one podman invocation, got: ${calls.join(' | ')}`);
  assert.ok(calls[0].includes(`run --rm ${ref} /bin/bash -c`), calls[0]);
  assert.ok(calls[0].includes('nix build'), 'the sandbox must run nix build');
  assert.ok(calls[0].includes('--print-out-paths'), 'the build must print its store path');
  assert.ok(calls[0].includes('derivation'), 'the request must be a trivial derivation');
  assert.ok(calls[0].includes('aarch64-darwin'), 'the derivation must target aarch64-darwin');
  assert.ok(calls[0].includes('builder = "/bin/sh"'), 'the derivation must use /bin/sh as builder');
  assert.ok(calls[0].includes('echo ok > $out'), 'the derivation must write the single output file');
});

test('without an argument the image reference defaults to name@digest', () => {
  const result = runSmoke();

  assert.equal(result.status, 0, output(result));
  const calls = podmanCalls();
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].includes('run --rm localhost/fabro-sandbox@sha256:defaultdigest /bin/bash -c'),
    calls[0],
  );
});

test('a missing digest file fails the build step naming the path', () => {
  fs.rmSync(paths.digest);
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[build\]/);
  assert.match(output(result), new RegExp(escapeRegExp(paths.digest)));
  assert.deepEqual(podmanCalls(), []);
});

test('an empty digest file fails the build step naming the path', () => {
  fs.writeFileSync(paths.digest, '');
  const result = runSmoke();

  assert.notEqual(result.status, 0);
  assert.match(output(result), new RegExp(escapeRegExp(paths.digest)));
  assert.deepEqual(podmanCalls(), []);
});

test('a failed sandbox build names the build step and returns non-zero', () => {
  const result = runSmoke([], { STUB_FAIL: '1' });

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[build\]/);
  assert.match(output(result), /failed/);
});

test('a store path absent from the guest store fails the report step', () => {
  const result = runSmoke([], { STUB_STORE_PATH: path.join(workspace, 'absent-store-path') });

  assert.notEqual(result.status, 0);
  assert.match(output(result), /\[report\]/);
  assert.match(output(result), new RegExp(escapeRegExp(path.join(workspace, 'absent-store-path'))));
});

test('the guest installs fabro-darwin-build-smoke in its system packages', () => {
  const names = JSON.parse(childProcess.execFileSync(
    'nix',
    [
      'eval',
      '--json',
      '--impure',
      '--expr',
      `let flake = builtins.getFlake (toString ${repoRoot}); in
       map (package: package.name) flake.nixosConfigurations."fabro-vm".config.environment.systemPackages`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));

  assert.ok(
    names.includes('fabro-darwin-build-smoke'),
    `the guest system packages must include fabro-darwin-build-smoke; got ${names.join(', ')}`,
  );
});
