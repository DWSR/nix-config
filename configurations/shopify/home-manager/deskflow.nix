_: {
  # ShopifyLaptop Deskflow client enablement.
  #
  # Turns on the shared `home.deskflow` module (home-manager/common/deskflow) in
  # the client role for this host. Three fields are intentionally left UNSET as
  # TODO placeholders; the host still evaluates with them unset:
  #
  #   * client.remoteHost          -- the operator fills this with the Deskflow
  #       server's address. While unset, the module omits the remote-host key
  #       and renders a `; TODO: set home.deskflow.client.remoteHost` line in
  #       Deskflow.conf.
  #   * tls.certificateFile        -- set when adopting managed TLS (an absolute
  #       path, e.g. an osConfig.sops secret). While unset, `security/certificate`
  #       is omitted so Deskflow self-generates its certificate.
  #   * tls.trustedFingerprints    -- set when adopting managed TLS to pre-seed
  #       the trusted-servers file. While empty, the trust file is left unmanaged
  #       so Deskflow's interactive first-connection trust stays intact.
  #
  # See .kiro/specs/deskflow-config/design.md "Host wiring" for the managed-TLS
  # adoption steps.
  home.deskflow = {
    enable = true;
    role = "client";
  };
}
