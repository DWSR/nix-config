# fabro-darwin-machines: render the guest's Nix machines file from the two
# runtime build-trust secrets
# (mac-builder-for-fabro-nix-darwin-builds, task 1.1; design "Component
# Contracts → Guest Dispatch → `fabro-darwin-machines`"; requirements 3.2, 6.1,
# 6.2, 6.6, 6.7, 6.12).
#
# The guest's nix-daemon reads `nix.settings.builders = "@<path>"`, so the file
# must contain one machines line. The pinned builder host key only exists after
# the builder boots, so it cannot be rendered at evaluation time; this script
# runs at boot (and whenever sops rewrites a secret) and writes:
#
#   ssh-ng://<ssh-user>@<host> <system> <client-key-path> <max-jobs> <speed-factor> - - <base64 host key>
#
# Invariants:
#   - the client key is referenced by path only; its value is never read into
#     the line;
#   - the host key field is the base64 of the pinned public key and is never
#     `-`, so SSH cannot fall back to an unpinned known-hosts entry;
#   - the output is replaced atomically (temp file + mv) with mode 0600, so the
#     daemon can never read a partial line;
#   - a missing, unreadable, or empty input fails with exit 1 naming its path
#     and leaves any previous machines file untouched.
{
  pkgs,
  coreutils ? pkgs.coreutils,
}:
pkgs.writeShellApplication {
  name = "fabro-darwin-machines";
  runtimeInputs = [ coreutils ];
  text = ''
    set -euo pipefail

    output_path=""
    host_name=""
    ssh_user=""
    system=""
    max_jobs=""
    speed_factor=""
    client_key_path=""
    host_key_path=""

    usage() {
      cat >&2 <<'USAGE'
    fabro-darwin-machines — render the Fabro Guest's Darwin build machines file

    Usage:
      fabro-darwin-machines --output PATH --host-name HOST --ssh-user USER \
        --system SYSTEM --max-jobs N --speed-factor N \
        --client-key PATH --host-key PATH

    Options:
      --output PATH       Machines file to write (mode 0600)
      --host-name HOST    Builder tailnet name
      --ssh-user USER     Builder user for the ssh-ng session
      --system SYSTEM     System scheduled on the builder (aarch64-darwin)
      --max-jobs N        Concurrent build jobs
      --speed-factor N    Relative builder speed
      --client-key PATH   Build client key path (the value is never read)
      --host-key PATH     Pinned builder host public key
      --help, -h          Show this help
      --version           Show version
    USAGE
    }

    fail() {
      printf 'fabro-darwin-machines: %s\n' "$1" >&2
      exit 1
    }

    usage_error() {
      printf 'fabro-darwin-machines: %s\n' "$1" >&2
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
        --output)
          require_value "$1" "''${2:-}"
          output_path="$2"
          shift 2
          ;;
        --host-name)
          require_value "$1" "''${2:-}"
          host_name="$2"
          shift 2
          ;;
        --ssh-user)
          require_value "$1" "''${2:-}"
          ssh_user="$2"
          shift 2
          ;;
        --system)
          require_value "$1" "''${2:-}"
          system="$2"
          shift 2
          ;;
        --max-jobs)
          require_value "$1" "''${2:-}"
          max_jobs="$2"
          shift 2
          ;;
        --speed-factor)
          require_value "$1" "''${2:-}"
          speed_factor="$2"
          shift 2
          ;;
        --client-key)
          require_value "$1" "''${2:-}"
          client_key_path="$2"
          shift 2
          ;;
        --host-key)
          require_value "$1" "''${2:-}"
          host_key_path="$2"
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        --version)
          printf 'fabro-darwin-machines 0.1.0\n'
          exit 0
          ;;
        *)
          usage_error "unknown argument: $1"
          ;;
      esac
    done

    for required in \
      "$output_path" \
      "$host_name" \
      "$ssh_user" \
      "$system" \
      "$max_jobs" \
      "$speed_factor" \
      "$client_key_path" \
      "$host_key_path"; do
      if [[ -z "$required" ]]; then
        usage_error "all of --output, --host-name, --ssh-user, --system, --max-jobs, --speed-factor, --client-key, and --host-key are required"
      fi
    done

    for value in "$host_name" "$ssh_user" "$system"; do
      if [[ "$value" == *[[:space:]]* ]]; then
        usage_error "host name, SSH user, and system must not contain whitespace: $value"
      fi
    done

    for value in "$max_jobs" "$speed_factor"; do
      case "$value" in
        ""|*[!0-9]*)
          usage_error "max jobs and speed factor must be non-negative integers: $value"
          ;;
      esac
    done
    if [[ "$max_jobs" -lt 1 ]]; then
      usage_error "max jobs must be at least 1: $max_jobs"
    fi
    if [[ "$speed_factor" -lt 1 ]]; then
      usage_error "speed factor must be at least 1: $speed_factor"
    fi

    # Validate both pieces of material before touching the output path, so a
    # failure cannot truncate or replace the machines file the daemon reads.
    require_material() {
      local material_path="$1"
      local label="$2"
      if [[ ! -e "$material_path" ]]; then
        fail "$label is missing: $material_path"
      fi
      if [[ ! -f "$material_path" ]]; then
        fail "$label is not a regular file: $material_path"
      fi
      if [[ ! -r "$material_path" ]]; then
        fail "$label is not readable: $material_path"
      fi
      if [[ ! -s "$material_path" ]]; then
        fail "$label is empty: $material_path"
      fi
    }

    require_material "$client_key_path" "build client key"
    require_material "$host_key_path" "pinned builder host key"

    host_key_base64="$(base64 -w0 -- "$host_key_path")" \
      || fail "pinned builder host key is not readable: $host_key_path"
    if [[ -z "$host_key_base64" ]]; then
      fail "pinned builder host key is empty: $host_key_path"
    fi

    line="ssh-ng://''${ssh_user}@''${host_name} ''${system} ''${client_key_path} ''${max_jobs} ''${speed_factor} - - ''${host_key_base64}"

    output_dir="$(dirname -- "$output_path")"
    if [[ ! -d "$output_dir" ]]; then
      fail "output directory does not exist: $output_dir"
    fi
    if [[ ! -w "$output_dir" ]]; then
      fail "output directory is not writable: $output_dir"
    fi

    tmp_file=""
    cleanup() {
      if [[ -n "$tmp_file" ]]; then
        rm -f -- "$tmp_file"
      fi
    }
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM

    tmp_file="$(mktemp "$output_dir/.fabro-darwin-machines.XXXXXX")" \
      || fail "cannot create a temporary file in: $output_dir"
    printf '%s\n' "$line" > "$tmp_file" \
      || fail "cannot write temporary machines file: $tmp_file"
    chmod 0600 -- "$tmp_file" \
      || fail "cannot set mode 0600 on: $tmp_file"
    # The unit runs as root; make the ownership explicit there and stay
    # runnable for the repository checks, which build as an unprivileged user.
    if [[ "$(id -u)" -eq 0 ]]; then
      chown 0:0 -- "$tmp_file" \
        || fail "cannot set owner root on: $tmp_file"
    fi
    mv -f -- "$tmp_file" "$output_path" \
      || fail "cannot replace machines file: $output_path"
    tmp_file=""
  '';
}
