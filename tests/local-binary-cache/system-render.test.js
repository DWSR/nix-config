'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createScriptFixture,
  evalDarwinFixture,
  nixEvalJson,
  repoRoot,
  runScript,
} = require('./helpers');

const jwtPublicKey = path.join(__dirname, 'fixtures/jwt-public.pem');
const tlsCertificate = path.join(__dirname, 'fixtures/tls-certificate.pem');
const cachePublicKey = 'darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=';
const personalCachePublicKey = fs.readFileSync(
  path.join(repoRoot, 'certificates/local-binary-cache/cache-public-key.txt'),
  'utf8',
).trim();
const canonicalCacheAuthority = 'brandons-macbook-pro.local:8443';
const communityCacheKey = 'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=';
const communitySubstituter = 'https://nix-community.cachix.org';
const localSubstituter = 'https://Brandons-MacBook-Pro.local:8443/darwin';
const publicSubstituter = 'https://cache.nixos.org/';
const combinedCaBundle = '/etc/ssl/certs/ca-certificates.crt';
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

function readyShopifyPublisherModule(options = {}) {
  const chainedHooks = (options.chainedHooks ?? []).map(JSON.stringify).join(' ');
  const externalHookInclude = options.externalHookInclude === undefined
    ? ''
    : `externalHookInclude = ${JSON.stringify(options.externalHookInclude)};`;

  return `{ lib, pkgs, ... }: {
    system.stateVersion = 7;
    nix.checkConfig = false;
    services.localBinaryCache = {
      enable = true;
      hostRole = "shopify";
      bootstrapMode = false;
      cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";
      caCertificate = ${tlsCertificate};
      consumer.enable = true;
      publisher = {
        enable = true;
        package = pkgs.hello;
        tokenFile = "/run/secrets/local-binary-cache-token";
        stateDirectory = "/var/db/local-binary-cache/publisher";
        chainedHooks = [ ${chainedHooks} ];
        ${externalHookInclude}
      };
    };
    nix.extraOptions = lib.mkOrder 5000 ''
      !include /etc/nix/nix.conf.d/shopify.conf
      keep-outputs = true
    '';
  }`;
}

function readyConsumerModule(hostRole, options = {}) {
  const existingSubstituter = `https://${hostRole}-existing.example`;
  const existingExtraSubstituter = `https://${hostRole}-extra.example`;
  const existingCacheKey = `${hostRole}-existing:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=`;
  const configuredCachePublicKey = options.cachePublicKey ?? cachePublicKey;
  const configuredCaCertificate = options.caCertificate ?? tlsCertificate;
  const configuredTlsCertificate = options.tlsCertificate ?? tlsCertificate;
  const externalHookInclude = options.externalHookInclude === undefined
    ? ''
    : `externalHookInclude = ${JSON.stringify(options.externalHookInclude)};`;
  const server = hostRole === 'personal'
    ? `server = {
        enable = true;
        package = pkgs.hello;
        proxyPackage = pkgs.hello;
        stateDirectory = "/var/db/local-binary-cache/attic";
        jwtPublicKey = ${jwtPublicKey};
        tlsCertificate = ${configuredTlsCertificate};
        tlsKeyFile = "/run/secrets/local-binary-cache-tls-key";
      };`
    : '';
  const managedInclude = hostRole === 'shopify'
    ? `nix.extraOptions = lib.mkOrder 5000 ''
        !include ${options.externalHookInclude ?? '/etc/nix/nix.conf.d/shopify.conf'}
        keep-outputs = true
      '';`
    : '';

  return `{ lib, pkgs, ... }: {
    system.stateVersion = 7;
    system.primaryUser = "cache-operator";
    nix.checkConfig = false;
    nix.settings = {
      substituters = [ ${JSON.stringify(existingSubstituter)} ];
      extra-substituters = [ ${JSON.stringify(existingExtraSubstituter)} ];
      extra-trusted-public-keys = [ ${JSON.stringify(existingCacheKey)} ];
    };
    services.localBinaryCache = {
      enable = true;
      hostRole = ${JSON.stringify(hostRole)};
      bootstrapMode = false;
      cachePublicKey = ${JSON.stringify(configuredCachePublicKey)};
      caCertificate = ${configuredCaCertificate};
      consumer.enable = true;
      publisher = {
        enable = true;
        package = pkgs.hello;
        tokenFile = "/run/secrets/local-binary-cache-token";
        stateDirectory = "/var/db/local-binary-cache/publisher";
        ${externalHookInclude}
      };
      ${server}
    };
    ${managedInclude}
  }`;
}

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

function shellAssignment(script, name) {
  const matches = script.split('\n').filter(line => line.startsWith(`${name}=`));
  assert.equal(matches.length, 1, `expected exactly one ${name} assignment`);
  return matches[0];
}

function runNix(nixExecutable, args, fixture, options = {}) {
  return runScript(
    nixExecutable,
    ['--extra-experimental-features', 'nix-command', ...args],
    {
      fixture,
      env: options.env,
      input: options.input,
      timeout: options.timeout,
    },
  );
}

function evalLiveHost(hostName, resultSource, moduleSource = null) {
  const host = moduleSource === null
    ? 'base'
    : `base.extendModules { modules = [ (${moduleSource}) ]; }`;

  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      base = flake.darwinConfigurations.${JSON.stringify(hostName)};
      host = ${host};
      config = host.config;
    in
      ${resultSource}
  `);
}

function evalLiveRetentionPolicy(hostName, moduleSource = null) {
  return evalLiveHost(
    hostName,
    `let
      calendarEntries = interval:
        if builtins.isList interval then interval else [ interval ];
    in {
      gc = {
        automatic = config.nix.gc.automatic;
        interval = calendarEntries
          config.launchd.daemons.nix-gc.serviceConfig.StartCalendarInterval;
        options = config.nix.gc.options;
      };
      optimise = {
        automatic = config.nix.optimise.automatic;
        interval = calendarEntries
          config.launchd.daemons.nix-optimise.serviceConfig.StartCalendarInterval;
      };
      cachePressure = config.services.localBinaryCache.gcPolicy;
      nixPressure = {
        hasMinFree = builtins.hasAttr "min-free" config.nix.settings;
        hasMaxFree = builtins.hasAttr "max-free" config.nix.settings;
        minFree = config.nix.settings."min-free" or null;
        maxFree = config.nix.settings."max-free" or null;
      };
    }`,
    moduleSource,
  );
}

function assertRequiredLiveHostFields(hostRole, contract) {
  const expectedTokenFile = hostRole === 'personal'
    ? '/run/secrets/local-binary-cache-personal-token'
    : '/run/secrets/local-binary-cache-shopify-token';

  assert.equal(contract.hostRole, hostRole, `${hostRole}: required host role`);
  assert.equal(
    contract.endpoint,
    'https://Brandons-MacBook-Pro.local:8443',
    `${hostRole}: required cache endpoint`,
  );
  assert.equal(
    contract.cachePublicKey,
    personalCachePublicKey,
    `${hostRole}: required cache signing key`,
  );
  assert.equal(
    contract.caCertificate,
    contract.expectedCaCertificate,
    `${hostRole}: required cache CA trust path`,
  );
  assert.equal(contract.cacheName, 'darwin', `${hostRole}: required publication cache scope`);
  assert.equal(
    contract.publisher.tokenFile,
    expectedTokenFile,
    `${hostRole}: required publisher token path`,
  );
  assert.equal(
    contract.publisher.stateDirectory,
    '/var/db/local-binary-cache/publisher',
    `${hostRole}: required publisher state path`,
  );
  assert.equal(
    contract.publisher.tokenValidity,
    31557600,
    `${hostRole}: required one-year publisher token validity`,
  );

  if (hostRole === 'personal') {
    assert.equal(contract.server.enable, true, 'personal: required cache server role');
    assert.equal(contract.server.retentionDays, 30, 'personal: required Attic retention');
    assert.equal(contract.server.gcInterval, '12 hours', 'personal: required Attic GC interval');
    assert.equal(
      contract.server.tlsKeyFile,
      '/run/secrets/local-binary-cache-tls-key',
      'personal: required TLS key path',
    );
    assert.equal(
      contract.jwtPrivateKey,
      '/run/secrets/local-binary-cache-jwt-private-key',
      'personal: required JWT private key path',
    );
  } else {
    assert.equal(contract.server.enable, false, 'shopify: cache server role must remain disabled');
  }
}

function evalRequiredLiveHostContract(hostName, moduleSource = null) {
  return evalLiveHost(
    hostName,
    `let
      cache = config.services.localBinaryCache;
    in {
      hostRole = cache.hostRole;
      endpoint = cache.endpoint;
      cacheName = cache.cacheName;
      cachePublicKey = cache.cachePublicKey;
      caCertificate = if cache.caCertificate == null then null else toString cache.caCertificate;
      expectedCaCertificate = toString flake.outPath + "/certificates/local-binary-cache/ca.pem";
      publisher = {
        tokenFile = cache.publisher.tokenFile;
        stateDirectory = cache.publisher.stateDirectory;
        tokenValidity = cache.publisher.tokenValidity;
      };
      server = {
        enable = cache.server.enable;
        retentionDays = cache.server.retentionDays;
        gcInterval = cache.server.gcInterval;
        tlsKeyFile = cache.server.tlsKeyFile;
      };
      jwtPrivateKey = cache.bootstrap.jwtPrivateKey;
    }`,
    moduleSource,
  );
}

function assertLiveHostMutationRejected(
  hostRole,
  hostName,
  field,
  moduleSource,
  diagnostic,
) {
  assert.throws(
    () => assertRequiredLiveHostFields(
      hostRole,
      evalRequiredLiveHostContract(hostName, moduleSource),
    ),
    error => {
      assert.match(
        `${error.message}\n${error.stderr ?? ''}`,
        diagnostic,
        `${hostName} ${field} mutation failed without the required diagnostic`,
      );
      return true;
    },
  );
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

test('live hosts render exact seven-day GC and distinct weekly optimisation schedules', () => {
  const personal = evalLiveRetentionPolicy('Brandons-MacBook-Pro');
  const shopify = evalLiveRetentionPolicy('ShopifyLaptop');
  const daily0315 = [{
    Day: null,
    Hour: 3,
    Minute: 15,
    Month: null,
    Weekday: null,
  }];
  const sunday0315 = [{
    Day: null,
    Hour: 3,
    Minute: 15,
    Month: null,
    Weekday: 0,
  }];
  const sunday0415 = [{
    Day: null,
    Hour: 4,
    Minute: 15,
    Month: null,
    Weekday: 0,
  }];

  assert.equal(personal.gc.automatic, true);
  assert.equal(shopify.gc.automatic, true);
  assert.equal(personal.gc.options, '--delete-older-than 7d');
  assert.equal(shopify.gc.options, '--delete-older-than 7d');
  assert.deepEqual(personal.gc.interval, daily0315);
  assert.deepEqual(shopify.gc.interval, sunday0315);
  assert.equal(personal.optimise.automatic, true);
  assert.equal(shopify.optimise.automatic, true);
  assert.deepEqual(personal.optimise.interval, sunday0415);
  assert.deepEqual(shopify.optimise.interval, sunday0415);

  for (const rendered of [personal, shopify]) {
    assert.deepEqual(rendered.cachePressure, {
      maxFree: null,
      minFree: null,
    });
    assert.deepEqual(rendered.nixPressure, {
      hasMaxFree: false,
      hasMinFree: false,
      maxFree: null,
      minFree: null,
    });
  }
});

test('live-host required fields fail closed through Nix module mutations', () => {
  const contracts = {
    personal: evalRequiredLiveHostContract('Brandons-MacBook-Pro'),
    shopify: evalRequiredLiveHostContract('ShopifyLaptop'),
  };

  assertRequiredLiveHostFields('personal', contracts.personal);
  assertRequiredLiveHostFields('shopify', contracts.shopify);

  const sharedMutations = [
    {
      field: 'endpoint',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.endpoint = lib.mkForce "https://alternate.local:8443";
      }`,
      diagnostic: /option `services\.localBinaryCache\.endpoint'/,
    },
    {
      field: 'cache signing key',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.cachePublicKey = lib.mkForce ${JSON.stringify(cachePublicKey)};
      }`,
      diagnostic: role => new RegExp(`${role}: required cache signing key`),
    },
    {
      field: 'CA trust path',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.caCertificate = lib.mkForce ${tlsCertificate};
      }`,
      diagnostic: role => new RegExp(`${role}: required cache CA trust path`),
    },
    {
      field: 'publication cache scope',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.cacheName = lib.mkForce "alternate";
      }`,
      diagnostic: /option `services\.localBinaryCache\.cacheName'/,
    },
    {
      field: 'publisher token path',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.publisher.tokenFile =
          lib.mkForce "/run/secrets/local-binary-cache-mutated-token";
      }`,
      diagnostic: role => new RegExp(`${role}: required publisher token path`),
    },
    {
      field: 'publisher state path',
      moduleSource: `{ lib, ... }: {
        services.localBinaryCache.publisher.stateDirectory =
          lib.mkForce "/var/db/local-binary-cache/mutated-publisher";
      }`,
      diagnostic: role => new RegExp(`${role}: required publisher state path`),
    },
  ];

  for (const [role, hostName] of [
    ['personal', 'Brandons-MacBook-Pro'],
    ['shopify', 'ShopifyLaptop'],
  ]) {
    for (const mutation of sharedMutations) {
      assertLiveHostMutationRejected(
        role,
        hostName,
        mutation.field,
        mutation.moduleSource,
        typeof mutation.diagnostic === 'function'
          ? mutation.diagnostic(role)
          : mutation.diagnostic,
      );
    }
  }

  assertLiveHostMutationRejected(
    'personal',
    'Brandons-MacBook-Pro',
    'Attic retention',
    `{ lib, ... }: {
      services.localBinaryCache.server.retentionDays = lib.mkForce 31;
    }`,
    /option `services\.localBinaryCache\.server\.retentionDays'/,
  );
});

test('live personal host renders consumer and root publisher ready mode', () => {
  const rendered = evalLiveHost(
    'Brandons-MacBook-Pro',
    `let
      cache = config.services.localBinaryCache;
      server = cache.server;
      homeManager = config.home-manager.users.brandonmcnama;
      mcpProxyConfig = builtins.fromJSON
        (builtins.unsafeDiscardStringContext
          homeManager.xdg.configFile."mcpproxy/mcp_config.json".text);
      hasAtticDaemon = config.launchd.daemons ? local-binary-cache-attic;
      hasCaddyDaemon = config.launchd.daemons ? local-binary-cache-caddy;
      hasPublisherDaemon = config.launchd.daemons ? local-binary-cache-publisher;
      atticService = if hasAtticDaemon
        then config.launchd.daemons.local-binary-cache-attic.serviceConfig
        else { };
      caddyService = if hasCaddyDaemon
        then config.launchd.daemons.local-binary-cache-caddy.serviceConfig
        else { };
      publisherService = if hasPublisherDaemon
        then config.launchd.daemons.local-binary-cache-publisher.serviceConfig
        else { };
      renderSecret = name:
        if builtins.hasAttr name config.sops.secrets then
          let secret = builtins.getAttr name config.sops.secrets;
          in {
            present = true;
            key = secret.key;
            mode = secret.mode;
            owner = secret.owner;
            path = secret.path;
            sopsFile = toString secret.sopsFile;
          }
        else {
          present = false;
          key = null;
          mode = null;
          owner = null;
          path = null;
          sopsFile = null;
        };
      readNullable = file: if file == null then "" else builtins.readFile file;
      caddyWrapperExecutable = if server.proxyWrapper == null
        then null
        else "${'${server.proxyWrapper}'}/bin/local-binary-cache-caddy";
      localDaemons = builtins.filter
        (name: builtins.match "local-binary-cache-.*" name != null)
        (builtins.attrNames config.launchd.daemons);
    in {
      cacheState = {
        enable = cache.enable;
        hostRole = cache.hostRole;
        bootstrapMode = cache.bootstrapMode;
        server = server.enable;
        consumer = cache.consumer.enable;
        publisher = cache.publisher.enable;
        cachePublicKey = cache.cachePublicKey;
        bootstrapClientPackage = toString cache.bootstrap.clientPackage;
        expectedBootstrapClientPackage = toString host.pkgs.unstable.attic-client;
        bootstrapClientPatches = map toString (cache.bootstrap.clientPackage.patches or [ ]);
        publisherClientPackage = toString cache.publisher.package;
        expectedPublisherClientPackage = toString host.pkgs.unstable.attic-client;
        publisherClientPatches = map toString (cache.publisher.package.patches or [ ]);
        serverPatches = map toString (server.package.patches or [ ]);
      };
      listenerContracts = {
        attic = server.listenAddress;
        mcpProxy = mcpProxyConfig.listen;
        mcpProxyPort = homeManager.home.mcp.listenPort;
      };
      publicPaths = {
        ca = if cache.caCertificate == null then null else toString cache.caCertificate;
        jwtVerifier = if server.jwtPublicKey == null then null else toString server.jwtPublicKey;
        tlsCertificate = if server.tlsCertificate == null then null else toString server.tlsCertificate;
      };
      expectedPaths = {
        ca = toString flake.outPath + "/certificates/local-binary-cache/ca.pem";
        jwtVerifier = toString flake.outPath + "/certificates/local-binary-cache/jwt-public.pem";
        tlsCertificate = toString flake.outPath + "/certificates/local-binary-cache/server.pem";
        sopsFile = toString flake.outPath + "/secrets/local-binary-cache.personal.yaml";
      };
      runtimePaths = {
        jwtPrivateKey = cache.bootstrap.jwtPrivateKey;
        tlsKey = server.tlsKeyFile;
        cachePublicKeyOutput = cache.bootstrap.cachePublicKeyOutput;
        personalTokenOutput = cache.bootstrap.personalTokenOutput;
        shopifyTokenOutput = cache.bootstrap.shopifyTokenOutput;
        serverState = server.stateDirectory;
        publisherState = cache.publisher.stateDirectory;
        publisherToken = cache.publisher.tokenFile;
      };
      secrets = {
        tls = renderSecret "local-binary-cache-tls-key";
        jwt = renderSecret "local-binary-cache-jwt-private-key";
        publisher = renderSecret "local-binary-cache-personal-token";
      };
      publisherSurfaces = {
        enqueuePackage = if cache.publisher.enqueuePackage == null
          then null
          else toString cache.publisher.enqueuePackage;
        postBuildHookPackage = if cache.publisher.postBuildHookPackage == null
          then null
          else toString cache.publisher.postBuildHookPackage;
        tokenFile = cache.publisher.tokenFile;
        stateDirectory = cache.publisher.stateDirectory;
      };
      consumerSurfaces = {
        certificateFiles = map toString config.security.pki.certificateFiles;
        settings = config.nix.settings;
        nixSettings = builtins.toJSON config.nix.settings;
      };
      services = {
        inherit
          hasAtticDaemon
          hasCaddyDaemon
          hasPublisherDaemon
          localDaemons
          caddyWrapperExecutable
          ;
        atticArguments = atticService.ProgramArguments or null;
        atticUser = atticService.UserName or null;
        caddyArguments = caddyService.ProgramArguments or null;
        caddyUser = caddyService.UserName or null;
        publisherArguments = publisherService.ProgramArguments or null;
        publisherUser = publisherService.UserName or null;
        publisherRunAtLoad = publisherService.RunAtLoad or null;
        publisherStartInterval = publisherService.StartInterval or null;
        publisherWorkingDirectory = publisherService.WorkingDirectory or null;
        publisherStandardOutPath = publisherService.StandardOutPath or null;
        publisherStandardErrorPath = publisherService.StandardErrorPath or null;
        atticConfigFile = if server.configFile == null then null else toString server.configFile;
        proxyConfigFile = if server.proxyConfigFile == null then null else toString server.proxyConfigFile;
      };
      artifacts = {
        activation = config.system.activationScripts.launchd.text;
        atticConfig = readNullable server.configFile;
        proxyConfig = readNullable server.proxyConfigFile;
        caddyWrapper = readNullable caddyWrapperExecutable;
        bootstrap = readNullable cache.bootstrap.command;
        readiness = readNullable cache.readiness.command;
        nixConfig = builtins.readFile config.environment.etc."nix/nix.conf".source;
        postBuildHook = readNullable
          (if cache.publisher.postBuildHookPackage == null then null else
            "${'${cache.publisher.postBuildHookPackage}'}/bin/local-binary-cache-post-build-hook");
        publisher = if publisherService ? ProgramArguments
          then builtins.readFile (builtins.head publisherService.ProgramArguments)
          else "";
        atticPlist = if hasAtticDaemon then builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-attic.plist"
          else "";
        caddyPlist = if hasCaddyDaemon then builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist"
          else "";
        publisherPlist = if hasPublisherDaemon then builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-publisher.plist"
          else "";
      };
    }`,
  );

  assert.deepEqual(rendered.cacheState, {
    bootstrapClientPackage: rendered.cacheState.expectedBootstrapClientPackage,
    bootstrapClientPatches: [rendered.cacheState.bootstrapClientPatches[0]],
    bootstrapMode: false,
    cachePublicKey: personalCachePublicKey,
    consumer: true,
    enable: true,
    expectedBootstrapClientPackage: rendered.cacheState.expectedBootstrapClientPackage,
    expectedPublisherClientPackage: rendered.cacheState.expectedPublisherClientPackage,
    hostRole: 'personal',
    publisher: true,
    publisherClientPackage: rendered.cacheState.expectedPublisherClientPackage,
    publisherClientPatches: [rendered.cacheState.publisherClientPatches[0]],
    serverPatches: [],
    server: true,
  });
  assert.equal(rendered.cacheState.bootstrapClientPatches.length, 1);
  assert.equal(rendered.cacheState.publisherClientPatches.length, 1);
  assert.deepEqual(rendered.listenerContracts, {
    attic: '127.0.0.1:18080',
    mcpProxy: '127.0.0.1:8080',
    mcpProxyPort: 8080,
  });
  assert.notEqual(
    Number(rendered.listenerContracts.attic.split(':').at(-1)),
    rendered.listenerContracts.mcpProxyPort,
  );
  assert.equal(
    path.basename(rendered.cacheState.bootstrapClientPatches[0]),
    'attic-client-ca-cert.patch',
  );
  assert.equal(
    path.basename(rendered.cacheState.publisherClientPatches[0]),
    'attic-client-ca-cert.patch',
  );
  assert.equal(
    rendered.artifacts.bootstrap.includes(
      `${rendered.cacheState.expectedBootstrapClientPackage}/bin/attic`,
    ),
    true,
  );
  assert.deepEqual(rendered.publicPaths, {
    ca: rendered.expectedPaths.ca,
    jwtVerifier: rendered.expectedPaths.jwtVerifier,
    tlsCertificate: rendered.expectedPaths.tlsCertificate,
  });
  assert.deepEqual(rendered.runtimePaths, {
    cachePublicKeyOutput: '/var/db/local-binary-cache/bootstrap/cache-public-key.txt',
    jwtPrivateKey: '/run/secrets/local-binary-cache-jwt-private-key',
    personalTokenOutput: '/var/db/local-binary-cache/bootstrap/personal-token',
    publisherState: '/var/db/local-binary-cache/publisher',
    publisherToken: '/run/secrets/local-binary-cache-personal-token',
    serverState: '/var/db/local-binary-cache/attic',
    shopifyTokenOutput: '/var/db/local-binary-cache/bootstrap/shopify-token',
    tlsKey: '/run/secrets/local-binary-cache-tls-key',
  });
  assert.deepEqual(rendered.secrets, {
    jwt: {
      key: 'local-binary-cache-jwt-private-key',
      mode: '0400',
      owner: 'root',
      path: rendered.runtimePaths.jwtPrivateKey,
      present: true,
      sopsFile: rendered.expectedPaths.sopsFile,
    },
    publisher: {
      key: 'local-binary-cache-personal-token',
      mode: '0400',
      owner: 'root',
      path: rendered.runtimePaths.publisherToken,
      present: true,
      sopsFile: rendered.expectedPaths.sopsFile,
    },
    tls: {
      key: 'local-binary-cache-tls-key',
      mode: '0400',
      owner: 'brandonmcnama',
      path: rendered.runtimePaths.tlsKey,
      present: true,
      sopsFile: rendered.expectedPaths.sopsFile,
    },
  });

  assert.deepEqual(rendered.services.localDaemons, [
    'local-binary-cache-attic',
    'local-binary-cache-caddy',
    'local-binary-cache-publisher',
  ]);
  assert.equal(rendered.services.hasAtticDaemon, true);
  assert.equal(rendered.services.hasCaddyDaemon, true);
  assert.equal(rendered.services.hasPublisherDaemon, true);
  assert.equal(rendered.services.atticUser, 'brandonmcnama');
  assert.equal(rendered.services.caddyUser, 'brandonmcnama');
  assert.deepEqual(rendered.services.atticArguments, [
    rendered.services.atticArguments[0],
    '-f',
    rendered.services.atticConfigFile,
    '--mode',
    'monolithic',
  ]);
  assert.match(rendered.services.atticArguments[0], /\/bin\/atticd$/);
  assert.deepEqual(rendered.services.caddyArguments, [rendered.services.caddyWrapperExecutable]);
  assert.deepEqual(rendered.services.publisherArguments, [rendered.services.publisherArguments[0]]);
  assert.match(rendered.services.publisherArguments[0], /\/bin\/local-binary-cache-publish$/);
  assert.equal(rendered.services.publisherUser, 'root');
  assert.equal(rendered.services.publisherRunAtLoad, true);
  assert.equal(rendered.services.publisherStartInterval, 60);
  assert.equal(rendered.services.publisherWorkingDirectory, rendered.runtimePaths.publisherState);
  assert.equal(
    rendered.services.publisherStandardOutPath,
    '/var/log/local-binary-cache/publisher/stdout.log',
  );
  assert.equal(
    rendered.services.publisherStandardErrorPath,
    '/var/log/local-binary-cache/publisher/stderr.log',
  );

  const jwtVerifierBase64 = fs.readFileSync(
    path.join(repoRoot, 'certificates/local-binary-cache/jwt-public.pem'),
  ).toString('base64');
  const tlsDirective = rendered.artifacts.proxyConfig.match(
    /^\ttls ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/m,
  );
  assert.notEqual(tlsDirective, null);
  const proxyTlsCertificate = JSON.parse(tlsDirective[1]);
  const proxyTlsKey = JSON.parse(tlsDirective[2]);
  assert.ok(rendered.artifacts.atticConfig.includes(jwtVerifierBase64));
  assert.deepEqual(
    fs.readFileSync(proxyTlsCertificate),
    fs.readFileSync(rendered.publicPaths.tlsCertificate),
  );
  assert.equal(proxyTlsKey, rendered.runtimePaths.tlsKey);
  const wrapperTlsCertificate = shellAssignment(rendered.artifacts.caddyWrapper, 'tls_certificate')
    .slice('tls_certificate='.length);
  assert.deepEqual(
    fs.readFileSync(wrapperTlsCertificate),
    fs.readFileSync(rendered.publicPaths.tlsCertificate),
  );
  assert.equal(
    shellAssignment(rendered.artifacts.caddyWrapper, 'tls_key'),
    `tls_key=${rendered.runtimePaths.tlsKey}`,
  );
  assert.ok(rendered.artifacts.caddyWrapper.includes(rendered.services.proxyConfigFile));
  for (const [assignment, publicPath] of [
    ['ca_certificate', rendered.publicPaths.ca],
    ['jwt_public_key', rendered.publicPaths.jwtVerifier],
    ['tls_certificate', rendered.publicPaths.tlsCertificate],
  ]) {
    const assignmentPattern = new RegExp(`^[ \\t]*${assignment}=(.*)$`, 'm');
    const matchedAssignment = rendered.artifacts.bootstrap.match(assignmentPattern);
    assert.notEqual(matchedAssignment, null, `missing ${assignment} assignment`);
    const materializedPath = matchedAssignment[1];
    assert.deepEqual(fs.readFileSync(materializedPath), fs.readFileSync(publicPath));
  }
  for (const declaredPath of [
    rendered.runtimePaths.jwtPrivateKey,
    rendered.runtimePaths.tlsKey,
    rendered.runtimePaths.cachePublicKeyOutput,
    rendered.runtimePaths.personalTokenOutput,
    rendered.runtimePaths.shopifyTokenOutput,
  ]) {
    assert.ok(rendered.artifacts.bootstrap.includes(declaredPath));
  }

  assert.notEqual(rendered.publisherSurfaces.enqueuePackage, null);
  assert.notEqual(rendered.publisherSurfaces.postBuildHookPackage, null);
  assert.equal(rendered.publisherSurfaces.stateDirectory, rendered.runtimePaths.publisherState);
  assert.equal(rendered.publisherSurfaces.tokenFile, rendered.runtimePaths.publisherToken);
  assert.equal(rendered.consumerSurfaces.certificateFiles.includes(rendered.publicPaths.ca), true);
  assert.equal(rendered.consumerSurfaces.settings.substituters.includes(publicSubstituter), true);
  assert.equal(
    rendered.consumerSurfaces.settings['extra-substituters'].includes(communitySubstituter),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-substituters'].includes(localSubstituter),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-trusted-public-keys'].includes(communityCacheKey),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-trusted-public-keys'].includes(personalCachePublicKey),
    true,
  );
  assert.equal(rendered.consumerSurfaces.settings.fallback, true);
  assert.equal(rendered.consumerSurfaces.settings['narinfo-cache-negative-ttl'], 60);
  assert.equal(rendered.consumerSurfaces.settings['require-sigs'], true);
  assert.equal(rendered.consumerSurfaces.settings['ssl-cert-file'], combinedCaBundle);
  assert.equal(rendered.consumerSurfaces.nixSettings.includes(localSubstituter), true);
  assert.equal(rendered.consumerSurfaces.nixSettings.includes(personalCachePublicKey), true);
  const hookLines = rendered.artifacts.nixConfig.match(/^post-build-hook = .*$/gm) ?? [];
  assert.deepEqual(hookLines, [
    `post-build-hook = ${rendered.publisherSurfaces.postBuildHookPackage}/bin/local-binary-cache-post-build-hook`,
  ]);
  assert.equal(
    rendered.artifacts.postBuildHook.includes(
      `${rendered.publisherSurfaces.enqueuePackage}/bin/local-binary-cache-enqueue`,
    ),
    true,
  );
  assert.equal(rendered.artifacts.publisher.includes(rendered.runtimePaths.publisherToken), true);
  for (const ownershipContract of [
    'prepare_owned_directory "$attic_state_directory" "$attic_user" staff 0700',
    'prepare_log_file "$attic_stdout_log" "$attic_user" staff 0640',
    'prepare_log_file "$attic_stderr_log" "$attic_user" staff 0640',
    'prepare_owned_directory "$attic_log_directory" "$attic_user" staff 0750',
    'prepare_log_file "$caddy_stdout_log" "$attic_user" staff 0640',
    'prepare_log_file "$caddy_stderr_log" "$attic_user" staff 0640',
    'prepare_owned_directory "$caddy_log_directory" "$attic_user" staff 0750',
    'prepare_owned_directory "$publisher_state_directory" root wheel 0700',
    'prepare_owned_directory "$publisher_pending_directory" root wheel 0700',
    'prepare_log_file "$publisher_stdout_log" root wheel 0640',
    'prepare_log_file "$publisher_stderr_log" root wheel 0640',
    'prepare_owned_directory "$publisher_log_directory" root wheel 0750',
  ]) {
    assert.equal(rendered.artifacts.activation.includes(ownershipContract), true);
  }
  const privateKeyMarkers = [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
  ];
  for (const artifact of Object.values(rendered.artifacts)) {
    for (const marker of privateKeyMarkers) {
      assert.equal(artifact.includes(marker), false);
    }
    assert.equal(artifact.includes('ENC[AES256_GCM'), false);
  }
  for (const artifact of [
    rendered.artifacts.atticConfig,
    rendered.artifacts.readiness,
    rendered.artifacts.atticPlist,
    rendered.artifacts.caddyPlist,
  ]) {
    assert.equal(artifact.includes(rendered.runtimePaths.jwtPrivateKey), false);
    assert.equal(artifact.includes(rendered.runtimePaths.tlsKey), false);
  }
});

test('live Shopify host renders consumer and root publisher ready mode', () => {
  const rendered = evalLiveHost(
    'ShopifyLaptop',
    `let
      cache = config.services.localBinaryCache;
      hasAtticDaemon = config.launchd.daemons ? local-binary-cache-attic;
      hasCaddyDaemon = config.launchd.daemons ? local-binary-cache-caddy;
      hasPublisherDaemon = config.launchd.daemons ? local-binary-cache-publisher;
      publisherService = if hasPublisherDaemon
        then config.launchd.daemons.local-binary-cache-publisher.serviceConfig
        else { };
      renderSecret = name:
        if builtins.hasAttr name config.sops.secrets then
          let secret = builtins.getAttr name config.sops.secrets;
          in {
            present = true;
            key = secret.key;
            mode = secret.mode;
            owner = secret.owner;
            path = secret.path;
            sopsFile = toString secret.sopsFile;
          }
        else {
          present = false;
          key = null;
          mode = null;
          owner = null;
          path = null;
          sopsFile = null;
        };
      readNullable = file: if file == null then "" else builtins.readFile file;
    in {
      cacheState = {
        nixEnabled = config.nix.enable;
        enable = cache.enable;
        hostRole = cache.hostRole;
        bootstrapMode = cache.bootstrapMode;
        server = cache.server.enable;
        consumer = cache.consumer.enable;
        publisher = cache.publisher.enable;
        cachePublicKey = cache.cachePublicKey;
        priority = cache.consumer.priority;
        publisherClientPackage = if cache.publisher.package == null
          then null
          else toString cache.publisher.package;
        expectedPublisherClientPackage = toString host.pkgs.unstable.attic-client;
        publisherClientPatches = if cache.publisher.package == null
          then [ ]
          else map toString (cache.publisher.package.patches or [ ]);
        externalHookInclude = cache.publisher.externalHookInclude;
        chainedHooks = cache.publisher.chainedHooks;
      };
      publicPaths = {
        ca = if cache.caCertificate == null then null else toString cache.caCertificate;
      };
      expectedPaths = {
        ca = toString flake.outPath + "/certificates/local-binary-cache/ca.pem";
        sopsFile = toString flake.outPath + "/secrets/local-binary-cache.shopify.yaml";
      };
      runtimePaths = {
        publisherState = cache.publisher.stateDirectory;
        publisherToken = cache.publisher.tokenFile;
      };
      secret = renderSecret "local-binary-cache-shopify-token";
      publisherSurfaces = {
        enqueuePackage = if cache.publisher.enqueuePackage == null
          then null
          else toString cache.publisher.enqueuePackage;
        postBuildHookPackage = if cache.publisher.postBuildHookPackage == null
          then null
          else toString cache.publisher.postBuildHookPackage;
        externalHookPreflightPackage = if cache.publisher.externalHookPreflightPackage == null
          then null
          else toString cache.publisher.externalHookPreflightPackage;
      };
      consumerSurfaces = {
        certificateFiles = map toString config.security.pki.certificateFiles;
        settings = config.nix.settings;
      };
      services = {
        inherit hasAtticDaemon hasCaddyDaemon hasPublisherDaemon;
        publisherArguments = publisherService.ProgramArguments or null;
        publisherUser = publisherService.UserName or null;
        publisherRunAtLoad = publisherService.RunAtLoad or null;
        publisherStartInterval = publisherService.StartInterval or null;
        publisherWorkingDirectory = publisherService.WorkingDirectory or null;
        publisherStandardOutPath = publisherService.StandardOutPath or null;
        publisherStandardErrorPath = publisherService.StandardErrorPath or null;
      };
      artifacts = {
        checksActivation = config.system.activationScripts.checks.text;
        etcActivation = config.system.activationScripts.etc.text;
        launchdActivation = config.system.activationScripts.launchd.text;
        nixConfig = builtins.readFile config.environment.etc."nix/nix.conf".source;
        postBuildHook = readNullable
          (if cache.publisher.postBuildHookPackage == null then null else
            "${'${cache.publisher.postBuildHookPackage}'}/bin/local-binary-cache-post-build-hook");
        publisher = if publisherService ? ProgramArguments
          then builtins.readFile (builtins.head publisherService.ProgramArguments)
          else "";
        publisherPlist = if hasPublisherDaemon then builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-publisher.plist"
          else "";
      };
    }`,
  );

  assert.deepEqual(rendered.cacheState, {
    bootstrapMode: false,
    cachePublicKey: personalCachePublicKey,
    chainedHooks: [],
    consumer: true,
    enable: true,
    expectedPublisherClientPackage: rendered.cacheState.expectedPublisherClientPackage,
    externalHookInclude: '/etc/nix/nix.conf.d/shopify.conf',
    hostRole: 'shopify',
    nixEnabled: true,
    priority: 30,
    publisher: true,
    publisherClientPackage: rendered.cacheState.expectedPublisherClientPackage,
    publisherClientPatches: [rendered.cacheState.publisherClientPatches[0]],
    server: false,
  });
  assert.equal(rendered.cacheState.publisherClientPatches.length, 1);
  assert.equal(
    path.basename(rendered.cacheState.publisherClientPatches[0]),
    'attic-client-ca-cert.patch',
  );
  assert.deepEqual(rendered.publicPaths, { ca: rendered.expectedPaths.ca });
  assert.deepEqual(rendered.runtimePaths, {
    publisherState: '/var/db/local-binary-cache/publisher',
    publisherToken: '/run/secrets/local-binary-cache-shopify-token',
  });
  assert.deepEqual(rendered.secret, {
    key: 'local-binary-cache-shopify-token',
    mode: '0400',
    owner: 'root',
    path: rendered.runtimePaths.publisherToken,
    present: true,
    sopsFile: rendered.expectedPaths.sopsFile,
  });

  assert.equal(rendered.services.hasAtticDaemon, false);
  assert.equal(rendered.services.hasCaddyDaemon, false);
  assert.equal(rendered.services.hasPublisherDaemon, true);
  assert.deepEqual(rendered.services.publisherArguments, [rendered.services.publisherArguments[0]]);
  assert.match(rendered.services.publisherArguments[0], /\/bin\/local-binary-cache-publish$/);
  assert.equal(rendered.services.publisherUser, 'root');
  assert.equal(rendered.services.publisherRunAtLoad, true);
  assert.equal(rendered.services.publisherStartInterval, 60);
  assert.equal(rendered.services.publisherWorkingDirectory, rendered.runtimePaths.publisherState);
  assert.equal(
    rendered.services.publisherStandardOutPath,
    '/var/log/local-binary-cache/publisher/stdout.log',
  );
  assert.equal(
    rendered.services.publisherStandardErrorPath,
    '/var/log/local-binary-cache/publisher/stderr.log',
  );

  assert.notEqual(rendered.publisherSurfaces.enqueuePackage, null);
  assert.notEqual(rendered.publisherSurfaces.postBuildHookPackage, null);
  assert.notEqual(rendered.publisherSurfaces.externalHookPreflightPackage, null);
  assert.equal(rendered.consumerSurfaces.certificateFiles.includes(rendered.publicPaths.ca), true);
  assert.equal(rendered.consumerSurfaces.settings.substituters.includes(publicSubstituter), true);
  assert.equal(
    rendered.consumerSurfaces.settings['extra-substituters'].includes(communitySubstituter),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-substituters'].includes(localSubstituter),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-trusted-public-keys'].includes(communityCacheKey),
    true,
  );
  assert.equal(
    rendered.consumerSurfaces.settings['extra-trusted-public-keys'].includes(personalCachePublicKey),
    true,
  );
  assert.equal(rendered.consumerSurfaces.settings.fallback, true);
  assert.equal(rendered.consumerSurfaces.settings['narinfo-cache-negative-ttl'], 60);
  assert.equal(rendered.consumerSurfaces.settings['require-sigs'], true);
  assert.equal(rendered.consumerSurfaces.settings['ssl-cert-file'], combinedCaBundle);

  assert.equal(rendered.artifacts.etcActivation.includes('/etc/nix/nix.custom.conf'), false);
  assert.equal(rendered.artifacts.etcActivation.includes('tec_nix_'), false);

  const includeLine = '!include nix.conf.d/shopify.conf';
  const includeLines = rendered.artifacts.nixConfig.split('\n').filter(line => line === includeLine);
  const finalSubstituterLine = rendered.artifacts.nixConfig
    .split('\n')
    .findLast(line => line.startsWith('extra-substituters = '));
  const finalTrustedKeyLine = rendered.artifacts.nixConfig
    .split('\n')
    .findLast(line => line.startsWith('extra-trusted-public-keys = '));
  const hookLines = rendered.artifacts.nixConfig.match(/^post-build-hook = .*$/gm) ?? [];
  assert.deepEqual(includeLines, [includeLine]);
  assert.notEqual(finalSubstituterLine, undefined);
  assert.notEqual(finalTrustedKeyLine, undefined);
  assert.deepEqual(new Set(finalSubstituterLine.split(' = ')[1].split(/\s+/)), new Set([
    publicSubstituter,
    communitySubstituter,
    localSubstituter,
  ]));
  assert.equal(finalTrustedKeyLine.includes(communityCacheKey), true);
  assert.equal(finalTrustedKeyLine.includes(personalCachePublicKey), true);
  assert.deepEqual(hookLines, [
    `post-build-hook = ${rendered.publisherSurfaces.postBuildHookPackage}/bin/local-binary-cache-post-build-hook`,
  ]);
  assert.ok(rendered.artifacts.nixConfig.indexOf(includeLine)
    < rendered.artifacts.nixConfig.lastIndexOf(finalSubstituterLine));
  assert.ok(rendered.artifacts.nixConfig.lastIndexOf(finalSubstituterLine)
    < rendered.artifacts.nixConfig.indexOf(hookLines[0]));

  const enqueueExecutable = `${rendered.publisherSurfaces.enqueuePackage}/bin/local-binary-cache-enqueue`;
  assert.equal(rendered.artifacts.postBuildHook.split(enqueueExecutable).length - 1, 1);
  assert.equal(rendered.artifacts.publisher.includes(rendered.runtimePaths.publisherToken), true);
  const preflightExecutable = `${rendered.publisherSurfaces.externalHookPreflightPackage}/bin/local-binary-cache-external-hook-preflight`;
  assert.equal(rendered.artifacts.checksActivation.includes(preflightExecutable), true);
  for (const ownershipContract of [
    'prepare_owned_directory "$publisher_state_directory" root wheel 0700',
    'prepare_owned_directory "$publisher_pending_directory" root wheel 0700',
    'prepare_log_file "$publisher_stdout_log" root wheel 0640',
    'prepare_log_file "$publisher_stderr_log" root wheel 0640',
    'prepare_owned_directory "$publisher_log_directory" root wheel 0750',
  ]) {
    assert.equal(rendered.artifacts.launchdActivation.includes(ownershipContract), true);
  }
  for (const serverVariable of [
    'attic_user',
    'attic_state_directory',
    'attic_log_directory',
    'attic_stdout_log',
    'attic_stderr_log',
    'caddy_log_directory',
    'caddy_stdout_log',
    'caddy_stderr_log',
  ]) {
    assert.equal(rendered.artifacts.launchdActivation.includes(`${serverVariable}=`), false);
    assert.equal(rendered.artifacts.launchdActivation.includes(`$${serverVariable}`), false);
  }
  for (const artifact of Object.values(rendered.artifacts)) {
    assert.equal(artifact.includes('ENC[AES256_GCM'), false);
  }
});

test('validated pressure values apply only to the personal host', () => {
  const minFree = 10 * 1024 * 1024 * 1024;
  const maxFree = 20 * 1024 * 1024 * 1024;
  const pressureModule = `{ ... }: {
    services.localBinaryCache.gcPolicy = {
      minFree = ${minFree};
      maxFree = ${maxFree};
    };
  }`;
  const personal = evalLiveRetentionPolicy('Brandons-MacBook-Pro', pressureModule);
  const shopify = evalLiveRetentionPolicy('ShopifyLaptop', pressureModule);

  assert.deepEqual(personal.nixPressure, {
    hasMaxFree: true,
    hasMinFree: true,
    maxFree,
    minFree,
  });
  assert.deepEqual(shopify.nixPressure, {
    hasMaxFree: false,
    hasMinFree: false,
    maxFree: null,
    minFree: null,
  });
});

for (const [name, pressure, diagnostic] of [
  [
    'minimum only',
    'minFree = 10737418240;',
    /gcPolicy\.minFree and gcPolicy\.maxFree must be set together/,
  ],
  [
    'maximum only',
    'maxFree = 21474836480;',
    /gcPolicy\.minFree and gcPolicy\.maxFree must be set together/,
  ],
  [
    'zero minimum',
    'minFree = 0; maxFree = 21474836480;',
    /gcPolicy requires maxFree > minFree > 0 when configured/,
  ],
  [
    'zero maximum',
    'minFree = 10737418240; maxFree = 0;',
    /gcPolicy requires maxFree > minFree > 0 when configured/,
  ],
  [
    'reversed pair',
    'minFree = 21474836480; maxFree = 10737418240;',
    /gcPolicy requires maxFree > minFree > 0 when configured/,
  ],
]) {
  test(`live personal host rejects ${name} pressure values`, () => {
    assert.throws(
      () => evalLiveHost(
        'Brandons-MacBook-Pro',
        'builtins.deepSeq config.system.build.toplevel true',
        `{ ... }: {
          services.localBinaryCache.gcPolicy = { ${pressure} };
        }`,
      ),
      error => {
        assert.match(String(error.stderr), diagnostic);
        return true;
      },
    );
  });
}

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

test('bootstrap renders only Attic, TLS, and operator commands without evaluating live state', t => {
  const fixture = createScriptFixture({
    statePaths: {
      bootstrapKey: 'secrets/bootstrap-jwt-key',
      cacheKeyOutput: 'outputs/cache-public-key.txt',
      personalTokenOutput: 'outputs/personal-token',
      publisherState: 'state/publisher',
      publisherToken: 'secrets/publisher-token',
      shopifyTokenOutput: 'outputs/shopify-token',
      tlsKey: 'secrets/tls-key',
    },
  });
  t.after(fixture.cleanup);
  for (const secretPath of [
    fixture.statePaths.bootstrapKey,
    fixture.statePaths.publisherToken,
    fixture.statePaths.tlsKey,
  ]) {
    fs.writeFileSync(secretPath, poisonedSecrets.jwtPrivateKey, { mode: 0o400 });
  }
  const originalSecrets = new Map([
    fixture.statePaths.bootstrapKey,
    fixture.statePaths.publisherToken,
    fixture.statePaths.tlsKey,
  ].map(file => [file, fs.readFileSync(file)]));

  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = true;
        caCertificate = ${tlsCertificate};
        publisher = {
          enable = false;
          package = pkgs.attic-client;
          tokenFile = ${JSON.stringify(fixture.statePaths.publisherToken)};
          stateDirectory = ${JSON.stringify(fixture.statePaths.publisherState)};
        };
        bootstrap = {
          clientPackage = pkgs.attic-client;
          jwtPrivateKey = ${JSON.stringify(fixture.statePaths.bootstrapKey)};
          cachePublicKeyOutput = ${JSON.stringify(fixture.statePaths.cacheKeyOutput)};
          personalTokenOutput = ${JSON.stringify(fixture.statePaths.personalTokenOutput)};
          shopifyTokenOutput = ${JSON.stringify(fixture.statePaths.shopifyTokenOutput)};
        };
        server = {
          enable = true;
          package = pkgs.attic-server;
          proxyPackage = pkgs.caddy;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = ${JSON.stringify(fixture.statePaths.tlsKey)};
        };
      };
    }`,
    `let
      cache = config.services.localBinaryCache;
      localDaemons = builtins.filter
        (name: builtins.match "local-binary-cache-.*" name != null)
        (builtins.attrNames config.launchd.daemons);
    in {
      inherit localDaemons;
      bootstrapCommand = cache.bootstrap.command;
      bootstrapPackage = toString cache.bootstrap.package;
      tokenValidity = cache.publisher.tokenValidity;
      configuredCaCertificate = toString cache.caCertificate;
      certificateFiles = map toString config.security.pki.certificateFiles;
      readinessCommand = cache.readiness.command;
      readinessPackage = toString cache.readiness.package;
      diagnosticsCommand = cache.diagnostics.command;
      diagnosticsPackage = toString cache.diagnostics.package;
      enqueuePackage = if cache.publisher.enqueuePackage == null
        then null
        else toString cache.publisher.enqueuePackage;
      postBuildHookPackage = if cache.publisher.postBuildHookPackage == null
        then null
        else toString cache.publisher.postBuildHookPackage;
      externalHookPreflightPackage = if cache.publisher.externalHookPreflightPackage == null
        then null
        else toString cache.publisher.externalHookPreflightPackage;
      bootstrapText = builtins.readFile cache.bootstrap.command;
      readinessText = builtins.readFile cache.readiness.command;
      installedOperatorPackages = builtins.filter
        (package:
          package == cache.bootstrap.package
          || package == cache.readiness.package
          || package == cache.diagnostics.package)
        config.environment.systemPackages;
      activation = config.system.activationScripts.launchd.text;
      nixSettings = builtins.toJSON config.nix.settings;
      atticPlist = builtins.readFile
        "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-attic.plist";
      caddyPlist = builtins.readFile
        "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist";
    }`,
    {
      env: {
        LOCAL_BINARY_CACHE_LIVE_KEY: poisonedSecrets.jwtPrivateKey,
        LOCAL_BINARY_CACHE_NETWORK_POISON: poisonedSecrets.pushToken,
      },
    },
  );

  assert.deepEqual(rendered.localDaemons, [
    'local-binary-cache-attic',
    'local-binary-cache-caddy',
  ]);
  assert.equal(rendered.bootstrapCommand, `${rendered.bootstrapPackage}/bin/local-binary-cache-bootstrap`);
  assert.equal(rendered.tokenValidity, 31557600);
  assert.match(
    rendered.bootstrapText,
    /generate_token Brandons-MacBook-Pro '?31557600s'? --push/,
  );
  assert.match(
    rendered.bootstrapText,
    /generate_token ShopifyLaptop '?31557600s'? --push/,
  );
  assert.equal(rendered.readinessCommand, `${rendered.readinessPackage}/bin/local-binary-cache-status`);
  assert.equal(
    rendered.diagnosticsCommand,
    `${rendered.diagnosticsPackage}/bin/local-binary-cache-diagnostics`,
  );
  assert.equal(rendered.enqueuePackage, null);
  assert.equal(rendered.postBuildHookPackage, null);
  assert.equal(rendered.externalHookPreflightPackage, null);
  assert.equal(rendered.installedOperatorPackages.length, 3);
  assert.ok(rendered.bootstrapText.includes(fixture.statePaths.bootstrapKey));
  assert.ok(rendered.bootstrapText.includes(fixture.statePaths.cacheKeyOutput));
  assert.ok(rendered.readinessText.includes('status=not-ready'));
  assert.equal(rendered.certificateFiles.includes(rendered.configuredCaCertificate), false);
  assert.equal(rendered.nixSettings.includes('Brandons-MacBook-Pro.local:8443/darwin'), false);
  assert.equal(rendered.nixSettings.includes(cachePublicKey), false);
  assert.equal(rendered.nixSettings.includes('post-build-hook'), false);
  for (const artifact of [rendered.activation, rendered.atticPlist, rendered.caddyPlist]) {
    assert.equal(artifact.includes('local-binary-cache-bootstrap'), false);
    assert.equal(artifact.includes('local-binary-cache-status'), false);
    assert.equal(artifact.includes(fixture.statePaths.publisherToken), false);
    assert.equal(artifact.includes(fixture.statePaths.publisherState), false);
  }
  for (const secret of Object.values(poisonedSecrets)) {
    assert.equal(rendered.bootstrapText.includes(secret), false);
    assert.equal(rendered.readinessText.includes(secret), false);
  }
  for (const [file, contents] of originalSecrets) {
    assert.deepEqual(fs.readFileSync(file), contents);
  }
  for (const output of [
    fixture.statePaths.cacheKeyOutput,
    fixture.statePaths.personalTokenOutput,
    fixture.statePaths.shopifyTokenOutput,
  ]) {
    assert.equal(fs.existsSync(output), false);
  }
});

test('ready mode wires exact declared trust and identity into the module-generated readiness command', t => {
  const fixture = createScriptFixture({
    statePaths: {
      caCertificate: 'public/ready-wiring-ca.pem',
      jwtPrivateKey: 'secrets/ready-wiring-jwt-private-key',
      publisherState: 'state/ready-wiring-publisher',
      publisherToken: 'secrets/ready-wiring-publisher-token',
      tlsPrivateKey: 'secrets/ready-wiring-tls-private-key',
    },
  });
  t.after(fixture.cleanup);

  const configuredCachePublicKey = `darwin:${Buffer.alloc(32, 0x5a).toString('base64')}`;
  const configuredEndpoint = 'https://Brandons-MacBook-Pro.local:8443';
  const configuredCacheName = 'darwin';
  const secretValues = {
    jwtPrivateKey: 'ready-wiring-jwt-private-poison-55f94c',
    publisherToken: 'ready-wiring-publisher-token-poison-a5cf13',
    tlsPrivateKey: 'ready-wiring-tls-private-poison-f398b2',
  };
  fs.writeFileSync(
    fixture.statePaths.caCertificate,
    'ready-wiring-public-ca-marker-14bd2e\n',
  );
  for (const [name, value] of Object.entries(secretValues)) {
    fs.writeFileSync(fixture.statePaths[name], `${value}\n`, { mode: 0o400 });
    assert.equal(
      fs.readFileSync(fixture.statePaths[name], 'utf8'),
      `${value}\n`,
      `${name} poison must be present in the fixture input`,
    );
  }

  const rendered = evalDarwinFixture(
    `{ pkgs, ... }: {
      system.primaryUser = "cache-operator";
      services.localBinaryCache = {
        enable = true;
        hostRole = "personal";
        bootstrapMode = false;
        endpoint = ${JSON.stringify(configuredEndpoint)};
        cacheName = ${JSON.stringify(configuredCacheName)};
        cachePublicKey = ${JSON.stringify(configuredCachePublicKey)};
        caCertificate = ${fixture.statePaths.caCertificate};
        consumer.enable = true;
        publisher = {
          enable = true;
          package = pkgs.attic-client;
          tokenFile = ${JSON.stringify(fixture.statePaths.publisherToken)};
          stateDirectory = ${JSON.stringify(fixture.statePaths.publisherState)};
        };
        bootstrap.jwtPrivateKey = ${JSON.stringify(fixture.statePaths.jwtPrivateKey)};
        server = {
          enable = true;
          package = pkgs.attic-server;
          proxyPackage = pkgs.caddy;
          stateDirectory = "/var/db/local-binary-cache/attic";
          jwtPublicKey = ${jwtPublicKey};
          tlsCertificate = ${tlsCertificate};
          tlsKeyFile = ${JSON.stringify(fixture.statePaths.tlsPrivateKey)};
        };
      };
    }`,
    `let
      cache = config.services.localBinaryCache;
      server = cache.server;
      publisherService = config.launchd.daemons.local-binary-cache-publisher.serviceConfig;
      caddyWrapper = "${'${server.proxyWrapper}'}/bin/local-binary-cache-caddy";
      postBuildHook = "${'${cache.publisher.postBuildHookPackage}'}/bin/local-binary-cache-post-build-hook";
    in {
      configuredCaCertificate = toString cache.caCertificate;
      configuredCacheName = cache.cacheName;
      configuredCachePublicKey = cache.cachePublicKey;
      configuredEndpoint = cache.endpoint;
      readinessCommand = cache.readiness.command;
      readinessDerivationText = builtins.readFile cache.readiness.package.drvPath;
      readinessPackage = toString cache.readiness.package;
      readinessText = builtins.readFile cache.readiness.command;
      diagnosticsCommand = cache.diagnostics.command;
      diagnosticsDerivationText = builtins.readFile cache.diagnostics.package.drvPath;
      diagnosticsPackage = toString cache.diagnostics.package;
      diagnosticsText = builtins.readFile cache.diagnostics.command;
      declaredSubstituters = fixture.pkgs.lib.unique (
        (config.nix.settings.substituters or [ ])
        ++ (config.nix.settings.extra-substituters or [ ])
      );
      expectedPendingDirectory = "${'${cache.publisher.stateDirectory}'}/pending";
      expectedStoreDirectory = builtins.storeDir;
      externalHookInclude = cache.publisher.externalHookInclude;
      externalHookPreflightPackage = if cache.publisher.externalHookPreflightPackage == null
        then null
        else toString cache.publisher.externalHookPreflightPackage;
      postBuildHookPackage = if cache.publisher.postBuildHookPackage == null
        then null
        else toString cache.publisher.postBuildHookPackage;
      secretSafeArtifacts = {
        activation = config.system.activationScripts.launchd.text;
        atticConfig = builtins.readFile server.configFile;
        atticPlist = builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-attic.plist";
        caddyConfig = builtins.readFile server.proxyConfigFile;
        caddyPlist = builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist";
        caddyWrapper = builtins.readFile caddyWrapper;
        nixConfig = builtins.readFile config.environment.etc."nix/nix.conf".source;
        postBuildHook = builtins.readFile postBuildHook;
        publisher = builtins.readFile (builtins.head publisherService.ProgramArguments);
        publisherPlist = builtins.readFile
          "${'${config.system.build.launchd}'}/Library/LaunchDaemons/org.nixos.local-binary-cache-publisher.plist";
        diagnostics = builtins.readFile cache.diagnostics.command;
        diagnosticsDerivation = builtins.readFile cache.diagnostics.package.drvPath;
        readiness = builtins.readFile cache.readiness.command;
        readinessDerivation = builtins.readFile cache.readiness.package.drvPath;
      };
    }`,
  );

  assert.equal(rendered.readinessCommand, `${rendered.readinessPackage}/bin/local-binary-cache-status`);
  assert.equal(
    rendered.diagnosticsCommand,
    `${rendered.diagnosticsPackage}/bin/local-binary-cache-diagnostics`,
  );
  assert.equal(
    shellAssignment(rendered.readinessText, 'ca_certificate'),
    `ca_certificate=${rendered.configuredCaCertificate}`,
  );
  assert.equal(
    shellAssignment(rendered.readinessText, 'endpoint'),
    `endpoint=${configuredEndpoint}`,
  );
  assert.equal(
    shellAssignment(rendered.readinessText, 'configured_cache_public_key'),
    `configured_cache_public_key='${configuredCachePublicKey}'`,
  );
  assert.equal(
    shellAssignment(rendered.readinessText, 'cache_name'),
    `cache_name=${configuredCacheName}`,
  );
  assert.equal(shellAssignment(rendered.readinessText, 'bootstrap_mode'), 'bootstrap_mode=0');
  assert.equal(shellAssignment(rendered.readinessText, 'readiness_only'), 'readiness_only=1');
  assert.equal(shellAssignment(rendered.diagnosticsText, 'readiness_only'), 'readiness_only=0');
  assert.equal(
    shellAssignment(rendered.diagnosticsText, 'expected_hook'),
    `expected_hook=${rendered.postBuildHookPackage}/bin/local-binary-cache-post-build-hook`,
  );
  assert.equal(
    shellAssignment(rendered.diagnosticsText, 'expected_substituters'),
    `expected_substituters='${rendered.declaredSubstituters.join(' ')}'`,
  );
  assert.equal(
    shellAssignment(rendered.diagnosticsText, 'pending_directory'),
    `pending_directory=${rendered.expectedPendingDirectory}`,
  );
  assert.equal(
    shellAssignment(rendered.diagnosticsText, 'store_directory'),
    `store_directory=${rendered.expectedStoreDirectory}`,
  );

  assert.equal(rendered.configuredEndpoint, configuredEndpoint);
  assert.equal(rendered.configuredCachePublicKey, configuredCachePublicKey);
  assert.equal(rendered.configuredCacheName, configuredCacheName);
  assert.equal(rendered.configuredCaCertificate.endsWith('/ready-wiring-ca.pem'), true);
  assert.equal(rendered.externalHookInclude, null);
  assert.equal(rendered.externalHookPreflightPackage, null);
  assert.notEqual(rendered.postBuildHookPackage, null);
  assert.deepEqual(Object.keys(rendered.secretSafeArtifacts).sort(), [
    'activation',
    'atticConfig',
    'atticPlist',
    'caddyConfig',
    'caddyPlist',
    'caddyWrapper',
    'diagnostics',
    'diagnosticsDerivation',
    'nixConfig',
    'postBuildHook',
    'publisher',
    'publisherPlist',
    'readiness',
    'readinessDerivation',
  ]);
  const readinessArtifacts = [
    rendered.readinessText,
    rendered.readinessDerivationText,
    rendered.diagnosticsText,
    rendered.diagnosticsDerivationText,
  ];
  for (const [name, secretPath] of [
    ['publisher token', fixture.statePaths.publisherToken],
    ['TLS private key', fixture.statePaths.tlsPrivateKey],
    ['JWT private key', fixture.statePaths.jwtPrivateKey],
  ]) {
    for (const artifact of readinessArtifacts) {
      assert.equal(artifact.includes(secretPath), false, `${name} path leaked into readiness package`);
    }
  }
  for (const [name, secretValue] of Object.entries(secretValues)) {
    for (const [artifactName, artifact] of Object.entries(rendered.secretSafeArtifacts)) {
      assert.equal(
        artifact.includes(secretValue),
        false,
        `${name} value leaked into ${artifactName}`,
      );
    }
  }
});

for (const hostRole of ['personal', 'shopify']) {
  test(`${hostRole} consumer appends trusted local cache settings without replacing existing caches`, () => {
    const existingSubstituter = `https://${hostRole}-existing.example`;
    const existingExtraSubstituter = `https://${hostRole}-extra.example`;
    const existingCacheKey = `${hostRole}-existing:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=`;
    const rendered = evalDarwinFixture(
      readyConsumerModule(hostRole),
      `let
        cache = config.services.localBinaryCache;
      in {
        priority = cache.consumer.priority;
        certificateFiles = map toString config.security.pki.certificateFiles;
        nixSettings = config.nix.settings;
        nixConfText = builtins.readFile config.environment.etc."nix/nix.conf".source;
      }`,
    );

    assert.equal(rendered.priority, 30);
    assert.deepEqual(new Set(rendered.nixSettings.substituters), new Set([
      existingSubstituter,
      'https://cache.nixos.org/',
    ]));
    assert.deepEqual(new Set(rendered.nixSettings['extra-substituters']), new Set([
      existingExtraSubstituter,
      localSubstituter,
    ]));
    assert.deepEqual(new Set(rendered.nixSettings['extra-trusted-public-keys']), new Set([
      existingCacheKey,
      cachePublicKey,
    ]));
    assert.equal(rendered.nixSettings.fallback, true);
    assert.equal(rendered.nixSettings['narinfo-cache-negative-ttl'], 60);
    assert.equal(rendered.nixSettings['require-sigs'], true);
    assert.equal(rendered.nixSettings['ssl-cert-file'], combinedCaBundle);
    assert.equal(rendered.certificateFiles.includes(combinedCaBundle), false);
    assert.deepEqual(new Set(rendered.certificateFiles.map(file => path.basename(file))), new Set([
      'ca-bundle.crt',
      'tls-certificate.pem',
    ]));

    assert.match(rendered.nixConfText, /^fallback = true$/m);
    assert.match(rendered.nixConfText, /^narinfo-cache-negative-ttl = 60$/m);
    assert.match(rendered.nixConfText, /^require-sigs = true$/m);
    assert.match(
      rendered.nixConfText,
      /^ssl-cert-file = \/etc\/ssl\/certs\/ca-certificates\.crt$/m,
    );
    assert.ok(rendered.nixConfText.includes(localSubstituter));
    assert.ok(rendered.nixConfText.includes(existingExtraSubstituter));
    assert.ok(rendered.nixConfText.includes(cachePublicKey));
    assert.ok(rendered.nixConfText.includes(existingCacheKey));
    assert.equal(rendered.nixConfText.includes('local-binary-cache-token'), false);

    const managedInclude = '!include /etc/nix/nix.conf.d/shopify.conf';
    assert.equal(
      rendered.nixConfText.split('\n').filter(line => line === managedInclude).length,
      hostRole === 'shopify' ? 1 : 0,
    );
  });
}

test('Shopify consumer settings remain effective after the unchanged managed include', t => {
  const fixture = createScriptFixture({
    statePaths: {
      externalInclude: 'etc/nix/nix.conf.d/shopify.conf',
      nixConf: 'nix-conf/nix.conf',
    },
  });
  t.after(fixture.cleanup);
  const managedSubstituter = 'https://shopify-managed.example';
  const managedCacheKey = 'shopify-managed:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
  const managedConfig = [
    `substituters = ${managedSubstituter}`,
    `trusted-public-keys = ${managedCacheKey}`,
    'ssl-cert-file = /etc/ssl/certs/shopify-managed.pem',
    'fallback = false',
    'narinfo-cache-negative-ttl = 3600',
    'require-sigs = false',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.statePaths.externalInclude, managedConfig);
  const originalManagedConfig = fs.readFileSync(fixture.statePaths.externalInclude);

  const rendered = evalDarwinFixture(
    readyConsumerModule('shopify', {
      externalHookInclude: fixture.statePaths.externalInclude,
    }),
    `let
      settings = config.nix.settings;
    in {
      declarativeSubstituters =
        (settings.substituters or [ ]) ++ (settings.extra-substituters or [ ]);
      declarativeTrustedPublicKeys =
        (settings.trusted-public-keys or [ ])
        ++ (settings.extra-trusted-public-keys or [ ]);
      nixConfText = builtins.readFile config.environment.etc."nix/nix.conf".source;
      nixExecutable = "${'${config.nix.package}'}/bin/nix";
      nixVersion = config.nix.package.version;
    }`,
  );
  fs.writeFileSync(fixture.statePaths.nixConf, rendered.nixConfText);
  const show = setting => {
    const result = runScript(
      rendered.nixExecutable,
      ['--extra-experimental-features', 'nix-command', 'config', 'show', setting],
      {
        fixture,
        env: {
          NIX_CONFIG: '',
          NIX_CONF_DIR: path.dirname(fixture.statePaths.nixConf),
          XDG_CONFIG_HOME: path.join(fixture.root, 'xdg-config'),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  assert.match(rendered.nixVersion, /^2\.34\./);
  assert.deepEqual(
    new Set(show('substituters').split(/\s+/)),
    new Set([managedSubstituter, ...rendered.declarativeSubstituters]),
  );
  assert.deepEqual(
    new Set(show('trusted-public-keys').split(/\s+/)),
    new Set([managedCacheKey, ...rendered.declarativeTrustedPublicKeys]),
  );
  assert.equal(show('ssl-cert-file'), combinedCaBundle);
  assert.equal(show('fallback'), 'true');
  assert.equal(show('narinfo-cache-negative-ttl'), '60');
  assert.equal(show('require-sigs'), 'true');
  assert.deepEqual(fs.readFileSync(fixture.statePaths.externalInclude), originalManagedConfig);
});

for (const [name, cacheName] of [
  ['alternate identity', 'alternate'],
  ['nix.conf injection', 'darwin\nfallback = false'],
]) {
  test(`cache name rejects ${name} with an option diagnostic`, () => {
    assert.throws(
      () => evalDarwinFixture(
        `{ ... }: {
          services.localBinaryCache.cacheName = ${JSON.stringify(cacheName)};
        }`,
        'config.services.localBinaryCache.cacheName',
      ),
      error => {
        assert.match(error.stderr, /option `services\.localBinaryCache\.cacheName'/);
        return true;
      },
    );
  });
}

for (const hostRole of ['personal', 'shopify']) {
  test(`effective ${hostRole} trust accepts the declared signer and rejects an undeclared signer`, t => {
    const fixture = createScriptFixture({
      statePaths: {
        emptyNixConf: 'empty-nix-conf/nix.conf',
        externalInclude: 'etc/nix/nix.conf.d/shopify.conf',
        nixConf: 'effective-nix-conf/nix.conf',
        rightSecretKey: 'keys/right-secret-key',
        wrongSecretKey: 'keys/wrong-secret-key',
      },
    });
    t.after(fixture.cleanup);
    fs.writeFileSync(fixture.statePaths.emptyNixConf, 'experimental-features = nix-command\n');
    const isolatedConfigEnv = {
      NIX_CONFIG: '',
      NIX_CONF_DIR: path.dirname(fixture.statePaths.emptyNixConf),
      XDG_CONFIG_HOME: path.join(fixture.root, 'xdg-config'),
    };
    const tools = evalDarwinFixture(
      '{ ... }: { }',
      `{
        nixExecutable = "${'${config.nix.package}'}/bin/nix";
        nixVersion = config.nix.package.version;
      }`,
    );
    const generateKey = (name, secretKeyFile) => {
      const generated = runNix(
        tools.nixExecutable,
        ['key', 'generate-secret', '--key-name', name],
        fixture,
        { env: isolatedConfigEnv },
      );
      assert.equal(generated.status, 0, generated.stderr);
      fs.writeFileSync(secretKeyFile, generated.stdout, { mode: 0o600 });
      const converted = runNix(
        tools.nixExecutable,
        ['key', 'convert-secret-to-public'],
        fixture,
        { env: isolatedConfigEnv, input: generated.stdout },
      );
      assert.equal(converted.status, 0, converted.stderr);
      return converted.stdout.trim();
    };
    const rightPublicKey = generateKey('declared-cache', fixture.statePaths.rightSecretKey);
    const wrongPublicKey = generateKey('undeclared-cache', fixture.statePaths.wrongSecretKey);
    const managedCacheKey = 'shopify-managed:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
    if (hostRole === 'shopify') {
      fs.writeFileSync(fixture.statePaths.externalInclude, [
        `trusted-public-keys = ${managedCacheKey}`,
        'require-sigs = false',
        '',
      ].join('\n'));
    }

    const rendered = evalDarwinFixture(
      readyConsumerModule(hostRole, {
        cachePublicKey: rightPublicKey,
        ...(hostRole === 'shopify' ? {
          externalHookInclude: fixture.statePaths.externalInclude,
        } : {}),
      }),
      `let
        signatureFixture = fixture.pkgs.runCommand "local-binary-cache-signature-fixture" { } ''
          printf 'signature fixture\n' > "$out"
        '';
      in {
        configuredCaCertificate = toString config.services.localBinaryCache.caCertificate;
        nixConfText = builtins.readFile config.environment.etc."nix/nix.conf".source;
        sourceFixtureText = builtins.readFile signatureFixture;
        sourceStorePath = toString signatureFixture;
        nixExecutable = "${'${config.nix.package}'}/bin/nix";
        nixVersion = config.nix.package.version;
      }`,
    );
    assert.match(rendered.nixVersion, /^2\.34\./);
    assert.equal(rendered.sourceFixtureText, 'signature fixture\n');
    fs.writeFileSync(fixture.statePaths.nixConf, rendered.nixConfText);
    const effectiveConfigEnv = {
      ...isolatedConfigEnv,
      NIX_CONF_DIR: path.dirname(fixture.statePaths.nixConf),
    };
    const effectiveTrustedKeys = runNix(
      rendered.nixExecutable,
      ['config', 'show', 'trusted-public-keys'],
      fixture,
      { env: effectiveConfigEnv },
    );
    assert.equal(effectiveTrustedKeys.status, 0, effectiveTrustedKeys.stderr);
    const trustedKeySet = new Set(effectiveTrustedKeys.stdout.trim().split(/\s+/));
    assert.equal(trustedKeySet.has(rightPublicKey), true);
    assert.equal(trustedKeySet.has(wrongPublicKey), false);
    const createCache = (name, secretKeyFile) => {
      const cacheDirectory = path.join(fixture.root, 'caches', name);
      fs.mkdirSync(cacheDirectory, { recursive: true });
      const copied = runNix(
        rendered.nixExecutable,
        [
          'copy', '--no-recursive',
          '--to', `file://${cacheDirectory}?secret-key=${secretKeyFile}`,
          rendered.sourceStorePath,
        ],
        fixture,
        { env: isolatedConfigEnv, timeout: 120_000 },
      );
      assert.equal(copied.status, 0, copied.stderr);
      return cacheDirectory;
    };
    const canonicalFixtureRoot = fs.realpathSync(fixture.root);
    const copyFromCache = (cacheDirectory, storeName) => runNix(
      rendered.nixExecutable,
      [
        'copy', '--no-recursive',
        '--from', `file://${cacheDirectory}`,
        '--to', path.join(canonicalFixtureRoot, 'stores', storeName),
        rendered.sourceStorePath,
      ],
      fixture,
      { env: effectiveConfigEnv, timeout: 120_000 },
    );

    const rightCache = createCache('right', fixture.statePaths.rightSecretKey);
    const accepted = copyFromCache(rightCache, 'right');
    assert.equal(accepted.status, 0, accepted.stderr);

    const wrongCache = createCache('wrong', fixture.statePaths.wrongSecretKey);
    const rejected = copyFromCache(wrongCache, 'wrong');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /lacks a signature by a trusted key/i);
    assert.equal(rendered.nixConfText.includes(wrongPublicKey), false);
  });
}

for (const hostRole of ['personal', 'shopify']) {
  test(`effective ${hostRole} TLS trust validates the SAN leaf and rejects the wrong issuer`, t => {
    const fixture = createScriptFixture({
      statePaths: {
        combinedBundle: 'certificates/combined-ca-bundle.pem',
        externalInclude: 'etc/nix/nix.conf.d/shopify.conf',
        leafExtensions: 'certificates/leaf-extensions.cnf',
        nixConf: 'effective-nix-conf/nix.conf',
        trustedCa: 'certificates/trusted-ca.pem',
        trustedCaKey: 'certificates/trusted-ca-key.pem',
        trustedLeaf: 'certificates/trusted-leaf.pem',
        trustedLeafCsr: 'certificates/trusted-leaf.csr',
        trustedLeafKey: 'certificates/trusted-leaf-key.pem',
        wrongCa: 'certificates/wrong-ca.pem',
        wrongCaKey: 'certificates/wrong-ca-key.pem',
        wrongLeaf: 'certificates/wrong-leaf.pem',
        wrongLeafCsr: 'certificates/wrong-leaf.csr',
        wrongLeafKey: 'certificates/wrong-leaf-key.pem',
      },
    });
    t.after(fixture.cleanup);
    const expectedHostname = 'Brandons-MacBook-Pro.local';
    const tools = evalDarwinFixture(
      '{ ... }: { }',
      `{
        nixExecutable = "${'${config.nix.package}'}/bin/nix";
        opensslExecutable = "${'${fixture.pkgs.openssl}'}/bin/openssl";
      }`,
    );
    const runOpenSSL = args => runScript(tools.opensslExecutable, args, { fixture });
    fs.writeFileSync(fixture.statePaths.leafExtensions, [
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = DNS:${expectedHostname}`,
      '',
    ].join('\n'));
    const generateChain = (name, caCertificate, caKey, leafCertificate, leafCsr, leafKey) => {
      const ca = runOpenSSL([
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
        '-subj', `/CN=${name} CA`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout', caKey,
        '-out', caCertificate,
      ]);
      assert.equal(ca.status, 0, ca.stderr);
      const csr = runOpenSSL([
        'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-subj', `/CN=${expectedHostname}`,
        '-keyout', leafKey,
        '-out', leafCsr,
      ]);
      assert.equal(csr.status, 0, csr.stderr);
      const leaf = runOpenSSL([
        'x509', '-req', '-days', '1', '-sha256',
        '-in', leafCsr,
        '-CA', caCertificate,
        '-CAkey', caKey,
        '-CAcreateserial',
        '-extfile', fixture.statePaths.leafExtensions,
        '-out', leafCertificate,
      ]);
      assert.equal(leaf.status, 0, leaf.stderr);
    };
    generateChain(
      'trusted',
      fixture.statePaths.trustedCa,
      fixture.statePaths.trustedCaKey,
      fixture.statePaths.trustedLeaf,
      fixture.statePaths.trustedLeafCsr,
      fixture.statePaths.trustedLeafKey,
    );
    generateChain(
      'wrong',
      fixture.statePaths.wrongCa,
      fixture.statePaths.wrongCaKey,
      fixture.statePaths.wrongLeaf,
      fixture.statePaths.wrongLeafCsr,
      fixture.statePaths.wrongLeafKey,
    );
    if (hostRole === 'shopify') {
      fs.writeFileSync(
        fixture.statePaths.externalInclude,
        'ssl-cert-file = /etc/ssl/certs/shopify-managed.pem\n',
      );
    }

    const rendered = evalDarwinFixture(
      readyConsumerModule(hostRole, {
        caCertificate: fixture.statePaths.trustedCa,
        tlsCertificate: fixture.statePaths.trustedLeaf,
        ...(hostRole === 'shopify' ? {
          externalHookInclude: fixture.statePaths.externalInclude,
        } : {}),
      }),
      `let
        cache = config.services.localBinaryCache;
        combinedBundle = config.environment.etc."ssl/certs/ca-certificates.crt".source;
      in {
        certificateFiles = map toString config.security.pki.certificateFiles;
        combinedBundleText = builtins.readFile combinedBundle;
        configuredCaCertificate = toString cache.caCertificate;
        configuredTlsCertificate =
          if cache.server.tlsCertificate == null then null else toString cache.server.tlsCertificate;
        nixConfText = builtins.readFile config.environment.etc."nix/nix.conf".source;
        nixExecutable = "${'${config.nix.package}'}/bin/nix";
      }`,
    );
    fs.writeFileSync(fixture.statePaths.combinedBundle, rendered.combinedBundleText);
    fs.writeFileSync(fixture.statePaths.nixConf, rendered.nixConfText);

    const caDetails = runOpenSSL([
      'x509', '-in', fixture.statePaths.trustedCa, '-noout', '-text',
    ]);
    assert.equal(caDetails.status, 0, caDetails.stderr);
    assert.match(caDetails.stdout, /CA:TRUE/);
    const leafDetails = runOpenSSL([
      'x509', '-in', fixture.statePaths.trustedLeaf, '-noout', '-text',
    ]);
    assert.equal(leafDetails.status, 0, leafDetails.stderr);
    assert.match(leafDetails.stdout, /CA:FALSE/);
    assert.ok(leafDetails.stdout.includes(`DNS:${expectedHostname}`));
    assert.match(leafDetails.stdout, /TLS Web Server Authentication/);

    assert.ok(rendered.certificateFiles.includes(rendered.configuredCaCertificate));
    assert.equal(
      rendered.certificateFiles.some(file => path.basename(file) === 'trusted-leaf.pem'),
      false,
    );
    if (hostRole === 'personal') {
      assert.equal(path.basename(rendered.configuredTlsCertificate), 'trusted-leaf.pem');
    } else {
      assert.equal(rendered.configuredTlsCertificate, null);
    }
    assert.equal(rendered.combinedBundleText.includes('PRIVATE KEY'), false);
    for (const privateKeyPath of [
      fixture.statePaths.trustedCaKey,
      fixture.statePaths.trustedLeafKey,
      fixture.statePaths.wrongCaKey,
      fixture.statePaths.wrongLeafKey,
    ]) {
      assert.equal(rendered.nixConfText.includes(privateKeyPath), false);
    }

    const trusted = runOpenSSL([
      'verify',
      '-CAfile', fixture.statePaths.combinedBundle,
      '-verify_hostname', expectedHostname,
      fixture.statePaths.trustedLeaf,
    ]);
    assert.equal(trusted.status, 0, trusted.stderr);
    const wrongControl = runOpenSSL([
      'verify',
      '-CAfile', fixture.statePaths.wrongCa,
      '-verify_hostname', expectedHostname,
      fixture.statePaths.wrongLeaf,
    ]);
    assert.equal(wrongControl.status, 0, wrongControl.stderr);
    const rejected = runOpenSSL([
      'verify',
      '-CAfile', fixture.statePaths.combinedBundle,
      '-verify_hostname', expectedHostname,
      fixture.statePaths.wrongLeaf,
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /unable to get local issuer certificate|unable to verify the first certificate/i,
    );

    const effectiveSslCertFile = runNix(
      tools.nixExecutable,
      ['config', 'show', 'ssl-cert-file'],
      fixture,
      {
        env: {
          NIX_CONFIG: '',
          NIX_CONF_DIR: path.dirname(fixture.statePaths.nixConf),
          XDG_CONFIG_HOME: path.join(fixture.root, 'xdg-config'),
        },
      },
    );
    assert.equal(effectiveSslCertFile.status, 0, effectiveSslCertFile.stderr);
    assert.equal(effectiveSslCertFile.stdout.trim(), combinedCaBundle);
  });
}

test('publisher renders one final post-build hook after every external include and checks it before activation', () => {
  const rendered = evalDarwinFixture(
    readyShopifyPublisherModule(),
    `let
      cache = config.services.localBinaryCache;
    in {
      nixConfText = builtins.readFile config.environment.etc."nix/nix.conf".source;
      activation = config.system.activationScripts.script.text;
      externalHookInclude = cache.publisher.externalHookInclude;
      externalHookPreflightPackage = toString cache.publisher.externalHookPreflightPackage;
      postBuildHookPackage = toString cache.publisher.postBuildHookPackage;
    }`,
    { env: { NIX_CONFIG: 'experimental-features = nix-command flakes' } },
  );

  const hookLines = rendered.nixConfText.match(/^post-build-hook = .*$/gm) ?? [];
  const effectiveLines = rendered.nixConfText.split('\n').filter(line => (
    line.trim() !== '' && !line.startsWith('#')
  ));
  const includeIndex = rendered.nixConfText.indexOf(
    '!include /etc/nix/nix.conf.d/shopify.conf',
  );
  const hookIndex = rendered.nixConfText.indexOf(hookLines[0]);
  const preflightIndex = rendered.activation.indexOf(
    `${rendered.externalHookPreflightPackage}/bin/local-binary-cache-external-hook-preflight`,
  );
  const etcIndex = rendered.activation.indexOf('setting up /etc...');
  const daemonReloadIndex = rendered.activation.indexOf('reloading nix-daemon...');

  assert.equal(rendered.externalHookInclude, '/etc/nix/nix.conf.d/shopify.conf');
  assert.equal(hookLines.length, 1);
  assert.equal(
    hookLines[0],
    `post-build-hook = ${rendered.postBuildHookPackage}/bin/local-binary-cache-post-build-hook`,
  );
  assert.ok(includeIndex >= 0 && includeIndex < hookIndex);
  assert.equal(effectiveLines.at(-1), hookLines[0]);
  assert.ok(preflightIndex >= 0 && preflightIndex < etcIndex);
  assert.ok(preflightIndex < daemonReloadIndex);
});

test('external hook preflight isolates config and accepts empty or declared hooks only', t => {
  const poison = 'poisoned-external-nix-config-secret-value';
  const inheritedPoison = 'poisoned-inherited-nix-config-marker';
  const fixture = createScriptFixture({
    executables: {
      declaredHook: 'process.exit(0);',
      undeclaredHook: 'process.exit(0);',
    },
    statePaths: {
      externalInclude: 'etc/nix/nix.conf.d/shopify.conf',
      nixConfigHomeConfig: 'poison/nix-config-home/nix.conf',
      nixUserConfig: 'poison/nix-user.conf',
      poisonPluginSentinel: 'poison/poison-plugin-marker/.fixture',
      xdgConfig: 'poison/xdg/nix/nix.conf',
    },
  });
  t.after(fixture.cleanup);
  const userConfig = path.join(fixture.home, '.config', 'nix', 'nix.conf');
  const poisonPluginDirectory = path.dirname(fixture.statePaths.poisonPluginSentinel);
  const inheritedPoisonConfig = [
    `post-build-hook = ${fixture.executables.undeclaredHook}`,
    `plugin-files = ${poisonPluginDirectory}`,
    `netrc-file = ${path.join(fixture.root, inheritedPoison)}`,
    '',
  ].join('\n');
  for (const configPath of [
    userConfig,
    fixture.statePaths.nixConfigHomeConfig,
    fixture.statePaths.nixUserConfig,
    fixture.statePaths.xdgConfig,
  ]) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, inheritedPoisonConfig);
  }
  fs.mkdirSync(poisonPluginDirectory, { recursive: true });
  const inheritedConfigEnvironment = {
    HOME: fixture.home,
    NIX_CONFIG: inheritedPoisonConfig,
    NIX_CONFIG_HOME: path.dirname(fixture.statePaths.nixConfigHomeConfig),
    NIX_USER_CONF_FILES: fixture.statePaths.nixUserConfig,
    XDG_CONFIG_HOME: path.dirname(path.dirname(fixture.statePaths.xdgConfig)),
  };

  const rendered = evalDarwinFixture(
    readyShopifyPublisherModule({
      chainedHooks: [fixture.executables.declaredHook],
      externalHookInclude: fixture.statePaths.externalInclude,
    }),
    `let
      publisher = config.services.localBinaryCache.publisher;
    in {
      preflightExecutable = "${'${publisher.externalHookPreflightPackage}'}/bin/local-binary-cache-external-hook-preflight";
      preflightText = builtins.readFile
        "${'${publisher.externalHookPreflightPackage}'}/bin/local-binary-cache-external-hook-preflight";
      nixVersion = config.nix.package.version;
    }`,
  );
  const runPreflight = (env = inheritedConfigEnvironment) => runScript(rendered.preflightExecutable, [], {
    fixture,
    env,
  });
  const runCase = (contents, env) => {
    if (contents === null) {
      fs.rmSync(fixture.statePaths.externalInclude, { force: true });
    } else {
      fs.writeFileSync(fixture.statePaths.externalInclude, contents);
    }
    const before = fs.existsSync(fixture.statePaths.externalInclude)
      ? fs.readFileSync(fixture.statePaths.externalInclude)
      : null;
    const result = runPreflight(env);
    const after = fs.existsSync(fixture.statePaths.externalInclude)
      ? fs.readFileSync(fixture.statePaths.externalInclude)
      : null;
    assert.deepEqual(after, before);
    return result;
  };
  const assertNoInheritedPoison = result => {
    const observable = `${result.stdout}\n${result.stderr}`;
    assert.equal(observable.includes(inheritedPoison), false);
    assert.equal(observable.includes(fixture.executables.undeclaredHook), false);
    assert.equal(observable.includes(poisonPluginDirectory), false);
  };

  const noHook = runCase('sandbox = false\n');
  assert.equal(noHook.status, 0, noHook.stderr);
  assertNoInheritedPoison(noHook);

  const managedConsumerSettings = runCase([
    'substituters = https://shopify-managed.example',
    'trusted-public-keys = shopify-managed:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    'ssl-cert-file = /etc/ssl/certs/shopify-managed.pem',
    'fallback = false',
    'narinfo-cache-negative-ttl = 3600',
    '',
  ].join('\n'));
  assert.equal(managedConsumerSettings.status, 0, managedConsumerSettings.stderr);
  assertNoInheritedPoison(managedConsumerSettings);

  const declared = runCase(`post-build-hook = ${fixture.executables.declaredHook}\n`);
  assert.equal(declared.status, 0, declared.stderr);
  assertNoInheritedPoison(declared);

  for (const [name, env] of [
    ['NIX_USER_CONF_FILES', { NIX_USER_CONF_FILES: fixture.statePaths.nixUserConfig }],
    ['NIX_CONFIG_HOME', { NIX_CONFIG_HOME: path.dirname(fixture.statePaths.nixConfigHomeConfig) }],
    ['XDG_CONFIG_HOME', { XDG_CONFIG_HOME: path.dirname(path.dirname(fixture.statePaths.xdgConfig)) }],
    ['HOME', { HOME: fixture.home }],
  ]) {
    const isolated = runCase('sandbox = false\n', env);
    assert.equal(isolated.status, 0, `${name}: ${isolated.stderr}`);
    assertNoInheritedPoison(isolated);
  }

  const undeclared = runCase(`post-build-hook = ${fixture.executables.undeclaredHook}\n`);
  assert.notEqual(undeclared.status, 0);
  assert.ok(undeclared.stderr.includes(fixture.statePaths.externalInclude));
  assert.ok(undeclared.stderr.includes(fixture.executables.undeclaredHook));

  const missing = runCase(null);
  assert.notEqual(missing.status, 0);
  assert.ok(missing.stderr.includes(fixture.statePaths.externalInclude));

  const malformed = runCase(`post-build-hook ${poison}\n`);
  assert.notEqual(malformed.status, 0);
  assert.ok(malformed.stderr.includes(fixture.statePaths.externalInclude));

  fs.chmodSync(fixture.executables.declaredHook, 0o600);
  const nonExecutable = runCase('sandbox = false\n');
  assert.notEqual(nonExecutable.status, 0);
  assert.ok(nonExecutable.stderr.includes(fixture.executables.declaredHook));

  for (const result of [
    noHook,
    managedConsumerSettings,
    declared,
    undeclared,
    missing,
    malformed,
    nonExecutable,
  ]) {
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(poison), false);
  }
  assert.ok(rendered.preflightText.includes(fixture.statePaths.externalInclude));
  assert.match(rendered.nixVersion, /^2\.34\./);
  for (const poisonValue of [
    inheritedPoison,
    userConfig,
    fixture.statePaths.nixConfigHomeConfig,
    fixture.statePaths.nixUserConfig,
    fixture.statePaths.xdgConfig,
    poisonPluginDirectory,
  ]) {
    assert.equal(rendered.preflightText.includes(poisonValue), false);
  }
});

test('publisher rejects duplicate chained hooks before rendering the wrapper', () => {
  const hook = '/usr/local/bin/existing-post-build-hook';

  assert.throws(
    () => evalDarwinFixture(
      readyShopifyPublisherModule({ chainedHooks: [hook, hook] }),
      'config.system.build.toplevel',
    ),
    error => {
      assert.match(error.stderr, /publisher\.chainedHooks must not contain duplicate paths/);
      return true;
    },
  );
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
  assert.ok(rendered.proxyConfigText.includes([
    `\treverse_proxy ${JSON.stringify('http://127.0.0.1:18080')} {`,
    `\t\theader_up Host ${JSON.stringify(canonicalCacheAuthority)}`,
    '\t}',
  ].join('\n')));
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
  assert.deepEqual(reverseProxy.upstreams, [{ dial: '127.0.0.1:18080' }]);
  assert.deepEqual(reverseProxy.headers, {
    request: {
      set: {
        Host: [canonicalCacheAuthority],
      },
    },
  });
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
    'allowed-hosts': ['brandons-macbook-pro.local:8443'],
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
    listen: '127.0.0.1:18080',
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
