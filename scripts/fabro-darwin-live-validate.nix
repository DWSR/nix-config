{ pkgs }:
pkgs.writeShellApplication {
  name = "fabro-darwin-live-validate";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gnused
    pkgs.gawk
    pkgs.nix
    pkgs.openssh
  ];
  text = ''
    set -euo pipefail

    usage() {
      cat <<'USAGE'
    Usage: fabro-darwin-live-validate [--repo PATH] [--guest-switch COMMAND]

    Runs task 5.6 checks against the live mac-builder and fabro Lima guests.
    Builder deployment and guest switching change live systems. Builder deploy
    is confirmation-gated; guest switching requires an explicit reviewed command.

    Options:
      --repo PATH              Repository root (default: current directory)
      --guest-switch COMMAND   Reviewed guest switch command (run via bash -lc)
      --help                   Show this help
    USAGE
    }

    repo="$PWD"
    guest_switch=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --repo)
          [[ -n "''${2:-}" && "$2" != --* ]] || { echo "--repo requires a path" >&2; exit 2; }
          repo="$2"; shift 2 ;;
        --guest-switch)
          [[ -n "''${2:-}" && "$2" != --* ]] || { echo "--guest-switch requires a command" >&2; exit 2; }
          guest_switch="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
      esac
    done

    repo="$(cd "$repo" && pwd)"
    cd "$repo"
    [[ -f flake.nix && -f flake.lock ]] || { echo "not a locked flake: $repo" >&2; exit 2; }
    command -v lima-vmctl >/dev/null || { echo 'lima-vmctl is unavailable; use the host Home Manager environment that manages these VMs.' >&2; exit 1; }
    [[ -n "$guest_switch" ]] || { echo 'Supply --guest-switch with the reviewed guest switch command.' >&2; exit 2; }
    lima_sudo() {
      local instance="$1"
      shift
      if [[ "$instance" == mac-builder ]]; then
        LIMA_HOME="''${LIMA_HOME:-$HOME/.local/state/lima}" lima-vmctl shell "$instance" \
          env SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A "$@"
      else
        LIMA_HOME="''${LIMA_HOME:-$HOME/.local/state/lima}" lima-vmctl shell "$instance" sudo -n "$@"
      fi
    }

    results="''${FABRO_DARWIN_VALIDATION_RESULTS:-$repo/.kiro/specs/mac-builder-for-fabro-nix-darwin-builds/live-validation-5.6.md}"
    mkdir -p "$(dirname "$results")"
    if [[ ! -f "$results" ]]; then
      printf '# Task 5.6 Live Validation\n\n' > "$results"
    fi
    append_evidence() {
      printf '%s\n' "$1" >> "$results"
    }
    tmp="$(mktemp "''${TMPDIR:-/tmp}/fabro-darwin-live-validate.XXXXXX")"
    trap 'rm -f "$tmp" "$tmp.tailscale"' EXIT

    echo 'Step 1/5: deploy and switch mac-builder (live system change)'
    read -r -p 'Deploy mac-builder now with nix run .#mac-builder-deploy? [y/N] ' answer
    case "$answer" in
      y|Y|yes|YES)
        host_op="$(command -v op)"
        nix run .#mac-builder-deploy -- --op-bin "$host_op" "$repo"
        ;;
      *) echo 'Builder deploy was skipped.' >&2; exit 1 ;;
    esac
    append_evidence '- Builder deploy/switch: PASS'

    echo 'Step 2/5: verify builder tailnet membership'
    lima_sudo mac-builder tailscale status --json > "$tmp.tailscale"
    grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"' "$tmp.tailscale"
    grep -q 'tag:nix-remote-builder' "$tmp.tailscale"
    rm -f "$tmp.tailscale"
    append_evidence '- Builder tailnet: Running with tag:nix-remote-builder'
    echo 'Inspect the mac-builder-tailscale-auth LaunchDaemon log and confirm OAuth startup without interactive login.'
    read -r -p 'Did the auth daemon join using its OAuth credential without interactive login? [y/N] ' auth_answer
    case "$auth_answer" in
      y|Y|yes|YES) append_evidence '- Builder OAuth startup: operator confirmed from LaunchDaemon logs' ;;
      *) echo 'OAuth startup was not confirmed.' >&2; exit 1 ;;
    esac

    echo 'Step 3/5: check the existing builder LAN-forward endpoint'
    nix run .#mac-builder-readiness
    append_evidence '- Builder LAN readiness: PASS'

    echo 'Step 4/5: switch fabro guest and verify machines file, daemon, and local Linux build'
    guest="''${FABRO_GUEST_LIMA_NAME:-fabro}"
    daemon_before="$(lima_sudo "$guest" systemctl show --property=ActiveEnterTimestamp --value nix-daemon.service)"
    bash -lc "$guest_switch"
    lima_sudo "$guest" systemctl restart nix-daemon.service
    guest_script=$(cat <<'GUEST'
    set -euo pipefail
    file=/run/fabro-darwin-builders/machines
    test -f "$file" || { echo "Guest machines file is missing: $file" >&2; exit 1; }
    test "$(stat -c '%a' "$file")" = 600
    test "$(wc -l < "$file" | tr -d ' ')" = 1
    grep -q 'aarch64-darwin' "$file"
    systemctl is-active --quiet nix-daemon.service
    daemon_after="$(systemctl show --property=ActiveEnterTimestamp --value nix-daemon.service)"
    test -n "$daemon_after"
    test "$daemon_after" != "$FABRO_DAEMON_BEFORE"
    printf '%s\n' 'derivation { name = "fabro-linux-local-validation"; system = "aarch64-linux"; builder = "/bin/sh"; args = [ "-c" "echo ok > $out" ]; }' > /tmp/fabro-linux-local.nix
    nix build --no-link --impure --expr 'import /tmp/fabro-linux-local.nix'
    GUEST
    )
    lima_sudo "$guest" env FABRO_DAEMON_BEFORE="$daemon_before" bash -c "$guest_script"
    append_evidence '- Guest switch: machines file is 0600 with one Darwin entry; nix-daemon restarted; Linux build passed'

    echo 'Step 5/5: run sandbox Darwin smoke and verify the result in the guest store and sandbox'
    lima_sudo "$guest" fabro-darwin-build-smoke | tee "$tmp"
    store_path="$(sed -n 's/^Darwin build smoke output: //p' "$tmp" | awk 'NF { line = $0 } END { print line }')"
    [[ "$store_path" =~ ^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._=-]+$ ]] || { echo 'Could not extract a valid smoke output path from the sandbox run.' >&2; exit 1; }
    lima_sudo "$guest" nix path-info "$store_path" >/dev/null
    image_digest="$(lima_sudo "$guest" cat /run/fabro-sandbox/digest)"
    [[ "$image_digest" == sha256:* ]] || { echo 'Guest sandbox image digest is missing or invalid.' >&2; exit 1; }
    image_ref="localhost/fabro-sandbox@$image_digest"
    lima_sudo "$guest" podman run --rm "$image_ref" /bin/bash -c "test -e '$store_path'"
    append_evidence "- Sandbox smoke: PASS; guest store contains $store_path and $image_ref resolves it inside a sandbox container"

    echo "Task 5.6 evidence recorded at $results"
  '';
}
