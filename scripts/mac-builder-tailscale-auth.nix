# mac-builder-tailscale-auth: join the Builder Host to the tailnet under
# launchd and re-authenticate when the session is lost
# (mac-builder-for-fabro-nix-darwin-builds, task 2.1; design "Component
# Contracts → Builder Host → `mac-builder-tailscale-auth`"; requirements 4.1,
# 4.3, 4.8, 4.9, 4.10, 4.11).
#
# Every iteration:
#   1. verifies the root-only OAuth credential file is present and non-empty;
#   2. reads `tailscale status --json` and inspects `BackendState`;
#   3. does nothing when Running, or runs `tailscale up` with the credential,
#      the dedicated tag, the hostname, and DNS disabled for
#      NeedsLogin | NeedsMachineAuth | Stopped.
#
# The credential is read on every poll, so rotating the secret or logging the
# node out re-authenticates without an operator. A missing credential always
# fails the iteration before `tailscale up` is ever considered. Default mode
# repeats forever (launchd KeepAlive); `--once` performs a single iteration and
# exits non-zero unless the node is Running or the re-authentication succeeded.
{
  pkgs,
  coreutils ? pkgs.coreutils,
  jq ? pkgs.jq,
}:
pkgs.writeShellApplication {
  name = "mac-builder-tailscale-auth";
  runtimeInputs = [
    coreutils
    jq
  ];
  text = ''
    set -euo pipefail

    auth_key_file=""
    hostname=""
    tag=""
    tailscale_bin=""
    interval=60
    once=0

    usage() {
      cat >&2 <<'USAGE'
    mac-builder-tailscale-auth — join the Builder Host to the tailnet under launchd

    Usage:
      mac-builder-tailscale-auth --auth-key-file PATH --hostname NAME --tag TAG \
        --tailscale PATH [--interval SECONDS] [--once]

    Options:
      --auth-key-file PATH  Root-only Tailscale OAuth credential file
      --hostname NAME       Tailnet machine name for this node
      --tag TAG             Dedicated builder tag (tag:mac-builder)
      --tailscale PATH      tailscale executable
      --interval SECONDS    Delay between iterations (default: 60)
      --once                Perform one iteration, then exit
      --help, -h            Show this help
      --version             Show version
    USAGE
    }

    log() {
      printf 'mac-builder-tailscale-auth: %s\n' "$*" >&2
    }

    usage_error() {
      printf 'mac-builder-tailscale-auth: %s\n' "$1" >&2
      usage
      exit 2
    }

    require_value() {
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        usage_error "$1 requires a value"
      fi
    }

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --auth-key-file)
          require_value "$1" "''${2:-}"
          auth_key_file="$2"
          shift 2
          ;;
        --hostname)
          require_value "$1" "''${2:-}"
          hostname="$2"
          shift 2
          ;;
        --tag)
          require_value "$1" "''${2:-}"
          tag="$2"
          shift 2
          ;;
        --tailscale)
          require_value "$1" "''${2:-}"
          tailscale_bin="$2"
          shift 2
          ;;
        --interval)
          require_value "$1" "''${2:-}"
          interval="$2"
          shift 2
          ;;
        --once)
          once=1
          shift
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        --version)
          printf 'mac-builder-tailscale-auth 0.1.0\n'
          exit 0
          ;;
        *)
          usage_error "unknown argument: $1"
          ;;
      esac
    done

    for required in "$auth_key_file" "$hostname" "$tag" "$tailscale_bin"; do
      if [[ -z "$required" ]]; then
        usage_error "all of --auth-key-file, --hostname, --tag, and --tailscale are required"
      fi
    done

    case "$interval" in
      ""|*[!0-9]*)
        usage_error "interval must be a positive integer: $interval"
        ;;
    esac
    if [[ "$interval" -lt 1 ]]; then
      usage_error "interval must be at least 1: $interval"
    fi

    if [[ ! -x "$tailscale_bin" ]]; then
      log "tailscale executable is not runnable: $tailscale_bin"
      exit 1
    fi

    # The credential must be checked before any `tailscale up` decision. The
    # message always names the runtime path, never the credential value.
    require_credential() {
      if [[ ! -e "$auth_key_file" ]]; then
        log "tailnet OAuth credential is missing: $auth_key_file"
        return 1
      fi
      if [[ ! -f "$auth_key_file" ]]; then
        log "tailnet OAuth credential is not a regular file: $auth_key_file"
        return 1
      fi
      if [[ ! -r "$auth_key_file" ]]; then
        log "tailnet OAuth credential is not readable: $auth_key_file"
        return 1
      fi
      if [[ ! -s "$auth_key_file" ]]; then
        log "tailnet OAuth credential is empty: $auth_key_file"
        return 1
      fi
    }

    read_backend_state() {
      local output state
      if ! output="$("$tailscale_bin" status --json 2>&1)"; then
        log "tailscale status failed: $output"
        return 1
      fi
      if ! state="$(printf '%s' "$output" | jq -er '.BackendState // empty' 2>/dev/null)"; then
        log "tailscale status returned no usable BackendState"
        return 1
      fi
      printf '%s\n' "$state"
    }

    authenticate() {
      local state="$1"
      local auth_key
      auth_key="$(tr -d '\r\n' < "$auth_key_file")"
      if [[ -z "$auth_key" ]]; then
        log "tailnet OAuth credential is empty: $auth_key_file"
        return 1
      fi
      log "BackendState=''${state}; joining the tailnet as ''${hostname} (''${tag})"
      if ! "$tailscale_bin" up \
        "--auth-key=''${auth_key}?ephemeral=false&preauthorized=true" \
        "--advertise-tags=''${tag}" \
        "--hostname=''${hostname}" \
        "--accept-dns=false"; then
        log "tailscale up failed while re-authenticating as ''${hostname}"
        return 1
      fi
    }

    run_iteration() {
      require_credential || return 1

      local state
      if ! state="$(read_backend_state)"; then
        return 1
      fi

      case "$state" in
        Running)
          log "tailnet is running as ''${hostname}"
          return 0
          ;;
        NeedsLogin|NeedsMachineAuth|Stopped)
          authenticate "$state"
          ;;
        *)
          log "unexpected BackendState: ''${state}"
          return 1
          ;;
      esac
    }

    if [[ "$once" -eq 1 ]]; then
      if run_iteration; then
        exit 0
      fi
      exit 1
    fi

    while true; do
      if ! run_iteration; then
        log "iteration failed; retrying in ''${interval}s"
      fi
      sleep "$interval"
    done
  '';
}
