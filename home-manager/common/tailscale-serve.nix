{ lib, ... }:
let
  inherit (lib) mkEnableOption mkOption types;

  renderedCommandOpts = {
    options = {
      name = mkOption {
        type = types.str;
        description = ''
          Name of the Tailscale Serve entry represented by this rendered
          command intent.
        '';
      };

      argv = mkOption {
        type = types.listOf types.str;
        description = ''
          Argument vector that a later activation step can pass to the
          configured Tailscale CLI.
        '';
      };
    };
  };
in
{
  options.home.tailscaleServe = {
    enable = mkEnableOption "declarative tailnet-private Tailscale Serve entries";

    cliPath = mkOption {
      type = types.str;
      default = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
      description = ''
        Path to the macOS Tailscale app CLI used by activation-time Serve
        convergence.
      '';
    };

    entries = mkOption {
      type = types.attrsOf types.attrs;
      default = { };
      description = ''
        Named Tailscale Serve entry declarations. Entry shape validation and
        non-empty command rendering are added by later HM Module tasks; the
        empty default keeps the module dormant.
      '';
    };

    _renderedCommands = mkOption {
      type = types.listOf (types.submodule renderedCommandOpts);
      default = [ ];
      internal = true;
      readOnly = true;
      description = ''
        Internal rendered command state consumed by tests and the later
        activation step. Disabled and empty-entry configurations render no
        command intents.
      '';
    };
  };
}
