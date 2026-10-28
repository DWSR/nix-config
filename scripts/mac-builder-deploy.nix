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
    VM_PASSWORD_REF=''${MAC_BUILDER_VM_PASSWORD_REF:-op://Private/mac-builder vm password/password}

    remote() {
      ssh -F "$sshConfig" "$remoteHost" "$@"
    }

    if ! ssh -F "$sshConfig" "$remoteHost" true; then
      echo "mac-builder-deploy: connection error: unable to reach $remoteHost via $sshConfig" >&2
      exit 1
    fi

    vm_password="$(op read "$VM_PASSWORD_REF")"
    printf '%s' "$vm_password" | remote -- "umask 077 && cat > /tmp/mac-builder-password && printf '%s\\n' '#!/bin/sh' 'cat /tmp/mac-builder-password' > /tmp/mac-builder-askpass && chmod 700 /tmp/mac-builder-askpass"

    remote -- "rm -rf '$scratch' && mkdir -p '$scratch'"

    tar --exclude=.git --exclude=.direnv --exclude=result --exclude='result-*' \
      --exclude=.pre-commit-config.yaml \
      -cf - -C "$repo" . \
      | gzip \
      | remote -- "tar -xzf - -C '$scratch'"

    age_key="$(op read "$AGE_KEY_REF")"
    remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A /usr/bin/install -d -m 0755 -o root -g wheel /var/lib/sops-nix"
    printf '%s' "$age_key" | remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A tee /var/lib/sops-nix/key.txt >/dev/null"
    remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A chmod 600 /var/lib/sops-nix/key.txt"

    remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sh -s" <<'MAC_BUILDER_NIX_VOLUME'
    set -eu

    export SUDO_ASKPASS=/tmp/mac-builder-askpass

    if ! grep -qx nix /etc/synthetic.conf >/dev/null 2>&1; then
      sudo -A /usr/bin/ex -u NONE -n /etc/synthetic.conf <<'EOF'
    :a
    nix
    .
    :x
    EOF
    fi

    /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -t >/dev/null 2>&1 || true
    /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -B >/dev/null 2>&1 || true

    if [ ! -d /nix ]; then
      echo "mac-builder-deploy: failed to create the /nix mountpoint" >&2
      exit 1
    fi

    if ! /usr/sbin/diskutil info -plist "Nix Store" >/dev/null 2>&1; then
      root_disk="$(/usr/sbin/diskutil info -plist / | /usr/bin/plutil -extract ParentWholeDisk raw -)"
      sudo -A /usr/sbin/diskutil apfs addVolume "$root_disk" APFS "Nix Store" -nomount >/dev/null
    fi

    if [ "$(/usr/sbin/diskutil info -plist "Nix Store" | /usr/bin/plutil -extract GlobalPermissionsEnabled raw - 2>/dev/null || true)" != "true" ]; then
      sudo -A /usr/sbin/diskutil enableOwnership "Nix Store" >/dev/null 2>&1 || true
    fi

    sudo -A /usr/bin/install -d -m 0755 -o root -g wheel /usr/local/libexec

    cat <<'MOUNT' | sudo -A /usr/bin/tee /usr/local/libexec/mac-builder-mount-nix >/dev/null
    #!/bin/sh
    set -eu

    label="Nix Store"
    mountpoint=/nix

    i=0
    while ! /usr/sbin/diskutil info -plist "$label" >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -ge 60 ] && exit 1
      sleep 1
    done

    uuid="$(/usr/sbin/diskutil info -plist "$label" | /usr/bin/plutil -extract VolumeUUID raw -)"

    current="$(/usr/sbin/diskutil info -plist "$mountpoint" 2>/dev/null | /usr/bin/plutil -extract VolumeUUID raw - 2>/dev/null || true)"
    [ "$current" = "$uuid" ] && exit 0

    /usr/sbin/diskutil unmount force "$uuid" >/dev/null 2>&1 || true
    dev="$(/usr/sbin/diskutil info -plist "$uuid" | /usr/bin/plutil -extract DeviceNode raw -)"
    exec /sbin/mount_apfs -o noatime,nosuid,owners "$dev" "$mountpoint"
    MOUNT

    sudo -A /bin/chmod 0755 /usr/local/libexec/mac-builder-mount-nix

    cat <<'PLIST' | sudo -A /usr/bin/tee /Library/LaunchDaemons/org.nixos.darwin-store.plist >/dev/null
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>org.nixos.darwin-store</string>
      <key>ProgramArguments</key>
      <array>
        <string>/usr/local/libexec/mac-builder-mount-nix</string>
      </array>
      <key>RunAtLoad</key>
      <true/>
      <key>KeepAlive</key>
      <dict>
        <key>SuccessfulExit</key>
        <false/>
      </dict>
    </dict>
    </plist>
    PLIST

    sudo -A /bin/chmod 0644 /Library/LaunchDaemons/org.nixos.darwin-store.plist

    sudo -A /bin/launchctl bootout system/org.nixos.darwin-store >/dev/null 2>&1 || true
    sudo -A /bin/launchctl bootstrap system /Library/LaunchDaemons/org.nixos.darwin-store.plist
    sudo -A /bin/launchctl kickstart -k system/org.nixos.darwin-store

    i=0
    while [ "$(/usr/sbin/diskutil info -plist /nix 2>/dev/null | /usr/bin/plutil -extract VolumeUUID raw - 2>/dev/null || true)" != "$(/usr/sbin/diskutil info -plist "Nix Store" | /usr/bin/plutil -extract VolumeUUID raw -)" ]; do
      i=$((i + 1))
      [ "$i" -ge 60 ] && { echo "mac-builder-deploy: failed to mount /nix" >&2; exit 1; }
      sleep 1
    done
    MAC_BUILDER_NIX_VOLUME

    remote -- "if [ ! -x /nix/var/nix/profiles/default/bin/nix ]; then curl -fsSL https://nixos.org/nix/install | SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A env NIX_VOLUME_CREATE=0 sh; fi"

    remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sh -s" <<'MAC_BUILDER_ETC_BACKUP'
    set -eu

    if ! id -u nix-builder >/dev/null 2>&1; then
      sudo -A /usr/sbin/sysadminctl -addUser nix-builder -UID 502 -GID 20 -home /Users/nix-builder -shell /bin/bash >/dev/null 2>&1 || true
      if ! id -u nix-builder >/dev/null 2>&1; then
        echo "mac-builder-deploy: failed to create the nix-builder user" >&2
        exit 1
      fi
    fi

    if [ ! -d /Users/nix-builder ]; then
      sudo -A /usr/sbin/createhomedir -c -u nix-builder >/dev/null 2>&1 || true
    fi

    sudo -A /usr/bin/dscl . -create /Users/nix-builder IsHidden 1
    sudo -A /usr/bin/dscl . -create /Users/nix-builder PrimaryGroupID 20
    sudo -A /usr/bin/dscl . -create /Users/nix-builder UserShell /bin/bash

    if [ ! -e /run/current-system ]; then
      for f in /etc/bashrc /etc/zshrc; do
        if [ -f "$f" ] && [ ! -L "$f" ] && grep -q 'nix-daemon.sh' "$f" 2>/dev/null; then
          sudo -A /bin/mv -f "$f" "$f.before-nix-darwin"
        fi
      done
    fi
    MAC_BUILDER_ETC_BACKUP

    if remote -- "test -x /run/current-system/sw/bin/darwin-rebuild"; then
      remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A -H env NIX_CONFIG='experimental-features = nix-command flakes' /run/current-system/sw/bin/darwin-rebuild switch --flake '$scratch#mac-builder'"
    elif remote -- "test -x /nix/var/nix/profiles/default/bin/darwin-rebuild"; then
      remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A -H env NIX_CONFIG='experimental-features = nix-command flakes' /nix/var/nix/profiles/default/bin/darwin-rebuild switch --flake '$scratch#mac-builder'"
    else
      remote -- "SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A -H env NIX_CONFIG='experimental-features = nix-command flakes' /nix/var/nix/profiles/default/bin/nix run github:nix-darwin/nix-darwin/master -- switch --flake '$scratch#mac-builder'"
    fi

    echo "mac-builder-deploy: switched guest to mac-builder; scratch tree left at $scratch."
  '';
}
