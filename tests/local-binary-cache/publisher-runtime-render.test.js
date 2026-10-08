'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createScriptFixture,
  nixEvalJson,
  repoRoot,
} = require('./helpers');

const cachePublicKey = 'darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=';
const endpoint = 'https://Brandons-MacBook-Pro.local:8443';
const jwtPublicKey = path.join(__dirname, 'fixtures/jwt-public.pem');
const moduleRelativePath = 'configurations/common-darwin/local-binary-cache.nix';
const publisherStateDirectory = '/var/db/local-binary-cache/publisher';
const tlsCertificate = path.join(__dirname, 'fixtures/tls-certificate.pem');

function moduleExpression() {
  const revision = process.env.LOCAL_BINARY_CACHE_MODULE_REV;
  if (revision === undefined) {
    return path.join(repoRoot, moduleRelativePath);
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('LOCAL_BINARY_CACHE_MODULE_REV must be a full lowercase commit hash');
  }

  const source = `git+file://${repoRoot}?rev=${revision}`;
  return `(import ((builtins.getFlake ${JSON.stringify(source)}).outPath + "/${moduleRelativePath}"))`;
}

function evalPublisherFixture(moduleSource, resultSource) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      fixture = flake.inputs.darwin.lib.darwinSystem {
        modules = [
          ${moduleExpression()}
          ({ ... }: {
            nixpkgs.hostPlatform = builtins.currentSystem;
          })
          (${moduleSource})
        ];
      };
      config = fixture.config;
    in
      ${resultSource}
  `);
}

function publisherModule(hostRole, fixture) {
  const server = `server = {
        enable = true;
        package = pkgs.hello;
        proxyPackage = pkgs.hello;
        stateDirectory = "/var/db/local-binary-cache/attic";
        jwtPublicKey = ${jwtPublicKey};
        tlsCertificate = ${tlsCertificate};
        tlsKeyFile = "/run/secrets/local-binary-cache-fixture-tls-key";
       };`;

  return `{ pkgs, ... }: {
    system.stateVersion = 7;
    system.primaryUser = "cache-operator";
    nix.checkConfig = false;
    nixpkgs.overlays = [ flake.overlays.unstable-packages ];
    services.localBinaryCache = {
      enable = true;
      hostRole = ${JSON.stringify(hostRole)};
      bootstrapMode = false;
      endpoint = ${JSON.stringify(endpoint)};
      cacheName = "darwin";
      cachePublicKey = ${JSON.stringify(cachePublicKey)};
      caCertificate = ${fixture.statePaths.ca};
      consumer.enable = true;
      publisher = {
        enable = true;
        package = pkgs.unstable.attic-client;
        tokenFile = ${JSON.stringify(fixture.statePaths.token)};
        stateDirectory = ${JSON.stringify(publisherStateDirectory)};
        intervalSeconds = 60;
      };
      ${server}
    };
  }`;
}

function renderPublisher(hostRole, fixture) {
  return evalPublisherFixture(
    publisherModule(hostRole, fixture),
    `let
      cache = config.services.localBinaryCache;
      service = config.launchd.daemons.local-binary-cache-publisher.serviceConfig;
      executable = builtins.head service.ProgramArguments;
    in {
      inherit executable service;
      activation = config.system.activationScripts.launchd.text;
      atticExecutable = fixture.pkgs.lib.getExe cache.publisher.package;
      caCertificate = toString cache.caCertificate;
      clientPatches = map (patch: builtins.baseNameOf (toString patch))
        (cache.publisher.package.patches or [ ]);
      executableText = builtins.readFile executable;
      hasAtticDaemon = config.launchd.daemons ? local-binary-cache-attic;
      hasCaddyDaemon = config.launchd.daemons ? local-binary-cache-caddy;
      plist = builtins.readFile
        "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-publisher.plist";
      publisher = {
        intervalSeconds = cache.publisher.intervalSeconds;
        stateDirectory = cache.publisher.stateDirectory;
        tokenFile = cache.publisher.tokenFile;
      };
    }`,
  );
}

function readClientConfig(executableText) {
  const match = executableText.match(/^export XDG_CONFIG_HOME=(\/nix\/store\/\S+)$/m);
  assert.notEqual(match, null, 'publisher must declare its generated Attic config');
  return fs.readFileSync(path.join(match[1], 'attic/config.toml'), 'utf8');
}

function sharedServiceContract(rendered) {
  return {
    argumentCount: rendered.service.ProgramArguments.length,
    executableName: path.basename(rendered.executable),
    runAtLoad: rendered.service.RunAtLoad,
    standardErrorPath: rendered.service.StandardErrorPath,
    standardOutPath: rendered.service.StandardOutPath,
    startInterval: rendered.service.StartInterval,
    userName: rendered.service.UserName,
    workingDirectory: rendered.service.WorkingDirectory,
  };
}

function assertPublisherRuntime(hostRole, fixture, poisonedToken, rendered) {
  assert.equal(fs.readFileSync(fixture.statePaths.token, 'utf8'), `${poisonedToken}\n`);
  assert.equal(path.isAbsolute(rendered.executable), true);
  assert.match(rendered.executable, /^\/nix\/store\/.*\/bin\/local-binary-cache-publish$/);
  assert.deepEqual(rendered.service.ProgramArguments, [rendered.executable]);
  assert.deepEqual(sharedServiceContract(rendered), {
    argumentCount: 1,
    executableName: 'local-binary-cache-publish',
    runAtLoad: true,
    standardErrorPath: '/var/log/local-binary-cache/publisher/stderr.log',
    standardOutPath: '/var/log/local-binary-cache/publisher/stdout.log',
    startInterval: 60,
    userName: 'root',
    workingDirectory: publisherStateDirectory,
  });
  assert.deepEqual(rendered.publisher, {
    intervalSeconds: 60,
    stateDirectory: publisherStateDirectory,
    tokenFile: fixture.statePaths.token,
  });
  assert.equal(rendered.clientPatches.includes('attic-client-ca-cert.patch'), true);

  for (const configuredInput of [
    rendered.atticExecutable,
    rendered.caCertificate,
    'cache_name=darwin',
    `pending_directory=${publisherStateDirectory}/pending`,
    `state_directory=${publisherStateDirectory}`,
    `token_file=${fixture.statePaths.token}`,
  ]) {
    assert.equal(
      rendered.executableText.includes(configuredInput),
      true,
      `publisher is missing configured input: ${configuredInput}`,
    );
  }
  assert.match(rendered.executableText, /push -j 1 "local:\$cache_name" "\$target"/);
  assert.equal(rendered.executableText.includes('ATTIC_CA_CERT="$ca_certificate"'), true);

  const clientConfig = readClientConfig(rendered.executableText);
  assert.equal(clientConfig.includes(`endpoint = ${JSON.stringify(endpoint)}`), true);
  assert.equal(clientConfig.includes(`token-file = ${JSON.stringify(fixture.statePaths.token)}`), true);

  for (const activationContract of [
    `publisher_state_directory=${publisherStateDirectory}`,
    'publisher_pending_directory="$publisher_state_directory/pending"',
    'publisher_log_directory=/var/log/local-binary-cache/publisher',
    'prepare_owned_directory "$publisher_state_directory" root wheel 0700',
    'prepare_owned_directory "$publisher_pending_directory" root wheel 0700',
    'prepare_log_file "$publisher_stdout_log" root wheel 0640',
    'prepare_log_file "$publisher_stderr_log" root wheel 0640',
    'prepare_owned_directory "$publisher_log_directory" root wheel 0750',
    'refusing attacker-controlled symlink path component',
    'refusing attacker-controlled parent directory',
    'refusing attacker-controlled log symlink',
  ]) {
    assert.equal(
      rendered.activation.includes(activationContract),
      true,
      `activation is missing publisher contract: ${activationContract}`,
    );
  }

  assert.equal(rendered.hasAtticDaemon, true);
  assert.equal(rendered.hasCaddyDaemon, true);

  for (const artifact of [rendered.executableText, clientConfig]) {
    assert.equal(artifact.includes(fixture.statePaths.token), true);
  }
  for (const artifact of [rendered.activation, rendered.plist]) {
    assert.equal(artifact.includes(fixture.statePaths.token), false);
  }
  for (const artifact of [rendered.activation, rendered.executableText, clientConfig, rendered.plist]) {
    assert.equal(artifact.includes(poisonedToken), false);
  }
}

test('personal role renders the root publisher runtime', t => {
  const fixture = createScriptFixture({
    statePaths: {
      ca: 'public/personal-ca.pem',
      token: 'secrets/personal-publisher-token',
    },
  });
  t.after(fixture.cleanup);
  const poisonedToken = 'poisoned-personal-publisher-token-value-54f20b';
  fs.writeFileSync(fixture.statePaths.ca, 'fixture-only-public-ca-certificate\n');
  fs.writeFileSync(fixture.statePaths.token, `${poisonedToken}\n`, { mode: 0o400 });
  const personal = renderPublisher('personal', fixture);
  assertPublisherRuntime('personal', fixture, poisonedToken, personal);
});

test('disabled and bootstrap fixtures render no publisher executable or daemon', t => {
  const fixture = createScriptFixture({
    statePaths: {
      ca: 'public/bootstrap-ca.pem',
      token: 'secrets/bootstrap-disabled-publisher-token',
    },
  });
  t.after(fixture.cleanup);
  const poisonedToken = 'poisoned-bootstrap-disabled-token-value-924bd0';
  fs.writeFileSync(fixture.statePaths.ca, 'fixture-only-bootstrap-ca-certificate\n');
  fs.writeFileSync(fixture.statePaths.token, `${poisonedToken}\n`, { mode: 0o400 });

  const inspect = `let
    hasPublisherDaemon = config.launchd.daemons ? local-binary-cache-publisher;
    publisherService = if hasPublisherDaemon
      then config.launchd.daemons.local-binary-cache-publisher.serviceConfig
      else { };
  in {
    inherit hasPublisherDaemon;
    activation = config.system.activationScripts.launchd.text;
    publisherExecutable = if publisherService ? ProgramArguments
      then builtins.head publisherService.ProgramArguments
      else null;
  }`;
  const disabled = evalPublisherFixture('{ ... }: { system.stateVersion = 7; }', inspect);
  const bootstrap = evalPublisherFixture(
    `{ pkgs, ... }: {
      system.stateVersion = 7;
      system.primaryUser = "cache-operator";
      nixpkgs.overlays = [ flake.overlays.unstable-packages ];
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
        caCertificate = ${fixture.statePaths.ca};
        publisher = {
          enable = false;
          package = pkgs.unstable.attic-client;
          tokenFile = ${JSON.stringify(fixture.statePaths.token)};
          stateDirectory = ${JSON.stringify(publisherStateDirectory)};
        };
        bootstrap = {
          jwtPrivateKey = "/run/secrets/local-binary-cache-bootstrap-jwt";
          cachePublicKeyOutput = "/var/db/local-binary-cache/bootstrap/cache-public-key.txt";
          personalTokenOutput = "/var/db/local-binary-cache/bootstrap/personal-token";
        };
        server = {
          enable = true;
          package = pkgs.hello;
          proxyPackage = pkgs.hello;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = "/run/secrets/local-binary-cache-bootstrap-tls-key";
        };
      };
    }`,
    inspect,
  );

  for (const rendered of [disabled, bootstrap]) {
    assert.equal(rendered.hasPublisherDaemon, false);
    assert.equal(rendered.publisherExecutable, null);
    assert.equal(
      rendered.activation.includes('local-binary-cache: preparing publisher runtime directories'),
      false,
    );
    assert.equal(rendered.activation.includes(fixture.statePaths.token), false);
    assert.equal(rendered.activation.includes(poisonedToken), false);
  }
});
