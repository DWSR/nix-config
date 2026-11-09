'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nixEvalJson, repoRoot } = require('./helpers');

function evaluateGuest() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      vm = flake.nixosConfigurations.fabro-vm.config;
      dispatch = vm.systemd.services.fabro-darwin-builders;
      daemon = vm.systemd.services.nix-daemon;
      image = vm.fabro.sandboxImage;
    in {
      dispatchOptions = vm.fabro.darwinBuilder;
      dispatchEnabled = vm.fabro.darwinBuilder.enable;
      distributedBuilds = vm.nix.distributedBuilds;
      maxJobs = vm.nix.settings.max-jobs;
      buildMachines = vm.nix.buildMachines;
      builders = vm.nix.settings.builders;
      buildersUseSubstitutes = vm.nix.settings.builders-use-substitutes;
      dispatchUnit = {
        type = dispatch.serviceConfig.Type;
        runtimeDirectory = dispatch.serviceConfig.RuntimeDirectory;
        runtimeDirectoryPreserve = dispatch.serviceConfig.RuntimeDirectoryPreserve or null;
        after = dispatch.after;
        wants = dispatch.wants;
        before = dispatch.before;
        execStart = dispatch.serviceConfig.ExecStart;
      };
      daemonOrdering = {
        after = daemon.after;
        wants = daemon.wants;
        requires = daemon.requires;
      };
      tmpfiles = vm.systemd.tmpfiles.rules;
      secrets = {
        client = {
          path = vm.sops.secrets."build-client-key".path;
          mode = vm.sops.secrets."build-client-key".mode;
          owner = vm.sops.secrets."build-client-key".owner;
          group = vm.sops.secrets."build-client-key".group;
          restartUnits = vm.sops.secrets."build-client-key".restartUnits;
        };
        linuxClient = {
          path = vm.sops.secrets."linux-builder-client-key".path;
          mode = vm.sops.secrets."linux-builder-client-key".mode;
          owner = vm.sops.secrets."linux-builder-client-key".owner;
          group = vm.sops.secrets."linux-builder-client-key".group;
          restartUnits = vm.sops.secrets."linux-builder-client-key".restartUnits;
        };
        host = {
          path = vm.sops.secrets."build-host-key".path;
          mode = vm.sops.secrets."build-host-key".mode;
          owner = vm.sops.secrets."build-host-key".owner;
          group = vm.sops.secrets."build-host-key".group;
          restartUnits = vm.sops.secrets."build-host-key".restartUnits;
        };
      };
      mounts = vm.virtualisation.containers.containersConf.settings.containers.mounts;
      imageEnv = image.imageConfig.Env;
      wiringText = builtins.toJSON {
        mounts = vm.virtualisation.containers.containersConf.settings.containers.mounts;
        imageConfig = image.imageConfig;
        sandbox = {
          image = vm.virtualisation.containers.containersConf.settings.containers;
          extraOptions = vm.virtualisation.podman.extraPackages or [ ];
        };
        sandboxImage = {
          name = image.name;
          tag = image.tag;
          imageConfig = image.imageConfig;
          contents = map (package: package.name or package.pname or "") image.contents;
          copyToRoot = image.copyToRoot.name;
          archive = image.archive.name;
        };
        imageContents = map (package: package.name or package.pname or "") image.contents;
        copyToRoot = image.copyToRoot.name;
      };
      onePasswordSecrets = vm.fabro.onePasswordSecrets;
    }
  `);
}

function evaluateGuestWithDispatchDisabled() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      vm = flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [ ({ lib, ... }: { fabro.darwinBuilder.enable = lib.mkForce false; }) ];
      };
      cfg = vm.config;
    in {
      options = cfg.fabro.darwinBuilder;
      serviceExists = builtins.hasAttr "fabro-darwin-builders" cfg.systemd.services;
    }
  `);
}

function assertBuilderSecretMappings(secrets) {
  assert.equal(secrets['build-client-key'], 'op://Infrastructure/Fabro nix remote builder key/private key');
  assert.equal(secrets['build-host-key'], 'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key');
  assert.equal(secrets['linux-builder-client-key'], 'op://Infrastructure/Fabro Linux nix remote builder key/private key');
}

function assertSandboxBoundary({ wiringText, sandboxSource, imageSource }) {
  const forbidden = /build-client-key|build-host-key|\/run\/secrets\/|tailscale|tailnet|tag:fabro|tag:nix-remote-builder/i;
  assert.doesNotMatch(wiringText, forbidden);
  assert.doesNotMatch(sandboxSource, forbidden);
  assert.doesNotMatch(imageSource, forbidden);
}

test('guest dispatch options expose the dedicated Linux builder inputs', () => {
  const config = evaluateGuest();

  assert.equal(config.dispatchOptions.linuxMachine.hostName, 'linux-builder.tuxedo-musical.ts.net');
  assert.equal(config.dispatchOptions.linuxMachine.system, 'aarch64-linux');
  assert.equal(config.dispatchOptions.linuxMachine.maxJobs, 4);
  assert.equal(config.dispatchOptions.linuxClientKeyPath, '/run/secrets/linux-builder-client-key');
  assert.match(config.dispatchOptions.linuxHostKeyPath, /\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub$/);
  assert.equal(config.dispatchOptions.machinesFile, '/run/fabro-darwin-builders/machines');
  assert.match(config.dispatchUnit.execStart, /--linux-host-name linux-builder\.tuxedo-musical\.ts\.net/);
  assert.match(config.dispatchUnit.execStart, /--linux-system aarch64-linux/);
  assert.match(config.dispatchUnit.execStart, /--linux-max-jobs 4/);
  assert.match(config.dispatchUnit.execStart, /--linux-client-key \/run\/secrets\/linux-builder-client-key/);
  assert.match(config.dispatchUnit.execStart, /--linux-host-key \/nix\/store\/[^\s]+-source\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub/);
});

test('guest dispatch option defaults remain available when dispatch is disabled', () => {
  const { options, serviceExists } = evaluateGuestWithDispatchDisabled();

  assert.equal(options.enable, false);
  assert.equal(options.linuxMachine.hostName, 'linux-builder.tuxedo-musical.ts.net');
  assert.equal(options.linuxMachine.system, 'aarch64-linux');
  assert.equal(options.linuxMachine.maxJobs, 4);
  assert.equal(options.linuxClientKeyPath, '/run/secrets/linux-builder-client-key');
  assert.match(options.linuxHostKeyPath, /\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub$/);
  assert.equal(options.machine.hostName, 'mac-builder.tuxedo-musical.ts.net');
  assert.equal(options.machine.sshUser, 'nix-builder');
  assert.equal(options.machine.system, 'aarch64-darwin');
  assert.equal(options.machine.maxJobs, 4);
  assert.equal(options.machine.speedFactor, 2);
  assert.equal(options.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(options.hostKeyPath, '/run/secrets/build-host-key');
  assert.equal(options.machinesFile, '/run/fabro-darwin-builders/machines');
  assert.equal(serviceExists, false);
});

test('fabro-vm enables dispatch and Nix distributed builds from the real configuration', () => {
  const config = evaluateGuest();

  assert.equal(config.dispatchEnabled, true);
  assert.equal(config.dispatchOptions.machine.hostName, 'mac-builder.tuxedo-musical.ts.net');
  assert.equal(config.dispatchOptions.machine.sshUser, 'nix-builder');
  assert.equal(config.dispatchOptions.machine.system, 'aarch64-darwin');
  assert.equal(config.dispatchOptions.machine.maxJobs, 4);
  assert.equal(config.dispatchOptions.machine.speedFactor, 2);
  assert.equal(config.dispatchOptions.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(config.dispatchOptions.hostKeyPath, '/run/secrets/build-host-key');
  assert.equal(config.dispatchOptions.linuxClientKeyPath, '/run/secrets/linux-builder-client-key');
  assert.match(config.dispatchOptions.linuxHostKeyPath, /\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub$/);
  assert.equal(config.dispatchOptions.machinesFile, '/run/fabro-darwin-builders/machines');
  assert.equal(config.distributedBuilds, true);
  assert.equal(config.maxJobs, 0);
  assert.deepEqual(config.buildMachines, []);
  assert.equal(config.builders, `@${config.dispatchOptions.machinesFile}`);
  assert.ok(config.builders.startsWith('@'));
  assert.ok(!config.builders.includes('/nix/store/'));
  assert.equal(config.buildersUseSubstitutes, true);
  assert.match(config.dispatchUnit.execStart, /--host-name mac-builder\.tuxedo-musical\.ts\.net/);
  assert.match(config.dispatchUnit.execStart, /--system aarch64-darwin/);
  assert.match(config.dispatchUnit.execStart, /--speed-factor 2/);
  assert.ok(config.daemonOrdering.after.includes('fabro-darwin-builders.service'));
});

test('renderer unit ordering, daemon ordering, and tmpfiles provision the machines file', () => {
  const config = evaluateGuest();

  assert.equal(config.dispatchUnit.type, 'oneshot');
  assert.equal(config.dispatchUnit.runtimeDirectory, 'fabro-darwin-builders');
  assert.equal(config.dispatchUnit.runtimeDirectoryPreserve, 'yes');
  assert.ok(config.dispatchUnit.after.includes('sops-install-secrets.service'));
  assert.ok(config.dispatchUnit.wants.includes('sops-install-secrets.service'));
  assert.ok(config.dispatchUnit.before.includes('nix-daemon.service'));
  assert.ok(config.daemonOrdering.wants.includes('fabro-darwin-builders.service'));
  assert.ok(config.daemonOrdering.after.includes('fabro-darwin-builders.service'));
  assert.ok(!config.daemonOrdering.requires.includes('fabro-darwin-builders.service'));
  assert.ok(
    config.tmpfiles.includes('f /run/fabro-darwin-builders/machines 0600 root root - -'),
  );
});

test('live validator restarts the guest daemon and allows its temporary local Nix expression import', () => {
  const validator = fs.readFileSync(path.join(repoRoot, 'scripts/fabro-darwin-live-validate.nix'), 'utf8');
  assert.match(validator, /lima_sudo "\$guest" systemctl restart nix-daemon\.service/);
  assert.match(validator, /Guest machines file is missing/);
  assert.match(validator, /nix build --no-link --impure --expr/);
});

test('both build secrets are declared at root-only runtime paths with unit restarts', () => {
  const { secrets, onePasswordSecrets } = evaluateGuest();

  assert.deepEqual(secrets.client, {
    path: '/run/secrets/build-client-key',
    mode: '0400',
    owner: 'root',
    group: 'root',
    restartUnits: ['fabro-darwin-builders.service', 'nix-daemon.service'],
  });
  assert.deepEqual(secrets.host, {
    path: '/run/secrets/build-host-key',
    mode: '0400',
    owner: 'root',
    group: 'root',
    restartUnits: ['fabro-darwin-builders.service', 'nix-daemon.service'],
  });
  assert.deepEqual(secrets.linuxClient, {
    path: '/run/secrets/linux-builder-client-key',
    mode: '0400',
    owner: 'root',
    group: 'root',
    restartUnits: ['fabro-darwin-builders.service', 'nix-daemon.service'],
  });
  assertBuilderSecretMappings(onePasswordSecrets);
});

test('sandbox wiring retains exactly the shared store, daemon socket, and tmpfs mounts', () => {
  const { mounts } = evaluateGuest();

  assert.deepEqual(mounts, [
    'type=bind,source=/nix/store,destination=/nix/store,ro',
    'type=bind,source=/nix/var/nix/daemon-socket,destination=/nix/var/nix/daemon-socket',
    'type=tmpfs,destination=/tmp',
  ]);
});

test('sandbox image uses the host Nix daemon and contains no builder trust or tailnet wiring', () => {
  const { imageEnv, wiringText } = evaluateGuest();
  const sandboxSource = fs.readFileSync(path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix'), 'utf8');
  const imageSource = fs.readFileSync(path.join(repoRoot, 'configurations/fabro-vm/sandbox-image.nix'), 'utf8');

  assert.ok(imageEnv.includes('NIX_REMOTE=daemon'));
  assertSandboxBoundary({ wiringText, sandboxSource, imageSource });
});

test('boundary assertions reject a missing 1Password mapping and leaked sandbox materials', () => {
  const mappings = {
    'build-client-key': 'op://Infrastructure/Fabro nix remote builder key/private key',
    'build-host-key': 'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key',
    'linux-builder-client-key': 'op://Infrastructure/Fabro Linux nix remote builder key/private key',
  };
  const sandbox = { wiringText: '{}', sandboxSource: '', imageSource: '' };

  assert.throws(() => assertBuilderSecretMappings({ ...mappings, 'build-client-key': undefined }));
  assert.throws(() => assertBuilderSecretMappings({ ...mappings, 'linux-builder-client-key': undefined }));
  assert.throws(() => assertSandboxBoundary({ ...sandbox, wiringText: '{"imageConfig":{"Env":["BUILDER_KEY=/run/secrets/build-client-key"]}}' }));
  assert.throws(() => assertSandboxBoundary({ ...sandbox, wiringText: '{"imageConfig":{"Env":["TAILSCALE_AUTH_KEY=... "]}}' }));
});
