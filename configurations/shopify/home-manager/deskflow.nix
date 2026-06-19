{ osConfig, ... }:
{
  # ShopifyLaptop Deskflow client enablement.
  #
  # Turns on the shared `home.deskflow` module (home-manager/common/deskflow) in
  # the client role for this host. It connects to the Brandons-MacBook-Pro
  # Deskflow server, presents its own managed TLS identity, and trusts that
  # server's cert by fingerprint. With both hosts' fingerprints pre-seeded, the
  # first TLS connection needs no interactive approval in either direction.
  home.deskflow = {
    enable = true;
    role = "client";

    # The Deskflow server to connect to: the Brandons-MacBook-Pro host, reached by
    # its mDNS/Bonjour name on the local network. Rendered as the client/remoteHost
    # key in Deskflow.conf.
    client.remoteHost = "Brandons-MacBook-Pro.local";

    tls = {
      # This client's managed TLS identity: a 4096-bit self-signed cert in sops
      # (secrets/deskflow-cert.shopify.yaml), declared as the system secret
      # "deskflow-cert" in ../../default.nix and referenced by path only -- the
      # private key never enters the Nix store. Its fingerprint
      # (f3296755...589749) is pre-seeded into the personal SERVER's
      # trustedFingerprints (rendering that server's trusted-clients) so the
      # server accepts this client without an interactive prompt.
      certificateFile = osConfig.sops.secrets."deskflow-cert".path;
      keySize = 4096;

      # Trust the Brandons-MacBook-Pro server's TLS identity by fingerprint, so the
      # first TLS connection needs no interactive approval. This is the SHA-256 of
      # the sops-managed cert on the personal host (secrets/deskflow-cert.personal.yaml);
      # rotating that cert invalidates this value. Rendered read-only to
      # ~/Library/Deskflow/tls/trusted-servers (a client verifies servers).
      trustedFingerprints = [
        "4a9f1514fc4bf5af3dec2f62b272fa84188e4d6554c53146a98fe761d7cf2701"
      ];
    };
  };
}
