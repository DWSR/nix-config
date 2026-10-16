# Sandbox image loader for the fabro-vm guest
# (spec `nix-built-container-for-default-fabro-environmen`).
#
# `fabro-sandbox-image-load.service` loads the repo-built OCI archive
# (`fabro.sandboxImage.archive`, see ./sandbox-image.nix) into the guest's
# local rootful Podman store on every switch whose image contents changed,
# verifies the immutable `<name>@<digest>` reference resolves there, and
# records the digest to /run/fabro-sandbox/digest for the environment
# reconciler and the smoke check. The archive and digest store paths are
# interpolated into ExecStart, so a contents change rewrites the unit text
# (systemd reloads the image) while an unchanged image leaves the unit
# untouched. Nothing is pushed: `podman load` reads the local archive and
# the digest reference is checked against the local store only.
#
# `fabro.service` (./fabro.nix) is ordered after and `wants` this unit so
# the image is loaded before Fabro's `default` environment can use it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.sandboxImage;

  # The loader script is parameterised by the image name (baked in at build
  # time); the unit passes the archive and digest store paths positionally.
  loadScript = import ../../scripts/fabro-sandbox-image-load.nix {
    inherit pkgs;
    inherit (cfg) name;
  };
in
{
  systemd.services."fabro-sandbox-image-load" = {
    description = "Load the repo-built Fabro sandbox image into the local Podman store";
    wantedBy = [ "multi-user.target" ];

    # The rootful Podman API socket must be listening before `podman load`;
    # podman.service is socket-activated, so ordering on the socket is
    # sufficient (see ./fabro.nix for the same reasoning).
    after = [ "podman.socket" ];
    requires = [ "podman.socket" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;

      # Owns /run/fabro-sandbox; the script writes the digest there and the
      # reconciler/smoke check read it back.
      RuntimeDirectory = "fabro-sandbox";

      # Both store paths are embedded: a contents change rewrites this unit
      # (reloading the image), an unchanged image leaves it untouched.
      ExecStart = "${lib.getExe loadScript} ${cfg.archive} ${cfg.digest}";
    };
  };
}
