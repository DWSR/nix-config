{ osConfig, ... }:
{
  # Brandons-MacBook-Pro Deskflow server enablement.
  #
  # This host is the Deskflow server: its keyboard/mouse are shared to clients
  # (ShopifyLaptop). The screen layout below is the declarative translation of
  # the host's exported deskflow-server.conf (screens + links + global options).
  # Per-screen options in that export (halfDuplex*, xtestIsXineramaUnaware,
  # switchCorners/switchCornerSize) were all Deskflow defaults and so are omitted;
  # the global switchCorners/switchCornerSize are preserved under server.options.
  #
  # TLS identity: the 4096-bit self-signed cert lives in sops
  # (secrets/deskflow-cert.personal.yaml), declared as the system secret
  # "deskflow-cert" in ../../default.nix and decrypted to an owner-only path. It
  # is referenced by path only -- the private key never enters the Nix store.
  # Client fingerprints are NOT pre-seeded here, so the server keeps Deskflow's
  # interactive first-connection trust for clients; ShopifyLaptop trusts THIS
  # host's fingerprint via its own home.deskflow.tls.trustedFingerprints.
  home.deskflow = {
    enable = true;
    role = "server";

    tls = {
      certificateFile = osConfig.sops.secrets."deskflow-cert".path;
      keySize = 4096;
    };

    server = {
      screens = [
        { name = "Brandons-MacBook-Pro.local"; }
        { name = "ShopifyLaptop.local"; }
      ];

      links = [
        {
          from = "Brandons-MacBook-Pro.local";
          direction = "right";
          to = "ShopifyLaptop.local";
        }
        {
          from = "ShopifyLaptop.local";
          direction = "left";
          to = "Brandons-MacBook-Pro.local";
        }
      ];

      # Global options, translated from deskflow-server.conf's `section: options`.
      # Values are strings (the schema is attrsOf str); the renderer emits them
      # bare. Order here is cosmetic -- the renderer sorts keys alphabetically.
      options = {
        heartbeat = "1500";
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
