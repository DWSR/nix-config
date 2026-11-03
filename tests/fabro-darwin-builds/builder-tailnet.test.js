'use strict';

// Checks for the Builder Host's tailnet membership, remote-builder endpoint,
// and cache policy (mac-builder-for-fabro-nix-darwin-builds, task 5.3; design
// "Components and Interfaces → Builder Host → Builder Tailnet Membership",
// "Builder Cache Policy", and "Testing Strategy → Render and evaluation";
// requirements 3.5, 3.7, 3.8, 4.1, 4.2, 4.5, 4.6, 4.9, 4.12, 4.14, 5.1, 5.2,
// 5.3, 5.4, 5.7, 7.1, 7.2, 7.3, 8.2).
//
// The component suites (`builder-tailnet-membership.test.js`,
// `builder-host-import.test.js`, `builder-cache-policy.test.js`, and
// `tailscale-auth.test.js`) pin their own modules in isolation; this file is
// the task 5.3 check over the assembled host, so the endpoint and cache
// expectations are stated here even where a component suite already covers
// them.
//
// Two shapes are covered:
//
// - Evaluation of the real `darwinConfigurations.mac-builder` proves what the
//   host ships: the open-source `services.tailscale` module and its stock
//   `com.tailscale.tailscaled` LaunchDaemon, the auth LaunchDaemon's exact
//   arguments, the root-only OAuth credential, the unchanged `trusted-users` /
//   non-admin `nix-builder` / `PermitRootLogin no` endpoint, no custom build
//   service, and the exact public substituter and trusted-key sets.
// - The wrapper that the evaluated LaunchDaemon runs is driven with `--once`
//   against a stub `tailscale`, using the host's own `--hostname` and `--tag`
//   arguments. The wrapper is built for the evaluation host from the same
//   source the host calls, because the host-evaluated binary targets
//   `aarch64-darwin`. That keeps the join arguments under the configuration
//   assertions instead of restating them here.
//
// No assertion reads a secret value; only the declared runtime paths appear.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { nixEvalJson, repoRoot } = require('./helpers');

const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

const AUTH_DAEMON = 'mac-builder-tailscale-auth';
const SECRET_NAME = 'builder-tailscale-oauth-secret';
const SECRET_PATH = '/run/secrets/builder-tailscale-oauth-secret';
const BUILDER_HOSTNAME = 'mac-builder';
const BUILDER_TAG = 'tag:mac-builder';

// The two public caches from `research.md` ("Public caches"), pinned here so a
// change to the host policy must update this list deliberately.
const PUBLIC_SUBSTITUTERS = [
  'https://cache.nixos.org/',
  'https://nix-community.cachix.org',
];
const PUBLIC_TRUSTED_PUBLIC_KEYS = [
  'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=',
];

// The repository's private binary cache must never reach the builder.
const PRIVATE_CACHE_HOST = 'Brandons-MacBook-Pro.local';

// Nix's own daemon plus the nix-darwin activation, GC, optimise, sops, and
// tailnet daemons. Any other entry would be a custom build API, queue, or
// scheduler replacing Nix's distributed-build mechanism.
const STOCK_LAUNCHD_DAEMONS = [
  'activate-system',
  AUTH_DAEMON,
  'nix-daemon',
  'nix-gc',
  'nix-optimise',
  'sops-install-secrets',
  'tailscaled',
];

const SELECTION = `{
  hostPlatform = config.nixpkgs.hostPlatform.system;
  daemons = builtins.attrNames config.launchd.daemons;
  tailscaled = {
    label = config.launchd.daemons.tailscaled.serviceConfig.Label;
    runAtLoad = config.launchd.daemons.tailscaled.serviceConfig.RunAtLoad;
    command = config.launchd.daemons.tailscaled.command;
  };
  auth = {
    serviceConfig = config.launchd.daemons.${AUTH_DAEMON}.serviceConfig;
  };
  tailscale = {
    enable = config.services.tailscale.enable;
    packageName = config.services.tailscale.package.pname;
    packagePath = toString config.services.tailscale.package;
    client = "\${toString config.services.tailscale.package}/bin/tailscale";
    inSystemPackages = builtins.elem config.services.tailscale.package config.environment.systemPackages;
  };
  secret = {
    path = config.sops.secrets.${SECRET_NAME}.path;
    mode = config.sops.secrets.${SECRET_NAME}.mode;
    owner = config.sops.secrets.${SECRET_NAME}.owner;
    group = config.sops.secrets.${SECRET_NAME}.group;
    sopsFile = toString config.sops.secrets.${SECRET_NAME}.sopsFile;
  };
  secretNames = builtins.attrNames config.sops.secrets;
  nix = {
    distributedBuilds = config.nix.distributedBuilds;
    builders = config.nix.settings.builders or null;
    trustedUsers = config.nix.settings.trusted-users;
    substituters = config.nix.settings.substituters;
    trustedPublicKeys = config.nix.settings.trusted-public-keys;
    hasExtraPlatforms = config.nix.settings ? extra-platforms;
    extraPlatforms = config.nix.settings.extra-platforms or [ ];
    hasExtraSubstituters = config.nix.settings ? extra-substituters;
    extraSubstituters = config.nix.settings.extra-substituters or [ ];
    hasExtraTrustedPublicKeys = config.nix.settings ? extra-trusted-public-keys;
    extraTrustedPublicKeys = config.nix.settings.extra-trusted-public-keys or [ ];
  };
  sshd = {
    enable = config.services.openssh.enable;
    extraConfig = config.services.openssh.extraConfig;
  };
  user = {
    inherit (config.users.users.nix-builder) uid gid isHidden;
    extraGroups = config.users.users.nix-builder.extraGroups or [ ];
  };
}`;

let cachedReport = null;

function builderReport() {
  if (cachedReport) return cachedReport;
  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  config = flake.darwinConfigurations.mac-builder.config;
in ${SELECTION}
`;
  cachedReport = nixEvalJson(expr, { timeout: NIX_TIMEOUT_MS });
  return cachedReport;
}

// The evaluated lists are *sets* of caches: nix-darwin's own module appends
// the stock `https://cache.nixos.org/` with `mkAfter`, so the policy's exact
// pair can repeat. What matters is that no cache outside the public pair can
// appear, which is what these comparisons pin.
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

// Splits a launchd command into words, tolerating the quoting
// `escapeShellArgs` adds.
function commandWords(command) {
  assert.equal(typeof command, 'string', 'the auth daemon must set a command string');
  return command
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

// `launchd.daemons.<name>.command` is wrapped by nix-darwin as
// `/bin/wait4path /nix/store && exec <command>`; the words after `exec` are the
// arguments launchd really runs.
function execWords(programArguments) {
  assert.equal(programArguments[0], '/bin/sh');
  assert.equal(programArguments[1], '-c');
  const script = programArguments[2];
  const execIndex = script.indexOf('exec ');
  assert.notEqual(execIndex, -1, `expected an exec wrapper, got: ${script}`);
  return commandWords(script.slice(execIndex + 'exec '.length));
}

// The host's own auth-daemon arguments, minus the wrapper executable. The
// behaviour cases pass these to the wrapper directly.
let cachedAuthArgs = null;

function hostAuthArgs() {
  if (cachedAuthArgs) return cachedAuthArgs;
  const report = builderReport();
  assert.ok(
    report.daemons.includes(AUTH_DAEMON),
    `launchd.daemons.${AUTH_DAEMON} must be declared; daemons: ${JSON.stringify(report.daemons)}`,
  );
  const words = execWords(report.auth.serviceConfig.ProgramArguments);
  assert.match(words[0], /mac-builder-tailscale-auth$/, `first word: ${words[0]}`);
  cachedAuthArgs = words.slice(1);
  return cachedAuthArgs;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(args)}`);
  return args[index + 1];
}

test('the builder joins the tailnet with the open-source client only', () => {
  const report = builderReport();

  assert.equal(report.hostPlatform, 'aarch64-darwin');
  assert.equal(report.tailscale.enable, true, 'services.tailscale must stay enabled');
  assert.equal(
    report.tailscale.packageName,
    'tailscale',
    `the builder must use the open-source client, got: ${report.tailscale.packageName}`,
  );
  assert.match(report.tailscale.packagePath, /^\/nix\/store\//);
  assert.ok(
    !/tailscale.*\.app/i.test(report.tailscale.packagePath),
    `the macOS application must not be used, got: ${report.tailscale.packagePath}`,
  );
  assert.equal(
    report.tailscale.inSystemPackages,
    true,
    'the tailscale client must be installed on the host',
  );
});

test('tailscaled is the stock com.tailscale.tailscaled LaunchDaemon', () => {
  const report = builderReport();

  assert.ok(report.daemons.includes('tailscaled'), `daemons: ${JSON.stringify(report.daemons)}`);
  assert.equal(report.tailscaled.label, 'com.tailscale.tailscaled');
  assert.equal(report.tailscaled.runAtLoad, true);
  assert.match(report.tailscaled.command, /tailscaled$/, `command: ${report.tailscaled.command}`);
});

test('the auth LaunchDaemon passes the builder name, tag, and credential path', () => {
  const report = builderReport();
  const words = hostAuthArgs();

  assert.equal(
    flagValue(words, '--auth-key-file'),
    SECRET_PATH,
    'launchd must pass the credential by path, never inline',
  );
  assert.equal(flagValue(words, '--hostname'), BUILDER_HOSTNAME);
  assert.equal(flagValue(words, '--tag'), BUILDER_TAG);
  assert.equal(
    flagValue(words, '--tailscale'),
    report.tailscale.client,
    'the auth daemon must use the client declared by services.tailscale',
  );

  // The wrapper owns the OAuth parameters and `--accept-dns=false`; launchd
  // must not carry the credential value or a second up-argument set.
  assert.ok(
    !words.some((word) => /^--auth-key=/.test(word)),
    'the credential must never appear in the launchd arguments',
  );
  assert.ok(
    !words.some((word) => word.includes('?ephemeral=')),
    'the OAuth parameters belong to the wrapper, not the launchd arguments',
  );

  const { serviceConfig } = report.auth;
  assert.equal(serviceConfig.RunAtLoad, true);
  assert.equal(serviceConfig.KeepAlive, true);
  assert.equal(serviceConfig.ThrottleInterval, 30);
  assert.equal(serviceConfig.ProcessType, 'Background');
  assert.match(serviceConfig.StandardOutPath, /^\/var\/log\//);
  assert.match(serviceConfig.StandardErrorPath, /^\/var\/log\//);
});

test('the OAuth credential is declared root-only at its runtime path', () => {
  const report = builderReport();

  assert.equal(report.secret.path, SECRET_PATH);
  assert.equal(report.secret.mode, '0400');
  assert.equal(report.secret.owner, 'root');
  assert.equal(report.secret.group, 'wheel');
  assert.match(report.secret.sopsFile, /remote-builder\.mac-builder\.yaml$/);
  assert.ok(
    !/fabro\.fabro\.yaml$/.test(report.secret.sopsFile),
    'the builder must not read the guest store',
  );

  // The builder holds its own OAuth credential and the existing authorized
  // keys; the guest's `tailscale-oauth-secret` must not appear here.
  assert.deepEqual(
    [...report.secretNames].sort(),
    ['builder-authorized-keys', SECRET_NAME].sort(),
    `unexpected sops secrets: ${JSON.stringify(report.secretNames)}`,
  );
});

test('the endpoint trusts only nix-builder, keeps it non-admin, and refuses root', () => {
  const report = builderReport();

  assert.equal(report.sshd.enable, true);
  assert.match(report.sshd.extraConfig, /PermitRootLogin no/);
  assert.match(report.sshd.extraConfig, /PasswordAuthentication no/);

  assert.deepEqual(
    report.nix.trustedUsers.filter((user) => user !== 'root'),
    ['nix-builder'],
    `nix-builder must be the only non-root trusted user, got: ${JSON.stringify(report.nix.trustedUsers)}`,
  );

  // The builder user stays the hidden uid-502 staff account: gid 20 is
  // `staff`, and no `admin` group membership exists.
  assert.equal(report.user.uid, 502);
  assert.equal(report.user.gid, 20);
  assert.equal(report.user.isHidden, true);
  assert.ok(
    !report.user.extraGroups.includes('admin'),
    `nix-builder must stay non-admin, got: ${JSON.stringify(report.user.extraGroups)}`,
  );

  // The host serves aarch64-darwin only, so no foreign system is queued here.
  assert.equal(
    report.nix.hasExtraPlatforms,
    false,
    `extra-platforms must stay unset, got: ${JSON.stringify(report.nix.extraPlatforms)}`,
  );
});

test('Nix keeps its stock daemon and no custom build service is added', () => {
  const report = builderReport();

  assert.deepEqual(
    [...report.daemons].sort(),
    [...STOCK_LAUNCHD_DAEMONS].sort(),
    'only the stock nix-darwin, sops, and tailnet daemons may run; a custom build API, queue, or scheduler would appear here',
  );
  assert.equal(
    report.nix.distributedBuilds,
    false,
    'the builder must not dispatch builds elsewhere',
  );
  assert.equal(
    report.nix.builders,
    null,
    'the builder must not declare remote builders of its own',
  );
});

test('the builder substitutes from exactly the two public caches', () => {
  const report = builderReport();
  const substituters = uniqueSorted(report.nix.substituters);

  assert.deepEqual(
    substituters,
    uniqueSorted(PUBLIC_SUBSTITUTERS),
    `the host must declare exactly the public caches, got: ${JSON.stringify(report.nix.substituters)}`,
  );
  assert.equal(
    report.nix.hasExtraSubstituters,
    false,
    `no extra-substituters may be declared, got: ${JSON.stringify(report.nix.extraSubstituters)}`,
  );

  const allSubstituters = [
    ...report.nix.substituters,
    ...report.nix.extraSubstituters,
  ].join('\n');
  assert.ok(
    !allSubstituters.includes(PRIVATE_CACHE_HOST),
    `the private cache must never be a substituter, got: ${allSubstituters}`,
  );
  for (const substituter of substituters) {
    assert.ok(
      PUBLIC_SUBSTITUTERS.includes(substituter),
      `substituter ${substituter} is not one of the declared public caches`,
    );
  }
});

test('the builder trusts exactly the two public cache keys', () => {
  const report = builderReport();
  const trustedKeys = uniqueSorted(report.nix.trustedPublicKeys);

  assert.deepEqual(
    trustedKeys,
    uniqueSorted(PUBLIC_TRUSTED_PUBLIC_KEYS),
    `the host must trust exactly the public cache keys, got: ${JSON.stringify(report.nix.trustedPublicKeys)}`,
  );
  assert.equal(
    report.nix.hasExtraTrustedPublicKeys,
    false,
    `no extra-trusted-public-keys may be declared, got: ${JSON.stringify(report.nix.extraTrustedPublicKeys)}`,
  );

  for (const key of trustedKeys) {
    assert.ok(
      PUBLIC_TRUSTED_PUBLIC_KEYS.includes(key),
      `trusted key ${key} does not belong to a public cache`,
    );
  }
});

// --- Behaviour: the wrapper the host's LaunchDaemon runs -------------------

const WRAPPER_EXPR = `let flake = builtins.getFlake (toString ${repoRoot}); pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage ${repoRoot}/scripts/mac-builder-tailscale-auth.nix { }`;

let cachedWrapperBin = null;

// The evaluated LaunchDaemon calls an aarch64-darwin build of the wrapper,
// which cannot run on this evaluation host. Build the same source for the
// current system; the arguments still come from the host's evaluated config.
function wrapperBin() {
  if (cachedWrapperBin) return cachedWrapperBin;
  const out = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', WRAPPER_EXPR],
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
// the state file. `FAIL` models an unresponsive tailscaled.
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
    printf '{"BackendState":"%s"}\\n' "$state"
    ;;
  up)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const CREDENTIAL_VALUE = 'tskey-auth-SECRET-123';

function makeWorkspace({ credential = `${CREDENTIAL_VALUE}\n`, state = 'Running' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-tailnet-'));
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

function stubCalls(workspace) {
  return fs
    .readFileSync(workspace.logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

// The host's arguments with the compiled-in credential path and tailscale
// binary swapped for the per-case fixtures, plus `--once`.
function onceArgs(workspace) {
  const args = [...hostAuthArgs()];
  for (const [flag, value] of [
    ['--auth-key-file', workspace.credentialPath],
    ['--tailscale', workspace.stubPath],
  ]) {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `the host must pass ${flag}`);
    args[index + 1] = value;
  }
  args.push('--once');
  return args;
}

function runOnce(options) {
  const workspace = makeWorkspace(options);
  const result = childProcess.spawnSync(wrapperBin(), onceArgs(workspace), {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: {
      ...process.env,
      STUB_LOG: workspace.logPath,
      STUB_STATE: workspace.statePath,
    },
  });
  return { result, workspace, calls: stubCalls(workspace) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('--once on Running does nothing and reports the builder hostname', () => {
  const { result, calls } = runOnce({ state: 'Running' });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(calls.includes('status --json'), `expected a status query, got: ${calls.join(', ')}`);
  assert.ok(
    !calls.some((call) => call.startsWith('up')),
    'Running must not call tailscale up',
  );
  assert.match(
    result.stderr,
    new RegExp(`tailnet is running as ${escapeRegExp(BUILDER_HOSTNAME)}`),
    'the wrapper must report the builder name it is running as',
  );
});

test('--once on NeedsLogin joins with the hostname, tag, and DNS disabled', () => {
  const { result, calls } = runOnce({ state: 'NeedsLogin' });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const upCalls = calls.filter((call) => call.startsWith('up'));
  assert.deepEqual(
    upCalls,
    [
      `up --auth-key=${CREDENTIAL_VALUE}?ephemeral=false&preauthorized=true --advertise-tags=${BUILDER_TAG} --hostname=${BUILDER_HOSTNAME} --accept-dns=false`,
    ],
    'the wrapper must join with the host-declared name and tag, and never accept tailnet DNS',
  );
  assert.ok(
    !`${result.stdout}${result.stderr}`.includes(CREDENTIAL_VALUE),
    'the credential value must never be logged',
  );
});

test('--once without the credential names its runtime path and never joins', () => {
  // Even a backend that claims Running must not hide missing material: the
  // credential is checked before any state decision.
  const { result, workspace, calls } = runOnce({ credential: null, state: 'Running' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(escapeRegExp(workspace.credentialPath)));
  assert.ok(
    !calls.some((call) => call.startsWith('up')),
    'a missing credential must never reach tailscale up',
  );
});

test('--once against an unresponsive daemon fails without joining', () => {
  const { result, calls } = runOnce({ state: 'FAIL' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tailscale status failed/);
  assert.ok(
    !calls.some((call) => call.startsWith('up')),
    'an unreadable status must not trigger tailscale up',
  );
});
