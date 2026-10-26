{ pkgs }:
pkgs.writeShellApplication {
  name = "mac-builder-deploy";
  runtimeInputs = [
    pkgs.gnutar
    pkgs.gzip
    pkgs.openssh
    pkgs._1password-cli
    pkgs.curl
  ];
  text = ''
    set -euo pipefail

    repo=''${1:-$PWD}

    if [ ! -f "$repo/flake.nix" ] || [ ! -f "$repo/flake.lock" ]; then
      echo "mac-builder-deploy: $repo is not a locked flake (usage: mac-builder-deploy [REPO])" >&2
      exit 1
    fi

    LIMA_HOME=''${LIMA_HOME:-$HOME/.local/state/lima}
    name=mac-builder
    sshConfig="$LIMA_HOME/$name/ssh.config"
    remoteHost="lima-$name"
    scratch=/tmp/mac-builder-deploy

    AGE_KEY_REF=''${MAC_BUILDER_AGE_KEY_REF:-op://Private/sops-age-key-mac-builder/notesPlain}

    remote() {
      ssh -F "$sshConfig" "$remoteHost" "$@"
    }

    if ! ssh -F "$sshConfig" "$remoteHost" true; then
      echo "mac-builder-deploy: connection error: unable to reach $remoteHost via $sshConfig" >&2
      exit 1
    fi

    remote -- "printf '%s\\n' '#!/bin/sh' 'cat \"\$HOME/password\"' > /tmp/mac-builder-askpass && chmod 700 /tmp/mac-builder-askpass"

    remote -- "rm -rf '$scratch' && mkdir -p '$scratch'"

    tar --exclude=.git --exclude=.direnv --exclude=result --exclude='result-*' \
      --exclude=.pre-commit-config.yaml \
      -cf - -C "$repo" . \
      | gzip \
      | remote -- "tar -xzf - -C '$scratch'"

    age_key="$(op read "$AGE_KEY_REF")"
    remote -- "mkdir -p /var/lib/sops-nix"
    printf '%s' "$age_key" | remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A tee /var/lib/sops-nix/key.txt >/dev/null"
    remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A chmod 600 /var/lib/sops-nix/key.txt"

    remote -- "if ! command -v nix >/dev/null 2>&1; then curl -fsSL https://nixos.org/nix/install | sh; fi"

    if remote -- "command -v darwin-rebuild >/dev/null 2>&1"; then
      remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A darwin-rebuild switch --flake '$scratch#mac-builder'"
    else
      remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A nix run github:nix-darwin/nix-darwin/master -- switch --flake '$scratch#mac-builder'"
    fi

    echo "mac-builder-deploy: switched guest to mac-builder; scratch tree left at $scratch."
  '';
}
