{
  config,
  lib,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.home.hammerspoon.timezoneMenubar;
  render = import ./render.nix;

  timezoneType = types.submodule {
    options = {
      label = mkOption {
        type = types.strMatching ".+";
        description = "Short label shown before this timezone's current time.";
      };

      timeZone = mkOption {
        type = types.strMatching "[A-Za-z0-9_+-]+/[A-Za-z0-9_+.-]+(/[A-Za-z0-9_+.-]+)*";
        description = "IANA timezone identifier, such as `America/Toronto` or `Etc/UTC`.";
      };
    };
  };

  labels = map (timezone: timezone.label) cfg.timezones;
in
{
  options.home.hammerspoon.timezoneMenubar = {
    enable = mkEnableOption "a compact Hammerspoon menubar showing multiple timezones";

    timezones = mkOption {
      type = types.listOf timezoneType;
      default = [ ];
      description = "Ordered timezones displayed in the compact menubar title.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = config.home.hammerspoon.enable;
        message = "home.hammerspoon.timezoneMenubar.enable requires home.hammerspoon.enable.";
      }
      {
        assertion = cfg.timezones != [ ];
        message = "home.hammerspoon.timezoneMenubar.timezones must contain at least one timezone.";
      }
      {
        assertion = builtins.length labels == builtins.length (lib.unique labels);
        message = "home.hammerspoon.timezoneMenubar.timezones labels must be unique.";
      }
    ];

    home.hammerspoon.extraConfig = lib.mkAfter (render cfg.timezones);
  };
}
