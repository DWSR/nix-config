#!/usr/bin/env bash
# Example: FLY_API_TOKEN=... FLY_SMOKE_CONFIRM_APP=my-app ./tests/fly-app/contract-smoke.sh my-app registry.fly.io/my-app:smoke
# The selected existing app is deployed and left running; use only a disposable app.
set -euo pipefail

usage() {
  printf 'usage: FLY_API_TOKEN=<operator-token> FLY_SMOKE_CONFIRM_APP=<app> %s <existing-disposable-app> <registry.fly.io/app:tag-or-@sha256:digest>\n' "$0" >&2
  printf 'The app must already exist and be disposable; this probe deploys the image and leaves its Machine running.\n' >&2
  exit 2
}

fail() {
  printf 'fly contract smoke: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || usage
app=$1
image=$2

if [[ ! $app =~ ^[a-z0-9][a-z0-9-]*$ ]] || (( ${#app} > 63 )); then
  fail 'app name must be 1-63 lowercase letters, digits, or hyphens and start with a letter or digit'
fi
if [[ ${FLY_SMOKE_CONFIRM_APP:-} != "$app" ]]; then
  fail 'set FLY_SMOKE_CONFIRM_APP to the exact existing disposable app name'
fi
if [[ -z ${FLY_API_TOKEN:-} ]]; then
  fail 'FLY_API_TOKEN is required'
fi
if [[ $FLY_API_TOKEN == *$'\r'* || $FLY_API_TOKEN == *$'\n'* ]]; then
  fail 'FLY_API_TOKEN must not contain line breaks'
fi

if [[ $image =~ ^registry\.fly\.io/([a-z0-9][a-z0-9-]*)(:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@sha256:([a-fA-F0-9]{64}))$ ]]; then
  image_app=${BASH_REMATCH[1]}
  image_tag=${BASH_REMATCH[3]:-}
  image_digest=${BASH_REMATCH[4]:-}
else
  fail 'image must be an app-scoped registry.fly.io reference with a tag or sha256 digest'
fi
[[ $image_app == "$app" ]] || fail 'registry image must belong to the selected app'
if [[ -n $image_tag ]]; then
  registry_reference=$image_tag
else
  registry_reference="sha256:$image_digest"
fi

for command in curl flyctl jq base64 mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
boot_timeout=${FLY_SMOKE_BOOT_TIMEOUT_SECONDS:-300}
[[ $boot_timeout =~ ^[0-9]+$ ]] || fail 'FLY_SMOKE_BOOT_TIMEOUT_SECONDS must be an integer from 1 through 3600'
boot_timeout=${boot_timeout#"${boot_timeout%%[!0]*}"}
[[ -n $boot_timeout ]] || boot_timeout=0
[[ ${#boot_timeout} -le 4 ]] || fail 'FLY_SMOKE_BOOT_TIMEOUT_SECONDS must be an integer from 1 through 3600'
(( 10#$boot_timeout >= 1 && 10#$boot_timeout <= 3600 )) ||
  fail 'FLY_SMOKE_BOOT_TIMEOUT_SECONDS must be an integer from 1 through 3600'
boot_timeout=$((10#$boot_timeout))

umask 077
if ! tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/fly-contract-smoke.XXXXXXXX"); then
  fail 'could not create private temporary directory'
fi
trap 'rm -rf -- "$tmp_dir"' EXIT

fly_token=$FLY_API_TOKEN
registry_auth=$(printf 'x:%s' "$fly_token" | base64 | tr -d '\n') || fail 'could not prepare registry authentication'
response=$tmp_dir/response
machines=$tmp_dir/machines
machines_before=$tmp_dir/machines-before
fly_config=$tmp_dir/fly.toml
printf 'app = "%s"\n' "$app" > "$fly_config"

http_get() {
  local auth_header=$1 url=$2 output=$3 status
  if ! status=$(printf '%s\n' "$auth_header" | curl --silent --show-error --connect-timeout 10 --max-time 30 \
    --header @- --output "$output" --write-out '%{http_code}' "$url" 2>/dev/null); then
    return 1
  fi
  if [[ ! $status =~ ^[0-9]{3}$ ]]; then
    return 1
  fi
  [[ $status == 200 ]]
}

if ! http_get "Authorization: Bearer $fly_token" "https://api.machines.dev/v1/apps/$app" "$response"; then
  fail 'could not confirm the existing app with Fly; check token, network, and app name'
fi
if ! jq -e --arg app "$app" 'type == "object" and .name == $app' "$response" >/dev/null 2>&1; then
  fail 'Fly did not confirm the requested existing app'
fi
printf 'Fly app exists: ok\n'

accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
if ! status=$(printf 'Authorization: Basic %s\nAccept: %s\n' "$registry_auth" "$accept" | \
  curl --silent --show-error --connect-timeout 10 --max-time 30 \
    --header @- --output /dev/null --write-out '%{http_code}' \
    "https://registry.fly.io/v2/$app/manifests/$registry_reference" 2>/dev/null) || [[ ! $status =~ ^[0-9]{3}$ || $status != 200 ]]; then
  fail 'the requested image is not readable from the Fly registry; check the image reference and token'
fi
printf 'Fly registry image: ok\n'
unset registry_auth

if ! http_get "Authorization: Bearer $fly_token" "https://api.machines.dev/v1/apps/$app/machines" "$machines_before" ||
  ! jq -e 'type == "array"' "$machines_before" >/dev/null 2>&1; then
  fail 'could not record the existing Fly Machines before deployment'
fi

if ! flyctl deploy --app "$app" --config "$fly_config" --image "$image" --now --ha=false --yes >/dev/null 2>&1; then
  fail 'Fly rejected the image deployment; command diagnostics were suppressed'
fi
printf 'Fly image deploy: accepted\n'

unset FLY_API_TOKEN
api_auth="Authorization: Bearer $fly_token"
unset fly_token
start_time=$SECONDS
while :; do
  if ! http_get "$api_auth" "https://api.machines.dev/v1/apps/$app/machines" "$machines"; then
    fail 'could not inspect Fly Machines after deployment; check token and network'
  fi
  if ! jq -e 'type == "array"' "$machines" >/dev/null 2>&1; then
    fail 'Fly returned an invalid Machines response'
  fi
  if jq -e --arg image "$image" --slurpfile before "$machines_before" \
    '[.[] as $machine |
      select($machine.state == "started" and $machine.config.image == $image) |
      select([$before[0][] | select(.id == $machine.id and .version == $machine.version)] | length == 0)] |
      length > 0' "$machines" >/dev/null 2>&1; then
    printf 'Fly Machine boot: ok (newly created or updated Machine is running the requested image)\n'
    exit 0
  fi
  if (( SECONDS - start_time >= boot_timeout )); then
    fail "no newly created or updated Machine using the requested image appeared within ${boot_timeout} seconds"
  fi
  remaining=$((boot_timeout - (SECONDS - start_time)))
  if (( remaining <= 5 )); then
    sleep "$remaining"
  else
    sleep 5
  fi
done
