{ pkgs, name }:
# fabro-sandbox-smoke: prove the repo-built sandbox image runs in the guest's
# local Podman store and reaches the host Nix store and Nix daemon.
#
# The loader (scripts/fabro-sandbox-image-load.nix) loads the image and records
# its content digest to /run/fabro-sandbox/digest; the reconciler
# (scripts/fabro-sandbox-env-reconcile.nix) points Fabro's `default`
# environment at `<name>@<digest>`. This check is the runtime counterpart: it
# runs the image by digest — proving the immutable reference resolves — and
# probes the things the image and the host-store mounts must provide
# (Requirements 6.3-6.5):
#
#   1. home    — `test -n "$HOME"; test -d "$HOME"; test -w "$HOME"` (Nix
#               resolves its flake registry and fetcher/eval caches under
#               `$HOME`; an empty HOME makes plain `nix` commands fail with
#               `error: not an absolute path:
#               ".cache/nix/flake-registry.json"` and writes caches into the
#               workspace).
#   2. usr-bin-env — `/usr/bin/env` exists and runs (npm-installed bin shims
#               start with `#!/usr/bin/env node` and exit 126 without it,
#               even when the interpreter is installed).
#   3. tools  — `bash --version; git --version; gh --version; python3
#               --version; command -v find; command -v grep; command -v nix;
#               command -v setsid` inside the container (Requirement 6.3: the
#               image's tools run there; `setsid` is what the Fabro sandbox
#               driver requires before it runs a command node, `find`/`grep`
#               are what Pebble (the agent harness) probes for before it
#               builds a session, and python3 is what the DWSR/fabro workflow
#               command nodes run their scripts with).
#   4. agent-tools — `rg --version; awk --version; jq --version; curl
#               --version` (tools workflow agents expect; otherwise they burn
#               turns on `rg: command not found` / `awk: command not found`).
#   5. certs  — `test -s /etc/ssl/certs/ca-bundle.crt` (the image links
#               cacert's bundle into its root and points SSL_CERT_FILE at it,
#               so https clients validate TLS without the guest's /etc/ssl).
#   6. store  — `test -e /nix/store; ls /nix/store` (Requirement 6.4: the
#               read-only host-store bind is present).
#   7. daemon — `nix store ping` (Requirement 6.4: NIX_REMOTE=daemon reaches
#               the bind-mounted host daemon socket).
#   8. nix-registry — `nix registry list` (proves the flake registry resolves
#               to an absolute path, i.e. HOME/XDG_CACHE_HOME are usable).
#
# An optional positional argument overrides the reference; otherwise it
# defaults to `<name>@$(cat /run/fabro-sandbox/digest)`. Set
# FABRO_SANDBOX_SMOKE_NETWORK=1 to additionally run a network-dependent
# `nix shell nixpkgs#hello --command hello` probe. Each step prints a banner
# before it runs, and a failure names the step and exits non-zero so the
# operator can localize the fault. The check is read-only: every probe runs
# `podman run --rm` in a fresh container.
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
    # tools, certs, store, or daemon.
    probe() {
      local step="$1"
      local cmd="$2"
      printf 'fabro-sandbox-smoke: [%s] %s\n' "$step" "$cmd"
      if ! podman run --rm "$ref" /bin/bash -c "$cmd"; then
        printf 'fabro-sandbox-smoke: step %s failed (ref=%s)\n' "$step" "$ref" >&2
        exit 1
      fi
    }

    # shellcheck disable=SC2016 # $HOME expands inside the container.
    probe home 'test -n "$HOME"; test -d "$HOME"; test -w "$HOME"'
    probe usr-bin-env '/usr/bin/env sh -c "exit 0"'
    probe tools 'bash --version; git --version; gh --version; python3 --version; command -v find; command -v grep; command -v nix; command -v setsid'
    probe agent-tools 'rg --version; awk --version; jq --version; curl --version'
    probe certs 'test -s /etc/ssl/certs/ca-bundle.crt'
    probe store 'test -e /nix/store; ls /nix/store'
    probe daemon 'nix store ping'
    probe nix-registry 'nix registry list >/dev/null'

    if [ "''${FABRO_SANDBOX_SMOKE_NETWORK:-}" = "1" ]; then
      probe nix-shell 'nix shell nixpkgs#hello --command hello'
    fi

    printf 'fabro-sandbox-smoke: all steps passed (ref=%s)\n' "$ref"
  '';
}
