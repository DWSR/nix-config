'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nixEvalJson, repoRoot } = require('../mac-nix-remote-builder/helpers');

const modulePath = path.join(repoRoot, 'configurations/fabro-vm/darwin-dispatch.nix');
const evalConfig = enabled => nixEvalJson(`
  let
    flake = builtins.getFlake (toString ${repoRoot});
    evaluated = flake.nixosConfigurations.fabro-vm.extendModules {
      modules = [ ({ ... }: {
        imports = [ ${JSON.stringify(modulePath)} ];
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
  const result = evalConfig('false');
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
  const result = evalConfig('true');
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
