'use strict';

// Fabro dispatch regression suite for the Linux remote builder
// (task 6.2): the runtime machines renderer must emit the existing Darwin
// record unchanged plus the pinned Linux record, and the Fabro guest must
// route both systems without ever falling back to local build jobs.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { nixEvalJson, repoRoot } = require('./helpers');

const linuxHostName = 'linux-builder.tuxedo-musical.ts.net';
const linuxSystem = 'aarch64-linux';
const linuxClientKeyPath = '/run/secrets/linux-builder-client-key';
const machinesFile = '/run/fabro-darwin-builders/machines';
const pinnedHostKeyPattern = /\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub$/;
const fixtureLinuxHostKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n';

function buildRenderer() {
  // Evaluate the renderer's generated shell text instead of building a
  // derivation so the suite also runs inside the sandboxed flake check.
  const text = childProcess.execFileSync(
    'nix',
    [
      'eval',
      '--raw',
      '--impure',
      '--expr',
      `let
        flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
        pkgs = flake.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem};
      in (import ./scripts/fabro-darwin-machines.nix { inherit pkgs; }).text`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 300_000 },
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-machines-renderer-'));
  const script = path.join(directory, 'fabro-darwin-machines');
  fs.writeFileSync(script, text, { mode: 0o700 });
  return script;
}

const renderer = buildRenderer();
test.after(() => fs.rmSync(path.dirname(renderer), { recursive: true, force: true }));

function makeInputs(directory) {
  const clientKey = path.join(directory, 'darwin-client-key');
  const hostKey = path.join(directory, 'darwin-host-key');
  const linuxHostKey = path.join(directory, 'linux-host-key');
  fs.writeFileSync(clientKey, 'DARWIN PRIVATE CLIENT KEY\n');
  fs.writeFileSync(hostKey, 'ssh-ed25519 AAAAhostkey darwin-builder\n');
  fs.writeFileSync(linuxHostKey, fixtureLinuxHostKey);
  return { clientKey, hostKey, linuxHostKey };
}

function rendererArguments({
  output,
  clientKey,
  hostKey,
  linuxHostKey,
  linuxHostName: hostName = linuxHostName,
  linuxSystem: system = linuxSystem,
  linuxMaxJobs: maxJobs = '4',
  linuxClientKey: clientKeyPath = linuxClientKeyPath,
}) {
  return [
    '--output', output,
    '--host-name', 'mac-builder.tuxedo-musical.ts.net',
    '--ssh-user', 'nix-builder',
    '--system', 'aarch64-darwin',
    '--max-jobs', '4',
    '--speed-factor', '2',
    '--client-key', clientKey,
    '--host-key', hostKey,
    '--linux-host-name', hostName,
    '--linux-system', system,
    '--linux-max-jobs', maxJobs,
    '--linux-client-key', clientKeyPath,
    '--linux-host-key', linuxHostKey,
  ];
}

function runRenderer(args) {
  return childProcess.spawnSync(renderer, args, { encoding: 'utf8' });
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-linux-machines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function assertNoTemporaryFiles(directory) {
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.tmp.')),
    [],
    'a failed render must not leave a partial temporary machines file behind',
  );
}

// Structural invariant shared by the positive render and the negative
// fixtures: exactly the Darwin and Linux records, in that order, with only
// the expected systems, runtime key path, and Linux host-key pin.
function assertMachineRecords(text) {
  const records = text.trimEnd().split('\n');
  assert.equal(records.length, 2, 'the machines file must contain the Darwin and Linux machine records');

  const [darwin, linux] = records.map((line) => line.split(' '));
  assert.equal(darwin.length, 8, `Darwin machine record must have eight fields: ${records[0]}`);
  assert.equal(linux.length, 8, `Linux machine record must have eight fields: ${records[1]}`);

  assert.equal(darwin[0], 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net', 'Darwin machine record must keep its endpoint');
  assert.equal(darwin[1], 'aarch64-darwin', 'Darwin machine record must keep its aarch64-darwin system');
  assert.equal(darwin[3], '4', 'Darwin machine record must keep its four jobs');
  assert.equal(darwin[4], '2', 'Darwin machine record must keep its speed factor');

  assert.equal(linux[0], `ssh-ng://builder@${linuxHostName}`);
  assert.equal(linux[1], linuxSystem);
  assert.match(linux[2], /^\/run\/secrets\/[A-Za-z0-9._-]+$/, 'Linux machine record must reference a runtime secret key path');
  assert.equal(linux[3], '4');
  assert.equal(linux[4], '1');
  assert.equal(linux[5], '-');
  assert.equal(linux[6], '-');
  assert.match(linux[7], /^[A-Za-z0-9+/]+={0,2}$/, 'Linux machine record must carry a base64 host-key pin');
}

test('renderer writes the unchanged Darwin record plus the pinned Linux record atomically with mode 0600', (t) => {
  const directory = tempDirectory(t);
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');
  fs.writeFileSync(output, 'stale records\n');

  const result = runRenderer(rendererArguments({ output, ...inputs }));

  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(output, 'utf8');
  assert.equal(
    text,
    `ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ${inputs.clientKey} 4 2 - - ${Buffer.from(fs.readFileSync(inputs.hostKey)).toString('base64')}\n`
      + `ssh-ng://builder@${linuxHostName} ${linuxSystem} ${linuxClientKeyPath} 4 1 - - ${Buffer.from(fs.readFileSync(inputs.linuxHostKey)).toString('base64')}\n`,
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.ok(!text.includes('PRIVATE CLIENT KEY'), 'private client-key contents must never reach the machines file');
  assertMachineRecords(text);
  assertNoTemporaryFiles(directory);
});

test('renderer emits the validated Linux client-key path instead of a hardcoded default', (t) => {
  const directory = tempDirectory(t);
  const inputs = makeInputs(directory);
  const output = path.join(directory, 'machines');
  const alternateKeyPath = '/run/secrets/alternate-linux-builder-key';

  const result = runRenderer(rendererArguments({ output, ...inputs, linuxClientKey: alternateKeyPath }));

  assert.equal(result.status, 0, result.stderr);
  const linux = fs.readFileSync(output, 'utf8').trimEnd().split('\n')[1].split(' ');
  assert.equal(linux[2], alternateKeyPath, 'the Linux record must use the validated client-key argument');
});

test('renderer keeps the prior complete output when a Linux input is missing', (t) => {
  for (const option of [
    '--linux-host-name',
    '--linux-system',
    '--linux-max-jobs',
    '--linux-client-key',
    '--linux-host-key',
  ]) {
    const directory = tempDirectory(t);
    const inputs = makeInputs(directory);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');
    const args = rendererArguments({ output, ...inputs });
    args.splice(args.indexOf(option), 2);

    const result = runRenderer(args);

    assert.notEqual(result.status, 0, `${option} must be required`);
    assert.match(result.stderr, /required/i, `${option} failure must name the missing option`);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assertNoTemporaryFiles(directory);
  }
});

test('renderer rejects missing or empty Darwin key inputs without replacing the prior output', (t) => {
  for (const [name, keyName, state] of [
    ['missing Darwin client key', 'clientKey', 'missing'],
    ['empty Darwin client key', 'clientKey', 'empty'],
    ['missing Darwin host key', 'hostKey', 'missing'],
    ['empty Darwin host key', 'hostKey', 'empty'],
  ]) {
    const directory = tempDirectory(t);
    const inputs = makeInputs(directory);
    if (state === 'missing') fs.unlinkSync(inputs[keyName]);
    else fs.writeFileSync(inputs[keyName], '');
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');

    const result = runRenderer(rendererArguments({ output, ...inputs }));

    assert.notEqual(result.status, 0, `${name} must be rejected`);
    assert.match(result.stderr, /missing, unreadable, or empty/, `${name} failure must identify the input`);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assertNoTemporaryFiles(directory);
  }
});

test('renderer rejects invalid Linux route values without replacing the prior output', (t) => {
  for (const [option, value] of [
    ['--linux-host-name', 'linux-builder.example.ts.net'],
    ['--linux-host-name', 'linux-builder.tuxedo-musical.ts.net;touch'],
    ['--linux-system', 'aarch64-darwin'],
    ['--linux-max-jobs', '3'],
    ['--linux-max-jobs', 'many'],
    ['--linux-client-key', 'relative-key'],
    ['--linux-client-key', '/tmp/linux-builder-client-key'],
    ['--linux-client-key', '/run/secrets/../../etc/key'],
    ['--linux-client-key', '/run/secrets//linux-builder-client-key'],
    ['--linux-client-key', '/nix/store/fake-client-key'],
  ]) {
    const directory = tempDirectory(t);
    const inputs = makeInputs(directory);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');
    const overrides = {
      linuxHostName: linuxHostName,
      linuxSystem,
      linuxMaxJobs: '4',
      linuxClientKey: linuxClientKeyPath,
    };
    if (option === '--linux-host-name') overrides.linuxHostName = value;
    if (option === '--linux-system') overrides.linuxSystem = value;
    if (option === '--linux-max-jobs') overrides.linuxMaxJobs = value;
    if (option === '--linux-client-key') overrides.linuxClientKey = value;

    const result = runRenderer(rendererArguments({ output, ...inputs, ...overrides }));

    assert.notEqual(result.status, 0, `${option} ${value} must be rejected`);
    assert.match(result.stderr, /linux/i, `${option} failure must identify the Linux route`);
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assertNoTemporaryFiles(directory);
  }
});

test('renderer rejects missing, empty, or malformed Linux host-key pins without replacing the prior output', (t) => {
  const cases = [
    { name: 'missing', mutate: (inputs) => fs.unlinkSync(inputs.linuxHostKey) },
    { name: 'empty', mutate: (inputs) => fs.writeFileSync(inputs.linuxHostKey, '') },
    {
      name: 'wrong key type',
      mutate: (inputs) => fs.writeFileSync(inputs.linuxHostKey, 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ linux-builder\n'),
    },
    {
      name: 'malformed base64',
      mutate: (inputs) => fs.writeFileSync(inputs.linuxHostKey, 'ssh-ed25519 AAAA-not-a-valid-ed25519-key linux-builder\n'),
    },
    {
      name: 'wrong key length',
      mutate: (inputs) => fs.writeFileSync(
        inputs.linuxHostKey,
        `ssh-ed25519 ${Buffer.concat([
          Buffer.from([0, 0, 0, 11]),
          Buffer.from('ssh-ed25519'),
          Buffer.from([0, 0, 0, 31]),
          Buffer.alloc(32, 1),
          Buffer.from([0]),
        ]).toString('base64')} linux-builder\n`,
      ),
    },
  ];

  for (const testCase of cases) {
    const directory = tempDirectory(t);
    const inputs = makeInputs(directory);
    testCase.mutate(inputs);
    const output = path.join(directory, 'machines');
    fs.writeFileSync(output, 'prior complete Darwin and Linux records\n');

    const result = runRenderer(rendererArguments({ output, ...inputs }));

    assert.notEqual(result.status, 0, `${testCase.name} host key must be rejected`);
    assert.match(
      result.stderr,
      /missing, unreadable, or empty|host key/i,
      `${testCase.name} host-key failure must identify the pin`,
    );
    assert.equal(fs.readFileSync(output, 'utf8'), 'prior complete Darwin and Linux records\n');
    assertNoTemporaryFiles(directory);
  }
});

test('machine-record validation rejects a missing Linux record', () => {
  const darwinOnly =
    'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 4 2 - - AAAA\n';

  assert.throws(() => assertMachineRecords(darwinOnly), /Darwin and Linux machine records/);
});

test('machine-record validation rejects an altered Darwin record', () => {
  const alteredDarwin =
    'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-linux /run/secrets/build-client-key 4 2 - - AAAA\n'
    + `ssh-ng://builder@${linuxHostName} ${linuxSystem} ${linuxClientKeyPath} 4 1 - - AAAA\n`;

  assert.throws(() => assertMachineRecords(alteredDarwin), /Darwin machine record/);
});

test('machine-record validation rejects a Linux client key outside the runtime secret path', () => {
  const invalidKey =
    'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/build-client-key 4 2 - - AAAA\n'
    + `ssh-ng://builder@${linuxHostName} ${linuxSystem} /tmp/linux-builder-client-key 4 1 - - AAAA\n`;

  assert.throws(() => assertMachineRecords(invalidKey), /runtime secret key path/);
});

function evaluateFabro(extraModule = null) {
  const host = extraModule
    ? `flake.nixosConfigurations.fabro-vm.extendModules { modules = [ (${extraModule}) ]; }`
    : 'flake.nixosConfigurations.fabro-vm';
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      vm = (${host}).config;
      dispatch = vm.systemd.services.fabro-darwin-builders;
      daemon = vm.systemd.services.nix-daemon;
      linuxSecret = vm.sops.secrets."linux-builder-client-key";
    in
    {
      dispatchEnabled = vm.fabro.darwinBuilder.enable;
      machine = vm.fabro.darwinBuilder.machine;
      linuxMachine = vm.fabro.darwinBuilder.linuxMachine;
      clientKeyPath = vm.fabro.darwinBuilder.clientKeyPath;
      hostKeyPath = vm.fabro.darwinBuilder.hostKeyPath;
      linuxClientKeyPath = vm.fabro.darwinBuilder.linuxClientKeyPath;
      linuxHostKeyPath = vm.fabro.darwinBuilder.linuxHostKeyPath;
      machinesFile = vm.fabro.darwinBuilder.machinesFile;
      distributedBuilds = vm.nix.distributedBuilds;
      maxJobs = vm.nix.settings.max-jobs;
      builders = vm.nix.settings.builders;
      buildersUseSubstitutes = vm.nix.settings.builders-use-substitutes;
      buildMachines = vm.nix.buildMachines;
      linuxSecret = {
        path = linuxSecret.path;
        mode = linuxSecret.mode;
        owner = linuxSecret.owner;
        group = linuxSecret.group;
        restartUnits = linuxSecret.restartUnits;
        sopsFile = toString linuxSecret.sopsFile;
      };
      linuxOnePasswordSource = vm.fabro.onePasswordSecrets."linux-builder-client-key";
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
    }
  `);
}

// Shared policy invariant: a test-only overlay can prove that a perturbed
// Fabro render is rejected instead of silently passing the suite.
function assertFabroDispatchPolicy(config) {
  assert.equal(config.dispatchEnabled, true, 'Fabro Linux/Darwin dispatch must be enabled (Requirements 3.1, 4.3)');

  // No local fallback: remote-only builds with the existing runtime
  // machines file and substituters.
  assert.equal(config.maxJobs, 0, 'Fabro must set max-jobs = 0 so builds never fall back to local jobs (Requirements 4.1, 4.2, 5.4)');
  assert.equal(config.distributedBuilds, true, 'Fabro must retain distributed builds (Requirements 3.1, 4.3)');
  assert.equal(config.builders, `@${machinesFile}`, 'Fabro must read the runtime machines file (Requirement 3.1)');
  assert.equal(config.buildersUseSubstitutes, true, 'Fabro must retain builder substitutes (Requirement 4.3)');
  assert.deepEqual(config.buildMachines, [], 'Fabro must not duplicate the runtime file with eval-time buildMachines');

  // Linux route.
  assert.equal(config.linuxMachine.hostName, linuxHostName, 'Fabro must dispatch to the Linux builder endpoint (Requirement 3.1)');
  assert.equal(config.linuxMachine.system, linuxSystem, 'Fabro Linux route must support only aarch64-linux (Requirements 1.2, 3.1)');
  assert.equal(config.linuxMachine.maxJobs, 4, 'Fabro Linux route must allow four remote jobs (Requirement 3.1)');
  assert.equal(config.linuxClientKeyPath, linuxClientKeyPath, 'Fabro Linux route must reference the dedicated runtime client key (Requirement 3.1)');
  assert.match(config.linuxHostKeyPath, pinnedHostKeyPattern, 'Fabro Linux route must use the checked-in host-key pin (Requirements 3.1, 5.3)');
  assert.equal(config.linuxSecret.path, linuxClientKeyPath, 'Fabro Linux client key must use its runtime secret path (Requirement 3.1)');
  assert.equal(config.linuxSecret.mode, '0400', 'Fabro Linux client key must be mode 0400 (Requirement 3.1)');
  assert.equal(config.linuxSecret.owner, 'root', 'Fabro Linux client key must be owned by root (Requirement 3.1)');
  assert.equal(config.linuxSecret.group, 'root', 'Fabro Linux client key must be grouped to root (Requirement 3.1)');
  assert.deepEqual(
    config.linuxSecret.restartUnits,
    ['fabro-darwin-builders.service', 'nix-daemon.service'],
    'Fabro Linux client key changes must restart the renderer and daemon (Requirement 3.1)',
  );
  assert.match(config.linuxSecret.sopsFile, /\/secrets\/fabro\.fabro\.yaml$/, 'Fabro Linux client key must come from the Fabro SOPS store');
  assert.equal(
    config.linuxOnePasswordSource,
    'op://Infrastructure/Fabro Linux nix remote builder key/private key',
    'Fabro Linux client key must have an operator-provisioned 1Password source (Requirement 5.3)',
  );

  // Darwin route unchanged.
  assert.deepEqual(config.machine, {
    hostName: 'mac-builder.tuxedo-musical.ts.net',
    sshUser: 'nix-builder',
    system: 'aarch64-darwin',
    maxJobs: 4,
    speedFactor: 2,
  }, 'the existing Darwin machine entry must keep its endpoint, user, system, jobs, and speed factor (Requirement 3.3)');
  assert.equal(config.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(config.hostKeyPath, '/run/secrets/build-host-key');

  // Renderer invocation carries both routes.
  assert.match(config.dispatchUnit.execStart, /--host-name mac-builder\.tuxedo-musical\.ts\.net/);
  assert.match(config.dispatchUnit.execStart, /--ssh-user nix-builder/);
  assert.match(config.dispatchUnit.execStart, /--system aarch64-darwin/);
  assert.match(config.dispatchUnit.execStart, /--max-jobs 4/);
  assert.match(config.dispatchUnit.execStart, /--speed-factor 2/);
  assert.match(config.dispatchUnit.execStart, /--client-key \/run\/secrets\/build-client-key/);
  assert.match(config.dispatchUnit.execStart, /--host-key \/run\/secrets\/build-host-key/);
  assert.match(config.dispatchUnit.execStart, /--linux-host-name linux-builder\.tuxedo-musical\.ts\.net/);
  assert.match(config.dispatchUnit.execStart, /--linux-system aarch64-linux/);
  assert.match(config.dispatchUnit.execStart, /--linux-max-jobs 4/);
  assert.match(config.dispatchUnit.execStart, /--linux-client-key \/run\/secrets\/linux-builder-client-key/);
  assert.match(
    config.dispatchUnit.execStart,
    /--linux-host-key \/nix\/store\/[^\s]+-source\/certificates\/linux-builder\/ssh_host_ed25519_key\.pub/,
    'the renderer must consume the checked-in Linux host-key pin',
  );

  // Retained service identity and daemon ordering.
  assert.equal(config.dispatchUnit.type, 'oneshot');
  assert.equal(config.dispatchUnit.runtimeDirectory, 'fabro-darwin-builders');
  assert.equal(config.dispatchUnit.runtimeDirectoryPreserve, 'yes');
  assert.ok(config.dispatchUnit.after.includes('sops-install-secrets.service'));
  assert.ok(config.dispatchUnit.wants.includes('sops-install-secrets.service'));
  assert.ok(config.dispatchUnit.before.includes('nix-daemon.service'));
  assert.ok(config.daemonOrdering.wants.includes('fabro-darwin-builders.service'));
  assert.ok(config.daemonOrdering.after.includes('fabro-darwin-builders.service'));
  assert.ok(!config.daemonOrdering.requires.includes('fabro-darwin-builders.service'));
  assert.ok(config.tmpfiles.includes('f /run/fabro-darwin-builders/machines 0600 root root - -'));
}

test('Fabro evaluates the Linux route alongside the unchanged Darwin route with no local jobs', () => {
  assertFabroDispatchPolicy(evaluateFabro());
});

test('Fabro policy rejects a nonzero local job limit', () => {
  const config = evaluateFabro('{ lib, ... }: { nix.settings.max-jobs = lib.mkForce 2; }');

  assert.equal(config.maxJobs, 2, 'the fixture must really change max-jobs before the invariant is run');
  assert.throws(() => assertFabroDispatchPolicy(config), /max-jobs = 0/);
});

test('Fabro policy rejects a Linux route on an unsupported system', () => {
  const config = evaluateFabro('{ lib, ... }: { fabro.darwinBuilder.linuxMachine.system = lib.mkForce "aarch64-darwin"; }');

  assert.equal(config.linuxMachine.system, 'aarch64-darwin', 'the fixture must really change the Linux system');
  assert.throws(() => assertFabroDispatchPolicy(config), /aarch64-linux/);
});

test('Fabro policy rejects a Linux client key outside the runtime secret path', () => {
  const config = evaluateFabro('{ lib, ... }: { fabro.darwinBuilder.linuxClientKeyPath = lib.mkForce "/tmp/linux-builder-client-key"; }');

  assert.equal(config.linuxClientKeyPath, '/tmp/linux-builder-client-key', 'the fixture must really change the Linux key path');
  assert.throws(() => assertFabroDispatchPolicy(config), /dedicated runtime client key/);
});

test('Fabro policy rejects an altered Darwin route', () => {
  const config = evaluateFabro('{ lib, ... }: { fabro.darwinBuilder.machine.system = lib.mkForce "aarch64-linux"; }');

  assert.equal(config.machine.system, 'aarch64-linux', 'the fixture must really change the Darwin system');
  assert.throws(() => assertFabroDispatchPolicy(config), /Darwin machine entry/);
});
