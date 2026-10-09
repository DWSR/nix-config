{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.home.omlx;

  logDir = "${config.home.homeDirectory}/Library/Logs/omlx";
in
{
  options.home.omlx = {
    enable = mkEnableOption "the omlx inference server launchd user agent";

    package = mkOption {
      type = types.package;
      default = pkgs.omlx;
      description = ''
        The omlx package providing the `omlx` server binary. Defaults to the
        overlay-provided package installed on the host.
      '';
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Host the omlx server binds to. Defaults to loopback so the server is
        reachable only from the local opencode provider.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8000;
      description = ''
        Port the omlx server binds to. Defaults to the port opencode's
        `provider.omlx` targets.
      '';
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Additional command-line arguments appended to `omlx serve` after the
        host and port arguments.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # launchd refuses to auto-create StandardOutPath / StandardErrorPath
    # parent directories; ensure ~/Library/Logs/omlx exists before the
    # agent starts.
    home.activation.omlxLogDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p "${logDir}"
    '';

    launchd.agents.omlx = {
      enable = true;
      config = {
        Label = "dev.dwsr.omlx";
        ProgramArguments = [
          "${cfg.package}/bin/omlx"
          "serve"
          "--host"
          cfg.host
          "--port"
          (toString cfg.port)
        ]
        ++ cfg.extraArgs;
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "${logDir}/omlx.log";
        StandardErrorPath = "${logDir}/omlx.error.log";
      };
    };
  };
}
