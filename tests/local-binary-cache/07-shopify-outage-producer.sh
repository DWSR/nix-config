#!/usr/bin/env bash

set -euo pipefail

expected_host="ShopifyLaptop"
publisher_label="org.nixos.local-binary-cache-publisher"
pending_directory="/var/db/local-binary-cache/publisher/pending"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_directory/../.." && pwd -P)"
status_command="/run/current-system/sw/bin/local-binary-cache-status"
outage_phase="07-shopify-outage-producer"

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

# shellcheck source=tests/local-binary-cache/outage-publisher-control.sh
source "$script_directory/outage-publisher-control.sh"

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
if [[ $# -eq 1 && "$1" == --recover ]]; then
  cd "$repo_root"
  load_publisher_contract || fail "deployed publisher plist contract is invalid"
  recover_publisher || fail "failed to recover publisher from $publisher_plist"
  printf 'publisher-recovery-command=%s\n' "$script_directory/07-shopify-outage-producer.sh --recover"
  printf 'publisher-loaded=system/%s\n' "$publisher_label"
  exit 0
fi
[[ $# -eq 2 ]] || fail "usage: $0 RUN_ID RESTORE_CHALLENGE"

run_id="$1"
restore_challenge="$2"
[[ "$run_id" =~ ^shopify-outage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "invalid run identifier: $run_id"
[[ "$restore_challenge" =~ ^shopify-restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "invalid restoration challenge: $restore_challenge"

cd "$repo_root"
acquire_noninteractive_privilege \
  || fail "non-interactive sudo credential is unavailable"
verify_consumer_config
load_publisher_contract || fail "deployed publisher plist contract is invalid"

status_exit=0
outage_status_output="$("$status_command")" || status_exit=$?
(( status_exit != 0 )) || fail "status unexpectedly reports a healthy cache during outage"
printf '%s\n' "$outage_status_output"
/usr/bin/grep -Fqx -- "status=unhealthy" <<< "$outage_status_output" \
  || fail "status did not report the controlled endpoint outage"

endpoint_status=0
probe_endpoint || endpoint_status=$?
(( endpoint_status != 0 )) || fail "cache endpoint is available during the outage phase"
printf 'endpoint-outage-curl-exit=%d run-id=%s\n' "$endpoint_status" "$run_id"

publisher_loaded || fail "publisher launchd job is not loaded"
sudo -n test -d "$pending_directory" \
  || fail "pending directory is unavailable: $pending_directory"
existing_pending="$(
  sudo -n /usr/bin/find "$pending_directory" -mindepth 1 -maxdepth 1 -print -quit
)"
[[ -z "$existing_pending" ]] \
  || fail "pending queue is not empty before outage build: $existing_pending"

expression="let
  flake = builtins.getFlake \"path:$repo_root\";
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
in pkgs.runCommand \"local-binary-cache-outage-$run_id\" {}
  \"printf %s $run_id:$restore_challenge > \$out\""

output="$(nix build --no-link --print-out-paths --impure --expr "$expression")"
[[ "$output" != *$'\n'* ]] || fail "build returned more than one output: $output"
store_name="${output#/nix/store/}"
root_id="${store_name%%-*}"
output_name="${store_name#"$root_id-"}"
[[ "$output" == /nix/store/* \
  && "$root_id" =~ ^[0-9abcdfghijklmnpqrsvwxyz]{32}$ \
  && "$output_name" == "local-binary-cache-outage-$run_id" ]] \
  || fail "build returned an unexpected store path: $output"
[[ "$(/bin/cat "$output")" == "$run_id:$restore_challenge" ]] \
  || fail "locally compiled output content does not match the run challenge"
printf 'fallback-build=%s run-id=%s challenge=%s\n' \
  "$output" "$run_id" "$restore_challenge"

pending_root="$pending_directory/$root_id"
sudo -n test -L "$pending_root" \
  || fail "build did not create pending root: $pending_root"
[[ "$(sudo -n readlink "$pending_root")" == "$output" ]] \
  || fail "pending root does not target $output"
endpoint_status=0
probe_endpoint || endpoint_status=$?
(( endpoint_status != 0 )) || fail "cache endpoint recovered before failure proof"

stop_publisher || fail "failed to stop publisher launchd job"
challenge_id="${restore_challenge#shopify-restore-}"
failure_capture="$publisher_state_directory/task-6.4-$run_id-$challenge_id-failure.capture"
failure_prefix="failed to publish $output from pending root $pending_root"
run_bounded_publisher \
  nonzero "$failure_capture" 2 "$failure_prefix" "retained for retry" \
  || fail "bounded publisher invocation did not prove retained failure"

sudo -n test -L "$pending_root" \
  || fail "bounded publisher failure did not retain pending root: $pending_root"
[[ "$(sudo -n readlink "$pending_root")" == "$output" ]] \
  || fail "retained pending root no longer targets $output"

ticket="$publisher_state_directory/task-6.4-$run_id-$challenge_id.ticket"
ticket_payload="$(printf 'RUN_ID=%s\nOUT=%s\nCHALLENGE=%s\nPUBLISHER=%s\nWORKING_DIRECTORY=%s\nFAILURE_CAPTURE=%s' \
  "$run_id" "$output" "$restore_challenge" "$publisher_executable" \
  "$publisher_working_directory" "$failure_capture")"
sudo -n /usr/bin/perl "$publisher_runner" ticket-create "$ticket" "$ticket_payload" \
  || fail "failed to create one-time recovery ticket"

finish_publisher_control

next_script="$script_directory/08-shopify-outage-recovery.sh"
printf 'RUN_ID=%s\nOUT=%s\nPENDING_ROOT=%s\nRESTORE_CHALLENGE=%s\nRUN_TICKET=%s\nFAILURE_CAPTURE=%s\n' \
  "$run_id" "$output" "$pending_root" "$restore_challenge" "$ticket" "$failure_capture"
printf 'Start on ShopifyLaptop before RESTORE: %s %s %s %s %s\n' \
  "$next_script" "$run_id" "$output" "$restore_challenge" "$ticket"
printf 'Only after phase 08 reports waiting, return to Brandons-MacBook-Pro and enter: RESTORE %s %s\n' \
  "$run_id" "$restore_challenge"
