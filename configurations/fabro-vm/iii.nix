# iii engine configuration for the fabro-vm guest (spec
# `iii-engine-on-the-fabro-host`). The engine is loopback-only: the rendered
# YAML declares exactly one lifecycle entry, the `iii-worker-manager`, bound to
# `fabro.iii.host`:`fabro.iii.port` (127.0.0.1:49134 by default). No project
# worker, `configuration`, `iii-stream`, `http-functions`, or `sandbox` entry is
# declared. The systemd unit, the system package, and the `svc:iii` tailnet
# handler are added by later tasks.
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
}
