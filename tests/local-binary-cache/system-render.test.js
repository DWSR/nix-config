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
  ['database-root', '/var/db'],
  ['namespace-parent', '/var/db/local-binary-cache'],
  ['state-descendant', '/var/db/local-binary-cache/attic/storage'],
  ['log-namespace', '/var/log/local-binary-cache'],
  ['attic-log-directory', '/var/log/local-binary-cache/attic'],
  ['system-directory', '/etc'],
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

test('disabled fixture renders no Attic launchd job or directory activation', () => {
  const rendered = evalDarwinFixture(
    `{ ... }: {
      system.primaryUser = "cache-operator";
    }`,
    `{
      hasSystemDaemon = config.launchd.daemons ? local-binary-cache-attic;
      hasLoginAgent = config.launchd.agents ? local-binary-cache-attic;
      hasUserAgent = config.launchd.user.agents ? local-binary-cache-attic;
      activation = config.system.activationScripts.launchd.text;
    }`,
  );

  assert.equal(rendered.hasSystemDaemon, false);
  assert.equal(rendered.hasLoginAgent, false);
  assert.equal(rendered.hasUserAgent, false);
  assert.equal(rendered.activation.includes('local-binary-cache: preparing Attic runtime directories'), false);
});

test('server renders a pre-login Attic daemon with failure restart state', () => {
  const tlsKeyFile = `/run/secrets/${poisonedSecrets.tlsPrivateKey}-${poisonedSecrets.jwtPrivateKey}`;
  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
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
      hasSystemDaemon = config.launchd.daemons ? local-binary-cache-attic;
      daemon = if hasSystemDaemon then config.launchd.daemons.local-binary-cache-attic else null;
      service = if daemon == null then { } else daemon.serviceConfig;
      plistPath = "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-attic.plist";
    in {
      inherit hasSystemDaemon;
      hasLoginAgent = config.launchd.agents ? local-binary-cache-attic;
      hasUserAgent = config.launchd.user.agents ? local-binary-cache-attic;
      label = service.Label or null;
      programArguments = service.ProgramArguments or null;
      runAtLoad = service.RunAtLoad or null;
      keepAliveSuccessfulExit =
        if service ? KeepAlive && builtins.isAttrs service.KeepAlive
        then service.KeepAlive.SuccessfulExit
        else null;
      throttleInterval = service.ThrottleInterval or null;
      userName = service.UserName or null;
      workingDirectory = service.WorkingDirectory or null;
      standardOutPath = service.StandardOutPath or null;
      standardErrorPath = service.StandardErrorPath or null;
      expectedExecutable = "${'${config.services.localBinaryCache.server.package}'}/bin/atticd";
      configFile = toString config.services.localBinaryCache.server.configFile;
      activation = config.system.activationScripts.launchd.text;
      plist = if hasSystemDaemon then builtins.readFile plistPath else null;
    }`,
  );

  assert.equal(rendered.hasSystemDaemon, true);
  assert.equal(rendered.hasLoginAgent, false);
  assert.equal(rendered.hasUserAgent, false);
  assert.equal(rendered.label, 'org.nixos.local-binary-cache-attic');
  assert.deepEqual(rendered.programArguments, [
    rendered.expectedExecutable,
    '-f',
    rendered.configFile,
    '--mode',
    'monolithic',
  ]);
  assert.equal(path.isAbsolute(rendered.programArguments[0]), true);
  assert.equal(path.isAbsolute(rendered.programArguments[2]), true);
  assert.equal(rendered.runAtLoad, true);
  assert.equal(rendered.keepAliveSuccessfulExit, false);
  assert.equal(rendered.throttleInterval, 10);
  assert.equal(rendered.userName, 'cache-operator');
  assert.equal(rendered.workingDirectory, '/var/db/local-binary-cache/attic');
  assert.equal(rendered.standardOutPath, '/var/log/local-binary-cache/attic/stdout.log');
  assert.equal(rendered.standardErrorPath, '/var/log/local-binary-cache/attic/stderr.log');
  const stateDirectory = rendered.workingDirectory;
  const logDirectory = path.dirname(rendered.standardOutPath);
  assert.equal(
    stateDirectory === logDirectory
      || stateDirectory.startsWith(`${logDirectory}${path.sep}`)
      || logDirectory.startsWith(`${stateDirectory}${path.sep}`),
    false,
  );

  assert.match(rendered.plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    rendered.plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  );
  assert.match(rendered.plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);

  assert.match(rendered.activation, /local-binary-cache: preparing Attic runtime directories/);
  assert.match(rendered.activation, /refusing attacker-controlled symlink path component/);
  assert.ok(
    rendered.activation.indexOf('if [[ -L "$target" ]]')
      < rendered.activation.indexOf('/usr/bin/install -d -o "$owner"'),
  );
  assert.match(rendered.activation, /prepare_owned_directory "\$attic_state_directory" "\$attic_user" staff 0700/);
  assert.match(rendered.activation, /prepare_owned_directory "\$attic_log_directory" root wheel 0755/);
  assert.match(rendered.activation, /prepare_owned_directory "\$attic_log_directory" "\$attic_user" staff 0750/);
  assert.match(rendered.activation, /prepare_log_file "\$attic_stdout_log" "\$attic_user" staff 0640/);
  assert.match(rendered.activation, /prepare_log_file "\$attic_stderr_log" "\$attic_user" staff 0640/);

  const directorySetupIndex = rendered.activation.indexOf(
    'local-binary-cache: preparing Attic runtime directories',
  );
  const launchdSetupIndex = rendered.activation.indexOf('setting up launchd services');
  const lockedLogDirectoryIndex = rendered.activation.indexOf(
    'prepare_owned_directory "$attic_log_directory" root wheel 0755',
  );
  const stdoutSetupIndex = rendered.activation.indexOf(
    'prepare_log_file "$attic_stdout_log" "$attic_user" staff 0640',
  );
  const ownedLogDirectoryIndex = rendered.activation.indexOf(
    'prepare_owned_directory "$attic_log_directory" "$attic_user" staff 0750',
  );
  assert.ok(directorySetupIndex >= 0 && directorySetupIndex < launchdSetupIndex);
  assert.ok(
    lockedLogDirectoryIndex < stdoutSetupIndex
      && stdoutSetupIndex < ownedLogDirectoryIndex,
  );

  for (const renderedText of [rendered.activation, rendered.plist]) {
    for (const secretValue of Object.values(poisonedSecrets)) {
      assert.equal(renderedText.includes(secretValue), false);
    }
  }
});

test('canonical server state directory is shell-escaped in activation', () => {
  const stateDirectory = '/var/db/local-binary-cache/attic';
  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
        server = {
          enable = true;
          package = pkgs.hello;
          proxyPackage = pkgs.hello;
          stateDirectory = ${JSON.stringify(stateDirectory)};
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = "/run/secrets/local-binary-cache-tls-key";
        };
      };
    }`,
    `{
      activation = config.system.activationScripts.launchd.text;
      workingDirectory =
        config.launchd.daemons.local-binary-cache-attic.serviceConfig.WorkingDirectory;
    }`,
  );

  assert.equal(rendered.workingDirectory, stateDirectory);
  assert.match(
    rendered.activation,
    /^attic_state_directory=\/var\/db\/local-binary-cache\/attic$/m,
  );
});

test('server renders the pinned secret-free Attic configuration contract', () => {
  const tlsKeyFile = `/run/secrets/${poisonedSecrets.tlsPrivateKey}-${poisonedSecrets.jwtPrivateKey}`;
  const tokenFile = `/run/secrets/${poisonedSecrets.pushToken}`;
  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
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

test('server rejects noncanonical, overlapping, or URI-ambiguous state directories', async t => {
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
