#!/usr/bin/env bash

set -euo pipefail

expected_host="ShopifyLaptop"
publisher_label="org.nixos.local-binary-cache-publisher"
pending_directory="/var/db/local-binary-cache/publisher/pending"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_directory/../.." && pwd -P)"
status_command="/run/current-system/sw/bin/local-binary-cache-status"
outage_phase="08-shopify-outage-recovery"

fail() {
  printf '%s: %s\n' "$outage_phase" "$1" >&2
  exit 1
}

probe_endpoint() {
  /usr/bin/curl --disable --fail --silent --show-error \
    --connect-timeout 3 --max-time 5 \
    --cacert "$repo_root/certificates/local-binary-cache/ca.pem" \
    "$endpoint/attic-cache-info" >/dev/null 2>&1
}

consume_recovery_ready() {
  local input="$1"

  (( recovery_ready_consumed == 0 )) || return 1
  [[ "$input" == "RECOVERY_READY $run_id $restore_challenge" ]] || return 1
  recovery_ready_consumed=1
}

require_status_line() {
  local output="$1"
  local expected="$2"

  /usr/bin/grep -Fqx -- "$expected" <<< "$output" \
    || fail "status output is missing after recovery: $expected"
}

# shellcheck source=tests/local-binary-cache/outage-publisher-control.sh
source "$script_directory/outage-publisher-control.sh"

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
[[ $# -eq 4 ]] || fail "usage: $0 RUN_ID OUT RESTORE_CHALLENGE RUN_TICKET"

run_id="$1"
output="$2"
restore_challenge="$3"
ticket="$4"
[[ "$run_id" =~ ^shopify-outage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "invalid run identifier: $run_id"
[[ "$output" =~ ^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-local-binary-cache-outage-shopify-outage-[0-9a-f-]+$ ]] \
  || fail "invalid outage output path: $output"
[[ "$restore_challenge" =~ ^shopify-restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "invalid restoration challenge: $restore_challenge"

store_name="${output#/nix/store/}"
root_id="${store_name%%-*}"
output_name="${store_name#"$root_id-"}"
[[ "$output_name" == "local-binary-cache-outage-$run_id" ]] \
  || fail "output path does not belong to run identifier $run_id: $output"
challenge_id="${restore_challenge#shopify-restore-}"
expected_ticket="$publisher_state_directory/task-6.4-$run_id-$challenge_id.ticket"
[[ "$ticket" == "$expected_ticket" ]] || fail "run ticket path does not match handoff"

cd "$repo_root"
acquire_noninteractive_privilege \
  || fail "non-interactive sudo credential is unavailable"
load_publisher_contract || fail "deployed publisher plist contract is invalid"
publisher_loaded || fail "publisher launchd job is not loaded"
sudo -n test -d "$pending_directory" \
  || fail "pending directory is unavailable: $pending_directory"
[[ -e "$output" && "$(/bin/cat "$output")" == "$run_id:$restore_challenge" ]] \
  || fail "outage output is missing or has unexpected content: $output"

status_exit=0
"$status_command" >/dev/null 2>&1 || status_exit=$?
(( status_exit != 0 )) || fail "endpoint recovered before phase 08 was waiting"
endpoint_status=0
probe_endpoint || endpoint_status=$?
(( endpoint_status != 0 )) || fail "cache endpoint is available before recovery handoff"

pending_root="$pending_directory/$root_id"
sudo -n test -L "$pending_root" || fail "expected pending root is absent: $pending_root"
[[ "$(sudo -n readlink "$pending_root")" == "$output" ]] \
  || fail "pending root does not target $output"
unrelated_pending="$(
  sudo -n /usr/bin/find "$pending_directory" -mindepth 1 -maxdepth 1 \
    ! -name "$root_id" -print -quit
)"
[[ -z "$unrelated_pending" ]] \
  || fail "unrelated pending root blocks recovery: $unrelated_pending"

failure_capture="$publisher_state_directory/task-6.4-$run_id-$challenge_id-failure.capture"
ticket_payload="$(printf 'RUN_ID=%s\nOUT=%s\nCHALLENGE=%s\nPUBLISHER=%s\nWORKING_DIRECTORY=%s\nFAILURE_CAPTURE=%s' \
  "$run_id" "$output" "$restore_challenge" "$publisher_executable" \
  "$publisher_working_directory" "$failure_capture")"
consumed_ticket="$ticket.consumed"
sudo -n /usr/bin/perl "$publisher_runner" ticket-consume \
  "$ticket" "$consumed_ticket" "$ticket_payload" \
  || fail "run ticket is missing, mismatched, or already consumed"

stop_publisher || fail "failed to stop publisher launchd job"
sudo -n test -L "$pending_root" \
  || fail "pending root disappeared before recovery handoff: $pending_root"
[[ "$(sudo -n readlink "$pending_root")" == "$output" ]] \
  || fail "pending root changed before recovery handoff"
printf 'phase-08-waiting run-id=%s challenge=%s ticket=%s\n' \
  "$run_id" "$restore_challenge" "$consumed_ticket"
printf 'Return to Brandons-MacBook-Pro now and enter: RESTORE %s %s\n' \
  "$run_id" "$restore_challenge"
printf 'After phase 06 prints recovery-ready, enter here: RECOVERY_READY %s %s\n' \
  "$run_id" "$restore_challenge"

recovery_ready_input=""
recovery_ready_received=0
recovery_ready_consumed=0
attempt=0
while (( attempt < 45 )); do
  read_status=0
  IFS= read -r -t 20 recovery_ready_input || read_status=$?
  if (( read_status == 0 )); then
    recovery_ready_received=1
    break
  fi
  (( read_status > 128 )) || fail "recovery-ready input closed before handoff"
  sudo -n -v || fail "sudo credential refresh failed while publisher was paused"
  (( attempt += 1 ))
done
(( recovery_ready_received == 1 )) \
  || fail "timed out after 900 seconds waiting for recovery-ready handoff"
consume_recovery_ready "$recovery_ready_input" \
  || fail "expected unused recovery-ready handoff for current run"

ready_status=""
ready=0
attempt=0
while (( attempt < 60 )); do
  if ready_status="$("$status_command")"; then
    ready=1
    break
  fi
  /bin/sleep 2
  (( attempt += 1 ))
done
(( ready == 1 )) || fail "endpoint did not become ready within 120 seconds"
printf '%s\n' "$ready_status"
require_status_line "$ready_status" "tls-health=healthy"
require_status_line "$ready_status" "cache-health=healthy"
require_status_line "$ready_status" "configured-live-key-match=true"
require_status_line "$ready_status" "status=ready"

success_capture="$publisher_state_directory/task-6.4-$run_id-$challenge_id-success.capture"
success_prefix="published $output from pending root $pending_root"
run_bounded_publisher zero "$success_capture" 1 "$success_prefix" \
  || fail "bounded publisher invocation did not prove successful recovery"
sudo -n test ! -L "$pending_root" \
  || fail "bounded publisher success did not remove pending root: $pending_root"

/usr/bin/curl --disable --fail --silent --show-error \
  --connect-timeout 3 --max-time 10 \
  --cacert "$repo_root/certificates/local-binary-cache/ca.pem" \
  "$endpoint/$root_id.narinfo" >/dev/null
remaining_pending="$(
  sudo -n /usr/bin/find "$pending_directory" -mindepth 1 -maxdepth 1 -print -quit
)"
[[ -z "$remaining_pending" ]] \
  || fail "publisher queue is not empty after recovery: $remaining_pending"

finish_publisher_control
printf 'recovery-published=%s failure-capture=%s success-capture=%s ticket=%s\n' \
  "$output" "$failure_capture" "$success_capture" "$consumed_ticket"
printf 'producer-copy-retained=%s (Task 6.3 already covers post-publication substitution)\n' "$output"
