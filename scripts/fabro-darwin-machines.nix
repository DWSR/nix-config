{ pkgs }:
pkgs.writeShellApplication {
  name = "fabro-darwin-machines";
  runtimeInputs = [ pkgs.coreutils ];
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
    linux_system=""
    linux_max_jobs=""
    linux_client_key=""
    linux_host_key=""

    usage() {
      cat >&2 <<'USAGE'
    Usage: fabro-darwin-machines --output PATH --host-name HOST --ssh-user USER \
      --system SYSTEM --max-jobs N --speed-factor N --client-key PATH --host-key PATH \
      --linux-host-name HOST --linux-system aarch64-linux --linux-max-jobs 4 \
      --linux-client-key PATH --linux-host-key PUBLIC_KEY_PATH
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
        --output|--host-name|--ssh-user|--system|--max-jobs|--speed-factor|--client-key|--host-key|--linux-host-name|--linux-system|--linux-max-jobs|--linux-client-key|--linux-host-key)
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
            --linux-system) linux_system="$2" ;;
            --linux-max-jobs) linux_max_jobs="$2" ;;
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

    for option in output host-name ssh-user system max-jobs speed-factor client-key host-key \
      linux-host-name linux-system linux-max-jobs linux-client-key linux-host-key; do
      variable="''${option//-/_}"
      if [[ -z "''${!variable}" ]]; then
        echo "fabro-darwin-machines: --$option is required" >&2
        usage
        exit 2
      fi
    done

    if [[ "$linux_host_name" != "linux-builder.tuxedo-musical.ts.net" ]]; then
      echo "fabro-darwin-machines: --linux-host-name must be linux-builder.tuxedo-musical.ts.net" >&2
      exit 2
    fi
    if [[ "$linux_system" != "aarch64-linux" ]]; then
      echo "fabro-darwin-machines: --linux-system must be aarch64-linux" >&2
      exit 2
    fi
    if [[ "$linux_max_jobs" != 4 ]]; then
      echo "fabro-darwin-machines: --linux-max-jobs must be 4" >&2
      exit 2
    fi
    if [[ "$linux_client_key" != /run/secrets/* || "$linux_client_key" == *[[:space:]]* || "$linux_client_key" == *//* || "$linux_client_key" == */../* || "$linux_client_key" == */.. ]]; then
      echo "fabro-darwin-machines: --linux-client-key must be a normalized runtime path under /run/secrets" >&2
      exit 2
    fi

    for key_path in "$client_key" "$host_key" "$linux_host_key"; do
      if [[ ! -f "$key_path" || ! -r "$key_path" || ! -s "$key_path" ]]; then
        echo "fabro-darwin-machines: key input is missing, unreadable, or empty: $key_path" >&2
        exit 1
      fi
    done

    linux_key_type="$(awk 'NR == 1 { print $1 }' "$linux_host_key")"
    linux_key_data="$(awk 'NR == 1 { print $2 }' "$linux_host_key")"
    linux_key_lines="$(wc -l < "$linux_host_key" | tr -d '[:space:]')"
    if [[ "$linux_key_type" != "ssh-ed25519" || ! "$linux_key_data" =~ ^[A-Za-z0-9+/]+={0,2}$ || "$linux_key_lines" != 1 ]]; then
      echo "fabro-darwin-machines: invalid pinned Linux Ed25519 public host key: $linux_host_key" >&2
      exit 1
    fi
    linux_key_size="$(printf '%s' "$linux_key_data" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]')"
    linux_key_type_blob="$(printf '%s' "$linux_key_data" | base64 -d 2>/dev/null | od -An -tx1 -N19 | tr -d '[:space:]')"
    if [[ "$linux_key_size" != 51 || "$linux_key_type_blob" != "0000000b7373682d6564323535313900000020" ]]; then
      echo "fabro-darwin-machines: invalid pinned Linux Ed25519 public host key: $linux_host_key" >&2
      exit 1
    fi

    darwin_host_key_b64="$(base64 < "$host_key" | tr -d '\n')"
    linux_host_key_b64="$(base64 < "$linux_host_key" | tr -d '\n')"
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
    {
      printf 'ssh-ng://%s@%s %s %s %s %s - - %s\n' \
        "$ssh_user" "$host_name" "$system" "$client_key" "$max_jobs" "$speed_factor" "$darwin_host_key_b64"
      printf 'ssh-ng://builder@%s aarch64-linux %s 4 1 - - %s\n' \
        "$linux_host_name" "$linux_client_key" "$linux_host_key_b64"
    } > "$temporary"
    chmod 0600 "$temporary"
    if ! mv -f -- "$temporary" "$output"; then
      echo "fabro-darwin-machines: cannot write output: $output" >&2
      exit 1
    fi
    trap - EXIT
  '';
}
