'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixtureHostKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n';
const darwinHostKeyBase64 =
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';

function nixEvalJson(expression) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  ));
}

function nixEvalFailure(expression) {
  try {
    childProcess.execFileSync(
      'nix',
      ['eval', '--json', '--impure', '--expr', expression],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      },
    );
  } catch (error) {
    return String(error.stderr ?? error.message);
  }

  throw new Error('expected nix eval to fail, but it succeeded');
}

function personalHostWithPin(pinPath) {
  return `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      host = flake.darwinConfigurations."Brandons-MacBook-Pro".extendModules {
        modules = [
          ({ ... }: { nix-config.linuxBuilder.hostKeyPin = ${JSON.stringify(pinPath)}; })
        ];
      };
      cfg = host.config;
    in
  `;
}

test('personal host renders Darwin and Linux machine records through an @file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pinPath = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(pinPath, fixtureHostKey);

  const rendered = nixEvalJson(`
    ${personalHostWithPin(pinPath)}
    {
      builders = cfg.nix.settings.builders;
      buildersText = cfg.nix-config.linuxBuilder.buildersFile.text;
      maxJobs = cfg.nix.settings.max-jobs;
      buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes;
      distributedBuilds = cfg.nix.distributedBuilds;
      linuxClientSecret = {
        path = cfg.sops.secrets.linux-builder-client-key.path;
        owner = cfg.sops.secrets.linux-builder-client-key.owner;
        mode = cfg.sops.secrets.linux-builder-client-key.mode;
        sopsFile = toString cfg.sops.secrets.linux-builder-client-key.sopsFile;
      };
      darwinClientSecretPath = cfg.sops.secrets.mac-builder-ssh-private-key.path;
      defaultSopsFile = toString cfg.sops.defaultSopsFile;
    }
  `);

  const buildersFile = rendered.builders.slice(1);
  assert.equal(rendered.builders, `@${buildersFile}`);
  assert.match(buildersFile, /^\/nix\/store\/[a-z0-9]+-nix-builders$/);

  const expectedLinuxHostKey = Buffer.from(fixtureHostKey).toString('base64');
  assert.equal(
    rendered.buildersText,
    `ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/mac-builder-ssh-private-key 8 1 - - ${darwinHostKeyBase64}\n`
      + `ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux /run/secrets/linux-builder-client-key 4 1 - - ${expectedLinuxHostKey}\n`,
  );

  const records = rendered.buildersText.trimEnd().split('\n');
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.split(' ').length, 8, `machine record must have eight fields: ${record}`);
  }
  assert.doesNotMatch(rendered.buildersText, /PRIVATE KEY/);

  assert.equal(rendered.maxJobs, 0);
  assert.equal(rendered.buildersUseSubstitutes, true);
  assert.equal(rendered.distributedBuilds, false);

  assert.equal(rendered.linuxClientSecret.path, '/run/secrets/linux-builder-client-key');
  assert.equal(rendered.linuxClientSecret.owner, 'root');
  assert.equal(rendered.linuxClientSecret.mode, '0400');
  assert.match(
    rendered.linuxClientSecret.sopsFile,
    /(\/secrets\/linux-builder-client\.personal\.yaml|-linux-builder-client-unprovisioned-secrets\.yaml)$/,
  );
  assert.equal(rendered.darwinClientSecretPath, '/run/secrets/mac-builder-ssh-private-key');
  assert.match(rendered.defaultSopsFile, /\/secrets\/mcp\.personal\.yaml$/);
});

test('a missing Linux host-key pin keeps evaluation working and fails closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missingPin = path.join(directory, 'missing-ssh_host_ed25519_key.pub');

  const result = childProcess.spawnSync(
    'nix',
    [
      'eval',
      '--json',
      '--impure',
      '--expr',
      `
        ${personalHostWithPin(missingPin)}
        { buildersText = cfg.nix-config.linuxBuilder.buildersFile.text; }
      `,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Linux builder SSH host-key pin is missing/);
  assert.match(result.stderr, /missing-ssh_host_ed25519_key\.pub/);

  const records = JSON.parse(result.stdout).buildersText.trimEnd().split('\n');
  assert.equal(records.length, 2);
  assert.match(records[0], / aarch64-darwin /);
  assert.equal(
    records[1],
    'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux /run/secrets/linux-builder-client-key 4 1 - -',
  );
});

test('the Linux host-key pin must be a single ssh-ed25519 public key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pinPath = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(pinPath, 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ linux-builder\n');

  const stderr = nixEvalFailure(`
    ${personalHostWithPin(pinPath)}
    cfg.nix.settings.builders
  `);

  assert.match(stderr, /Linux builder SSH host-key pin is not an ssh-ed25519 public key/);
  assert.match(stderr, /ssh_host_ed25519_key\.pub/);
});
