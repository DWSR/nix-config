{
  lib,
  writeShellApplication,
  coreutils,
  nixStoreExecutable,
  pendingDirectory,
  storeDirectory,
}:

writeShellApplication {
  name = "local-binary-cache-enqueue";
  runtimeInputs = [ coreutils ];
  text = ''
    set -f
    export LC_ALL=C

    fail() {
      printf 'local-binary-cache-enqueue: %s\n' "$1" >&2
      exit 1
    }

    nix_store=${lib.escapeShellArg nixStoreExecutable}
    pending_directory=${lib.escapeShellArg pendingDirectory}
    store_directory=${lib.escapeShellArg storeDirectory}
    out_paths="''${OUT_PATHS-}"

    if [[ "$nix_store" != /* ]]; then
      fail "invalid nix-store executable path: $nix_store"
    fi
    if [[ "$pending_directory" != /* || "$pending_directory" == / || "$pending_directory" == */ ]]; then
      fail "invalid pending directory: $pending_directory"
    fi
    if [[ "$store_directory" != /* || "$store_directory" == / || "$store_directory" == */ ]]; then
      fail "invalid store directory: $store_directory"
    fi
    if [[ -z "$out_paths" ]]; then
      fail "OUT_PATHS is missing or empty"
    fi
    if [[ "$out_paths" == *$'\n'* || "$out_paths" == *$'\r'* || "$out_paths" == *$'\t'* ]]; then
      fail "invalid OUT_PATHS: expected one or more space-separated store paths"
    fi

    IFS=' ' read -r -a outputs <<< "$out_paths"
    if (( ''${#outputs[@]} == 0 )); then
      fail "OUT_PATHS is missing or empty"
    fi

    declare -A output_by_hash=()
    declare -a root_ids=()
    declare -a unique_outputs=()

    for output in "''${outputs[@]}"; do
      if [[ "$output" != "$store_directory/"* ]]; then
        fail "invalid output path: $output"
      fi

      store_name="''${output#"$store_directory/"}"
      if [[ ! "$store_name" =~ ^([0-9abcdfghijklmnpqrsvwxyz]{32})-([A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*)$ ]]; then
        fail "invalid output path: $output"
      fi

      store_hash="''${BASH_REMATCH[1]}"
      output_name="''${BASH_REMATCH[2]}"
      if (( ''${#output_name} > 211 )); then
        fail "invalid output path: $output"
      fi

      existing="''${output_by_hash[$store_hash]-}"
      if [[ -n "$existing" ]]; then
        if [[ "$existing" != "$output" ]]; then
          fail "invalid output path: store hash $store_hash identifies both $existing and $output"
        fi
        continue
      fi

      output_by_hash[$store_hash]="$output"
      root_ids+=("$store_hash")
      unique_outputs+=("$output")
    done

    if ! mkdir -p -- "$pending_directory"; then
      fail "failed to create pending directory: $pending_directory"
    fi

    for index in "''${!unique_outputs[@]}"; do
      output="''${unique_outputs[$index]}"
      root="$pending_directory/''${root_ids[$index]}"
      if ! "$nix_store" --add-root "$root" --realise "$output" >/dev/null; then
        fail "failed to record output $output at pending root $root"
      fi
    done
  '';
}
