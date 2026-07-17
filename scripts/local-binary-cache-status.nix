{
  lib,
  writeShellApplication,
  coreutils,
  caCertificate,
  cacheName,
  configuredCachePublicKey,
  curlExecutable,
  dateExecutable,
  endpoint,
  expectedPostBuildHook,
  expectedSubstituters,
  jqExecutable,
  nixExecutable,
  pendingDirectory,
  readlinkExecutable,
  statExecutable,
  storeDirectory,
  bootstrapMode ? false,
  readinessOnly ? false,
}:

writeShellApplication {
  name = "local-binary-cache-status";
  runtimeInputs = [ coreutils ];
  text = ''
    export LC_ALL=C

    redact_substituter() {
      local value="$1"
      local scheme
      local rest
      local authority
      local suffix

      if [[ "$value" != *://* ]]; then
        printf '<invalid>'
        return
      fi

      scheme="''${value%%://*}://"
      rest="''${value#*://}"
      authority="''${rest%%[/?#]*}"
      suffix="''${rest#"$authority"}"
      if [[ "$authority" == *@* ]]; then
        authority="<redacted>@''${authority##*@}"
      fi
      value="$scheme$authority$suffix"

      if [[ "$value" == *\?* ]]; then
        value="''${value%%\?*}?<redacted>"
      elif [[ "$value" == *\#* ]]; then
        value="''${value%%\#*}#<redacted>"
      fi
      printf '%s' "$value"
    }

    record_broken_root() {
      broken_roots+=("$1")
      broken_reasons+=("$2")
      healthy=0
    }

    ca_certificate=${lib.escapeShellArg caCertificate}
    cache_name=${lib.escapeShellArg cacheName}
    configured_cache_public_key=${lib.escapeShellArg configuredCachePublicKey}
    bootstrap_mode=${if bootstrapMode then "1" else "0"}
    curl=${lib.escapeShellArg curlExecutable}
    date=${lib.escapeShellArg dateExecutable}
    endpoint=${lib.escapeShellArg endpoint}
    expected_hook=${lib.escapeShellArg expectedPostBuildHook}
    expected_substituters=${lib.escapeShellArg expectedSubstituters}
    jq=${lib.escapeShellArg jqExecutable}
    nix=${lib.escapeShellArg nixExecutable}
    pending_directory=${lib.escapeShellArg pendingDirectory}
    readiness_only=${if readinessOnly then "1" else "0"}
    readlink=${lib.escapeShellArg readlinkExecutable}
    stat=${lib.escapeShellArg statExecutable}
    store_directory=${lib.escapeShellArg storeDirectory}

    if (( bootstrap_mode == 1 && readiness_only == 1 )); then
      printf 'mode=bootstrap\n'
      printf 'status=not-ready\n'
      exit 1
    fi

    healthy=1
    tls_health=unhealthy
    cache_health=unhealthy
    configured_live_key_match=unavailable
    effective_hook_available=0
    effective_hook=""
    hook_match=false
    effective_substituters_available=0
    effective_substituters=""
    substituters_match=false
    queue_count=0
    oldest_pending_age=none
    declare -a broken_roots=()
    declare -a broken_reasons=()

    probe_inputs_valid=1
    if [[ "$curl" != /* || ! -x "$curl" || "$jq" != /* || ! -x "$jq" ]]; then
      probe_inputs_valid=0
    fi
    if [[ "$ca_certificate" != /* || ! -f "$ca_certificate" || ! -r "$ca_certificate" ]]; then
      probe_inputs_valid=0
    fi
    if [[ "$endpoint" != https://Brandons-MacBook-Pro.local:8443 || "$cache_name" != darwin ]]; then
      probe_inputs_valid=0
    fi

    live_cache_public_key=""
    if (( probe_inputs_valid == 1 )); then
      cache_url="$endpoint/$cache_name/attic-cache-info"
      probe_status=0
      probe_output="$($curl --disable --cacert "$ca_certificate" --silent --show-error \
        --write-out $'\n%{http_code}' -- "$cache_url" 2>/dev/null)" || probe_status=$?
      if (( probe_status == 0 )) && [[ "$probe_output" == *$'\n'* ]]; then
        cache_http_status="''${probe_output##*$'\n'}"
        cache_response="''${probe_output%$'\n'*}"
        if [[ "$cache_http_status" =~ ^[0-9]{3}$ ]]; then
          tls_health=healthy
        fi
        if [[ "$cache_http_status" == 200 ]]; then
          if live_cache_public_key="$(
            printf '%s' "$cache_response" \
              | "$jq" -er '
                  if type == "object"
                    and .is_public == true
                    and (.public_key | type == "string")
                  then .public_key
                  else empty
                  end
                ' 2>/dev/null
          )" && [[ "$live_cache_public_key" =~ ^darwin:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]]; then
            cache_health=healthy
          fi
        fi
      fi
    fi

    if [[ "$configured_cache_public_key" =~ ^darwin:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ \
      && "$cache_health" == healthy ]]; then
      if [[ "$configured_cache_public_key" == "$live_cache_public_key" ]]; then
        configured_live_key_match=true
      else
        configured_live_key_match=false
      fi
    fi

    if [[ "$tls_health" != healthy || "$cache_health" != healthy \
      || "$configured_live_key_match" != true ]]; then
      healthy=0
    fi

    if (( readiness_only == 1 )); then
      printf 'mode=ready\n'
      printf 'tls-health=%s\n' "$tls_health"
      printf 'cache-health=%s\n' "$cache_health"
      printf 'configured-live-key-match=%s\n' "$configured_live_key_match"
      if (( healthy == 1 )); then
        printf 'status=ready\n'
        exit 0
      fi
      printf 'status=not-ready\n'
      exit 1
    fi

    if [[ "$nix" == /* && -x "$nix" ]]; then
      if effective_hook="$($nix config show post-build-hook 2>/dev/null)" \
        && [[ "$effective_hook" != *$'\n'* && "$effective_hook" != *$'\r'* ]]; then
        effective_hook_available=1
        if [[ "$effective_hook" == "$expected_hook" ]]; then
          hook_match=true
        fi
      fi
      if effective_substituters="$($nix config show substituters 2>/dev/null)" \
        && [[ "$effective_substituters" != *$'\n'* && "$effective_substituters" != *$'\r'* ]]; then
        effective_substituters_available=1
        if [[ "$effective_substituters" == "$expected_substituters" ]]; then
          substituters_match=true
        fi
      fi
    fi
    if [[ "$hook_match" != true || "$substituters_match" != true ]]; then
      healthy=0
    fi

    if [[ "$pending_directory" != /* || "$pending_directory" == / || "$pending_directory" == */ \
      || "$store_directory" != /* || "$store_directory" == / || "$store_directory" == */ ]]; then
      record_broken_root "$pending_directory" invalid-queue-path
    elif [[ -e "$pending_directory" && ! -d "$pending_directory" ]]; then
      record_broken_root "$pending_directory" not-a-directory
    elif [[ -d "$pending_directory" ]]; then
      shopt -s dotglob nullglob
      entries=("$pending_directory"/*)
      shopt -u dotglob nullglob
      now_epoch=""

      for root in "''${entries[@]}"; do
        root_id="''${root##*/}"
        if [[ ! -L "$root" ]]; then
          record_broken_root "$root" not-a-symlink
          continue
        fi
        if [[ ! -e "$root" ]]; then
          record_broken_root "$root" broken-symlink
          continue
        fi
        if [[ ! "$root_id" =~ ^[0-9abcdfghijklmnpqrsvwxyz]{32}$ ]]; then
          record_broken_root "$root" invalid-root-name
          continue
        fi
        if [[ "$readlink" != /* || ! -x "$readlink" ]] \
          || ! target="$($readlink -- "$root" 2>/dev/null)"; then
          record_broken_root "$root" unreadable-symlink
          continue
        fi
        if [[ "$target" != "$store_directory/"* ]]; then
          record_broken_root "$root" target-outside-store
          continue
        fi

        store_name="''${target#"$store_directory/"}"
        if [[ ! "$store_name" =~ ^([0-9abcdfghijklmnpqrsvwxyz]{32})-([A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*)$ ]]; then
          record_broken_root "$root" invalid-store-target
          continue
        fi
        if [[ "''${BASH_REMATCH[1]}" != "$root_id" || ''${#BASH_REMATCH[2]} -gt 211 ]]; then
          record_broken_root "$root" root-name-does-not-match-target
          continue
        fi

        (( queue_count += 1 ))
        if [[ -z "$now_epoch" ]]; then
          if [[ "$date" != /* || ! -x "$date" ]] \
            || ! now_epoch="$($date +%s 2>/dev/null)" \
            || [[ ! "$now_epoch" =~ ^[0-9]+$ ]]; then
            now_epoch=unavailable
          fi
        fi
        if [[ "$now_epoch" == unavailable || "$stat" != /* || ! -x "$stat" ]] \
          || ! pending_mtime="$($stat '--format=%Y' -- "$root" 2>/dev/null)" \
          || [[ ! "$pending_mtime" =~ ^[0-9]+$ ]]; then
          record_broken_root "$root" pending-age-unavailable
          continue
        fi
        if (( pending_mtime > now_epoch )); then
          record_broken_root "$root" pending-timestamp-in-future
          continue
        fi

        pending_age=$((now_epoch - pending_mtime))
        if [[ "$oldest_pending_age" == none ]] || (( pending_age > oldest_pending_age )); then
          oldest_pending_age=$pending_age
        fi
      done
    fi

    printf 'tls-health=%s\n' "$tls_health"
    printf 'cache-health=%s\n' "$cache_health"
    printf 'configured-live-key-match=%s\n' "$configured_live_key_match"
    if (( effective_hook_available == 0 )); then
      printf 'effective-post-build-hook=unavailable\n'
    elif [[ -z "$effective_hook" ]]; then
      printf 'effective-post-build-hook=none\n'
    else
      printf 'effective-post-build-hook=%s\n' "$effective_hook"
    fi
    printf 'post-build-hook-match=%s\n' "$hook_match"
    if (( effective_substituters_available == 0 )); then
      printf 'effective-substituter=unavailable\n'
    elif [[ -z "$effective_substituters" ]]; then
      printf 'effective-substituter=none\n'
    else
      read -r -a substituter_values <<< "$effective_substituters"
      for substituter in "''${substituter_values[@]}"; do
        printf 'effective-substituter=%s\n' "$(redact_substituter "$substituter")"
      done
    fi
    printf 'substituters-match=%s\n' "$substituters_match"
    printf 'queue-count=%d\n' "$queue_count"
    printf 'oldest-pending-age-seconds=%s\n' "$oldest_pending_age"
    if (( ''${#broken_roots[@]} == 0 )); then
      printf 'broken-root=none\n'
    else
      for index in "''${!broken_roots[@]}"; do
        printf 'broken-root=%q reason=%s\n' "''${broken_roots[$index]}" "''${broken_reasons[$index]}"
      done
    fi

    if (( healthy == 1 )); then
      printf 'status=healthy\n'
      exit 0
    fi
    printf 'status=unhealthy\n'
    exit 1
  '';
}
