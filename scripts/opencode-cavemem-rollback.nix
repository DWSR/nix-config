{
  coreutils,
  writeShellApplication,
}:

writeShellApplication {
  name = "opencode-cavemem-rollback";
  runtimeInputs = [ coreutils ];
  text = ''
    state_home="''${XDG_STATE_HOME:-$HOME/.local/state}"
    current_generation_link="$state_home/home-manager/gcroots/current-home"
    if [ ! -e "$current_generation_link" ]; then
      echo "ERROR: OpenCode cavemem rollback activation is unavailable because the current Home Manager generation was not found at $current_generation_link. Rebuild the host to install a generation containing the rollback specialisation." >&2
      exit 1
    fi
    current_generation="$(readlink -f "$current_generation_link")"
    rollback_generation="$current_generation/specialisation/opencode-cavemem-rollback"
    activation="$rollback_generation/activate"
    generation_version_file="$rollback_generation/gen-version"

    if [ ! -x "$activation" ]; then
      echo "ERROR: OpenCode cavemem rollback activation is unavailable at $activation. Rebuild the host to install a Home Manager generation containing the rollback specialisation." >&2
      exit 1
    fi

    if [ ! -r "$generation_version_file" ]; then
      echo "ERROR: OpenCode cavemem rollback activation does not declare Home Manager driver support. Rebuild the host with the pinned Home Manager version." >&2
      exit 1
    fi

    IFS= read -r generation_version < "$generation_version_file"
    case "$generation_version" in
      "" | *[!0-9]*)
        echo "ERROR: OpenCode cavemem rollback activation has invalid gen-version '$generation_version'. Rebuild the host with the pinned Home Manager version." >&2
        exit 1
        ;;
    esac
    if [ "$generation_version" -lt 1 ]; then
      echo "ERROR: OpenCode cavemem rollback activation does not support Home Manager driver version 1. Rebuild the host with the pinned Home Manager version." >&2
      exit 1
    fi

    case "''${1:-}" in
      --check)
        printf 'opencode_cavemem_rollback=available\n'
        printf 'rollback_generation=%s\n' "$rollback_generation"
        printf 'driver_version=1\n'
        ;;
      "")
        exec "$activation" --driver-version 1
        ;;
      *)
        echo "Usage: opencode-cavemem-rollback [--check]" >&2
        exit 2
        ;;
    esac
  '';
}
