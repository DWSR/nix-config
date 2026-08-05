#!/usr/bin/env bash

set -euo pipefail

expected_host="ShopifyLaptop"
publisher_label="org.nixos.local-binary-cache-publisher"
pending_directory="/var/db/local-binary-cache/publisher/pending"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_directory/../.." && pwd -P)"
status_command="/run/current-system/sw/bin/local-binary-cache-status"

fail() {
  printf '05-shopify-outage-preflight: %s\n' "$1" >&2
  exit 1
}

require_status_line() {
  local output="$1"
  local expected="$2"

  /usr/bin/grep -Fqx -- "$expected" <<< "$output" \
    || fail "status output is missing: $expected"
}

check_required_services() {
  local output

  output="$("$status_command")" || return
  /usr/bin/grep -Fqx -- "status=ready" <<< "$output" || return 1
  launchctl print "system/$publisher_label" >/dev/null 2>&1 || return
  printf '%s\n' "$output"
}

verify_consumer_config() {
  local hook
  local substituter
  local substituters
  local found_local=0
  local found_upstream=0
  local -a substituter_values

  hook="$(nix config show post-build-hook)"
  [[ -x "$hook" ]] || fail "effective post-build hook is unavailable: $hook"
  [[ "$(nix config show require-sigs)" == true ]] \
    || fail "Nix signature verification is not required"
  [[ "$(nix config show fallback)" == true ]] \
    || fail "Nix fallback is not enabled"

  substituters="$(nix config show substituters)"
  read -r -a substituter_values <<< "$substituters"
  for substituter in "${substituter_values[@]}"; do
    if [[ "$substituter" == "$endpoint" ]]; then
      found_local=1
    else
      found_upstream=1
    fi
  done
  (( found_local == 1 )) || fail "local cache substituter is not effective"
  (( found_upstream == 1 )) || fail "no existing upstream substituter is effective"
}

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
[[ $# -eq 0 ]] || fail "usage: $0"

cd "$repo_root"
sudo -n -v || fail "non-interactive sudo credential is unavailable"

status_output="$(check_required_services)" \
  || fail "cache endpoint or publisher is not healthy before outage preflight"
printf '%s\n' "$status_output"
require_status_line "$status_output" "status=ready"
verify_consumer_config

sudo -n test -d "$pending_directory" \
  || fail "pending directory is unavailable: $pending_directory"
existing_pending="$(
  sudo -n /usr/bin/find "$pending_directory" -mindepth 1 -maxdepth 1 -print -quit
)"
[[ -z "$existing_pending" ]] \
  || fail "pending queue is not empty before outage preflight: $existing_pending"

run_id="shopify-outage-$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
[[ "$run_id" =~ ^shopify-outage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "uuidgen returned an invalid run identifier: $run_id"

next_script="$script_directory/06-personal-endpoint-outage.sh"
printf 'RUN_ID=%s\n' "$run_id"
printf 'Next on Brandons-MacBook-Pro: %s %s\n' "$next_script" "$run_id"
