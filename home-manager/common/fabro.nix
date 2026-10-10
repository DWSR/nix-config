{
  config,
  lib,
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
        module-provided FABRO_* variables. Use this for provider API keys
        and other secrets the server must carry into runs.
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
  };

  config = lib.mkIf cfg.enable {
    programs.fabro._settingsFile = if settingsManaged then settingsFile else null;

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
        ProgramArguments = [
          "${cfg.package}/bin/fabro"
          "server"
          "start"
          "--foreground"
        ]
        ++ lib.optionals (cfg.bind != null) [
          "--bind"
          cfg.bind
        ]
        ++ lib.optionals (!cfg.web) [ "--no-web" ]
        ++ cfg.extraArgs;
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables = serviceEnv;
        StandardOutPath = "${logDir}/fabro.log";
        StandardErrorPath = "${logDir}/fabro.error.log";
      };
    };
  };
}
