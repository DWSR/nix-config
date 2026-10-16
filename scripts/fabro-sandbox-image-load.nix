{ pkgs, name }:
# fabro-sandbox-image-load: load the repo-built sandbox image into the
# guest's local Podman store and record its content digest.
#
# The image (configurations/fabro-vm/sandbox-image.nix) is an OCI
# image-layout archive produced by the pinned `nix-snapshotter`. The
# guest's `fabro-sandbox-image-load.service` runs this script on every
# switch whose image contents changed: the unit's ExecStart passes the
# archive and digest store paths, so a contents change rewrites the unit
# text and systemd reloads the image, while an unchanged image leaves the
# unit untouched.
#
# Arguments (positional; the unit embeds the store paths):
#   1  archive      OCI image-layout tar (fabro.sandboxImage.archive)
#   2  digest-file  file holding the manifest digest "sha256:<hex>"
#                   (fabro.sandboxImage.digest)
#
# `name` is the image name (fabro.sandboxImage.name) baked in at build
# time; Fabro references the loaded image as `<name>@<digest>`.
#
# Behaviour:
#   1. `podman load -i <archive>` into the local store. The archive's ref
#      annotation retains the local `<name>:<tag>` tag.
#   2. Read the declared digest and form the immutable reference
#      `<name>@<digest>`.
#   3. `podman image exists <name>@<digest>`: the OCI-layout load records
#      that digest as the image's RepoDigest, so a divergence fails here
#      (naming the reference) instead of silently referencing a mutable
#      tag.
#   4. Write the digest to /run/fabro-sandbox/digest (mode 0644) for the
#      reconciler and the smoke check.
#
# Nothing is published: `podman load` reads the local archive and the
# digest reference is checked against the local store only, so no registry
# is ever contacted.
pkgs.writeShellApplication {
  name = "fabro-sandbox-image-load";
  runtimeInputs = [
    pkgs.podman
    pkgs.coreutils
  ];
  text = ''
    set -euo pipefail

    if [ "$#" -ne 2 ]; then
      echo "fabro-sandbox-image-load: usage: fabro-sandbox-image-load <archive> <digest-file>" >&2
      exit 2
    fi

    archive="$1"
    digest_file="$2"

    # Load the OCI archive into the local store. The local `<name>:<tag>`
    # tag is retained from the archive's ref annotation.
    if ! podman load -i "$archive"; then
      echo "fabro-sandbox-image-load: podman load failed for archive: $archive" >&2
      exit 1
    fi

    # The digest the archive declares; Fabro references `<name>@<digest>`.
    digest="$(cat "$digest_file")"
    ref="${name}@$digest"

    # Verify the immutable reference resolves in the local store. A
    # failure means the load did not record this digest, so the reference
    # cannot be trusted: fail the unit — and therefore the switch — naming
    # the reference rather than falling back to the mutable tag.
    if ! podman image exists "$ref"; then
      echo "fabro-sandbox-image-load: loaded image does not resolve by digest reference: $ref" >&2
      exit 1
    fi

    # Record the digest for the reconciler and the smoke check. The unit's
    # RuntimeDirectory owns /run/fabro-sandbox; this file is recreated on
    # every boot/switch.
    printf '%s\n' "$digest" > /run/fabro-sandbox/digest
    chmod 0644 /run/fabro-sandbox/digest
  '';
}
