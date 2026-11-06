'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { repoRoot } = require('./helpers');

const wrapperSource = path.join(repoRoot, 'scripts/mac-builder-tailscale-auth.nix');
const dummyCredential = 'dummy-test-credential';

function fixture(backendState, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tailscale-auth-'));
  const log = path.join(directory, 'calls.jsonl');
  const statusLog = path.join(directory, 'status.jsonl');
  const credential = path.join(directory, 'credential');
  const tailscale = path.join(directory, 'tailscale');
  if (options.credential !== false) fs.writeFileSync(credential, options.empty ? '' : dummyCredential);
  fs.writeFileSync(tailscale, `#!/bin/sh\nif [ "$1" = status ]; then\n  printf 'status\\n' >> "$STATUS_LOG"\n  ${options.unresponsive ? 'exit 1' : `printf '%s\\n' '${JSON.stringify({ BackendState: backendState })}'`}\nelse\n  printf '%s\\n' "$@" > "$CALL_LOG"\nfi\n`);
  fs.chmodSync(tailscale, 0o755);
  const expression = `let flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)}); pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage ${JSON.stringify(wrapperSource)} {}`;
  const executable = childProcess.execFileSync('nix', ['build', '--impure', '--no-link', '--print-out-paths', '--expr', expression], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes' } }).trim() + '/bin/mac-builder-tailscale-auth';
  const args = ['--auth-key-file', credential, '--hostname', 'builder-test', '--tag', 'tag:builder', '--tailscale', tailscale];
  const run = () => childProcess.spawnSync(executable, [...args, '--once'], { encoding: 'utf8', env: { ...process.env, CALL_LOG: log, STATUS_LOG: statusLog } });
  return { directory, credential, executable, log, statusLog, args, run };
}

test('Running performs no up', () => {
  const f = fixture('Running');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.log), false);
});

test('NeedsLogin uses the exact tagged, non-ephemeral up arguments', () => {
  const f = fixture('NeedsLogin');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(f.log, 'utf8').trim().split('\n'), [
    'up',
    `--auth-key=${dummyCredential}?ephemeral=false&preauthorized=true`,
    '--advertise-tags=tag:builder', '--hostname=builder-test', '--accept-dns=false',
  ]);
});

test('missing or empty credential fails without up and names its path', async (t) => {
  for (const options of [{ credential: false }, { empty: true }]) {
    await t.test(JSON.stringify(options), () => {
      const f = fixture('NeedsLogin', options);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(f.credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(fs.existsSync(f.log), false);
    });
  }
});

test('--once returns nonzero when the daemon does not respond', () => {
  const f = fixture('NeedsLogin', { unresponsive: true });
  assert.notEqual(f.run().status, 0);
});

test('default mode keeps polling after a successful iteration', async (t) => {
  const f = fixture('Running');
  const child = childProcess.spawn(f.executable, [...f.args, '--interval', '0.01'], {
    env: { ...process.env, PATH: '', CALL_LOG: f.log, STATUS_LOG: f.statusLog },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => child.kill('SIGTERM'));
  await delay(1_200);
  assert.equal(child.exitCode, null, `default loop exited early: ${stderr}`);
  child.kill('SIGTERM');
  await once(child, 'exit');

  const iterations = fs.readFileSync(f.statusLog, 'utf8').trim().split('\n').length;
  assert.ok(iterations > 1, `expected repeated polls, saw ${iterations}`);
});
