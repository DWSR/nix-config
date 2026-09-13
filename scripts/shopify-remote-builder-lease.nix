{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  stateDirectory ? "/var/db/shopify-remote-builder/requests",
  ownerUid ? 502,
  rootAdderExecutable ? "/run/current-system/sw/bin/nix-store",
  selectedInputRealizerExecutable ? "/run/current-system/sw/bin/nix-store",
  expectedOutputPrimerExecutable ? "/run/current-system/sw/bin/nix-store",
  nowExecutable ? "${coreutils}/bin/date",
  idleTtlSeconds ? 60 * 60,
  heartbeatSeconds ? 30,
  maxRequestBytes ? 1024 * 1024,
  maxPaths ? 10000,
}:

assert lib.isString stateDirectory;
assert stateDirectory != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" stateDirectory != null;
assert lib.isInt ownerUid;
assert ownerUid >= 0;
assert lib.isString rootAdderExecutable;
assert rootAdderExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" rootAdderExecutable != null;
assert lib.isString selectedInputRealizerExecutable;
assert selectedInputRealizerExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" selectedInputRealizerExecutable != null;
assert lib.isString expectedOutputPrimerExecutable;
assert expectedOutputPrimerExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" expectedOutputPrimerExecutable != null;
assert lib.isString nowExecutable;
assert nowExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" nowExecutable != null;
assert lib.isInt idleTtlSeconds;
assert idleTtlSeconds > 0;
assert lib.isInt heartbeatSeconds;
assert heartbeatSeconds > 0;
assert lib.isInt maxRequestBytes;
assert maxRequestBytes > 0;
assert lib.isInt maxPaths;
assert maxPaths > 0;
let
  coreutilsBin = "${coreutils}/bin";
  jqExecutable = "${jq}/bin/jq";
in
writeShellApplication {
  name = "shopify-remote-builder-lease";
  runtimeInputs = [
    coreutils
    jq
  ];
  excludeShellChecks = [
    "SC2016"
    "SC2329"
  ];
  text = ''
    export LC_ALL=C
    umask 077
    set -o pipefail

    chmod_command=${lib.escapeShellArg "${coreutilsBin}/chmod"}
    cut=${lib.escapeShellArg "${coreutilsBin}/cut"}
    head=${lib.escapeShellArg "${coreutilsBin}/head"}
    id_command=${lib.escapeShellArg "${coreutilsBin}/id"}
    jq=${lib.escapeShellArg jqExecutable}
    mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
    mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
    mv=${lib.escapeShellArg "${coreutilsBin}/mv"}
    readlink=${lib.escapeShellArg "${coreutilsBin}/readlink"}
    realpath=${lib.escapeShellArg "${coreutilsBin}/realpath"}
    rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
    sha256sum=${lib.escapeShellArg "${coreutilsBin}/sha256sum"}
    stat=${lib.escapeShellArg "${coreutilsBin}/stat"}
    touch=${lib.escapeShellArg "${coreutilsBin}/touch"}
    wc=${lib.escapeShellArg "${coreutilsBin}/wc"}

    owner_uid=${toString ownerUid}
    root_adder=${lib.escapeShellArg rootAdderExecutable}
    selected_input_realizer=${lib.escapeShellArg selectedInputRealizerExecutable}
    expected_output_primer=${lib.escapeShellArg expectedOutputPrimerExecutable}
    now_command=${lib.escapeShellArg nowExecutable}
     state_directory=${lib.escapeShellArg stateDirectory}
     idle_ttl_seconds=${toString idleTtlSeconds}
     heartbeat_seconds=${toString heartbeatSeconds}
     max_request_bytes=${toString maxRequestBytes}
     max_paths=${toString maxPaths}
     # Keep timestamps within jq's exact integer range before comparison.
     max_timestamp=9007199254740991

    temporary_root=""
    request_file=""
    request_input_file=""
    normalized_request_file=""
    rooted_paths_file=""
    request_root=""
    roots_directory=""
    manifest_file=""
    operation_token=""
    operation_nonce=""
    prepare_created_markers_file=""
    prepare_succeeded=false
    response_operation="create"
    created_request_root=false
    keep_request_root=false
    active_lock_directory=""
    active_heartbeat_file=""
    active_lock_acquired=false
    active_owner_file=""

    emit_failure() {
      local decision="$1"
      local reason="$2"
      local detail="$3"
      "$jq" -n -cS \
        --arg operation "$response_operation" \
        --arg decision "$decision" \
        --arg reason "$reason" \
        --arg detail "$detail" \
        '{
          schemaVersion: 1,
          operation: $operation,
          decision: $decision,
          reason: $reason,
          nonce: null,
          leaseToken: null,
          detail: $detail
           }'
    }

    emit_success() {
      "$jq" -n -cS --slurpfile request "$normalized_request_file" \
        '($request[0]) as $value
         | {
             schemaVersion: 1,
             operation: "create",
             decision: "created",
             nonce: $value.nonce,
             leaseToken: $value.token,
             graphDigest: $value.graphDigest,
             rootedPaths: $value.rootedPaths,
             selectedInputOutputs: $value.selectedInputOutputs,
             expectedOutputs: $value.expectedOutputs,
             publicCacheCuts: ($value.publicCacheCuts
               | map({ rootPath: .rootPath, closureDigest: .closureDigest })
               | sort_by(.rootPath)),
             detail: null
      }'
    }

    emit_prepare_success() {
      "$jq" -n -cS --slurpfile request "$normalized_request_file" \
        '($request[0]) as $value
         | {
             schemaVersion: 1,
             operation: "prepare",
             decision: "prepared",
             nonce: $value.nonce,
             leaseToken: $value.token,
             graphDigest: $value.graphDigest,
             rootedPaths: $value.rootedPaths,
             selectedInputOutputs: $value.selectedInputOutputs,
             expectedOutputs: $value.expectedOutputs,
             detail: null
            }'
    }

    emit_keepalive_ack() {
      "$jq" -n -cS --slurpfile request "$normalized_request_file" \
        --argjson heartbeatSeconds "$heartbeat_seconds" \
        '($request[0]) as $value
         | {
             schemaVersion: 1,
             operation: "keepalive",
             decision: "active",
             nonce: $value.nonce,
             leaseToken: $value.token,
             graphDigest: $value.graphDigest,
             heartbeatSeconds: $heartbeatSeconds,
             detail: null
           }'
    }

    emit_release_success() {
      "$jq" -n -cS --slurpfile request "$normalized_request_file" \
        '($request[0]) as $value
         | {
             schemaVersion: 1,
             operation: "release",
             decision: "released",
             nonce: $value.nonce,
             leaseToken: $value.token,
             graphDigest: $value.graphDigest,
             detail: null
           }'
    }

    emit_cleanup_success() {
      local scanned="$1"
      local removed="$2"
      local skipped_active="$3"
      local skipped_fresh="$4"
      local skipped_invalid="$5"
      local failed="$6"
      "$jq" -n -cS \
        --argjson scanned "$scanned" \
        --argjson removed "$removed" \
        --argjson skippedActive "$skipped_active" \
        --argjson skippedFresh "$skipped_fresh" \
        --argjson skippedInvalid "$skipped_invalid" \
        --argjson failed "$failed" \
        '{
          schemaVersion: 1,
          operation: "cleanup",
          decision: "cleaned",
          scanned: $scanned,
          removed: $removed,
          skippedActive: $skippedActive,
          skippedFresh: $skippedFresh,
          skippedInvalid: $skippedInvalid,
          failed: $failed,
          detail: null
        }'
    }

    validate_cache_cuts() {
      local manifest_path="$1"
      local cut_validation_failed=false
      local cut_record
      local closure_json
      local closure_hash
      local expected_closure_digest
      local actual_closure_digest

      while IFS= read -r cut_record; do
        closure_json="$($jq -cS '.closure' <<<"$cut_record" 2>/dev/null)" || {
          cut_validation_failed=true
          break
        }
        closure_hash="$(printf '%s' "$closure_json" | "$sha256sum" 2>/dev/null | "$cut" -d ' ' -f 1)" || {
          cut_validation_failed=true
          break
        }
        expected_closure_digest="sha256:$closure_hash"
        actual_closure_digest="$($jq -r '.closureDigest' <<<"$cut_record" 2>/dev/null)" || {
          cut_validation_failed=true
          break
        }
        if [[ "$actual_closure_digest" != "$expected_closure_digest" ]]; then
          cut_validation_failed=true
          break
        fi
      done < <("$jq" -c '.publicCacheCuts[]' "$manifest_path" 2>/dev/null)

      [[ "$cut_validation_failed" != true ]]
    }

    verify_root_marker_target() {
      local expected_store_path="$1"
      local marker="$2"
      local link_target

      if [[ -L "$roots_directory" || "$marker" != "$roots_directory/"* ]]; then
        return 1
      fi
      if [[ ! -L "$marker" ]]; then
        return 1
      fi
      link_target="$($readlink "$marker" 2>/dev/null)" || return 1
      [[ "$link_target" == "$expected_store_path" ]]
    }

     verify_root_marker() {
       local expected_store_path="$1"
       local marker="$2"

       [[ -e "$marker" ]] && verify_root_marker_target "$expected_store_path" "$marker"
     }

     normalize_timestamp() {
       local value="$1"
       [[ "$value" =~ ^[0-9]+$ ]] || return 1
       while [[ "$value" == 0* && "$value" != 0 ]]; do
         value="''${value#0}"
       done
       # shellcheck disable=SC2071
       if [[ "''${#value}" -gt "''${#max_timestamp}" ]] || \
         [[ "''${#value}" == "''${#max_timestamp}" && "$value" > "$max_timestamp" ]]; then
         return 1
       fi
       printf '%s\n' "$value"
     }

     decimal_is_greater() {
       local left="$1"
       local right="$2"
       if [[ "''${#left}" -lt "''${#right}" ]]; then
         return 1
       fi
       if [[ "''${#left}" -gt "''${#right}" ]]; then
         return 0
       fi
       # shellcheck disable=SC2071
       [[ "$left" > "$right" ]]
     }

     decimal_add() {
       local left
       local right
       local carry=0
       local left_digit
       local right_digit
       local sum
       local digit
       local result=""
       left="$(normalize_timestamp "$1")" || return 1
       right="$(normalize_timestamp "$2")" || return 1
       while [[ -n "$left" || -n "$right" || "$carry" == 1 ]]; do
         if [[ -n "$left" ]]; then
           left_digit="''${left: -1}"
           left="''${left%?}"
         else
           left_digit=0
         fi
         if [[ -n "$right" ]]; then
           right_digit="''${right: -1}"
           right="''${right%?}"
         else
           right_digit=0
         fi
         # Only validated single decimal digits reach this arithmetic.
         sum=$((10#$left_digit + 10#$right_digit + carry))
         if (( sum >= 10 )); then
           digit=$((sum - 10))
           carry=1
         else
           digit=$sum
           carry=0
         fi
         result="''${digit}''${result}"
       done
       printf '%s\n' "$result"
     }

     read_now() {
       local current_time
       current_time="$($now_command +%s 2>/dev/null)" || return 1
       current_time="$(normalize_timestamp "$current_time")" || return 2
       printf '%s\n' "$current_time"
     }

    validate_persisted_roots() {
      local root_record
      local store_path
      local root_destination
      local root_marker
      local root_name

      while IFS= read -r root_record; do
        store_path="$($jq -r '.storePath' <<<"$root_record" 2>/dev/null)" || return 1
        root_destination="$($jq -r '.destination' <<<"$root_record" 2>/dev/null)" || return 1
        root_marker="$roots_directory/''${store_path##*/}"
        if [[ "$root_destination" != "$root_marker" || "$root_marker" != "$roots_directory/"* ]]; then
          return 1
        fi
        if ! verify_root_marker_target "$store_path" "$root_marker"; then
          return 1
        fi
      done < <("$jq" -c '.rootDestinations[]' "$normalized_request_file" 2>/dev/null)

      for root_marker in "$roots_directory"/* "$roots_directory"/.[!.]* "$roots_directory"/..?*; do
        if [[ ! -e "$root_marker" && ! -L "$root_marker" ]]; then
          continue
        fi
        if [[ ! -L "$root_marker" ]]; then
          return 1
        fi
        root_name="''${root_marker##*/}"
        if ! "$jq" -e --arg rootName "$root_name" \
          '.rootDestinations | any(.[]; (.storePath | split("/") | .[-1]) == $rootName)' \
          "$normalized_request_file" >/dev/null 2>&1; then
          return 1
        fi
      done
    }

    validate_heartbeat() {
      local heartbeat_mode
      local heartbeat_owner
      local heartbeat_value
      heartbeat_present=false
      heartbeat_timestamp=""
       active_heartbeat_file="$request_root/heartbeat.json"
       if [[ ! -e "$active_heartbeat_file" && ! -L "$active_heartbeat_file" ]]; then
         heartbeat_timestamp="$($stat -c '%Y' -- "$manifest_file" 2>/dev/null)" || return 1
         heartbeat_timestamp="$(normalize_timestamp "$heartbeat_timestamp")" || return 1
         heartbeat_present=true
         return 0
      fi
      if [[ -L "$active_heartbeat_file" || ! -f "$active_heartbeat_file" ]]; then
        return 1
      fi
      heartbeat_mode="$($stat -c '%a' -- "$active_heartbeat_file" 2>/dev/null)" || return 1
      heartbeat_owner="$($stat -c '%u' -- "$active_heartbeat_file" 2>/dev/null)" || return 1
      if [[ "$heartbeat_mode" != 600 || "$heartbeat_owner" != "$owner_uid" ]]; then
        return 1
      fi
      if ! "$jq" -e -s \
        --arg expectedNonce "$nonce" \
        --arg expectedToken "$manifest_token" \
        --arg expectedDigest "$manifest_digest" \
        'length == 1
         and (.[0]
       | type == "object"
       and ((keys | sort) == ["graphDigest", "lastHeartbeat", "nonce", "schemaVersion", "token"])
       and .schemaVersion == 1
           and .nonce == $expectedNonce
           and .token == $expectedToken
           and .graphDigest == $expectedDigest
           and (.lastHeartbeat | type == "number" and isfinite and floor == . and . >= 0))' \
        "$active_heartbeat_file" >/dev/null 2>&1; then
        return 1
       fi
       heartbeat_value="$($jq -r '.lastHeartbeat' "$active_heartbeat_file" 2>/dev/null)" || return 1
       heartbeat_timestamp="$(normalize_timestamp "$heartbeat_value")" || return 1
       heartbeat_present=true
     }

     write_heartbeat() {
       local timestamp="$1"
       local heartbeat_tmp="$request_root/heartbeat.json.tmp"
       timestamp="$(normalize_timestamp "$timestamp")" || return 1
       if [[ -e "$heartbeat_tmp" || -L "$heartbeat_tmp" ]]; then
         return 1
      fi
      if ! "$jq" -n -cS \
        --arg nonce "$nonce" \
        --arg token "$manifest_token" \
        --arg graphDigest "$manifest_digest" \
        --argjson lastHeartbeat "$timestamp" \
        '{
          schemaVersion: 1,
          nonce: $nonce,
          token: $token,
          graphDigest: $graphDigest,
          lastHeartbeat: $lastHeartbeat
        }' >"$heartbeat_tmp" 2>/dev/null; then
        return 1
      fi
      if ! "$chmod_command" 600 -- "$heartbeat_tmp" 2>/dev/null \
        || ! "$mv" -- "$heartbeat_tmp" "$active_heartbeat_file" 2>/dev/null; then
        "$rm" -f -- "$heartbeat_tmp" 2>/dev/null || true
        return 1
      fi
      heartbeat_timestamp="$timestamp"
      heartbeat_present=true
    }

    acquire_active_lock() {
      local active_owner_tmp
      active_lock_directory="$request_root/active.lock"
      if [[ -e "$active_lock_directory" || -L "$active_lock_directory" ]]; then
        return 1
      fi
      if ! "$mkdir" -- "$active_lock_directory" 2>/dev/null; then
        return 1
      fi
      if ! "$chmod_command" 700 -- "$active_lock_directory" 2>/dev/null; then
        "$rm" -rf -- "$active_lock_directory" 2>/dev/null || true
        return 1
      fi
      active_lock_acquired=true
      active_owner_file="$active_lock_directory/pid"
      active_owner_tmp="$active_lock_directory/pid.tmp"
      if [[ -e "$active_owner_tmp" || -L "$active_owner_tmp" ]] \
        || ! printf '%s\n' "$$" >"$active_owner_tmp" \
        || ! "$chmod_command" 600 -- "$active_owner_tmp" 2>/dev/null \
        || ! "$mv" -- "$active_owner_tmp" "$active_owner_file" 2>/dev/null; then
        release_active_state
        return 1
      fi
    }

    active_lock_is_live() {
      local active_pid
      active_owner_file="$active_lock_directory/pid"
      if [[ -L "$active_owner_file" || ! -f "$active_owner_file" ]]; then
        return 0
      fi
      IFS= read -r active_pid <"$active_owner_file" || return 0
      if [[ ! "$active_pid" =~ ^[0-9]+$ ]]; then
        return 0
      fi
      kill -0 "$active_pid" 2>/dev/null
    }

    release_active_state() {
      if [[ "$active_lock_acquired" == true ]]; then
        "$rm" -f -- "$request_root/heartbeat.json.tmp" "$active_lock_directory/pid.tmp" 2>/dev/null || true
        "$rm" -rf -- "$active_lock_directory" 2>/dev/null || true
        active_lock_acquired=false
        active_owner_file=""
      fi
    }

    cleanup_on_exit() {
      local status="$?"
      release_active_state
      if [[ "$prepare_succeeded" != true && -n "$prepare_created_markers_file" ]]; then
        while IFS= read -r marker; do
          if [[ "$marker" == "$roots_directory/"* && "$marker" != "$roots_directory" ]]; then
            "$rm" -f -- "$marker" 2>/dev/null || true
          fi
        done <"$prepare_created_markers_file"
      fi
      if [[ "$keep_request_root" != true && "$created_request_root" == true ]]; then
        "$rm" -rf -- "$request_root" 2>/dev/null || true
      fi
      if [[ -n "$temporary_root" ]]; then
        "$rm" -rf -- "$temporary_root" 2>/dev/null || true
      fi
      return "$status"
    }

    cleanup_leases() {
      local scanned=0
      local removed=0
      local skipped_active=0
      local skipped_fresh=0
      local skipped_invalid=0
      local failed=0
      local candidate
      local candidate_name
      local request_root_canonical
      local request_mode
      local request_owner
      local roots_directory_canonical
      local roots_mode
      local roots_owner
      local manifest_mode
       local manifest_owner
       local now_value
       local now_status
       local expiry_timestamp

      for candidate in "$canonical_parent"/*; do
        if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
          continue
        fi
        (( scanned += 1 ))
        candidate_name="''${candidate##*/}"
        if [[ -L "$candidate" || ! "$candidate_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ || ! -d "$candidate" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi

        request_root="$candidate"
        request_root_canonical="$($realpath "$request_root" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        if [[ "$request_root_canonical" != "$request_root" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi
        request_mode="$($stat -c '%a' -- "$request_root" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        request_owner="$($stat -c '%u' -- "$request_root" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        if [[ "$request_mode" != 700 || "$request_owner" != "$owner_uid" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi

        roots_directory="$request_root/roots"
        if [[ -L "$roots_directory" || ! -d "$roots_directory" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi
        roots_directory_canonical="$($realpath "$roots_directory" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        if [[ "$roots_directory_canonical" != "$roots_directory" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi
        roots_mode="$($stat -c '%a' -- "$roots_directory" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        roots_owner="$($stat -c '%u' -- "$roots_directory" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        if [[ "$roots_mode" != 700 || "$roots_owner" != "$owner_uid" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi

        manifest_file="$request_root/manifest.json"
        if [[ -L "$manifest_file" || ! -f "$manifest_file" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi
        manifest_mode="$($stat -c '%a' -- "$manifest_file" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        manifest_owner="$($stat -c '%u' -- "$manifest_file" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        if [[ "$manifest_mode" != 600 || "$manifest_owner" != "$owner_uid" ]]; then
          (( skipped_invalid += 1 ))
          continue
        fi

        nonce="$candidate_name"
        manifest_token="$($jq -r '.token' "$manifest_file" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        manifest_digest="$($jq -r '.graphDigest' "$manifest_file" 2>/dev/null)" || {
          (( skipped_invalid += 1 ))
          continue
        }
        normalized_request_file="$manifest_file"
        if ! "$jq" -e \
          --arg expectedParent "$canonical_parent" \
          --arg expectedNonce "$candidate_name" \
          --argjson ownerUid "$owner_uid" \
          '
            def valid_digest:
              type == "string" and test("^sha256:[0-9a-f]{64}$");
            def valid_store_path:
              type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+-]+$");
            def valid_paths:
              type == "array" and . == (sort | unique) and all(.[]; valid_store_path);
            . as $request
            | ($request | type == "object")
            and (($request | keys) == ([
              "schemaVersion", "operation", "nonce", "token", "requestParent",
              "ownership", "authorization", "graphDigest", "graph", "rootedPaths",
              "rootDestinations", "selectedInputOutputs", "expectedOutputs", "publicCacheCuts"
            ] | sort))
            and $request.schemaVersion == 1
            and $request.operation == "create"
            and $request.nonce == $expectedNonce
            and ($request.token | type == "string"
              and test("^srb1-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[0-9a-f]{64}$")
              and startswith("srb1-" + $expectedNonce + "-"))
            and $request.requestParent == $expectedParent
            and ($request.ownership | type == "object" and .uid == $ownerUid)
            and ($request.authorization | type == "object"
              and .uid == $ownerUid and .operation == "create" and .channel == "local-pipe")
            and ($request.graphDigest | valid_digest)
            and ($request.graph | type == "object"
              and .digest == $request.graphDigest
              and (.paths | valid_paths and length > 0)
              and (.outputPaths | valid_paths and length > 0)
              and (.topOutput | valid_store_path)
              and (.paths | index($request.graph.topOutput) != null)
              and (.outputPaths | index($request.graph.topOutput) != null))
            and ($request.rootedPaths | valid_paths and length > 0)
            and all($request.rootedPaths[]; . as $path | ($request.graph.paths | index($path)) != null)
            and ($request.rootDestinations | type == "array" and length == ($request.rootedPaths | length))
            and ($request.rootDestinations | map(.storePath) == $request.rootedPaths)
            and all($request.rootDestinations[]; . as $root
              | ($root | type == "object"
                and ((keys | sort) == ["destination", "storePath"])
                and .storePath and .destination)
              and ($root.storePath | valid_store_path)
              and ($request.rootedPaths | index($root.storePath)) != null
              and $root.destination == ($expectedParent + "/" + $expectedNonce + "/roots/"
                + ($root.storePath | split("/") | .[-1])))
            and ($request.selectedInputOutputs | valid_paths and length > 0)
            and all($request.selectedInputOutputs[]; . as $path
              | ($request.graph.outputPaths | index($path)) != null
              and ($request.rootedPaths | index($path)) != null
              and $path != $request.graph.topOutput)
            and ($request.expectedOutputs | valid_paths and length > 0)
            and all($request.expectedOutputs[]; . as $path
              | ($request.graph.outputPaths | index($path)) != null
              and ($request.rootedPaths | index($path)) != null)
            and ($request.expectedOutputs | index($request.graph.topOutput) != null)
            and ($request.publicCacheCuts | type == "array")
          ' "$manifest_file" >/dev/null 2>&1; then
          (( skipped_invalid += 1 ))
          continue
        fi
        if ! validate_cache_cuts "$manifest_file"; then
          (( skipped_invalid += 1 ))
          continue
        fi
        if ! validate_persisted_roots; then
          (( skipped_invalid += 1 ))
          continue
        fi
        if ! validate_heartbeat; then
          (( skipped_invalid += 1 ))
          continue
        fi
        if ! acquire_active_lock; then
          active_lock_directory="$request_root/active.lock"
          if [[ -L "$active_lock_directory" || ! -d "$active_lock_directory" ]]; then
            (( skipped_invalid += 1 ))
            continue
          fi
          if active_lock_is_live; then
            (( skipped_active += 1 ))
            continue
          fi
          if ! "$rm" -rf -- "$active_lock_directory" 2>/dev/null \
            || ! acquire_active_lock; then
            (( failed += 1 ))
            continue
          fi
        fi
        if [[ "$heartbeat_present" != true ]]; then
          release_active_state
          (( skipped_invalid += 1 ))
          continue
        fi
         if now_value="$(read_now 2>/dev/null)"; then
           :
         else
           now_status="$?"
           release_active_state
           if [[ "$now_status" == 2 ]]; then
             (( skipped_invalid += 1 ))
           else
             (( failed += 1 ))
           fi
           continue
         fi
         if decimal_is_greater "$heartbeat_timestamp" "$now_value"; then
           release_active_state
           (( skipped_invalid += 1 ))
           continue
         fi
         if ! expiry_timestamp="$(decimal_add "$heartbeat_timestamp" "$idle_ttl_seconds" 2>/dev/null)"; then
           release_active_state
           (( skipped_invalid += 1 ))
           continue
         fi
         if ! decimal_is_greater "$now_value" "$expiry_timestamp"; then
           release_active_state
           (( skipped_fresh += 1 ))
           continue
        fi
        if "$rm" -rf -- "$request_root" 2>/dev/null \
          && [[ ! -e "$request_root" && ! -L "$request_root" ]]; then
          active_lock_acquired=false
          active_lock_directory=""
          (( removed += 1 ))
        else
          release_active_state
          (( failed += 1 ))
        fi
      done

      emit_cleanup_success "$scanned" "$removed" "$skipped_active" "$skipped_fresh" \
        "$skipped_invalid" "$failed"
    }
    trap cleanup_on_exit EXIT

    lease_operation=""
    if (( $# == 1 )) && [[ "$1" == create ]]; then
      lease_operation=create
    elif (( $# == 2 )) && [[ "$1" == prepare || "$1" == keepalive || "$1" == release ]]; then
      lease_operation="$1"
      response_operation="$1"
      operation_token="$2"
      if [[ ! "$operation_token" =~ ^srb1-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-[0-9a-f]{64}$ ]]; then
        emit_failure ineligible "invalid token" "lease token was not accepted"
        exit 0
      fi
      operation_nonce="''${BASH_REMATCH[1]}"
    elif (( $# == 1 )) && [[ "$1" == cleanup ]]; then
      lease_operation=cleanup
      response_operation=cleanup
    else
      emit_failure ineligible "unsupported operation" "lease operation is not available"
      exit 0
    fi

    current_uid="$($id_command -u 2>/dev/null)" || {
      emit_failure error "authorization failure" "lease ownership could not be verified"
      exit 1
    }
    if [[ "$current_uid" != "$owner_uid" ]]; then
      emit_failure ineligible "authorization failure" "lease ownership was not authorized"
      exit 0
    fi

    canonical_parent="$($realpath "$state_directory" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent could not be canonicalized"
      exit 1
    }
    if [[ ! -d "$canonical_parent" || -L "$canonical_parent" ]]; then
      emit_failure error "internal lease failure" "lease state parent is not a directory"
      exit 1
    fi
    parent_mode="$($stat -c '%a' -- "$canonical_parent" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent ownership could not be checked"
      exit 1
    }
    parent_owner="$($stat -c '%u' -- "$canonical_parent" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent ownership could not be checked"
      exit 1
    }
    if [[ "$parent_mode" != 700 || "$parent_owner" != "$owner_uid" ]]; then
      emit_failure ineligible "authorization failure" "lease state parent ownership was not authorized"
      exit 0
    fi

    if [[ "$lease_operation" == cleanup ]]; then
      cleanup_leases
      exit 0
    fi

    if [[ "$lease_operation" == prepare || "$lease_operation" == keepalive || "$lease_operation" == release ]]; then
      request_root="$canonical_parent/$operation_nonce"
      if [[ -L "$request_root" || ! -d "$request_root" ]]; then
        emit_failure ineligible "lease state missing" "lease request state is unavailable"
        exit 0
      fi
      request_root_canonical="$($realpath "$request_root" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request state is unavailable"
        exit 0
      }
      if [[ "$request_root_canonical" != "$request_root" ]]; then
        emit_failure ineligible "lease state invalid" "lease request state is unavailable"
        exit 0
      fi
      request_mode="$($stat -c '%a' -- "$request_root" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request state is unavailable"
        exit 0
      }
      request_owner="$($stat -c '%u' -- "$request_root" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request state is unavailable"
        exit 0
      }
      if [[ "$request_mode" != 700 || "$request_owner" != "$owner_uid" ]]; then
        emit_failure ineligible "authorization failure" "lease request state was not authorized"
        exit 0
      fi
      roots_directory="$request_root/roots"
      if [[ -L "$roots_directory" || ! -d "$roots_directory" ]]; then
        emit_failure ineligible "lease state invalid" "lease request roots are unavailable"
        exit 0
      fi
      roots_directory_canonical="$($realpath "$roots_directory" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request roots are unavailable"
        exit 0
      }
      if [[ "$roots_directory_canonical" != "$roots_directory" ]]; then
        emit_failure ineligible "lease state invalid" "lease request roots are unavailable"
        exit 0
      fi
      roots_mode="$($stat -c '%a' -- "$roots_directory" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request roots are unavailable"
        exit 0
      }
      roots_owner="$($stat -c '%u' -- "$roots_directory" 2>/dev/null)" || {
        emit_failure ineligible "authorization failure" "lease request roots were not authorized"
        exit 0
      }
      if [[ "$roots_mode" != 700 || "$roots_owner" != "$owner_uid" ]]; then
        emit_failure ineligible "authorization failure" "lease request roots were not authorized"
        exit 0
      fi
      manifest_file="$request_root/manifest.json"
      if [[ -L "$manifest_file" || ! -f "$manifest_file" ]]; then
        emit_failure ineligible "lease state missing" "lease request manifest is unavailable"
        exit 0
      fi
      manifest_mode="$($stat -c '%a' -- "$manifest_file" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request manifest is unavailable"
        exit 0
      }
      manifest_owner="$($stat -c '%u' -- "$manifest_file" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request manifest is unavailable"
        exit 0
      }
      if [[ "$manifest_mode" != 600 || "$manifest_owner" != "$owner_uid" ]]; then
        emit_failure ineligible "authorization failure" "lease request manifest was not authorized"
        exit 0
      fi
      temporary_root="$($mktemp -d "''${TMPDIR:-/tmp}/shopify-remote-builder-lease.XXXXXX" 2>/dev/null)" || {
        emit_failure error "internal lease failure" "lease request state could not be prepared"
        exit 1
      }
      normalized_request_file="$temporary_root/normalized-request.json"
      if [[ "$lease_operation" == prepare ]]; then
        prepare_created_markers_file="$temporary_root/created-markers"
        "$touch" "$prepare_created_markers_file" 2>/dev/null || {
          emit_failure error "internal lease failure" "lease request state could not be prepared"
          exit 1
        }
      fi
      request_input_file="$manifest_file"
    else
      temporary_root="$($mktemp -d "''${TMPDIR:-/tmp}/shopify-remote-builder-lease.XXXXXX" 2>/dev/null)" || {
        emit_failure error "internal lease failure" "lease request state could not be created"
        exit 1
      }
      request_file="$temporary_root/request.json"
      normalized_request_file="$temporary_root/normalized-request.json"
      rooted_paths_file="$temporary_root/rooted-paths"
      request_input_file="$request_file"

      request_read_limit=$((max_request_bytes + 1))
      "$head" -c "$request_read_limit" >"$request_file" 2>/dev/null || {
        emit_failure error "internal lease failure" "lease request could not be read"
        exit 1
      }
      request_bytes="$($wc -c <"$request_file" 2>/dev/null)" || {
        emit_failure error "internal lease failure" "lease request size could not be checked"
        exit 1
      }
      request_bytes="''${request_bytes//[[:space:]]/}"
      if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
        emit_failure ineligible "resource limit" "lease request exceeded a validation limit"
        exit 0
      fi
    fi

    if ! "$jq" -cS -e -s \
      --arg expectedParent "$canonical_parent" \
      --argjson ownerUid "$owner_uid" \
      --argjson maxPaths "$max_paths" \
      '
        def exact_object($required; $allowed):
          . as $object
          | ($object | type == "object")
          and ((($object | keys) - $allowed) | length) == 0
          and all($required[]; . as $key | ($object | has($key)));
        def valid_digest:
          type == "string" and test("^sha256:[0-9a-f]{64}$");
        def valid_nonce:
          type == "string"
          and utf8bytelength > 0
          and utf8bytelength <= 128
          and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
        def valid_token($nonce):
          type == "string"
          and utf8bytelength > 0
          and utf8bytelength <= 256
          and test("^srb1-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[0-9a-f]{64}$")
          and startswith("srb1-" + $nonce + "-");
        def valid_store_path:
          type == "string"
          and utf8bytelength <= 266
          and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+-]+$");
        def sorted_unique:
          . == (sort | unique);
        def valid_path_array:
          type == "array"
          and sorted_unique
          and all(.[]; valid_store_path);
        def valid_uid:
          type == "number" and isfinite and floor == . and . >= 0;
        if length != 1 then
          error("one request object required")
        else
          .[0] as $request
          | ($request.graph // {}) as $graph
          | ($request.nonce // "") as $nonce
          | ($expectedParent + "/" + $nonce) as $expectedRoot
          | if ($request | exact_object(
              [
                "schemaVersion",
                "operation",
                "nonce",
                "token",
                "requestParent",
                "ownership",
                "authorization",
                "graphDigest",
                "graph",
                "rootedPaths",
                "rootDestinations",
                "selectedInputOutputs",
                "expectedOutputs",
                "publicCacheCuts"
              ];
              [
                "schemaVersion",
                "operation",
                "nonce",
                "token",
                "requestParent",
                "ownership",
                "authorization",
                "graphDigest",
                "graph",
                "rootedPaths",
                "rootDestinations",
                "selectedInputOutputs",
                "expectedOutputs",
                "publicCacheCuts"
              ]
            ) | not)
            or $request.schemaVersion != 1
            or $request.operation != "create"
            or ($nonce | valid_nonce | not)
            or ($request.token | valid_token($nonce) | not)
            or $request.requestParent != $expectedParent
            or ($request.ownership
              | exact_object(["uid"]; ["uid"]) | not)
            or ($request.ownership.uid | valid_uid | not)
            or $request.ownership.uid != $ownerUid
            or ($request.authorization
              | exact_object(["uid", "operation", "channel"]; ["uid", "operation", "channel"]) | not)
            or ($request.authorization.uid | valid_uid | not)
            or $request.authorization.uid != $ownerUid
            or $request.authorization.operation != "create"
            or $request.authorization.channel != "local-pipe"
            or ($request.graphDigest | valid_digest | not)
            or ($graph
              | exact_object(
                ["digest", "paths", "outputPaths", "referenceClosures", "topOutput"];
                ["digest", "paths", "outputPaths", "referenceClosures", "topOutput"]
              ) | not)
            or ($graph.digest | valid_digest | not)
            or $graph.digest != $request.graphDigest
            or ($graph.paths | valid_path_array | not)
            or ($graph.paths | length == 0 or length > $maxPaths)
            or ($graph.outputPaths | valid_path_array | not)
            or ($graph.outputPaths | length == 0)
            or ($graph.topOutput | valid_store_path | not)
            or (($graph.paths | index($graph.topOutput)) == null)
            or (($graph.outputPaths | index($graph.topOutput)) == null)
            or ($graph.outputPaths | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            or ($graph.referenceClosures | type != "object")
            or (($graph.referenceClosures | keys) | any(.[]; valid_store_path | not))
            or ($graph.referenceClosures | to_entries | any(.[];
              . as $entry
              | ($entry.value | valid_path_array | not)
                or (($entry.value | index($entry.key)) == null)
                or ($entry.value | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            ))
            or ($request.rootedPaths | valid_path_array | not)
            or ($request.rootedPaths | length == 0 or length > $maxPaths)
            or ($request.rootedPaths | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            or ($request.selectedInputOutputs | valid_path_array | not)
            or ($request.selectedInputOutputs | length == 0 or length > $maxPaths)
            or ($request.selectedInputOutputs | any(.[];
              . as $path
              | ($graph.outputPaths | index($path)) == null or $path == $graph.topOutput))
            or ($request.expectedOutputs | valid_path_array | not)
            or ($request.expectedOutputs | length == 0 or length > $maxPaths)
            or ($request.expectedOutputs | any(.[]; . as $path | ($graph.outputPaths | index($path)) == null))
            or (($request.expectedOutputs | index($graph.topOutput)) == null)
             or ($request.selectedInputOutputs | any(.[];
               . as $path
               | ($request.rootedPaths | index($path)) == null
             ))
             or ($request.expectedOutputs | any(.[];
               . as $path
               | ($request.rootedPaths | index($path)) == null
             ))
            or ($request.rootDestinations | type != "array")
            or ($request.rootDestinations | length != ($request.rootedPaths | length))
            or ($request.rootDestinations | map(.storePath) != (map(.storePath) | sort | unique))
            or ($request.rootDestinations | any(.[];
              . as $root
              | ($root | exact_object(["storePath", "destination"]; ["storePath", "destination"]) | not)
              or ($root.storePath | valid_store_path | not)
              or (($request.rootedPaths | index($root.storePath)) == null)
              or ($root.destination != ($expectedRoot + "/roots/" + ($root.storePath | split("/") | .[-1])))
            ))
            or ($request.publicCacheCuts | type != "array")
            or ($request.publicCacheCuts | length > $maxPaths)
            or ($request.publicCacheCuts | map(.rootPath) != (map(.rootPath) | sort | unique))
            or ($request.publicCacheCuts | any(.[];
              . as $cut
              | ($cut | exact_object(["rootPath", "closure", "closureDigest"];
                ["rootPath", "closure", "closureDigest"]) | not)
              or ($cut.rootPath | valid_store_path | not)
              or $cut.rootPath == $graph.topOutput
              or (($graph.paths | index($cut.rootPath)) == null)
              or ($cut.closure | valid_path_array | not)
              or ($cut.closureDigest | valid_digest | not)
              or (($graph.referenceClosures[$cut.rootPath] // null) != $cut.closure)
            or ($cut.closure | any(.[]; . as $path | ($request.rootedPaths | index($path)) == null))
            ))
            then
              error("lease request schema rejected")
            else
              $request
            end
        end
      ' "$request_input_file" >"$normalized_request_file" 2>/dev/null; then
      emit_failure ineligible "schema drift" "lease request rejected"
      exit 0
    fi

    if [[ "$lease_operation" != create ]]; then
      nonce="$($jq -r '.nonce' "$normalized_request_file" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request manifest is unavailable"
        exit 0
      }
      manifest_token="$($jq -r '.token' "$normalized_request_file" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request manifest is unavailable"
        exit 0
      }
      manifest_digest="$($jq -r '.graphDigest' "$normalized_request_file" 2>/dev/null)" || {
        emit_failure ineligible "lease state invalid" "lease request manifest is unavailable"
        exit 0
      }
      if [[ "$nonce" != "$operation_nonce" || "$manifest_token" != "$operation_token" ]]; then
        emit_failure ineligible "token mismatch" "lease request token was not accepted"
        exit 0
      fi
      if ! validate_cache_cuts "$normalized_request_file"; then
        emit_failure ineligible "cache cut mismatch" "lease request rejected"
        exit 0
      fi

      if [[ "$lease_operation" == prepare ]]; then
        root_validation_failed=false
        while IFS= read -r root_record; do
          store_path="$($jq -r '.storePath' <<<"$root_record" 2>/dev/null)" || {
            root_validation_failed=true
            break
          }
          root_destination="$($jq -r '.destination' <<<"$root_record" 2>/dev/null)" || {
            root_validation_failed=true
            break
          }
          root_marker="$roots_directory/''${store_path##*/}"
          if [[ "$root_destination" != "$root_marker" || "$root_marker" != "$roots_directory/"* ]]; then
            root_validation_failed=true
            break
          fi
          if [[ -e "$root_marker" ]]; then
            if ! verify_root_marker "$store_path" "$root_marker"; then
              root_validation_failed=true
              break
            fi
          elif [[ -L "$root_marker" ]]; then
            link_target="$($readlink "$root_marker" 2>/dev/null)" || {
              root_validation_failed=true
              break
            }
            if [[ "$link_target" != "$store_path" ]]; then
              root_validation_failed=true
              break
            fi
          fi
        done < <("$jq" -c '.rootDestinations[]' "$normalized_request_file" 2>/dev/null)
        if [[ "$root_validation_failed" == true ]]; then
          emit_failure ineligible "root operation failed" "lease roots could not be validated"
          exit 0
        fi

        selected_paths_file="$temporary_root/selected-inputs"
        expected_paths_file="$temporary_root/expected-outputs"
        if ! "$jq" -r '.selectedInputOutputs[]' "$normalized_request_file" >"$selected_paths_file" 2>/dev/null \
          || ! "$jq" -r '.expectedOutputs[]' "$normalized_request_file" >"$expected_paths_file" 2>/dev/null; then
          emit_failure error "internal lease failure" "lease paths could not be prepared"
          exit 1
        fi

        mapfile -t selected_paths <"$selected_paths_file"
        if ! "$selected_input_realizer" --realise "''${selected_paths[@]}" \
          >/dev/null 2>/dev/null; then
          emit_failure error "selected input realization failed" "lease inputs could not be prepared"
          exit 1
        fi

        selected_root_failed=false
        while IFS= read -r store_path; do
          root_marker="$roots_directory/''${store_path##*/}"
          if [[ -e "$root_marker" ]]; then
            if ! verify_root_marker "$store_path" "$root_marker"; then
              selected_root_failed=true
              break
            fi
            continue
          fi
          if [[ -L "$root_marker" ]] && ! "$rm" -f -- "$root_marker" 2>/dev/null; then
            selected_root_failed=true
            break
          fi
          if ! printf '%s\n' "$root_marker" >>"$prepare_created_markers_file"; then
            selected_root_failed=true
            break
          fi
          if ! "$root_adder" --add-root "$root_marker" --indirect --realise "$store_path" \
            >/dev/null 2>/dev/null \
            || ! verify_root_marker "$store_path" "$root_marker"; then
            selected_root_failed=true
            break
          fi
        done <"$selected_paths_file"
        if [[ "$selected_root_failed" == true ]]; then
          emit_failure error "root operation failed" "lease roots could not be created"
          exit 1
        fi

        top_output_failed=false
        while IFS= read -r store_path; do
          root_marker="$roots_directory/''${store_path##*/}"
          if [[ -e "$root_marker" ]]; then
            if ! verify_root_marker "$store_path" "$root_marker"; then
              top_output_failed=true
              break
            fi
            continue
          fi
          if [[ -L "$root_marker" ]] && ! "$rm" -f -- "$root_marker" 2>/dev/null; then
            top_output_failed=true
            break
          fi
          if ! printf '%s\n' "$root_marker" >>"$prepare_created_markers_file"; then
            top_output_failed=true
            break
          fi
          if ! "$expected_output_primer" --add-root "$root_marker" --realise "$store_path" \
            >/dev/null 2>/dev/null \
            || ! verify_root_marker_target "$store_path" "$root_marker"; then
            top_output_failed=true
            break
          fi
        done <"$expected_paths_file"
        if [[ "$top_output_failed" == true ]]; then
          emit_failure error "top output priming failed" "expected outputs could not be prepared"
          exit 1
        fi

        prepare_succeeded=true
        keep_request_root=true
        emit_prepare_success
        exit 0
      fi

      if ! validate_persisted_roots || ! validate_heartbeat; then
        emit_failure ineligible "lease state invalid" "lease request state could not be validated"
        exit 0
      fi

      if [[ "$lease_operation" == keepalive ]]; then
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM
        if ! acquire_active_lock; then
          emit_failure ineligible "lease active" "lease is already held"
          exit 0
        fi
        heartbeat_now="$(read_now 2>/dev/null)" || {
          emit_failure error "heartbeat failure" "lease heartbeat could not be started"
          exit 1
        }
        if ! write_heartbeat "$heartbeat_now"; then
          emit_failure error "heartbeat failure" "lease heartbeat could not be started"
          exit 1
        fi
        keep_request_root=true
        emit_keepalive_ack
        while true; do
          read_status=0
          IFS= read -r -t "$heartbeat_seconds" || read_status="$?"
          if [[ "$read_status" == 1 ]]; then
            break
          fi
          heartbeat_now="$(read_now 2>/dev/null)" || {
            emit_failure error "heartbeat failure" "lease heartbeat could not be refreshed"
            exit 1
          }
          if ! write_heartbeat "$heartbeat_now"; then
            emit_failure error "heartbeat failure" "lease heartbeat could not be refreshed"
            exit 1
          fi
        done
        exit 0
      fi

      if [[ "$lease_operation" == release ]]; then
        if ! acquire_active_lock; then
          emit_failure ineligible "lease active" "lease is already held"
          exit 0
        fi
        if ! "$rm" -rf -- "$request_root" 2>/dev/null \
          || [[ -e "$request_root" || -L "$request_root" ]]; then
          emit_failure error "release failed" "lease roots could not be released"
          exit 1
        fi
        active_lock_acquired=false
        active_lock_directory=""
        emit_release_success
        exit 0
      fi
    fi

    nonce="$($jq -r '.nonce' "$normalized_request_file")"
    request_root="$canonical_parent/$nonce"
    if [[ -e "$request_root" || -L "$request_root" ]]; then
      emit_failure ineligible "lease state exists" "lease request state already exists"
      exit 0
    fi

    if ! "$jq" -r '.rootedPaths[]' "$normalized_request_file" >"$rooted_paths_file" 2>/dev/null; then
      emit_failure error "internal lease failure" "lease paths could not be materialized"
      exit 1
    fi

    if ! validate_cache_cuts "$normalized_request_file"; then
      emit_failure ineligible "cache cut mismatch" "lease request rejected"
      exit 0
    fi

    if ! "$mkdir" -- "$request_root" 2>/dev/null; then
      emit_failure ineligible "lease state exists" "lease request state already exists"
      exit 0
    fi
    created_request_root=true
    "$chmod_command" 700 -- "$request_root" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease request state could not be secured"
      exit 1
    }
    roots_directory="$request_root/roots"
    "$mkdir" -- "$roots_directory" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease root directory could not be created"
      exit 1
    }
    "$chmod_command" 700 -- "$roots_directory" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease root directory could not be secured"
      exit 1
    }

    root_operation_failed=false
    while IFS= read -r store_path; do
      root_marker="$roots_directory/''${store_path##*/}"
      if [[ -L "$roots_directory" || "$root_marker" != "$roots_directory/"* ]]; then
        root_operation_failed=true
        break
      fi
      if ! "$root_adder" --add-root "$root_marker" --indirect --realise "$store_path" \
        >/dev/null 2>/dev/null; then
        root_operation_failed=true
        break
      fi
      link_target="$($readlink "$root_marker" 2>/dev/null)" || {
        root_operation_failed=true
        break
      }
      if [[ "$link_target" != "$store_path" ]]; then
        root_operation_failed=true
        break
      fi
    done <"$rooted_paths_file"
    if [[ "$root_operation_failed" == true ]]; then
      emit_failure error "root operation failed" "lease roots could not be created"
      exit 1
    fi

    manifest_tmp="$request_root/manifest.json.tmp"
    if ! "$jq" -cS '.' "$normalized_request_file" >"$manifest_tmp" 2>/dev/null; then
      emit_failure error "internal lease failure" "lease manifest could not be written"
      exit 1
    fi
    "$chmod_command" 600 -- "$manifest_tmp" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease manifest could not be secured"
      exit 1
    }
    "$mv" -- "$manifest_tmp" "$request_root/manifest.json" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease manifest could not be committed"
      exit 1
    }
    created_at="$(read_now 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state timestamp could not be recorded"
      exit 1
    }
    "$touch" -d "@$created_at" -- "$request_root/manifest.json" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease state timestamp could not be recorded"
      exit 1
    }

    keep_request_root=true
    emit_success
    exit 0
  '';
}
