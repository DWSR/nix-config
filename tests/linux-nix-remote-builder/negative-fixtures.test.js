'use strict';

// Combined negative-fixture suite for task 6.4. Every checked-in fixture under
// `fixtures/` perturbs exactly one required setting, so this suite proves the
// named invariant fails for that setting while the existing Darwin path is
// still asserted independently. The fixtures are evaluated through the real
// flake configurations, not synthesized objects.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { nixEvalJson, repoRoot } = require('./helpers');

const fixtureDirectory = path.join(repoRoot, 'tests/linux-nix-remote-builder/fixtures');
const nixString = (value) => JSON.stringify(value);
const fixtureModule = (name, args = '') =>
  `(import ${nixString(path.join(fixtureDirectory, `${name}.nix`))} { ${args} })`;

const darwinEndpoint = 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net';
const linuxEndpoint = 'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net';
const linuxSystem = 'aarch64-linux';
const linuxClientKeyPath = '/run/secrets/linux-builder-client-key';
const darwinClientKeyPath = '/run/secrets/mac-builder-ssh-private-key';
const darwinHostKeyBase64 =
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';

function evaluateBuilderHost(extraModules = []) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      cfg = (flake.nixosConfigurations.linux-builder.extendModules {
        modules = [ ${extraModules.join('\n')} ];
      }).config;
    in
    {
      hostPlatform = cfg.nixpkgs.hostPlatform.system;
      extraPlatforms = cfg.nix.settings.extra-platforms;
    }
  `);
}

function evaluateFabro(extraModules = []) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      cfg = (flake.nixosConfigurations.fabro-vm.extendModules {
        modules = [ ${extraModules.join('\n')} ];
      }).config;
    in
    {
      machine = cfg.fabro.darwinBuilder.machine;
      linuxMachine = cfg.fabro.darwinBuilder.linuxMachine;
      clientKeyPath = cfg.fabro.darwinBuilder.clientKeyPath;
      hostKeyPath = cfg.fabro.darwinBuilder.hostKeyPath;
      linuxClientKeyPath = cfg.fabro.darwinBuilder.linuxClientKeyPath;
      maxJobs = cfg.nix.settings.max-jobs;
      distributedBuilds = cfg.nix.distributedBuilds;
      builders = cfg.nix.settings.builders;
      buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes;
    }
  `);
}

function evaluatePersonalHost(extraModules = []) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      lib = flake.inputs.nixpkgs.lib;
      cfg = (flake.darwinConfigurations."Brandons-MacBook-Pro".extendModules {
        modules = [ ${extraModules.join('\n')} ];
      }).config;
      buildersValue = cfg.nix.settings.builders;
      buildersText =
        if lib.hasPrefix "@" buildersValue
        then builtins.readFile (lib.removePrefix "@" buildersValue)
        else buildersValue;
    in
    {
      builder = {
        cpus = cfg.home-manager.users.brandonmcnama.virtualisation.limaLinuxBuilder.cpus;
        memory = cfg.home-manager.users.brandonmcnama.virtualisation.limaLinuxBuilder.memory;
        disk = cfg.home-manager.users.brandonmcnama.virtualisation.limaLinuxBuilder.disk;
      };
      maxJobs = cfg.nix.settings.max-jobs;
      distributedBuilds = cfg.nix.distributedBuilds;
      buildersText = buildersText;
    }
  `);
}

// Shared invariants. Each one names the requirement it protects so a fixture
// can prove that its perturbed setting is the one that fails the check.
function assertBuilderCapability(config) {
  assert.equal(
    config.hostPlatform,
    'aarch64-linux',
    'the Linux builder must be a native aarch64-linux NixOS host (Requirements 1.1, 1.3, 5.1)',
  );
  assert.deepEqual(
    config.extraPlatforms,
    [],
    'the Linux builder must not advertise extra execution platforms (Requirement 1.2)',
  );
}

function assertVmResources(builder) {
  assert.equal(builder.cpus, 4, 'the Linux builder VM must allocate 4 CPUs (Requirements 2.1, 5.2)');
  assert.equal(builder.memory, '8GiB', 'the Linux builder VM must allocate 8 GiB (Requirements 2.2, 5.2)');
  assert.equal(builder.disk, '128GiB', 'the Linux builder VM must allocate 128 GiB (Requirements 2.3, 5.2)');
}

function assertFabroLinuxDispatch(config) {
  assert.equal(
    config.linuxMachine.hostName,
    'linux-builder.tuxedo-musical.ts.net',
    'Fabro must dispatch aarch64-linux builds to the Linux builder (Requirement 3.1)',
  );
  assert.equal(
    config.linuxMachine.system,
    linuxSystem,
    'the Fabro Linux machine entry must support only aarch64-linux (Requirements 1.2, 3.1)',
  );
  assert.equal(config.linuxMachine.maxJobs, 4, 'the Fabro Linux entry must allow four remote jobs (Requirement 3.1)');
  assert.equal(
    config.linuxClientKeyPath,
    linuxClientKeyPath,
    'the Fabro Linux entry must reference the dedicated runtime client key (Requirement 3.1)',
  );
  assert.equal(
    config.builders,
    '@/run/fabro-darwin-builders/machines',
    'Fabro must read the combined runtime machines file (Requirement 3.1)',
  );
}

function assertFabroNoLocalBuildPolicy(config) {
  assert.equal(
    config.maxJobs,
    0,
    'Fabro must set max-jobs = 0 so builds never fall back to local jobs (Requirements 4.1, 4.2, 5.4)',
  );
  assert.equal(config.distributedBuilds, true, 'Fabro must retain distributed builds (Requirement 4.3)');
  assert.equal(
    config.buildersUseSubstitutes,
    true,
    'Fabro must retain builder substitutes (Requirement 4.3)',
  );
}

function assertDarwinDispatchUnchanged(machine) {
  assert.deepEqual(
    machine,
    {
      hostName: 'mac-builder.tuxedo-musical.ts.net',
      sshUser: 'nix-builder',
      system: 'aarch64-darwin',
      maxJobs: 4,
      speedFactor: 2,
    },
    'the existing Fabro Darwin machine entry must remain unchanged (Requirement 3.3)',
  );
}

function personalRecords(config) {
  const records = config.buildersText.trimEnd().split('\n');
  assert.equal(
    records.length,
    2,
    'the personal builders file must contain the Darwin and Linux machine records (Requirement 3.3)',
  );
  return records.map((line) => line.split(' '));
}

function assertPersonalDarwinDispatchUnchanged(config) {
  const [darwin] = personalRecords(config);
  assert.equal(darwin[0], darwinEndpoint, 'the existing Darwin machine entry must keep its endpoint (Requirement 3.3)');
  assert.equal(darwin[1], 'aarch64-darwin', 'the existing Darwin machine entry must keep its system (Requirement 3.3)');
  assert.equal(darwin[2], darwinClientKeyPath, 'the existing Darwin machine entry must keep its runtime key (Requirement 3.3)');
  assert.equal(darwin[3], '8', 'the existing Darwin machine entry must keep its eight jobs (Requirement 3.3)');
  assert.equal(darwin[4], '1', 'the existing Darwin machine entry must keep its speed factor (Requirement 3.3)');
  assert.equal(darwin[7], darwinHostKeyBase64, 'the existing Darwin host-key pin must not change (Requirement 3.3)');
}

function assertPersonalLinuxDispatch(config) {
  const [, linux] = personalRecords(config);
  assert.equal(linux[0], linuxEndpoint, 'the personal Mac must dispatch aarch64-linux to the Linux builder (Requirement 3.2)');
  assert.equal(linux[1], linuxSystem, 'the personal Linux entry must support only aarch64-linux (Requirements 1.2, 3.2)');
  assert.equal(
    linux[2],
    linuxClientKeyPath,
    'the personal Linux entry must reference the dedicated runtime SOPS key path (Requirement 3.2)',
  );
  assert.equal(linux[3], '4', 'the personal Linux entry must allow four remote jobs (Requirement 3.2)');
  assert.equal(linux[4], '1', 'the personal Linux entry must use speed factor 1 (Requirement 3.2)');
}

function assertPersonalNoLocalBuildPolicy(config) {
  assert.equal(config.maxJobs, 0, 'the personal host must keep max-jobs = 0 (Requirements 3.2, 3.3)');
  assert.equal(
    config.distributedBuilds,
    false,
    'the personal host must not enable global distributed builds (Requirement 3.3)',
  );
}

test('the unmodified builder, VM, and client wiring passes every combined invariant', () => {
  const builder = evaluateBuilderHost();
  assertBuilderCapability(builder);

  const personal = evaluatePersonalHost();
  assertVmResources(personal.builder);
  assertPersonalDarwinDispatchUnchanged(personal);
  assertPersonalLinuxDispatch(personal);
  assertPersonalNoLocalBuildPolicy(personal);

  const fabro = evaluateFabro();
  assertFabroLinuxDispatch(fabro);
  assertFabroNoLocalBuildPolicy(fabro);
  assertDarwinDispatchUnchanged(fabro.machine);
});

test('a wrong builder platform fails the builder-capability check', () => {
  const builder = evaluateBuilderHost([
    fixtureModule('builder-capability', 'hostPlatform = "x86_64-linux";'),
  ]);

  assert.equal(builder.hostPlatform, 'x86_64-linux', 'the fixture must really change the platform');
  assert.throws(() => assertBuilderCapability(builder), /native aarch64-linux/);
});

test('an extra builder execution platform fails the builder-capability check', () => {
  const builder = evaluateBuilderHost([
    fixtureModule('builder-capability', 'extraPlatforms = [ "x86_64-linux" ];'),
  ]);

  assert.deepEqual(builder.extraPlatforms, ['x86_64-linux'], 'the fixture must really add a platform');
  assert.throws(() => assertBuilderCapability(builder), /extra execution platforms/);
});

for (const [name, argument, expected] of [
  ['CPU', 'cpus = 2;', /4 CPUs/],
  ['memory', 'memory = "4GiB";', /8 GiB/],
  ['disk', 'disk = "64GiB";', /128 GiB/],
]) {
  test(`a changed Linux builder ${name} allocation fails the VM-resource check`, () => {
    const personal = evaluatePersonalHost([fixtureModule('vm-resources', argument)]);

    assert.throws(() => assertVmResources(personal.builder), expected);
    // The Darwin record must stay correct even when the VM resource drifts.
    assertPersonalDarwinDispatchUnchanged(personal);
    assertPersonalLinuxDispatch(personal);
  });
}

test('a Fabro Linux route on an unsupported system fails the dispatch check', () => {
  const fabro = evaluateFabro([
    fixtureModule('fabro-client-dispatch', 'system = "aarch64-darwin";'),
  ]);

  assert.equal(fabro.linuxMachine.system, 'aarch64-darwin', 'the fixture must really change the Linux system');
  assert.throws(() => assertFabroLinuxDispatch(fabro), /only aarch64-linux/);
  // The existing Darwin path stays independently asserted.
  assertDarwinDispatchUnchanged(fabro.machine);
  assertFabroNoLocalBuildPolicy(fabro);
});

test('a Fabro Linux client key outside the runtime path fails the dispatch check', () => {
  const fabro = evaluateFabro([
    fixtureModule('fabro-client-dispatch', 'clientKeyPath = "/tmp/linux-builder-client-key";'),
  ]);

  assert.equal(
    fabro.linuxClientKeyPath,
    '/tmp/linux-builder-client-key',
    'the fixture must really change the Linux client key path',
  );
  assert.throws(() => assertFabroLinuxDispatch(fabro), /dedicated runtime client key/);
  assertDarwinDispatchUnchanged(fabro.machine);
});

test('a nonzero Fabro local job limit fails the no-local-build policy check', () => {
  const fabro = evaluateFabro([fixtureModule('fabro-policy', 'maxJobs = 2;')]);

  assert.equal(fabro.maxJobs, 2, 'the fixture must really change max-jobs');
  assert.throws(() => assertFabroNoLocalBuildPolicy(fabro), /max-jobs = 0/);
  assertFabroLinuxDispatch(fabro);
  assertDarwinDispatchUnchanged(fabro.machine);
});

test('a personal Linux route on an unsupported system fails the dispatch check', () => {
  const personal = evaluatePersonalHost([
    fixtureModule('personal-client-dispatch', 'system = "aarch64-darwin";'),
  ]);

  assert.match(
    personal.buildersText,
    /ssh-ng:\/\/builder@linux-builder\.tuxedo-musical\.ts\.net aarch64-darwin /,
    'the fixture must really change the personal Linux system',
  );
  assert.throws(() => assertPersonalLinuxDispatch(personal), /only aarch64-linux/);
  // The Darwin record and VM resources stay independently asserted.
  assertPersonalDarwinDispatchUnchanged(personal);
  assertVmResources(personal.builder);
});
