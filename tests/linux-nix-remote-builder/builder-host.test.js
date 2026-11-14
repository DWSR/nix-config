'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { nixEvalJson, repoRoot } = require('./helpers');

function evalBuilder(extraModule = null) {
  const host = extraModule
    ? `flake.nixosConfigurations.linux-builder.extendModules { modules = [ (${extraModule}) ]; }`
    : `flake.nixosConfigurations.linux-builder`;
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      host = ${host};
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
      wheelNeedsPassword = cfg.security.sudo.wheelNeedsPassword;
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
        sopsFileContext = builtins.getContext "\${cfg.sops.secrets."builder-authorized-keys".sopsFile}";
        owner = cfg.sops.secrets."builder-authorized-keys".owner;
        mode = cfg.sops.secrets."builder-authorized-keys".mode;
      };
      tailscaleSecret = {
        path = cfg.sops.secrets."builder-tailscale-oauth-secret".path;
        owner = cfg.sops.secrets."builder-tailscale-oauth-secret".owner;
        mode = cfg.sops.secrets."builder-tailscale-oauth-secret".mode;
      };
      sopsActivation = {
        enabled = cfg.sops.useSystemdActivation;
        installerServiceExists = cfg.systemd.services ? sops-install-secrets;
        installerPreStart = (cfg.systemd.services.sops-install-secrets or { }).preStart or "";
        installerWantedBy = (cfg.systemd.services.sops-install-secrets or { }).wantedBy or [ ];
        ageKeyFile = cfg.sops.age.keyFile;
      };
      tailscale = {
        enable = cfg.services.tailscale.enable;
        openFirewall = cfg.services.tailscale.openFirewall;
        authKeyFile = cfg.services.tailscale.authKeyFile;
      };
      tailscaleAuthService = {
        after = cfg.systemd.services.builder-tailscale-auth.after;
        requires = cfg.systemd.services.builder-tailscale-auth.requires;
        script = cfg.systemd.services.builder-tailscale-auth.script;
        serviceConfig = cfg.systemd.services.builder-tailscale-auth.serviceConfig;
        tailscaleCli = "\${cfg.services.tailscale.package}/bin/tailscale";
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
      # The portable host must not depend on the personal host's Lima modules.
      hasLimaVM = cfg.virtualisation ? limaVM;
      hasLimaMacGuest = cfg.virtualisation ? limaMacGuest;
    }
  `;

  return nixEvalJson(expression);
}

// Shared invariant checks so a test-only overlay can prove that a perturbed
// host render is rejected instead of silently passing the suite.
function assertNativeBuilderPlatform(cfg) {
  assert.equal(
    cfg.hostPlatform,
    'aarch64-linux',
    'linux-builder must evaluate as a native aarch64-linux NixOS host (Requirements 1.1, 1.3, 5.1)',
  );
  assert.deepEqual(
    cfg.extraPlatforms,
    [],
    'linux-builder must not advertise any extra execution platform (Requirement 1.2)',
  );
}

test('linux-builder is a native, standalone NixOS remote builder', () => {
  const cfg = evalBuilder();

  assertNativeBuilderPlatform(cfg);
  assert.equal(cfg.nixEnabled, true);
  assert.ok(cfg.experimentalFeatures.includes('nix-command'));
  assert.ok(cfg.experimentalFeatures.includes('flakes'));
  assert.equal(cfg.maxJobs, 4);
  assert.equal(cfg.buildUsersGroup, 'nixbld');
  // Only the dedicated non-root builder account is trusted for remote builds.
  assert.deepEqual(cfg.trustedUsers, ['builder']);
  assert.equal(cfg.wheelNeedsPassword, false, 'the Lima operator user must retain passwordless sudo');
  assert.equal(cfg.hostName, 'linux-builder');
  assert.equal(cfg.builderUser.isNormalUser, true);
  assert.equal(cfg.builderUser.isSystemUser, false);
  assert.equal(cfg.builderUser.group, 'builder');
  assert.equal(cfg.builderUser.createHome, true);
  assert.deepEqual(cfg.builderUser.extraGroups ?? [], []);
});

test('a wrong builder platform is rejected', () => {
  const cfg = evalBuilder(`{ lib, ... }: {
    nixpkgs.hostPlatform = lib.mkForce "x86_64-linux";
  }`);

  // The fixture must really change the platform before the invariant is run.
  assert.equal(cfg.hostPlatform, 'x86_64-linux');

  assert.throws(
    () => assertNativeBuilderPlatform(cfg),
    /native aarch64-linux/,
  );
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
  assert.equal(cfg.ssh.settings.KbdInteractiveAuthentication, false);
  assert.equal(cfg.builderSecret.path, '/run/secrets/builder-authorized-keys');
  assert.match(cfg.builderSecret.sopsFile, /(linux-builder-unprovisioned-secrets|remote-builder\.linux-builder)\.yaml$/);
  assert.ok(
    Object.keys(cfg.builderSecret.sopsFileContext).length > 0,
    'the SOPS manifest must retain the selected source file as a derivation input',
  );
  assert.equal(cfg.builderSecret.owner, 'root');
  assert.equal(cfg.builderSecret.mode, '0400');
  assert.equal(cfg.tailscaleSecret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(cfg.tailscaleSecret.owner, 'root');
  assert.equal(cfg.tailscaleSecret.mode, '0400');
  assert.equal(cfg.sopsActivation.enabled, true);
  assert.equal(cfg.sopsActivation.installerServiceExists, true);
  assert.ok(cfg.sopsActivation.installerWantedBy.includes('sysinit.target'));
  assert.match(cfg.sopsActivation.installerPreStart, /required.*(key|secret)|missing.*(key|secret)/i);
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

test('SOPS activation fails clearly when the encrypted store or age key is missing', () => {
  const cfg = evalBuilder();
  const preStart = cfg.sopsActivation.installerPreStart;

  assert.match(preStart, /required encrypted SOPS store is missing or empty/);
  assert.match(preStart, /required SOPS age key is missing/);
  assert.match(preStart, /secrets\/remote-builder\.linux-builder\.yaml/);
  assert.match(preStart, /\/var\/lib\/sops-nix\/key\.txt/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-sops-'));
  try {
    const scriptPath = path.join(tempRoot, 'sops-pre-start');
    fs.writeFileSync(scriptPath, preStart, { mode: 0o700 });

    const provisionedRoot = path.join(tempRoot, 'repo');
    const storePath = path.join(provisionedRoot, 'secrets/remote-builder.linux-builder.yaml');
    const keyPath = path.join(tempRoot, 'age-key.txt');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '');
    fs.writeFileSync(keyPath, 'fixture age key');
    const configuredStorePath = preStart.match(/required encrypted SOPS store is missing or empty at (.*); provision it/)[1];
    const provisionedScript = preStart
      .replaceAll(configuredStorePath, storePath)
      .replaceAll('/var/lib/sops-nix/key.txt', keyPath);
    fs.writeFileSync(scriptPath, provisionedScript, { mode: 0o700 });
    const emptyStore = childProcess.spawnSync('/bin/bash', [scriptPath], { encoding: 'utf8' });
    assert.notEqual(emptyStore.status, 0);
    assert.match(emptyStore.stderr, /required encrypted SOPS store is missing or empty/);

    fs.writeFileSync(storePath, 'fixture encrypted store');
    fs.writeFileSync(keyPath, 'fixture age key');

    const provisioned = childProcess.spawnSync('/bin/bash', [scriptPath], { encoding: 'utf8' });
    assert.equal(provisioned.status, 0, provisioned.stderr);

    fs.rmSync(keyPath);
    const missingKey = childProcess.spawnSync('/bin/bash', [scriptPath], { encoding: 'utf8' });
    assert.notEqual(missingKey.status, 0);
    assert.match(missingKey.stderr, /required SOPS age key is missing/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Tailscale and Nix maintenance are configured without Lima dependencies', () => {
  const cfg = evalBuilder();

  assert.equal(cfg.tailscale.enable, true);
  assert.equal(cfg.tailscale.openFirewall, true);
  assert.equal(cfg.tailscale.authKeyFile, null);
  assert.ok(cfg.tailscaleAuthService.after.includes('sops-install-secrets.service'));
  assert.ok(cfg.tailscaleAuthService.requires.includes('sops-install-secrets.service'));
  assert.ok(cfg.tailscaleAuthService.after.includes('tailscaled.service'));
  assert.ok(cfg.tailscaleAuthService.requires.includes('tailscaled.service'));
  assert.equal(cfg.tailscaleAuthService.serviceConfig.Type, 'oneshot');
  assert.equal(cfg.tailscaleAuthService.serviceConfig.TimeoutStartSec, '0');
  assert.match(cfg.tailscaleAuthService.script, /tailscale up/);
  assert.match(cfg.tailscaleAuthService.script, /--auth-key=/);
  assert.match(cfg.tailscaleAuthService.script, /\?ephemeral=false&preauthorized=true/);
  assert.match(cfg.tailscaleAuthService.script, /--advertise-tags=tag:nix-remote-builder/);
  assert.match(cfg.tailscaleAuthService.script, /--hostname=linux-builder/);
  assert.doesNotMatch(cfg.tailscaleAuthService.script, /builder-tailscale-oauth-client-id/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-tailscale-'));
  try {
    const credentialPath = path.join(tempRoot, 'oauth-secret');
    const mockTailscale = path.join(tempRoot, 'tailscale');
    const scriptPath = path.join(tempRoot, 'builder-tailscale-auth');
    const capturePath = path.join(tempRoot, 'tailscale-args');
    fs.writeFileSync(mockTailscale, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE_FILE"\n', { mode: 0o700 });
    const mockSleep = path.join(tempRoot, 'sleep');
    fs.writeFileSync(mockSleep, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const script = cfg.tailscaleAuthService.script
      .replaceAll(cfg.tailscaleAuthService.tailscaleCli, mockTailscale)
      .replaceAll('/run/current-system/sw/bin/sleep', mockSleep)
      .replaceAll(cfg.tailscaleSecret.path, credentialPath);
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    const missingCredential = childProcess.spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CAPTURE_FILE: capturePath },
    });
    assert.notEqual(missingCredential.status, 0);
    assert.match(missingCredential.stderr, /Tailscale OAuth credential is missing or empty/);

    fs.writeFileSync(credentialPath, 'fixture-oauth-client-secret');
    const enrolled = childProcess.spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CAPTURE_FILE: capturePath },
    });
    assert.equal(enrolled.status, 0, enrolled.stderr);
    const args = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
    assert.ok(args.includes('--auth-key=fixture-oauth-client-secret?ephemeral=false&preauthorized=true'));
    assert.ok(args.includes('--hostname=linux-builder'));
    assert.ok(args.includes('--advertise-tags=tag:nix-remote-builder'));
    assert.ok(args.includes('--accept-dns=false'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(cfg.garbageCollection.automatic, true);
  assert.deepEqual(cfg.garbageCollection.dates, ['daily']);
  assert.equal(cfg.garbageCollection.options, '--delete-older-than 7d');
  assert.equal(cfg.optimisation.automatic, true);
  assert.deepEqual(cfg.optimisation.dates, ['daily']);

  // Lima provisioning and lifecycle belong to the personal host, never to the
  // portable builder host: neither Lima module's options exist here.
  assert.equal(cfg.hasLimaVM, false);
  assert.equal(cfg.hasLimaMacGuest, false);

  const source = fs.readFileSync(path.join(repoRoot, 'configurations/linux-builder/default.nix'), 'utf8');
  assert.doesNotMatch(source, /lima/i);
  assert.doesNotMatch(source, /limactl/);
  assert.doesNotMatch(source, /builtins\.readFile/);
  assert.doesNotMatch(source, /authorizedKeys\.keys/);
});
