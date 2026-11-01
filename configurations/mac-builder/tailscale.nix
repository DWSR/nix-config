# Builder Host tailnet membership: put `mac-builder` on the tailnet as its own
# tagged node with the open-source client, and keep it joined under launchd
# (mac-builder-for-fabro-nix-darwin-builds, task 2.2; design "Component
# Contracts → Builder Host → Builder Tailnet Membership"; requirements 3.5,
# 3.7, 3.8, 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.12, 4.13, 4.14, 6.5).
#
# The builder is an ordinary nix-darwin node: `services.tailscale` installs the
# open-source `pkgs.tailscale` and declares the stock
# `com.tailscale.tailscaled` LaunchDaemon. Nothing here uses the macOS app,
# `tailscale serve`, or Tailscale SSH, so the tailnet only decides
# reachability and the build session still authenticates with the pinned SSH
# keys.
#
# nix-darwin exposes no auth-key option, so a dedicated LaunchDaemon runs
# `mac-builder-tailscale-auth` (task 2.1) with the root-only OAuth credential
# at its runtime path. The credential is read from `secrets/remote-builder.mac-builder.yaml`
# — a different OAuth client from the guest's, in the builder's own store — and
# is never rendered into the Nix store. A missing or empty credential makes the
# wrapper log that path and retry without ever running `tailscale up`.
#
# The node joins directly (not through the personal host) and stays a
# nix-darwin host with no Home Manager configuration.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # Build the wrapper from the repository source so the daemon runs exactly the
  # version checked by tests/fabro-darwin-builds/tailscale-auth.test.js.
  authWrapper = pkgs.callPackage ../../scripts/mac-builder-tailscale-auth.nix { };

  credentialPath = config.sops.secrets."builder-tailscale-oauth-secret".path;
in
{
  # Default open-source client; `pkgs.tailscale` also installs the stock
  # `com.tailscale.tailscaled` LaunchDaemon (RunAtLoad) used by this node.
  services.tailscale.enable = true;

  # Root-only runtime path, declared in the builder's own sops store. This is
  # the only tailnet credential on the host: the guest's
  # `tailscale-oauth-secret` lives in the fabro store and is never read here.
  sops.secrets."builder-tailscale-oauth-secret" = {
    mode = "0400";
    owner = "root";
    group = "wheel";
  };

  launchd.daemons.mac-builder-tailscale-auth = {
    # Read the credential path and the builder tag into the wrapper; the wrapper
    # emits `tailscale up ... --accept-dns=false` itself and never enables SSH.
    command = lib.escapeShellArgs [
      (lib.getExe authWrapper)
      "--auth-key-file"
      credentialPath
      "--hostname"
      "mac-builder"
      "--tag"
      "tag:mac-builder"
      "--tailscale"
      (lib.getExe' config.services.tailscale.package "tailscale")
    ];

    serviceConfig = {
      RunAtLoad = true;
      KeepAlive = true;
      # Re-authentication is worth retrying on its own cadence, but not in a
      # tight loop while tailscaled is still starting.
      ThrottleInterval = 30;
      ProcessType = "Background";
      StandardOutPath = "/var/log/mac-builder-tailscale-auth.log";
      StandardErrorPath = "/var/log/mac-builder-tailscale-auth.err.log";
    };
  };
}
