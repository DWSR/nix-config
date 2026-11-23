{ pkgs, writeShellApplication }:

writeShellApplication {
  name = "fabro-tailscale-reconcile";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.jq
  ];
  text = ''
    auth_key_file=
    tag=
    tailscale=

    while (($#)); do
      case "$1" in
        --auth-key-file) auth_key_file="''${2:?missing value for --auth-key-file}"; shift 2 ;;
        --tag) tag="''${2:?missing value for --tag}"; shift 2 ;;
        --tailscale) tailscale="''${2:?missing value for --tailscale}"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    [[ -n "$auth_key_file" && -n "$tag" && -n "$tailscale" ]] || { echo "required arguments: --auth-key-file, --tag, --tailscale" >&2; exit 2; }

    status="$("$tailscale" status --json --peers=false)" || { echo "tailscale status failed" >&2; exit 1; }

    backend="$(jq -r '.BackendState // ""' <<<"$status")" || { echo "invalid tailscale status response" >&2; exit 1; }
    online="$(jq -r '.Self.Online // false' <<<"$status")" || { echo "invalid tailscale status response" >&2; exit 1; }
    auth_url="$(jq -r '.AuthURL // ""' <<<"$status")" || { echo "invalid tailscale status response" >&2; exit 1; }
    [[ -n "$backend" ]] || { echo "invalid tailscale status response: missing BackendState" >&2; exit 1; }

    case "$backend" in
      Running)
        if [[ "$online" == true && -z "$auth_url" ]]; then
          echo "tailnet registration healthy: $tag is online"
          exit 0
        fi
        ;;
      NeedsLogin|NeedsMachineAuth|Stopped) ;;
      NoState|Starting)
        echo "tailscaled backend is $backend; deferring to the next timer"
        exit 0
        ;;
      *)
        echo "unsupported tailscale BackendState: $backend" >&2
        exit 0
        ;;
    esac

    if [[ ! -s "$auth_key_file" ]]; then
      echo "Tailscale auth credential missing or empty: $auth_key_file" >&2
      exit 1
    fi
    key="$(<"$auth_key_file")"

    echo "re-registering $tag: BackendState=$backend Online=$online AuthURL=$([[ -n "$auth_url" ]] && echo present || echo absent)"
    "$tailscale" up "--auth-key=''${key}?ephemeral=true&preauthorized=true" "--advertise-tags=$tag" || { echo "tailscale up failed" >&2; exit 1; }
  '';
}
