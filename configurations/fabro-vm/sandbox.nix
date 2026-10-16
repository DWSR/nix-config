# Sandbox image loader and environment reconciler for the fabro-vm guest
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
# `fabro-sandbox-env.service` then reconciles Fabro's persisted `default`
# environment to that recorded digest through the environments API
# (scripts/fabro-sandbox-env-reconcile.nix): it reads
# /run/fabro-sandbox/digest at run time, so an unchanged image leaves both
# the unit and the persisted environment untouched. It runs as root (it
# reads the root-only sops `fabro-env` template) and is ordered after both
# fabro.service and the loader, whose state it depends on.
#
# `fabro.service` (./fabro.nix) is ordered after and `wants` the loader so
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

  # The reconciler script forms `<name>@<digest>` from the image name (baked
  # in here) and the digest the loader recorded at run time; the unit passes
  # no arguments and reads the digest from /run/fabro-sandbox/digest.
  reconcileScript = import ../../scripts/fabro-sandbox-env-reconcile.nix {
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

  systemd.services."fabro-sandbox-env" = {
    description = "Reconcile Fabro's persisted `default` environment to the loaded sandbox image digest";
    wantedBy = [ "multi-user.target" ];

    # Hard dependencies: the environments API must be up (fabro.service) and
    # the digest must be recorded (the loader). A missing dependency fails
    # the switch instead of reconciling against stale state.
    after = [
      "fabro.service"
      "fabro-sandbox-image-load.service"
    ];
    requires = [
      "fabro.service"
      "fabro-sandbox-image-load.service"
    ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;

      # Root: the reconciler reads the root-only sops `fabro-env` template
      # and talks to the loopback environments API; the dev token never
      # leaves the guest.
      User = "root";

      # FABRO_DEV_TOKEN from the sops-rendered `fabro-env` template
      # (default.nix). The template's restartUnits restarts fabro.service on
      # rotation; this oneshot re-reads the file on every switch.
      EnvironmentFile = config.sops.templates."fabro-env".path;

      # The digest is read at run time from /run/fabro-sandbox/digest, so an
      # unchanged image leaves this unit (and the persisted environment)
      # untouched.
      ExecStart = "${lib.getExe reconcileScript}";
    };
  };
}
