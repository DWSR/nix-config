# iii engine configuration for the fabro-vm guest (spec
# `iii-engine-on-the-fabro-host`). The engine is loopback-only: the rendered
# YAML declares exactly one lifecycle entry, the `iii-worker-manager`, bound to
# `fabro.iii.host`:`fabro.iii.port` (127.0.0.1:49134 by default). No project
# worker, `configuration`, `iii-stream`, `http-functions`, or `sandbox` entry is
# declared.
#
# `iii.service` supervises one engine process from the store binary
# (`lib.getExe config.fabro.iii.package`, i.e. `pkgs.iii`) as a DynamicUser:
# no static account, no secret, and no `EnvironmentFile`. The configuration is
# a read-only store path passed via `--config`, so a rendered change alters
# `ExecStart` and `switch-to-configuration` restarts the unit on the new
# config. Runtime state lives in the systemd state directory `/var/lib/iii`
# (never on the `/var/lib/fabro` Lima share), which survives service restarts,
# reboots, and switches. `--no-update-check` disables the engine's update and
# advisory checks and `III_TELEMETRY_ENABLED=false` its telemetry; neither
# changes the listener set. The `svc:iii` tailnet handler is added by a later
# task.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.iii;

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
        by the guest's `iii.service`.
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
    # One supervised engine process: the store binary named by
    # `fabro.iii.package` (`lib.getExe` reads `meta.mainProgram = "iii"`) with
    # the read-only rendered config. No dependency on the tailnet: before
    # registration the engine is reachable on loopback only.
    systemd.services.iii = {
      description = "iii engine (loopback-only worker manager)";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} --config ${cfg.configFile} --no-update-check";

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

        # Restart on any unexpected exit; systemd's default start limit still
        # ends a permanently broken unit in `failed` with the engine error in
        # the journal.
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
