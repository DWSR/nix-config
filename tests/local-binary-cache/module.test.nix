{ pkgs }:
let
  inherit (pkgs) lib;

  modulePath = ../../configurations/common-darwin/local-binary-cache.nix;
  jwtPublicKey = ./fixtures/jwt-public.pem;
  tlsCertificate = ./fixtures/tls-certificate.pem;
  atticServerPackage = pkgs.unstable.attic-server;
  caddyPackage = pkgs.unstable.caddy;
  runtimePackage = pkgs.hello;
  contextualStorePath = "${tlsCertificate}";
  contextlessStorePath = builtins.unsafeDiscardStringContext contextualStorePath;

  prerequisiteOptions =
    { lib, ... }:
    {
      options = {
        assertions = lib.mkOption {
          type = lib.types.listOf (
            lib.types.submodule {
              options = {
                assertion = lib.mkOption { type = lib.types.bool; };
                message = lib.mkOption { type = lib.types.str; };
              };
            }
          );
          default = [ ];
        };

        nix.distributedBuilds = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };

        system.primaryUser = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
        };

        system.activationScripts.launchd.text = lib.mkOption {
          type = lib.types.lines;
          default = "";
        };

        launchd.daemons = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = { };
        };
      };
    };

  mkConfiguration =
    moduleConfig:
    lib.evalModules {
      modules = [
        prerequisiteOptions
        modulePath
        moduleConfig
      ];
      specialArgs = { inherit pkgs; };
    };

  serverConfig = {
    enable = true;
    package = atticServerPackage;
    proxyPackage = caddyPackage;
    stateDirectory = "/var/db/local-binary-cache/attic";
    inherit jwtPublicKey tlsCertificate;
    tlsKeyFile = "/run/secrets/local-binary-cache-tls-key";
  };

  publisherConfig = {
    enable = true;
    package = runtimePackage;
    tokenFile = "/run/secrets/local-binary-cache-token";
    stateDirectory = "/var/db/local-binary-cache/publisher";
  };

  readyModule = hostRole: {
    system.primaryUser = "cache-operator";
    services.localBinaryCache = {
      enable = true;
      inherit hostRole;
      endpoint = "https://Brandons-MacBook-Pro.local:8443";
      cacheName = "darwin";
      cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";
      caCertificate = tlsCertificate;
      publisher = publisherConfig;
      consumer.enable = true;
    }
    // lib.optionalAttrs (hostRole == "personal") {
      server = serverConfig;
    };
  };

  mkReady =
    hostRole: overrides: mkConfiguration (lib.recursiveUpdate (readyModule hostRole) overrides);

  disabled = mkConfiguration { };
  bootstrap = mkConfiguration {
    system.primaryUser = "cache-operator";
    services.localBinaryCache = {
      enable = true;
      hostRole = "personal";
      bootstrapMode = true;
      endpoint = "https://Brandons-MacBook-Pro.local:8443";
      cacheName = "darwin";
      server = serverConfig;
    };
  };
  readyPersonal = mkReady "personal" { };
  readyShopify = mkReady "shopify" { };
  missingTrust = mkReady "personal" {
    services.localBinaryCache = {
      cachePublicKey = null;
      caCertificate = null;
    };
  };
  invalidRole = mkReady "personal" {
    services.localBinaryCache.hostRole = "shopify";
  };
  distributedPublisher = mkReady "shopify" {
    nix.distributedBuilds = true;
  };
  storeBackedTokenFile = mkReady "shopify" {
    services.localBinaryCache.publisher.tokenFile = contextualStorePath;
  };
  storeRootTokenFile = mkReady "shopify" {
    services.localBinaryCache.publisher.tokenFile = builtins.storeDir;
  };
  storeBackedStateDirectory = mkReady "shopify" {
    services.localBinaryCache.publisher.stateDirectory = contextlessStorePath;
  };
  malformedCachePublicKey = mkReady "shopify" {
    services.localBinaryCache.cachePublicKey = "darwin:not-base64";
  };
  malformedPaddedCachePublicKey = mkReady "shopify" {
    services.localBinaryCache.cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs==";
  };
  noncanonicalCachePublicKey = mkReady "shopify" {
    services.localBinaryCache.cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Ft=";
  };
  alternateRetentionDays = mkReady "personal" {
    services.localBinaryCache.server.retentionDays = 31;
  };
  alternateGcInterval = mkReady "personal" {
    services.localBinaryCache.server.gcInterval = "24 hours";
  };
  orderedPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy = {
      minFree = 10 * 1024 * 1024 * 1024;
      maxFree = 20 * 1024 * 1024 * 1024;
    };
  };
  minOnlyPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy.minFree = 10 * 1024 * 1024 * 1024;
  };
  maxOnlyPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy.maxFree = 20 * 1024 * 1024 * 1024;
  };
  zeroTriggerPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy = {
      minFree = 0;
      maxFree = 20 * 1024 * 1024 * 1024;
    };
  };
  zeroTargetPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy = {
      minFree = 10 * 1024 * 1024 * 1024;
      maxFree = 0;
    };
  };
  reversedPressure = mkReady "personal" {
    services.localBinaryCache.gcPolicy = {
      minFree = 20 * 1024 * 1024 * 1024;
      maxFree = 10 * 1024 * 1024 * 1024;
    };
  };
  missingRuntimePrerequisites = mkReady "personal" {
    services.localBinaryCache = {
      publisher = {
        package = null;
        tokenFile = null;
        stateDirectory = null;
      };
      server = {
        package = null;
        proxyPackage = null;
        stateDirectory = null;
        jwtPublicKey = null;
        tlsCertificate = null;
        tlsKeyFile = null;
      };
    };
  };
  missingPrimaryUser = mkReady "personal" {
    system.primaryUser = null;
  };

  requiredOptionNames = [
    "bootstrapMode"
    "cacheName"
    "cachePublicKey"
    "caCertificate"
    "consumer"
    "enable"
    "endpoint"
    "gcPolicy"
    "hostRole"
    "publisher"
    "server"
  ];
  cacheAssertionPrefix = "services.localBinaryCache.";
  cacheAssertions =
    configuration:
    builtins.filter (
      entry: lib.hasPrefix cacheAssertionPrefix entry.message
    ) configuration.config.assertions;
  failedAssertions =
    configuration: builtins.filter (entry: !entry.assertion) (cacheAssertions configuration);
  failureMessages = configuration: map (entry: entry.message) (failedAssertions configuration);
  rejected = value: !(builtins.tryEval value).success;
  runtimePathAccepted =
    path:
    (builtins.tryEval
      (mkReady "shopify" {
        services.localBinaryCache.publisher.tokenFile = path;
      }).config.services.localBinaryCache.publisher.tokenFile
    ).success;
  publisherSubOptions = disabled.options.services.localBinaryCache.publisher.type.getSubOptions [ ];
  runtimePathTypeDescription = publisherSubOptions.tokenFile.type.description;
  cachePublicKeyTypeDescription =
    disabled.options.services.localBinaryCache.cachePublicKey.type.description;
  pressurePairMessage = "services.localBinaryCache.gcPolicy.minFree and gcPolicy.maxFree must be set together.";
  pressureOrderMessage = "services.localBinaryCache.gcPolicy requires maxFree > minFree > 0 when configured.";
in
assert lib.all (
  name: builtins.hasAttr name disabled.options.services.localBinaryCache
) requiredOptionNames;
assert disabled.config.services.localBinaryCache.enable == false;
assert failedAssertions disabled == [ ];
assert disabled.config.services.localBinaryCache.server.configFile == null;
assert bootstrap.config.services.localBinaryCache.bootstrapMode;
assert bootstrap.config.services.localBinaryCache.server.enable;
assert !bootstrap.config.services.localBinaryCache.publisher.enable;
assert !bootstrap.config.services.localBinaryCache.consumer.enable;
assert failedAssertions bootstrap == [ ];
assert failedAssertions readyPersonal == [ ];
assert failedAssertions readyShopify == [ ];
assert
  failureMessages missingTrust == [
    "services.localBinaryCache.cachePublicKey is required in ready mode."
    "services.localBinaryCache.caCertificate is required when consumer.enable is true."
  ];
assert
  failureMessages invalidRole == [
    "services.localBinaryCache.server.enable may only be true when hostRole is personal."
  ];
assert
  failureMessages distributedPublisher == [
    "services.localBinaryCache.publisher.enable requires nix.distributedBuilds = false."
  ];
assert builtins.getContext contextualStorePath != { };
assert builtins.getContext contextlessStorePath == { };
assert rejected storeBackedTokenFile.config.services.localBinaryCache.publisher.tokenFile;
assert rejected storeRootTokenFile.config.services.localBinaryCache.publisher.tokenFile;
assert rejected storeBackedStateDirectory.config.services.localBinaryCache.publisher.stateDirectory;
assert lib.all runtimePathAccepted [
  "/"
  "/run/secrets/local-binary-cache-token"
  "/run/secrets/local binary cache token?version=1#current%25"
  "/var/db/local-binary-cache/publisher"
  "/nix/storehouse/local-binary-cache-token"
];
assert rejected malformedCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert rejected malformedPaddedCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert rejected noncanonicalCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert rejected alternateRetentionDays.config.services.localBinaryCache.server.retentionDays;
assert rejected alternateGcInterval.config.services.localBinaryCache.server.gcInterval;
assert lib.hasInfix "without Nix store context" runtimePathTypeDescription;
assert lib.hasInfix "32-byte base64-encoded Ed25519" cachePublicKeyTypeDescription;
assert readyPersonal.config.services.localBinaryCache.server.retentionDays == 30;
assert readyPersonal.config.services.localBinaryCache.server.gcInterval == "12 hours";
assert caddyPackage.version == "2.11.4";
assert readyPersonal.config.services.localBinaryCache.server.proxyConfigFile != null;
assert readyPersonal.config.services.localBinaryCache.server.proxyWrapper != null;
assert
  readyPersonal.config.services.localBinaryCache.gcPolicy == {
    minFree = null;
    maxFree = null;
  };
assert
  orderedPressure.config.services.localBinaryCache.gcPolicy == {
    minFree = 10 * 1024 * 1024 * 1024;
    maxFree = 20 * 1024 * 1024 * 1024;
  };
assert failedAssertions orderedPressure == [ ];
assert failureMessages minOnlyPressure == [ pressurePairMessage ];
assert failureMessages maxOnlyPressure == [ pressurePairMessage ];
assert failureMessages zeroTriggerPressure == [ pressureOrderMessage ];
assert failureMessages zeroTargetPressure == [ pressureOrderMessage ];
assert failureMessages reversedPressure == [ pressureOrderMessage ];
assert
  failureMessages missingRuntimePrerequisites == [
    "services.localBinaryCache.publisher.package is required when publisher.enable is true."
    "services.localBinaryCache.publisher.tokenFile is required when publisher.enable is true."
    "services.localBinaryCache.publisher.stateDirectory is required when publisher.enable is true."
    "services.localBinaryCache.server.package is required when server.enable is true."
    "services.localBinaryCache.server.proxyPackage is required when server.enable is true."
    "services.localBinaryCache.server.stateDirectory is required when server.enable is true."
    "services.localBinaryCache.server.jwtPublicKey is required when server.enable is true."
    "services.localBinaryCache.server.tlsCertificate is required when server.enable is true."
    "services.localBinaryCache.server.tlsKeyFile is required when server.enable is true."
  ];
assert
  failureMessages missingPrimaryUser == [
    "services.localBinaryCache.server.enable requires system.primaryUser."
  ];
pkgs.runCommand "local-binary-cache-module-test"
  {
    nativeBuildInputs = [ pkgs.openssl ];
  }
  ''
    export HOME="$TMPDIR/home"
    export XDG_CONFIG_HOME="$TMPDIR/config"
    export XDG_DATA_HOME="$TMPDIR/data"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

    openssl pkey -pubin -in ${jwtPublicKey} -noout
    openssl x509 -in ${tlsCertificate} -noout
    ${atticServerPackage}/bin/atticd \
      --config ${readyPersonal.config.services.localBinaryCache.server.configFile} \
      --mode check-config

    ${caddyPackage}/bin/caddy adapt \
      --config ${readyPersonal.config.services.localBinaryCache.server.proxyConfigFile} \
      --adapter caddyfile \
      --pretty > "$TMPDIR/caddy-adapted.json"

    openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
      -subj /CN=Brandons-MacBook-Pro.local \
      -keyout "$TMPDIR/tls-key.pem" \
      -out "$TMPDIR/tls-certificate.pem"
    found_tls_directive=false
    while IFS= read -r line; do
      if [[ "$line" == *"tls "* ]]; then
        printf '\ttls "%s" "%s"\n' "$TMPDIR/tls-certificate.pem" "$TMPDIR/tls-key.pem"
        found_tls_directive=true
      else
        printf '%s\n' "$line"
      fi
    done < ${readyPersonal.config.services.localBinaryCache.server.proxyConfigFile} \
      > "$TMPDIR/Caddyfile"
    test "$found_tls_directive" = true
    ${caddyPackage}/bin/caddy adapt \
      --config "$TMPDIR/Caddyfile" \
      --adapter caddyfile \
      --validate > "$TMPDIR/caddy-validated.json"

    touch "$out"
  ''
