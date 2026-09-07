'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const secret = 'status-test-bearer-value';

function statusPackageDerivation() {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [ flake.outputs.overlays.custom-packages ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        programs.agentmemory = {
          enable = true;
          dataDir = "/tmp/agentmemory/status-data";
          runtimeDir = "/tmp/agentmemory/status-runtime";
          logDir = "/tmp/agentmemory/status-logs";
          restPort = 35111;
          streamPort = 35112;
          viewerPort = 35113;
          enginePort = 61134;
          bearerReference = "status-bearer-reference";
        };
      }
    ];
  }).config;
in hm.programs.agentmemory.statusPackage.drvPath)`;

  return execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function statusCommandPath() {
  return execFileSync('nix-store', ['--realise', statusPackageDerivation()], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split('\n').at(-1) + '/bin/agentmemory-status';
}

function writeExecutable(directory, name, source) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-status-'));
  const curl = writeExecutable(
    directory,
    'curl',
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      '  *livez*) printf "%s" "$STATUS_LIVEZ_RESPONSE" ;;\n' +
      '  *) printf "%s" "$STATUS_HEALTH_RESPONSE" ;;\n' +
      'esac\n' +
      'exit "${STATUS_CURL_EXIT:-0}"\n',
  );
  const launchctl = writeExecutable(
    directory,
    'launchctl',
    '#!/bin/sh\nprintf "%s" "$STATUS_LAUNCHCTL_RESPONSE"\nexit "${STATUS_LAUNCHCTL_EXIT:-0}"\n',
  );
  const lsof = writeExecutable(
    directory,
    'lsof',
    '#!/bin/sh\nif [ "${STATUS_LISTENERS:-none}" = all ]; then printf "1234\\n"; fi\n',
  );

  return {
    directory,
    curl,
    launchctl,
    lsof,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function runStatus(fixture, state) {
  const result = spawnSync(statusCommandPath(), [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTMEMORY_SECRET: secret,
      AGENTMEMORY_STATUS_CURL_BIN: fixture.curl,
      AGENTMEMORY_STATUS_LAUNCHCTL_BIN: fixture.launchctl,
      AGENTMEMORY_STATUS_LSOF_BIN: fixture.lsof,
      AGENTMEMORY_STATUS_LAUNCHD_DOMAIN: 'gui/test-user',
      ...state,
    },
  });
  return result;
}

function assertCommonStatus(result, expected) {
  assert.equal(result.status, expected.exitCode, result.error?.message || result.stderr);
  assert.match(result.stdout, new RegExp(`^status=${expected.status}$`, 'm'));
  assert.match(result.stdout, /^agentmemory_revision=e04ba88819c365c9acf9d6661ea802143e728bd6$/m);
  assert.match(result.stdout, /^iii_revision=iii\/v0\.11\.2$/m);
  assert.match(result.stdout, /^data_dir=\/tmp\/agentmemory\/status-data$/m);
  for (const listener of ['rest', 'stream', 'viewer', 'engine']) {
    assert.match(result.stdout, new RegExp(`^listener_${listener}=${expected.listenerState}$`, 'm'));
  }
  assert.equal((result.stdout.match(/^action=/gm) || []).length, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
}

test('status reports a healthy stock daemon without exposing its bearer', () => {
  const fixture = createFixture();
  try {
    const result = runStatus(fixture, {
      STATUS_LIVEZ_RESPONSE: '{"ok":true}\n200',
      STATUS_HEALTH_RESPONSE: '{"status":"healthy","version":"0.9.29"}\n200',
      STATUS_LAUNCHCTL_RESPONSE: 'state = running\nlast exit code = 0\n',
      STATUS_LISTENERS: 'all',
    });

    assertCommonStatus(result, { exitCode: 0, listenerState: 'listening', status: 'healthy' });
    assert.match(result.stdout, /^health=healthy$/m);
    assert.match(result.stdout, /^action=none$/m);
  } finally {
    fixture.cleanup();
  }
});

test('status reports a stopped daemon with one restart action', () => {
  const fixture = createFixture();
  try {
    const result = runStatus(fixture, {
      STATUS_LIVEZ_RESPONSE: '\n000',
      STATUS_HEALTH_RESPONSE: '\n000',
      STATUS_CURL_EXIT: '1',
      STATUS_LAUNCHCTL_RESPONSE: '',
      STATUS_LAUNCHCTL_EXIT: '1',
      STATUS_LISTENERS: 'none',
    });

    assertCommonStatus(result, { exitCode: 1, listenerState: 'not-listening', status: 'stopped' });
    assert.match(result.stdout, /^health=unreachable$/m);
    assert.match(result.stdout, /^action=launchctl kickstart -k gui\/test-user\/dev\.dwsr\.agentmemory$/m);
  } finally {
    fixture.cleanup();
  }
});

test('status reports a loaded job that failed startup with one diagnostic action', () => {
  const fixture = createFixture();
  try {
    const result = runStatus(fixture, {
      STATUS_LIVEZ_RESPONSE: 'startup failed\n503',
      STATUS_HEALTH_RESPONSE: 'startup failed\n503',
      STATUS_CURL_EXIT: '0',
      STATUS_LAUNCHCTL_RESPONSE: 'state = exited\nlast exit code = 1\n',
      STATUS_LAUNCHCTL_EXIT: '0',
      STATUS_LISTENERS: 'none',
    });

    assertCommonStatus(result, { exitCode: 2, listenerState: 'not-listening', status: 'failed-startup' });
    assert.match(result.stdout, /^health=unhealthy$/m);
    assert.match(result.stdout, /^action=inspect \/tmp\/agentmemory\/status-logs\/agentmemory\.error\.log$/m);
  } finally {
    fixture.cleanup();
  }
});
