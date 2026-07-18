{
  lib,
  writeShellApplication,
  writeTextDir,
  coreutils,
  atticExecutable,
  caCertificate,
  cacheName,
  endpoint,
  pendingDirectory,
  shlockExecutable,
  stateDirectory,
  storeDirectory,
  tokenFile,
}:

let
  tomlString =
    value:
    ''"${lib.replaceStrings [ "\\" "\"" "\n" "\r" "\t" ] [ "\\\\" "\\\"" "\\n" "\\r" "\\t" ] value}"'';
  clientConfig = writeTextDir "attic/config.toml" ''
    [servers.local]
    endpoint = ${tomlString endpoint}
    token-file = ${tomlString tokenFile}
  '';
in
writeShellApplication {
  name = "local-binary-cache-publish";
  runtimeInputs = [ coreutils ];
  text = ''
    export LC_ALL=C

    fail() {
      printf 'local-binary-cache-publish: %s\n' "$1" >&2
      exit 1
    }

    log_invalid() {
      printf 'local-binary-cache-publish: invalid pending entry retained: %s (%s)\n' "$1" "$2" >&2
    }

    attic=${lib.escapeShellArg atticExecutable}
    ca_certificate=${lib.escapeShellArg caCertificate}
    cache_name=${lib.escapeShellArg cacheName}
    pending_directory=${lib.escapeShellArg pendingDirectory}
    shlock=${lib.escapeShellArg shlockExecutable}
    state_directory=${lib.escapeShellArg stateDirectory}
    store_directory=${lib.escapeShellArg storeDirectory}
    token_file=${lib.escapeShellArg tokenFile}
    lock_directory="$state_directory/publish.lock"
    lock_acquired=0

    cleanup_lock() {
      if (( lock_acquired == 1 )); then
        rm -f -- "$lock_directory"
      fi
    }

    if [[ "$attic" != /* ]]; then
      fail "invalid Attic executable path: $attic"
    fi
    if [[ "$shlock" != /* ]]; then
      fail "invalid shlock executable path: $shlock"
    fi
    if [[ "$ca_certificate" != /* ]]; then
      fail "custom CA certificate path must be absolute: $ca_certificate"
    fi
    if [[ ! -e "$ca_certificate" ]]; then
      fail "custom CA certificate is missing or unavailable: $ca_certificate"
    fi
    if [[ ! -f "$ca_certificate" ]]; then
      fail "custom CA certificate is not a regular file: $ca_certificate"
    fi
    if [[ ! -r "$ca_certificate" ]]; then
      fail "custom CA certificate is unreadable: $ca_certificate"
    fi
    for directory in "$pending_directory" "$state_directory" "$store_directory"; do
      if [[ "$directory" != /* || "$directory" == / || "$directory" == */ ]]; then
        fail "invalid publisher directory: $directory"
      fi
    done
    if [[ "$token_file" != /* ]]; then
      fail "invalid publisher token-file path: $token_file"
    fi
    if [[ ! "$cache_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
      fail "invalid cache name: $cache_name"
    fi

    if ! mkdir -p -- "$state_directory"; then
      fail "failed to create publisher state directory: $state_directory"
    fi
    lock_status=0
    "$shlock" -p "$$" -f "$lock_directory" || lock_status=$?
    if (( lock_status != 0 )); then
      lock_owner=""
      if [[ -f "$lock_directory" ]]; then
        IFS= read -r lock_owner < "$lock_directory" || true
      fi
      if [[ "$lock_owner" =~ ^[1-9][0-9]*$ ]] && kill -0 "$lock_owner" 2>/dev/null; then
        exit 0
      fi
      fail "failed to acquire publisher lock: $lock_directory"
    fi
    lock_acquired=1
    trap cleanup_lock EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    if [[ ! -f "$token_file" || ! -r "$token_file" || ! -s "$token_file" ]]; then
      fail "required publisher token file is unavailable: $token_file"
    fi
    if [[ ! -d "$pending_directory" ]]; then
      exit 0
    fi

    export XDG_CONFIG_HOME=${lib.escapeShellArg clientConfig}
    shopt -s dotglob nullglob
    entries=("$pending_directory"/*)
    shopt -u dotglob nullglob

    for root in "''${entries[@]}"; do
      root_id="''${root##*/}"
      if [[ ! -L "$root" ]]; then
        log_invalid "$root" "not a symlink"
        continue
      fi
      if [[ ! -e "$root" ]]; then
        log_invalid "$root" "broken symlink"
        continue
      fi
      if [[ ! "$root_id" =~ ^[0-9abcdfghijklmnpqrsvwxyz]{32}$ ]]; then
        log_invalid "$root" "invalid root name"
        continue
      fi

      if ! target="$(readlink -- "$root")"; then
        log_invalid "$root" "unreadable symlink"
        continue
      fi
      if [[ "$target" != "$store_directory/"* ]]; then
        log_invalid "$root" "target is outside the store"
        continue
      fi

      store_name="''${target#"$store_directory/"}"
      if [[ ! "$store_name" =~ ^([0-9abcdfghijklmnpqrsvwxyz]{32})-([A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*)$ ]]; then
        log_invalid "$root" "invalid store target"
        continue
      fi
      if [[ "''${BASH_REMATCH[1]}" != "$root_id" || ''${#BASH_REMATCH[2]} -gt 211 ]]; then
        log_invalid "$root" "root name does not match target"
        continue
      fi

      if ATTIC_CA_CERT="$ca_certificate" "$attic" push -j 1 "local:$cache_name" "$target"; then
        if ! rm -f -- "$root"; then
          fail "published $target but failed to remove pending root $root"
        fi
        printf 'local-binary-cache-publish: published %s from pending root %s\n' "$target" "$root" >&2
      else
        status=$?
        printf 'local-binary-cache-publish: failed to publish %s from pending root %s (Attic exit %d); retained for retry\n' \
          "$target" "$root" "$status" >&2
        exit "$status"
      fi
    done
  '';
}
