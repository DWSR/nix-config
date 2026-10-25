{ pkgs, name }:
# fabro-sandbox-image-keep: pin the loaded sandbox image in the local Podman
# store with a running container.
#
# The guest's hourly store reaper (`virtualisation.podman.autoPrune` →
# `podman system prune -f -a --volumes`) removes every image not referenced
# by a *running* container. The loaded sandbox image is only referenced
# transiently while Fabro creates a sandbox container, so between runs the
# reaper deletes it; the next run's docker provider then treats
# `<name>@<digest>` as missing, tries to pull it from the nonexistent
# `localhost` registry, and fails with `docker error [500]: pulling image`.
#
# This script runs one trivial long-lived container from the loaded image, so
# the digest reference Fabro resolves is pinned in the store exactly like any
# other in-use image. The container is removed (`--rm`) whenever the client
# exits, and the keeper unit's `ExecStart` embeds the digest store path, so an
# image contents change restarts the keeper on the new digest.
#
# Arguments (positional; the unit embeds the digest store path):
#   1  digest-file  file holding the manifest digest "sha256:<hex>"
#                   (fabro.sandboxImage.digest)
#
# `name` is the image name (fabro.sandboxImage.name) baked in at build time.
# The image is never pulled (`--pull=never`): a missing image fails the unit
# naming the reference instead of contacting a registry.
pkgs.writeShellApplication {
  name = "fabro-sandbox-image-keep";
  runtimeInputs = [
    pkgs.podman
    pkgs.coreutils
  ];
  text = ''
    set -euo pipefail

    if [ "$#" -ne 1 ]; then
      echo "fabro-sandbox-image-keep: usage: fabro-sandbox-image-keep <digest-file>" >&2
      exit 2
    fi

    digest_file="$1"

    if [ ! -r "$digest_file" ]; then
      echo "fabro-sandbox-image-keep: declared digest file is missing: $digest_file" >&2
      exit 1
    fi

    ref="${name}@$(cat "$digest_file")"

    # The loader ran first; a missing image here would make every future
    # sandbox run fail, so fail the unit (loudly) instead of pulling.
    if ! podman image exists "$ref"; then
      echo "fabro-sandbox-image-keep: loaded image does not resolve by digest reference: $ref" >&2
      exit 1
    fi

    # Remove a stale keeper (e.g. left behind when a previous client was
    # killed before its `--rm` could run) so `podman run` cannot hit a name
    # conflict.
    podman rm --force --ignore fabro-sandbox-image-keep >/dev/null

    # Run in the foreground so systemd supervises the container; `--rm`
    # removes it when the unit stops, and `exec` keeps signal delivery direct.
    #
    # The payload is bash with an explicit TERM trap, not `sleep` directly:
    # as container PID 1, `sleep` never installs a handler, and the kernel
    # discards default-disposition signals aimed at PID 1, so a forwarded
    # SIGTERM (podman's signal proxy on unit stop) would be silently ignored.
    # The trap makes the stop path clean; `wait` is interruptible so the trap
    # runs immediately.
    exec podman run --rm --name fabro-sandbox-image-keep --pull=never \
      --label dev.fabro.sandbox.keep=true \
      "$ref" /bin/bash -c "trap 'exit 0' TERM; sleep infinity & wait"
  '';
}
