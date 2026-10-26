{
  pkgs,
  openssh ? pkgs.openssh,
  ssh ? openssh,
  nix ? pkgs.nix,
  coreutils ? pkgs.coreutils,
}:
pkgs.writeShellApplication {
  name = "mac-builder-readiness";
  runtimeInputs = [
    ssh
    nix
    coreutils
  ];
  text = ''
    set -euo pipefail

    user="nix-builder"
    host="127.0.0.1"
    port="2222"
    identity="''${HOME}/.ssh/id_ed25519"

    require_value() {
      if [[ -z "''${2:-}" || "''${2:-}" == --* ]]; then
        echo "mac-builder-readiness: $1 requires a value" >&2
        exit 2
      fi
    }

    usage() {
      cat >&2 <<'USAGE'
    mac-builder-readiness — check whether a mac-builder endpoint accepts aarch64-darwin builds

    Usage:
      mac-builder-readiness [--user USER] [--host HOST] [--port PORT] [--identity PATH]

    Options:
      --user USER        SSH user (default: nix-builder)
      --host HOST        Builder host/address (default: 127.0.0.1)
      --port PORT        SSH port (default: 2222)
      --identity PATH    Operator SSH private key (default: $HOME/.ssh/id_ed25519)
      --help, -h         Show this help
      --version          Show version
    USAGE
    }

    version() {
      printf 'mac-builder-readiness 0.1.0\n'
    }

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --user)
          require_value "$1" "''${2:-}"
          user="$2"
          shift 2
          ;;
        --host)
          require_value "$1" "''${2:-}"
          host="$2"
          shift 2
          ;;
        --port)
          require_value "$1" "''${2:-}"
          port="$2"
          shift 2
          ;;
        --identity)
          require_value "$1" "''${2:-}"
          identity="$2"
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        --version)
          version
          exit 0
          ;;
        --*)
          echo "mac-builder-readiness: unknown option: $1" >&2
          exit 2
          ;;
        *)
          echo "mac-builder-readiness: unexpected argument: $1" >&2
          exit 2
          ;;
      esac
    done

    endpoint="ssh-ng://''${user}@''${host}:''${port}"

    echo "mac-builder-readiness: endpoint ''${endpoint}"

    echo "check 1/3: ssh (''${user}@''${host}:''${port})"
    if ssh -i "''${identity}" -p "''${port}" "''${user}@''${host}" true >/dev/null 2>&1; then
      echo "  OK"
    else
      echo "  FAIL"
      echo "mac-builder-readiness: FAILED: ssh" >&2
      exit 1
    fi

    echo "check 2/3: remote builtins.currentSystem == aarch64-darwin"
    remote_system=""
    if ! remote_system="$(ssh -i "''${identity}" -p "''${port}" "''${user}@''${host}" 'nix eval --raw --expr builtins.currentSystem' 2>/dev/null)"; then
      echo "  FAIL (ssh error)"
      echo "mac-builder-readiness: FAILED: currentSystem" >&2
      exit 1
    fi
    if [[ "''${remote_system}" != "aarch64-darwin" ]]; then
      echo "  FAIL (got ''${remote_system})"
      echo "mac-builder-readiness: FAILED: currentSystem" >&2
      exit 1
    fi
    echo "  OK (''${remote_system})"

    echo "check 3/3: nix store ping (''${endpoint})"
    if nix store ping --store "''${endpoint}" >/dev/null 2>&1; then
      echo "  OK"
    else
      echo "  FAIL"
      echo "mac-builder-readiness: FAILED: store-ping" >&2
      exit 1
    fi

    echo "mac-builder-readiness: READY"
  '';
}
