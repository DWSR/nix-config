{
  coreutils,
  bearerReference,
  curl,
  dataDir,
  enginePort,
  iiiRevision,
  lib,
  lsof,
  logDir,
  opencodeBackend,
  opencodeRollbackBackend,
  piBackend,
  restPort,
  sourceRevision,
  streamPort,
  viewerPort,
  writeShellApplication,
}:

writeShellApplication {
  name = "agentmemory-status";
  runtimeInputs = [
    coreutils
    curl
    lsof
  ];
  text = ''
    data_dir=${builtins.toJSON (toString dataDir)}
    log_file=${builtins.toJSON "${toString logDir}/agentmemory.error.log"}
    source_revision=${builtins.toJSON sourceRevision}
    iii_revision=${builtins.toJSON iiiRevision}
    opencode_backend=${builtins.toJSON opencodeBackend}
    opencode_rollback_backend=${builtins.toJSON opencodeRollbackBackend}
    pi_backend=${builtins.toJSON piBackend}
    rest_port=${builtins.toJSON (toString restPort)}
    stream_port=${builtins.toJSON (toString streamPort)}
    viewer_port=${builtins.toJSON (toString viewerPort)}
    engine_port=${builtins.toJSON (toString enginePort)}
    launchd_label=${builtins.toJSON "dev.dwsr.agentmemory"}

    curl_bin="''${AGENTMEMORY_STATUS_CURL_BIN:-curl}"
    launchctl_bin="''${AGENTMEMORY_STATUS_LAUNCHCTL_BIN:-/bin/launchctl}"
    lsof_bin="''${AGENTMEMORY_STATUS_LSOF_BIN:-lsof}"
    security_bin="''${AGENTMEMORY_STATUS_SECURITY_BIN:-/usr/bin/security}"
    launchd_domain="''${AGENTMEMORY_STATUS_LAUNCHD_DOMAIN:-gui/$(id -u)}"

    if [ -z "''${AGENTMEMORY_SECRET:-}" ]; then
      agentmemory_secret=$(${coreutils}/bin/timeout --kill-after=2s 5s "$security_bin" find-generic-password -s mcpproxy -a ${lib.escapeShellArg bearerReference} -w 2>/dev/null) || agentmemory_secret=""
      if [ -n "$agentmemory_secret" ]; then
        export AGENTMEMORY_SECRET="$agentmemory_secret"
      fi
    fi

    probe_endpoint() {
      local endpoint="$1"
      local authenticated="$2"
      local response=""

      if [ "$authenticated" = yes ] && [ -n "''${AGENTMEMORY_SECRET:-}" ]; then
        response=$("$curl_bin" --silent --show-error --max-time 2 \
          --header "Authorization: Bearer $AGENTMEMORY_SECRET" \
          --output - --write-out $'\n%{http_code}' -- "$endpoint" 2>/dev/null) || response=$'\n000'
      else
        response=$("$curl_bin" --silent --show-error --max-time 2 \
          --output - --write-out $'\n%{http_code}' -- "$endpoint" 2>/dev/null) || response=$'\n000'
      fi

      probe_body="''${response%$'\n'*}"
      probe_code="''${response##*$'\n'}"
    }

    listener_state() {
      local port="$1"
      local listeners
      listeners=$("$lsof_bin" -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null) || listeners=""
      if [ -n "$listeners" ]; then
        printf 'listening'
      else
        printf 'not-listening'
      fi
    }

    probe_endpoint "http://127.0.0.1:$rest_port/agentmemory/livez" no
    livez_code="$probe_code"

    probe_endpoint "http://127.0.0.1:$rest_port/agentmemory/health" yes
    health_code="$probe_code"
    health_body="$probe_body"
    if [ "$health_code" = 200 ] \
      && printf '%s\n' "$health_body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"(healthy|ok)"'; then
      health=healthy
    elif [ "$health_code" = 200 ] \
      && printf '%s\n' "$health_body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"degraded"'; then
      health=degraded
    elif [ "$health_code" = 000 ]; then
      health=unreachable
    else
      health=unhealthy
    fi

    listener_rest=$(listener_state "$rest_port")
    listener_stream=$(listener_state "$stream_port")
    listener_viewer=$(listener_state "$viewer_port")
    listener_engine=$(listener_state "$engine_port")

    launchd_loaded=0
    if "$launchctl_bin" print "$launchd_domain/$launchd_label" >/dev/null 2>&1; then
      launchd_loaded=1
    fi

    all_listeners=listening
    for listener in "$listener_rest" "$listener_stream" "$listener_viewer" "$listener_engine"; do
      if [ "$listener" != listening ]; then
        all_listeners=not-listening
      fi
    done

    status=failed-startup
    action="inspect $log_file"
    exit_code=2
    if [ "$livez_code" = 200 ] \
      && { [ "$health" = healthy ] || [ "$health" = degraded ]; } \
      && [ "$all_listeners" = listening ]; then
      status="$health"
      action=none
      exit_code=0
    elif [ "$livez_code" = 000 ] && [ "$launchd_loaded" -eq 0 ] && [ "$all_listeners" = not-listening ]; then
      status=stopped
      action="launchctl kickstart -k $launchd_domain/$launchd_label"
      exit_code=1
    fi

    printf 'status=%s\n' "$status"
    printf 'health=%s\n' "$health"
    printf 'agentmemory_revision=%s\n' "$source_revision"
    printf 'iii_revision=%s\n' "$iii_revision"
    printf 'opencode_backend=%s\n' "$opencode_backend"
    printf 'opencode_rollback_backend=%s\n' "$opencode_rollback_backend"
    printf 'pi_backend=%s\n' "$pi_backend"
    printf 'data_dir=%s\n' "$data_dir"
    printf 'listener_rest=%s\n' "$listener_rest"
    printf 'listener_stream=%s\n' "$listener_stream"
    printf 'listener_viewer=%s\n' "$listener_viewer"
    printf 'listener_engine=%s\n' "$listener_engine"
    printf 'action=%s\n' "$action"
    exit "$exit_code"
  '';
}
