{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  stateDirectory ? "/var/db/shopify-remote-builder/requests",
  ownerUid ? 502,
  rootAdderExecutable ? "/run/current-system/sw/bin/nix-store",
  leaseManagerExecutable ? "/run/current-system/sw/bin/shopify-remote-builder-lease",
  nativeCacheMaterializerExecutable ? "/run/current-system/sw/bin/nix",
  targetStoreDirectory ? "/nix/store",
  targetStoreUri ? "local",
  approvedCacheConfigurations ? [
    {
      endpoint = "https://cache.nixos.org";
      trustedKeys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      ];
    }
    {
      endpoint = "https://nix-community.cachix.org";
      trustedKeys = [
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    }
  ],
  policyProxyPort ? 1080,
  nowExecutable ? "${coreutils}/bin/date",
  idleTtlSeconds ? 60 * 60,
  maxRequestBytes ? 1024 * 1024,
  maxPaths ? 10000,
  maxDiagnosticBytes ? 64 * 1024,
  maxNativeOutputBytes ? 16 * 1024 * 1024,
  queryTimeoutSeconds ? 30,
}:
let
  endpointPattern = "https://[A-Za-z0-9][A-Za-z0-9.-]*";
  trustedKeyPattern = "[A-Za-z0-9._-]+:[A-Za-z0-9+/=_-]+";
  validCacheConfiguration =
    cache:
    lib.isAttrs cache
    && lib.isString (cache.endpoint or null)
    && builtins.match endpointPattern cache.endpoint != null
    && lib.isList (cache.trustedKeys or null)
    && cache.trustedKeys != [ ]
    && lib.all (
      key: lib.isString key && builtins.match trustedKeyPattern key != null
    ) cache.trustedKeys;
in
assert lib.isString stateDirectory;
assert stateDirectory != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" stateDirectory != null;
assert lib.isInt ownerUid;
assert ownerUid >= 0;
assert lib.isString rootAdderExecutable;
assert rootAdderExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" rootAdderExecutable != null;
assert lib.isString leaseManagerExecutable;
assert leaseManagerExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" leaseManagerExecutable != null;
assert lib.isString nativeCacheMaterializerExecutable;
assert nativeCacheMaterializerExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" nativeCacheMaterializerExecutable != null;
assert lib.isString targetStoreDirectory;
assert targetStoreDirectory != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" targetStoreDirectory != null;
assert lib.isString targetStoreUri;
assert targetStoreUri != "";
assert lib.isString nowExecutable;
assert nowExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" nowExecutable != null;
assert lib.isList approvedCacheConfigurations;
assert approvedCacheConfigurations != [ ];
assert lib.all validCacheConfiguration approvedCacheConfigurations;
assert
  lib.length (lib.unique (map (cache: cache.endpoint) approvedCacheConfigurations))
  == lib.length approvedCacheConfigurations;
assert lib.isInt ownerUid;
assert lib.isInt policyProxyPort;
assert policyProxyPort > 1023;
assert policyProxyPort <= 65535;
assert lib.isInt idleTtlSeconds;
assert idleTtlSeconds > 0;
assert lib.isInt maxRequestBytes;
assert maxRequestBytes > 0;
assert lib.isInt maxPaths;
assert maxPaths > 0;
assert lib.isInt maxDiagnosticBytes;
assert maxDiagnosticBytes > 0;
assert lib.isInt maxNativeOutputBytes;
assert maxNativeOutputBytes > 0;
assert lib.isInt queryTimeoutSeconds;
assert queryTimeoutSeconds > 0;
let
  coreutilsBin = "${coreutils}/bin";
  jqExecutable = "${jq}/bin/jq";
  safePath = lib.makeBinPath [
    coreutils
    jq
  ];
in
writeShellApplication {
  name = "shopify-remote-builder-cache-materializer";
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

        cut=${lib.escapeShellArg "${coreutilsBin}/cut"}
        env_command=${lib.escapeShellArg "${coreutilsBin}/env"}
        head=${lib.escapeShellArg "${coreutilsBin}/head"}
        id_command=${lib.escapeShellArg "${coreutilsBin}/id"}
        jq=${lib.escapeShellArg jqExecutable}
        mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
        mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
        native=${lib.escapeShellArg nativeCacheMaterializerExecutable}
        now_command=${lib.escapeShellArg nowExecutable}
        readlink=${lib.escapeShellArg "${coreutilsBin}/readlink"}
        realpath=${lib.escapeShellArg "${coreutilsBin}/realpath"}
        rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
        root_adder=${lib.escapeShellArg rootAdderExecutable}
        sha256sum=${lib.escapeShellArg "${coreutilsBin}/sha256sum"}
        stat=${lib.escapeShellArg "${coreutilsBin}/stat"}
        touch=${lib.escapeShellArg "${coreutilsBin}/touch"}
        timeout=${lib.escapeShellArg "${coreutilsBin}/timeout"}
        wc=${lib.escapeShellArg "${coreutilsBin}/wc"}
        lease_manager=${lib.escapeShellArg leaseManagerExecutable}
        safe_path=${lib.escapeShellArg safePath}
        state_directory=${lib.escapeShellArg stateDirectory}
        owner_uid=${toString ownerUid}
        target_store_directory=${lib.escapeShellArg targetStoreDirectory}
        target_store_uri=${lib.escapeShellArg targetStoreUri}
        approved_cache_configurations=${lib.escapeShellArg (builtins.toJSON approvedCacheConfigurations)}
        policy_proxy_endpoint="socks5h://127.0.0.1:${toString policyProxyPort}"
        idle_ttl_seconds=${toString idleTtlSeconds}
        max_request_bytes=${toString maxRequestBytes}
        max_paths=${toString maxPaths}
        max_diagnostic_bytes=${toString maxDiagnosticBytes}
        max_native_output_bytes=${toString maxNativeOutputBytes}
        query_timeout_seconds=${toString queryTimeoutSeconds}
        max_timestamp=9007199254740991

        temporary_root=""
        request_file=""
        manifest_file=""
        normalized_manifest_file=""
        closure_file=""
        rooted_paths_file=""
        fetched_paths_file=""
        cut_file=""
        request_root=""
        roots_directory=""
        lease_token=""
        nonce=""
        graph_digest=""
        top_output=""
        endpoint=""
        trusted_keys=""
        signing_key_id=""
        native_config=""
        lease_valid=false
        success=false
        released=false
        failure_reason=""

        emit_failure() {
          local decision="$1"
          local reason="$2"
          local detail="$3"
          "$jq" -n -cS \
            --arg decision "$decision" \
            --arg reason "$reason" \
            --arg detail "$detail" \
            '{
              schemaVersion: 1,
              decision: $decision,
              reason: $reason,
              nonce: null,
              leaseToken: null,
              detail: $detail
            }'
        }

        emit_success() {
          local closure_json
          local cuts_json
          closure_json="$($jq -R -s -c 'split("\n") | map(select(length > 0))' "$closure_file")"
          cuts_json="$($jq -cS '.' "$cut_file")"
          "$jq" -n -cS \
            --arg nonce "$nonce" \
            --arg leaseToken "$lease_token" \
            --arg graphDigest "$graph_digest" \
            --argjson closure "$closure_json" \
            --argjson publicCacheCuts "$cuts_json" \
            '{
              schemaVersion: 1,
              decision: "materialized",
              nonce: $nonce,
               leaseToken: $leaseToken,
               graphDigest: $graphDigest,
               publicCacheCuts: $publicCacheCuts,
               rootedPaths: $closure,
              detail: null
            }'
        }

        path_in_file() {
          local candidate="$1"
          local file="$2"
          while IFS= read -r existing; do
            if [[ "$existing" == "$candidate" ]]; then
              return 0
            fi
          done <"$file"
          return 1
        }

        encode_store_path_argument() {
          local store_path="$1"
          local store_name="''${store_path##*/}"
          store_name="''${store_name//\?/%3F}"
          store_name="''${store_name//=/%3D}"
          printf '/nix/store/%s' "$store_name"
        }

        normalize_timestamp() {
          local value="$1"
          [[ "$value" =~ ^[0-9]+$ ]] || return 1
          while [[ "$value" == 0* && "$value" != 0 ]]; do
            value="''${value#0}"
          done
          # shellcheck disable=SC2071
          if [[ "''${#value}" -gt "''${#max_timestamp}" ]] \
            || [[ "''${#value}" == "''${#max_timestamp}" && "$value" > "$max_timestamp" ]]; then
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

        release_lease() {
          if [[ "$lease_valid" != true || "$released" == true ]]; then
            return 0
          fi
          local release_response=""
          release_response="$($env_command -i \
            "HOME=$temporary_root/home" \
            "LANG=C" \
            "LC_ALL=C" \
            "PATH=$safe_path" \
            "TMPDIR=$temporary_root" \
            "$lease_manager" release "$lease_token" 2>/dev/null || true)"
          if ! "$jq" -e '.decision == "released"' <<<"$release_response" >/dev/null 2>&1; then
            printf '%s\n' \
              'lease release was not confirmed; lease state was retained for TTL or explicit release' >&2
          fi
          released=true
        }

        cleanup_fetched_paths() {
          [[ -n "$fetched_paths_file" && -f "$fetched_paths_file" ]] || return 0
          local encoded_store_path
          while IFS= read -r store_path; do
            [[ -n "$store_path" ]] || continue
            encoded_store_path="$(encode_store_path_argument "$store_path")" || continue
            native_run "$temporary_root/cleanup.stdout" "$temporary_root/cleanup.stderr" \
              store delete --store "$target_store_uri" --ignore-liveness \
              "$encoded_store_path" >/dev/null 2>&1 || true
          done <"$fetched_paths_file"
        }

        cleanup() {
          local status="$?"
          if [[ "$success" != true ]]; then
            cleanup_fetched_paths
            release_lease
          fi
          if [[ -n "$temporary_root" ]]; then
            "$rm" -rf -- "$temporary_root" 2>/dev/null || true
          fi
          return "$status"
        }
        trap cleanup EXIT

        native_run() {
          local stdout_file="$1"
          local stderr_file="$2"
          shift 2
          local native_status
          : >"$stdout_file"
          : >"$stderr_file"
          set +e
          "$env_command" -i \
            "HOME=$temporary_root/home" \
            "LANG=C" \
            "LC_ALL=C" \
            "PATH=$safe_path" \
            "TMPDIR=$temporary_root" \
            "XDG_CACHE_HOME=$temporary_root/xdg-cache" \
            "XDG_CONFIG_HOME=$temporary_root/xdg-config" \
            "XDG_DATA_HOME=$temporary_root/xdg-data" \
            "XDG_STATE_HOME=$temporary_root/xdg-state" \
            "NIX_CACHE_DIR=$temporary_root/nix-cache" \
            "NIX_CONFIG_HOME=$temporary_root/nix-config-home" \
            "NIX_CONF_DIR=$temporary_root/nix-conf" \
            "NIX_LOG_DIR=$temporary_root/nix-log" \
            "NIX_STATE_DIR=$temporary_root/nix-state" \
            "NIX_USER_CONF_FILES=/dev/null" \
            "_NIX_FORCE_HTTP=1" \
            "NIX_CONFIG=$native_config" \
            "ALL_PROXY=$policy_proxy_endpoint" \
            "HTTP_PROXY=$policy_proxy_endpoint" \
            "HTTPS_PROXY=$policy_proxy_endpoint" \
            "all_proxy=$policy_proxy_endpoint" \
            "http_proxy=$policy_proxy_endpoint" \
            "https_proxy=$policy_proxy_endpoint" \
            "NO_PROXY=" \
            "no_proxy=" \
            "$timeout" --signal=TERM --kill-after=1s "''${query_timeout_seconds}s" \
            "$native" "$@" >"$stdout_file" 2>"$stderr_file"
          native_status=$?
          set -e
          local stdout_bytes
          local stderr_bytes
          stdout_bytes="$($wc -c <"$stdout_file" 2>/dev/null)" || return 125
          stderr_bytes="$($wc -c <"$stderr_file" 2>/dev/null)" || return 125
          stdout_bytes="''${stdout_bytes//[[:space:]]/}"
          stderr_bytes="''${stderr_bytes//[[:space:]]/}"
          [[ "$stdout_bytes" =~ ^[0-9]+$ && "$stderr_bytes" =~ ^[0-9]+$ ]] || return 125
          if (( stdout_bytes > max_native_output_bytes || stderr_bytes > max_diagnostic_bytes )); then
            failure_reason="resource limit"
            return 125
          fi
          return "$native_status"
        }

        native_path_info() {
          local store_path="$1"
          local store_name="''${store_path##*/}"
          local raw_file="$temporary_root/$store_name.path-info.raw"
          local stderr_file="$temporary_root/$store_name.path-info.stderr"
          local record_file="$temporary_root/$store_name.path-info.json"
          local encoded_path
          encoded_path="$(encode_store_path_argument "$store_path")" || {
            failure_reason="native verification failed"
            return 1
          }
          if ! native_run "$raw_file" "$stderr_file" \
            path-info --json --json-format 1 --sigs --store "$target_store_uri" "$encoded_path"; then
            failure_reason="native verification failed"
            return 1
          fi
          if ! "$jq" -cS --arg expectedPath "$store_path" '
            if type != "object" or (keys | length) != 1 or (has($expectedPath) | not) then
              error("path metadata identity mismatch")
            else
              .[$expectedPath] as $info
              | if ($info | type) != "object"
                  or (($info | has("narHash")) | not)
                  or (($info | has("narSize")) | not)
                  or (($info | has("references")) | not)
                  or (($info | has("signatures")) | not)
                then
                  error("path metadata is incomplete")
                else
                  {
                    storePath: $expectedPath,
                    narHash: $info.narHash,
                    narSize: $info.narSize,
                    references: $info.references,
                    signatures: $info.signatures
                  }
                end
            end
          ' "$raw_file" >"$record_file" 2>/dev/null; then
            failure_reason="native verification failed"
            return 1
          fi
          printf '%s\n' "$record_file"
        }

        native_verify() {
          local store_path="$1"
          local store_name="''${store_path##*/}"
          local stdout_file="$temporary_root/$store_name.verify.stdout"
          local stderr_file="$temporary_root/$store_name.verify.stderr"
          local status=0
          local encoded_path
          encoded_path="$(encode_store_path_argument "$store_path")" || {
            failure_reason="native verification failed"
            return 1
          }
          native_run "$stdout_file" "$stderr_file" \
            store verify --recursive --sigs-needed 1 --store "$target_store_uri" \
            "$encoded_path" || status=$?
          if (( status == 0 )); then
            return 0
          elif (( status == 2 )); then
            failure_reason="signature mismatch"
          elif (( status == 1 )); then
            failure_reason="NAR content mismatch"
          elif [[ "$failure_reason" == "resource limit" ]]; then
            :
          else
            failure_reason="native verification failed"
          fi
          return 1
        }

        fail_ineligible() {
          local reason="$1"
          local detail="$2"
          emit_failure ineligible "$reason" "$detail"
          exit 0
        }

        if (( $# != 2 )) || [[ "$1" != materialize ]]; then
          emit_failure ineligible "unsupported operation" "cache materialization is not available"
          exit 0
        fi
        lease_token="$2"
        if [[ ! "$lease_token" =~ ^srb1-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-([0-9a-f]{64})$ ]]; then
          fail_ineligible "invalid token" "lease token was not accepted"
        fi
        nonce="''${BASH_REMATCH[1]}"

        temporary_root="$($mktemp -d "/tmp/shopify-remote-builder-cache-materializer.XXXXXX" 2>/dev/null)" || {
          emit_failure error "internal materialization failure" "materialization state could not be created"
          exit 1
        }
        temporary_root="$($realpath "$temporary_root" 2>/dev/null)" || {
          emit_failure error "internal materialization failure" "materialization state could not be secured"
          exit 1
        }
        for directory in home xdg-cache xdg-config xdg-data xdg-state nix-cache nix-config-home nix-conf nix-log nix-state; do
          "$mkdir" -p -- "$temporary_root/$directory" || {
            emit_failure error "internal materialization failure" "materialization state could not be initialized"
            exit 1
          }
        done
        request_file="$temporary_root/attestation.json"
        normalized_manifest_file="$temporary_root/manifest.json"
        closure_file="$temporary_root/closure"
        rooted_paths_file="$temporary_root/rooted-paths"
        fetched_paths_file="$temporary_root/fetched-paths"
        cut_file="$temporary_root/cut.json"
        "$touch" "$fetched_paths_file" || {
          emit_failure error "internal materialization failure" "materialization state could not be initialized"
          exit 1
        }

        current_uid="$($id_command -u 2>/dev/null)" || {
          emit_failure error "authorization failure" "lease ownership could not be verified"
          exit 1
        }
        [[ "$current_uid" == "$owner_uid" ]] || fail_ineligible "authorization failure" "lease ownership was not authorized"
        canonical_parent="$($realpath "$state_directory" 2>/dev/null)" || {
          emit_failure error "internal materialization failure" "lease state parent could not be secured"
          exit 1
        }
        parent_mode="$($stat -c '%a' -- "$canonical_parent" 2>/dev/null)" || exit 1
        parent_owner="$($stat -c '%u' -- "$canonical_parent" 2>/dev/null)" || exit 1
        [[ "$canonical_parent" == "$state_directory" && "$parent_mode" == 700 && "$parent_owner" == "$owner_uid" ]] \
          || fail_ineligible "authorization failure" "lease state parent was not authorized"
        request_root="$canonical_parent/$nonce"
        [[ -d "$request_root" && ! -L "$request_root" ]] \
          || fail_ineligible "lease state missing" "lease request state is unavailable"
        request_root_canonical="$($realpath "$request_root" 2>/dev/null)" || fail_ineligible "lease state invalid" "lease request state is unavailable"
        [[ "$request_root_canonical" == "$request_root" ]] || fail_ineligible "lease state invalid" "lease request state is unavailable"
        request_mode="$($stat -c '%a' -- "$request_root" 2>/dev/null)" || fail_ineligible "lease state invalid" "lease request state is unavailable"
        request_owner="$($stat -c '%u' -- "$request_root" 2>/dev/null)" || fail_ineligible "authorization failure" "lease request state was not authorized"
        [[ "$request_mode" == 700 && "$request_owner" == "$owner_uid" ]] || fail_ineligible "authorization failure" "lease request state was not authorized"
        roots_directory="$request_root/roots"
        [[ -d "$roots_directory" && ! -L "$roots_directory" ]] || fail_ineligible "lease state invalid" "lease request roots are unavailable"
        roots_directory_canonical="$($realpath "$roots_directory" 2>/dev/null)" || fail_ineligible "lease state invalid" "lease request roots are unavailable"
        [[ "$roots_directory_canonical" == "$roots_directory" ]] || fail_ineligible "lease state invalid" "lease request roots are unavailable"
        roots_mode="$($stat -c '%a' -- "$roots_directory" 2>/dev/null)" || fail_ineligible "lease state invalid" "lease request roots are unavailable"
        roots_owner="$($stat -c '%u' -- "$roots_directory" 2>/dev/null)" || fail_ineligible "authorization failure" "lease request roots were not authorized"
        [[ "$roots_mode" == 700 && "$roots_owner" == "$owner_uid" ]] || fail_ineligible "authorization failure" "lease request roots were not authorized"
        manifest_file="$request_root/manifest.json"
        [[ -f "$manifest_file" && ! -L "$manifest_file" ]] || fail_ineligible "lease state missing" "lease request manifest is unavailable"
        manifest_mode="$($stat -c '%a' -- "$manifest_file" 2>/dev/null)" || fail_ineligible "lease state invalid" "lease request manifest is unavailable"
        manifest_owner="$($stat -c '%u' -- "$manifest_file" 2>/dev/null)" || fail_ineligible "authorization failure" "lease request manifest was not authorized"
        [[ "$manifest_mode" == 600 && "$manifest_owner" == "$owner_uid" ]] || fail_ineligible "authorization failure" "lease request manifest was not authorized"
        [[ ! -e "$request_root/active.lock" && ! -L "$request_root/active.lock" ]] || fail_ineligible "lease active" "lease is already held"
        [[ ! -e "$request_root/heartbeat.json" && ! -L "$request_root/heartbeat.json" ]] || fail_ineligible "lease active" "lease is already held"

        if ! "$jq" -cS -e \
          --arg expectedParent "$canonical_parent" \
          --arg expectedNonce "$nonce" \
          --arg expectedToken "$lease_token" \
          --argjson ownerUid "$owner_uid" \
          --argjson maxPaths "$max_paths" '
            def digest: type == "string" and test("^sha256:[0-9a-f]{64}$");
            def storePath: type == "string" and utf8bytelength <= 266
              and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+?=-]+$");
            def paths: type == "array" and . == (sort | unique) and all(.[]; storePath);
            . as $request
            | ($request.graph // {}) as $graph
            | ($request | type == "object")
              and (($request | keys | sort) == [
                "authorization", "expectedOutputs", "graph", "graphDigest", "nonce",
                "operation", "ownership", "publicCacheCuts", "requestParent", "rootDestinations",
                "rootedPaths", "schemaVersion", "selectedInputOutputs", "token"
              ])
              and $request.schemaVersion == 1
              and $request.operation == "create"
              and $request.nonce == $expectedNonce
              and $request.token == $expectedToken
              and $request.requestParent == $expectedParent
              and ($request.ownership | type == "object" and .uid == $ownerUid)
              and ($request.authorization | type == "object" and .uid == $ownerUid
                and .operation == "create" and .channel == "local-pipe")
              and ($request.graphDigest | digest)
              and ($graph | type == "object"
                and .digest == $request.graphDigest
                and (.paths | paths and length > 0 and length <= $maxPaths)
                and (.outputPaths | paths and length > 0)
                and (.topOutput | storePath)
                and (.paths | index($graph.topOutput) != null)
                and (.outputPaths | index($graph.topOutput) != null)
                and (.referenceClosures | type == "object")
                and (.referenceClosures | to_entries | all(. as $entry
                  | ($entry.key | storePath)
                  and ($entry.value | paths)
                  and (($entry.value | index($entry.key)) != null)
                  and all($entry.value[]; . as $path | ($graph.paths | index($path)) != null)))
              )
              and ($request.rootedPaths | paths and length > 0 and length <= $maxPaths
                and all(.[]; ($graph.paths | index(.)) != null))
              and ($request.rootDestinations | type == "array"
                and length == ($request.rootedPaths | length)
                and map(.storePath) == $request.rootedPaths
                and all(.[]; .destination == ($expectedParent + "/" + $expectedNonce + "/roots/" + (.storePath | split("/") | .[-1]))))
              and ($request.selectedInputOutputs | paths and all(.[]; ($request.rootedPaths | index(.)) != null))
              and ($request.expectedOutputs | paths and all(.[]; ($request.rootedPaths | index(.)) != null))
              and ($request.expectedOutputs | index($graph.topOutput) != null)
               and ($request.publicCacheCuts | type == "array"
                 and (map(.rootPath) == (map(.rootPath) | sort | unique))
                 and ([ .[]?.closure[]? ] | length == (unique | length))
                 and all(.[]; . as $cut
                   | (keys | sort) == [
                       "closure", "closureDigest", "endpoint", "narinfos", "rootPath", "signingKeyId"
                     ]
                   and ($cut.rootPath | storePath)
                   and $cut.rootPath != $graph.topOutput
                   and ($graph.paths | index($cut.rootPath)) != null
                    and ($cut.closure | paths)
                    and (($cut.closure | index($cut.rootPath)) != null)
                    and (($cut.closure | index($graph.topOutput)) == null)
                   and $cut.closure == $graph.referenceClosures[$cut.rootPath]
                   and all($cut.closure[]; . as $path | ($request.rootedPaths | index($path)) != null)
                   and ($cut.closureDigest | digest)
                   and ($cut.endpoint | type == "string"
                     and test("^https://[A-Za-z0-9][A-Za-z0-9.-]*$"))
                   and ($cut.signingKeyId | type == "string"
                     and test("^[A-Za-z0-9._-]+$"))
                   and ($cut.narinfos | type == "array"
                     and length == ($cut.closure | length)
                     and (map(.storePath) == $cut.closure)
                     and all(.[]; . as $info
                       | (keys | sort) == ["narHash", "narSize", "references", "signatures", "storePath"]
                       and ($info.storePath | storePath)
                       and ($cut.closure | index($info.storePath)) != null
                       and ($info.narHash | type == "string"
                         and test("^sha256-[A-Za-z0-9+/]{43}=$"))
                       and ($info.narSize | type == "number"
                         and isfinite and floor == . and . >= 0)
                        and ($info.references | paths)
                        and ($info.references == ($info.references | sort | unique))
                        and all($info.references[]; ($cut.closure | index(.)) != null)
                       and ($info.signatures | type == "array" and length > 0
                         and all(.[]; type == "string"
                           and test("^[A-Za-z0-9._-]+:[A-Za-z0-9+/=_-]+$")
                           and (split(":")[0] == $cut.signingKeyId)))
                      ))))
              | if . then $request else error("lease manifest schema rejected") end
           ' "$manifest_file" >"$normalized_manifest_file"; then
          fail_ineligible "lease state invalid" "lease request manifest was rejected"
        fi
        graph_digest="$($jq -r '.graphDigest' "$normalized_manifest_file")"
        top_output="$($jq -r '.graph.topOutput' "$normalized_manifest_file")"
        "$jq" -r '.rootedPaths[]' "$normalized_manifest_file" >"$rooted_paths_file"
        "$jq" -r '[.publicCacheCuts[]?.closure[]?] | unique | sort[]' \
          "$normalized_manifest_file" >"$closure_file"
        lease_valid=true

        if ! now_value="$($now_command +%s 2>/dev/null)" \
          || ! now_value="$(normalize_timestamp "$now_value")" \
          || ! manifest_time="$($stat -c '%Y' -- "$manifest_file" 2>/dev/null)" \
          || ! manifest_time="$(normalize_timestamp "$manifest_time")" \
          || decimal_is_greater "$manifest_time" "$now_value"; then
          fail_ineligible "lease expired" "lease request is not active"
        fi
        expiry_time="$(decimal_add "$manifest_time" "$idle_ttl_seconds")" || fail_ineligible "lease expired" "lease request is not active"
        decimal_is_greater "$now_value" "$expiry_time" && fail_ineligible "lease expired" "lease request is not active"

        while IFS= read -r store_path; do
          [[ -n "$store_path" ]] || continue
          root_marker="$roots_directory/''${store_path##*/}"
          if [[ -e "$root_marker" || -L "$root_marker" ]]; then
            [[ -L "$root_marker" ]] \
              && [[ "$($readlink "$root_marker" 2>/dev/null)" == "$store_path" ]] \
              || fail_ineligible "lease state invalid" "lease root coverage was rejected"
          elif ! path_in_file "$store_path" "$closure_file"; then
            fail_ineligible "lease state invalid" "lease root coverage was rejected"
          fi
        done <"$rooted_paths_file"
        for root_marker in "$roots_directory"/* "$roots_directory"/.[!.]* "$roots_directory"/..?*; do
          if [[ ! -e "$root_marker" && ! -L "$root_marker" ]]; then
            continue
          fi
          [[ -L "$root_marker" ]] || fail_ineligible "lease state invalid" "lease root coverage was rejected"
          root_name="''${root_marker##*/}"
          "$jq" -e --arg rootName "$root_name" \
            '.rootedPaths | any(.[]; (split("/") | .[-1]) == $rootName)' \
            "$normalized_manifest_file" >/dev/null 2>&1 \
            || fail_ineligible "lease state invalid" "lease root coverage was rejected"
        done
        request_read_limit=$((max_request_bytes + 1))
        if ! "$head" -c "$request_read_limit" >"$request_file" 2>/dev/null; then
          fail_ineligible "schema drift" "cache attestation was rejected"
        fi
        request_bytes="$($wc -c <"$request_file" 2>/dev/null)" || fail_ineligible "schema drift" "cache attestation was rejected"
        request_bytes="''${request_bytes//[[:space:]]/}"
        if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
          fail_ineligible "resource limit" "cache attestation exceeded a validation limit"
        fi

        if ! "$jq" -cS -e '
          def storePath:
            type == "string" and utf8bytelength <= 266
            and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+?=-]+$");
          def digest:
            type == "string" and test("^sha256:[0-9a-f]{64}$");
          def sortedPaths:
            type == "array" and . == (sort | unique)
            and all(.[]; storePath);
          def validInfo($cut):
            . as $info
            | ((keys | sort) == ["narHash", "narSize", "references", "signatures", "storePath"])
              and ($info.storePath | storePath)
              and (($cut.closure | index($info.storePath)) != null)
              and ($info.narHash | type == "string"
                and test("^sha256-[A-Za-z0-9+/]{43}=$"))
              and ($info.narSize | type == "number" and isfinite and floor == . and . >= 0)
              and ($info.references | sortedPaths)
              and all($info.references[]; ($cut.closure | index(.)) != null)
              and ($info.signatures | type == "array" and length > 0)
              and all($info.signatures[]; type == "string"
                and test("^[A-Za-z0-9._-]+:[A-Za-z0-9+/=_-]+$")
                and (split(":")[0] == $cut.signingKeyId));
          def validCut:
            . as $cut
            | ((keys | sort) == [
                "closure", "closureDigest", "endpoint", "narinfos", "rootPath", "signingKeyId"
              ])
              and ($cut.rootPath | storePath)
              and ($cut.closure | sortedPaths)
              and (($cut.closure | length) > 0)
              and (($cut.closure | index($cut.rootPath)) != null)
              and ($cut.closureDigest | digest)
              and ($cut.endpoint | type == "string"
                and test("^https://[A-Za-z0-9][A-Za-z0-9.-]*$"))
              and ($cut.signingKeyId | type == "string"
                and test("^[A-Za-z0-9._-]+$"))
              and ($cut.narinfos | type == "array")
              and (($cut.narinfos | length) == ($cut.closure | length))
              and (($cut.narinfos | map(.storePath)) == $cut.closure)
              and all($cut.narinfos[]; validInfo($cut));
          . as $request
          | if ($request | type) == "object"
            and (($request | keys) == ["publicCacheCuts"])
            and ($request.publicCacheCuts | type == "array" and length > 0)
            and ($request.publicCacheCuts | map(.rootPath) == (map(.rootPath) | sort | unique))
            and ([ $request.publicCacheCuts[]?.closure[]? ]
              | length == (unique | length))
            and all($request.publicCacheCuts[]; validCut)
            then $request.publicCacheCuts
            else error("cache attestation schema rejected")
            end
        ' "$request_file" >"$cut_file" 2>/dev/null; then
          fail_ineligible "schema drift" "cache attestation was rejected"
        fi
        manifest_cuts_json="$($jq -cS '.publicCacheCuts' "$normalized_manifest_file")"
        if ! "$jq" -e --argjson expected "$manifest_cuts_json" '. == $expected' "$cut_file" >/dev/null 2>&1; then
          fail_ineligible "graph mismatch" "cache attestation was not bound to the lease"
        fi
        cut_count="$($jq -r 'length' "$cut_file")" || fail_ineligible "cache attestation" "cache attestation was rejected"
        if [[ ! "$cut_count" =~ ^[1-9][0-9]*$ ]] || (( cut_count > max_paths )); then
          fail_ineligible "resource limit" "cache attestation exceeded a validation limit"
        fi
        for ((cut_index = 0; cut_index < cut_count; cut_index += 1)); do
          cut_record="$($jq -c ".[$cut_index]" "$cut_file")" || fail_ineligible "cache attestation" "cache attestation was rejected"
          endpoint="$($jq -r '.endpoint' <<<"$cut_record")"
          signing_key_id="$($jq -r '.signingKeyId' <<<"$cut_record")"
          cache_config="$($jq -n -c --arg endpoint "$endpoint" --argjson configurations "$approved_cache_configurations" \
            '$configurations | map(select(.endpoint == $endpoint)) | if length == 1 then .[0] else null end' 2>/dev/null)" || \
            fail_ineligible "cache endpoint" "cache endpoint was not approved"
          [[ "$cache_config" != null ]] || fail_ineligible "cache endpoint" "cache endpoint was not approved"
          trusted_keys="$($jq -r '.trustedKeys | join(" ")' <<<"$cache_config")" || fail_ineligible "cache key" "cache key configuration was not available"
          if ! "$jq" -e --arg keyId "$signing_key_id" --argjson configuration "$cache_config" '
            ($configuration.trustedKeys | map(split(":")[0]) | index($keyId)) != null
            and all(.narinfos[]; all(.signatures[]; (split(":")[0]) == $keyId))
          ' <<<"$cut_record" >/dev/null 2>&1; then
            fail_ineligible "cache attestation" "cache attestation metadata was rejected"
          fi
          closure_json="$($jq -cS '.closure' <<<"$cut_record")"
          closure_hash="$(printf '%s' "$closure_json" | "$sha256sum" | "$cut" -d ' ' -f 1)" || fail_ineligible "cache attestation" "cache closure digest was rejected"
          [[ "$($jq -r '.closureDigest' <<<"$cut_record")" == "sha256:$closure_hash" ]] \
            || fail_ineligible "cache attestation" "cache closure digest was rejected"
          if ! "$jq" -e --arg topOutput "$top_output" \
            '.rootPath != $topOutput and (.closure | index($topOutput) == null)' \
            <<<"$cut_record" >/dev/null 2>&1; then
            fail_ineligible "top output" "requested output cannot be a public-cache cut"
          fi
        done

        target_store_canonical="$($realpath "$target_store_directory" 2>/dev/null)" || {
          emit_failure error "internal materialization failure" "target store could not be secured"
          exit 1
        }
        [[ ! -L "$target_store_directory" ]] || {
          emit_failure error "internal materialization failure" "target store could not be secured"
          exit 1
        }
        target_store_directory="$target_store_canonical"
        for ((cut_index = 0; cut_index < cut_count; cut_index += 1)); do
          cut_record="$($jq -c ".[$cut_index]" "$cut_file")" || fail_ineligible "cache attestation" "cache attestation was rejected"
          endpoint="$($jq -r '.endpoint' <<<"$cut_record")"
          trusted_keys="$($jq -n -r --arg endpoint "$endpoint" --argjson configurations "$approved_cache_configurations" \
            '$configurations | map(select(.endpoint == $endpoint)) | .[0].trustedKeys | join(" ")' 2>/dev/null)" || \
            fail_ineligible "cache key" "cache key configuration was not available"
          native_config="experimental-features = nix-command
    substituters = $endpoint
    extra-substituters =
    trusted-substituters =
    trusted-public-keys = $trusted_keys
    require-sigs = true
    builders =
    plugin-files =
    access-tokens =
    netrc-file = /dev/null
    flake-registry = /dev/null
    eval-cache = false
    narinfo-cache-negative-ttl = 0"

          cut_paths_file="$temporary_root/cut-$cut_index.paths"
          copy_paths_file="$temporary_root/cut-$cut_index.copy"
          verification_paths_file="$temporary_root/cut-$cut_index.verify"
          "$jq" -r '.closure[]' <<<"$cut_record" >"$cut_paths_file" || {
            failure_reason="cache attestation"
            fail_ineligible "$failure_reason" "cache attestation metadata was rejected"
          }
          : >"$copy_paths_file"
          while IFS= read -r store_path; do
            [[ -n "$store_path" ]] || continue
            store_name="''${store_path##*/}"
            target_path="$target_store_directory/$store_name"
            if [[ -L "$target_path" ]]; then
              fail_ineligible "path confinement" "target store entry was not authorized"
            fi
            if [[ ! -e "$target_path" ]]; then
              printf '%s\n' "$store_path" >>"$copy_paths_file" || {
                failure_reason="internal materialization failure"
                fail_ineligible "$failure_reason" "materialization state could not be updated"
              }
            fi
          done <"$cut_paths_file"

          copy_arguments=()
          while IFS= read -r store_path; do
            [[ -n "$store_path" ]] || continue
            printf '%s\n' "$store_path" >>"$fetched_paths_file" || {
              failure_reason="internal materialization failure"
              fail_ineligible "$failure_reason" "materialization state could not be updated"
            }
            encoded_path="$(encode_store_path_argument "$store_path")" || {
              failure_reason="native verification failed"
              fail_ineligible "$failure_reason" "native cache verification failed"
            }
            copy_arguments+=("$encoded_path")
          done <"$copy_paths_file"
          if (( ''${#copy_arguments[@]} > 0 )); then
            copy_status=0
            native_run "$temporary_root/cut-$cut_index.copy.stdout" "$temporary_root/cut-$cut_index.copy.stderr" \
              copy --from "$endpoint" --to "$target_store_uri" --no-recursive \
              --option trusted-public-keys "$trusted_keys" --option require-sigs true \
              "''${copy_arguments[@]}" || copy_status=$?
            if (( copy_status != 0 )); then
              failure_reason="narinfo unavailable"
              fail_ineligible "$failure_reason" "approved cache materialization was unavailable"
            fi
          fi

          if ! "$jq" -r '
            . as $cut
            | ($cut.narinfos) as $infos
            | def deps($path): [$infos[] | select(.storePath == $path) | .references[] | select(. != $path)];
              def topo($remaining; $done):
                if ($remaining | length) == 0 then $done
                else
                  ([$remaining[] | select((deps(.) - $done | length) == 0)] | sort) as $ready
                  | if ($ready | length) == 0 then error("cache closure cycle")
                    else topo($remaining - $ready; $done + $ready)
                    end
                end;
              topo($cut.closure; []) | .[]
          ' <<<"$cut_record" >"$verification_paths_file" 2>/dev/null; then
            failure_reason="cache attestation"
            fail_ineligible "$failure_reason" "cache closure order was rejected"
          fi
          while IFS= read -r store_path; do
            [[ -n "$store_path" ]] || continue
            store_name="''${store_path##*/}"
            actual_file="$(native_path_info "$store_path")" || fail_ineligible "$failure_reason" "native cache verification failed"
            expected_file="$temporary_root/$store_name.expected.json"
            if ! "$jq" -c --arg path "$store_path" \
              '[.narinfos[] | select(.storePath == $path)] | if length == 1 then .[0] else error("metadata missing") end' \
              <<<"$cut_record" >"$expected_file" 2>/dev/null; then
              failure_reason="cache attestation"
              fail_ineligible "$failure_reason" "cache attestation metadata was rejected"
            fi
            if ! "$jq" -n -e --slurpfile actual "$actual_file" --slurpfile expected "$expected_file" '
              ($actual[0] | .storePath == $expected[0].storePath
                and .narHash == $expected[0].narHash
                and .narSize == $expected[0].narSize
                and .references == $expected[0].references
                and .signatures == $expected[0].signatures)
            ' >/dev/null 2>&1; then
              failure_reason="NAR metadata mismatch"
              fail_ineligible "$failure_reason" "native cache metadata did not match the attestation"
            fi
            native_verify "$store_path" || fail_ineligible "$failure_reason" "native cache verification failed"
          done <"$verification_paths_file"
        done

        root_operation_failed=false
        while IFS= read -r store_path; do
          [[ -n "$store_path" ]] || continue
          root_marker="$roots_directory/''${store_path##*/}"
          if [[ -e "$root_marker" || -L "$root_marker" ]]; then
            if [[ ! -L "$root_marker" ]] || [[ "$($readlink "$root_marker" 2>/dev/null)" != "$store_path" ]]; then
              root_operation_failed=true
              break
            fi
            continue
          fi
          if ! "$root_adder" --add-root "$root_marker" --indirect --realise "$store_path" >/dev/null 2>/dev/null \
            || [[ ! -L "$root_marker" ]] \
            || [[ "$($readlink "$root_marker" 2>/dev/null)" != "$store_path" ]]; then
            root_operation_failed=true
            break
          fi
        done <"$closure_file"
        if [[ "$root_operation_failed" == true ]]; then
          failure_reason="root operation failed"
          fail_ineligible "$failure_reason" "lease roots could not be created"
        fi

        success=true
        emit_success
        exit 0
  '';
}
