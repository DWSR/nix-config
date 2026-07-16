{
  pkgs,
  fixture,
}:
let
  inherit (pkgs) lib;

  modulePath = ../../configurations/common-darwin/local-binary-cache.nix;
  contextualStorePath = "${./fixtures/tls-certificate.pem}";

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

  fixtures = {
    store-root = {
      module.services.localBinaryCache.publisher.tokenFile = builtins.storeDir;
      select = config: config.publisher.tokenFile;
    };
    store-descendant = {
      module.services.localBinaryCache.publisher.stateDirectory =
        "${builtins.storeDir}/contextless-test-path";
      select = config: config.publisher.stateDirectory;
    };
    store-dot-component = {
      module.services.localBinaryCache.publisher.tokenFile = "/nix/./store";
      select = config: config.publisher.tokenFile;
    };
    store-parent-component = {
      module.services.localBinaryCache.publisher.tokenFile = "/nix/not-store/../store";
      select = config: config.publisher.tokenFile;
    };
    store-repeated-separator = {
      module.services.localBinaryCache.publisher.tokenFile = "/nix//store";
      select = config: config.publisher.tokenFile;
    };
    store-trailing-separator = {
      module.services.localBinaryCache.publisher.tokenFile = "${builtins.storeDir}/";
      select = config: config.publisher.tokenFile;
    };
    store-case-variant = {
      module.services.localBinaryCache.publisher.tokenFile = "/NIX/STORE";
      select = config: config.publisher.tokenFile;
    };
    contextual-store = {
      module.services.localBinaryCache.publisher.tokenFile = contextualStorePath;
      select = config: config.publisher.tokenFile;
    };
    key-not-base64 = {
      module.services.localBinaryCache.cachePublicKey = "darwin:not-base64";
      select = config: config.cachePublicKey;
    };
    key-bad-padding = {
      module.services.localBinaryCache.cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs==";
      select = config: config.cachePublicKey;
    };
    key-noncanonical = {
      module.services.localBinaryCache.cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Ft=";
      select = config: config.cachePublicKey;
    };
    endpoint-fragment = {
      module.services.localBinaryCache.endpoint = "https://Brandons-MacBook-Pro.local:8443#fragment";
      select = config: config.endpoint;
    };
    endpoint-query = {
      module.services.localBinaryCache.endpoint = "https://Brandons-MacBook-Pro.local:8443?query";
      select = config: config.endpoint;
    };
    endpoint-userinfo = {
      module.services.localBinaryCache.endpoint = "https://user@Brandons-MacBook-Pro.local:8443";
      select = config: config.endpoint;
    };
    endpoint-whitespace = {
      module.services.localBinaryCache.endpoint = "https:// Brandons-MacBook-Pro.local:8443";
      select = config: config.endpoint;
    };
    endpoint-cache-path = {
      module.services.localBinaryCache.endpoint = "https://Brandons-MacBook-Pro.local:8443/darwin";
      select = config: config.endpoint;
    };
    endpoint-trailing-slash = {
      module.services.localBinaryCache.endpoint = "https://Brandons-MacBook-Pro.local:8443/";
      select = config: config.endpoint;
    };
    endpoint-alternate-host = {
      module.services.localBinaryCache.endpoint = "https://alternate.local:8443";
      select = config: config.endpoint;
    };
  };

  selected = fixtures.${fixture} or (throw "unknown local binary cache fixture: ${fixture}");
  evaluated = lib.evalModules {
    modules = [
      prerequisiteOptions
      modulePath
      selected.module
    ];
    specialArgs = { inherit pkgs; };
  };
in
selected.select evaluated.config.services.localBinaryCache
