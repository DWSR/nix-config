{
  bearerReference,
  coreutils,
  curl,
  jq,
  lib,
  restPort,
  writeShellApplication,
}:

writeShellApplication {
  name = "agentmemory-reap-sessions";
  runtimeInputs = [
    coreutils
    curl
    jq
  ];
  text = ''
    set -eu

    rest_endpoint="''${AGENTMEMORY_REAPER_URL:-http://127.0.0.1:${toString restPort}}"
    curl_bin="''${AGENTMEMORY_REAPER_CURL_BIN:-curl}"
    security_bin="''${AGENTMEMORY_REAPER_SECURITY_BIN:-/usr/bin/security}"
    max_age_seconds=604800

    if ! "$curl_bin" --fail --silent --show-error --max-time 10 \
      "$rest_endpoint/agentmemory/livez" >/dev/null 2>&1; then
      printf '%s\n' 'AgentMemory is unavailable; skipping session reap.' >&2
      exit 0
    fi

    agentmemory_secret="''${AGENTMEMORY_SECRET:-}"
    if [ -z "$agentmemory_secret" ]; then
      agentmemory_secret=$(${coreutils}/bin/timeout --kill-after=2s 5s \
        "$security_bin" find-generic-password \
        -s mcpproxy \
        -a ${lib.escapeShellArg bearerReference} \
        -w 2>/dev/null) || agentmemory_secret=""
    fi
    if [ -z "$agentmemory_secret" ]; then
      printf '%s\n' 'AgentMemory bearer unavailable; skipping session reap.' >&2
      exit 0
    fi

    sessions=$(
      "$curl_bin" --fail --silent --show-error --max-time 30 \
        --header "Authorization: Bearer $agentmemory_secret" \
        "$rest_endpoint/agentmemory/sessions?agentId=*"
    )

    stale_sessions=$(
      printf '%s' "$sessions" | jq -r --argjson max_age "$max_age_seconds" '
        .sessions[]?
        | select(.status == "active")
        | (.startedAt? | try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null) as $started
        | select($started != null and $started < (now - $max_age))
        | .id
      '
    )

    while IFS= read -r session_id; do
      [ -n "$session_id" ] || continue
      payload=$(jq -cn --arg session_id "$session_id" '{ sessionId: $session_id }')
      "$curl_bin" --fail --silent --show-error --max-time 30 \
        --request POST \
        --header "Authorization: Bearer $agentmemory_secret" \
        --header 'Content-Type: application/json' \
        --data "$payload" \
        "$rest_endpoint/agentmemory/session/end" >/dev/null
      printf 'Completed leaked AgentMemory session: %s\n' "$session_id"
    done <<< "$stale_sessions"
  '';
}
