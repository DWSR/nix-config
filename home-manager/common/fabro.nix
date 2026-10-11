{
  config,
  lib,
  options,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.programs.fabro;

  # Fabro resolves everything from FABRO_HOME (default ~/.fabro): settings,
  # auth.json, the server unix socket, skills, workflows, logs, tmp, and
  # (unless FABRO_STORAGE_DIR overrides it) the storage tree. The module
  # maps fabro's flat home onto the XDG base directories instead:
  #
  #   settings.toml, auth.json, socket, workflows, skills → xdg.stateHome
  #   SQLite DB, object store, vaults, caches, scratch     → xdg.dataHome
  #
  # This mirrors the FABRO_HOME/FABRO_STORAGE_DIR split upstream's own
  # Docker image performs (`FABRO_HOME=/storage/.home`,
  # `FABRO_STORAGE_DIR=/storage`); the launchd agent EnvironmentVariables
  # below are the launchd equivalent of that image's ENV block.
  fabroStateDir = "${config.xdg.stateHome}/fabro";
  fabroDataDir = cfg.storageDir;
  logDir = "${config.home.homeDirectory}/Library/Logs/fabro";
  settingsPath = "${fabroStateDir}/settings.toml";
  keychainPath = "${config.home.homeDirectory}/Library/Keychains/login.keychain-db";

  settingsManaged = cfg.settings != { };

  # Shell PATH for workflows: anything fabro spawns from agent/command
  # nodes (claude, codex, git..., like the `git` package the upstream
  # Docker image installs) resolves through the service PATH.
  servicePath = lib.concatStringsSep ":" [
    (lib.makeBinPath cfg.path)
    "${config.home.path}/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  ];

  serviceEnv = {
    FABRO_HOME = fabroStateDir;
    FABRO_STORAGE_DIR = toString fabroDataDir;
    # Log to stdout so launchd captures the stream in StandardOutPath
    # instead of fabro's per-node log files inside FABRO_HOME.
    FABRO_LOG_DESTINATION = "stdout";
    # The store-path binary cannot self-upgrade; suppress the upgrade
    # check (same value the upstream CLI env docs document).
    FABRO_NO_UPGRADE_CHECK = "true";
    # Suppress Segment telemetry for the supervised server; the user shell
    # convention (DO_NOT_TRACK) does not reach launchd agents.
    FABRO_TELEMETRY = "off";
    PATH = servicePath;
  }
  // cfg.environment;

  tomlFormat = pkgs.formats.toml { };

  settingsFile = tomlFormat.generate "fabro-settings.toml" cfg.settings;

  # Server flags shared by the direct and wrapped launchd invocations.
  serverArgs =
    lib.optionals (cfg.bind != null) [
      "--bind"
      cfg.bind
    ]
    ++ lib.optionals (!cfg.web) [ "--no-web" ]
    ++ cfg.extraArgs;

  # Secrets the launchd wrapper resolves from the mcpproxy-routed Keychain
  # layout (see scripts/mcp-secrets-activate.nix) — e.g. the dev-token
  # auth pair. fabro reads them in-process at start-up (dev-token auth
  # refuses to start without SESSION_SECRET / FABRO_DEV_TOKEN), so they
  # must not be passed through the world-readable launchd plist.
  fabroWrapperSecrets = lib.mapAttrsToList (envName: secretName: {
    inherit envName secretName;
  }) cfg.keychainSecrets;
  wrapperResolvesKeychain = fabroWrapperSecrets != [ ];

  # Bash parameter reference defaulting to empty, built by concatenation so
  # the indented wrapper text can interpolate the env-var NAME without the
  # `''` string-from-shell escaping swallowing the `${`.
  envRef = name: "\${" + name + ":-}";

  fabroWrapper = pkgs.writeShellApplication {
    name = "fabro-launchd-wrapper";
    text = ''
      set -eu

      keychain_path=${lib.escapeShellArg keychainPath}

      ${lib.concatMapStringsSep "\n" (
        {
          envName,
          secretName,
        }:
        ''
          if ! ${envName}="$(/usr/bin/security find-generic-password -s mcpproxy -a ${lib.escapeShellArg secretName} -w "$keychain_path" 2>/dev/null)" || [ -z "${envRef envName}" ]; then
            echo "ERROR: ${envName} (${secretName}) unavailable from macOS Keychain; not starting without it." >&2
            echo "  Provision it via the 1Password item declared in home.mcp.keychainSecrets," >&2
            echo "  then refresh the Keychain with a switch and restart:" >&2
            echo "  launchctl kickstart -k gui/\$(id -u)/dev.dwsr.fabro" >&2
            exit 1
          else
            export ${envName}
          fi
        ''
      ) fabroWrapperSecrets}

      exec ${cfg.package}/bin/fabro server start --foreground ${lib.escapeShellArgs serverArgs}
    '';
  };
in
{
  options.programs.fabro = {
    enable = mkEnableOption "the Fabro workflow-engine server launchd user agent";

    package = mkOption {
      type = types.package;
      default = pkgs.fabro;
      defaultText = "pkgs.fabro";
      description = ''
        The fabro package providing the `fabro` binary. Defaults to the
        overlay-provided release package installed on the host.
      '';
    };

    bind = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "127.0.0.1:32276";
      description = ''
        Server listen address passed as `server start --bind`. Null keeps
        fabro's default listen target — a Unix socket at
        `$FABRO_HOME/fabro.sock` — which matches the fabro CLI's default
        server target, so local CLIs reach this service with no extra
        configuration. Set a TCP `IP:port` (or an absolute socket path) to
        expose the API/web UI directly; a TCP bind requires pointing
        `cli.target` at the URL via settings or `--server`.
      '';
    };

    web = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Enable the embedded web UI and browser auth routes in the service.
        Disabled, the service runs with upstream's `--no-web`, which also
        skips the first-run browser install wizard: a service with no
        settings.toml starts headless on fabro's defaults instead of
        opening the wizard. Declaring {option}`settings` keeps the web UI
        usable while skipping the wizard the same way.
      '';
    };

    storageDir = mkOption {
      type = types.path;
      default = "${config.xdg.dataHome}/fabro";
      defaultText = lib.literalExpression ''"''${config.xdg.dataHome}/fabro"'';
      description = ''
        Fabro storage directory (SQLite DB, object store, vaults, cache,
        run scratch), exposed to the service and user shells as
        FABRO_STORAGE_DIR.
      '';
    };

    settings = mkOption {
      inherit (tomlFormat) type;
      default = { };
      example = {
        _version = 1;
        cli = {
          target = {
            type = "http";
            url = "http://127.0.0.1:32276";
          };
        };
      };
      description = ''
        Fabro `settings.toml` contents, written to
        `$FABRO_HOME/settings.toml` at activation when non-empty. When
        empty the module does not manage the file, so `fabro install` /
        `fabro server start` can run upstream's own setup wizard there.

        A settings file that configures `server.auth` changes what the
        server requires at start-up: dev-token auth refuses to start
        without a 64-hex-char SESSION_SECRET and a `fabro_dev_<64 hex>`
        FABRO_DEV_TOKEN, both provided through {option}`environment`. Run
        the upstream wizard once with this option empty to see the
        settings shape it produces.

        Fabro also writes this file at runtime (the wizard records
        `cli.target` on first login); the next home-manager switch
        overwrites those runtime changes with this declared content.
      '';
    };

    path = mkOption {
      type = types.listOf types.package;
      default = [ pkgs.git ];
      defaultText = "pkgs.git";
      description = ''
        Packages prepended to the service PATH before the user's home
        packages and the standard system directories. Mirrors the `git`
        dependency the upstream Docker image installs.
      '';
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Additional command-line arguments appended to `fabro server start
        --foreground` after the bind argument.
      '';
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = ''
        Extra environment variables for the service, merged over the
        module-provided FABRO_* variables. Use this only for non-secret
        values; the launchd plist is world-readable, so auth credentials
        belong in {option}`keychainSecrets`.
      '';
    };

    keychainSecrets = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        SESSION_SECRET = "fabro-session-secret";
        FABRO_DEV_TOKEN = "fabro-dev-token";
      };
      description = ''
        Map of environment variable name → `home.mcp.keychainSecrets`
        entry name for secrets fabro needs at start-up (the dev-token
        auth pair above). The launchd agent execs through a wrapper that
        resolves each entry from the macOS Keychain (service
        `mcpproxy`) and exports it before start, so no secret value
        lands in the Nix store or the agent plist. A missing entry
        aborts the start: dev-token auth refuses to run without the
        pair anyway. Declaring any entries changes the agent's
        ProgramArguments to the wrapper (the wrapper execs fabro with
        the same server flags).
      '';
    };

    _settingsFile = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = ''
        Internal rendered settings file consumed by the activation step and
        tests. Null when settings are not declared.
      '';
    };

    _wrapper = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal launchd wrapper consumed by the agent config and tests.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.optionals (options.home ? mcp) (
      lib.mapAttrsToList (envName: secretName: {
        assertion = builtins.hasAttr secretName config.home.mcp.keychainSecrets;
        message = "programs.fabro.keychainSecrets.${envName} must name a home.mcp.keychainSecrets entry (\"${secretName}\").";
      }) cfg.keychainSecrets
    );

    programs.fabro = {
      _settingsFile = if settingsManaged then settingsFile else null;
      _wrapper = if wrapperResolvesKeychain then fabroWrapper else null;
    };

    home = {
      packages = [ cfg.package ];

      # User shells and the launchd agent must resolve fabro's defaults the
      # same way or the CLI's default unix-socket target will not reach the
      # service. HM sessionVariables cover the shells; the agent gets the
      # same values explicitly below.
      sessionVariables = {
        FABRO_HOME = fabroStateDir;
        FABRO_STORAGE_DIR = toString fabroDataDir;
      };

      # launchd refuses to auto-create StandardOutPath / StandardErrorPath
      # parent directories, and fabro's Docker entrypoint creates FABRO_HOME
      # the same way before start-up.
      activation.fabroState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p ${
          lib.escapeShellArgs [
            fabroStateDir
            (toString fabroDataDir)
            logDir
          ]
        }
        ${lib.optionalString settingsManaged ''
          run install -Dm600 -T "${settingsFile}" ${lib.escapeShellArg settingsPath}
        ''}
      '';
    };

    launchd.agents.fabro = {
      enable = true;
      config = {
        Label = "dev.dwsr.fabro";
        # `server start --foreground` is upstream's documented supervised
        # invocation (the Docker image CMD runs the same): foreground
        # execution with the server daemon record written for
        # `fabro server status` / `fabro server stop`.
        #
        # With keychainSecrets the agent execs through a wrapper that
        # resolves them from the Keychain first; without any it runs the
        # binary directly.
        ProgramArguments =
          if wrapperResolvesKeychain then
            [ "${fabroWrapper}/bin/fabro-launchd-wrapper" ]
          else
            [
              "${cfg.package}/bin/fabro"
              "server"
              "start"
              "--foreground"
            ]
            ++ serverArgs;
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables = serviceEnv;
        StandardOutPath = "${logDir}/fabro.log";
        StandardErrorPath = "${logDir}/fabro.error.log";
      };
    };
  };
}
