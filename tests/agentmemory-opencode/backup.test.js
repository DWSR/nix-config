'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'agentmemory-backup.nix');
const packagePaths = new Map();

function backupPackagePath(timeoutSeconds = 30) {
  if (packagePaths.has(timeoutSeconds)) return packagePaths.get(timeoutSeconds);

  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [ flake.outputs.overlays.custom-packages ];
    config.allowUnfree = true;
  };
in (pkgs.callPackage ${JSON.stringify(scriptPath)} {
  agentmemoryPackage = pkgs.writeShellScriptBin "agentmemory-test" "exit 0";
  dataDir = "/tmp/agentmemory-backup-test-data";
  runtimeDir = "/tmp/agentmemory-backup-test-runtime";
  backupDestination = "/tmp/agentmemory-backup-test-destination";
  restPort = 35111;
  streamPort = 35112;
  viewerPort = 35113;
  enginePort = 61134;
  timeoutSeconds = ${timeoutSeconds};
}).drvPath)`;

  const drvPath = execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const packagePath = execFileSync('nix-store', ['--realise', drvPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split('\n').at(-1) + '/bin/agentmemory-backup';
  packagePaths.set(timeoutSeconds, packagePath);
  return packagePath;
}

function writeExecutable(directory, name, source) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-backup-'));
  const dataDir = path.join(directory, 'managed-data');
  const destination = path.join(directory, 'backups');
  const logPath = path.join(directory, 'commands.log');
  fs.mkdirSync(path.join(dataDir, 'nested'), { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(dataDir, 'database.sqlite'), 'database');
  fs.writeFileSync(path.join(dataDir, '.runtime-state'), 'hidden');
  fs.writeFileSync(path.join(dataDir, 'nested', 'index.json'), '{"version":1}\n');

  const agentmemory = writeExecutable(
    directory,
    'agentmemory',
    '#!/bin/sh\n' +
      'printf "%s\\n" "stop:$*" >> "$BACKUP_LOG"\n' +
      'exit "${BACKUP_STOP_EXIT:-0}"\n',
  );
  const lsof = writeExecutable(
    directory,
    'lsof',
    '#!/bin/sh\n' +
      'printf "%s\\n" "lsof:$*" >> "$BACKUP_LOG"\n' +
      'if [ "${BACKUP_LISTENERS:-0}" = 1 ]; then exit 0; fi\n' +
      'exit 1\n',
  );
  const pgrep = writeExecutable(
    directory,
    'pgrep',
    '#!/bin/sh\n' +
      'printf "%s\\n" "pgrep:$*" >> "$BACKUP_LOG"\n' +
      'if [ "${BACKUP_PROCESSES:-0}" = 1 ]; then exit 0; fi\n' +
      'exit 1\n',
  );
  const cp = writeExecutable(
    directory,
    'cp',
    '#!/bin/sh\n' +
      'printf "%s\\n" "cp:$*" >> "$BACKUP_LOG"\n' +
      'if [ "${BACKUP_COPY_EXIT:-0}" != 0 ]; then exit "$BACKUP_COPY_EXIT"; fi\n' +
      'exec /bin/cp "$@"\n',
  );
  const launchctl = writeExecutable(
    directory,
    'launchctl',
    '#!/bin/sh\n' +
      'printf "%s\\n" "restart:$*" >> "$BACKUP_LOG"\n' +
      'exit "${BACKUP_RESTART_EXIT:-0}"\n',
  );

  return {
    directory,
    dataDir,
    destination,
    logPath,
    agentmemory,
    lsof,
    pgrep,
    cp,
    launchctl,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function runBackup(fixture, packagePath, state = {}) {
  return spawnSync(packagePath, [], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTMEMORY_BACKUP_DATA_DIR: fixture.dataDir,
      AGENTMEMORY_BACKUP_DESTINATION: fixture.destination,
      AGENTMEMORY_BACKUP_LOG: fixture.logPath,
      BACKUP_LOG: fixture.logPath,
      AGENTMEMORY_BACKUP_AGENTMEMORY_BIN: fixture.agentmemory,
      AGENTMEMORY_BACKUP_LSOF_BIN: fixture.lsof,
      AGENTMEMORY_BACKUP_PGREP_BIN: fixture.pgrep,
      AGENTMEMORY_BACKUP_CP_BIN: fixture.cp,
      AGENTMEMORY_BACKUP_LAUNCHCTL_BIN: fixture.launchctl,
      AGENTMEMORY_BACKUP_LAUNCHD_DOMAIN: 'gui/test-user',
      ...state,
    },
  });
}

function commandLog(fixture) {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, 'utf8').trim().split('\n').filter(Boolean);
}

function processOutput(result) {
  return result.stderr || result.error?.message || result.signal || '';
}

function assertNoFalseClaims(result) {
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`.toLowerCase(),
    /transaction|flush barrier|restore validation|consistent snapshot/,
  );
}

test('stops, waits, copies the complete managed tree, and restarts in order', () => {
  const fixture = createFixture();
  try {
    const result = runBackup(fixture, backupPackagePath());
    assert.equal(result.status, 0, processOutput(result));
    assert.match(result.stdout, /backup stop=ok/);
    assert.match(result.stdout, /backup copy=ok path=/);
    assert.match(result.stdout, /backup restart=ok/);

    const log = commandLog(fixture);
    assert.equal(log[0], 'stop:stop --force --port 35111');
    assert.match(log.find((line) => line.startsWith('lsof:')), /-iTCP:35111/);
    assert.equal(log.at(-1), 'restart:kickstart -k gui/test-user/dev.dwsr.agentmemory');
    const phases = log.map((line) => line.split(':', 1)[0]);
    assert.equal(phases[0], 'stop');
    assert.ok(phases.indexOf('lsof') > phases.indexOf('stop'));
    assert.ok(phases.indexOf('cp') > phases.indexOf('lsof'));
    assert.equal(phases.at(-1), 'restart');
    for (const relativePath of [
      'managed-data/database.sqlite',
      'managed-data/.runtime-state',
      'managed-data/nested/index.json',
    ]) {
      assert.equal(fs.existsSync(path.join(fixture.destination, relativePath)), true, relativePath);
    }
    assertNoFalseClaims(result);
  } finally {
    fixture.cleanup();
  }
});

test('reports a missing or failed stock stop without copying or restarting', () => {
  for (const state of [
    { AGENTMEMORY_BACKUP_AGENTMEMORY_BIN: '/missing/agentmemory' },
    { BACKUP_STOP_EXIT: '7' },
  ]) {
    const fixture = createFixture();
    try {
      const result = runBackup(fixture, backupPackagePath(), state);
      assert.notEqual(result.status, 0);
      assert.match(processOutput(result), /backup stop=failed/);
      assert.equal(commandLog(fixture).some((line) => line.startsWith('cp:')), false);
      assert.equal(commandLog(fixture).some((line) => line.startsWith('restart:')), false);
      assertNoFalseClaims(result);
    } finally {
      fixture.cleanup();
    }
  }
});

test('reports a copy failure but still attempts the service restart', () => {
  const fixture = createFixture();
  try {
    const result = runBackup(fixture, backupPackagePath(), { BACKUP_COPY_EXIT: '9' });
    assert.notEqual(result.status, 0);
    assert.match(processOutput(result), /backup copy=failed/);
    assert.equal(commandLog(fixture).at(-1).startsWith('restart:'), true);
    assertNoFalseClaims(result);
  } finally {
    fixture.cleanup();
  }
});

test('reports a restart failure after the archived tree has been copied', () => {
  const fixture = createFixture();
  try {
    const result = runBackup(fixture, backupPackagePath(), { BACKUP_RESTART_EXIT: '8' });
    assert.notEqual(result.status, 0);
    assert.match(processOutput(result), /backup restart=failed/);
    assert.equal(fs.existsSync(path.join(fixture.destination, 'managed-data', 'nested', 'index.json')), true);
    assertNoFalseClaims(result);
  } finally {
    fixture.cleanup();
  }
});

test('stops waiting at the fixed timeout when listeners remain', () => {
  const fixture = createFixture();
  try {
    const packagePath = backupPackagePath(1);
    const startedAt = Date.now();
    const result = runBackup(fixture, packagePath, { BACKUP_LISTENERS: '1' });
    const elapsedMs = Date.now() - startedAt;
    assert.notEqual(result.status, 0);
    assert.match(processOutput(result), /backup stop=failed.*timeout/);
    assert.ok(elapsedMs < 5_000, `wait exceeded fixed bound: ${elapsedMs}ms`);
    assert.equal(commandLog(fixture).some((line) => line.startsWith('cp:')), false);
    assert.equal(commandLog(fixture).some((line) => line.startsWith('restart:')), false);
    assertNoFalseClaims(result);
  } finally {
    fixture.cleanup();
  }
});
