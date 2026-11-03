'use strict';

// Secret-material and build-session trust checks
// (mac-builder-for-fabro-nix-darwin-builds, task 5.4; design "Testing Strategy
// → Render and evaluation", "Data Models → Machines File", and "Security
// Considerations"; requirements 6.3, 6.4, 6.5, 6.11, 6.13, 7.4, 8.3).
//
// The dispatch contract has two halves that must never collapse into one
// artifact: the machines line carries the client key *path*, and the builder
// admits a session only through `builder-authorized-keys`. These cases drive
// the real renderer with poisoned key files and execute the evaluated builder
// activation script in a fixture directory, so a key value that replaced a
// path, or an authorized-keys file that kept a foreign key, fails the suite.
//
// The activation fixture rewrites only the two literal paths and drops the two
// `-o nix-builder -g staff` owner/group flags: the repository checks run as an
// unprivileged Linux user with no macOS `nix-builder` account, while the
// guard, the replacement, and the installed content stay exactly what the
// builder runs. Every rewrite asserts its source line first, so a drift in the
// real activation fails the suite instead of silently degrading the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { nixEvalJson } = require('./helpers');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

// Unmistakable values: if any of them reaches an evaluated artifact or the
// rendered machines line, the assertion below names it.
const POISONED_CLIENT_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'POISONED_CLIENT_KEY_MATERIAL_9d4b',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');
const POISONED_HOST_KEY = 'ssh-ed25519 AAAAPOISONEDHOSTKEYMATERIAL9d4b mac-builder\n';
const POISONED_AUTHORIZED_KEY =
  'ssh-ed25519 AAAAOUTSIDEAUTHORIZEDKEYMATERIAL9d4b outsider@example.invalid\n';
const POISON_MARKERS = [
  'POISONED_CLIENT_KEY_MATERIAL_9d4b',
  'POISONEDHOSTKEYMATERIAL9d4b',
  'OUTSIDEAUTHORIZEDKEYMATERIAL9d4b',
];

const MACHINES_FILE = '/run/fabro-darwin-builders/machines';
const CLIENT_KEY_PATH = '/run/secrets/build-client-key';
const HOST_KEY_PATH = '/run/secrets/build-host-key';
const AUTHORIZED_KEYS_PATH = '/run/secrets/builder-authorized-keys';
const PUBLIC_SUBSTITUTERS = [
  'https://cache.nixos.org/',
  'https://nix-community.cachix.org',
];

const guestSelection = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  guest = flake.nixosConfigurations."fabro-vm".config;
  unit = guest.systemd.services.fabro-darwin-builders;
in
{
  machinesFile = guest.fabro.darwinBuilder.machinesFile;
  builders = guest.nix.settings.builders;
  distributedBuilds = guest.nix.distributedBuilds;
  buildMachines = guest.nix.buildMachines;
  hasEtcMachines = guest.environment.etc ? "nix/machines";
  etcNames = builtins.attrNames guest.environment.etc;
  tmpfilesRules = guest.systemd.tmpfiles.rules;
  execStart = unit.serviceConfig.ExecStart;
  runtimeDirectory = unit.serviceConfig.RuntimeDirectory;
  clientKeyPath = guest.fabro.darwinBuilder.clientKeyPath;
  hostKeyPath = guest.fabro.darwinBuilder.hostKeyPath;
  after = unit.after;
  wants = unit.wants;
}
`;

const builderSelection = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  builder = flake.darwinConfigurations."mac-builder".config;
  authorized = builder.sops.secrets."builder-authorized-keys";
  oauth = builder.sops.secrets."builder-tailscale-oauth-secret";
  sshdNames = builtins.filter
    (name: builtins.match "ssh/sshd_config\\.d/.*" name != null)
    (builtins.attrNames builder.environment.etc);
in
{
  activationText = builder.system.activationScripts.postActivation.text;
  sshEnable = builder.services.openssh.enable;
  sshExtraConfig = builder.services.openssh.extraConfig;
  sshdConfigs = builtins.listToAttrs (map
    (name: { inherit name; value = builder.environment.etc.\${name}.text; })
    sshdNames);
  trustedUsers = builder.nix.settings.trusted-users;
  extraPlatforms = builder.nix.settings.extra-platforms or null;
  builderUser = {
    inherit (builder.users.users.nix-builder) uid gid shell;
    isAdmin = builder.users.users."nix-builder".isAdmin or false;
  };
  authorizedSecret = { inherit (authorized) path mode owner group; };
  oauthSecret = { inherit (oauth) path mode owner group; };
  sopsSecretNames = builtins.attrNames builder.sops.secrets;
  substituters = builder.nix.settings.substituters or [ ];
  trustedPublicKeys = builder.nix.settings.trusted-public-keys or [ ];
  extraSubstituters = builder.nix.settings.extra-substituters or [ ];
  accessTokens = builder.nix.settings.access-tokens or null;
  postBuildHook = builder.nix.settings.post-build-hook or null;
  netrcExists = builder.environment.etc ? "nix/netrc";
  etcNames = builtins.attrNames builder.environment.etc;
  authCommand = builder.launchd.daemons.mac-builder-tailscale-auth.command;
  tailscaledCommand = builder.launchd.daemons.tailscaled.command;
  authWrapperSource = builtins.readFile ${repoRoot}/scripts/mac-builder-tailscale-auth.nix;
}
`;

let cachedGuest = null;
let cachedBuilder = null;

function guestReport() {
  if (!cachedGuest) {
    cachedGuest = nixEvalJson(guestSelection, { timeout: NIX_TIMEOUT_MS });
  }
  return cachedGuest;
}

function builderReport() {
  if (!cachedBuilder) {
    cachedBuilder = nixEvalJson(builderSelection, { timeout: NIX_TIMEOUT_MS });
  }
  return cachedBuilder;
}

let cachedRendererBin = null;

function rendererBin() {
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

// Renders one machines line from poisoned key files, so the assertions can
// prove the line carries the path and not the material.
function renderPoisonedMachinesLine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-secret-material-'));
  const clientKeyPath = path.join(dir, 'build-client-key');
  const hostKeyPath = path.join(dir, 'build-host-key');
  const outputPath = path.join(dir, 'machines');
  fs.writeFileSync(clientKeyPath, POISONED_CLIENT_KEY);
  fs.writeFileSync(hostKeyPath, POISONED_HOST_KEY);

  const result = childProcess.spawnSync(
    rendererBin(),
    [
      '--output', outputPath,
      '--host-name', 'mac-builder.tuxedo-musical.ts.net',
      '--ssh-user', 'nix-builder',
      '--system', 'aarch64-darwin',
      '--max-jobs', '4',
      '--speed-factor', '2',
      '--client-key', clientKeyPath,
      '--host-key', hostKeyPath,
    ],
    { encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  return {
    clientKeyPath,
    line: fs.readFileSync(outputPath, 'utf8').trimEnd(),
  };
}

function assertNoPoison(label, value) {
  for (const marker of POISON_MARKERS) {
    assert.ok(
      !value.includes(marker),
      `${marker} leaked into ${label}`,
    );
  }
}

// Slices the evaluated `postActivation` text down to the builder's own
// authorized-keys block and rewrites the two literal paths so the guard can run
// in a fixture directory. The owner/group flags are the only other rewrite (the
// checks have no macOS `nix-builder` account); everything the guard and the
// install do is executed verbatim.
function fixtureActivationScript(report) {
  const marker = `secret_file="${AUTHORIZED_KEYS_PATH}"\n`;
  const index = report.activationText.indexOf(marker);
  assert.notEqual(
    index,
    -1,
    'the builder activation must read builder-authorized-keys from its runtime path',
  );
  assert.match(
    report.activationText.slice(0, index),
    /set -euo pipefail\n$/,
    'the authorized-keys activation must run with set -euo pipefail so a failed install aborts activation',
  );

  let script = `set -euo pipefail\n${report.activationText.slice(index)}`;
  script = script
    .replace(marker, 'secret_file="$FIXTURE_SECRET_FILE"\n')
    .replace('ssh_dir="/Users/nix-builder/.ssh"\n', 'ssh_dir="$FIXTURE_SSH_DIR"\n');

  assert.ok(script.includes('secret_file="$FIXTURE_SECRET_FILE"'), 'missing the fixture secret replacement');
  assert.ok(script.includes('ssh_dir="$FIXTURE_SSH_DIR"'), 'missing the fixture ssh-dir replacement');

  const ownerFlags = script.match(/ -o nix-builder -g staff/g) ?? [];
  assert.equal(
    ownerFlags.length,
    2,
    'the activation must install the ssh directory and authorized_keys for nix-builder',
  );

  const fixture = script.replaceAll(' -o nix-builder -g staff', '');
  assert.doesNotMatch(fixture, /-o nix-builder/, 'the fixture must not depend on a host nix-builder user');
  return fixture;
}

function runActivation(report, { secret, omitSecret = false, existingAuthorizedKeys } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-activation-'));
  const secretPath = path.join(dir, 'builder-authorized-keys');
  const sshDir = path.join(dir, 'Users', 'nix-builder', '.ssh');
  const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

  if (!omitSecret) fs.writeFileSync(secretPath, secret ?? '');

  if (existingAuthorizedKeys !== undefined) {
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(authorizedKeysPath, existingAuthorizedKeys);
  }

  const result = childProcess.spawnSync('bash', ['-c', fixtureActivationScript(report)], {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: {
      ...process.env,
      FIXTURE_SECRET_FILE: secretPath,
      FIXTURE_SSH_DIR: sshDir,
    },
  });

  return { result, dir, secretPath, sshDir, authorizedKeysPath };
}

test('the machines file is runtime state outside the store and /etc, selected by an @ path', { timeout: NIX_TIMEOUT_MS }, () => {
  const guest = guestReport();

  assert.equal(guest.machinesFile, MACHINES_FILE);
  assert.ok(guest.machinesFile.startsWith('/run/'), 'the machines file must live in runtime state');
  assert.ok(!guest.machinesFile.startsWith('/nix/store'), 'the machines file must not be a store path');
  assert.ok(!guest.machinesFile.startsWith('/etc'), 'the machines file must not be an /etc path');

  assert.equal(guest.distributedBuilds, true, 'the guest daemon must read the machines file');
  assert.equal(guest.builders, `@${MACHINES_FILE}`, 'builders must reference the file by @ path');
  assert.deepEqual(
    guest.buildMachines,
    [],
    'no evaluation-time machine entry may render /etc/nix/machines',
  );
  assert.equal(
    guest.hasEtcMachines,
    false,
    'the machines line must not be rendered into /etc at evaluation time',
  );
  assert.ok(
    !guest.etcNames.includes('nix/machines'),
    `environment.etc must not declare nix/machines, got ${JSON.stringify(guest.etcNames)}`,
  );

  assert.equal(guest.runtimeDirectory, 'fabro-darwin-builders');
  assert.ok(
    guest.tmpfilesRules.includes(`f ${MACHINES_FILE} 0600 root root -`),
    'the daemon needs a root-only machines file before the renderer succeeds',
  );
  assert.ok(guest.execStart.includes(`--output ${MACHINES_FILE}`));
  assert.ok(guest.after.includes('sops-install-secrets.service'));
  assert.ok(guest.wants.includes('sops-install-secrets.service'));
});

test('the rendered machines line carries the client key path, never a key value', { timeout: NIX_TIMEOUT_MS }, () => {
  const guest = guestReport();
  const rendered = renderPoisonedMachinesLine();
  const fields = rendered.line.split(' ');

  assert.equal(fields.length, 8, `unexpected machines line: ${rendered.line}`);
  assert.equal(fields[0], 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net');
  assert.equal(fields[1], 'aarch64-darwin');
  assert.equal(fields[2], rendered.clientKeyPath, 'the client key must be referenced by path');
  assert.equal(fields[3], '4');
  assert.equal(fields[4], '2');
  assert.equal(fields[5], '-');
  assert.equal(fields[6], '-');
  assert.equal(
    fields[7],
    Buffer.from(POISONED_HOST_KEY).toString('base64'),
    'the pinned host key must be the base64 of the host key file',
  );
  assert.notEqual(fields[7], '-', 'the machines line must never fall back to an unpinned host key');

  assert.ok(rendered.line.includes(rendered.clientKeyPath));
  assert.ok(!rendered.line.includes(POISONED_CLIENT_KEY.trim()), 'the client key value must not be rendered');
  assertNoPoison('the rendered machines line', rendered.line);

  // The evaluated unit receives the two runtime paths as arguments; a value in
  // their place would mean the line was built at evaluation time.
  assert.ok(guest.execStart.includes(`--client-key ${CLIENT_KEY_PATH}`));
  assert.ok(guest.execStart.includes(`--host-key ${HOST_KEY_PATH}`));
  assert.equal(guest.clientKeyPath, CLIENT_KEY_PATH);
  assert.equal(guest.hostKeyPath, HOST_KEY_PATH);
  assertNoPoison('the renderer unit', guest.execStart);
});

test('poisoned build-secret values never reach the guest configuration or the builder activation', { timeout: NIX_TIMEOUT_MS }, () => {
  const guest = guestReport();
  const builder = builderReport();

  // Even when the renderer is fed poisoned files, the evaluated guest still
  // names only the runtime paths the daemon reads.
  const guestArtifacts = {
    builders: guest.builders,
    execStart: guest.execStart,
    tmpfiles: guest.tmpfilesRules.join('\n'),
    machinesFile: guest.machinesFile,
    clientKeyPath: guest.clientKeyPath,
    hostKeyPath: guest.hostKeyPath,
  };
  for (const [name, value] of Object.entries(guestArtifacts)) {
    assertNoPoison(`the guest ${name}`, value);
  }
  assert.ok(guest.builders.startsWith('@'), 'builders must be the @ path, not a rendered line');
  assert.ok(
    !guest.builders.includes('ssh-ng://') && !guest.builders.includes('PRIVATE KEY'),
    'the daemon setting must not embed a machines line or key material',
  );
  assert.equal(guest.clientKeyPath, CLIENT_KEY_PATH);
  assert.equal(guest.hostKeyPath, HOST_KEY_PATH);

  // The builder reads its authorized keys from the runtime path only.
  assert.equal(builder.authorizedSecret.path, AUTHORIZED_KEYS_PATH);
  assert.ok(builder.activationText.includes(`secret_file="${AUTHORIZED_KEYS_PATH}"`));
  assert.ok(builder.activationText.includes('ssh_dir="/Users/nix-builder/.ssh"'));
  assert.ok(builder.activationText.includes('authorized_keys="$ssh_dir/authorized_keys"'));
  assertNoPoison('the builder activation', builder.activationText);
  assert.doesNotMatch(
    builder.activationText,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    'the builder activation must never embed a private key',
  );
  assert.doesNotMatch(
    builder.activationText,
    /\bssh-ed25519 AAAA[A-Za-z0-9+/]{20,}/,
    'the builder activation must never embed a concrete public key value',
  );
});

test('the builder activation fails when builder-authorized-keys is missing or empty', { timeout: NIX_TIMEOUT_MS }, () => {
  const builder = builderReport();

  for (const [label, options] of [
    ['missing', { omitSecret: true }],
    ['empty', { secret: '' }],
  ]) {
    const run = runActivation(builder, options);

    assert.notEqual(run.result.status, 0, `a ${label} authorized-keys secret must fail activation`);
    assert.match(
      run.result.stderr,
      new RegExp(`builder-authorized-keys is missing or empty at ${run.secretPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'the activation must name the runtime path of the missing material',
    );
    assert.equal(
      fs.existsSync(run.authorizedKeysPath),
      false,
      `a ${label} secret must leave no authorized_keys file behind`,
    );
  }

  const success = runActivation(builder, { secret: POISONED_AUTHORIZED_KEY });

  assert.equal(success.result.status, 0, `${success.result.stdout}\n${success.result.stderr}`);
  assert.equal(
    fs.readFileSync(success.authorizedKeysPath, 'utf8'),
    POISONED_AUTHORIZED_KEY,
    'the authorized keys must be exactly the secret contents',
  );
  assert.equal(fs.statSync(success.authorizedKeysPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(success.sshDir).mode & 0o777, 0o700);
});

test('a client key outside the authorized set is refused, not added to it', { timeout: NIX_TIMEOUT_MS }, () => {
  const builder = builderReport();

  // The activation keeps its guarantee only if it replaces the file rather
  // than appending to whatever an earlier run (or an operator) left there.
  assert.doesNotMatch(
    builder.activationText,
    />>/,
    'the authorized-keys activation must replace the file, never append',
  );

  const run = runActivation(builder, {
    secret: POISONED_HOST_KEY,
    existingAuthorizedKeys: POISONED_AUTHORIZED_KEY,
  });

  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  const installed = fs.readFileSync(run.authorizedKeysPath, 'utf8');
  assert.equal(installed, POISONED_HOST_KEY, 'only the secret contents may remain authorized');
  assert.ok(
    !installed.includes('OUTSIDEAUTHORIZEDKEYMATERIAL9d4b'),
    'a client key outside builder-authorized-keys must be refused',
  );

  // sshd's only authentication path is the replaced key file behind the
  // non-admin builder user; no CA, password, or empty-password path may widen
  // the set.
  assert.equal(builder.sshEnable, true);
  assert.match(builder.sshExtraConfig, /PasswordAuthentication no/);
  assert.match(builder.sshExtraConfig, /KbdInteractiveAuthentication no/);
  assert.match(builder.sshExtraConfig, /PermitRootLogin no/);
  assert.equal(builder.builderUser.uid, 502);
  assert.equal(builder.builderUser.isAdmin, false);
  assert.equal(builder.builderUser.shell, '/bin/zsh');

  const sshdConfig = Object.values(builder.sshdConfigs).join('\n');
  assert.doesNotMatch(sshdConfig, /TrustedUserCAKeys/, 'no CA may authorize an unlisted key');
  assert.doesNotMatch(sshdConfig, /PermitEmptyPasswords/, 'no empty-password path may bypass the key set');
  assert.doesNotMatch(sshdConfig, /AuthorizedKeysFile\s+none/);
  assert.doesNotMatch(sshdConfig, /tailscale/i, 'tailnet tooling must not supply authorized keys');

  // The builder user is the only non-root trusted user.
  assert.deepEqual(
    [...builder.trustedUsers].sort(),
    ['nix-builder', 'root'],
    'the builder user must be the only non-root trusted user',
  );
});

test('the builder never treats tailnet node identity as session authentication', { timeout: NIX_TIMEOUT_MS }, () => {
  const builder = builderReport();

  assert.doesNotMatch(builder.authCommand, /--ssh\b/, 'the auth daemon must not enable Tailscale SSH');
  assert.doesNotMatch(builder.authCommand, /\bssh\b/, 'the auth daemon must not run an SSH helper');
  assert.doesNotMatch(builder.tailscaledCommand, /--ssh\b/, 'tailscaled must not enable Tailscale SSH');

  assert.doesNotMatch(
    builder.authWrapperSource,
    /--ssh\b/,
    'the auth wrapper must never pass --ssh to tailscale up',
  );
  assert.doesNotMatch(
    builder.authWrapperSource,
    /tailscale['"]?\s+ssh\b/,
    'the auth wrapper must never invoke tailscale ssh',
  );

  // Node identity is not an authorized-key source: the only configured
  // AuthorizedKeysCommand is nix-darwin's cat of a local directory, and the
  // builder activation installs the key file at the user's sshd path.
  const sshdCommand = Object.values(builder.sshdConfigs)
    .map((text) => text.split('\n').filter((line) => line.startsWith('AuthorizedKeysCommand')))
    .flat()
    .join('\n');
  assert.ok(!sshdCommand.includes('tailscale'), `unexpected AuthorizedKeysCommand: ${sshdCommand}`);
  assert.ok(
    builder.activationText.includes(`install -m 0600 -o nix-builder -g staff "$secret_file" "$authorized_keys"`),
    'the session key must come from builder-authorized-keys at activation',
  );
});

test('the builder holds no private-cache reference or credential', { timeout: NIX_TIMEOUT_MS }, () => {
  const builder = builderReport();

  assert.deepEqual(
    [...new Set(builder.substituters)],
    PUBLIC_SUBSTITUTERS,
    'the builder must substitute only from its two public caches',
  );
  // nix-darwin's defaults merge with the module, so compare the unique set.
  const trustedKeys = [...new Set(builder.trustedPublicKeys)];
  assert.equal(trustedKeys.length, 2, `unexpected trusted keys: ${JSON.stringify(trustedKeys)}`);
  for (const key of trustedKeys) {
    assert.match(
      key,
      /^(cache\.nixos\.org-1:|nix-community\.cachix\.org-1:)/,
      `unexpected trusted public key: ${key}`,
    );
  }
  assert.deepEqual(builder.extraSubstituters, [], 'no extra substituter may name a private cache');
  assert.equal(builder.postBuildHook, null, 'the builder must not publish outputs');

  const tokens = builder.accessTokens;
  assert.ok(
    tokens === null || Object.keys(tokens).length === 0,
    'the builder must hold no cache credential',
  );
  assert.equal(builder.netrcExists, false, 'the builder must not carry a cache netrc');

  assert.deepEqual(
    [...builder.sopsSecretNames].sort(),
    ['builder-authorized-keys', 'builder-tailscale-oauth-secret'],
    'the builder store must hold no cache credential',
  );
  assert.equal(builder.oauthSecret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(builder.oauthSecret.mode, '0400');

  for (const name of builder.etcNames) {
    assert.doesNotMatch(
      name,
      /(^|\/)(netrc|attic|binary-cache|.*cache.*credential)/i,
      `unexpected private-cache artifact in /etc: ${name}`,
    );
  }
  for (const url of builder.substituters) {
    assert.ok(
      !/attic|fabro|private|cache\.tuxedo/i.test(url),
      `a private cache URL must not appear in substituters: ${url}`,
    );
  }
});
