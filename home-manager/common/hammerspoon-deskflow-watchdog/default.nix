{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.home.hammerspoon.deskflowWatchdog;
  deskflowRole = config.home.deskflow.role;
  validRole = builtins.elem deskflowRole [
    "client"
    "server"
  ];

  snapshotHelper = pkgs.callPackage ./process-snapshot.nix { };
  renderWatchdog = import ./render.nix {
    trustedSnapshotHelper = snapshotHelper;
  };
in
{
  options.home.hammerspoon.deskflowWatchdog.enable = lib.mkEnableOption ''
    Deskflow core recovery through Hammerspoon. Recovery requires
    separate macOS Accessibility grants for Hammerspoon and Deskflow
  '';

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.home.hammerspoon.enable;
        message = "home.hammerspoon.deskflowWatchdog.enable requires home.hammerspoon.enable.";
      }
      {
        assertion = config.home.deskflow.enable;
        message = "home.hammerspoon.deskflowWatchdog.enable requires home.deskflow.enable.";
      }
      {
        assertion = validRole;
        message = "home.hammerspoon.deskflowWatchdog.enable requires home.deskflow.role to be client or server.";
      }
    ];

    home.hammerspoon.extraConfig = lib.mkAfter (
      lib.optionalString validRole (renderWatchdog {
        role = deskflowRole;
        snapshotCommand = "${snapshotHelper}/bin/deskflow-process-snapshot";
      })
    );
  };
}
