{ osConfig, ... }:
{
  # Brandons-MacBook-Pro Deskflow server enablement.
  #
  # This host is the Deskflow server: its keyboard/mouse are shared to clients.
  # the host's exported deskflow-server.conf (screens + links + global options).
  # Per-screen options in that export (halfDuplex*, xtestIsXineramaUnaware,
  # switchCorners/switchCornerSize) were all Deskflow defaults and so are omitted;
  # the global switchCorners/switchCornerSize are preserved under server.options.
  #
  # TLS identity: the 4096-bit self-signed cert lives in sops
  # (secrets/deskflow-cert.personal.yaml), declared as the system secret
  # "deskflow-cert" in ../../default.nix (format = "yaml"; key = "data") and
  # decrypted to an owner-only path. It
  # is referenced by path only -- the private key never enters the Nix store.
  home.hammerspoon.deskflowWatchdog.enable = true;

  home.deskflow = {
    enable = true;
    role = "server";
    computerName = "Brandons-MacBook-Pro.local";

    tls = {
      certificateFile = osConfig.sops.secrets."deskflow-cert".path;
      keySize = 4096;

      trustedFingerprints = [ ];
    };

    server = {
      screens = [
        { name = "Brandons-MacBook-Pro.local"; }
      ];

      links = [
        {
        }
      ];

      # Global options, translated from deskflow-server.conf's `section: options`.
      # Values are strings (the schema is attrsOf str); the renderer emits them
      # bare. Order here is cosmetic -- the renderer sorts keys alphabetically.
      options = {
        heartbeat = "1000";
        protocol = "barrier";
        relativeMouseMoves = "false";
        win32KeepForeground = "false";
        defaultLockToScreenState = "false";
        disableLockToScreen = "true";
        clipboardSharing = "true";
        clipboardSharingSize = "102400";
        switchCorners = "none";
        switchCornerSize = "0";
        "keystroke(Control+Shift+j)" = "switchInDirection(up)";
        "keystroke(Control+Shift+k)" = "switchInDirection(down)";
        "keystroke(Control+Shift+h)" = "switchInDirection(left)";
        "keystroke(Control+Shift+l)" = "switchInDirection(right)";
      };
    };
  };
}
