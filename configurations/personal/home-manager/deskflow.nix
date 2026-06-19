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
  # "deskflow-cert" in ../../default.nix (format = "yaml"; key = "data") and
  # decrypted to an owner-only path. It
  # is referenced by path only -- the private key never enters the Nix store.
  # ShopifyLaptop trusts THIS host's fingerprint via its own trustedFingerprints,
  # and this host pre-trusts ShopifyLaptop's fingerprint below, so the TLS
  # connection is mutually pre-seeded (no interactive approval needed).
  home.deskflow = {
    enable = true;
    role = "server";

    tls = {
      certificateFile = osConfig.sops.secrets."deskflow-cert".path;
      keySize = 4096;

      # Trust the ShopifyLaptop client's TLS identity by fingerprint, so the
      # server accepts it with no interactive approval. This is the SHA-256 of
      # the sops-managed cert on ShopifyLaptop (secrets/deskflow-cert.shopify.yaml);
      # rotating that cert invalidates this value. Rendered read-only to
      # ~/Library/Deskflow/tls/trusted-clients (a server verifies clients).
      trustedFingerprints = [
        "f3296755f00be642cda4cc062c01f5ccaa3dc4ceb9fc16389bddc02b5a589749"
      ];
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
