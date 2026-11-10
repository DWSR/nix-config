'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

// A syntactically valid Ed25519 public key used only as a fixture. The real
// pin is operator-provisioned at
// certificates/linux-builder/ssh_host_ed25519_key.pub.
const linuxHostKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n';

const darwinRecord =
  'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ' +
  '/run/secrets/mac-builder-ssh-private-key 8 1 - - ' +
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';

function evalPersonal(pinPath) {
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      lib = flake.inputs.nixpkgs.lib;
      host = flake.darwinConfigurations."Brandons-MacBook-Pro".extendModules {
        modules = [
          { nix-config.linuxBuilderHostKeyPin = builtins.toPath ${JSON.stringify(pinPath)}; }
        ];
      };
      settings = host.config.nix.settings;
      builders = settings.builders;
      buildersFile =
        if lib.hasPrefix "@" builders then lib.removePrefix "@" builders else null;
      buildersText =
        if buildersFile == null then null else builtins.readFile buildersFile;
      failedAssertions = map (entry: entry.message) (
        builtins.filter (entry: !entry.assertion) host.config.assertions
      );
      linuxClientSecret = host.config.sops.secrets."linux-builder-client-key";
    in
    {
      builders = builders;
      buildersFile = buildersFile;
      buildersText = buildersText;
      failedAssertions = failedAssertions;
      hasLinuxRecord =
        buildersText != null
        && lib.hasInfix "ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux" buildersText;
      maxJobs = settings.max-jobs;
      buildersUseSubstitutes = settings.builders-use-substitutes;
      distributedBuilds = host.config.nix.distributedBuilds;
      publisherEnabled = host.config.services.localBinaryCache.publisher.enable;
      darwinClientSecretPath = host.config.sops.secrets."mac-builder-ssh-private-key".path;
      linuxClientSecret = {
        path = linuxClientSecret.path;
        owner = linuxClientSecret.owner;
        mode = linuxClientSecret.mode;
        key = linuxClientSecret.key;
        sopsFile = toString linuxClientSecret.sopsFile;
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
      timeout: 600_000,
    },
  ));
}

function evalPersonalFailure(pinPath) {
  try {
    evalPersonal(pinPath);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  throw new Error('expected nix eval to fail, but it succeeded');
}

function withFixturePin(contents, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-pin-'));
  const pinPath = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(pinPath, contents);
  try {
    return fn(pinPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('personal host dispatches through a generated builders file with both records', () => {
  withFixturePin(linuxHostKey, (pinPath) => {
    const rendered = evalPersonal(pinPath);

    assert.match(rendered.builders, /^@\/nix\/store\/[^/]+-nix-builders\.conf$/);
    assert.match(rendered.buildersFile, /\/nix\/store\/[^/]+-nix-builders\.conf$/);

    const lines = rendered.buildersText.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 2, rendered.buildersText);
    assert.equal(lines[0], darwinRecord);
    assert.equal(
      lines[1],
      'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ' +
        `/run/secrets/linux-builder-client-key 4 1 - - ${Buffer.from(linuxHostKey).toString('base64')}`,
    );
    assert.ok(rendered.buildersText.endsWith('\n'));
  });
});

test('personal host keeps its no-local-build and local cache policy', () => {
  withFixturePin(linuxHostKey, (pinPath) => {
    const rendered = evalPersonal(pinPath);

    assert.equal(rendered.maxJobs, 0);
    assert.equal(rendered.distributedBuilds, false);
    assert.equal(rendered.buildersUseSubstitutes, true);
    assert.equal(rendered.publisherEnabled, true);
    assert.equal(rendered.darwinClientSecretPath, '/run/secrets/mac-builder-ssh-private-key');
  });
});

test('personal Linux client key is a dedicated root-only SOPS secret', () => {
  withFixturePin(linuxHostKey, (pinPath) => {
    const rendered = evalPersonal(pinPath);

    assert.equal(rendered.linuxClientSecret.path, '/run/secrets/linux-builder-client-key');
    assert.equal(rendered.linuxClientSecret.owner, 'root');
    assert.equal(rendered.linuxClientSecret.mode, '0400');
    assert.equal(rendered.linuxClientSecret.key, 'linux-builder-client-key');
    assert.match(
      rendered.linuxClientSecret.sopsFile,
      /secrets\/linux-builder-client\.personal\.yaml$/,
    );
  });
});

test('generated builders file carries runtime key paths, never key values', () => {
  withFixturePin(linuxHostKey, (pinPath) => {
    const rendered = evalPersonal(pinPath);

    assert.doesNotMatch(rendered.buildersText, /PRIVATE KEY/);
    assert.doesNotMatch(rendered.buildersText, /BEGIN OPENSSH/);
    assert.equal(
      (rendered.buildersText.match(/\/run\/secrets\//g) ?? []).length,
      2,
      'expected exactly the two runtime secret paths in the generated file',
    );
    assert.ok(rendered.buildersText.includes('/run/secrets/mac-builder-ssh-private-key'));
    assert.ok(rendered.buildersText.includes('/run/secrets/linux-builder-client-key'));
  });
});

test('missing pinned host key blocks activation instead of substituting a key', () => {
  const pinPath = path.join(os.tmpdir(), `linux-builder-missing-${process.pid}.pub`);
  fs.rmSync(pinPath, { force: true });

  const rendered = evalPersonal(pinPath);

  assert.equal(rendered.hasLinuxRecord, false);
  assert.match(rendered.buildersText, /pinned host key missing/);
  assert.ok(
    rendered.failedAssertions.some((message) =>
      /pinned linux-builder SSH host key is missing/.test(message) && message.includes(pinPath),
    ),
    JSON.stringify(rendered.failedAssertions),
  );
});

test('malformed pinned host key fails instead of emitting an invalid record', () => {
  withFixturePin('not an ssh public key\n', (pinPath) => {
    const stderr = evalPersonalFailure(pinPath);
    assert.match(stderr, /is not a single ssh-ed25519 public key line/);
  });
});
