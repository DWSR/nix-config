{ pkgs, name }:
# fabro-sandbox-smoke: prove the repo-built sandbox image runs in the guest's
# local Podman store and reaches the host Nix store and Nix daemon.
#
# The loader (scripts/fabro-sandbox-image-load.nix) loads the image and records
# its content digest to /run/fabro-sandbox/digest; the reconciler
# (scripts/fabro-sandbox-env-reconcile.nix) points Fabro's `default`
# environment at `<name>@<digest>`. This check is the runtime counterpart: it
# runs the image by digest — proving the immutable reference resolves — and
# probes the three things the image and the host-store mounts must provide
# (Requirements 6.3-6.5):
#
#   1. tools  — `bash --version; git --version; command -v nix` inside the
#               container (Requirement 6.3: the image's tools run there).
#   2. store  — `test -e /nix/store; ls /nix/store` (Requirement 6.4: the
#               read-only host-store bind is present).
#   3. daemon — `nix store ping` (Requirement 6.4: NIX_REMOTE=daemon reaches
#               the bind-mounted host daemon socket).
#
# An optional positional argument overrides the reference; otherwise it
# defaults to `<name>@$(cat /run/fabro-sandbox/digest)`. Each step prints a
# banner before it runs, and a failure names the step and exits non-zero so the
# operator can localize the fault to tools, store, or daemon. The check is
# read-only: every probe runs `podman run --rm` in a fresh container.
#
# `name` is the image name (fabro.sandboxImage.name) baked in at build time;
# the digest is read at run time, so the check always exercises the image the
# guest just loaded.
pkgs.writeShellApplication {
  name = "fabro-sandbox-smoke";
  runtimeInputs = [
    pkgs.podman
    pkgs.coreutils
  ];
  text = ''
    set -euo pipefail

    digest_file="/run/fabro-sandbox/digest"

    # Optional reference argument; default to the digest the loader recorded.
    # Running by digest (not tag) proves Fabro's immutable reference resolves.
    if [ "$#" -ge 1 ]; then
      ref="$1"
    else
      if [ ! -r "$digest_file" ]; then
        echo "fabro-sandbox-smoke: image reference unavailable: digest file is missing: $digest_file" >&2
        exit 1
      fi
      ref="${name}@$(cat "$digest_file")"
    fi

    # Run one probe inside a fresh container from the image. Print a banner
    # before the probe and name the step on failure so a failure localizes to
    # tools, store, or daemon.
    probe() {
      local step="$1"
      local cmd="$2"
      printf 'fabro-sandbox-smoke: [%s] %s\n' "$step" "$cmd"
      if ! podman run --rm "$ref" /bin/bash -c "$cmd"; then
        printf 'fabro-sandbox-smoke: step %s failed (ref=%s)\n' "$step" "$ref" >&2
        exit 1
      fi
    }

    probe tools 'bash --version; git --version; command -v nix'
    probe store 'test -e /nix/store; ls /nix/store'
    probe daemon 'nix store ping'

    printf 'fabro-sandbox-smoke: all steps passed (ref=%s)\n' "$ref"
  '';
}
