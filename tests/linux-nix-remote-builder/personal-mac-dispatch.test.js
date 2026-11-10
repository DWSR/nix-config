'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const fixtureHostKeyPath = path.join(__dirname, 'fixtures/linux-builder-host-key.pub');
const fixtureHostKey = fs.readFileSync(fixtureHostKeyPath, 'utf8');
const fixtureHostKeyBase64 = Buffer.from(fixtureHostKey).toString('base64');
const defaultHostKeyPath = path.join(
  repoRoot,
  'certificates/linux-builder/ssh_host_ed25519_key.pub',
);
// The pin is operator-supplied (spec task 2.3). When it is present the record
// must embed its base64 form; when it is absent the record must leave the
// host-key field at its default so the connection fails closed.
const expectedDefaultHostKeyField = fs.existsSync(defaultHostKeyPath)
  ? Buffer.from(fs.readFileSync(defaultHostKeyPath)).toString('base64')
  : '-';

const darwinRecord =
  'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ' +
  '/run/secrets/mac-builder-ssh-private-key 8 1 - - ' +
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';

function evaluatePersonal(extraModule = '{}') {
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      host = flake.darwinConfigurations."Brandons-MacBook-Pro".extendModules {
        modules = [ ({ ... }: ${extraModule}) ];
      };
      cfg = host.config;
      builders = cfg.nix-config.linuxBuilderBuilders;
    in
    {
      maxJobs = cfg.nix.settings.max-jobs;
      builders = cfg.nix.settings.builders;
      buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes;
      distributedBuilds = cfg.nix.distributedBuilds;
      buildersText = builders.text;
      buildersOutPath = builders.outPath;
      hostKeyPath = cfg.nix-config.linuxBuilderHostKeyPath;
      linuxClientSecret = {
        path = cfg.sops.secrets."linux-builder-client-key".path;
        sopsFile = toString cfg.sops.secrets."linux-builder-client-key".sopsFile;
        key = cfg.sops.secrets."linux-builder-client-key".key;
        owner = cfg.sops.secrets."linux-builder-client-key".owner;
        mode = cfg.sops.secrets."linux-builder-client-key".mode;
      };
    }
  `;

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

function recordLines(buildersText) {
  return buildersText.split('\n').filter((line) => line !== '');
}

test('personal host renders both machine records through a store-backed builders file', () => {
  const config = evaluatePersonal();
  const lines = recordLines(config.buildersText);

  assert.equal(config.maxJobs, 0);
  assert.equal(config.buildersUseSubstitutes, true);
  assert.equal(config.distributedBuilds, false);
  assert.equal(config.builders, `@${config.buildersOutPath}`);
  assert.match(config.builders, /^@\/nix\/store\/[^/]+-nix-builders$/);

  assert.equal(lines.length, 2);
  assert.equal(lines[0], darwinRecord);
  assert.equal(
    lines[1],
    'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ' +
      `/run/secrets/linux-builder-client-key 4 1 - - ${expectedDefaultHostKeyField}`,
  );
});

test('the pinned Linux host public key is base64-encoded into the Linux record', () => {
  const config = evaluatePersonal(
    `{ nix-config.linuxBuilderHostKeyPath = ${JSON.stringify(fixtureHostKeyPath)}; }`,
  );
  const lines = recordLines(config.buildersText);

  assert.equal(config.hostKeyPath, fixtureHostKeyPath);
  assert.equal(
    lines[1],
    'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ' +
      `/run/secrets/linux-builder-client-key 4 1 - - ${fixtureHostKeyBase64}`,
  );
  assert.equal(lines[0], darwinRecord);
  assert.doesNotMatch(config.buildersText, /ssh-ed25519 AAAA/);
});

test('the personal Linux client key is a dedicated root-only SOPS secret', () => {
  const config = evaluatePersonal();
  const source = fs.readFileSync(path.join(repoRoot, 'configurations/personal/default.nix'), 'utf8');

  assert.equal(config.linuxClientSecret.path, '/run/secrets/linux-builder-client-key');
  assert.equal(config.linuxClientSecret.key, 'linux-builder-client-key');
  assert.equal(config.linuxClientSecret.owner, 'root');
  assert.equal(config.linuxClientSecret.mode, '0400');
  assert.match(
    config.linuxClientSecret.sopsFile,
    /linux-builder-client-personal-unprovisioned\.yaml$|secrets\/linux-builder-client\.personal\.yaml$/,
  );
  assert.match(source, /secrets\/linux-builder-client\.personal\.yaml/);
});

test('the generated builders file never contains private key material', () => {
  const config = evaluatePersonal(
    `{ nix-config.linuxBuilderHostKeyPath = ${JSON.stringify(fixtureHostKeyPath)}; }`,
  );

  assert.doesNotMatch(config.buildersText, /PRIVATE KEY/);
  assert.doesNotMatch(config.buildersText, /BEGIN OPENSSH/);
  assert.ok(config.buildersText.includes('/run/secrets/linux-builder-client-key'));
  assert.ok(config.buildersText.includes('/run/secrets/mac-builder-ssh-private-key'));
});
