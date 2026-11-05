'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nixEvalJson, repoRoot } = require('./helpers');

const script = path.join(__dirname, '../../scripts/fabro-darwin-build-smoke.nix');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-build-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPackage(args, env = {}) {
  const nixpkgs = process.env.FABRO_DARWIN_BUILDS_NIXPKGS ?? '<nixpkgs>';
  const drv = spawnSync('nix', ['eval', '--raw', '--impure', '--expr', `let pkgs = import ${nixpkgs} {}; in (import ${JSON.stringify(script)} { inherit pkgs; }).outPath`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes' } });
  assert.equal(drv.status, 0, drv.stderr);
  const executable = path.join(drv.stdout.trim(), 'bin/fabro-darwin-build-smoke');
  const shellEnv = spawnSync('nix', ['shell', '--impure', '--expr', `let pkgs = import ${nixpkgs} {}; in pkgs.symlinkJoin { name = "smoke-test-env"; paths = [ (import ${JSON.stringify(script)} { inherit pkgs; }) ]; }`, '--command', executable, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes', ...env },
  });
  return shellEnv;
}

test('disabled Darwin builder omits smoke command from guest packages', () => {
  const result = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [ ({ lib, ... }: { fabro.darwinBuilder.enable = lib.mkForce false; }) ];
      };
    in builtins.map (p: p.name) vm.config.environment.systemPackages
  `);
  assert.ok(!result.includes('fabro-darwin-build-smoke'));
});

test('successful smoke run validates preflight, invokes podman, and reports store path', t => {
  const dir = fixture(t);
  const client = path.join(dir, 'client-key');
  const host = path.join(dir, 'host-key');
  const machines = path.join(dir, 'machines');
  const argsFile = path.join(dir, 'podman-args');
  const scriptFile = path.join(dir, 'podman-script');
  const storePath = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fabro-darwin-build-smoke';
  fs.writeFileSync(client, 'test-client-key');
  fs.writeFileSync(host, 'test-host-key');
  fs.writeFileSync(machines, 'ssh-ng://builder aarch64-darwin /etc/nix/builder-key 4 1\n');
  const podman = path.join(dir, 'podman');
  fs.writeFileSync(podman, `#!/bin/sh\nif [ "$1" != run ] || [ "$2" != --rm ] || [ "$4" != /bin/bash ] || [ "$5" != -c ]; then exit 98; fi\nprintf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}\ncall_count=$(awk 'END { print int(NR / 6) }' ${JSON.stringify(argsFile)})\nif [ "$call_count" -eq 1 ] && printf '%s' "$6" | grep -q 'nix build --no-link --print-out-paths --expr'; then\n  printf '%s\\n' "$6" > ${JSON.stringify(scriptFile)}\n  printf '%s\\n' ${JSON.stringify(storePath)}\nelif [ "$call_count" -eq 2 ] && [ "$6" = "test -e '${storePath}'" ]; then\n  exit 0\nelse\n  exit 98\nfi\n`);
  fs.chmodSync(podman, 0o755);
  const result = runPackage(['test/image@sha256:abc'], {
    FABRO_BUILD_SMOKE_CLIENT_KEY: client,
    FABRO_BUILD_SMOKE_HOST_KEY: host,
    FABRO_BUILD_SMOKE_MACHINES: machines,
    FABRO_BUILD_SMOKE_PODMAN: podman,
    FABRO_BUILD_SMOKE_STORE_ROOT: '/nix/store',
    FABRO_BUILD_SMOKE_DIGEST: path.join(dir, 'digest'),
  });
  assert.equal(result.status, 0, `${result.stderr ?? ''}${result.stdout ?? ''}${result.error ?? ''}`);
  for (const banner of ['STEP 1: Preflight', 'STEP 2: Build Darwin derivation', 'STEP 3: Verify guest store path']) {
    assert.ok(result.stdout.includes(banner), result.stdout);
  }
  assert.ok(result.stdout.includes(storePath));
  const calls = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.deepEqual(calls.slice(0, 2), ['run', '--rm']);
  assert.equal(calls[2], 'test/image@sha256:abc');
  assert.deepEqual(calls.slice(3, 5), ['/bin/bash', '-c']);
  assert.ok(fs.readFileSync(scriptFile, 'utf8').includes('nix build --no-link --print-out-paths --expr'));
  assert.equal(calls[8], 'run');
  assert.equal(calls[9], '--rm');
  assert.equal(calls[10], 'test/image@sha256:abc');
  assert.deepEqual(calls.slice(11, 13), ['/bin/bash', '-c']);
  assert.equal(calls[13], `test -e '${storePath}'`);
  assert.equal(calls.filter(arg => arg === 'run').length, 2);
  const guestScript = fs.readFileSync(scriptFile, 'utf8');
  assert.match(guestScript, /system = "aarch64-darwin"/);
  assert.match(guestScript, /builder = "\/bin\/sh"/);
  assert.match(guestScript, /echo ok > \$out/);
  assert.match(guestScript, /nix build --no-link --print-out-paths --expr/);
});

test('preflight reports missing secret path and fails without invoking podman', t => {
  const dir = fixture(t);
  const missing = path.join(dir, 'missing-client-key');
  const host = path.join(dir, 'host-key');
  const machines = path.join(dir, 'machines');
  const podman = path.join(dir, 'podman');
  fs.writeFileSync(host, 'test-host-key');
  fs.writeFileSync(machines, 'ssh-ng://builder aarch64-darwin /etc/nix/builder-key 4 1\n');
  const digest = path.join(dir, 'digest');
  fs.writeFileSync(digest, 'sha256:abc\n');
  fs.writeFileSync(podman, '#!/bin/sh\nexit 99\n');
  fs.chmodSync(podman, 0o755);
  const result = runPackage([], {
    FABRO_BUILD_SMOKE_CLIENT_KEY: missing,
    FABRO_BUILD_SMOKE_HOST_KEY: host,
    FABRO_BUILD_SMOKE_MACHINES: machines,
    FABRO_BUILD_SMOKE_PODMAN: podman,
    FABRO_BUILD_SMOKE_DIGEST: digest,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr ?? '', new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, /FAILED: Step 1/);
});

test('enabled guest packages include smoke command', () => {
  const result = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [ ({ lib, ... }: { fabro.darwinBuilder.enable = lib.mkForce true; }) ];
      };
    in builtins.map (p: p.name) vm.config.environment.systemPackages
  `);
  assert.ok(result.includes('fabro-darwin-build-smoke'));
});
