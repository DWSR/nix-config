'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function evalBuilder() {
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      host = flake.nixosConfigurations.linux-builder;
      cfg = host.config;
    in
    {
      hostPlatform = cfg.nixpkgs.hostPlatform.system;
      nixEnabled = cfg.nix.enable;
      experimentalFeatures = cfg.nix.settings.experimental-features;
      extraPlatforms = cfg.nix.settings.extra-platforms;
      maxJobs = cfg.nix.settings.max-jobs;
      buildUsersGroup = cfg.nix.settings.build-users-group;
      trustedUsers = cfg.nix.settings.trusted-users;
      builderUser = {
        isNormalUser = cfg.users.users.builder.isNormalUser;
        isSystemUser = cfg.users.users.builder.isSystemUser;
        group = cfg.users.users.builder.group;
        createHome = cfg.users.users.builder.createHome;
        extraGroups = cfg.users.users.builder.extraGroups;
      };
      builderSecret = {
        path = cfg.sops.secrets."builder-authorized-keys".path;
        sopsFile = toString cfg.sops.secrets."builder-authorized-keys".sopsFile;
        owner = cfg.sops.secrets."builder-authorized-keys".owner;
        mode = cfg.sops.secrets."builder-authorized-keys".mode;
      };
      tailscaleSecret = {
        path = cfg.sops.secrets."builder-tailscale-oauth-secret".path;
        owner = cfg.sops.secrets."builder-tailscale-oauth-secret".owner;
        mode = cfg.sops.secrets."builder-tailscale-oauth-secret".mode;
      };
      tailscale = {
        enable = cfg.services.tailscale.enable;
        authKeyFile = cfg.services.tailscale.authKeyFile;
        authKeyParameters = cfg.services.tailscale.authKeyParameters;
        extraUpFlags = cfg.services.tailscale.extraUpFlags;
      };
      ssh = {
        enable = cfg.services.openssh.enable;
        openFirewall = cfg.services.openssh.openFirewall;
        hostKeys = cfg.services.openssh.hostKeys;
        settings = cfg.services.openssh.settings;
      };
      materializer = {
        after = cfg.systemd.services.builder-authorized-keys.after;
        before = cfg.systemd.services.builder-authorized-keys.before;
        requires = cfg.systemd.services.builder-authorized-keys.requires;
        script = cfg.systemd.services.builder-authorized-keys.script;
        serviceConfig = cfg.systemd.services.builder-authorized-keys.serviceConfig;
      };
      sshd = {
        after = cfg.systemd.services.sshd.after;
        requires = cfg.systemd.services.sshd.requires;
      };
      garbageCollection = {
        automatic = cfg.nix.gc.automatic;
        dates = cfg.nix.gc.dates;
        options = cfg.nix.gc.options;
      };
      optimisation = {
        automatic = cfg.nix.optimise.automatic;
        dates = cfg.nix.optimise.dates;
      };
      hostName = cfg.networking.hostName;
    }
  `;

  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

test('linux-builder is a native, standalone NixOS remote builder', () => {
  const cfg = evalBuilder();

  assert.equal(cfg.hostPlatform, 'aarch64-linux');
  assert.equal(cfg.nixEnabled, true);
  assert.ok(cfg.experimentalFeatures.includes('nix-command'));
  assert.ok(cfg.experimentalFeatures.includes('flakes'));
  assert.deepEqual(cfg.extraPlatforms, []);
  assert.equal(cfg.maxJobs, 4);
  assert.equal(cfg.buildUsersGroup, 'nixbld');
  assert.deepEqual(cfg.trustedUsers, ['builder']);
  assert.equal(cfg.hostName, 'linux-builder');
  assert.equal(cfg.builderUser.isNormalUser, true);
  assert.equal(cfg.builderUser.isSystemUser, false);
  assert.equal(cfg.builderUser.group, 'builder');
  assert.equal(cfg.builderUser.createHome, true);
  assert.deepEqual(cfg.builderUser.extraGroups ?? [], []);
});

test('SSH authorization and host identity are delivered outside the Nix store', () => {
  const cfg = evalBuilder();

  assert.equal(cfg.ssh.enable, true);
  assert.equal(cfg.ssh.openFirewall, false);
  assert.deepEqual(cfg.ssh.hostKeys, [
    { path: '/var/lib/ssh/ssh_host_ed25519_key', type: 'ed25519' },
  ]);
  assert.deepEqual(cfg.ssh.settings.AllowUsers, ['builder']);
  assert.equal(cfg.ssh.settings.PermitRootLogin, 'no');
  assert.equal(cfg.ssh.settings.PasswordAuthentication, false);
  assert.equal(cfg.builderSecret.path, '/run/secrets/builder-authorized-keys');
  assert.match(cfg.builderSecret.sopsFile, /linux-builder-(unprovisioned-secrets|remote-builder\.linux-builder\.yaml)\.yaml$/);
  assert.equal(cfg.builderSecret.owner, 'root');
  assert.equal(cfg.builderSecret.mode, '0400');
  assert.equal(cfg.tailscaleSecret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(cfg.tailscaleSecret.owner, 'root');
  assert.equal(cfg.tailscaleSecret.mode, '0400');
  assert.equal(cfg.materializer.serviceConfig.Type, 'oneshot');
  assert.ok(cfg.materializer.after.includes('sops-install-secrets.service'));
  assert.ok(cfg.materializer.requires.includes('sops-install-secrets.service'));
  assert.ok(cfg.materializer.before.includes('sshd.service'));
  assert.ok(cfg.sshd.requires.includes('builder-authorized-keys.service'));
  assert.ok(cfg.sshd.after.includes('builder-authorized-keys.service'));
  assert.match(cfg.materializer.script, /authorized_keys/);
  assert.match(cfg.materializer.script, /install -m 0600/);
  assert.match(cfg.materializer.script, /builder-authorized-keys/);
});

test('Tailscale and Nix maintenance are configured without Lima dependencies', () => {
  const cfg = evalBuilder();

  assert.equal(cfg.tailscale.enable, true);
  assert.equal(cfg.tailscale.authKeyFile, cfg.tailscaleSecret.path);
  assert.equal(cfg.tailscale.authKeyParameters.ephemeral, false);
  assert.equal(cfg.tailscale.authKeyParameters.preauthorized, true);
  assert.ok(cfg.tailscale.extraUpFlags.includes('--hostname=linux-builder'));
  assert.ok(cfg.tailscale.extraUpFlags.includes('--advertise-tags=tag:linux-nix-remote-builder'));
  assert.equal(cfg.garbageCollection.automatic, true);
  assert.equal(cfg.optimisation.automatic, true);

  const source = fs.readFileSync(path.join(repoRoot, 'configurations/linux-builder/default.nix'), 'utf8');
  assert.doesNotMatch(source, /lima/i);
  assert.doesNotMatch(source, /builtins\.readFile/);
  assert.doesNotMatch(source, /authorizedKeys\.keys/);
});
