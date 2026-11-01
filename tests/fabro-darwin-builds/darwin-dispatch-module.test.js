'use strict';

// Evaluation tests for `configurations/fabro-vm/darwin-dispatch.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 1.2; design "Component
// Contracts → Guest Dispatch → `fabro.darwinBuilder` module"; requirements
// 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.7, 3.1, 3.2, 3.3, 3.6, 6.11, 7.5, 7.6).
//
// The module owns the guest's machines-file contract: the option surface, the
// `nix.settings.builders = "@<path>"` wiring, the renderer unit and its
// ordering, and the tmpfiles fallback. Every case evaluates the module in a
// standalone NixOS configuration, so the assertions cover what the guest
// evaluates even before `configurations/fabro-vm/default.nix` imports it.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const modulePath = `${repoRoot}/configurations/fabro-vm/darwin-dispatch.nix`;
const NIX_TIMEOUT_MS = 600_000;

// Every evaluated variant reports the same shape, so the individual cases can
// assert on whichever fields the requirement names.
const SELECTION = `{
  enable = config.fabro.darwinBuilder.enable;
  machine = config.fabro.darwinBuilder.machine;
  clientKeyPath = config.fabro.darwinBuilder.clientKeyPath;
  hostKeyPath = config.fabro.darwinBuilder.hostKeyPath;
  machinesFile = config.fabro.darwinBuilder.machinesFile;
  distributedBuilds = config.nix.distributedBuilds;
  builders = config.nix.settings.builders or null;
  buildersUseSubstitutes = config.nix.settings.builders-use-substitutes or null;
  buildMachines = config.nix.buildMachines;
  hasEtcMachines = config.environment.etc ? "nix/machines";
  fabroDarwinServices =
    lib.attrNames (lib.filterAttrs (name: _: lib.hasPrefix "fabro-darwin" name) config.systemd.services);
  rendererUnit =
    if config.systemd.services ? fabro-darwin-builders then
      {
        type = config.systemd.services.fabro-darwin-builders.serviceConfig.Type or null;
        runtimeDirectory =
          config.systemd.services.fabro-darwin-builders.serviceConfig.RuntimeDirectory or null;
        execStart = config.systemd.services.fabro-darwin-builders.serviceConfig.ExecStart or null;
        after = config.systemd.services.fabro-darwin-builders.after;
        wants = config.systemd.services.fabro-darwin-builders.wants;
        before = config.systemd.services.fabro-darwin-builders.before;
        requires = config.systemd.services.fabro-darwin-builders.requires;
      }
    else
      null;
  nixDaemon = {
    after = config.systemd.services.nix-daemon.after;
    wants = config.systemd.services.nix-daemon.wants;
    requires = config.systemd.services.nix-daemon.requires;
    hasServiceExecStart = config.systemd.services.nix-daemon.serviceConfig ? ExecStart;
    script = config.systemd.services.nix-daemon.script or null;
  };
  tmpfilesRules = config.systemd.tmpfiles.rules;
}`;

const variants = new Map();

function evalGuest(extraModulesSource) {
  if (variants.has(extraModulesSource)) return variants.get(extraModulesSource);

  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  lib = flake.inputs.nixpkgs.lib;
  config = (lib.nixosSystem {
    system = builtins.currentSystem;
    modules = [ ${modulePath} ] ++ ${extraModulesSource};
  }).config;
in ${SELECTION}
`;

  const report = JSON.parse(childProcess.execFileSync(
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
  variants.set(extraModulesSource, report);
  return report;
}

const disabled = () => evalGuest('[ ]');
const enabled = () => evalGuest('[ { fabro.darwinBuilder.enable = true; } ]');

// Splits a systemd ExecStart into words, tolerating the quoting `escapeShellArgs`
// adds for unusual characters.
function execStartWords(execStart) {
  assert.equal(typeof execStart, 'string', 'the renderer unit must set a string ExecStart');
  return execStart
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

test('the option surface defaults to a disabled dispatch with the design values', () => {
  const report = disabled();

  assert.equal(report.enable, false);
  assert.deepEqual(report.machine, {
    hostName: 'mac-builder.tuxedo-musical.ts.net',
    sshUser: 'nix-builder',
    system: 'aarch64-darwin',
    maxJobs: 4,
    speedFactor: 2,
  });
  assert.equal(report.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(report.hostKeyPath, '/run/secrets/build-host-key');
  assert.equal(report.machinesFile, '/run/fabro-darwin-builders/machines');
});

test('a disabled module leaves the daemon without distributed builds', () => {
  const report = disabled();

  assert.equal(report.distributedBuilds, false);
  assert.equal(report.builders, null, 'a disabled module must not select a machines file');
  assert.equal(report.rendererUnit, null);
  assert.deepEqual(report.fabroDarwinServices, []);
  assert.ok(
    !report.tmpfilesRules.some((rule) => rule.includes(report.machinesFile)),
    'a disabled module must not create the machines file',
  );
});

test('enabling dispatch selects the runtime machines file for the daemon', () => {
  const report = enabled();

  assert.equal(report.enable, true);
  assert.equal(report.distributedBuilds, true);
  assert.equal(report.builders, `@${report.machinesFile}`);
  assert.equal(report.buildersUseSubstitutes, true);
  assert.deepEqual(report.buildMachines, [], 'eval must not generate /etc/nix/machines');
  assert.equal(report.hasEtcMachines, false, 'no eval-time /etc/nix/machines may exist');
});

test('the single machine entry schedules only aarch64-darwin', () => {
  const report = enabled();

  assert.equal(report.machine.system, 'aarch64-darwin');
  assert.deepEqual(report.buildMachines, [], 'the only machine entry is the rendered machines line');
  assert.equal(report.machine.maxJobs, 4);
  assert.equal(report.machine.speedFactor, 2);
});

test('the renderer unit renders the machines file before the daemon starts', () => {
  const report = enabled();
  const unit = report.rendererUnit;

  assert.ok(unit, 'enabling dispatch must declare systemd.services.fabro-darwin-builders');
  assert.equal(unit.type, 'oneshot');
  assert.equal(unit.runtimeDirectory, 'fabro-darwin-builders');

  assert.ok(unit.wants.includes('sops-install-secrets.service'), 'the renderer must want sops-install-secrets');
  assert.ok(unit.after.includes('sops-install-secrets.service'), 'the renderer must run after sops-install-secrets');
  assert.ok(
    !unit.requires.includes('sops-install-secrets.service'),
    'the renderer must not require sops-install-secrets (activation already pulls it in)',
  );

  assert.ok(unit.before.includes('nix-daemon.service'), 'the renderer must run before nix-daemon');

  const words = execStartWords(unit.execStart);
  assert.match(
    words[0],
    /\/bin\/fabro-darwin-machines$/,
    'the unit must run the fabro-darwin-machines renderer',
  );
  assert.deepEqual(words.slice(1), [
    '--output',
    '/run/fabro-darwin-builders/machines',
    '--host-name',
    'mac-builder.tuxedo-musical.ts.net',
    '--ssh-user',
    'nix-builder',
    '--system',
    'aarch64-darwin',
    '--max-jobs',
    '4',
    '--speed-factor',
    '2',
    '--client-key',
    '/run/secrets/build-client-key',
    '--host-key',
    '/run/secrets/build-host-key',
  ]);
});

test('nix-daemon wants and follows the renderer without requiring it', () => {
  const report = enabled();
  const daemon = report.nixDaemon;

  assert.ok(
    daemon.wants.includes('fabro-darwin-builders.service'),
    'nix-daemon must want the renderer so the machines file exists at start',
  );
  assert.ok(
    daemon.after.includes('fabro-darwin-builders.service'),
    'nix-daemon must be ordered after the renderer',
  );
  assert.ok(
    !daemon.requires.includes('fabro-darwin-builders.service'),
    'a failed renderer must not block local builds',
  );
});

test('tmpfiles creates the machines file 0600 owned by root', () => {
  const report = enabled();
  const rules = report.tmpfilesRules.filter((rule) => rule.includes(report.machinesFile));

  assert.deepEqual(rules, [`f /run/fabro-darwin-builders/machines 0600 root root -`]);
});

test('dispatch stays Nix ssh-ng: no wrapper replaces the daemon command', () => {
  const report = enabled();

  // The daemon reads the machines file itself; the setting is the plain
  // `@<path>` form, never a command wrapper around `nix`.
  assert.match(report.builders, /^@\/\S+$/);
  assert.ok(!/\s/.test(report.builders), 'the builders setting must be a single @<path> token');

  // The renderer unit renders the file; it must not become the build client.
  const words = execStartWords(report.rendererUnit.execStart);
  assert.match(words[0], /\/bin\/fabro-darwin-machines$/);
  assert.ok(
    !words.some((word) => word === 'nix' || word === 'build' || /(^|\/)nix$/.test(word)),
    'the renderer unit must not invoke nix or dispatch builds',
  );

  // The daemon keeps its packaged command: the module only adds ordering.
  assert.equal(report.nixDaemon.hasServiceExecStart, false, 'the module must not replace nix-daemon ExecStart');
  assert.ok(!report.nixDaemon.script, 'the module must not wrap nix-daemon in a script');
  assert.deepEqual(report.fabroDarwinServices, ['fabro-darwin-builders']);
});

test('key paths follow the sops secret declarations when they exist', () => {
  const report = evalGuest(`[
    flake.inputs.sops-nix.nixosModules.default
    {
      sops.secrets."build-client-key".path = "/run/secrets/custom-client-key";
      sops.secrets."build-host-key".path = "/run/secrets/custom-host-key";
    }
    { fabro.darwinBuilder.enable = true; }
  ]`);

  assert.equal(report.enable, true);
  assert.equal(report.clientKeyPath, '/run/secrets/custom-client-key');
  assert.equal(report.hostKeyPath, '/run/secrets/custom-host-key');

  const words = execStartWords(report.rendererUnit.execStart);
  assert.ok(words.includes('/run/secrets/custom-client-key'));
  assert.ok(words.includes('/run/secrets/custom-host-key'));
});
