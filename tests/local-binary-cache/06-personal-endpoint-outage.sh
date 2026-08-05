#!/usr/bin/env bash

set -euo pipefail

expected_host="Brandons-MacBook-Pro"
caddy_label="org.nixos.local-binary-cache-caddy"
attic_label="org.nixos.local-binary-cache-attic"
caddy_plist="/Library/LaunchDaemons/$caddy_label.plist"
pending_directory="/var/db/local-binary-cache/publisher/pending"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_directory/../.." && pwd -P)"
status_command="/run/current-system/sw/bin/local-binary-cache-status"
caddy_recovery_command="$script_directory/06-personal-endpoint-outage.sh --recover"

fail() {
  printf '06-personal-endpoint-outage: %s\n' "$1" >&2
  exit 1
}

job_loaded() {
  launchctl print "system/$1" >/dev/null 2>&1
}

probe_endpoint() {
  /usr/bin/curl --disable --fail --silent --show-error \
    --connect-timeout 3 --max-time 5 \
    --cacert "$repo_root/certificates/local-binary-cache/ca.pem" \
    "$endpoint/attic-cache-info" >/dev/null 2>&1
}

require_status_line() {
  local output="$1"
  local expected="$2"

  /usr/bin/grep -Fqx -- "$expected" <<< "$output"
}

endpoint_health() {
  local output

  job_loaded "$caddy_label" || return
  job_loaded "$attic_label" || return
  output="$("$status_command")" || return
  require_status_line "$output" "tls-health=healthy" || return
  require_status_line "$output" "cache-health=healthy" || return
  require_status_line "$output" "configured-live-key-match=true" || return
  require_status_line "$output" "status=ready" || return
  printf '%s\n' "$output"
}

wait_for_endpoint_health() {
  local attempt=0
  local output

  while (( attempt < 60 )); do
    if output="$(endpoint_health)"; then
      printf '%s\n' "$output"
      return 0
    fi
    /bin/sleep 2
    (( attempt += 1 ))
  done
  return 1
}

recover_endpoint() {
  local bootstrap_status=0

  if ! job_loaded "$caddy_label"; then
    sudo -n -v || return
    sudo -n launchctl bootstrap system "$caddy_plist" || bootstrap_status=$?
    (( bootstrap_status == 0 )) || return "$bootstrap_status"
    job_loaded "$caddy_label" || return
  fi
  wait_for_endpoint_health
}

consume_restore_command() {
  local input="$1"

  (( restore_consumed == 0 )) || return 1
  [[ "$input" == "RESTORE $run_id $restore_challenge" ]] || return 1
  restore_consumed=1
}

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
if [[ $# -eq 1 && "$1" == --recover ]]; then
  cd "$repo_root"
  ready_status="$(recover_endpoint)" \
    || fail "failed to recover Caddy from $caddy_plist or confirm endpoint health"
  printf '%s\n' "$ready_status"
  printf 'caddy-recovery-command=%s\n' "$caddy_recovery_command"
  exit 0
fi
[[ $# -eq 1 ]] || fail "usage: $0 RUN_ID"

run_id="$1"
[[ "$run_id" =~ ^shopify-outage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "invalid run identifier: $run_id"

cd "$repo_root"
sudo -n -v || fail "non-interactive sudo credential is unavailable"

initial_status="$(endpoint_health)" \
  || fail "local binary cache is not healthy before controlled outage"
printf '%s\n' "$initial_status"
require_status_line "$initial_status" "status=ready" \
  || fail "status output is missing before outage: status=ready"
sudo -n test -d "$pending_directory" \
  || fail "pending directory is unavailable: $pending_directory"
existing_pending="$(
  sudo -n /usr/bin/find "$pending_directory" -mindepth 1 -maxdepth 1 -print -quit
)"
[[ -z "$existing_pending" ]] \
  || fail "personal pending queue is not empty before endpoint outage: $existing_pending"

printf 'Manual recovery if interrupted: %s\n' "$caddy_recovery_command" >&2
sudo -n launchctl bootout system "$caddy_plist"

endpoint_status=0
attempt=0
while (( attempt < 15 )); do
  endpoint_status=0
  probe_endpoint || endpoint_status=$?
  if (( endpoint_status != 0 )); then
    break
  fi
  /bin/sleep 1
  (( attempt += 1 ))
done
(( endpoint_status != 0 )) || fail "Caddy endpoint remained available after bootout"
printf 'endpoint-outage-curl-exit=%d run-id=%s\n' "$endpoint_status" "$run_id"
job_loaded "$attic_label" || fail "Attic stopped during the Caddy-only outage"

restore_challenge="shopify-restore-$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
[[ "$restore_challenge" =~ ^shopify-restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "uuidgen returned an invalid restoration challenge: $restore_challenge"
restore_consumed=0

next_script="$script_directory/07-shopify-outage-producer.sh"
printf 'Next on ShopifyLaptop while outage is held: %s %s %s\n' \
  "$next_script" "$run_id" "$restore_challenge"
printf 'Do not enter RESTORE until phase 08 reports that it is waiting.\n'

restore_input=""
restore_received=0
attempt=0
while (( attempt < 45 )); do
  read_status=0
  IFS= read -r -t 20 restore_input || read_status=$?
  if (( read_status == 0 )); then
    restore_received=1
    break
  fi
  (( read_status > 128 )) || fail "restore command input closed before recovery"
  sudo -n -v || fail "sudo credential refresh failed during controlled outage"
  (( attempt += 1 ))
done
(( restore_received == 1 )) \
  || fail "timed out after 900 seconds waiting for the restore command"
consume_restore_command "$restore_input" \
  || fail "expected the unused restore command: RESTORE $run_id $restore_challenge"

ready_status="$(recover_endpoint)" \
  || fail "endpoint did not become ready within 120 seconds"
printf '%s\n' "$ready_status"
require_status_line "$ready_status" "tls-health=healthy" \
  || fail "status output is missing after recovery: tls-health=healthy"
require_status_line "$ready_status" "cache-health=healthy" \
  || fail "status output is missing after recovery: cache-health=healthy"
require_status_line "$ready_status" "configured-live-key-match=true" \
  || fail "status output is missing after recovery: configured-live-key-match=true"
require_status_line "$ready_status" "status=ready" \
  || fail "status output is missing after recovery: status=ready"
job_loaded "$attic_label" || fail "Attic is not loaded after Caddy recovery"
job_loaded "$caddy_label" || fail "Caddy is not loaded after recovery"

printf 'recovery-ready-run-id=%s\n' "$run_id"
printf 'RECOVERY_READY %s %s\n' "$run_id" "$restore_challenge"
