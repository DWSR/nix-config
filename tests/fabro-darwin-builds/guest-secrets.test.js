'use strict';

// Evaluation tests for the guest wiring of Darwin dispatch
// (mac-builder-for-fabro-nix-darwin-builds, task 1.3; design "Component
// Contracts → Guest Dispatch → `fabro.darwinBuilder` module" and "Data
// Models → Fabro Secret Store Additions"; requirements 6.8, 6.9, 6.10, 6.11).
//
// The cases evaluate `nixosConfigurations.fabro-vm` (not the module in
// isolation), so they cover what the guest actually ships: the enabled
// dispatch option, the two build-session secrets with their runtime paths,
// modes, owners, restart triggers, and 1Password sources, and the absence of
// key material or key paths from the store, `/etc`, and the sandbox image.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;

// The design's Data Models table: name, runtime path, and 1Password source.
const BUILD_SECRETS = [
  {
    name: 'build-client-key',
    path: '/run/secrets/build-client-key',
    onePasswordUri: 'op://Infrastructure/Fabro mac-builder Build Credentials/Client Private Key',
  },
  {
    name: 'build-host-key',
    path: '/run/secrets/build-host-key',
    onePasswordUri: 'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key',
  },
];

// Both secrets are rotated by restarting the renderer (so the machines line is
// re-rendered) and the daemon (so it re-reads the machines file).
const RESTART_UNITS = ['fabro-darwin-builders.service', 'nix-daemon.service'];

const SELECTION = `
let
  flake = builtins.getFlake (toString REPO_ROOT);
  cfg = flake.nixosConfigurations.fabro-vm.config;
  secret = name:
    if builtins.hasAttr name cfg.sops.secrets then
      let
        s = builtins.getAttr name cfg.sops.secrets;
      in
      {
        declared = true;
        inherit (s) path mode owner group restartUnits;
        sopsFile = toString s.sopsFile;
      }
    else
      { declared = false; };
  dispatch =
    if cfg.fabro ? darwinBuilder then
      {
        declared = true;
        inherit (cfg.fabro.darwinBuilder) enable machinesFile clientKeyPath hostKeyPath;
      }
    else
      { declared = false; };
in
{
  inherit dispatch;
  distributedBuilds = cfg.nix.distributedBuilds;
  builders = cfg.nix.settings.builders or null;
  hasEtcMachines = cfg.environment.etc ? "nix/machines";
  rendererUnit =
    if cfg.systemd.services ? fabro-darwin-builders then
      {
        execStart = cfg.systemd.services.fabro-darwin-builders.serviceConfig.ExecStart or null;
        after = cfg.systemd.services.fabro-darwin-builders.after;
        wants = cfg.systemd.services.fabro-darwin-builders.wants;
      }
    else
      null;
  secrets = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = secret name;
    }) [ "build-client-key" "build-host-key" ]
  );
  onePasswordSecrets = cfg.fabro.onePasswordSecrets;
  undeclaredManifestKeys = builtins.filter (
    name: !(builtins.hasAttr name cfg.sops.secrets)
  ) (builtins.attrNames cfg.fabro.onePasswordSecrets);
  imageEnv = cfg.fabro.sandboxImage.imageConfig.Env;
}`.replace('REPO_ROOT', repoRoot);

let cachedReport = null;

function guestReport() {
  if (cachedReport) return cachedReport;
  cachedReport = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', SELECTION],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
  return cachedReport;
}

test('the guest enables Darwin dispatch on its own nix-daemon', () => {
  const report = guestReport();

  assert.equal(
    report.dispatch.declared,
    true,
    'configurations/fabro-vm/default.nix must import ./darwin-dispatch.nix',
  );
  assert.equal(report.dispatch.enable, true, 'fabro.darwinBuilder.enable must be true on the guest');
  assert.equal(report.distributedBuilds, true, 'nix.distributedBuilds must be on');
  assert.equal(
    report.builders,
    `@${report.dispatch.machinesFile}`,
    'the daemon must read the runtime machines file',
  );
  assert.ok(
    report.rendererUnit,
    'enabling dispatch must declare systemd.services.fabro-darwin-builders',
  );
});

test('both build-session secrets materialize root-only at 0400 at their runtime paths', () => {
  const report = guestReport();

  for (const expected of BUILD_SECRETS) {
    const secret = report.secrets[expected.name];

    assert.equal(secret.declared, true, `sops.secrets.${expected.name} must be declared`);
    assert.equal(secret.path, expected.path, `sops.secrets.${expected.name}.path`);
    assert.equal(secret.mode, '0400', `sops.secrets.${expected.name}.mode`);
    assert.equal(secret.owner, 'root', `sops.secrets.${expected.name}.owner`);
    assert.equal(secret.group, 'root', `sops.secrets.${expected.name}.group`);
    assert.ok(
      secret.sopsFile.endsWith('secrets/fabro.fabro.yaml'),
      `sops.secrets.${expected.name} must come from the fabro store, got ${secret.sopsFile}`,
    );
  }
});

test('rotating a build secret restarts the renderer and the daemon', () => {
  const report = guestReport();

  for (const expected of BUILD_SECRETS) {
    const units = report.secrets[expected.name].restartUnits;

    assert.deepEqual(
      [...units].sort(),
      [...RESTART_UNITS].sort(),
      `sops.secrets.${expected.name}.restartUnits must restart the renderer and the daemon`,
    );
  }
});

test('both build-session secrets are mirrored from their 1Password items', () => {
  const report = guestReport();

  for (const expected of BUILD_SECRETS) {
    assert.equal(
      report.onePasswordSecrets[expected.name],
      expected.onePasswordUri,
      `fabro.onePasswordSecrets.${expected.name} must name the design's 1Password field`,
    );
  }

  assert.deepEqual(
    report.undeclaredManifestKeys,
    [],
    'every 1Password manifest key must have a matching sops.secrets declaration',
  );
});

test('the guest references the keys by runtime path only, outside the store and /etc', () => {
  const report = guestReport();

  assert.equal(report.dispatch.declared, true, 'the guest must import the dispatch module');
  assert.ok(report.rendererUnit, 'dispatch must be enabled so the renderer unit exists');
  const words = report.rendererUnit.execStart.match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));

  for (const expected of BUILD_SECRETS) {
    const optionValue = expected.name === 'build-client-key'
      ? report.dispatch.clientKeyPath
      : report.dispatch.hostKeyPath;

    assert.equal(optionValue, expected.path, `${expected.name} must resolve to its runtime path`);
    assert.ok(
      !expected.path.startsWith('/nix/store'),
      `${expected.name} must not live in the Nix store`,
    );
    assert.ok(
      words.includes(expected.path),
      `the renderer must receive ${expected.name} by path`,
    );
  }

  assert.ok(
    report.dispatch.machinesFile.startsWith('/run/'),
    `the machines file must be runtime state, got ${report.dispatch.machinesFile}`,
  );
  assert.equal(report.builders, `@${report.dispatch.machinesFile}`);
  assert.equal(
    report.hasEtcMachines,
    false,
    'the machines line must not be rendered into /etc at evaluation time',
  );

  // The renderer is the only consumer, and it is ordered after secret
  // materialisation like the module requires.
  assert.ok(report.rendererUnit.wants.includes('sops-install-secrets.service'));
  assert.ok(report.rendererUnit.after.includes('sops-install-secrets.service'));
});

test('the sandbox image carries no build-session key path', () => {
  const report = guestReport();
  const env = report.imageEnv.join('\n');

  assert.ok(env.includes('NIX_REMOTE=daemon'), 'the image keeps talking to the guest daemon');

  for (const expected of BUILD_SECRETS) {
    assert.ok(
      !env.includes(expected.path) && !env.includes(expected.name),
      `the sandbox image environment must not mention ${expected.name}`,
    );
  }
});

test('the encrypted store holds no plaintext build key material', () => {
  const storePath = path.join(repoRoot, 'secrets/fabro.fabro.yaml');
  const lines = fs.readFileSync(storePath, 'utf8').split('\n');

  for (const expected of BUILD_SECRETS) {
    const line = lines.find((candidate) => candidate.startsWith(`${expected.name}:`));

    if (line === undefined) continue; // Provisioned by task 4.2, not by this task.

    assert.match(
      line,
      new RegExp(`^${expected.name}: ENC\\[`),
      `${expected.name} must only appear encrypted in the working tree`,
    );
  }
});
