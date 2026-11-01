'use strict';

// Behaviour tests for `scripts/mac-builder-tailscale-auth.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 2.1; design "Component
// Contracts → Builder Host → `mac-builder-tailscale-auth`"; requirements 4.1,
// 4.3, 4.8, 4.9, 4.10, 4.11).
//
// Every case drives the built wrapper against a stub `--tailscale`, so the
// assertions cover the artifact launchd actually runs rather than the shell
// source.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

let cachedWrapperBin = null;

function buildWrapperBin() {
  if (cachedWrapperBin) return cachedWrapperBin;
  const expr = `let flake = builtins.getFlake (toString ${repoRoot}); pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage ${repoRoot}/scripts/mac-builder-tailscale-auth.nix { }`;
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
  cachedWrapperBin = path.join(out, 'bin', 'mac-builder-tailscale-auth');
  return cachedWrapperBin;
}

// The stub records each invocation on its own line and serves `status` from
// the state file. `FAIL` makes `status` exit nonzero, which models an
// unresponsive daemon.
const STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$STUB_LOG"
case "\${1:-}" in
  status)
    state="$(cat "$STUB_STATE" 2>/dev/null || printf 'FAIL')"
    if [[ "$state" == FAIL ]]; then
      printf 'stub: tailscaled is unreachable\\n' >&2
      exit 1
    fi
    if [[ "$state" == INVALID ]]; then
      printf 'not json\\n'
      exit 0
    fi
    printf '{"BackendState":"%s"}\\n' "$state"
    ;;
  up)
    exit "\${STUB_UP_EXIT:-0}"
    ;;
  *)
    exit 0
    ;;
esac
`;

function makeWorkspace({ credential = 'tskey-auth-SECRET-123\n', state = 'Running' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-tailscale-auth-'));
  const stubPath = path.join(dir, 'tailscale-stub');
  const statePath = path.join(dir, 'state');
  const logPath = path.join(dir, 'stub.log');
  const credentialPath = path.join(dir, 'builder-tailscale-oauth-secret');
  fs.writeFileSync(stubPath, STUB, { mode: 0o755 });
  fs.writeFileSync(statePath, `${state}\n`);
  fs.writeFileSync(logPath, '');
  if (credential !== null) fs.writeFileSync(credentialPath, credential);
  return { dir, stubPath, statePath, logPath, credentialPath };
}

function runArgs(workspace, overrides = {}) {
  const values = {
    '--auth-key-file': workspace.credentialPath,
    '--hostname': 'mac-builder',
    '--tag': 'tag:mac-builder',
    '--tailscale': workspace.stubPath,
    '--once': null,
    ...overrides,
  };
  const args = [];
  for (const [flag, value] of Object.entries(values)) {
    if (value === null) {
      args.push(flag);
    } else if (value !== undefined) {
      args.push(flag, value);
    }
  }
  return args;
}

function runWrapper(workspace, args, extraEnv = {}) {
  return childProcess.spawnSync(buildWrapperBin(), args, {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: {
      ...process.env,
      STUB_LOG: workspace.logPath,
      STUB_STATE: workspace.statePath,
      ...extraEnv,
    },
  });
}

function stubCalls(workspace) {
  return fs
    .readFileSync(workspace.logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Running state does nothing and --once exits zero', () => {
  const workspace = makeWorkspace({ state: 'Running' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = stubCalls(workspace);
  assert.ok(calls.includes('status --json'), `expected a status query, got: ${calls.join(', ')}`);
  assert.ok(!calls.some((call) => call.startsWith('up')), 'Running must not call tailscale up');
});

for (const state of ['NeedsLogin', 'NeedsMachineAuth', 'Stopped']) {
  test(`${state} state re-authenticates with the exact tailscale up arguments`, () => {
    const workspace = makeWorkspace({ state });
    const result = runWrapper(workspace, runArgs(workspace));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const upCalls = stubCalls(workspace).filter((call) => call.startsWith('up'));
    assert.equal(upCalls.length, 1, `expected one up call, got: ${upCalls.join(' | ')}`);
    assert.equal(
      upCalls[0],
      'up --auth-key=tskey-auth-SECRET-123?ephemeral=false&preauthorized=true --advertise-tags=tag:mac-builder --hostname=mac-builder --accept-dns=false',
    );
  });
}

test('a failed re-authentication makes --once exit nonzero', () => {
  const workspace = makeWorkspace({ state: 'NeedsLogin' });
  const result = runWrapper(workspace, runArgs(workspace), { STUB_UP_EXIT: '1' });

  assert.notEqual(result.status, 0);
  const upCalls = stubCalls(workspace).filter((call) => call.startsWith('up'));
  assert.equal(upCalls.length, 1);
});

test('a missing credential is reported even when the node already reports Running', () => {
  const workspace = makeWorkspace({ credential: null, state: 'Running' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(escapeRegExp(workspace.credentialPath)));
});

test('the credential value never appears in the wrapper logs', () => {
  const workspace = makeWorkspace({ state: 'NeedsLogin' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('tskey-auth-SECRET-123'));
});

test('a missing credential names the runtime path and never calls tailscale up', () => {
  const workspace = makeWorkspace({ credential: null, state: 'NeedsLogin' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(escapeRegExp(workspace.credentialPath)));
  assert.ok(
    !stubCalls(workspace).some((call) => call.startsWith('up')),
    'a missing credential must never reach tailscale up',
  );
});

test('an empty credential names the runtime path and never calls tailscale up', () => {
  const workspace = makeWorkspace({ credential: '', state: 'NeedsLogin' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(escapeRegExp(workspace.credentialPath)));
  assert.ok(
    !stubCalls(workspace).some((call) => call.startsWith('up')),
    'an empty credential must never reach tailscale up',
  );
});

test('an unresponsive daemon makes --once exit nonzero without guessing a state', () => {
  const workspace = makeWorkspace({ state: 'FAIL' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.ok(
    !stubCalls(workspace).some((call) => call.startsWith('up')),
    'an unreadable status must not trigger tailscale up',
  );
});

test('a status response without BackendState is treated as unresponsive', () => {
  const workspace = makeWorkspace({ state: 'INVALID' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.ok(!stubCalls(workspace).some((call) => call.startsWith('up')));
});

test('an unrecognized state does not call tailscale up and fails --once', () => {
  const workspace = makeWorkspace({ state: 'Starting' });
  const result = runWrapper(workspace, runArgs(workspace));

  assert.notEqual(result.status, 0);
  assert.ok(!stubCalls(workspace).some((call) => call.startsWith('up')));
});

test('default mode keeps retrying after a failed iteration', () => {
  const workspace = makeWorkspace({ state: 'FAIL' });
  const result = childProcess.spawnSync(
    buildWrapperBin(),
    runArgs(workspace, { '--once': undefined, '--interval': '1' }),
    {
      encoding: 'utf8',
      timeout: 2500,
      env: {
        ...process.env,
        STUB_LOG: workspace.logPath,
        STUB_STATE: workspace.statePath,
      },
    },
  );

  assert.equal(result.signal, 'SIGTERM', 'a failed iteration must not exit the daemon wrapper');
  assert.ok(stubCalls(workspace).length >= 1, 'the wrapper must have attempted an iteration');
});

test('default mode re-authenticates and keeps polling after a successful join', () => {
  const workspace = makeWorkspace({ state: 'NeedsLogin' });
  const result = childProcess.spawnSync(
    buildWrapperBin(),
    runArgs(workspace, { '--once': undefined, '--interval': '1' }),
    {
      encoding: 'utf8',
      timeout: 2500,
      env: {
        ...process.env,
        STUB_LOG: workspace.logPath,
        STUB_STATE: workspace.statePath,
      },
    },
  );

  assert.equal(result.signal, 'SIGTERM', 'default mode must keep running');
  const calls = stubCalls(workspace);
  assert.ok(calls.some((call) => call.startsWith('up')), 'the first iteration must join');
  assert.ok(
    calls.filter((call) => call === 'status --json').length >= 2,
    'the wrapper must poll again after joining',
  );
});
