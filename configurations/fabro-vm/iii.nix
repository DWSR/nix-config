# iii engine configuration for the fabro-vm guest (spec
# `iii-engine-on-the-fabro-host`). The engine is loopback-only: the rendered
# YAML declares exactly one lifecycle entry, the `iii-worker-manager`, bound to
# `fabro.iii.host`:`fabro.iii.port` (127.0.0.1:49134 by default). No project
# worker, `configuration`, `iii-stream`, `http-functions`, or `sandbox` entry is
# declared.
#
# `iii.service` supervises one engine process from the store binary
# (`lib.getExe config.fabro.iii.package`, i.e. `pkgs.iii`) under the local
# `iii-supervisor`: the supervisor is the unit's main process, preflight-binds
# `fabro.iii.host`:`fabro.iii.port`, spawns the engine as its child, and only
# reports readiness (systemd `Type=notify` with `NotifyAccess=main`) after the
# child owns the listener. It sends watchdog keep-alives while the engine runs
# and forwards SIGTERM with a bounded SIGKILL escalation. The unit still runs as
# a DynamicUser: no static account, no secret, and no `EnvironmentFile`. The
# configuration is a read-only store path passed via `--config`, so a rendered
# change alters `ExecStart` and `switch-to-configuration` restarts the unit on
# the new config. Runtime state lives in the systemd state directory
# `/var/lib/iii` (never on the `/var/lib/fabro` Lima share), which survives
# service restarts, reboots, and switches. `--no-update-check` disables the
# engine's update and advisory checks and `III_TELEMETRY_ENABLED=false` its
# telemetry; neither changes the listener set. The `svc:iii` tailnet handler is
# added by a later task.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.iii;

  # The unit's main process: a repository-owned Rust supervisor that owns the
  # readiness gate, the systemd watchdog, and signal forwarding, and spawns the
  # engine as its direct child.
  supervisorPackage = pkgs.rustPlatform.buildRustPackage {
    pname = "iii-supervisor";
    version = "0.1.0";
    src = lib.cleanSource ./iii-supervisor;
    cargoLock.lockFile = ./iii-supervisor/Cargo.lock;
    meta = {
      description = "Readiness-gated systemd supervisor for the iii engine";
      mainProgram = "iii-supervisor";
    };
  };

  # The single source of the rendered configuration: one worker-manager entry
  # whose listener is derived from the host/port options, so an operator
  # changes the bind in one place.
  defaultConfig = {
    workers = [
      {
        name = "iii-worker-manager";
        config = {
          inherit (cfg) host port;
        };
      }
    ];
  };

  configFormat = pkgs.formats.yaml { };
in
{
  options.fabro.iii = {
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii;
      description = ''
        Pinned iii engine package rendered by this configuration and executed
        as the child of the guest's `iii-supervisor`.
      '';
    };

    supervisorPackage = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = supervisorPackage;
      description = ''
        Read-only local `iii-supervisor` package built from
        `configurations/fabro-vm/iii-supervisor/`. It is the main process of
        `iii.service` and spawns {option}`fabro.iii.package`.
      '';
    };

    watchdogSec = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = ''
        systemd `WatchdogSec` interval. The supervisor sends `WATCHDOG=1` at
        half this interval while the engine child runs; a missed deadline makes
        systemd restart the unit.
      '';
    };

    readinessTimeoutSec = lib.mkOption {
      type = lib.types.ints.positive;
      default = 15;
      description = ''
        Seconds the supervisor waits for the engine child to own
        {option}`fabro.iii.host`:{option}`fabro.iii.port` before it kills the
        child and fails the start.
      '';
    };

    stopTimeoutSec = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10;
      description = ''
        Seconds the supervisor waits after forwarding SIGTERM before it sends
        SIGKILL to the engine child.
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address the worker manager binds. It must stay a loopback address:
        the guest exposes the engine to the tailnet only through the
        `svc:iii` Tailscale Serve handler.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 49134;
      description = ''
        TCP port the worker manager binds on {option}`fabro.iii.host`.
      '';
    };

    config = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      default = defaultConfig;
      description = ''
        Read-only rendered engine configuration: exactly one
        `iii-worker-manager` lifecycle entry derived from
        {option}`fabro.iii.host` and {option}`fabro.iii.port`. It declares no
        project worker.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = configFormat.generate "iii-config.yaml" cfg.config;
      description = ''
        Read-only Nix store path of the YAML rendered from
        {option}`fabro.iii.config`.
      '';
    };
  };

  config = {
    # One supervised engine process: the supervisor named by
    # `fabro.iii.supervisorPackage` is the unit's main process; it receives the
    # loopback listen address and the timeouts, then spawns the store engine
    # named by `fabro.iii.package` (`lib.getExe` reads
    # `meta.mainProgram = "iii"`) with the read-only rendered config. No
    # dependency on the tailnet: before registration the engine is reachable on
    # loopback only.
    systemd.services.iii = {
      description = "iii engine (loopback-only, readiness-gated by iii-supervisor)";
      wantedBy = [ "multi-user.target" ];
      # A bounded start limit is explicit: with the required RestartSec=2 the
      # default 5-starts-per-10s window sits exactly at the restart rate and
      # resets instead of tripping, so a permanently broken start would retry
      # forever instead of reaching `failed`. The wider window keeps
      # Restart=always for transient exits while still ending a permanently
      # broken unit in `failed` with the error in the journal.
      unitConfig.StartLimitIntervalSec = 120;
      unitConfig.StartLimitBurst = 5;
      serviceConfig = {
        # Readiness is explicit: only the supervisor may notify, and it sends
        # READY=1 after the engine child owns the loopback listener. The finite
        # watchdog and start/stop timeouts bound a hung start, a dead
        # supervisor, and a slow child shutdown.
        Type = "notify";
        NotifyAccess = "main";
        WatchdogSec = toString cfg.watchdogSec;
        TimeoutStartSec = toString (cfg.readinessTimeoutSec * 2);
        TimeoutStopSec = toString (cfg.stopTimeoutSec * 2);

        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.supervisorPackage)
          "--listen"
          "${cfg.host}:${toString cfg.port}"
          "--ready-timeout"
          (toString cfg.readinessTimeoutSec)
          "--stop-timeout"
          (toString cfg.stopTimeoutSec)
          "--"
          (lib.getExe cfg.package)
          "--config"
          (toString cfg.configFile)
          "--no-update-check"
        ];

        # Dynamic identity: no static account is declared anywhere, and the
        # state directory is the only writable path systemd creates for it.
        DynamicUser = true;
        StateDirectory = [ "iii" ];
        WorkingDirectory = "/var/lib/iii";

        # A DynamicUser gets no $HOME from systemd; the engine writes its
        # runtime state under the same state directory. Telemetry is off.
        Environment = [
          "HOME=/var/lib/iii"
          "III_TELEMETRY_ENABLED=false"
        ];

        # Restart on any unexpected exit; the explicit start limit above still
        # ends a permanently broken unit in `failed` with the error in the
        # journal.
        Restart = "always";
        RestartSec = 2;

        # Hardening in the fabro-service style. StateDirectory already
        # implies the state-dir write path; ReadWritePaths is kept explicit
        # for legibility.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        ReadWritePaths = [ "/var/lib/iii" ];
      };
    };
  };
}
