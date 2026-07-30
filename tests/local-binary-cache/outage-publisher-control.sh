# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154

publisher_plist="/Library/LaunchDaemons/$publisher_label.plist"
publisher_state_directory="/var/db/local-binary-cache/publisher"
publisher_runner="$script_directory/outage-log-io.pl"
publisher_recovery_command="$script_directory/07-shopify-outage-producer.sh --recover"
publisher_stopped=0
publisher_privilege_ready=0

publisher_plist_read() {
  local command

  case "$1" in
    Label) command='Print :Label' ;;
    UserName) command='Print :UserName' ;;
    WorkingDirectory) command='Print :WorkingDirectory' ;;
    ProgramArguments:0) command='Print :ProgramArguments:0' ;;
    *) return 1 ;;
  esac
  /usr/libexec/PlistBuddy -c "$command" "$publisher_plist"
}

publisher_plist_has_key() {
  local command

  case "$1" in
    ProgramArguments:1) command='Print :ProgramArguments:1' ;;
    Program) command='Print :Program' ;;
    EnvironmentVariables) command='Print :EnvironmentVariables' ;;
    *) return 1 ;;
  esac
  /usr/libexec/PlistBuddy -c "$command" "$publisher_plist" \
    >/dev/null 2>&1
}

publisher_executable_is_valid() {
  local executable="$1"
  local store_root="${2:-/nix/store}"
  local store_relative
  local canonical_store_root
  local canonical

  [[ "$store_root" == /* && "$store_root" != / && "$store_root" != */ ]] \
    || return 1
  canonical_store_root="$(/bin/realpath "$store_root" 2>/dev/null)" || return 1
  [[ "$canonical_store_root" == "$store_root" \
    && "$executable" == "$store_root/"* ]] \
    || return 1
  store_relative="${executable#"$store_root/"}"
  [[ "$store_relative" =~ ^[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*/bin/local-binary-cache-publish$ \
    && -f "$executable" \
    && -x "$executable" ]] \
    || return 1
  canonical="$(/bin/realpath "$executable" 2>/dev/null)" || return 1
  [[ "$canonical" == "$executable" ]]
}

acquire_noninteractive_privilege() {
  sudo -n -v || return
  publisher_privilege_ready=1
}

require_noninteractive_privilege() {
  (( publisher_privilege_ready == 1 )) || acquire_noninteractive_privilege
}

publisher_loaded() {
  launchctl print "system/$publisher_label" >/dev/null 2>&1
}

load_publisher_contract() {
  [[ -f "$publisher_plist" && ! -L "$publisher_plist" ]] \
    || return 1
  publisher_plist_label="$(publisher_plist_read Label)" \
    || return 1
  publisher_user="$(publisher_plist_read UserName)" \
    || return 1
  publisher_working_directory="$(publisher_plist_read WorkingDirectory)" \
    || return 1
  publisher_executable="$(publisher_plist_read ProgramArguments:0)" \
    || return 1

  [[ "$publisher_plist_label" == "$publisher_label" ]] || return 1
  [[ "$publisher_user" == root ]] || return 1
  [[ "$publisher_working_directory" == "$publisher_state_directory" ]] || return 1
  publisher_plist_has_key ProgramArguments:1 && return 1
  publisher_plist_has_key Program && return 1
  publisher_plist_has_key EnvironmentVariables && return 1
  publisher_executable_is_valid "$publisher_executable"
}

recover_publisher() {
  local bootstrap_status=0

  if publisher_loaded; then
    publisher_stopped=0
    return 0
  fi
  require_noninteractive_privilege || return
  sudo -n launchctl bootstrap system "$publisher_plist" || bootstrap_status=$?
  (( bootstrap_status == 0 )) || return "$bootstrap_status"
  publisher_loaded || return $?
  publisher_stopped=0
}

stop_publisher() {
  require_noninteractive_privilege || return
  publisher_loaded || return 1
  printf 'Manual recovery if interrupted: %s\n' \
    "$publisher_recovery_command" >&2
  sudo -n launchctl bootout system "$publisher_plist" || return
  publisher_loaded && return 1
  publisher_stopped=1
}

finish_publisher_control() {
  recover_publisher
}

run_bounded_publisher() {
  local expectation="$1"
  local capture="$2"
  local fragment_count="$3"
  shift 3

  require_noninteractive_privilege || return
  sudo -n /usr/bin/perl "$publisher_runner" run \
    "$expectation" "$capture" "$publisher_working_directory" \
    "$fragment_count" "$@" -- "$publisher_executable"
}
