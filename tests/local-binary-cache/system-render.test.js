'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createScriptFixture,
  evalDarwinFixture,
  runScript,
} = require('./helpers');

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

function renderCaddyFixture(tlsKeyFile) {
  return evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
        server = {
          enable = true;
          package = pkgs.hello;
          proxyPackage = pkgs.caddy;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = ${JSON.stringify(tlsKeyFile)};
        };
      };
    }`,
    `let
      server = config.services.localBinaryCache.server;
    in {
      caddyExecutable = "${'${server.proxyPackage}'}/bin/caddy";
      proxyConfigFile = toString server.proxyConfigFile;
      proxyConfigText = builtins.readFile server.proxyConfigFile;
    }`,
  );
}

function adaptCaddyConfig(rendered) {
  return JSON.parse(childProcess.execFileSync(
    rendered.caddyExecutable,
    ['adapt', '--config', rendered.proxyConfigFile, '--adapter', 'caddyfile'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

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
      hasAtticSystemDaemon = config.launchd.daemons ? local-binary-cache-attic;
      hasCaddySystemDaemon = config.launchd.daemons ? local-binary-cache-caddy;
      hasAtticLoginAgent = config.launchd.agents ? local-binary-cache-attic;
      hasCaddyLoginAgent = config.launchd.agents ? local-binary-cache-caddy;
      hasAtticUserAgent = config.launchd.user.agents ? local-binary-cache-attic;
      hasCaddyUserAgent = config.launchd.user.agents ? local-binary-cache-caddy;
      proxyConfigFile = config.services.localBinaryCache.server.proxyConfigFile;
      proxyWrapper = config.services.localBinaryCache.server.proxyWrapper;
      activation = config.system.activationScripts.launchd.text;
    }`,
  );

  assert.equal(rendered.hasAtticSystemDaemon, false);
  assert.equal(rendered.hasCaddySystemDaemon, false);
  assert.equal(rendered.hasAtticLoginAgent, false);
  assert.equal(rendered.hasCaddyLoginAgent, false);
  assert.equal(rendered.hasAtticUserAgent, false);
  assert.equal(rendered.hasCaddyUserAgent, false);
  assert.equal(rendered.proxyConfigFile, null);
  assert.equal(rendered.proxyWrapper, null);
  assert.equal(rendered.activation.includes('local-binary-cache: preparing Attic runtime directories'), false);
  assert.equal(rendered.activation.includes('local-binary-cache: preparing Caddy log directory'), false);
});

test('server renders an explicit pinned Caddy TLS proxy and pre-login daemon', () => {
  const tlsKeyFile = '/run/secrets/local-binary-cache-tls-key';
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
          proxyPackage = pkgs.caddy;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = ${JSON.stringify(tlsKeyFile)};
        };
      };
    }`,
    `let
      server = config.services.localBinaryCache.server;
      daemon = config.launchd.daemons.local-binary-cache-caddy;
      service = daemon.serviceConfig;
      wrapperExecutable = "${'${server.proxyWrapper}'}/bin/local-binary-cache-caddy";
      plistPath = "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist";
    in {
      proxyPackageVersion = server.proxyPackage.version;
      caddyExecutable = "${'${server.proxyPackage}'}/bin/caddy";
      proxyConfigFile = toString server.proxyConfigFile;
      proxyConfigText = builtins.readFile server.proxyConfigFile;
      proxyWrapper = toString server.proxyWrapper;
      inherit wrapperExecutable;
      hasSystemDaemon = config.launchd.daemons ? local-binary-cache-caddy;
      hasLoginAgent = config.launchd.agents ? local-binary-cache-caddy;
      hasUserAgent = config.launchd.user.agents ? local-binary-cache-caddy;
      label = service.Label or null;
      programArguments = service.ProgramArguments or null;
      runAtLoad = service.RunAtLoad or null;
      keepAliveSuccessfulExit =
        if service ? KeepAlive && builtins.isAttrs service.KeepAlive
        then service.KeepAlive.SuccessfulExit
        else null;
      throttleInterval = service.ThrottleInterval or null;
      userName = service.UserName or null;
      standardOutPath = service.StandardOutPath or null;
      standardErrorPath = service.StandardErrorPath or null;
      activation = config.system.activationScripts.launchd.text;
      plist = builtins.readFile plistPath;
    }`,
  );

  assert.equal(rendered.proxyPackageVersion, '2.11.4');
  assert.match(rendered.proxyConfigFile, /-local-binary-cache-Caddyfile$/);
  assert.equal(path.isAbsolute(rendered.proxyConfigFile), true);
  assert.equal(path.isAbsolute(rendered.proxyWrapper), true);
  assert.equal(path.isAbsolute(rendered.wrapperExecutable), true);

  assert.match(rendered.proxyConfigText, /admin off/);
  assert.match(rendered.proxyConfigText, /persist_config off/);
  assert.match(rendered.proxyConfigText, /auto_https off/);
  assert.match(rendered.proxyConfigText, /protocols h1 h2/);
  assert.ok(rendered.proxyConfigText.includes(
    `${JSON.stringify('https://Brandons-MacBook-Pro.local:8443')} {`,
  ));
  const tlsDirective = rendered.proxyConfigText.match(
    /^\ttls ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/m,
  );
  assert.notEqual(tlsDirective, null);
  const renderedTlsCertificate = JSON.parse(tlsDirective[1]);
  assert.match(renderedTlsCertificate, /^\/nix\/store\/[a-z0-9]+-tls-certificate\.pem$/);
  assert.equal(JSON.parse(tlsDirective[2]), tlsKeyFile);
  assert.ok(rendered.proxyConfigText.includes(
    `reverse_proxy ${JSON.stringify('http://127.0.0.1:8080')}`,
  ));
  assert.doesNotMatch(rendered.proxyConfigText, /tls internal|acme|http_port|https_port/);

  const adapted = JSON.parse(childProcess.execFileSync(
    rendered.caddyExecutable,
    ['adapt', '--config', rendered.proxyConfigFile, '--adapter', 'caddyfile'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
  const caddyServer = adapted.apps.http.servers.srv0;
  const reverseProxy = caddyServer.routes[0].handle[0].routes[0].handle[0];

  assert.deepEqual(adapted.admin, {
    config: { persist: false },
    disabled: true,
  });
  assert.deepEqual(Object.keys(adapted.apps.http.servers), ['srv0']);
  assert.deepEqual(caddyServer.listen, [':8443']);
  assert.deepEqual(caddyServer.protocols, ['h1', 'h2']);
  assert.equal(caddyServer.protocols.includes('h3'), false);
  assert.deepEqual(caddyServer.automatic_https, { disable: true });
  assert.deepEqual(caddyServer.routes[0].match, [{ host: ['brandons-macbook-pro.local'] }]);
  assert.equal(reverseProxy.handler, 'reverse_proxy');
  assert.deepEqual(reverseProxy.upstreams, [{ dial: '127.0.0.1:8080' }]);
  assert.deepEqual(adapted.apps.tls.certificates.load_files, [{
    certificate: renderedTlsCertificate,
    key: tlsKeyFile,
    tags: ['cert0'],
  }]);
  assert.equal(Object.hasOwn(adapted.apps.tls, 'automation'), false);
  assert.equal(JSON.stringify(adapted).includes('udp'), false);

  assert.equal(rendered.hasSystemDaemon, true);
  assert.equal(rendered.hasLoginAgent, false);
  assert.equal(rendered.hasUserAgent, false);
  assert.equal(rendered.label, 'org.nixos.local-binary-cache-caddy');
  assert.deepEqual(rendered.programArguments, [rendered.wrapperExecutable]);
  assert.equal(rendered.runAtLoad, true);
  assert.equal(rendered.keepAliveSuccessfulExit, false);
  assert.equal(rendered.throttleInterval, 10);
  assert.equal(rendered.userName, 'cache-operator');
  assert.equal(rendered.standardOutPath, '/var/log/local-binary-cache/caddy/stdout.log');
  assert.equal(rendered.standardErrorPath, '/var/log/local-binary-cache/caddy/stderr.log');
  assert.notEqual(rendered.standardOutPath, rendered.standardErrorPath);

  assert.match(rendered.plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    rendered.plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  );
  assert.match(rendered.plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(rendered.activation, /local-binary-cache: preparing Caddy log directory/);
  assert.match(rendered.activation, /prepare_owned_directory "\$caddy_log_directory" root wheel 0755/);
  assert.match(rendered.activation, /prepare_log_file "\$caddy_stdout_log" "\$attic_user" staff 0640/);
  assert.match(rendered.activation, /prepare_log_file "\$caddy_stderr_log" "\$attic_user" staff 0640/);
  assert.match(rendered.activation, /prepare_owned_directory "\$caddy_log_directory" "\$attic_user" staff 0750/);

  for (const renderedText of [rendered.proxyConfigText, rendered.activation, rendered.plist]) {
    for (const secretValue of Object.values(poisonedSecrets)) {
      assert.equal(renderedText.includes(secretValue), false);
    }
  }
});

test('TLS key option rejects Caddyfile listener injection with an option diagnostic', () => {
  const tlsKeyFile = '/run/secrets/key\n}\n:9000 {';

  assert.throws(
    () => renderCaddyFixture(tlsKeyFile),
    error => {
      assert.match(error.stderr, /option `services\.localBinaryCache\.server\.tlsKeyFile'/);
      assert.match(error.stderr, /Caddyfile-serializable absolute runtime path/);
      return true;
    },
  );
});

for (const [name, tlsKeyFile] of [
  ['whitespace', '/run/secrets/local binary cache key'],
  ['quote', '/run/secrets/local-"binary"-cache-key'],
]) {
  test(`Caddyfile serialization preserves ${name} in the TLS key path`, () => {
    const rendered = renderCaddyFixture(tlsKeyFile);
    const adapted = adaptCaddyConfig(rendered);
    const servers = Object.values(adapted.apps.http.servers);

    assert.deepEqual(servers.flatMap(server => server.listen ?? []), [':8443']);
    assert.deepEqual(adapted.apps.tls.certificates.load_files.map(file => file.key), [tlsKeyFile]);
    assert.ok(rendered.proxyConfigText.includes(JSON.stringify(tlsKeyFile)));
  });
}

test('TLS key option rejects backslashes before Caddyfile rendering', () => {
  assert.throws(
    () => renderCaddyFixture('/run/secrets/local\\binary\\cache-key'),
    error => {
      assert.match(error.stderr, /option `services\.localBinaryCache\.server\.tlsKeyFile'/);
      assert.match(error.stderr, /Caddyfile-serializable absolute runtime path/);
      return true;
    },
  );
});

test('Caddy wrapper retries secret failures and execs exact command for a healthy SOPS key', () => {
  const fixture = createScriptFixture();
  const secretPoison = poisonedSecrets.tlsPrivateKey;
  const generationDirectory = path.join(fixture.root, 'run', 'secrets.d', '1');
  const stableDirectory = path.join(fixture.root, 'run', 'secrets');
  const tlsKeyFile = path.join(stableDirectory, 'local-binary-cache-tls-key');
  const generationKeyFile = path.join(generationDirectory, 'local-binary-cache-tls-key');
  const unsafeTarget = path.join(generationDirectory, 'unsafe-target');
  const execLog = path.join(fixture.root, 'caddy-exec.log');

  fs.mkdirSync(generationDirectory, { recursive: true });
  fs.symlinkSync(generationDirectory, stableDirectory, 'dir');

  try {
    const rendered = evalDarwinFixture(
      `{ pkgs, ... }:
      let
        proxyPackage = pkgs.writeShellScriptBin "caddy" ''
          {
            printf '%s\\n' "$0"
            printf '%s\\n' "$@"
          } > "$CADDY_EXEC_LOG"
        '';
      in {
        system.primaryUser = "cache-operator";
        services.localBinaryCache = {
          enable = true;
          hostRole = "personal";
          bootstrapMode = true;
          server = {
            enable = true;
            package = pkgs.hello;
            inherit proxyPackage;
            stateDirectory = "/var/db/local-binary-cache/attic";
            jwtPublicKey = ${jwtPublicKey};
            tlsCertificate = ${tlsCertificate};
            tlsKeyFile = ${JSON.stringify(tlsKeyFile)};
          };
        };
      }`,
      `let
        server = config.services.localBinaryCache.server;
        wrapperExecutable = "${'${server.proxyWrapper}'}/bin/local-binary-cache-caddy";
      in {
        inherit wrapperExecutable;
        wrapperText = builtins.readFile wrapperExecutable;
        caddyExecutable = "${'${server.proxyPackage}'}/bin/caddy";
        proxyConfigFile = toString server.proxyConfigFile;
      }`,
    );
    const runWrapper = () => {
      fs.rmSync(execLog, { force: true });
      return runScript(rendered.wrapperExecutable, [], {
        env: { CADDY_EXEC_LOG: execLog },
        fixture,
      });
    };
    const assertNoExecOrLeak = result => {
      assert.equal(fs.existsSync(execLog), false);
      assert.equal(result.stdout.includes(secretPoison), false);
      assert.equal(result.stderr.includes(secretPoison), false);
    };

    const missing = runWrapper();
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes(`TLS private key is missing: ${tlsKeyFile}`));
    assertNoExecOrLeak(missing);

    fs.writeFileSync(generationKeyFile, secretPoison, { mode: 0o000 });
    const unreadable = runWrapper();
    assert.notEqual(unreadable.status, 0);
    assert.ok(unreadable.stderr.includes(`TLS private key is unreadable: ${tlsKeyFile}`));
    assertNoExecOrLeak(unreadable);

    fs.chmodSync(generationKeyFile, 0o600);
    fs.rmSync(generationKeyFile);
    fs.writeFileSync(unsafeTarget, secretPoison, { mode: 0o400 });
    fs.symlinkSync(unsafeTarget, generationKeyFile);
    const unsafe = runWrapper();
    assert.notEqual(unsafe.status, 0);
    assert.ok(unsafe.stderr.includes(`refusing unsafe TLS private key symlink: ${tlsKeyFile}`));
    assertNoExecOrLeak(unsafe);

    fs.rmSync(generationKeyFile);
    fs.writeFileSync(generationKeyFile, secretPoison, { mode: 0o400 });
    const healthy = runWrapper();
    assert.equal(healthy.status, 0);
    assert.equal(healthy.stdout, '');
    assert.equal(healthy.stderr, '');
    assert.deepEqual(fs.readFileSync(execLog, 'utf8').trimEnd().split('\n'), [
      rendered.caddyExecutable,
      'run',
      '--config',
      rendered.proxyConfigFile,
      '--adapter',
      'caddyfile',
    ]);

    assert.match(rendered.wrapperText, /TLS certificate is missing/);
    assert.match(rendered.wrapperText, /TLS certificate is unreadable/);
    assert.match(rendered.wrapperText, /TLS private key is missing/);
    assert.match(rendered.wrapperText, /TLS private key is unreadable/);
    assert.match(rendered.wrapperText, /refusing unsafe TLS private key symlink/);
    assert.equal(rendered.wrapperText.includes(secretPoison), false);
  } finally {
    if (fs.existsSync(unsafeTarget)) {
      fs.chmodSync(unsafeTarget, 0o600);
    }
    fixture.cleanup();
  }
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
