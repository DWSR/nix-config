'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const executable = process.env.RECONCILE_EXECUTABLE;
if (!executable) {
  throw new Error('RECONCILE_EXECUTABLE must point at fabro-tailscale-reconcile');
}

const dummyCredential = 'dummy-test-credential';
const expectedUp = [
  'up',
  `--auth-key=${dummyCredential}?ephemeral=true&preauthorized=true`,
  '--advertise-tags=tag:fabro',
];

function fixture(status, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-tailscale-reconcile-'));
  const log = path.join(directory, 'calls.jsonl');
  const keyFile = path.join(directory, 'tailscale-oauth-secret');
  const statusFile = path.join(directory, 'status.json');
  const tailscale = path.join(directory, 'tailscale');

  if (options.key !== 'missing') fs.writeFileSync(keyFile, options.key ?? dummyCredential);
  fs.writeFileSync(statusFile, JSON.stringify(status));
  fs.writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = status ]; then
  ${options.statusFails ? 'exit 1' : 'cat "$STATUS_FILE"'}
else
  printf '%s\\n' "$@" >> "$CALL_LOG"
fi
`);
  fs.chmodSync(tailscale, 0o755);

  const run = () => childProcess.spawnSync(executable, [
    '--auth-key-file', keyFile,
    '--tag', 'tag:fabro',
    '--tailscale', tailscale,
  ], {
    encoding: 'utf8',
    env: { ...process.env, CALL_LOG: log, STATUS_FILE: statusFile },
  });

  return { directory, keyFile, log, run };
}

function upCalls(f) {
  if (!fs.existsSync(f.log)) return [];
  return fs.readFileSync(f.log, 'utf8').trim().split('\n');
}

test('healthy running node is a no-op', () => {
  const f = fixture({ BackendState: 'Running', Self: { Online: true } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(upCalls(f), []);
});

test('running but offline node re-registers (ephemeral reap)', () => {
  const f = fixture({ BackendState: 'Running', Self: { Online: false } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(upCalls(f), expectedUp);
  assert.match(result.stdout, /Online=false/);
});

test('pending AuthURL re-registers even while running', () => {
  const f = fixture({
    BackendState: 'Running',
    Self: { Online: true },
    AuthURL: 'https://login.tailscale.com/a/example',
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(upCalls(f), expectedUp);
  assert.match(result.stdout, /AuthURL=present/);
});

for (const backend of ['NeedsLogin', 'NeedsMachineAuth', 'Stopped']) {
  test(`${backend} re-registers with the tagged ephemeral key`, () => {
    const f = fixture({ BackendState: backend });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(upCalls(f), expectedUp);
  });
}

test('starting or unknown backends defer without a login attempt', () => {
  for (const backend of ['NoState', 'Starting', 'InUseOtherUser']) {
    const f = fixture({ BackendState: backend });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(upCalls(f), [], backend);
  }
});

test('missing or empty credential fails without up and names its path', () => {
  for (const options of [{ key: 'missing' }, { key: '' }]) {
    const f = fixture({ BackendState: 'NeedsLogin' }, options);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(f.keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(upCalls(f), []);
  }
});

test('unresponsive daemon fails without up', () => {
  const f = fixture({ BackendState: 'Running' }, { statusFails: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tailscale status failed/);
  assert.deepEqual(upCalls(f), []);
});
