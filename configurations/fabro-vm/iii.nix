# iii engine configuration for the fabro-vm guest (spec
# `iii-engine-on-the-fabro-host`). The engine is loopback-only: the rendered
# YAML declares exactly one lifecycle entry, the `iii-worker-manager`, bound to
# `fabro.iii.host`:`fabro.iii.port` (127.0.0.1:49134 by default). No project
# worker, `configuration`, `iii-stream`, `http-functions`, or `sandbox` entry is
# declared. This module also supervises the engine as `iii.service`, a
# `DynamicUser` unit whose only writable state is `/var/lib/iii`; the
# `svc:iii` tailnet handler is added by a later task.
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

  # The durable state directory named in `StateDirectory`; the unit's cwd,
  # HOME, and only writable path derive from it so they cannot drift.
  stateDirName = "iii";
  stateDir = "/var/lib/${stateDirName}";
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
    # The only engine process on the guest: a DynamicUser unit started from
    # the pinned store binary with the rendered configuration as a read-only
    # store path. A changed `fabro.iii.config` produces a new `configFile`, so
    # the `ExecStart` hash changes and `switch-to-configuration` restarts the
    # unit. Runtime state lives in `/var/lib/iii` (never the Lima share), and
    # systemd retries an unexpected exit every two seconds until the start
    # limit marks the unit failed with the engine error in the journal.
    systemd.services.iii = {
      description = "iii engine (loopback-only worker manager)";
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = "${lib.getExe config.fabro.iii.package} --config ${config.fabro.iii.configFile} --no-update-check";

        DynamicUser = true;
        StateDirectory = [ stateDirName ];
        WorkingDirectory = stateDir;
        Restart = "always";
        RestartSec = 2;

        # A DynamicUser unit gets no HOME from systemd; the engine keeps its
        # state under the state directory, and telemetry stays off.
        Environment = [
          "HOME=${stateDir}"
          "III_TELEMETRY_ENABLED=false"
        ];

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        ReadWritePaths = [ stateDir ];
      };
    };
  };
}
