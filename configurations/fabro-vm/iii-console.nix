# iii console on the fabro host: an iii Compose project named `console` whose
# single worker is the pinned `ade` binary (overlays/iii-workers.nix), the web
# UI for the loopback-only engine started by `iii.service` (./iii.nix).
#
# The project is generated as `console/worker-compose.yaml`; the `ade` worker
# is declared as a `path://` container so Compose executes the Nix-pinned
# package directly and never queries the worker registry or downloads an
# artifact at runtime. Compose is started with `--engine` pointing at
# `iii.service`, so it connects to that engine instead of owning a second one,
# and the unit `Requires`/`After` the engine.
#
# ADE binds 127.0.0.1:3113 by default; the explicit `--http-host`/`--http-port`
# flags keep that bind on loopback even if the stored `console` configuration
# entry carries another value. The tailnet reaches the console only through the
# `svc:iii-console` Tailscale Serve handler (./tailscale.nix).
#
# Runtime state lives in the systemd state directory `/var/lib/iii-console`:
# Compose's per-project state (`III_COMPOSE_STATE_DIR`), the copied `console`
# project (so Compose can write `worker-compose.lock` beside the compose
# file), and ADE's workspace data. The generated project directory in the
# store stays read-only.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.iiiConsole;
  stateDir = "iii-console";
  configFormat = pkgs.formats.yaml { };

  # ADE's local seed: the first registration of the `console-ade`
  # configuration entry copies these values; `data_dir` is absolute so the
  # workspace layout does not fall back to the read-only Compose `III_COMPOSE_DIR`.
  adeConfigFile = configFormat.generate "ade-config.yaml" {
    http_host = cfg.host;
    http_port = cfg.port;
    data_dir = "/var/lib/${stateDir}/data/ade";
  };

  composeConfig = {
    namespace = "console";
    containers.ade = {
      worker = "path://.";
      required = true;
      restart = "always";
      startup_timeout = "60s";
      scripts.run = lib.escapeShellArgs [
        (lib.getExe cfg.package)
        "--config"
        (toString adeConfigFile)
        "--url"
        cfg.engineUrl
        "--http-host"
        cfg.host
        "--http-port"
        (toString cfg.port)
      ];
      environment.III_CONSOLE_ONBOARDING_AUTO_OPEN = "false";
    };
  };

  # The project name is the resolved compose-file directory's name, so the
  # generated `console/` directory is what makes this the `console` project.
  project = pkgs.runCommand "iii-console-project" { } ''
    mkdir -p "$out/console"
    cp ${configFormat.generate "worker-compose.yaml" composeConfig} "$out/console/worker-compose.yaml"
  '';

  # Compose writes `worker-compose.lock` beside the compose file, so the
  # project cannot run from the read-only store path. Each start copies the
  # generated `console/` project into the writable state directory.
  runtimeProject = "/var/lib/${stateDir}/console";
in
{
  options.fabro.iiiConsole = {
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.ade;
      description = ''
        Pinned `ade` worker package (the iii console) executed by the
        generated `console` Compose project.
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address the ADE console binds. It must stay a loopback address: the
        guest exposes the console to the tailnet only through the
        `svc:iii-console` Tailscale Serve handler.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3113;
      description = ''
        TCP port the ADE console binds on {option}`fabro.iiiConsole.host`.
      '';
    };

    engineUrl = lib.mkOption {
      type = lib.types.str;
      default = "ws://${config.fabro.iii.host}:${toString config.fabro.iii.port}";
      description = ''
        Existing iii engine WebSocket URL the Compose project connects to.
      '';
    };

    projectDirectory = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = project;
      description = ''
        Read-only store path holding the generated `console` project and its
        `worker-compose.yaml`.
      '';
    };

    composeConfig = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      default = composeConfig;
      description = ''
        Read-only `console` Compose project rendered into
        {option}`fabro.iiiConsole.projectDirectory`.
      '';
    };
  };

  config = {
    systemd.services.iii-console = {
      description = "iii console (ade worker in the console Compose project)";
      wantedBy = [ "multi-user.target" ];
      after = [ "iii.service" ];
      requires = [ "iii.service" ];
      # Restart the console when the engine is restarted (a plain Requires
      # stops the console with the engine but does not bring it back).
      partOf = [ "iii.service" ];
      # A bounded start limit ends a permanently broken project in `failed`
      # instead of retrying forever at RestartSec=2.
      unitConfig.StartLimitIntervalSec = 120;
      unitConfig.StartLimitBurst = 5;
      # Compose keeps the project lock beside the compose file, so copy the
      # read-only generated project into the state directory first.
      preStart = ''
        ${lib.getExe' pkgs.coreutils "rm"} -rf ${runtimeProject}
        ${lib.getExe' pkgs.coreutils "cp"} -r ${cfg.projectDirectory}/console ${runtimeProject}
      '';
      serviceConfig = {
        # Compose does not send sd_notify readiness; it starts its workers and
        # supervises them as child processes.
        Type = "simple";
        ExecStart = lib.escapeShellArgs [
          (lib.getExe config.fabro.iii.package)
          "compose"
          "--engine"
          cfg.engineUrl
          "--namespace"
          "console"
          "--up"
          "-f"
          "${runtimeProject}/worker-compose.yaml"
        ];

        DynamicUser = true;
        StateDirectory = [ stateDir ];
        WorkingDirectory = "/var/lib/${stateDir}";

        # Compose reads its state root from III_COMPOSE_STATE_DIR; ADE inherits
        # HOME and writes its workspace under data_dir (see adeConfigFile).
        Environment = [
          "HOME=/var/lib/${stateDir}"
          "III_COMPOSE_STATE_DIR=/var/lib/${stateDir}"
          "III_TELEMETRY_ENABLED=false"
        ];

        Restart = "always";
        RestartSec = 2;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        ReadWritePaths = [ "/var/lib/${stateDir}" ];
      };
    };
  };
}
