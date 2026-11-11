#!/usr/bin/env bash
# Operator-run Fly compatibility gate.
#
# Existing-image boot check (Task 1.2):
#   FLY_API_TOKEN=... FLY_SMOKE_CONFIRM_APP=my-app \
#     ./tests/fly-app/contract-smoke.sh my-app registry.fly.io/my-app:smoke
#
# Module deployment check (Task 5.5):
#   FLY_API_TOKEN=... FLY_SMOKE_CONFIRM_APP=my-app \
#     ./tests/fly-app/contract-smoke.sh --spec <fly-app-spec.json> \
#       --deploy <fly-app-deploy> my-app
#
# The module deployment check runs the real per-app deployment program twice
# against the selected existing disposable app. `--deploy` must accept
# `--spec <spec>` (for example `packages.<system>.fly-app-deploy`). A generated
# `deploy-<app>` wrapper embeds its own spec and ignores arguments, so pass
# that same spec to this harness when using the wrapper. The spec must declare
# at least one derivation-backed image (the hybrid dockerTools +
# nix-snapshotter image) and a multi-container Machine. After each deployment
# the harness re-reads the Machines through the Fly Machines API and proves
# that the module-managed Machine count, stable identities, images, and full
# declared configurations match the specification, that the published image
# references are readable from the Fly registry, and that the declared app
# settings are present in the live app configuration. The two deployments must
# keep the same Machine IDs. Declared Machine keys must match the Fly Launch
# process groups that flyctl creates (or the app must already have
# module-managed Machines), because the reconciler rejects surplus Fly Launch
# Machines instead of deleting them.
#
# Publication state is kept in the harness's private temporary directory, so
# the second deployment exercises the unchanged-image path without touching
# the operator's persistent publication state.
#
# The selected existing app is deployed and left running; use only a
# disposable app. The token is never written to disk or printed: it is passed
# to Fly only through the environment or an HTTP header.
set -euo pipefail

usage() {
  printf 'usage: FLY_API_TOKEN=<operator-token> FLY_SMOKE_CONFIRM_APP=<app> %s <existing-disposable-app> <registry.fly.io/app:tag-or-@sha256:digest>\n' "$0" >&2
  printf '       FLY_API_TOKEN=<operator-token> FLY_SMOKE_CONFIRM_APP=<app> %s --spec <spec.json> --deploy <fly-app-deploy> <existing-disposable-app>\n' "$0" >&2
  printf 'The app must already exist and be disposable; this probe deploys the image and leaves its Machines running.\n' >&2
  exit 2
}

fail() {
  printf 'fly contract smoke: %s\n' "$1" >&2
  exit 1
}

mode=image
if [[ ${1:-} == --spec ]]; then
  mode=deploy
  if [[ $# -ne 5 || -z ${2:-} || ${3:-} != --deploy || -z ${4:-} || -z ${5:-} ]]; then
    usage
  fi
  spec=$2
  deploy_program=$4
  app=$5
else
  if [[ $# -ne 2 ]]; then
    usage
  fi
  app=$1
  image=$2
fi

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

if [[ $mode == deploy ]]; then
  if [[ ! -f $deploy_program || ! -x $deploy_program ]]; then
    fail "deployment program is not executable: $deploy_program"
  fi
  if [[ ! -f $spec || ! -r $spec ]]; then
    fail "spec is not readable: $spec"
  fi
fi

for command in curl flyctl jq base64 mktemp awk; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

if [[ $mode == image ]]; then
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
fi

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
fly_token_b64=$(printf '%s' "$fly_token" | base64 | tr -d '\n') || fail 'could not prepare token redaction'
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

accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'

registry_status() {
  local reference=$1
  printf 'Authorization: Basic %s\nAccept: %s\n' "$registry_auth" "$accept" | \
    curl --silent --show-error --connect-timeout 10 --max-time 30 \
      --header @- --output /dev/null --write-out '%{http_code}' \
      "https://registry.fly.io/v2/$app/manifests/$reference" 2>/dev/null
}

# Replace the token and its base64 forms literally, without treating the token
# as a pattern, before writing captured diagnostics to stderr.
redact_to_stderr() {
  local file=$1
  [[ -f $file ]] || return 0
  awk -v token="$fly_token" -v encoded="$fly_token_b64" -v registry="$registry_auth" '
    function scrub(line, secret,    out, position) {
      if (secret == "") {
        return line
      }
      out = ""
      while ((position = index(line, secret)) > 0) {
        out = out substr(line, 1, position - 1) "[REDACTED]"
        line = substr(line, position + length(secret))
      }
      return out line
    }
    {
      line = scrub($0, token)
      line = scrub(line, encoded)
      line = scrub(line, registry)
      print line
    }
  ' "$file" >&2
}

if ! http_get "Authorization: Bearer $fly_token" "https://api.machines.dev/v1/apps/$app" "$response"; then
  fail 'could not confirm the existing app with Fly; check token, network, and app name'
fi
if ! jq -e --arg app "$app" 'type == "object" and .name == $app' "$response" >/dev/null 2>&1; then
  fail 'Fly did not confirm the requested existing app'
fi
printf 'Fly app exists: ok\n'

if [[ $mode == image ]]; then
  if ! status=$(registry_status "$registry_reference") || [[ ! $status =~ ^[0-9]{3}$ || $status != 200 ]]; then
    fail 'the requested image is not readable from the Fly registry; check the image reference and token'
  fi
  printf 'Fly registry image: ok\n'

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
fi

# ---------------------------------------------------------------------------
# Module deployment mode: hybrid image publication, two deployments, full
# Machine and app-setting verification through the live Fly interfaces.
# ---------------------------------------------------------------------------

cat > "$tmp_dir/spec.jq" <<'JQ'
def source_ok:
  (type == "object") and
  (if (has("existingImage") and (has("derivation") | not)) then
     (.existingImage | type == "string" and length > 0 and (test("\\s") | not))
   elif (has("derivation") and (has("existingImage") | not)) then
     (.derivation | type == "string" and
       test("^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+$"))
   else false end);

def machine_problems:
  [ .machines | to_entries[] |
    .key as $name | .value as $machine |
    if ($name | length) == 0 or ($name | test("\\s")) then
      "Machine names must be non-empty and contain no whitespace"
    elif ($machine | type) != "object" then
      "Machine '\($name)' must be a JSON object"
    elif (($machine.config // {}) | type) != "object" then
      "Machine '\($name)' config must be a JSON object"
    elif (($machine.containers // {}) | type) != "object" then
      "Machine '\($name)' containers must be a JSON object"
    elif (($machine.containers // {}) | length) > 0 then
      if ($machine | has("image")) then
        "Machine '\($name)' cannot mix Machine and container image declarations"
      elif ([ $machine.containers[].image | source_ok ] | all | not) then
        "Machine '\($name)' must declare exactly one image source for each container"
      elif (($machine.deployContainer // null) != null and
            ((($machine.deployContainer | type) != "string") or
             (($machine.containers | has($machine.deployContainer)) | not))) then
        "Machine '\($name)' selects an unknown deployContainer"
      elif (($machine.containers | length) > 1 and
            ($machine.deployContainer // null) == null) then
        "Machine '\($name)' must select a deployContainer when it has multiple containers"
      else empty end
    elif ($machine.image | source_ok | not) then
      "Machine '\($name)' must declare exactly one image source"
    else empty end
  ];

if (type != "object") then
  "the spec must be a JSON object"
elif (.name | type) != "string" or (.name | length) == 0 then
  "the spec must declare a Fly app name"
elif (.name != $app) then
  "the spec targets app '\(.name)' instead of '\($app)'"
elif ((.settings // {}) | type) != "object" then
  "the spec settings must be a JSON object"
elif ((.settings // {}) | has("app")) then
  "app setting 'app' must not override the declared Fly app identity"
elif ((.settings // {}) | has("build")) then
  "app setting 'build' is not supported"
elif ((.machines // {}) | type) != "object" or ((.machines // {}) | length) == 0 then
  "the spec must declare at least one Machine"
elif (machine_problems | length) > 0 then
  machine_problems[0]
elif ([ .machines[] | (.containers // {}) | length > 1 ] | any | not) then
  "the spec must declare a multi-container Machine"
elif ([ .machines[] |
        (if ((.containers // {}) | length) > 0 then
           .containers[].image
         else
           .image
         end) |
        has("derivation") ] | any | not) then
  "the spec must declare a derivation image source for the hybrid image"
else
  empty
end
JQ
spec_problem=$(jq -r --arg app "$app" -f "$tmp_dir/spec.jq" "$spec" 2>/dev/null) ||
  fail 'the spec is not valid JSON'
[[ -z $spec_problem ]] || fail "$spec_problem"

mapfile -t derivation_references < <(jq -r --arg app "$app" '
  [ .machines[] |
    (if ((.containers // {}) | length) > 0 then .containers[].image else .image end) |
    select(has("derivation")) |
    .derivation |
    capture("^/nix/store/(?<hash>[0-9abcdfghijklmnpqrsvwxyz]{32})-").hash |
    "registry.fly.io/\($app):nix-\(.)" ] |
  unique | .[]
' "$spec" 2>/dev/null)
(( ${#derivation_references[@]} > 0 )) ||
  fail 'the spec must declare a derivation image source for the hybrid image'

cat > "$tmp_dir/verify.jq" <<'JQ'
def contains($want; $have):
  ($want | type) as $want_type |
  ($have | type) as $have_type |
  if $want_type == "object" then
    $have_type == "object" and
    ([ ($want | keys[]) as $key |
       ($have | has($key)) and contains($want[$key]; $have[$key]) ] | all)
  elif $want_type == "array" then
    $have_type == "array" and
    ([ $want[] as $item | [ $have[] | contains($item; .) ] | any ] | all)
  else
    $want == $have
  end;

def image_reference($app; $source):
  if $source.existingImage then
    $source.existingImage
  else
    "registry.fly.io/\($app):nix-\($source.derivation |
      capture("^/nix/store/(?<hash>[0-9abcdfghijklmnpqrsvwxyz]{32})-").hash)"
  end;

def expected_config($app; $key; $machine):
  ($machine.config // {}) as $declared |
  (if (($machine.containers // {}) | length) > 0 then
     ($declared | del(.image)) + {
       containers: [
         $machine.containers | to_entries[] |
         (.value.config // {}) + {
           name: .key,
           image: image_reference($app; .value.image)
         }
       ]
     }
   else
     ($declared | del(.containers)) + {
       image: image_reference($app; $machine.image)
     }
   end) as $config |
  $config + {
    metadata: (($declared.metadata // {}) + {fly_app_module_key: $key})
  };

$spec[0] as $spec |
($spec.machines) as $declared |
($declared | keys) as $keys |
([ .[] |
   select(((.config.metadata // {}) | has("fly_app_module_key")) or
          ((.config.metadata // {}) | has("fly_process_group"))) ]) as $managed |
([ $managed[] | (.config.metadata // {}).fly_app_module_key? // empty ]) as $managed_keys |

(if ($managed | length) != ($keys | length) then
   "managed Machine count \($managed | length) does not match the \($keys | length) declared Machines"
 else empty end),
(if ([ $managed[] |
        select(((.config.metadata // {}) | has("fly_app_module_key")) | not) ] |
      length) > 0 then
   "managed Machine set contains a Fly Launch process group without a module identity"
 else empty end),
(if ($managed_keys | length) != ($managed_keys | unique | length) then
   "managed Machine identities are not unique: \($managed_keys | sort | join(", "))"
 else empty end),
(
  $keys[] as $key |
  ([ $managed[] |
     select(((.config.metadata // {}).fly_app_module_key? // null) == $key) ]) as $matches |
  if ($matches | length) != 1 then
    "declared Machine '\($key)' has \($matches | length) module-managed matches"
  else
    ($matches[0]) as $live |
    (if $live.state != "started" then
       "Machine '\($key)' is not started (state: \($live.state))"
     else empty end),
    (if (($declared[$key].containers // {}) | length) > 0 then
       ([ ($live.config.containers // [])[] | .name ] | sort) as $live_names |
       ([ $declared[$key].containers | keys[] ] | sort) as $declared_names |
       (if $live_names != $declared_names then
          "Machine '\($key)' containers \($live_names | join(", ")) do not match the declaration \($declared_names | join(", "))"
        else empty end)
     else empty end),
    (if contains(expected_config($app; $key; $declared[$key]); $live.config) then
       empty
     else
       "Machine '\($key)' full config does not contain the declared configuration"
     end)
  end
)
JQ

api_auth="Authorization: Bearer $fly_token"
state_dir=$tmp_dir/state

fetch_machines() {
  local output=$1
  if ! http_get "$api_auth" "https://api.machines.dev/v1/apps/$app/machines" "$output"; then
    fail 'could not inspect Fly Machines through the Machines API; check token and network'
  fi
  if ! jq -e 'type == "array"' "$output" >/dev/null 2>&1; then
    fail 'Fly returned an invalid Machines response'
  fi
}

machine_problem() {
  local output=$1
  jq -r --arg app "$app" --slurpfile spec "$spec" -f "$tmp_dir/verify.jq" "$output" 2>/dev/null
}

machines_ready() {
  local output=$1
  jq -e --slurpfile spec "$spec" '
    ($spec[0].machines | keys) as $keys |
    ([ .[] |
       select(((.config.metadata // {}) | has("fly_app_module_key"))) ]) as $managed |
    ($keys | length) > 0 and
    ([ $keys[] as $key |
       [ $managed[] |
         select(.config.metadata.fly_app_module_key == $key and
                .state == "started") ] |
       length == 1 ] | all)
  ' "$output" >/dev/null 2>&1
}

managed_ids() {
  jq -r '[ .[] |
    select(((.config.metadata // {}) | has("fly_app_module_key"))) |
    .id ] | sort | .[]' "$1"
}

wait_for_machines() {
  local label=$1 output=$2 start_time=$SECONDS remaining problem
  while :; do
    fetch_machines "$output"
    if machines_ready "$output"; then
      return 0
    fi
    if (( SECONDS - start_time >= boot_timeout )); then
      if ! problem=$(machine_problem "$output"); then
        fail 'could not verify the Fly Machines against the declaration'
      fi
      if [[ -n $problem ]]; then
        fail "$problem"
      fi
      fail "no started Machine set matching the declaration appeared within ${boot_timeout} seconds"
    fi
    remaining=$((boot_timeout - (SECONDS - start_time)))
    if (( remaining <= 5 )); then
      sleep "$remaining"
    else
      sleep 5
    fi
  done
}

verify_machines() {
  local label=$1 output=$2 problem count
  if ! problem=$(machine_problem "$output"); then
    fail 'could not verify the Fly Machines against the declaration'
  fi
  [[ -z $problem ]] || fail "$problem"
  if ! count=$(jq '[ .[] |
    select(((.config.metadata // {}) | has("fly_app_module_key"))) ] | length' "$output"); then
    fail 'could not count the module-managed Machines'
  fi
  printf 'Fly Machine set %s: ok (%s module-managed Machines match the declaration)\n' "$label" "$count"
}

check_derivation_images() {
  local reference status
  for reference in "${derivation_references[@]}"; do
    if ! status=$(registry_status "$reference") || [[ ! $status =~ ^[0-9]{3}$ || $status != 200 ]]; then
      fail 'the requested image is not readable from the Fly registry; check the image reference and token'
    fi
  done
}

inspect_app_settings() {
  local step=$1 label=$2 config error problem
  config=$tmp_dir/app-config-$step.json
  error=$tmp_dir/app-config-$step.stderr
  if ! FLY_API_TOKEN="$fly_token" flyctl config show --app "$app" >"$config" 2>"$error"; then
    redact_to_stderr "$error"
    fail "could not read the live Fly app configuration for deployment $label"
  fi
  problem=$(jq -r --slurpfile spec "$spec" '
    def matches_setting($want; $have):
      ($want | type) as $want_type |
      ($have | type) as $have_type |
      if $want_type == "object" then
        $have_type == "object" and
        ([ ($want | keys[]) as $key |
           ($have | has($key)) and matches_setting($want[$key]; $have[$key]) ] | all)
      elif $want_type == "array" then
        $have_type == "array" and
        ([ $want[] as $item | [ $have[] | matches_setting($item; .) ] | any ] | all)
      elif $want == $have then
        true
      elif $want_type == "number" and $have_type == "string" then
        $have == "\($want)s"
      elif $want_type == "string" and $have_type == "number" then
        $want == "\($have)s"
      else
        false
      end;
    ($spec[0].settings // {}) as $settings |
    if ($settings | length) == 0 then
      empty
    elif matches_setting($settings; .) then
      empty
    else
      "the live app configuration does not contain the declared settings"
    end
  ' "$config" 2>/dev/null) || problem='the Fly CLI returned an invalid app configuration'
  [[ -z $problem ]] || fail "$problem"
  printf 'Fly app settings %s: ok\n' "$label"
}

run_deployment() {
  local step=$1 label=$2 status=0 stdout stderr
  stdout=$tmp_dir/deploy-$step.stdout
  stderr=$tmp_dir/deploy-$step.stderr
  if FLY_API_TOKEN="$fly_token" FLY_APP_STATE_DIR="$state_dir" \
    "$deploy_program" --spec "$spec" >"$stdout" 2>"$stderr"; then
    status=0
  else
    status=$?
  fi
  if (( status != 0 )); then
    redact_to_stderr "$stdout"
    redact_to_stderr "$stderr"
    fail "Fly deployment $label failed with status $status"
  fi
  printf 'Fly deployment %s: accepted\n' "$label"
}

fetch_machines "$machines_before"

first_ids=''
for step in 1 2; do
  label="$step/2"
  run_deployment "$step" "$label"
  wait_for_machines "$label" "$machines"
  verify_machines "$label" "$machines"
  if (( step == 1 )); then
    check_derivation_images
    printf 'Fly hybrid image publication: ok (%s derivation-backed references)\n' "${#derivation_references[@]}"
    printf 'Fly hybrid image boot: ok (the declared derivation-backed references run on the managed Machines)\n'
    if ! first_ids=$(managed_ids "$machines"); then
      fail 'could not read the module-managed Machine identities'
    fi
  else
    if ! current_ids=$(managed_ids "$machines"); then
      fail 'could not read the module-managed Machine identities'
    fi
    if [[ $current_ids != "$first_ids" ]]; then
      fail 'the second deployment replaced the module-managed Machines'
    fi
  fi
  inspect_app_settings "$step" "$label"
done

printf 'Fly live compatibility: ok (two deployments preserved the declared app and Machine configuration)\n'
