{ pkgs }:
pkgs.writeShellApplication {
  name = "fabro-darwin-machines";
  runtimeInputs = [ pkgs.coreutils pkgs.findutils ];
  text = ''
    set -euo pipefail

    output=""
    host_name=""
    ssh_user=""
    system=""
    max_jobs=""
    speed_factor=""
    client_key=""
    host_key=""
    linux_host_name=""
    linux_ssh_user=""
    linux_system=""
    linux_max_jobs=""
    linux_speed_factor=""
    linux_client_key=""
    linux_host_key=""

    usage() {
      cat >&2 <<'USAGE'
    Usage: fabro-darwin-machines --output PATH --host-name HOST --ssh-user USER \\
      --system SYSTEM --max-jobs N --speed-factor N --client-key PATH --host-key PATH \\
      --linux-host-name HOST --linux-ssh-user USER --linux-system SYSTEM \\
      --linux-max-jobs N --linux-speed-factor N --linux-client-key PATH --linux-host-key PATH
    USAGE
    }

    require_value() {
      if [[ -z "''${2:-}" || "''${2:-}" == --* ]]; then
        echo "fabro-darwin-machines: $1 requires a value" >&2
        exit 2
      fi
    }

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --output|--host-name|--ssh-user|--system|--max-jobs|--speed-factor|--client-key|--host-key|\
        --linux-host-name|--linux-ssh-user|--linux-system|--linux-max-jobs|--linux-speed-factor|\
        --linux-client-key|--linux-host-key)
          require_value "$1" "''${2:-}"
          case "$1" in
            --output) output="$2" ;;
            --host-name) host_name="$2" ;;
            --ssh-user) ssh_user="$2" ;;
            --system) system="$2" ;;
            --max-jobs) max_jobs="$2" ;;
            --speed-factor) speed_factor="$2" ;;
            --client-key) client_key="$2" ;;
            --host-key) host_key="$2" ;;
            --linux-host-name) linux_host_name="$2" ;;
            --linux-ssh-user) linux_ssh_user="$2" ;;
            --linux-system) linux_system="$2" ;;
            --linux-max-jobs) linux_max_jobs="$2" ;;
            --linux-speed-factor) linux_speed_factor="$2" ;;
            --linux-client-key) linux_client_key="$2" ;;
            --linux-host-key) linux_host_key="$2" ;;
          esac
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        --*)
          echo "fabro-darwin-machines: unknown option: $1" >&2
          usage
          exit 2
          ;;
        *)
          echo "fabro-darwin-machines: unexpected argument: $1" >&2
          usage
          exit 2
          ;;
      esac
    done

    for option in \
      output host-name ssh-user system max-jobs speed-factor client-key host-key \
      linux-host-name linux-ssh-user linux-system linux-max-jobs linux-speed-factor linux-client-key linux-host-key; do
      variable="''${option//-/_}"
      if [[ -z "''${!variable}" ]]; then
        echo "fabro-darwin-machines: --$option is required" >&2
        usage
        exit 2
      fi
    done

    for key_path in "$client_key" "$host_key" "$linux_client_key"; do
      if [[ ! -f "$key_path" || ! -r "$key_path" || ! -s "$key_path" ]]; then
        echo "fabro-darwin-machines: key file is missing, unreadable, or empty: $key_path" >&2
        exit 1
      fi
    done

    if [[ "$linux_host_name" != "linux-builder.tuxedo-musical.ts.net" ]]; then
      echo "fabro-darwin-machines: --linux-host-name must be linux-builder.tuxedo-musical.ts.net" >&2
      exit 1
    fi
    if [[ "$linux_ssh_user" != "builder" ]]; then
      echo "fabro-darwin-machines: --linux-ssh-user must be builder" >&2
      exit 1
    fi
    if [[ "$linux_system" != "aarch64-linux" ]]; then
      echo "fabro-darwin-machines: --linux-system must be aarch64-linux" >&2
      exit 1
    fi
    if [[ "$linux_max_jobs" != "4" ]]; then
      echo "fabro-darwin-machines: --linux-max-jobs must be 4" >&2
      exit 1
    fi
    if [[ "$linux_speed_factor" != "1" ]]; then
      echo "fabro-darwin-machines: --linux-speed-factor must be 1" >&2
      exit 1
    fi
    case "$linux_client_key" in
      /run/secrets/*) ;;
      *)
        echo "fabro-darwin-machines: --linux-client-key must be under /run/secrets" >&2
        exit 1
        ;;
    esac
    if [[ "$linux_client_key" == /nix/store/* ]]; then
      echo "fabro-darwin-machines: --linux-client-key must be an absolute runtime path outside /nix/store" >&2
      exit 1
    fi
    if [[ "$(basename -- "$linux_host_key")" != "ssh_host_ed25519_key.pub" ]]; then
      echo "fabro-darwin-machines: --linux-host-key must name the pinned ssh_host_ed25519_key.pub file" >&2
      exit 1
    fi
    mapfile -t linux_host_key_lines < "$linux_host_key"
    if [[ "''${#linux_host_key_lines[@]}" -ne 1 ]]; then
      echo "fabro-darwin-machines: --linux-host-key must contain exactly one public key" >&2
      exit 1
    fi
    IFS=' ' read -r key_type key_blob _key_comment <<< "''${linux_host_key_lines[0]}"
    if [[ "$key_type" != "ssh-ed25519" || ! "$key_blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
      echo "fabro-darwin-machines: --linux-host-key must contain a valid public Ed25519 key" >&2
      exit 1
    fi
    key_blob_header="$(printf '%s' "$key_blob" | base64 --decode 2>/dev/null | od -An -tx1 -N15 | tr -d ' \\n')"
    key_blob_size="$(printf '%s' "$key_blob" | base64 --decode 2>/dev/null | wc -c)"
    if [[ "$key_blob_header" != "0000000b7373682d65643235353139" || "$key_blob_size" -ne 51 ]]; then
      echo "fabro-darwin-machines: --linux-host-key must contain a valid public Ed25519 key" >&2
      exit 1
    fi

    linux_host_key_b64="$(base64 < "$linux_host_key" | tr -d '\n')"
    host_key_b64="$(base64 < "$host_key" | tr -d '\n')"
    if [[ -z "$host_key_b64" || -z "$linux_host_key_b64" ]]; then
      echo "fabro-darwin-machines: host key input is empty" >&2
      exit 1
    fi

    output_dir="$(dirname -- "$output")"
    if [[ ! -d "$output_dir" ]]; then
      echo "fabro-darwin-machines: output directory does not exist: $output_dir" >&2
      exit 1
    fi

    temporary="$(mktemp "''${output}.tmp.XXXXXX")" || {
      echo "fabro-darwin-machines: cannot create temporary output for: $output" >&2
      exit 1
    }
    trap 'rm -f -- "$temporary"' EXIT

    printf 'ssh-ng://%s@%s %s %s %s %s - - %s\n' \
      "$ssh_user" "$host_name" "$system" "$client_key" "$max_jobs" "$speed_factor" "$host_key_b64" > "$temporary"
    printf 'ssh-ng://%s@%s %s %s %s %s - - %s\n' \
      "$linux_ssh_user" "$linux_host_name" "$linux_system" "$linux_client_key" \
      "$linux_max_jobs" "$linux_speed_factor" "$linux_host_key_b64" >> "$temporary"
    chmod 0600 "$temporary"
    if ! mv -f -- "$temporary" "$output"; then
      echo "fabro-darwin-machines: cannot write output: $output" >&2
      exit 1
    fi
    trap - EXIT
  '';
}
