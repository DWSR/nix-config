'use strict';

// Pure combined check for task 6.4. The flake evaluates the builder, personal
// Mac, and Fabro configurations plus every negative fixture module at flake
// evaluation time and writes the JSON snapshot referenced by
// `LINUX_NIX_REMOTE_BUILDER_DATA_FILE`. This suite asserts the snapshot, so
// the flake check is hermetic: it needs no nested `nix eval`, flake-input
// cache, Darwin builder, or provisioned secret. Direct runs without the
// snapshot skip the suite; `negative-fixtures.test.js` covers the same
// fixtures through nested evaluation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const dataFile = process.env.LINUX_NIX_REMOTE_BUILDER_DATA_FILE;
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null;
const maybeTest = data ? test : test.skip;

const darwinEndpoint = 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net';
const linuxEndpoint = 'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net';
const linuxSystem = 'aarch64-linux';
const personalLinuxClientKeyPath = '/run/secrets/mac-builder-ssh-private-key';
const fabroLinuxClientKeyPath = '/run/secrets/build-client-key';
const darwinClientKeyPath = '/run/secrets/mac-builder-ssh-private-key';
const darwinHostKeyBase64 =
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';
const linuxHostKeyBase64 =
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSUFBQkFnTUVCUVlIQ0FrS0N3d05EZzhRRVJJVEZCVVdGeGdaR2hzY0hSNGYgbGludXgtYnVpbGRlcgo=';

function assertBuilderCapability(builder) {
  assert.equal(
    builder.hostPlatform,
    'aarch64-linux',
    'the Linux builder must be a native aarch64-linux NixOS host (Requirements 1.1, 1.3, 5.1)',
  );
  assert.deepEqual(
    builder.extraPlatforms,
    [],
    'the Linux builder must not advertise extra execution platforms (Requirement 1.2)',
  );
  assert.equal(builder.maxJobs, 4, 'the Linux builder must accept four concurrent jobs (Requirement 1.1)');
  assert.deepEqual(builder.trustedUsers, ['builder'], 'only the dedicated builder account may be trusted (Requirements 1.1, 5.1)');
  assert.equal(builder.hostName, 'linux-builder', 'the Linux builder must keep its stable host identity (Requirement 1.3)');
  assert.equal(builder.ssh.enable, true, 'the Linux builder must enable OpenSSH (Requirement 1.1)');
  assert.equal(builder.ssh.openFirewall, false, 'the builder must not expose SSH outside the tailnet (Requirement 1.3)');
  assert.deepEqual(
    builder.ssh.hostKeys,
    [{ path: '/var/lib/ssh/ssh_host_ed25519_key', type: 'ed25519' }],
    'the builder host key must persist outside the Nix store (Requirement 3.1)',
  );
  assert.deepEqual(builder.ssh.settings.AllowUsers, ['builder'], 'sshd must allow only the builder account (Requirement 1.1)');
  assert.equal(builder.ssh.settings.PermitRootLogin, 'no', 'root SSH must stay disabled (Requirement 1.3)');
  assert.equal(builder.ssh.settings.PasswordAuthentication, false, 'SSH must use keys, not passwords (Requirement 1.3)');
  assert.equal(builder.ssh.settings.KbdInteractiveAuthentication, false, 'SSH must use keys, not passwords (Requirement 1.3)');
  assert.equal(builder.authorizedKeys.path, '/run/secrets/builder-authorized-keys', 'authorized keys must come from the runtime SOPS path (Requirements 1.1, 5.1)');
  assert.equal(builder.authorizedKeys.owner, 'root', 'authorized keys must be root-owned (Requirement 5.1)');
  assert.equal(builder.authorizedKeys.mode, '0400', 'authorized keys must be mode 0400 (Requirement 5.1)');
  assert.equal(builder.tailscaleOauth.path, '/run/secrets/builder-tailscale-oauth-secret', 'the Tailscale credential must come from its runtime SOPS path (Requirement 1.3)');
  assert.equal(builder.tailscaleOauth.owner, 'root', 'the Tailscale credential must be root-owned (Requirement 5.1)');
  assert.equal(builder.tailscaleOauth.mode, '0400', 'the Tailscale credential must be mode 0400 (Requirement 5.1)');
  assert.equal(builder.tailscale.enable, true, 'the Linux builder must join the tailnet (Requirement 1.3)');
  assert.equal(builder.tailscale.openFirewall, true, 'the builder must accept tailnet traffic (Requirement 1.3)');
  assert.equal(builder.gc.automatic, true, 'the builder must garbage-collect its Nix store (Requirement 1.1)');
  assert.deepEqual(builder.gc.dates, ['daily'], 'the builder must garbage-collect daily (Requirement 1.1)');
  assert.equal(builder.gc.options, '--delete-older-than 7d', 'the builder GC must retain seven days (Requirement 1.1)');
  assert.equal(builder.optimise.automatic, true, 'the builder must optimise its Nix store (Requirement 1.1)');
  assert.deepEqual(builder.optimise.dates, ['daily'], 'the builder must optimise daily (Requirement 1.1)');
}

function assertVmResources(builder) {
  assert.equal(builder.cpus, 4, 'the Linux builder VM must allocate 4 CPUs (Requirements 2.1, 5.2)');
  assert.equal(builder.memory, '8GiB', 'the Linux builder VM must allocate 8 GiB (Requirements 2.2, 5.2)');
  assert.equal(builder.disk, '128GiB', 'the Linux builder VM must allocate 128 GiB (Requirements 2.3, 5.2)');
}

function personalRecords(personal) {
  const records = personal.buildersText.trimEnd().split('\n');
  assert.equal(
    records.length,
    2,
    'the personal builders file must contain the Darwin and Linux machine records (Requirement 3.3)',
  );
  return records.map((line) => line.split(' '));
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

function assertPersonalDispatch(personal) {
  const [darwin, linux] = personalRecords(personal);
  assert.equal(darwin.length, 8, `Darwin machine record must have eight fields: ${darwin.join(' ')}`);
  assert.equal(darwin[0], darwinEndpoint, 'the existing Darwin machine entry must keep its endpoint (Requirement 3.3)');
  assert.equal(darwin[1], 'aarch64-darwin', 'the existing Darwin machine entry must keep its system (Requirement 3.3)');
  assert.equal(darwin[2], darwinClientKeyPath, 'the existing Darwin machine entry must keep its runtime key (Requirement 3.3)');
  assert.equal(darwin[3], '8', 'the existing Darwin machine entry must keep its eight jobs (Requirement 3.3)');
  assert.equal(darwin[4], '1', 'the existing Darwin machine entry must keep its speed factor (Requirement 3.3)');
  assert.equal(darwin[7], darwinHostKeyBase64, 'the existing Darwin host-key pin must not change (Requirement 3.3)');

  assert.equal(linux.length, 8, `Linux machine record must have eight fields: ${linux.join(' ')}`);
  assert.equal(linux[0], linuxEndpoint, 'the personal Mac must dispatch aarch64-linux to the Linux builder (Requirement 3.2)');
  assert.equal(linux[1], linuxSystem, 'the personal Linux entry must support only aarch64-linux (Requirements 1.2, 3.2)');
  assert.equal(linux[2], personalLinuxClientKeyPath, 'the personal Linux entry must reference the runtime SOPS key path (Requirement 3.2)');
  assert.equal(linux[3], '4', 'the personal Linux entry must allow four remote jobs (Requirement 3.2)');
  assert.equal(linux[4], '1', 'the personal Linux entry must use speed factor 1 (Requirement 3.2)');
  assert.equal(linux[7], linuxHostKeyBase64, 'the personal Linux entry must carry the pinned builder host key (Requirement 3.2)');

  assert.equal(personal.maxJobs, 0, 'the personal host must keep max-jobs = 0 (Requirements 3.2, 3.3)');
  assert.equal(personal.distributedBuilds, false, 'the personal host must not enable global distributed builds (Requirement 3.3)');
  assert.equal(personal.linuxSecret.path, personalLinuxClientKeyPath, 'the personal Linux client key must use its runtime SOPS path (Requirement 3.2)');
  assert.equal(personal.linuxSecret.owner, 'root', 'the personal Linux client key must be root-owned (Requirement 3.2)');
  assert.equal(personal.linuxSecret.mode, '0400', 'the personal Linux client key must be mode 0400 (Requirement 3.2)');
  assert.match(
    personal.linuxSecret.sopsFile,
    /mac-builder-client\.personal\.yaml$/,
    'the personal Linux client key must reuse the mac builder client key store (Requirement 3.2)',
  );
  assert.equal(personal.darwinSecret.path, darwinClientKeyPath, 'the existing Darwin client key must keep its runtime path (Requirement 3.3)');
  assert.equal(personal.darwinSecret.owner, 'root', 'the existing Darwin client key must stay root-owned (Requirement 3.3)');
  assert.equal(personal.darwinSecret.mode, '0400', 'the existing Darwin client key must stay mode 0400 (Requirement 3.3)');
}

function assertFabroDispatch(fabro) {
  assert.equal(fabro.linuxMachine.hostName, 'linux-builder.tuxedo-musical.ts.net', 'Fabro must dispatch aarch64-linux builds to the Linux builder (Requirement 3.1)');
  assert.equal(fabro.linuxMachine.system, linuxSystem, 'the Fabro Linux machine entry must support only aarch64-linux (Requirements 1.2, 3.1)');
  assert.equal(fabro.linuxMachine.maxJobs, 4, 'the Fabro Linux entry must allow four remote jobs (Requirement 3.1)');
  assert.equal(fabro.linuxClientKeyPath, fabroLinuxClientKeyPath, 'the Fabro Linux entry must reference the runtime client key (Requirement 3.1)');
  assert.equal(fabro.builders, '@/run/fabro-darwin-builders/machines', 'Fabro must read the combined runtime machines file (Requirement 3.1)');
  assert.equal(fabro.maxJobs, 0, 'Fabro must set max-jobs = 0 so builds never fall back to local jobs (Requirements 4.1, 4.2, 5.4)');
  assert.equal(fabro.distributedBuilds, true, 'Fabro must retain distributed builds (Requirement 4.3)');
  assert.equal(fabro.buildersUseSubstitutes, true, 'Fabro must retain builder substitutes (Requirement 4.3)');
  assert.equal(fabro.clientKeyPath, '/run/secrets/build-client-key', 'the existing Darwin client key must keep its runtime path (Requirement 3.3)');
  assert.equal(fabro.hostKeyPath, '/run/secrets/build-host-key', 'the existing Darwin host key must keep its runtime path (Requirement 3.3)');
  assert.equal(fabro.linuxSecret.path, fabroLinuxClientKeyPath, 'the Fabro Linux client key must use its runtime secret path (Requirement 3.1)');
  assert.equal(fabro.linuxSecret.owner, 'root', 'the Fabro Linux client key must be root-owned (Requirement 3.1)');
  assert.equal(fabro.linuxSecret.mode, '0400', 'the Fabro Linux client key must be mode 0400 (Requirement 3.1)');
  assertDarwinDispatchUnchanged(fabro.machine);
}

maybeTest('the combined check data is present and every positive invariant passes', () => {
  assertBuilderCapability(data.builder);
  assertVmResources(data.personal.builder);
  assertPersonalDispatch(data.personal);
  assertFabroDispatch(data.fabro);
});

maybeTest('a wrong builder platform fails the builder-capability check', () => {
  assert.equal(data.negative.builderWrongPlatform.hostPlatform, 'x86_64-linux', 'the fixture must really change the platform');
  assert.throws(() => assertBuilderCapability(data.negative.builderWrongPlatform), /native aarch64-linux/);
});

maybeTest('an extra builder execution platform fails the builder-capability check', () => {
  assert.deepEqual(data.negative.builderExtraPlatform.extraPlatforms, ['x86_64-linux'], 'the fixture must really add a platform');
  assert.throws(() => assertBuilderCapability(data.negative.builderExtraPlatform), /extra execution platforms/);
});

for (const [name, key, expected] of [
  ['CPU', 'vmCpus', /4 CPUs/],
  ['memory', 'vmMemory', /8 GiB/],
  ['disk', 'vmDisk', /128 GiB/],
]) {
  maybeTest(`a changed Linux builder ${name} allocation fails the VM-resource check`, () => {
    assert.throws(() => assertVmResources(data.negative[key].builder), expected);
    // The personal Darwin/Linux machine data must stay intact.
    assertPersonalDispatch(data.negative[key]);
  });
}

maybeTest('a Fabro Linux route on an unsupported system fails the dispatch check', () => {
  assert.equal(data.negative.fabroUnsupportedSystem.linuxMachine.system, 'aarch64-darwin', 'the fixture must really change the Linux system');
  assert.throws(() => assertFabroDispatch(data.negative.fabroUnsupportedSystem), /only aarch64-linux/);
  assertDarwinDispatchUnchanged(data.negative.fabroUnsupportedSystem.machine);
});

maybeTest('a Fabro Linux client key outside the runtime path fails the dispatch check', () => {
  assert.equal(data.negative.fabroInvalidKeyPath.linuxClientKeyPath, '/tmp/linux-builder-client-key', 'the fixture must really change the Linux key path');
  assert.throws(() => assertFabroDispatch(data.negative.fabroInvalidKeyPath), /dedicated runtime client key/);
  assertDarwinDispatchUnchanged(data.negative.fabroInvalidKeyPath.machine);
});

maybeTest('a nonzero Fabro local job limit fails the no-local-build policy check', () => {
  assert.equal(data.negative.fabroNonzeroMaxJobs.maxJobs, 2, 'the fixture must really change max-jobs');
  assert.throws(() => assertFabroDispatch(data.negative.fabroNonzeroMaxJobs), /max-jobs = 0/);
  assertDarwinDispatchUnchanged(data.negative.fabroNonzeroMaxJobs.machine);
});

maybeTest('a personal Linux route on an unsupported system fails the dispatch check', () => {
  assert.match(
    data.negative.personalUnsupportedSystem.buildersText,
    /ssh-ng:\/\/builder@linux-builder\.tuxedo-musical\.ts\.net aarch64-darwin /,
    'the fixture must really change the personal Linux system',
  );
  assert.throws(() => assertPersonalDispatch(data.negative.personalUnsupportedSystem), /only aarch64-linux/);
  assertVmResources(data.negative.personalUnsupportedSystem.builder);
});
