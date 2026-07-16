{ pkgs }:
let
  inherit (pkgs) lib;

  modulePath = ../../configurations/common-darwin/local-binary-cache.nix;
  jwtPublicKey = ./fixtures/jwt-public.pem;
  tlsCertificate = ./fixtures/tls-certificate.pem;
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
    package = runtimePackage;
    proxyPackage = runtimePackage;
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

  requiredOptionNames = [
    "bootstrapMode"
    "cacheName"
    "cachePublicKey"
    "caCertificate"
    "consumer"
    "enable"
    "endpoint"
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
in
assert lib.all (
  name: builtins.hasAttr name disabled.options.services.localBinaryCache
) requiredOptionNames;
assert disabled.config.services.localBinaryCache.enable == false;
assert failedAssertions disabled == [ ];
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
  "/var/db/local-binary-cache/publisher"
  "/nix/storehouse/local-binary-cache-token"
];
assert rejected malformedCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert rejected malformedPaddedCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert rejected noncanonicalCachePublicKey.config.services.localBinaryCache.cachePublicKey;
assert lib.hasInfix "without Nix store context" runtimePathTypeDescription;
assert lib.hasInfix "32-byte base64-encoded Ed25519" cachePublicKeyTypeDescription;
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
pkgs.runCommand "local-binary-cache-module-test"
  {
    nativeBuildInputs = [ pkgs.openssl ];
  }
  ''
    openssl pkey -pubin -in ${jwtPublicKey} -noout
    openssl x509 -in ${tlsCertificate} -noout
    touch "$out"
  ''
