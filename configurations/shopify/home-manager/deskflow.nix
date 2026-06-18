_: {
  # ShopifyLaptop Deskflow client enablement.
  #
  # Turns on the shared `home.deskflow` module (home-manager/common/deskflow) in
  # the client role for this host. It connects to the Brandons-MacBook-Pro
  # Deskflow server and trusts that server's cert by fingerprint.
  #
  # Two fields are still intentionally left UNSET as TODO placeholders; the host
  # evaluates with them unset:
  #
  #   * client.remoteHost          -- the operator fills this with the Deskflow
  #       server's address (the Brandons-MacBook-Pro host on the network) so the
  #       client knows where to connect. While unset, the module omits the
  #       remote-host key and renders a `; TODO: set home.deskflow.client.remoteHost`
  #       line in Deskflow.conf, so the client will not connect until it is set.
  #   * tls.certificateFile        -- left unset, so this client self-generates
  #       its own TLS cert. The server keeps interactive trust for clients, so a
  #       managed client cert is not required for the first connection.
  #
  # See .kiro/specs/deskflow-config/design.md "Host wiring" for the managed-TLS
  # adoption steps.
  home.deskflow = {
    enable = true;
    role = "client";

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
