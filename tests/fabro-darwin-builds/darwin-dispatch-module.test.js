'use strict';

// Evaluation tests for `configurations/fabro-vm/darwin-dispatch.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 1.2; design "Component
// Contracts → Guest Dispatch → `fabro.darwinBuilder` module"; requirements
// 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.7, 3.1, 3.2, 3.3, 3.6, 6.11, 7.5, 7.6).
//
// The module is not imported by `configurations/fabro-vm/default.nix` until
// task 1.3, so every case evaluates it through `extendModules` on the real
// guest configuration. The `enable = false` evaluation proves the option
// defaults and that an untouched guest has no dispatch wiring; the
// `enable = true` evaluation proves the unit, ordering, tmpfiles, and
// daemon settings while the sandbox and tailnet modules stay identical.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const modulePath = path.join(repoRoot, 'configurations/fabro-vm/darwin-dispatch.nix');
const NIX_TIMEOUT_MS = 600_000;

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
}

function evalGuest(enable) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      extended = flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [
          (import ${JSON.stringify(modulePath)})
          { fabro.darwinBuilder.enable = flake.inputs.nixpkgs.lib.mkForce ${enable ? 'true' : 'false'}; }
        ];
      };
      cfg = extended.config;
      builder = cfg.fabro.darwinBuilder;
      unit = cfg.systemd.services."fabro-darwin-builders" or null;
      daemon = cfg.systemd.services."nix-daemon" or { };
      fabroDarwinServices = builtins.filter
        (name: flake.inputs.nixpkgs.lib.hasPrefix "fabro-darwin" name)
        (builtins.attrNames cfg.systemd.services);
    in
    {
      options = {
        enable = builder.enable;
        machine = builder.machine;
        clientKeyPath = builder.clientKeyPath;
        hostKeyPath = builder.hostKeyPath;
        machinesFile = builder.machinesFile;
      };

      distributedBuilds = cfg.nix.distributedBuilds;
      builders = cfg.nix.settings.builders or null;
      buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes or null;
      buildMachines = cfg.nix.buildMachines;
      hasEtcMachines = cfg.environment.etc ? "nix/machines";

      rendererUnit = if unit == null then null else {
        type = unit.serviceConfig.Type or null;
        runtimeDirectory = unit.serviceConfig.RuntimeDirectory or null;
        execStart = unit.serviceConfig.ExecStart or null;
        wants = unit.wants or [ ];
        after = unit.after or [ ];
        before = unit.before or [ ];
      };

      daemonUnit = {
        wants = daemon.wants or [ ];
        after = daemon.after or [ ];
        requires = daemon.requires or [ ];
      };

      fabroDarwinServices = fabroDarwinServices;
      tmpfiles = builtins.filter
        (rule: flake.inputs.nixpkgs.lib.hasPrefix "f /run/fabro-darwin-builders" rule)
        cfg.systemd.tmpfiles.rules;

      sandbox = {
        mounts = cfg.virtualisation.containers.containersConf.settings.containers.mounts;
        imageEnv = cfg.fabro.sandboxImage.imageConfig.Env;
      };

      tailscale = {
        enable = cfg.services.tailscale.enable;
        authKeyFile = cfg.services.tailscale.authKeyFile;
        authKeyParameters = cfg.services.tailscale.authKeyParameters;
        extraUpFlags = cfg.services.tailscale.extraUpFlags;
      };
    }
  `);
}

let disabledCache = null;
let enabledCache = null;

function disabledGuest() {
  if (disabledCache === null) disabledCache = evalGuest(false);
  return disabledCache;
}

function enabledGuest() {
  if (enabledCache === null) enabledCache = evalGuest(true);
  return enabledCache;
}

test('option defaults match the design contract while dispatch stays off', () => {
  const { options } = disabledGuest();

  assert.equal(options.enable, false, 'fabro.darwinBuilder.enable must default to false');
  assert.deepEqual(options.machine, {
    hostName: 'mac-builder.tuxedo-musical.ts.net',
    sshUser: 'nix-builder',
    system: 'aarch64-darwin',
    maxJobs: 4,
    speedFactor: 2,
  });
  assert.equal(options.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(options.hostKeyPath, '/run/secrets/build-host-key');
  assert.equal(options.machinesFile, '/run/fabro-darwin-builders/machines');
});

test('disabled dispatch leaves the guest without any build wiring', () => {
  const guest = disabledGuest();

  assert.equal(guest.distributedBuilds, false);
  assert.equal(guest.builders, null);
  assert.equal(guest.rendererUnit, null);
  assert.deepEqual(guest.fabroDarwinServices, []);
  assert.deepEqual(guest.tmpfiles, []);
});

test('enabled dispatch points the daemon at the runtime machines file', () => {
  const guest = enabledGuest();
  const machinesFile = guest.options.machinesFile;

  assert.equal(guest.distributedBuilds, true);
  assert.equal(guest.builders, `@${machinesFile}`);
  assert.equal(guest.buildersUseSubstitutes, true);

  // No eval-time machine list: /etc/nix/machines must not be generated, so the
  // runtime renderer is the only producer of the machines file.
  assert.deepEqual(guest.buildMachines, []);
  assert.equal(guest.hasEtcMachines, false);

  // The single entry is Darwin-only; nothing schedules aarch64-linux remotely.
  assert.equal(guest.options.machine.system, 'aarch64-darwin');
  assert.deepEqual(guest.buildMachines, []);
});

test('renderer unit renders the machines file before the daemon starts', () => {
  const guest = enabledGuest();
  const unit = guest.rendererUnit;

  assert.notEqual(unit, null, 'systemd.services.fabro-darwin-builders must exist');
  assert.equal(unit.type, 'oneshot');
  assert.equal(unit.runtimeDirectory, 'fabro-darwin-builders');

  const execStart = unit.execStart ?? unit.script;
  assert.match(String(execStart), /fabro-darwin-machines/);
  for (const arg of [
    '--output',
    guest.options.machinesFile,
    '--host-name',
    guest.options.machine.hostName,
    '--ssh-user',
    guest.options.machine.sshUser,
    '--system',
    guest.options.machine.system,
    '--max-jobs',
    String(guest.options.machine.maxJobs),
    '--speed-factor',
    String(guest.options.machine.speedFactor),
    '--client-key',
    guest.options.clientKeyPath,
    '--host-key',
    guest.options.hostKeyPath,
  ]) {
    assert.ok(
      String(execStart).includes(arg),
      `renderer command must contain ${JSON.stringify(arg)}, got: ${execStart}`,
    );
  }

  assert.ok(unit.after.includes('sops-install-secrets.service'), 'renderer must start after sops');
  assert.ok(unit.wants.includes('sops-install-secrets.service'), 'renderer must want sops');
  assert.ok(unit.before.includes('nix-daemon.service'), 'renderer must run before nix-daemon');
});

test('nix-daemon wants the renderer without requiring it', () => {
  const guest = enabledGuest();

  assert.ok(
    guest.daemonUnit.wants.includes('fabro-darwin-builders.service'),
    `nix-daemon must want the renderer, got: ${JSON.stringify(guest.daemonUnit)}`,
  );
  assert.ok(
    guest.daemonUnit.after.includes('fabro-darwin-builders.service'),
    `nix-daemon must start after the renderer, got: ${JSON.stringify(guest.daemonUnit)}`,
  );
  assert.ok(
    !guest.daemonUnit.requires.includes('fabro-darwin-builders.service'),
    'a failed renderer must not block nix-daemon or local Linux builds',
  );
});

test('tmpfiles creates a root-only machines file', () => {
  const guest = enabledGuest();

  assert.deepEqual(
    guest.tmpfiles,
    ['f /run/fabro-darwin-builders/machines 0600 root root -'],
    `expected the 0600 root tmpfiles rule, got: ${JSON.stringify(guest.tmpfiles)}`,
  );
});

test('the renderer is the only Darwin dispatch unit', () => {
  const guest = enabledGuest();

  assert.deepEqual(
    guest.fabroDarwinServices,
    ['fabro-darwin-builders'],
    'a dispatch wrapper would replace Nix ssh-ng error reporting; only the renderer may exist',
  );
});

test('enabling dispatch leaves sandbox mounts and the image environment untouched', () => {
  const off = disabledGuest();
  const on = enabledGuest();

  assert.deepEqual(on.sandbox, off.sandbox);
  assert.deepEqual(on.tailscale, off.tailscale);
  assert.equal(
    on.sandbox.mounts.some((mount) => mount.includes('build-client-key')),
    false,
    'no sandbox mount may expose the build client key',
  );
  assert.ok(
    on.sandbox.imageEnv.includes('NIX_REMOTE=daemon'),
    `the sandbox image must keep NIX_REMOTE=daemon, got: ${JSON.stringify(on.sandbox.imageEnv)}`,
  );
});
