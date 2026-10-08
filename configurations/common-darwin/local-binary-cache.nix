{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.services.localBinaryCache;

  atticDaemonLabel = "org.nixos.local-binary-cache-attic";
  caddyDaemonLabel = "org.nixos.local-binary-cache-caddy";
  atticStateDirectory = "/var/db/local-binary-cache/attic";
  atticLogDirectory = "/var/log/local-binary-cache/attic";
  atticStandardOutPath = "${atticLogDirectory}/stdout.log";
  atticStandardErrorPath = "${atticLogDirectory}/stderr.log";
  caddyLogDirectory = "/var/log/local-binary-cache/caddy";
  caddyStandardOutPath = "${caddyLogDirectory}/stdout.log";
  caddyStandardErrorPath = "${caddyLogDirectory}/stderr.log";
  publisherDaemonLabel = "org.nixos.local-binary-cache-publisher";
  publisherLogDirectory = "/var/log/local-binary-cache/publisher";
  publisherStandardOutPath = "${publisherLogDirectory}/stdout.log";
  publisherStandardErrorPath = "${publisherLogDirectory}/stderr.log";
  loginUser = if config.system.primaryUser == null then "" else config.system.primaryUser;
  canonicalAuthority = lib.toLower (lib.removePrefix "https://" cfg.endpoint);

  tomlFormat = pkgs.formats.toml { };
  jwtPublicKeyPlaceholder = "LOCAL_BINARY_CACHE_RS256_PUBLIC_KEY_BASE64";
  atticConfigTemplate = tomlFormat.generate "attic-server-template.toml" {
    listen = cfg.server.listenAddress;
    allowed-hosts = [ canonicalAuthority ];
    api-endpoint = "${cfg.endpoint}/";
    substituter-endpoint = "${cfg.endpoint}/";

    database.url = "sqlite://${cfg.server.stateDirectory}/attic.db?mode=rwc";
    storage = {
      type = "local";
      path = "${cfg.server.stateDirectory}/storage";
    };
    chunking = {
      nar-size-threshold = 65536;
      min-size = 16384;
      avg-size = 65536;
      max-size = 262144;
    };
    compression.type = "zstd";
    garbage-collection = {
      interval = cfg.server.gcInterval;
      default-retention-period = "${toString cfg.server.retentionDays} days";
    };
    jwt.signing.token-rs256-pubkey-base64 = jwtPublicKeyPlaceholder;
  };
  atticConfig = pkgs.runCommand "attic-server.toml" { nativeBuildInputs = [ pkgs.coreutils ]; } ''
    public_key_base64="$(base64 --wrap=0 < ${cfg.server.jwtPublicKey})"
    substitute ${atticConfigTemplate} "$out" \
      --replace-fail ${lib.escapeShellArg jwtPublicKeyPlaceholder} "$public_key_base64"
  '';
  # Caddy 2.11.4 decodes escaped quotes but preserves JSON newline and
  # backslash escapes, so tlsKeyFile is restricted to proven round-trip input.
  caddyfileToken = value: builtins.toJSON value;
  proxyUpstream = "http://${cfg.server.listenAddress}";
  proxyConfig = pkgs.writeText "local-binary-cache-Caddyfile" (
    lib.concatStrings [
      "{\n"
      "\tadmin off\n"
      "\tpersist_config off\n"
      "\tauto_https off\n"
      "\tservers {\n"
      "\t\tprotocols h1 h2\n"
      "\t}\n"
      "}\n"
      "\n"
      "${caddyfileToken cfg.endpoint} {\n"
      "\ttls ${caddyfileToken cfg.server.tlsCertificate} ${caddyfileToken cfg.server.tlsKeyFile}\n"
      "\treverse_proxy ${caddyfileToken proxyUpstream} {\n"
      "\t\theader_up Host ${caddyfileToken canonicalAuthority}\n"
      "\t}\n"
      "}\n"
    ]
  );
  proxyWrapper = pkgs.writeShellScriptBin "local-binary-cache-caddy" ''
    fail() {
      printf 'local-binary-cache-caddy: %s\n' "$1" >&2
      exit 1
    }

    tls_certificate=${lib.escapeShellArg (toString cfg.server.tlsCertificate)}
    tls_key=${lib.escapeShellArg cfg.server.tlsKeyFile}

    if [[ ! -e "$tls_certificate" ]]; then
      fail "TLS certificate is missing: $tls_certificate"
    fi
    if [[ ! -f "$tls_certificate" ]]; then
      fail "TLS certificate is not a regular file: $tls_certificate"
    fi
    if [[ ! -r "$tls_certificate" ]]; then
      fail "TLS certificate is unreadable: $tls_certificate"
    fi

    if [[ -L "$tls_key" ]]; then
      fail "refusing unsafe TLS private key symlink: $tls_key"
    fi
    if [[ ! -e "$tls_key" ]]; then
      fail "TLS private key is missing: $tls_key"
    fi
    if [[ ! -f "$tls_key" ]]; then
      fail "TLS private key is not a regular file: $tls_key"
    fi
    if [[ ! -r "$tls_key" ]]; then
      fail "TLS private key is unreadable: $tls_key"
    fi

    exec ${lib.getExe' cfg.server.proxyPackage "caddy"} run \
      --config ${proxyConfig} \
      --adapter caddyfile
  '';

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
  safeRuntimePathType =
    types.addCheck runtimePathType (
      path: builtins.match "/[A-Za-z0-9._+,:=@%~-]+(/[A-Za-z0-9._+,:=@%~-]+)*" path != null
    )
    // {
      description = "canonical context-free absolute runtime path using safe ASCII characters";
    };
  safeExecutablePathType =
    types.addCheck absolutePathType (
      path:
      let
        pathComponents = lib.drop 1 (lib.splitString "/" path);
        lowerPath = lib.toLower path;
        lowerStoreDir = lib.toLower builtins.storeDir;
        isStorePath = lowerPath == lowerStoreDir || lib.hasPrefix "${lowerStoreDir}/" lowerPath;
        hasStoreContext = builtins.getContext path != { };
      in
      path != "/"
      && lib.all (component: component != "" && component != "." && component != "..") pathComponents
      && builtins.match "/[A-Za-z0-9._+,:=@%~-]+(/[A-Za-z0-9._+,:=@%~-]+)*" path != null
      && isStorePath == hasStoreContext
    )
    // {
      description = "safe absolute executable path with Nix context exactly when store-backed";
    };
  publisherStateDirectoryType = types.addCheck runtimePathType (path: path != "/") // {
    description = "non-root absolute publisher runtime directory without Nix store context";
  };
  caddyTlsKeyPathType =
    types.addCheck runtimePathType (path: builtins.match "/[ /A-Za-z0-9._+,:=@%~\"'()-]+" path != null)
    // {
      description = "Caddyfile-serializable absolute runtime path using safe ASCII characters";
    };
  uriSafeServerStateDirectoryType =
    types.addCheck runtimePathType (path: builtins.match "/[^[:space:][:cntrl:]?#%]+" path != null)
    // {
      description = "non-root runtime path without whitespace, control characters, or URI-reserved ?, #, and % characters";
    };
  serverStateDirectoryType =
    types.addCheck uriSafeServerStateDirectoryType (path: path == atticStateDirectory)
    // {
      description = "exact canonical Attic state path ${atticStateDirectory}";
    };
  pathsOverlap =
    first: second:
    first == second || lib.hasPrefix "${first}/" second || lib.hasPrefix "${second}/" first;
  endpointType = types.enum [ "https://Brandons-MacBook-Pro.local:8443" ];
  cachePublicKeyType =
    types.addCheck types.str (
      key: builtins.match "[^:[:space:]]+:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=" key != null
    )
    // {
      description = "Nix cache public key with a 32-byte base64-encoded Ed25519 payload";
    };
  localSubstituter = "${cfg.endpoint}/${cfg.cacheName}";
  declarativeSubstituters = lib.unique (
    (config.nix.settings.substituters or [ ]) ++ (config.nix.settings.extra-substituters or [ ])
  );
  declarativeTrustedPublicKeys = lib.unique (
    (config.nix.settings.trusted-public-keys or [ ])
    ++ (config.nix.settings.extra-trusted-public-keys or [ ])
  );

  bootstrapInputsDeclared =
    cfg.server.package != null
    && cfg.caCertificate != null
    && cfg.bootstrap.jwtPrivateKey != null
    && cfg.bootstrap.cachePublicKeyOutput != null
    && cfg.bootstrap.personalTokenOutput != null
    && cfg.server.jwtPublicKey != null
    && cfg.server.tlsCertificate != null
    && cfg.server.tlsKeyFile != null;
  bootstrapPackage =
    if cfg.server.enable && bootstrapInputsDeclared then
      pkgs.callPackage ../../scripts/local-binary-cache-bootstrap.nix {
        atticAdminExecutable = lib.getExe' cfg.server.package "atticadm";
        atticClientExecutable = lib.getExe' cfg.bootstrap.clientPackage "attic";
        caCertificate = toString cfg.caCertificate;
        inherit (cfg) cacheName endpoint;
        inherit (cfg.bootstrap)
          cachePublicKeyOutput
          jwtPrivateKey
          personalTokenOutput
          ;
        configuredCachePublicKey = if cfg.cachePublicKey == null then "" else cfg.cachePublicKey;
        curlExecutable = lib.getExe pkgs.curl;
        jqExecutable = lib.getExe pkgs.jq;
        jwtPublicKey = toString cfg.server.jwtPublicKey;
        inherit loginUser;
        tlsCertificate = toString cfg.server.tlsCertificate;
        inherit (cfg.server) tlsKeyFile;
        tokenValiditySeconds = cfg.publisher.tokenValidity;
      }
    else
      null;
  readinessPackage =
    if cfg.enable then
      pkgs.callPackage ../../scripts/local-binary-cache-status.nix {
        caCertificate = if cfg.caCertificate == null then "" else toString cfg.caCertificate;
        inherit (cfg) bootstrapMode cacheName endpoint;
        configuredCachePublicKey = if cfg.cachePublicKey == null then "" else cfg.cachePublicKey;
        curlExecutable = lib.getExe pkgs.curl;
        dateExecutable = lib.getExe' pkgs.coreutils "date";
        expectedPostBuildHook = "";
        expectedSubstituters = "";
        jqExecutable = lib.getExe pkgs.jq;
        nixExecutable = lib.getExe config.nix.package;
        pendingDirectory =
          if cfg.publisher.stateDirectory == null then "" else "${cfg.publisher.stateDirectory}/pending";
        readlinkExecutable = lib.getExe' pkgs.coreutils "readlink";
        readinessOnly = true;
        statExecutable = lib.getExe' pkgs.coreutils "stat";
        storeDirectory = builtins.storeDir;
      }
    else
      null;
  diagnosticsPackage =
    if cfg.enable then
      pkgs.callPackage ../../scripts/local-binary-cache-status.nix {
        caCertificate = if cfg.caCertificate == null then "" else toString cfg.caCertificate;
        inherit (cfg) bootstrapMode cacheName endpoint;
        configuredCachePublicKey = if cfg.cachePublicKey == null then "" else cfg.cachePublicKey;
        curlExecutable = lib.getExe pkgs.curl;
        dateExecutable = lib.getExe' pkgs.coreutils "date";
        expectedPostBuildHook =
          if postBuildHookPackage == null then "" else lib.getExe postBuildHookPackage;
        expectedSubstituters = lib.concatStringsSep " " declarativeSubstituters;
        jqExecutable = lib.getExe pkgs.jq;
        name = "local-binary-cache-diagnostics";
        nixExecutable = lib.getExe config.nix.package;
        pendingDirectory =
          if cfg.publisher.stateDirectory == null then "" else "${cfg.publisher.stateDirectory}/pending";
        readlinkExecutable = lib.getExe' pkgs.coreutils "readlink";
        readinessOnly = false;
        statExecutable = lib.getExe' pkgs.coreutils "stat";
        storeDirectory = builtins.storeDir;
      }
    else
      null;
  enqueueHookPackage =
    if cfg.publisher.enable && cfg.publisher.stateDirectory != null then
      pkgs.callPackage ../../scripts/local-binary-cache-enqueue.nix {
        nixStoreExecutable = lib.getExe' config.nix.package "nix-store";
        pendingDirectory = "${cfg.publisher.stateDirectory}/pending";
        storeDirectory = builtins.storeDir;
      }
    else
      null;
  postBuildHookPackage =
    if enqueueHookPackage != null then
      pkgs.writeShellApplication {
        name = "local-binary-cache-post-build-hook";
        text = lib.concatStringsSep "\n" (
          [ (lib.escapeShellArg (lib.getExe enqueueHookPackage)) ]
          ++ map lib.escapeShellArg cfg.publisher.chainedHooks
        );
      }
    else
      null;
  publisherPackage =
    if
      cfg.publisher.enable
      && cfg.publisher.package != null
      && cfg.publisher.tokenFile != null
      && cfg.publisher.stateDirectory != null
      && cfg.caCertificate != null
    then
      pkgs.callPackage ../../scripts/local-binary-cache-publish.nix {
        atticExecutable = lib.getExe cfg.publisher.package;
        caCertificate = toString cfg.caCertificate;
        inherit (cfg) cacheName endpoint;
        pendingDirectory = "${cfg.publisher.stateDirectory}/pending";
        shlockExecutable = "/usr/bin/shlock";
        inherit (cfg.publisher) stateDirectory tokenFile;
        storeDirectory = builtins.storeDir;
      }
    else
      null;

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
        type = types.nullOr publisherStateDirectoryType;
        default = null;
        description = "Runtime directory for pending publication state and GC roots.";
      };

      tokenValidity = mkOption {
        type = types.enum [ 31557600 ];
        default = 31557600;
        description = "Attic one-year validity of issued publication tokens in seconds.";
      };

      intervalSeconds = mkOption {
        type = types.ints.positive;
        default = 60;
        description = "Interval between asynchronous publication attempts.";
      };

      chainedHooks = mkOption {
        type = types.listOf safeExecutablePathType;
        default = [ ];
        description = "Explicit existing post-build hooks invoked by the final wrapper.";
      };

      enqueuePackage = mkOption {
        type = types.nullOr types.package;
        default = enqueueHookPackage;
        readOnly = true;
        description = "Local-only enqueue hook instantiated with this host's Nix and pending state paths.";
      };

      postBuildHookPackage = mkOption {
        type = types.nullOr types.package;
        default = postBuildHookPackage;
        readOnly = true;
        description = "Final post-build wrapper that enqueues before explicitly chained hooks.";
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
        type = types.enum [ "127.0.0.1:18080" ];
        default = "127.0.0.1:18080";
        description = "Loopback-only Attic listen address.";
      };

      stateDirectory = mkOption {
        type = types.nullOr serverStateDirectoryType;
        default = null;
        description = "Runtime directory containing Attic database and object state.";
      };

      retentionDays = mkOption {
        type = types.enum [ 30 ];
        default = 30;
        description = "Number of unused days before cache artifacts become eligible for collection.";
      };

      gcInterval = mkOption {
        type = types.enum [ "12 hours" ];
        default = "12 hours";
        description = "Interval between cache garbage-collection runs.";
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
        type = types.nullOr caddyTlsKeyPathType;
        default = null;
        description = "Runtime path to the TLS leaf private key.";
      };

      configFile = mkOption {
        type = types.nullOr types.path;
        default = if cfg.server.enable then atticConfig else null;
        readOnly = true;
        description = "Secret-free Attic server configuration consumed by the cache daemon.";
      };

      proxyConfigFile = mkOption {
        type = types.nullOr types.path;
        default = if cfg.server.enable then proxyConfig else null;
        readOnly = true;
        description = "Explicit Caddy LAN TLS reverse-proxy configuration.";
      };

      proxyWrapper = mkOption {
        type = types.nullOr types.package;
        default = if cfg.server.enable then proxyWrapper else null;
        readOnly = true;
        description = "Caddy launcher with runtime TLS path preflight.";
      };
    };
  };

  gcPolicyOptions = {
    options = {
      minFree = mkOption {
        type = types.nullOr types.ints.unsigned;
        default = null;
        description = "Free-byte threshold that triggers Nix store pressure garbage collection.";
      };

      maxFree = mkOption {
        type = types.nullOr types.ints.unsigned;
        default = null;
        description = "Free-byte target for Nix store pressure garbage collection.";
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
      type = types.enum [ "darwin" ];
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

    bootstrap = {
      clientPackage = mkOption {
        type = types.package;
        default = if pkgs ? unstable then pkgs.unstable.attic-client else pkgs.attic-client;
        description = "Attic client package used only by explicit cache bootstrap operations.";
      };

      jwtPrivateKey = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime path to the operator-only RS256 private key used by explicit bootstrap operations.";
      };

      cachePublicKeyOutput = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime output path for the public cache signing key captured during bootstrap.";
      };

      personalTokenOutput = mkOption {
        type = types.nullOr runtimePathType;
        default = null;
        description = "Runtime output path for the personal host's bootstrap publication token.";
      };

      package = mkOption {
        type = types.nullOr types.package;
        default = bootstrapPackage;
        readOnly = true;
        description = "Explicit identity preflight and cache bootstrap operations package.";
      };

      command = mkOption {
        type = types.nullOr types.str;
        default =
          if cfg.bootstrap.package == null then
            null
          else
            "${cfg.bootstrap.package}/bin/local-binary-cache-bootstrap";
        readOnly = true;
        description = "Stable command path for explicit identity preflight and cache bootstrap operations.";
      };
    };

    readiness = {
      package = mkOption {
        type = types.nullOr types.package;
        default = readinessPackage;
        readOnly = true;
        description = "Read-only TLS, anonymous cache, and signing identity readiness package.";
      };

      command = mkOption {
        type = types.nullOr types.str;
        default =
          if cfg.readiness.package == null then
            null
          else
            "${cfg.readiness.package}/bin/local-binary-cache-status";
        readOnly = true;
        description = "Stable operator-invokable command path for cache runtime readiness.";
      };
    };

    diagnostics = {
      package = mkOption {
        type = types.nullOr types.package;
        default = diagnosticsPackage;
        readOnly = true;
        description = "Full read-only cache, effective Nix configuration, and publisher queue diagnostics package.";
      };

      command = mkOption {
        type = types.nullOr types.str;
        default =
          if cfg.diagnostics.package == null then
            null
          else
            "${cfg.diagnostics.package}/bin/local-binary-cache-diagnostics";
        readOnly = true;
        description = "Stable operator-invokable command path for full cache diagnostics.";
      };
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

    gcPolicy = mkOption {
      type = types.submodule gcPolicyOptions;
      default = { };
      description = "Optional Nix store pressure garbage-collection policy.";
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
      assertion = !cfg.bootstrapMode || cfg.caCertificate != null;
      message = "services.localBinaryCache.caCertificate is required in bootstrap mode.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.bootstrap.jwtPrivateKey != null;
      message = "services.localBinaryCache.bootstrap.jwtPrivateKey is required in bootstrap mode.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.bootstrap.cachePublicKeyOutput != null;
      message = "services.localBinaryCache.bootstrap.cachePublicKeyOutput is required in bootstrap mode.";
    }
    {
      assertion = !cfg.bootstrapMode || cfg.bootstrap.personalTokenOutput != null;
      message = "services.localBinaryCache.bootstrap.personalTokenOutput is required in bootstrap mode.";
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
      assertion =
        builtins.length cfg.publisher.chainedHooks
        == builtins.length (lib.unique cfg.publisher.chainedHooks);
      message = "services.localBinaryCache.publisher.chainedHooks must not contain duplicate paths.";
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
      assertion = !cfg.server.enable || config.system.primaryUser != null;
      message = "services.localBinaryCache.server.enable requires system.primaryUser.";
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
      assertion =
        !cfg.server.enable
        || cfg.server.stateDirectory == null
        || !pathsOverlap cfg.server.stateDirectory atticLogDirectory;
      message = "services.localBinaryCache.server.stateDirectory must not overlap the Attic log directory.";
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
    {
      assertion = (cfg.gcPolicy.minFree == null) == (cfg.gcPolicy.maxFree == null);
      message = "services.localBinaryCache.gcPolicy.minFree and gcPolicy.maxFree must be set together.";
    }
    {
      assertion =
        cfg.gcPolicy.minFree == null
        || cfg.gcPolicy.maxFree == null
        || (cfg.gcPolicy.minFree > 0 && cfg.gcPolicy.maxFree > cfg.gcPolicy.minFree);
      message = "services.localBinaryCache.gcPolicy requires maxFree > minFree > 0 when configured.";
    }
  ];

  config.environment.systemPackages = lib.optionals cfg.enable (
    [
      cfg.readiness.package
      cfg.diagnostics.package
    ]
    ++ lib.optional (cfg.bootstrap.package != null) cfg.bootstrap.package
  );

  config.security.pki.certificateFiles = lib.mkIf (cfg.consumer.enable && cfg.caCertificate != null) [
    cfg.caCertificate
  ];

  config.nix.settings = lib.mkIf cfg.consumer.enable {
    extra-substituters = [ localSubstituter ];
    extra-trusted-public-keys = lib.optional (cfg.cachePublicKey != null) cfg.cachePublicKey;
    fallback = true;
    narinfo-cache-negative-ttl = cfg.consumer.negativeTtlSeconds;
    require-sigs = true;
    ssl-cert-file = "/etc/ssl/certs/ca-certificates.crt";
  };

  config.nix.extraOptions = lib.mkMerge [
    (lib.mkIf (cfg.publisher.postBuildHookPackage != null) (
      lib.mkOrder 9999 ''
        post-build-hook = ${lib.getExe cfg.publisher.postBuildHookPackage}
      ''
    ))
  ];

  config.system.activationScripts.launchd.text =
    lib.mkIf (cfg.server.enable || cfg.publisher.enable)
      (
        lib.mkBefore ''
          ${lib.optionalString cfg.server.enable ''
            attic_user=${lib.escapeShellArg loginUser}
            attic_state_directory=${
              lib.escapeShellArg (if cfg.server.stateDirectory == null then "" else cfg.server.stateDirectory)
            }
            attic_log_directory=${lib.escapeShellArg atticLogDirectory}
            attic_stdout_log=${lib.escapeShellArg atticStandardOutPath}
            attic_stderr_log=${lib.escapeShellArg atticStandardErrorPath}
            caddy_log_directory=${lib.escapeShellArg caddyLogDirectory}
            caddy_stdout_log=${lib.escapeShellArg caddyStandardOutPath}
            caddy_stderr_log=${lib.escapeShellArg caddyStandardErrorPath}
          ''}publisher_state_directory=${
            lib.escapeShellArg (
              if !cfg.publisher.enable || cfg.publisher.stateDirectory == null then
                ""
              else
                cfg.publisher.stateDirectory
            )
          }
          publisher_pending_directory="$publisher_state_directory/pending"
          publisher_log_directory=${lib.escapeShellArg publisherLogDirectory}
          publisher_stdout_log=${lib.escapeShellArg publisherStandardOutPath}
          publisher_stderr_log=${lib.escapeShellArg publisherStandardErrorPath}

          fail_attic_path() {
            printf 'local-binary-cache: %s: %s\n' "$1" "$2" >&2
            exit 1
          }

          prepare_trusted_parents() {
            local target="$1"
            local parent="''${target%/*}"
            local current=""
            local component link_owner parent_owner parent_mode
            local -a components

            IFS='/' read -r -a components <<< "''${parent#/}"
            for component in "''${components[@]}"; do
              current="$current/$component"
              if [[ -L "$current" ]]; then
                link_owner="$(/usr/bin/stat -f '%Su' "$current")"
                if [[ "$link_owner" != root ]]; then
                  fail_attic_path "refusing attacker-controlled symlink path component" "$current"
                fi
              elif [[ -e "$current" && ! -d "$current" ]]; then
                fail_attic_path "runtime path component is not a directory" "$current"
              elif [[ ! -e "$current" ]]; then
                /usr/bin/install -d -o root -g wheel -m 0755 "$current"
              fi

              parent_owner="$(/usr/bin/stat -L -f '%Su' "$current")"
              parent_mode="$(/usr/bin/stat -L -f '%OLp' "$current")"
              if [[ "$parent_owner" != root ]] || (( (8#$parent_mode & 0022) != 0 )); then
                fail_attic_path "refusing attacker-controlled parent directory" "$current"
              fi
            done
          }

          prepare_owned_directory() {
            local target="$1"
            local owner="$2"
            local group="$3"
            local mode="$4"

            prepare_trusted_parents "$target"
            if [[ -L "$target" ]]; then
              fail_attic_path "refusing attacker-controlled symlink path component" "$target"
            fi
            if [[ -e "$target" && ! -d "$target" ]]; then
              fail_attic_path "runtime path is not a directory" "$target"
            fi
            /usr/bin/install -d -o "$owner" -g "$group" -m "$mode" "$target"
          }

          prepare_log_file() {
            local target="$1"
            local owner="$2"
            local group="$3"
            local mode="$4"

            if [[ -L "$target" ]]; then
              fail_attic_path "refusing attacker-controlled log symlink" "$target"
            fi
            if [[ -e "$target" && ! -f "$target" ]]; then
              fail_attic_path "log path is not a regular file" "$target"
            fi
            if [[ ! -e "$target" ]]; then
              /usr/bin/touch "$target"
            fi
            /usr/sbin/chown "$owner:$group" "$target"
            /bin/chmod "$mode" "$target"
          }

          ${lib.optionalString cfg.server.enable ''
            echo "local-binary-cache: preparing Attic runtime directories" >&2
            prepare_owned_directory "$attic_state_directory" "$attic_user" staff 0700
            prepare_owned_directory "$attic_log_directory" root wheel 0755
            prepare_log_file "$attic_stdout_log" "$attic_user" staff 0640
            prepare_log_file "$attic_stderr_log" "$attic_user" staff 0640
            prepare_owned_directory "$attic_log_directory" "$attic_user" staff 0750

            echo "local-binary-cache: preparing Caddy log directory" >&2
            prepare_owned_directory "$caddy_log_directory" root wheel 0755
            prepare_log_file "$caddy_stdout_log" "$attic_user" staff 0640
            prepare_log_file "$caddy_stderr_log" "$attic_user" staff 0640
            prepare_owned_directory "$caddy_log_directory" "$attic_user" staff 0750
          ''}

          ${lib.optionalString cfg.publisher.enable ''
            echo "local-binary-cache: preparing publisher runtime directories" >&2
            prepare_owned_directory "$publisher_state_directory" root wheel 0700
            prepare_owned_directory "$publisher_pending_directory" root wheel 0700
            prepare_owned_directory "$publisher_log_directory" root wheel 0755
            prepare_log_file "$publisher_stdout_log" root wheel 0640
            prepare_log_file "$publisher_stderr_log" root wheel 0640
            prepare_owned_directory "$publisher_log_directory" root wheel 0750
          ''}
        ''
      );

  config.launchd.daemons.local-binary-cache-attic = lib.mkIf cfg.server.enable {
    serviceConfig = {
      Label = atticDaemonLabel;
      ProgramArguments = [
        (lib.getExe' cfg.server.package "atticd")
        "-f"
        (toString cfg.server.configFile)
        "--mode"
        "monolithic"
      ];
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ThrottleInterval = 10;
      UserName = loginUser;
      WorkingDirectory = cfg.server.stateDirectory;
      StandardOutPath = atticStandardOutPath;
      StandardErrorPath = atticStandardErrorPath;
    };
  };

  config.launchd.daemons.local-binary-cache-caddy = lib.mkIf cfg.server.enable {
    serviceConfig = {
      Label = caddyDaemonLabel;
      ProgramArguments = [ (lib.getExe cfg.server.proxyWrapper) ];
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ThrottleInterval = 10;
      UserName = loginUser;
      StandardOutPath = caddyStandardOutPath;
      StandardErrorPath = caddyStandardErrorPath;
    };
  };

  config.launchd.daemons.local-binary-cache-publisher = lib.mkIf cfg.publisher.enable {
    serviceConfig = {
      Label = publisherDaemonLabel;
      ProgramArguments = [ (lib.getExe publisherPackage) ];
      RunAtLoad = true;
      StartInterval = cfg.publisher.intervalSeconds;
      UserName = "root";
      WorkingDirectory = cfg.publisher.stateDirectory;
      StandardOutPath = publisherStandardOutPath;
      StandardErrorPath = publisherStandardErrorPath;
    };
  };
}
