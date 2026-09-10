{ lib }:
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

  mkConfiguration =
    moduleConfig:
    lib.evalModules {
      modules = [
        modulePath
        moduleConfig
      ];
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
        clientPublicKey = "ssh-ed25519 AAAAfixture-client-key";
        privateKeyFile = "/run/secrets/shopify-remote-builder-client-key";
        publicHostKey = "ssh-ed25519 AAAAfixture-host-key";
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
            trustedKeys = [ "cache.example.test-1:fixture-key" ];
          }
        ];
      };
    };
  };
  defaultOptionNames = [
    "allowedRepositories"
    "enable"
    "endpoint"
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
      clientPublicKey = "ssh-ed25519 AAAAfixture-client-key";
      privateKeyFile = "/run/secrets/shopify-remote-builder-client-key";
      publicHostKey = "ssh-ed25519 AAAAfixture-host-key";
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
          trustedKeys = [ "cache.example.test-1:fixture-key" ];
        }
      ];
    };
  };
true
