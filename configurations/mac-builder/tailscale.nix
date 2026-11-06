{
  config,
  lib,
  pkgs,
  ...
}:
let
  tailscaleAuth = pkgs.callPackage ../../scripts/mac-builder-tailscale-auth.nix { };
  credentialPath = config.sops.secrets."builder-tailscale-oauth-secret".path;
in
{
  services.tailscale.enable = true;
  services.tailscale.package = pkgs.tailscale;

  launchd.daemons.tailscaled.serviceConfig.Label = lib.mkForce "com.tailscale.tailscaled";

  sops.secrets."builder-tailscale-oauth-secret" = {
    path = "/run/secrets/builder-tailscale-oauth-secret";
    mode = "0400";
    owner = "root";
    group = "wheel";
  };

  launchd.daemons.mac-builder-tailscale-auth = {
    serviceConfig = {
      Label = "mac-builder-tailscale-auth";
      ProgramArguments = [
        "${tailscaleAuth}/bin/mac-builder-tailscale-auth"
        "--auth-key-file"
        credentialPath
        "--hostname"
        "mac-builder"
        "--tag"
        "tag:nix-remote-builder"
        "--tailscale"
        (lib.getExe config.services.tailscale.package)
      ];
      RunAtLoad = true;
      KeepAlive = true;
      ThrottleInterval = 30;
      ProcessType = "Background";
      StandardOutPath = "/var/log/mac-builder-tailscale-auth.log";
      StandardErrorPath = "/var/log/mac-builder-tailscale-auth.err";
    };
  };
}
