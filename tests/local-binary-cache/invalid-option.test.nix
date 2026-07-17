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

        nix.package = lib.mkOption {
          type = lib.types.package;
          default = pkgs.nix;
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

        environment.systemPackages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
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
    server-state-root = {
      module.services.localBinaryCache.server.stateDirectory = "/";
      select = config: config.server.stateDirectory;
    };
    server-state-database-root = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db";
      select = config: config.server.stateDirectory;
    };
    server-state-namespace-parent = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db/local-binary-cache";
      select = config: config.server.stateDirectory;
    };
    server-state-descendant = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db/local-binary-cache/attic/storage";
      select = config: config.server.stateDirectory;
    };
    server-state-log-namespace = {
      module.services.localBinaryCache.server.stateDirectory = "/var/log/local-binary-cache";
      select = config: config.server.stateDirectory;
    };
    server-state-log-directory = {
      module.services.localBinaryCache.server.stateDirectory = "/var/log/local-binary-cache/attic";
      select = config: config.server.stateDirectory;
    };
    server-state-system-directory = {
      module.services.localBinaryCache.server.stateDirectory = "/etc";
      select = config: config.server.stateDirectory;
    };
    server-state-whitespace = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db/local-binary-cache/attic state";
      select = config: config.server.stateDirectory;
    };
    server-state-control = {
      module.services.localBinaryCache.server.stateDirectory =
        builtins.fromJSON ''"/var/db/local-binary-cache/attic\u0001state"'';
      select = config: config.server.stateDirectory;
    };
    server-state-query = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db/local-binary-cache/attic?mode=ro";
      select = config: config.server.stateDirectory;
    };
    server-state-fragment = {
      module.services.localBinaryCache.server.stateDirectory =
        "/var/db/local-binary-cache/attic#fragment";
      select = config: config.server.stateDirectory;
    };
    server-state-percent = {
      module.services.localBinaryCache.server.stateDirectory = "/var/db/local-binary-cache/%61ttic";
      select = config: config.server.stateDirectory;
    };
    tls-key-caddyfile-injection = {
      module.services.localBinaryCache.server.tlsKeyFile =
        builtins.fromJSON ''"/run/secrets/key\n}\n:9000 {"'';
      select = config: config.server.tlsKeyFile;
    };
    tls-key-backslash = {
      module.services.localBinaryCache.server.tlsKeyFile = "/run/secrets/local\\binary-cache-key";
      select = config: config.server.tlsKeyFile;
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
