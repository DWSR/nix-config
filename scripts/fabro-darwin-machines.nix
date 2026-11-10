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

    usage() {
      cat >&2 <<'USAGE'
    Usage: fabro-darwin-machines --output PATH --host-name HOST --ssh-user USER \\
      --system SYSTEM --max-jobs N --speed-factor N --client-key PATH --host-key PATH
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
        --output|--host-name|--ssh-user|--system|--max-jobs|--speed-factor|--client-key|--host-key)
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

    for option in output host-name ssh-user system max-jobs speed-factor client-key host-key; do
      variable="''${option//-/_}"
      if [[ -z "''${!variable}" ]]; then
        echo "fabro-darwin-machines: --$option is required" >&2
        usage
        exit 2
      fi
    done

    for key_path in "$client_key" "$host_key"; do
      if [[ ! -f "$key_path" || ! -r "$key_path" || ! -s "$key_path" ]]; then
        echo "fabro-darwin-machines: key file is missing, unreadable, or empty: $key_path" >&2
        exit 1
      fi
    done

    host_key_b64="$(base64 < "$host_key" | tr -d '\n')"
    if [[ -z "$host_key_b64" ]]; then
      echo "fabro-darwin-machines: host key is empty: $host_key" >&2
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
    chmod 0600 "$temporary"
    if ! mv -f -- "$temporary" "$output"; then
      echo "fabro-darwin-machines: cannot write output: $output" >&2
      exit 1
    fi
    trap - EXIT
  '';
}
