'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { nixEvalJson, repoRoot } = require('./helpers');

const poison = {
  client: 'PRIVATE-CLIENT-KEY-FILE-CONTENTS-POISON-DO-NOT-LEAK',
  host: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n',
  authorized: 'AUTHORIZED-PUBLIC-KEY-FILE-CONTENTS-POISON-DO-NOT-LEAK',
};

function evaluateGuest() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      cfg = flake.nixosConfigurations.fabro-vm.config;
      dispatch = cfg.systemd.services.fabro-darwin-builders;
    in {
      machinesFile = cfg.fabro.darwinBuilder.machinesFile;
      builders = cfg.nix.settings.builders;
      etcMachines = cfg.environment.etc."nix/machines" or null;
      unitText = dispatch.serviceConfig.ExecStart;
    }
  `);
}

function evaluateBuilder() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      cfg = flake.darwinConfigurations.mac-builder.config;
      activation = cfg.system.activationScripts.postActivation.text;
      secret = cfg.sops.secrets."builder-authorized-keys";
    in {
      activation = activation;
      secretPath = secret.path;
      secretName = secret.name;
      opensshEnabled = cfg.services.openssh.enable;
      opensshExtraConfig = cfg.services.openssh.extraConfig;
      nixDarwinSshdConfig = cfg.environment.etc."ssh/sshd_config.d/100-nix-darwin.conf".text;
      tailscaleSsh = cfg.launchd.daemons.tailscaled.serviceConfig.ProgramArguments;
      authArgs = cfg.launchd.daemons.mac-builder-tailscale-auth.serviceConfig.ProgramArguments;
    }
  `);
}

function runActivationFixture(activation, state, authorizedKey = 'ssh-ed25519 AAAATEST authorized-client\n', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-authorized-keys-'));
  try {
    const secretFile = path.join(directory, 'builder-authorized-keys');
    const sshDirectory = path.join(directory, 'nix-builder', '.ssh');
    if (state !== 'missing') {
      fs.writeFileSync(secretFile, state === 'empty' ? '' : authorizedKey);
    }
    const script = activation
      .replaceAll('/run/secrets/builder-authorized-keys', secretFile)
      .replaceAll('/Users/nix-builder/.ssh', sshDirectory);
    const shell = options.installStub
      ? script.replace(/install -d -m 0700[^\n]*/, 'mkdir -p "$ssh_dir"')
        .replace(/install -m 0600[^\n]*/, 'cp "$secret_file" "$authorized_keys"')
        .replace(/\/nix\/store\/[^\s"']*sops-install-secrets[^\s"']*\/bin\/sops-install-secrets/g, '/usr/bin/true')
      : script;
    const result = childProcess.spawnSync('/bin/sh', ['-c', shell], { encoding: 'utf8' });
    const installedAuthorizedKeys = fs.existsSync(path.join(sshDirectory, 'authorized_keys'))
      ? fs.readFileSync(path.join(sshDirectory, 'authorized_keys'), 'utf8')
      : null;
    return { ...result, installedAuthorizedKeys };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function buildRenderer() {
  const output = childProcess.execFileSync('nix', [
    'build', '--impure', '--no-link', '--print-out-paths', '--expr',
    `let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      pkgs = flake.inputs.nixpkgs.legacyPackages.${'${builtins.currentSystem}'};
    in pkgs.callPackage ./scripts/fabro-darwin-machines.nix {}`,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  return path.join(output.trim(), 'bin/fabro-darwin-machines');
}

function generateKeyPair(directory, name) {
  const privateKey = path.join(directory, name);
  childProcess.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', privateKey]);
  return {
    privateKey: fs.readFileSync(privateKey, 'utf8'),
    publicKey: fs.readFileSync(`${privateKey}.pub`, 'utf8'),
    fingerprint: childProcess.execFileSync('ssh-keygen', ['-lf', `${privateKey}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1],
  };
}

function renderMachines(renderer, directory, clientKey, hostKey) {
  const clientPath = path.join(directory, 'client-key');
  const hostPath = path.join(directory, 'host-key');
  const linuxClientPath = path.join(directory, 'linux-client-key');
  const linuxHostPath = path.join(directory, 'linux-host-key');
  const linuxClientRuntimePath = '/run/secrets/build-client-key';
  const output = path.join(directory, 'machines');
  fs.writeFileSync(clientPath, clientKey);
  fs.writeFileSync(hostPath, hostKey);
  fs.writeFileSync(linuxClientPath, clientKey);
  fs.writeFileSync(linuxHostPath, `${hostKey.trimEnd()} linux-builder\n`);
  const result = childProcess.spawnSync(renderer, [
    '--output', output, '--host-name', 'mac-builder.example.ts.net',
    '--ssh-user', 'nix-builder', '--system', 'aarch64-darwin',
    '--max-jobs', '4', '--speed-factor', '2', '--client-key', clientPath, '--host-key', hostPath,
    '--linux-host-name', 'linux-builder.tuxedo-musical.ts.net', '--linux-system', 'aarch64-linux',
    '--linux-max-jobs', '4', '--linux-client-key', linuxClientRuntimePath, '--linux-host-key', linuxHostPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { line: fs.readFileSync(output, 'utf8'), clientPath, linuxClientPath, linuxClientRuntimePath };
}

function fingerprint(publicKey, directory) {
  const keyFile = path.join(directory, 'candidate.pub');
  fs.writeFileSync(keyFile, publicKey);
  return childProcess.execFileSync('ssh-keygen', ['-lf', keyFile], { encoding: 'utf8' }).trim().split(/\s+/)[1];
}

test('machines file is runtime-only and referenced through Nix builders @ path', () => {
  const config = evaluateGuest();
  assert.equal(config.machinesFile, '/run/fabro-darwin-builders/machines');
  assert.ok(!config.machinesFile.startsWith('/nix/store/'));
  assert.ok(!config.machinesFile.startsWith('/etc/'));
  assert.equal(config.builders, `@${config.machinesFile}`);
  assert.equal(config.etcMachines, null);
  assert.match(config.unitText, /--client-key \/run\/secrets\/build-client-key/);
  assert.doesNotMatch(config.unitText, /PRIVATE CLIENT KEY/);
});

test('synthetic poisoned secret values never enter evaluated guest configuration or builder activation', () => {
  const config = evaluateGuest();
  const builder = evaluateBuilder();
  const renderer = buildRenderer();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-poison-files-'));
  try {
    const { line, clientPath, linuxClientRuntimePath } = renderMachines(renderer, directory, poison.client, poison.host);
    const evaluated = JSON.stringify(config);
    assert.match(line, new RegExp(` ${clientPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 4 2 - - `));
    assert.match(line, new RegExp(` ${linuxClientRuntimePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 4 1 - - `));
    assert.ok(!line.includes(poison.client));
    assert.ok(!line.includes(poison.host));
    assert.ok(!line.includes('/nix/store'));
    assert.ok(!line.includes('/etc/'));
    for (const value of Object.values(poison)) {
      assert.ok(!evaluated.includes(value), `poison file contents leaked into guest config: ${value}`);
      assert.ok(!line.includes(value), `poison file contents leaked into machines line: ${value}`);
      assert.ok(!builder.activation.includes(value), `poison file contents leaked into builder activation: ${value}`);
    }
    assert.match(builder.activation, /\/run\/secrets\/builder-authorized-keys/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('builder activation aborts when authorized build keys are missing or empty', () => {
  const config = evaluateBuilder();
  assert.equal(config.secretPath, '/run/secrets/builder-authorized-keys');
  assert.equal(config.secretName, 'builder-authorized-keys');
  assert.match(config.activation, /if \[ ! -s "\$secret_file" \]/);
  assert.match(config.activation, /required sops secret builder-authorized-keys is missing or empty/);

  for (const state of ['missing', 'empty']) {
    const result = runActivationFixture(config.activation, state);
    assert.notEqual(result.status, 0, `${state} secret unexpectedly passed activation`);
    assert.match(result.stderr, /builder-authorized-keys is missing or empty/);
  }
});

test('activation installs configured authorized keys for stock OpenSSH identity lookup', (t) => {
  const config = evaluateBuilder();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-authorized-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authorized = generateKeyPair(directory, 'authorized');
  const outsider = generateKeyPair(directory, 'outsider');
  const authorizedPayload = authorized.publicKey.replace(/\s+[^\s]+\s*$/, ` ${poison.authorized}\n`);
  const result = runActivationFixture(config.activation, 'present', authorizedPayload, { installStub: true });
  assert.equal(result.status, 0, result.stderr);
  const installed = result.installedAuthorizedKeys;
  assert.equal(typeof installed, 'string', 'activation did not install authorized_keys');
  assert.equal(fingerprint(installed, directory), authorized.fingerprint);
  assert.ok(!installed.includes(outsider.publicKey.trim()));
  assert.notEqual(fingerprint(outsider.publicKey, directory), authorized.fingerprint);
  assert.match(config.activation, /authorized_keys="\$ssh_dir\/authorized_keys"/);
  assert.equal(config.opensshEnabled, true);
  assert.match(config.activation, /ssh_dir="\/Users\/nix-builder\/\.ssh"/);
  assert.match(config.activation, /authorized_keys="\$ssh_dir\/authorized_keys"/);
  assert.match(config.opensshExtraConfig, /PasswordAuthentication no/);
  assert.doesNotMatch(config.opensshExtraConfig, /AuthorizedKeys(?:Command|File)/i);
  assert.doesNotMatch(config.nixDarwinSshdConfig, /AuthorizedKeys(?:Command|File)/i);
  assert.doesNotMatch(config.activation, /AuthorizedKeysCommand|tailscale|tailnet/i);
  assert.doesNotMatch(config.opensshExtraConfig, /tailscale|tailnet/i);
  assert.doesNotMatch(config.nixDarwinSshdConfig, /tailscale|tailnet/i);
  assert.ok(installed.includes(poison.authorized), 'synthetic authorized-key payload was not installed');
  assert.doesNotMatch(JSON.stringify(config.tailscaleSsh), /AuthorizedKeysCommand|authorized_keys/i);
});

test('tailnet node identity is not configured as build-session authentication', () => {
  const config = evaluateBuilder();
  assert.equal(config.tailscaleSsh.includes('--ssh'), false);
  assert.equal(config.tailscaleSsh.some(arg => /auth.key|authorized.key/i.test(arg)), false);
  assert.ok(config.authArgs.includes('--auth-key-file'));
  assert.ok(config.activation.includes('authorized_keys'));
  assert.doesNotMatch(config.activation, /tailscale|tailnet/i);
});
