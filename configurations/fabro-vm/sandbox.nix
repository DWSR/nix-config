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
# `fabro.service` (./fabro.nix) is ordered after and `wants` this unit so
# the image is loaded before Fabro's `default` environment can use it.
#
# `fabro-sandbox-env.service` reconciles Fabro's persisted `default`
# environment to the digest the loader recorded (scripts/
# fabro-sandbox-env-reconcile.nix). It is a oneshot ordered after both
# `fabro.service` (the environments API) and the loader (the declared
# digest), and reads `FABRO_DEV_TOKEN` from the sops-rendered `fabro-env`
# file. Running as root, it updates the persisted environment in place
# (never creating a duplicate) and is idempotent when the reference
# already matches.
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

  # The reconciler script is parameterised by the image name (baked in at
  # build time); it reads the digest the loader recorded at run time, so an
  # unchanged image leaves this unit (and the persisted environment)
  # untouched.
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

  # Reconcile Fabro's persisted `default` environment to the digest the loader
  # recorded. `fabro.service` serves the environments API and the loader
  # records /run/fabro-sandbox/digest, so both are hard dependencies (and
  # ordering) of this unit.
  systemd.services."fabro-sandbox-env" = {
    description = "Reconcile the Fabro default environment to the loaded sandbox image digest";
    wantedBy = [ "multi-user.target" ];

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

      # FABRO_DEV_TOKEN comes from the sops-rendered `fabro-env` file (the
      # same template fabro.service loads); the token never enters the Nix
      # store or the image. No User is set, so the unit runs as root.
      EnvironmentFile = config.sops.templates."fabro-env".path;

      # The digest is read at run time from the loader's recorded file, so an
      # unchanged image leaves this unit (and the persisted environment)
      # untouched.
      ExecStart = lib.getExe reconcileScript;
    };
  };
}
