{ pkgs, writeShellApplication }:

writeShellApplication {
  name = "mac-builder-tailscale-auth";
  runtimeInputs = [ pkgs.coreutils ];
  text = ''
    auth_key_file=
    hostname=
    tag=
    tailscale=
    interval=30
    once=false

    while (($#)); do
      case "$1" in
        --auth-key-file) auth_key_file="''${2:?missing value for --auth-key-file}"; shift 2 ;;
        --hostname) hostname="''${2:?missing value for --hostname}"; shift 2 ;;
        --tag) tag="''${2:?missing value for --tag}"; shift 2 ;;
        --tailscale) tailscale="''${2:?missing value for --tailscale}"; shift 2 ;;
        --interval) interval="''${2:?missing value for --interval}"; shift 2 ;;
        --once) once=true; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    [[ -n "$auth_key_file" && -n "$hostname" && -n "$tag" && -n "$tailscale" ]] || { echo "required arguments: --auth-key-file, --hostname, --tag, --tailscale" >&2; exit 2; }

    iteration() {
      if [[ ! -s "$auth_key_file" ]]; then
        echo "Tailscale auth credential missing or empty: $auth_key_file" >&2
        return 1
      fi
      local state
      state=$("$tailscale" status --json) || { echo "tailscale status failed" >&2; return 1; }
      state=$(printf '%s' "$state" | ${pkgs.jq}/bin/jq -er '.BackendState') || { echo "invalid tailscale status response" >&2; return 1; }
      case "$state" in
        Running) return 0 ;;
        NeedsLogin|NeedsMachineAuth|Stopped)
          local key
          key=$(<"$auth_key_file") || return 1
          [[ -n "$key" ]] || { echo "Tailscale auth credential missing or empty: $auth_key_file" >&2; return 1; }
          printf '%s\n' 'FABRO_TAILSCALE_UP_ATTEMPT' >&2
          "$tailscale" up "--auth-key=''${key}?ephemeral=true&preauthorized=true" "--advertise-tags=$tag" "--hostname=$hostname" --accept-dns=false || { echo "tailscale up failed" >&2; return 1; }
          ;;
        *) echo "unsupported tailscale BackendState: $state" >&2; return 1 ;;
      esac
    }

    if [[ "$once" == true ]]; then
      iteration
      exit $?
    fi
    while true; do
      iteration || echo "Tailscale authentication iteration failed" >&2
      sleep "$interval"
    done
  '';
}
