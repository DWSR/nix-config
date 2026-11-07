'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nixEvalJson, repoRoot } = require('../mac-nix-remote-builder/helpers');

const evalConfig = enabled => nixEvalJson(`
  let
    flake = builtins.getFlake (toString ${repoRoot});
    evaluated = flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [ ({ lib, ... }: {
          fabro.darwinBuilder.enable = ${enabled};
        ${enabled ? 'fabro.darwinBuilder.clientKeyPath = "/run/test/client-key"; fabro.darwinBuilder.hostKeyPath = "/run/test/host-key";' : ''}
      }) ];
    };
    vm = evaluated.config;
  in {
    options = vm.fabro.darwinBuilder;
    distributedBuilds = vm.nix.distributedBuilds;
    builders = vm.nix.settings.builders or null;
    substitutes = vm.nix.settings.builders-use-substitutes or null;
    buildMachines = vm.nix.buildMachines;
    service = if vm.fabro.darwinBuilder.enable then {
      after = vm.systemd.services.fabro-darwin-builders.after;
      wants = vm.systemd.services.fabro-darwin-builders.wants;
      before = vm.systemd.services.fabro-darwin-builders.before;
      serviceConfig = {
        Type = vm.systemd.services.fabro-darwin-builders.serviceConfig.Type;
        RuntimeDirectory = vm.systemd.services.fabro-darwin-builders.serviceConfig.RuntimeDirectory;
      };
    } else null;
    daemon = {
      wants = vm.systemd.services.nix-daemon.wants;
      after = vm.systemd.services.nix-daemon.after;
      requires = vm.systemd.services.nix-daemon.requires;
    };
    tmpfiles = vm.systemd.tmpfiles.rules;
  }
`);

test('disabled dispatch keeps option defaults and does not enable the unit', () => {
  const result = evalConfig('lib.mkForce false');
  assert.equal(result.options.enable, false);
  assert.equal(result.options.machine.hostName, 'mac-builder.tuxedo-musical.ts.net');
  assert.equal(result.options.machine.sshUser, 'nix-builder');
  assert.equal(result.options.machine.system, 'aarch64-darwin');
  assert.equal(result.options.machine.maxJobs, 4);
  assert.equal(result.options.machine.speedFactor, 2);
  assert.equal(result.options.machinesFile, '/run/fabro-darwin-builders/machines');
  assert.equal(result.service, null);
});

test('enabled dispatch selects the renderer file and orders daemon startup', () => {
  const result = evalConfig('lib.mkForce true');
  assert.equal(result.distributedBuilds, true);
  assert.equal(result.builders, '@' + result.options.machinesFile);
  assert.equal(result.substitutes, true);
  assert.deepEqual(result.buildMachines, []);
  assert.equal(result.service.serviceConfig.Type, 'oneshot');
  assert.equal(result.service.serviceConfig.RuntimeDirectory, 'fabro-darwin-builders');
  assert.ok(result.service.after.includes('sops-install-secrets.service'));
  assert.ok(result.service.wants.includes('sops-install-secrets.service'));
  assert.ok(result.service.before.includes('nix-daemon.service'));
  assert.ok(result.daemon.wants.includes('fabro-darwin-builders.service'));
  assert.ok(result.daemon.after.includes('fabro-darwin-builders.service'));
  assert.ok(!result.daemon.requires.includes('fabro-darwin-builders.service'));
  assert.ok(result.tmpfiles.includes('f /run/fabro-darwin-builders/machines 0600 root root - -'));
});

test('fabro-vm enables dispatch and declares runtime build secrets from 1Password', () => {
  const result = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.config;
    in {
      dispatchImports = builtins.filterSource (name: type: name == "darwin-dispatch.nix") (toString ${repoRoot} + "/configurations/fabro-vm");
      enabled = vm.fabro.darwinBuilder.enable;
      client = {
        path = vm.sops.secrets."build-client-key".path;
        mode = vm.sops.secrets."build-client-key".mode;
        owner = vm.sops.secrets."build-client-key".owner;
        group = vm.sops.secrets."build-client-key".group;
        restartUnits = vm.sops.secrets."build-client-key".restartUnits;
      };
      host = {
        path = vm.sops.secrets."build-host-key".path;
        mode = vm.sops.secrets."build-host-key".mode;
        owner = vm.sops.secrets."build-host-key".owner;
        group = vm.sops.secrets."build-host-key".group;
        restartUnits = vm.sops.secrets."build-host-key".restartUnits;
      };
      uris = vm.fabro.onePasswordSecrets;
    }
  `);
  assert.equal(result.dispatchImports != null, true);
  assert.equal(result.enabled, true);
  for (const secret of [result.client, result.host]) {
    assert.equal(secret.mode, '0400');
    assert.equal(secret.owner, 'root');
    assert.equal(secret.group, 'root');
    assert.deepEqual(secret.restartUnits.sort(), [
      'fabro-darwin-builders.service',
      'nix-daemon.service',
    ]);
  }
  assert.equal(result.client.path, '/run/secrets/build-client-key');
  assert.equal(result.host.path, '/run/secrets/build-host-key');
  assert.equal(result.uris['build-client-key'], 'op://Infrastructure/Fabro mac-builder Build Credentials/Client Private Key');
  assert.equal(result.uris['build-host-key'], 'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key');
});
