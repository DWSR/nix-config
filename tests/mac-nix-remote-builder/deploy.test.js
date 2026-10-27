'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 120_000;

let cachedDeployBin = null;

function buildDeployBin() {
  if (cachedDeployBin) return cachedDeployBin;
  const expr = `let flake = builtins.getFlake (toString ${repoRoot}); pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; config.allowUnfree = true; overlays = [ flake.outputs.overlays.unstable-packages flake.outputs.overlays.custom-packages ]; }; in pkgs.callPackage ${repoRoot}/scripts/mac-builder-deploy.nix { }`;
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
  cachedDeployBin = path.join(out, 'bin', 'mac-builder-deploy');
  return cachedDeployBin;
}

function makeStubs(stubBin, logFile, sshExit) {
  fs.mkdirSync(stubBin, { recursive: true });
  fs.writeFileSync(
    path.join(stubBin, 'ssh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\ncat >/dev/null 2>&1 || true\nexit ${sshExit}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(stubBin, 'op'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nprintf '%s\\n' 'AGE-SECRET-KEY-1TEST'\nexit 0\n`,
    { mode: 0o755 },
  );
}

function makeRunnableDeploy(stubBin) {
  const src = fs.readFileSync(buildDeployBin(), 'utf8');
  const patched = src.replace('export PATH="', `export PATH="${stubBin}:`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-deploy-run-'));
  const file = path.join(dir, 'mac-builder-deploy');
  fs.writeFileSync(file, patched, { mode: 0o755 });
  return file;
}

function runDeploy(repoDir, stubBin, logFile, sshExit) {
  makeStubs(stubBin, logFile, sshExit);
  const bin = makeRunnableDeploy(stubBin);
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-deploy-home-'));
  const limaHome = path.join(tmpHome, '.local', 'state', 'lima');
  fs.mkdirSync(limaHome, { recursive: true });
  const result = childProcess.spawnSync(bin, [repoDir], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      LIMA_HOME: limaHome,
      MAC_BUILDER_AGE_KEY_REF: 'op://Private/sops-age-key-mac-builder/notesPlain',
    },
    timeout: RUN_TIMEOUT_MS,
  });
  return result;
}

test('deploy guard: missing flake.lock aborts before any host change', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-deploy-repo-'));
  fs.writeFileSync(path.join(repoDir, 'flake.nix'), '{ }');
  // no flake.lock
  const stubBin = path.join(repoDir, 'bin');
  const logFile = path.join(repoDir, 'ssh.log');
  const result = runDeploy(repoDir, stubBin, logFile, 0);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /locked flake|flake\.lock/i);
});

test('deploy: unreachable host fails with connection error', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-deploy-repo-'));
  fs.writeFileSync(path.join(repoDir, 'flake.nix'), '{ }');
  fs.writeFileSync(path.join(repoDir, 'flake.lock'), '{ }');
  const stubBin = path.join(repoDir, 'bin');
  const logFile = path.join(repoDir, 'ssh.log');
  const result = runDeploy(repoDir, stubBin, logFile, 1);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /connection error/i);
});

test('deploy: streams tree, installs age key, and runs switch with stubs', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-deploy-repo-'));
  fs.writeFileSync(path.join(repoDir, 'flake.nix'), '{ }');
  fs.writeFileSync(path.join(repoDir, 'flake.lock'), '{ }');
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello');
  const stubBin = path.join(repoDir, 'bin');
  const logFile = path.join(repoDir, 'ssh.log');
  const result = runDeploy(repoDir, stubBin, logFile, 0);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /tar -xzf - -C/);
  const keyDirSetup = log.indexOf(
    'sudo -A /usr/bin/install -d -m 0755 -o root -g wheel /var/lib/sops-nix',
  );
  const keyWrite = log.indexOf('sudo -A tee /var/lib/sops-nix/key.txt');
  assert.ok(keyDirSetup >= 0, 'expected privileged creation of the sops-nix directory');
  assert.ok(keyWrite > keyDirSetup, 'expected the key directory to exist before writing the key');
  assert.match(log, /tee \/var\/lib\/sops-nix\/key\.txt/);
  assert.match(log, /curl -fsSL https:\/\/nixos\.org\/nix\/install \| SUDO_ASKPASS=\/tmp\/mac-builder-askpass sudo -A sh/);
  assert.match(log, /read op:\/\/Private\/mac-builder vm password\/password/);
  assert.match(log, /cat \/tmp\/mac-builder-password/);
  assert.match(log, /darwin-rebuild switch|nix run .* switch/);
  assert.doesNotMatch(log, /mount/i);
});
