{ lib, pkgs }:
let
  modulePath = ../../configurations/common-darwin/shopify-remote-builder.nix;
  cacheNixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  cacheNixCommunityKey = "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";
  defaultSourceCidrs = [
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
  ];
  defaultPublicCaches = [
    {
      endpoint = "https://cache.nixos.org";
      trustedKeys = [ cacheNixosKey ];
    }
    {
      endpoint = "https://nix-community.cachix.org";
      trustedKeys = [ cacheNixCommunityKey ];
    }
  ];

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

        nix.package = lib.mkOption {
          type = lib.types.package;
          default = pkgs.nix;
        };

        nix.distributedBuilds = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };

        nix.buildMachines = lib.mkOption {
          type = lib.types.listOf lib.types.anything;
          default = [ ];
        };

        nix.settings.builders = lib.mkOption {
          type = lib.types.anything;
          default = [ ];
        };

        services.localBinaryCache = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
          };

          hostRole = lib.mkOption {
            type = lib.types.nullOr (
              lib.types.enum [
                "personal"
                "shopify"
              ]
            );
            default = null;
          };

          publisher = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
            };

            package = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
            };
          };
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

  disabledPersonal = mkConfiguration {
    services.shopifyRemoteBuilder = {
      enable = false;
      role = "personal";
    };
  };
  disabledShopify = mkConfiguration {
    services.shopifyRemoteBuilder = {
      enable = false;
      role = "shopify";
    };
  };
  defaults = disabledPersonal.config.services.shopifyRemoteBuilder;
  customized = mkConfiguration {
    services.shopifyRemoteBuilder = {
      enable = false;
      role = "shopify";
      endpoint = "builder.example.local";
      system = "aarch64-darwin";
      allowedRepositories = [
        {
          provider = "github";
          owner = "example";
          repository = "public-project";
        }
      ];
      ssh = {
        user = "remote-builder";
        uid = 503;
        port = 2222;
        clientPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g fixture-client";
        privateKeyFile = "/run/secrets/shopify-remote-builder-client-key";
        publicHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9A fixture-host";
        sourceCidrs = [ "192.0.2.0/24" ];
      };
      validation = {
        timeoutSeconds = 60;
        maxDerivations = 12;
        maxInputSources = 13;
        maxFixedOutputs = 14;
        maxWorkspaceBytes = 15;
        publicInterface = "en7";
        maxRedirects = 2;
        stateDirectory = "/tmp/shopify-remote-builder-requests";
        leaseIdleTtlSeconds = 16;
        heartbeatSeconds = 17;
        publicCaches = [
          {
            endpoint = "https://cache.example.test";
            trustedKeys = [ "cache.example.test-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
          }
        ];
      };
    };
  };
  nix234 = pkgs.nix;
  nix235 =
    pkgs.nix.overrideAttrs (_: {
      version = "2.35.0";
      name = "nix-2.35.0";
    })
    // {
      version = "2.35.0";
    };
  lix295 = pkgs.lixPackageSets.latest.lix;
  lix291 = pkgs.lixPackageSets.stable.lix;
  spoofedNixIdentity = pkgs.hello.overrideAttrs (_: {
    inherit (nix234) pname version name;
    __intentionallyOverridingVersion = true;
  });
  spoofedLixIdentity = pkgs.hello.overrideAttrs (_: {
    inherit (lix295) pname version name;
    __intentionallyOverridingVersion = true;
  });
  copiedNixIdentity = pkgs.hello // {
    inherit (nix234)
      drvPath
      outPath
      pname
      version
      name
      ;
    __intentionallyCopyingIdentity = true;
  };
  copiedLixIdentity = pkgs.hello // {
    inherit (lix295)
      drvPath
      outPath
      pname
      version
      name
      ;
    __intentionallyCopyingIdentity = true;
  };
  canonicalVersionForgedNix = pkgs.stdenv.mkDerivation {
    inherit (nix234) pname version;
    dontUnpack = true;
    installPhase = "mkdir -p $out";
  };
  canonicalVersionForgedLix = pkgs.stdenv.mkDerivation {
    inherit (lix295) pname version;
    dontUnpack = true;
    installPhase = "mkdir -p $out";
  };
  fixturePackage = pkgs.writeText "shopify-remote-builder-fixture-package" "fixture package\n";
  fixtureClientKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g fixture-client";
  fixtureHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9A fixture-host";
  fixturePrivateKeyPath = "/run/secrets/shopify-remote-builder-client-key";
  fixturePackages = {
    diagnostics = fixturePackage;
    dispatcher = fixturePackage;
    guardedBuild = fixturePackage;
    lease = fixturePackage;
    policyProxy = fixturePackage;
    validator = fixturePackage;
  };
  personalLixOverride = lix295.overrideAttrs (old: {
    preCheck = (old.preCheck or "") + ''
      export GTEST_FILTER='-FileTransfer.*'
    '';
    doInstallCheck = false;
  });
  cacheModule = role: {
    services.localBinaryCache = {
      enable = true;
      hostRole = role;
      publisher = {
        enable = true;
        package = fixturePackage;
      };
    };
  };
  roleModule =
    role: nixPackage: extra:
    lib.recursiveUpdate (lib.recursiveUpdate (cacheModule role) {
      nix.package = nixPackage;
      services.shopifyRemoteBuilder = {
        enable = true;
        inherit role;
        ssh =
          if role == "personal" then
            {
              clientPublicKey = fixtureClientKey;
            }
          else
            {
              privateKeyFile = fixturePrivateKeyPath;
              publicHostKey = fixtureHostKey;
            };
        packages = fixturePackages;
      };
    }) extra;
  validPersonal = mkConfiguration (roleModule "personal" lix295 { });
  validPersonalOverride = mkConfiguration (roleModule "personal" personalLixOverride { });
  validShopify = mkConfiguration (roleModule "shopify" nix234 { });
  validNarrowPersonal = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.sourceCidrs = [ "192.168.42.0/24" ];
    }
  );
  unsupportedPersonal = mkConfiguration (roleModule "personal" lix291 { });
  unsupportedShopify = mkConfiguration (roleModule "shopify" nix235 { });
  spoofedPersonalIdentity = mkConfiguration (roleModule "personal" spoofedLixIdentity { });
  spoofedShopifyIdentity = mkConfiguration (roleModule "shopify" spoofedNixIdentity { });
  copiedPersonalIdentity = mkConfiguration (roleModule "personal" copiedLixIdentity { });
  copiedShopifyIdentity = mkConfiguration (roleModule "shopify" copiedNixIdentity { });
  canonicalVersionForgedPersonal = mkConfiguration (
    roleModule "personal" canonicalVersionForgedLix { }
  );
  canonicalVersionForgedShopify = mkConfiguration (
    roleModule "shopify" canonicalVersionForgedNix { }
  );
  missingPersonalClientKey = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.clientPublicKey = null;
    }
  );
  prohibitedPersonalPrivateKey = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.privateKeyFile = fixturePrivateKeyPath;
    }
  );
  missingShopifyPrivateKey = mkConfiguration (
    roleModule "shopify" nix234 {
      services.shopifyRemoteBuilder.ssh.privateKeyFile = null;
    }
  );
  missingShopifyHostKey = mkConfiguration (
    roleModule "shopify" nix234 {
      services.shopifyRemoteBuilder.ssh.publicHostKey = null;
    }
  );
  missingPersonalPublisher = mkConfiguration (
    lib.recursiveUpdate (roleModule "personal" lix295 { }) {
      services.localBinaryCache.publisher.enable = false;
    }
  );
  missingShopifyPublisher = mkConfiguration (
    lib.recursiveUpdate (roleModule "shopify" nix234 { }) {
      services.localBinaryCache.publisher.package = null;
    }
  );
  globalPersonalBuilder = mkConfiguration (
    lib.recursiveUpdate (roleModule "shopify" nix234 { }) {
      nix.buildMachines = [ { hostName = "Brandons-MacBook-Pro.local"; } ];
    }
  );
  globalPersonalBuilderSetting = mkConfiguration (
    lib.recursiveUpdate (roleModule "shopify" nix234 { }) {
      nix.settings.builders = [ "ssh-ng://Brandons-MacBook-Pro.local" ];
    }
  );
  distributedBuilds = mkConfiguration (
    lib.recursiveUpdate (roleModule "shopify" nix234 { }) {
      nix.distributedBuilds = true;
    }
  );
  tailscaleSourceCidr = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.sourceCidrs = [ "100.100.0.0/16" ];
    }
  );
  defaultSourceCidr = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.sourceCidrs = [ "0.0.0.0/0" ];
    }
  );
  publicSourceCidr = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.sourceCidrs = [ "8.8.8.0/24" ];
    }
  );
  unsafeUid = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.uid = 0;
    }
  );
  unsafePrivateKeyPath = mkConfiguration (
    roleModule "shopify" nix234 {
      services.shopifyRemoteBuilder.ssh.privateKeyFile = "${builtins.storeDir}/fixture-key";
    }
  );
  unsafeStatePath = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.validation.stateDirectory = "/tmp/../unsafe";
    }
  );
  unsafePublicKey = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.ssh.clientPublicKey = "ssh-ed25519 fixture-key\npost-build-hook = /tmp/injected";
    }
  );
  unsafeCacheEndpoint = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.validation.publicCaches = [
        {
          endpoint = "https://Brandons-MacBook-Pro.local:8443";
          trustedKeys = [ cacheNixosKey ];
        }
      ];
    }
  );
  unsafeCacheKey = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.validation.publicCaches = [
        {
          endpoint = "https://cache.nixos.org";
          trustedKeys = [ "cache.nixos.org-1:not-a-cache-key" ];
        }
      ];
    }
  );
  unapprovedCache = mkConfiguration (
    roleModule "personal" lix295 {
      services.shopifyRemoteBuilder.validation.publicCaches = [
        {
          endpoint = "https://cache.example.test";
          trustedKeys = [ "cache.example.test-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
        }
      ];
    }
  );
  defaultOptionNames = [
    "allowedRepositories"
    "enable"
    "endpoint"
    "packages"
    "role"
    "ssh"
    "system"
    "validation"
  ];
  sshOptionNames = [
    "clientPublicKey"
    "port"
    "privateKeyFile"
    "publicHostKey"
    "sourceCidrs"
    "uid"
    "user"
  ];
  validationOptionNames = [
    "heartbeatSeconds"
    "leaseIdleTtlSeconds"
    "maxDerivations"
    "maxFixedOutputs"
    "maxInputSources"
    "maxRedirects"
    "maxWorkspaceBytes"
    "publicCaches"
    "publicInterface"
    "stateDirectory"
    "timeoutSeconds"
  ];
  repositoryOptionNames = [
    "owner"
    "provider"
    "repository"
  ];
  publicCacheOptionNames = [
    "endpoint"
    "trustedKeys"
  ];
  packageOptionNames = [
    "diagnostics"
    "dispatcher"
    "guardedBuild"
    "lease"
    "policyProxy"
    "validator"
  ];
  failedAssertions =
    configuration: builtins.filter (entry: !entry.assertion) configuration.config.assertions;
  failureMessages = configuration: map (entry: entry.message) (failedAssertions configuration);
  rejected = value: !(builtins.tryEval value).success;
  renderedRole =
    configuration:
    builtins.unsafeDiscardStringContext (
      builtins.toJSON {
        role = configuration.config.services.shopifyRemoteBuilder.role;
        endpoint = configuration.config.services.shopifyRemoteBuilder.endpoint;
        ssh = {
          clientPublicKey = configuration.config.services.shopifyRemoteBuilder.ssh.clientPublicKey;
          privateKeyFile = configuration.config.services.shopifyRemoteBuilder.ssh.privateKeyFile;
          publicHostKey = configuration.config.services.shopifyRemoteBuilder.ssh.publicHostKey;
        };
        packages = builtins.mapAttrs (
          _: package: if package == null then null else toString package
        ) configuration.config.services.shopifyRemoteBuilder.packages;
      }
    );
in
assert builtins.attrNames defaults == defaultOptionNames;
assert builtins.attrNames defaults.ssh == sshOptionNames;
assert builtins.attrNames defaults.validation == validationOptionNames;
assert builtins.attrNames (builtins.head defaults.allowedRepositories) == repositoryOptionNames;
assert
  builtins.attrNames (builtins.head defaults.validation.publicCaches) == publicCacheOptionNames;
assert
  defaults == {
    enable = false;
    role = "personal";
    endpoint = "Brandons-MacBook-Pro.local";
    system = "aarch64-darwin";
    allowedRepositories = [
      {
        provider = "github";
        owner = "NixOS";
        repository = "nixpkgs";
      }
    ];
    ssh = {
      user = "_nixremote";
      uid = 502;
      port = 22;
      clientPublicKey = null;
      privateKeyFile = null;
      publicHostKey = null;
      sourceCidrs = defaultSourceCidrs;
    };
    packages = {
      diagnostics = null;
      dispatcher = null;
      guardedBuild = null;
      lease = null;
      policyProxy = null;
      validator = null;
    };
    validation = {
      timeoutSeconds = 30 * 60;
      maxDerivations = 10000;
      maxInputSources = 1000;
      maxFixedOutputs = 256;
      maxWorkspaceBytes = 20 * 1024 * 1024 * 1024;
      publicInterface = "en0";
      maxRedirects = 5;
      stateDirectory = "/var/db/shopify-remote-builder/requests";
      leaseIdleTtlSeconds = 60 * 60;
      heartbeatSeconds = 30;
      publicCaches = defaultPublicCaches;
    };
  };
assert disabledShopify.config.services.shopifyRemoteBuilder.enable == false;
assert disabledShopify.config.services.shopifyRemoteBuilder.role == "shopify";
assert
  customized.config.services.shopifyRemoteBuilder == {
    enable = false;
    role = "shopify";
    endpoint = "builder.example.local";
    system = "aarch64-darwin";
    allowedRepositories = [
      {
        provider = "github";
        owner = "example";
        repository = "public-project";
      }
    ];
    ssh = {
      user = "remote-builder";
      uid = 503;
      port = 2222;
      clientPublicKey = fixtureClientKey;
      privateKeyFile = "/run/secrets/shopify-remote-builder-client-key";
      publicHostKey = fixtureHostKey;
      sourceCidrs = [ "192.0.2.0/24" ];
    };
    packages = {
      diagnostics = null;
      dispatcher = null;
      guardedBuild = null;
      lease = null;
      policyProxy = null;
      validator = null;
    };
    validation = {
      timeoutSeconds = 60;
      maxDerivations = 12;
      maxInputSources = 13;
      maxFixedOutputs = 14;
      maxWorkspaceBytes = 15;
      publicInterface = "en7";
      maxRedirects = 2;
      stateDirectory = "/tmp/shopify-remote-builder-requests";
      leaseIdleTtlSeconds = 16;
      heartbeatSeconds = 17;
      publicCaches = [
        {
          endpoint = "https://cache.example.test";
          trustedKeys = [ "cache.example.test-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
        }
      ];
    };
  };
assert builtins.attrNames defaults.packages == packageOptionNames;
assert
  lib.filter (name: name != "_module") (
    builtins.attrNames (
      disabledPersonal.options.services.shopifyRemoteBuilder.packages.type.getSubOptions [ ]
    )
  ) == packageOptionNames;
assert failedAssertions disabledPersonal == [ ];
assert failedAssertions disabledShopify == [ ];
assert failedAssertions validPersonal == [ ];
assert failedAssertions validPersonalOverride == [ ];
assert failedAssertions validShopify == [ ];
assert failedAssertions validNarrowPersonal == [ ];
assert canonicalVersionForgedNix.version == nix234.version;
assert canonicalVersionForgedNix.drvAttrs.version == nix234.drvAttrs.version;
assert canonicalVersionForgedLix.version == lix295.version;
assert canonicalVersionForgedLix.drvAttrs.version == lix295.drvAttrs.version;
assert spoofedNixIdentity.pname == nix234.pname;
assert spoofedNixIdentity.version == nix234.version;
assert
  builtins.unsafeDiscardStringContext (toString spoofedNixIdentity)
  != builtins.unsafeDiscardStringContext (toString nix234);
assert spoofedLixIdentity.pname == lix295.pname;
assert spoofedLixIdentity.version == lix295.version;
assert
  builtins.unsafeDiscardStringContext (toString spoofedLixIdentity)
  != builtins.unsafeDiscardStringContext (toString lix295);
assert validPersonal.config.services.shopifyRemoteBuilder.packages == fixturePackages;
assert validShopify.config.services.shopifyRemoteBuilder.packages == fixturePackages;
assert
  failureMessages unsupportedPersonal == [
    "services.shopifyRemoteBuilder.personal role requires Lix 2.95.2 or newer."
  ];
assert
  failureMessages unsupportedShopify == [
    "services.shopifyRemoteBuilder.shopify role requires Nix/Tecnix 2.34."
  ];
assert
  failureMessages spoofedPersonalIdentity == [
    "services.shopifyRemoteBuilder.personal role requires Lix 2.95.2 or newer."
  ];
assert
  failureMessages spoofedShopifyIdentity == [
    "services.shopifyRemoteBuilder.shopify role requires Nix/Tecnix 2.34."
  ];
assert
  failureMessages copiedPersonalIdentity == [
    "services.shopifyRemoteBuilder.personal role requires Lix 2.95.2 or newer."
  ];
assert
  failureMessages copiedShopifyIdentity == [
    "services.shopifyRemoteBuilder.shopify role requires Nix/Tecnix 2.34."
  ];
assert
  failureMessages canonicalVersionForgedPersonal == [
    "services.shopifyRemoteBuilder.personal role requires Lix 2.95.2 or newer."
  ];
assert
  failureMessages canonicalVersionForgedShopify == [
    "services.shopifyRemoteBuilder.shopify role requires Nix/Tecnix 2.34."
  ];
assert
  failureMessages missingPersonalClientKey == [
    "services.shopifyRemoteBuilder.personal role requires a client public key and no private key."
  ];
assert
  failureMessages prohibitedPersonalPrivateKey == [
    "services.shopifyRemoteBuilder.personal role requires a client public key and no private key."
  ];
assert
  failureMessages missingShopifyPrivateKey == [
    "services.shopifyRemoteBuilder.shopify role requires a private key path and pinned public host key."
  ];
assert
  failureMessages missingShopifyHostKey == [
    "services.shopifyRemoteBuilder.shopify role requires a private key path and pinned public host key."
  ];
assert
  failureMessages missingPersonalPublisher == [
    "services.shopifyRemoteBuilder requires a matching enabled local-binary-cache publisher."
  ];
assert
  failureMessages missingShopifyPublisher == [
    "services.shopifyRemoteBuilder requires a matching enabled local-binary-cache publisher."
  ];
assert
  failureMessages globalPersonalBuilder == [
    "services.shopifyRemoteBuilder must not configure a global personal builder."
  ];
assert
  failureMessages globalPersonalBuilderSetting == [
    "services.shopifyRemoteBuilder must not configure a global personal builder."
  ];
assert
  failureMessages distributedBuilds == [
    "services.shopifyRemoteBuilder requires nix.distributedBuilds = false."
  ];
assert
  failureMessages tailscaleSourceCidr == [
    "services.shopifyRemoteBuilder.ssh.sourceCidrs must contain only approved RFC1918 IPv4 LAN CIDRs and exclude Tailscale CGNAT."
  ];
assert
  failureMessages defaultSourceCidr == [
    "services.shopifyRemoteBuilder.ssh.sourceCidrs must contain only approved RFC1918 IPv4 LAN CIDRs and exclude Tailscale CGNAT."
  ];
assert
  failureMessages publicSourceCidr == [
    "services.shopifyRemoteBuilder.ssh.sourceCidrs must contain only approved RFC1918 IPv4 LAN CIDRs and exclude Tailscale CGNAT."
  ];
assert
  failureMessages unapprovedCache == [
    "services.shopifyRemoteBuilder.validation.publicCaches must contain only approved signed public caches."
  ];
assert rejected unsafeUid.config.services.shopifyRemoteBuilder.ssh.uid;
assert rejected unsafePrivateKeyPath.config.services.shopifyRemoteBuilder.ssh.privateKeyFile;
assert rejected unsafeStatePath.config.services.shopifyRemoteBuilder.validation.stateDirectory;
assert rejected unsafePublicKey.config.services.shopifyRemoteBuilder.ssh.clientPublicKey;
assert rejected
  (builtins.head unsafeCacheEndpoint.config.services.shopifyRemoteBuilder.validation.publicCaches)
  .endpoint;
assert
  let
    unsafeCache = builtins.head unsafeCacheKey.config.services.shopifyRemoteBuilder.validation.publicCaches;
    unsafeCacheKeyValue = builtins.head unsafeCache.trustedKeys;
  in
  rejected unsafeCacheKeyValue;
assert
  validPersonal.config.services.shopifyRemoteBuilder.ssh == {
    user = "_nixremote";
    uid = 502;
    port = 22;
    clientPublicKey = fixtureClientKey;
    privateKeyFile = null;
    publicHostKey = null;
    sourceCidrs = defaultSourceCidrs;
  };
assert
  validShopify.config.services.shopifyRemoteBuilder.ssh == {
    user = "_nixremote";
    uid = 502;
    port = 22;
    clientPublicKey = null;
    privateKeyFile = fixturePrivateKeyPath;
    publicHostKey = fixtureHostKey;
    sourceCidrs = defaultSourceCidrs;
  };
assert
  let
    personalRendered = builtins.fromJSON (renderedRole validPersonal);
    shopifyRendered = builtins.fromJSON (renderedRole validShopify);
  in
  personalRendered.ssh == {
    clientPublicKey = fixtureClientKey;
    privateKeyFile = null;
    publicHostKey = null;
  }
  &&
    shopifyRendered.ssh == {
      clientPublicKey = null;
      privateKeyFile = fixturePrivateKeyPath;
      publicHostKey = fixtureHostKey;
    };
true
