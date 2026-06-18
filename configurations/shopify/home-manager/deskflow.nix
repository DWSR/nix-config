_: {
  # ShopifyLaptop Deskflow client enablement.
  #
  # Turns on the shared `home.deskflow` module (home-manager/common/deskflow) in
  # the client role for this host. It connects to the Brandons-MacBook-Pro
  # Deskflow server and trusts that server's cert by fingerprint.
  #
  # tls.certificateFile is intentionally left UNSET, so this client
  # self-generates its own TLS cert and the server keeps interactive trust for it
  # on the first connection. To adopt a managed client identity instead, run
  #     bash scripts/deskflow-generate-cert.sh shopify
  # ON this host, then declare the sops secret and set tls.certificateFile here,
  # and add this host's printed fingerprint to the personal server's
  # home.deskflow.tls.trustedFingerprints. See
  # .kiro/specs/deskflow-config/design.md "Host wiring".
  home.deskflow = {
    enable = true;
    role = "client";

    # The Deskflow server to connect to: the Brandons-MacBook-Pro host, reached by
    # its mDNS/Bonjour name on the local network. Rendered as the client/remoteHost
    # key in Deskflow.conf.
    client.remoteHost = "Brandons-MacBook-Pro.local";

    # Trust the Brandons-MacBook-Pro server's TLS identity by fingerprint, so the
    # first TLS connection needs no interactive approval. This is the SHA-256 of
    # the sops-managed cert on the personal host (secrets/deskflow-cert.personal.yaml);
    # rotating that cert invalidates this value. Rendered read-only to
    # ~/Library/Deskflow/tls/trusted-servers (a client verifies servers).
    tls.trustedFingerprints = [
      "4a9f1514fc4bf5af3dec2f62b272fa84188e4d6554c53146a98fe761d7cf2701"
    ];
  };
}
