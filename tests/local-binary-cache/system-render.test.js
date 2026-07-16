'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { evalDarwinFixture } = require('./helpers');

const jwtPublicKey = path.join(__dirname, 'fixtures/jwt-public.pem');
const tlsCertificate = path.join(__dirname, 'fixtures/tls-certificate.pem');
const poisonedSecrets = {
  jwtPrivateKey: 'poisoned-jwt-private-key-value',
  pushToken: 'poisoned-push-token-value',
  tlsPrivateKey: 'poisoned-tls-private-key-value',
};
const unsafeServerStateDirectories = [
  ['root', '/'],
  ['whitespace', '/var/db/local-binary-cache/attic state'],
  ['control', `/var/db/local-binary-cache/attic${String.fromCharCode(1)}state`],
  ['query', '/var/db/local-binary-cache/attic?mode=ro'],
  ['fragment', '/var/db/local-binary-cache/attic#fragment'],
  ['percent', '/var/db/local-binary-cache/%61ttic'],
];

test('render harness evaluates an isolated nix-darwin fixture', () => {
  const rendered = evalDarwinFixture(
    `{ ... }: {
      networking.hostName = "local-binary-cache-fixture";
    }`,
    `{
      atticConfigFile = config.services.localBinaryCache.server.configFile;
      hostName = config.networking.hostName;
      cacheEnabled = config.services.localBinaryCache.enable;
      hasDarwinActivation = config.system ? activationScripts;
    }`,
  );

  assert.deepEqual(rendered, {
    atticConfigFile: null,
    cacheEnabled: false,
    hasDarwinActivation: true,
    hostName: 'local-binary-cache-fixture',
  });
});

test('server renders the pinned secret-free Attic configuration contract', () => {
  const tlsKeyFile = `/run/secrets/${poisonedSecrets.tlsPrivateKey}-${poisonedSecrets.jwtPrivateKey}`;
  const tokenFile = `/run/secrets/${poisonedSecrets.pushToken}`;
  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
        publisher.tokenFile = ${JSON.stringify(tokenFile)};
        server = {
          enable = true;
          package = pkgs.hello;
          proxyPackage = pkgs.hello;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = ${JSON.stringify(tlsKeyFile)};
        };
      };
    }`,
    `let
      server = config.services.localBinaryCache.server;
      configText = builtins.readFile server.configFile;
    in {
      configFile = toString server.configFile;
      inherit configText;
      settings = builtins.fromTOML configText;
      stateDirectory = server.stateDirectory;
      sourceSecretPaths = [ server.tlsKeyFile config.services.localBinaryCache.publisher.tokenFile ];
      sourcePublicPaths = [ server.jwtPublicKey server.tlsCertificate ];
    }`,
  );

  assert.match(rendered.configFile, /-attic-server\.toml$/);
  assert.equal(rendered.stateDirectory, '/var/db/local-binary-cache/attic');
  assert.deepEqual(rendered.settings, {
    'allowed-hosts': ['Brandons-MacBook-Pro.local:8443'],
    'api-endpoint': 'https://Brandons-MacBook-Pro.local:8443/',
    chunking: {
      'avg-size': 65536,
      'max-size': 262144,
      'min-size': 16384,
      'nar-size-threshold': 65536,
    },
    compression: {
      type: 'zstd',
    },
    database: {
      url: 'sqlite:///var/db/local-binary-cache/attic/attic.db?mode=rwc',
    },
    'garbage-collection': {
      'default-retention-period': '30 days',
      interval: '12 hours',
    },
    jwt: {
      signing: {
        'token-rs256-pubkey-base64': fs.readFileSync(jwtPublicKey).toString('base64'),
      },
    },
    listen: '127.0.0.1:8080',
    storage: {
      path: '/var/db/local-binary-cache/attic/storage',
      type: 'local',
    },
    'substituter-endpoint': 'https://Brandons-MacBook-Pro.local:8443/',
  });

  assert.deepEqual(rendered.sourceSecretPaths, [tlsKeyFile, tokenFile]);
  for (const secretPath of rendered.sourceSecretPaths) {
    assert.equal(rendered.configText.includes(secretPath), false);
  }
  for (const secretValue of Object.values(poisonedSecrets)) {
    assert.equal(rendered.configText.includes(secretValue), false);
  }
  for (const publicPath of rendered.sourcePublicPaths) {
    assert.equal(rendered.configText.includes(publicPath), false);
  }

  const renderedKeys = new Set([
    ...Object.keys(rendered.settings),
    ...Object.keys(rendered.settings.jwt),
    ...Object.keys(rendered.settings.jwt.signing),
  ]);
  for (const forbiddenKey of [
    'auto-create-cache',
    'bootstrap',
    'cache',
    'cache-name',
    'caches',
    'create-cache',
    'private-key',
    'priority',
    'public',
    'tls-key',
    'token-file',
    'token-hs256-secret-base64',
    'token-rs256-secret-base64',
    'upstream-cache-key-names',
  ]) {
    assert.equal(renderedKeys.has(forbiddenKey), false);
  }
});

test('server rejects state directories that make storage paths or SQLite URLs ambiguous', async t => {
  for (const [name, stateDirectory] of unsafeServerStateDirectories) {
    await t.test(name, () => {
      const nixStateDirectory = JSON.stringify(JSON.stringify(stateDirectory));

      assert.throws(
        () => evalDarwinFixture(
          `{ ... }: {
            services.localBinaryCache.server.stateDirectory = builtins.fromJSON ${nixStateDirectory};
          }`,
          'config.services.localBinaryCache.server.stateDirectory',
        ),
        error => {
          assert.match(
            error.stderr,
            /option `services\.localBinaryCache\.server\.stateDirectory'/,
          );
          return true;
        },
      );
    });
  }
});
