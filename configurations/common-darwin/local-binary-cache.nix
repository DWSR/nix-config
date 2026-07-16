{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.services.localBinaryCache;

  absolutePathType = types.addCheck types.str (lib.hasPrefix "/") // {
    description = "absolute path";
  };
  runtimePathType =
    types.addCheck absolutePathType (
      path:
      let
        pathComponents = lib.drop 1 (lib.splitString "/" path);
        lowerPath = lib.toLower path;
        lowerStoreDir = lib.toLower builtins.storeDir;
      in
      builtins.getContext path == { }
      && (
        path == "/"
        || lib.all (component: component != "" && component != "." && component != "..") pathComponents
      )
      && lowerPath != lowerStoreDir
      && !lib.hasPrefix "${lowerStoreDir}/" lowerPath
    )
    // {
      description = "absolute runtime path without Nix store context";
    };
  endpointType = types.enum [ "https://Brandons-MacBook-Pro.local:8443" ];
  cachePublicKeyType =
    types.addCheck types.str (
      key: builtins.match "[^:[:space:]]+:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=" key != null
    )
    // {
      description = "Nix cache public key with a 32-byte base64-encoded Ed25519 payload";
    };

  publisherOptions = {
    options = {
      enable = mkEnableOption "asynchronous publication to the local binary cache";

      package = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Attic client package used by the publisher.";
      };

      tokenFile = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime path to this host's cache-scoped publication token.";
      };

      stateDirectory = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime directory for pending publication state and GC roots.";
      };

      tokenValidity = mkOption {
        type = types.enum [ 31536000 ];
        default = 31536000;
        description = "Validity of issued publication tokens in seconds.";
      };

      intervalSeconds = mkOption {
        type = types.positive;
        default = 60;
        description = "Interval between asynchronous publication attempts.";
      };

      chainedHooks = mkOption {
        type = types.listOf absolutePathType;
        default = [ ];
        description = "Explicit existing post-build hooks invoked by the final wrapper.";
      };
    };
  };

  consumerOptions = {
    options = {
      enable = mkEnableOption "trusted consumption from the local binary cache";

      priority = mkOption {
        type = types.enum [ 30 ];
        default = 30;
        description = "Local cache priority, lower than configured public upstreams.";
      };

      negativeTtlSeconds = mkOption {
        type = types.enum [ 60 ];
        default = 60;
        description = "Negative narinfo cache lifetime in seconds.";
      };
    };
  };

  serverOptions = {
    options = {
      enable = mkEnableOption "the personal-host local binary cache server";

      package = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Attic server package used by the cache daemon.";
      };

      proxyPackage = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "TLS reverse-proxy package used for LAN access.";
      };

      listenAddress = mkOption {
        type = types.enum [ "127.0.0.1:8080" ];
        default = "127.0.0.1:8080";
        description = "Loopback-only Attic listen address.";
      };

      stateDirectory = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime directory containing Attic database and object state.";
      };

      jwtPublicKey = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Committed RS256 public key used to verify publication tokens.";
      };

      tlsCertificate = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Committed public TLS leaf certificate or certificate chain.";
      };

      tlsKeyFile = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime path to the TLS leaf private key.";
      };
    };
  };
in
{
  options.services.localBinaryCache = {
    enable = mkEnableOption "the local signed binary cache integration";

    hostRole = mkOption {
      type = types.nullOr (
        types.enum [
          "personal"
          "shopify"
        ]
      );
      default = null;
      description = "Host role used to validate server, publisher, and consumer capabilities.";
    };

    bootstrapMode = mkOption {
      type = types.bool;
      default = false;
      description = "Expose only the personal cache server before cache trust is captured.";
    };

    endpoint = mkOption {
      type = endpointType;
      default = "https://Brandons-MacBook-Pro.local:8443";
      description = "LAN TLS origin shared by server, publisher, and consumer capabilities.";
    };

    cacheName = mkOption {
      type = types.nonEmptyStr;
      default = "darwin";
      description = "Existing Attic cache identity; the module never creates it automatically.";
    };

    cachePublicKey = mkOption {
      type = types.nullOr cachePublicKeyType;
      default = null;
      description = "Committed Nix signing public key captured during explicit bootstrap.";
    };

    caCertificate = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Committed LAN certificate authority used by cache consumers.";
    };

    publisher = mkOption {
      type = types.submodule publisherOptions;
      default = { };
      description = "Asynchronous host publication contract.";
    };

    consumer = mkOption {
      type = types.submodule consumerOptions;
      default = { };
      description = "Trusted Nix daemon consumption contract.";
    };

    server = mkOption {
      type = types.submodule serverOptions;
      default = { };
      description = "Personal-host Attic and TLS endpoint contract.";
    };
  };

  config.assertions = [
    {
      assertion = !cfg.server.enable || cfg.enable;
      message = "services.localBinaryCache.server.enable requires services.localBinaryCache.enable.";
    }
    {
      assertion = !cfg.publisher.enable || cfg.enable;
      message = "services.localBinaryCache.publisher.enable requires services.localBinaryCache.enable.";
    }
    {
      assertion = !cfg.consumer.enable || cfg.enable;
      message = "services.localBinaryCache.consumer.enable requires services.localBinaryCache.enable.";
    }
    {
      assertion = !cfg.enable || cfg.hostRole != null;
      message = "services.localBinaryCache.hostRole is required when services.localBinaryCache.enable is true.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.enable;
      message = "services.localBinaryCache.bootstrapMode requires services.localBinaryCache.enable.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.hostRole == "personal";
      message = "services.localBinaryCache.bootstrapMode may only be true when hostRole is personal.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.server.enable;
      message = "services.localBinaryCache.bootstrapMode requires server.enable.";
    }
    {
      assertion = !cfg.bootstrapMode || !cfg.publisher.enable;
      message = "services.localBinaryCache.publisher.enable must be false in bootstrap mode.";
    }
    {
      assertion = !cfg.bootstrapMode || !cfg.consumer.enable;
      message = "services.localBinaryCache.consumer.enable must be false in bootstrap mode.";
    }
    {
      assertion = !cfg.server.enable || cfg.hostRole == "personal";
      message = "services.localBinaryCache.server.enable may only be true when hostRole is personal.";
    }
    {
      assertion = !cfg.enable || cfg.bootstrapMode || cfg.publisher.enable;
      message = "services.localBinaryCache.publisher.enable must be true in ready mode.";
    }
    {
      assertion = !cfg.enable || cfg.bootstrapMode || cfg.consumer.enable;
      message = "services.localBinaryCache.consumer.enable must be true in ready mode.";
    }
    {
      assertion = !cfg.enable || cfg.bootstrapMode || cfg.hostRole != "personal" || cfg.server.enable;
      message = "services.localBinaryCache.server.enable must be true for the personal host in ready mode.";
    }
    {
      assertion = !cfg.enable || cfg.bootstrapMode || cfg.cachePublicKey != null;
      message = "services.localBinaryCache.cachePublicKey is required in ready mode.";
    }
    {
      assertion = !cfg.consumer.enable || cfg.caCertificate != null;
      message = "services.localBinaryCache.caCertificate is required when consumer.enable is true.";
    }
    {
      assertion = !cfg.publisher.enable || !config.nix.distributedBuilds;
      message = "services.localBinaryCache.publisher.enable requires nix.distributedBuilds = false.";
    }
    {
      assertion = !cfg.publisher.enable || cfg.publisher.package != null;
      message = "services.localBinaryCache.publisher.package is required when publisher.enable is true.";
    }
    {
      assertion = !cfg.publisher.enable || cfg.publisher.tokenFile != null;
      message = "services.localBinaryCache.publisher.tokenFile is required when publisher.enable is true.";
    }
    {
      assertion = !cfg.publisher.enable || cfg.publisher.stateDirectory != null;
      message = "services.localBinaryCache.publisher.stateDirectory is required when publisher.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.package != null;
      message = "services.localBinaryCache.server.package is required when server.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.proxyPackage != null;
      message = "services.localBinaryCache.server.proxyPackage is required when server.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.stateDirectory != null;
      message = "services.localBinaryCache.server.stateDirectory is required when server.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.jwtPublicKey != null;
      message = "services.localBinaryCache.server.jwtPublicKey is required when server.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.tlsCertificate != null;
      message = "services.localBinaryCache.server.tlsCertificate is required when server.enable is true.";
    }
    {
      assertion = !cfg.server.enable || cfg.server.tlsKeyFile != null;
      message = "services.localBinaryCache.server.tlsKeyFile is required when server.enable is true.";
    }
  ];
}
