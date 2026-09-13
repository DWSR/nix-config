{
  lib,
  writeShellApplication,
  coreutils,
  curl,
  jq,
  nativeCacheVerifierExecutable ? "/run/current-system/sw/bin/nix",
  curlExecutable ? "${curl}/bin/curl",
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
  approvedCacheEndpoints ? map (cache: cache.endpoint) approvedCacheConfigurations,
  maxGraphPaths ? 10000,
  maxRequestBytes ? 1024 * 1024,
  maxDiagnosticBytes ? 64 * 1024,
  maxNativeOutputBytes ? 16 * 1024 * 1024,
  maxCacheBytes ? 20 * 1024 * 1024 * 1024,
  maxRedirects ? 20,
  policyProxyPort ? 1080,
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
assert lib.isString nativeCacheVerifierExecutable;
assert nativeCacheVerifierExecutable != "";
assert lib.isString curlExecutable;
assert curlExecutable != "";
assert lib.isList approvedCacheConfigurations;
assert approvedCacheConfigurations != [ ];
assert lib.all validCacheConfiguration approvedCacheConfigurations;
assert
  lib.length (lib.unique (map (cache: cache.endpoint) approvedCacheConfigurations))
  == lib.length approvedCacheConfigurations;
assert lib.isList approvedCacheEndpoints;
assert approvedCacheEndpoints != [ ];
assert lib.all (
  endpoint: lib.elem endpoint (map (cache: cache.endpoint) approvedCacheConfigurations)
) approvedCacheEndpoints;
assert lib.isInt maxGraphPaths;
assert maxGraphPaths > 0;
assert lib.isInt maxRequestBytes;
assert maxRequestBytes > 0;
assert lib.isInt maxDiagnosticBytes;
assert maxDiagnosticBytes > 0;
assert lib.isInt maxNativeOutputBytes;
assert maxNativeOutputBytes > 0;
assert lib.isInt maxCacheBytes;
assert maxCacheBytes > 0;
assert lib.isInt maxRedirects;
assert maxRedirects > 0;
assert maxRedirects <= 20;
assert lib.isInt policyProxyPort;
assert policyProxyPort > 1023;
assert policyProxyPort <= 65535;
assert lib.isInt queryTimeoutSeconds;
assert queryTimeoutSeconds > 0;
let
  coreutilsBin = "${coreutils}/bin";
  safePath = lib.makeBinPath [
    coreutils
    curl
    jq
  ];
in
writeShellApplication {
  name = "shopify-remote-builder-cache-verifier";
  runtimeInputs = [
    coreutils
    curl
    jq
  ];
  # jq programs intentionally use single-quoted shell arguments; trap callbacks
  # are invoked indirectly by signal dispatch.
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
        mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
        mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
        mv=${lib.escapeShellArg "${coreutilsBin}/mv"}
        native_verifier=${lib.escapeShellArg nativeCacheVerifierExecutable}
        curl_command=${lib.escapeShellArg curlExecutable}
        realpath=${lib.escapeShellArg "${coreutilsBin}/realpath"}
        rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
        sha256sum=${lib.escapeShellArg "${coreutilsBin}/sha256sum"}
        timeout=${lib.escapeShellArg "${coreutilsBin}/timeout"}
        touch=${lib.escapeShellArg "${coreutilsBin}/touch"}
        wc=${lib.escapeShellArg "${coreutilsBin}/wc"}
        jq=${lib.escapeShellArg "${jq}/bin/jq"}
        safe_path=${lib.escapeShellArg safePath}
        approved_cache_configurations=${lib.escapeShellArg (builtins.toJSON approvedCacheConfigurations)}
        max_graph_paths=${toString maxGraphPaths}
        max_request_bytes=${toString maxRequestBytes}
        max_diagnostic_bytes=${toString maxDiagnosticBytes}
        max_native_output_bytes=${toString maxNativeOutputBytes}
        max_cache_bytes=${toString maxCacheBytes}
        max_redirects=${toString maxRedirects}
        policy_proxy_port=${toString policyProxyPort}
        query_timeout_seconds=${toString queryTimeoutSeconds}

        validation_root=""
        validation_tmp_parent="/tmp"
        request_file=""
        request_meta_file=""
        cuts_file=""
        traversal_file=""
        traversal_paths_file=""
        processed_branches_file=""
        covered_paths_file=""
        result_nonce=""
        top_output=""
        proxy_endpoint=""
        approved_cache_count=0
        cache_bytes=0
        failure_reason=""

        emit_result() {
          local decision="$1"
          local reason="$2"
          local detail="$3"
          local cuts_json='[]'
          local traversal_json='[]'

          if [[ -n "$cuts_file" && -f "$cuts_file" ]]; then
            cuts_json="$($jq -s -c 'sort_by(.rootPath)' "$cuts_file" 2>/dev/null)" || cuts_json='[]'
          fi
          if [[ -n "$traversal_file" && -f "$traversal_file" ]]; then
            traversal_json="$($jq -s -c 'sort_by(.rootPath)' "$traversal_file" 2>/dev/null)" || traversal_json='[]'
          fi
          "$jq" -n -cS \
            --argjson schemaVersion 1 \
            --arg nonce "$result_nonce" \
            --arg decision "$decision" \
            --arg reason "$reason" \
            --arg detail "$detail" \
            --argjson publicCacheCuts "$cuts_json" \
            --argjson traversal "$traversal_json" \
            '{
              schemaVersion: $schemaVersion,
              nonce: (if $nonce == "" then null else $nonce end),
              decision: $decision,
              reason: (if $reason == "" then null else $reason end),
              publicCacheCuts: $publicCacheCuts,
              traversal: $traversal,
              detail: $detail
            }'
        }

        cleanup() {
          if [[ -n "$validation_root" ]]; then
            "$rm" -rf -- "$validation_root" 2>/dev/null || true
            validation_root=""
          fi
        }

        on_signal() {
          local signal_status="$1"
          cleanup
          trap - EXIT
          exit "$signal_status"
        }

        trap cleanup EXIT
        trap 'on_signal 129' HUP
        trap 'on_signal 130' INT
        trap 'on_signal 143' TERM

        validation_root="$($mktemp -d "$validation_tmp_parent/shopify-remote-builder-cache-verifier.XXXXXX" 2>/dev/null)" || {
          emit_result error "internal validation failure" "cache verification state could not be created"
          exit 1
        }
        validation_root="$($realpath "$validation_root" 2>/dev/null)" || {
          emit_result error "internal validation failure" "cache verification state could not be canonicalized"
          exit 1
        }
        request_file="$validation_root/request.json"
        request_meta_file="$validation_root/request-meta.json"
        cuts_file="$validation_root/cuts.jsonl"
        traversal_file="$validation_root/traversal.jsonl"
        traversal_paths_file="$validation_root/traversal-paths"
        processed_branches_file="$validation_root/processed-branches"
        covered_paths_file="$validation_root/covered-paths"
        "$touch" "$cuts_file" "$traversal_file" "$traversal_paths_file" \
          "$processed_branches_file" "$covered_paths_file" 2>/dev/null || {
          emit_result error "internal validation failure" "cache verification state could not be initialized"
          exit 1
        }
        for fresh_directory in \
          fresh-home fresh-curl-home fresh-xdg-cache fresh-xdg-config fresh-xdg-data \
          fresh-xdg-state fresh-nix-cache fresh-nix-config-home fresh-nix-conf \
          fresh-nix-log fresh-nix-state; do
          "$mkdir" -p -- "$validation_root/$fresh_directory" || {
            emit_result error "internal validation failure" "fresh cache state could not be created"
            exit 1
          }
        done

        request_read_limit=$((max_request_bytes + 1))
        set +e
        "$timeout" --signal=KILL 2s "$head" -c "$request_read_limit" >"$request_file" 2>/dev/null
        request_read_status=$?
        set -e
        if (( request_read_status == 124 || request_read_status == 137 )); then
          emit_result ineligible "resource limit" "cache verification request exceeded a validation limit"
          exit 0
        elif (( request_read_status != 0 )); then
          emit_result error "internal validation failure" "cache verification request could not be read"
          exit 1
        fi

        request_bytes="$($wc -c <"$request_file" 2>/dev/null)" || {
          emit_result error "internal validation failure" "cache verification request size could not be checked"
          exit 1
        }
        request_bytes="''${request_bytes//[[:space:]]/}"
        if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
          emit_result ineligible "resource limit" "cache verification request exceeded a validation limit"
          exit 0
        fi

        if ! "$jq" -c -e -s \
          --argjson maxGraphPaths "$max_graph_paths" \
          --argjson policyProxyPort "$policy_proxy_port" '
            def store_path:
              type == "string"
              and utf8bytelength <= 266
              and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+?=-]+$");
            def sorted_unique:
              . == (sort | unique);
            def exact_object($required; $allowed):
              type == "object"
              and ((keys - $allowed) | length) == 0
              and (. as $object | all($required[]; . as $key | ($object | has($key))));
            def finite_integer:
              type == "number" and isfinite and floor == .;
            if length != 1 then
              error("one request object required")
            else
              .[0] as $request
              | if ($request | type) != "object"
                or (($request | keys) - [
                  "schemaVersion",
                  "nonce",
                  "topOutput",
                  "candidateRoots",
                  "graph",
                  "proxy"
                ] | length) != 0
                or $request.schemaVersion != 1
                or ($request.nonce | type != "string"
                  or utf8bytelength == 0
                  or utf8bytelength > 128
                  or test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") | not)
                or ($request.topOutput | store_path | not)
                or ($request.candidateRoots | type != "array"
                  or (sorted_unique | not)
                  or any(.[]; store_path | not))
                or ($request.graph | exact_object(["references"]; ["references"]) | not)
                or ($request.proxy | exact_object(["endpoint", "nonce"]; ["endpoint", "nonce"]) | not)
                or ($request.proxy.endpoint | type != "string"
                  or . != ("socks5h://127.0.0.1:" + ($policyProxyPort | tostring)))
                or ($request.proxy.nonce != $request.nonce)
                then
                  error("request schema rejected")
                else
                  $request.graph.references as $references
                  | ($references | type == "object") as $referencesObject
                  | ($references | keys) as $graphPaths
                  | ($references[$request.topOutput] // null) as $topReferences
                  | if ($referencesObject | not)
                    or ($graphPaths | length == 0 or length > $maxGraphPaths)
                    or ($graphPaths | any(.[]; store_path | not))
                    or ($topReferences | type != "array")
                    or ($topReferences | sorted_unique | not)
                    or ($graphPaths | any(.[ ];
                      . as $path
                      | ($references[$path] | type != "array"
                        or (sorted_unique | not)
                        or any(.[]; store_path | not))))
                     or ($graphPaths | any(.[ ];
                       . as $path
                       | $references[$path][] as $reference
                         | ($graphPaths | index($reference)) == null))
                     or (
                       def acyclic($node; $stack):
                         if ($stack | index($node)) != null then false
                         else reduce (($references[$node] // [])[] | select(. != $node)) as $child
                           (true; . and acyclic($child; $stack + [$node]))
                         end;
                       acyclic($request.topOutput; []) | not
                    )
                    or (
                      def reachable($node; $visited):
                        if ($visited | index($node)) != null then $visited
                        else reduce (($references[$node] // [])[]) as $child
                          ($visited + [$node]; reachable($child; .))
                        end;
                      (reachable($request.topOutput; [])) as $reachable
                      | any($request.candidateRoots[]; . as $candidate
                        | ($reachable | index($candidate)) == null)
                    )
                    or ((reduce ($topReferences[]) as $required
                      (true; . and (($request.candidateRoots | index($required)) != null)) | not))
                    then
                      error("graph schema rejected")
                    else
                      $request
                    end
                end
              end
          ' "$request_file" >"$request_meta_file" 2>/dev/null; then
          emit_result ineligible "schema drift" "cache verification request schema rejected"
          exit 0
        fi

        result_nonce="$($jq -r '.nonce' "$request_meta_file")"
        top_output="$($jq -r '.topOutput' "$request_meta_file")"
        proxy_endpoint="$($jq -r '.proxy.endpoint' "$request_meta_file")"
        approved_cache_count="$($jq -n -r --argjson configurations "$approved_cache_configurations" \
          '$configurations | length' 2>/dev/null)" || {
          emit_result error "internal validation failure" "approved cache configuration could not be loaded"
          exit 1
        }

        for ((cache_index = 0; cache_index < approved_cache_count; cache_index += 1)); do
          "$mkdir" -p -- "$validation_root/cache-$cache_index" || {
            emit_result error "internal validation failure" "cache verification state could not be created"
            exit 1
          }
        done

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

        append_traversal() {
          local store_path="$1"
          local reason="$2"
          if path_in_file "$store_path" "$traversal_paths_file"; then
            return 0
          fi
          printf '%s\n' "$store_path" >>"$traversal_paths_file"
          printf '%s\n' "$store_path" >>"$processed_branches_file"
          "$jq" -n -cS --arg rootPath "$store_path" --arg reason "$reason" \
            '{rootPath: $rootPath, reason: $reason}' >>"$traversal_file"
        }

        origin_for_url() {
          local url="$1"
          local authority
          case "$url" in
            https://*) ;;
            *) return 1 ;;
          esac
          authority="''${url#https://}"
          authority="''${authority%%/*}"
          authority="''${authority%%\?*}"
          authority="''${authority%%\#*}"
          if [[ -z "$authority" || "$authority" == *:* || "$authority" == *@* ]] \
            || [[ ! "$authority" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
            return 1
          fi
          printf 'https://%s\n' "$authority"
        }

        cache_url_path() {
          local endpoint="$1"
          local raw_url="$2"
          local url_origin
          local url_path
          local remainder
          local segment

          case "$raw_url" in
            https://*)
              if ! url_origin="$(origin_for_url "$raw_url")" || [[ "$url_origin" != "$endpoint" ]]; then
                return 1
              fi
              url_path="''${raw_url#"$url_origin"}"
              ;;
            /*)
              url_path="$raw_url"
              ;;
            nar/*)
              url_path="/$raw_url"
              ;;
            *)
              return 1
              ;;
          esac

          url_path="''${url_path%%\?*}"
          url_path="''${url_path%%\#*}"
          url_path="''${url_path#/}"
          if [[ "$url_path" == *\\* ]] \
            || [[ "$url_path" =~ %2[eE]|%2[fF]|%5[cC] ]]; then
            return 1
          fi
          remainder="$url_path"
          while :; do
            segment="''${remainder%%/*}"
            case "$segment" in
              ""|.|..)
                return 1
                ;;
            esac
            if [[ "$remainder" == "$segment" ]]; then
              break
            fi
            remainder="''${remainder#*/}"
          done
          printf '%s\n' "$url_path"
        }

        fetch_cache_file() {
          local cache_index="$1"
          local endpoint="$2"
          local initial_url="$3"
          local output_file="$4"
          local temporary_file="$output_file.download"
          local response_meta="$output_file.response"
          local response_error="$output_file.error"
          local current_url="$initial_url"
          local redirect_count=0
          local curl_status
          local http_code
          local redirect_url
          local effective_url
          local effective_origin
          local download_bytes

          if ! cache_url_path "$endpoint" "$current_url" >/dev/null; then
            failure_reason="metadata malformed"
            return 1
          fi
          while (( redirect_count <= max_redirects )); do
            "$rm" -f -- "$temporary_file" "$response_meta" "$response_error"
            set +e
            "$env_command" -i \
              "HOME=$validation_root/fresh-home" \
              "CURL_HOME=$validation_root/fresh-curl-home" \
              "LANG=C" \
              "LC_ALL=C" \
              "PATH=$safe_path" \
              "TMPDIR=$validation_root" \
              "XDG_CONFIG_HOME=$validation_root/fresh-xdg-config" \
              "ALL_PROXY=$proxy_endpoint" \
              "HTTP_PROXY=$proxy_endpoint" \
              "HTTPS_PROXY=$proxy_endpoint" \
              "all_proxy=$proxy_endpoint" \
              "http_proxy=$proxy_endpoint" \
              "https_proxy=$proxy_endpoint" \
              "NO_PROXY=" \
              "no_proxy=" \
              "$timeout" --signal=TERM --kill-after=1s "''${query_timeout_seconds}s" \
              "$curl_command" \
              --disable \
              --fail --silent --show-error \
              --proxy "$proxy_endpoint" --noproxy "" \
              --proto '=https' --proto-redir '=https' \
              --max-redirs 0 --max-time "$query_timeout_seconds" \
              --max-filesize "$max_cache_bytes" \
              --output "$temporary_file" \
              --write-out '%{http_code}\n%{redirect_url}\n%{url_effective}\n' \
              "$current_url" >"$response_meta" 2>"$response_error"
            curl_status=$?
            set -e
            if (( curl_status != 0 )); then
              failure_reason="narinfo unavailable"
              "$rm" -f -- "$temporary_file" "$response_meta" "$response_error"
              return 1
            fi

            exec 3<"$response_meta"
            if ! IFS= read -r http_code <&3; then
              exec 3<&-
              failure_reason="metadata malformed"
              return 1
            fi
            if ! IFS= read -r redirect_url <&3; then
              redirect_url=""
            fi
            if ! IFS= read -r effective_url <&3; then
              effective_url="$current_url"
            fi
            exec 3<&-

            if [[ "$http_code" =~ ^3[0-9][0-9]$ ]]; then
              if (( redirect_count >= max_redirects )); then
                failure_reason="redirect limit"
                return 1
              fi
              if [[ -z "$redirect_url" ]]; then
                failure_reason="redirect origin mismatch"
                return 1
              fi
              if ! effective_origin="$(origin_for_url "$redirect_url")" \
                || [[ "$effective_origin" != "$endpoint" ]]; then
                failure_reason="redirect origin mismatch"
                return 1
              fi
              if ! cache_url_path "$endpoint" "$redirect_url" >/dev/null; then
                failure_reason="metadata malformed"
                return 1
              fi
              current_url="$redirect_url"
              redirect_count=$((redirect_count + 1))
              continue
            fi
            if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
              failure_reason="narinfo unavailable"
              return 1
            fi
            if ! effective_origin="$(origin_for_url "$effective_url")" \
              || [[ "$effective_origin" != "$endpoint" ]]; then
              failure_reason="redirect origin mismatch"
              return 1
            fi
            if ! cache_url_path "$endpoint" "$effective_url" >/dev/null; then
              failure_reason="metadata malformed"
              return 1
            fi
            download_bytes="$($wc -c <"$temporary_file" 2>/dev/null)" || {
              failure_reason="metadata malformed"
              return 1
            }
            download_bytes="''${download_bytes//[[:space:]]/}"
            if [[ ! "$download_bytes" =~ ^[0-9]+$ ]] \
              || (( download_bytes > max_cache_bytes - cache_bytes )); then
              failure_reason="resource limit"
              return 1
            fi
            cache_bytes=$((cache_bytes + download_bytes))
            "$mv" -f -- "$temporary_file" "$output_file" || {
              failure_reason="metadata malformed"
              return 1
            }
            "$rm" -f -- "$response_meta" "$response_error"
            return 0
          done
          failure_reason="redirect limit"
          return 1
        }

        cache_relative_path() {
          local endpoint="$1"
          local raw_url="$2"
          local url_path
          if ! url_path="$(cache_url_path "$endpoint" "$raw_url")"; then
            return 1
          fi
          case "$url_path" in
            nar/*) ;;
            *)
              return 1
              ;;
          esac
          printf '%s\n' "$url_path"
        }

        cache_remote_url() {
          local endpoint="$1"
          local raw_url="$2"
          local url_path
          if ! url_path="$(cache_relative_path "$endpoint" "$raw_url")"; then
            failure_reason="metadata malformed"
            return 1
          fi
          printf '%s/%s\n' "$endpoint" "$url_path"
        }

        rewrite_narinfo_url() {
          local source_file="$1"
          local output_file="$2"
          local local_url="$3"
          local url_count=0
          while IFS= read -r line || [[ -n "$line" ]]; do
            case "$line" in
              URL:\ *)
                url_count=$((url_count + 1))
                printf 'URL: %s\n' "$local_url"
                ;;
              *)
                printf '%s\n' "$line"
                ;;
            esac
          done <"$source_file" >"$output_file" || return 1
          (( url_count == 1 )) || return 1
        }

        materialize_cache_path() {
          local cache_index="$1"
          local store_path="$2"
          local cache_directory="$validation_root/cache-$cache_index"
          local endpoint
          local store_name="''${store_path##*/}"
          local hash_part="''${store_name%%-*}"
          local marker_file="$cache_directory/$hash_part.ready"
          local remote_narinfo="$cache_directory/$hash_part.narinfo.remote"
          local narinfo_file="$cache_directory/$hash_part.narinfo"
          local narinfo_temp="$cache_directory/$hash_part.narinfo.tmp"
          local narinfo_url
          local local_nar_path
          local remote_nar_url
          local local_nar_file

          if [[ -f "$marker_file" && ! -L "$marker_file" ]]; then
            return 0
          fi
          if [[ ! "$hash_part" =~ ^[a-z0-9]{32}$ ]]; then
            failure_reason="metadata malformed"
            return 1
          fi
          endpoint="$($jq -n -r --argjson index "$cache_index" \
            --argjson configurations "$approved_cache_configurations" \
            '$configurations[$index].endpoint' 2>/dev/null)" || {
            failure_reason="metadata malformed"
            return 1
          }
          fetch_cache_file "$cache_index" "$endpoint" "$endpoint/$hash_part.narinfo" "$remote_narinfo" || return 1
          narinfo_url="$($jq -R -s -r '
            [split("\n")[] | select(startswith("URL: ")) | .[5:] | sub("\r$"; "")] as $urls
            | if ($urls | length) == 1 then $urls[0] else error("one URL required") end
          ' "$remote_narinfo" 2>/dev/null)" || {
            failure_reason="metadata malformed"
            return 1
          }
          if ! cache_relative_path "$endpoint" "$narinfo_url" >/dev/null; then
            failure_reason="metadata malformed"
            return 1
          fi
          remote_nar_url="$(cache_remote_url "$endpoint" "$narinfo_url")" || {
            failure_reason="metadata malformed"
            return 1
          }
          local_nar_path="nar/$hash_part.nar"
          local_nar_file="$cache_directory/$local_nar_path"
          "$mkdir" -p -- "$cache_directory/''${local_nar_path%/*}" || {
            failure_reason="metadata malformed"
            return 1
          }
          fetch_cache_file "$cache_index" "$endpoint" "$remote_nar_url" "$local_nar_file" || return 1
          rewrite_narinfo_url "$remote_narinfo" "$narinfo_temp" "$local_nar_path" || {
            failure_reason="metadata malformed"
            return 1
          }
          "$mv" -f -- "$narinfo_temp" "$narinfo_file" || {
            failure_reason="metadata malformed"
            return 1
          }
          "$rm" -f -- "$remote_narinfo"
          "$touch" "$marker_file" || {
            failure_reason="metadata malformed"
            return 1
          }
          return 0
        }

        prepare_cache() {
          local cache_index="$1"
          local root_path="$2"
          local cache_directory="$validation_root/cache-$cache_index"
          local closure_json
          if [[ ! -f "$cache_directory/nix-cache-info" || -L "$cache_directory/nix-cache-info" ]]; then
            printf 'StoreDir: /nix/store\nWantMassQuery: 1\n' >"$cache_directory/nix-cache-info" || {
              failure_reason="metadata malformed"
              return 1
            }
          fi
          closure_json="$(closure_for_root "$root_path")" || {
            failure_reason="metadata malformed"
            return 1
          }
          while IFS= read -r closure_path; do
            [[ -n "$closure_path" ]] || continue
            materialize_cache_path "$cache_index" "$closure_path" || return 1
          done < <("$jq" -r '.[]' <<<"$closure_json")
          return 0
        }

        file_uri_for_path() {
          local containment_root="$1"
          local candidate_path="$2"
          local canonical_root
          local canonical_candidate
          local remainder
          local component
          local encoded_component
          local encoded_path=""

          canonical_root="$($realpath -- "$containment_root" 2>/dev/null)" || return 1
          canonical_candidate="$($realpath -- "$candidate_path" 2>/dev/null)" || return 1
          case "$canonical_candidate" in
            "$canonical_root"|"$canonical_root"/*) ;;
            *) return 1 ;;
          esac

          remainder="''${canonical_candidate#/}"
          while :; do
            component="''${remainder%%/*}"
            if [[ -z "$component" ]]; then
              break
            fi
            encoded_component="$(printf '%s' "$component" | "$jq" -sRr '@uri')" || return 1
            encoded_path+="/$encoded_component"
            if [[ "$remainder" == "$component" ]]; then
              break
            fi
            remainder="''${remainder#*/}"
          done
          printf 'file://%s\n' "$encoded_path"
        }

        native_run() {
          local cache_index="$1"
          local stdout_file="$2"
          local stderr_file="$3"
          shift 3
          local endpoint
          local trusted_keys
          local cache_directory
          local cache_store_uri
          local nix_config
          local native_status

          endpoint="$("$jq" -n -r --argjson index "$cache_index" \
            --argjson configurations "$approved_cache_configurations" \
            '$configurations[$index].endpoint' 2>/dev/null)" || return 125
          trusted_keys="$("$jq" -n -r --argjson index "$cache_index" \
            --argjson configurations "$approved_cache_configurations" \
            '$configurations[$index].trustedKeys | join(" ")' 2>/dev/null)" || return 125
          cache_directory="$validation_root/cache-$cache_index"
          cache_store_uri="$(file_uri_for_path "$validation_root" "$cache_directory")" || return 125
          nix_config="experimental-features = nix-command
    use-registries = false
    flake-registry = /dev/null
    substituters = $cache_store_uri
    trusted-public-keys = $trusted_keys
    require-sigs = true
    narinfo-cache-negative-ttl = 0
    builders =
    plugin-files =
    access-tokens =
    netrc-file = /dev/null"

          set +e
          "$env_command" -i \
            "HOME=$validation_root/fresh-home" \
            "LANG=C" \
            "LC_ALL=C" \
            "PATH=$safe_path" \
            "TMPDIR=$validation_root" \
            "XDG_CACHE_HOME=$validation_root/fresh-xdg-cache" \
            "XDG_CONFIG_HOME=$validation_root/fresh-xdg-config" \
            "XDG_DATA_HOME=$validation_root/fresh-xdg-data" \
            "XDG_STATE_HOME=$validation_root/fresh-xdg-state" \
            "NIX_CACHE_DIR=$validation_root/fresh-nix-cache" \
            "NIX_CONFIG_HOME=$validation_root/fresh-nix-config-home" \
            "NIX_CONF_DIR=$validation_root/fresh-nix-conf" \
             "NIX_LOG_DIR=$validation_root/fresh-nix-log" \
             "NIX_STATE_DIR=$validation_root/fresh-nix-state" \
             "NIX_USER_CONF_FILES=/dev/null" \
             "_NIX_FORCE_HTTP=1" \
             "NIX_CONFIG=$nix_config" \
            "ALL_PROXY=$proxy_endpoint" \
            "HTTP_PROXY=$proxy_endpoint" \
            "HTTPS_PROXY=$proxy_endpoint" \
            "all_proxy=$proxy_endpoint" \
            "http_proxy=$proxy_endpoint" \
            "https_proxy=$proxy_endpoint" \
            "NO_PROXY=" \
            "no_proxy=" \
            "$timeout" --signal=TERM --kill-after=1s "''${query_timeout_seconds}s" \
            "$native_verifier" "$@" >"$stdout_file" 2>"$stderr_file"
          native_status=$?
          set -e
          return "$native_status"
        }

        check_native_output_limits() {
          local stdout_file="$1"
          local stderr_file="$2"
          local stdout_bytes
          local stderr_bytes

          stdout_bytes="$($wc -c <"$stdout_file" 2>/dev/null)" || return 1
          stderr_bytes="$($wc -c <"$stderr_file" 2>/dev/null)" || return 1
          stdout_bytes="''${stdout_bytes//[[:space:]]/}"
          stderr_bytes="''${stderr_bytes//[[:space:]]/}"
          [[ "$stdout_bytes" =~ ^[0-9]+$ ]] || return 1
          [[ "$stderr_bytes" =~ ^[0-9]+$ ]] || return 1
          (( stdout_bytes <= max_native_output_bytes )) || return 2
          (( stderr_bytes <= max_diagnostic_bytes )) || return 2
          return 0
        }

        native_cache_verify() {
          local cache_index="$1"
          local store_path="$2"
          local store_name="''${store_path##*/}"
          local cache_directory="$validation_root/cache-$cache_index"
          local stdout_file="$cache_directory/$store_name.verify.stdout"
          local stderr_file="$cache_directory/$store_name.verify.stderr"
          local native_store_path
          local native_status
          local output_limit_status
          local native_store_uri
          : >"$stdout_file"
          : >"$stderr_file"
          native_store_uri="$(file_uri_for_path "$validation_root" "$cache_directory")" || {
            failure_reason="native verification failed"
            return 1
          }
          native_store_path="$(encode_store_path_argument "$store_path")" || {
            failure_reason="native verification failed"
            return 1
          }

          if native_run "$cache_index" "$stdout_file" "$stderr_file" \
            store verify --recursive --sigs-needed 1 \
            --store "$native_store_uri" \
            "$native_store_path"; then
            native_status=0
          else
            native_status=$?
          fi
          output_limit_status=0
          check_native_output_limits "$stdout_file" "$stderr_file" || output_limit_status=$?
          if (( output_limit_status == 2 )); then
            failure_reason="resource limit"
            return 1
          elif (( output_limit_status != 0 )); then
            failure_reason="native verification failed"
            return 1
          fi
          if (( native_status == 0 )); then
            return 0
          elif (( native_status & 2 )); then
            failure_reason="signature mismatch"
          elif (( native_status & 1 )); then
            failure_reason="NAR content mismatch"
          elif (( native_status & 4 )); then
            failure_reason="narinfo unavailable"
          else
            failure_reason="native verification failed"
          fi
          return 1
        }

        native_path_info() {
          local cache_index="$1"
          local store_path="$2"
          local store_name="''${store_path##*/}"
          local cache_directory="$validation_root/cache-$cache_index"
          local raw_file="$cache_directory/$store_name.path-info.raw"
          local stderr_file="$cache_directory/$store_name.path-info.stderr"
          local info_file="$cache_directory/$store_name.path-info.json"
          local native_store_path
          local native_status
          local output_limit_status
          local native_store_uri
          : >"$raw_file"
          : >"$stderr_file"
          native_store_uri="$(file_uri_for_path "$validation_root" "$cache_directory")" || {
            failure_reason="native verification failed"
            return 1
          }
          native_store_path="$(encode_store_path_argument "$store_path")" || {
            failure_reason="native verification failed"
            return 1
          }

          if native_run "$cache_index" "$raw_file" "$stderr_file" \
              path-info --json --json-format 1 --sigs --recursive \
              --store "$native_store_uri" \
              "$native_store_path"; then
            native_status=0
          else
            native_status=$?
          fi
          output_limit_status=0
          check_native_output_limits "$raw_file" "$stderr_file" || output_limit_status=$?
          if (( output_limit_status == 2 )); then
            failure_reason="resource limit"
            return 1
          elif (( output_limit_status != 0 || native_status != 0 )); then
            failure_reason="narinfo unavailable"
            return 1
          fi
          if ! "$jq" -cS '
            if type != "object" then
              error("native path metadata is not an object")
            else
               [to_entries[] | {
                 storePath: .key,
                 narHash: .value.narHash,
                 narSize: .value.narSize,
                 references: .value.references,
                 signatures: .value.signatures
               }] | sort_by(.storePath)
            end
          ' "$raw_file" >"$info_file" 2>/dev/null; then
            failure_reason="metadata malformed"
            return 1
          fi
          printf '%s\n' "$info_file"
          return 0
        }

         closure_for_root() {
           local root_path="$1"
           "$jq" -c --arg root "$root_path" '
             .graph.references as $references
             | def descendants($path; $visited):
                 if ($visited | index($path)) != null then []
                 else reduce (($references[$path] // [])[]) as $child
                   ([$path]; . + descendants($child; $visited + [$path]))
                 end;
             descendants($root; []) | unique | sort
           ' "$request_meta_file"
         }

        encode_store_path_argument() {
          local store_path="$1"
          local store_name="''${store_path##*/}"
          store_name="''${store_name//\?/%3F}"
          printf '/nix/store/%s' "$store_name"
        }

        validate_native_metadata() {
          local cache_index="$1"
          local root_path="$2"
          local info_file="$3"
          local closure_json
          local metadata_file
          local closure_path
          local expected_references_json
          local entry_json
          local trusted_key_ids
          local cache_directory="$validation_root/cache-$cache_index"

          closure_json="$(closure_for_root "$root_path")" || {
            failure_reason="metadata malformed"
            return 1
          }
          trusted_key_ids="$("$jq" -n -c --argjson index "$cache_index" \
            --argjson configurations "$approved_cache_configurations" \
            '$configurations[$index].trustedKeys | map(split(":")[0]) | unique' 2>/dev/null)" || {
            failure_reason="metadata malformed"
            return 1
          }
          if ! "$jq" -e --argjson expected "$closure_json" '
            type == "array"
            and length == ($expected | length)
            and (map(.storePath) | sort) == $expected
          ' "$info_file" >/dev/null 2>&1; then
            failure_reason="incomplete reference closure"
            return 1
          fi

          while IFS= read -r closure_path; do
            [[ -n "$closure_path" ]] || continue
            expected_references_json="$("$jq" -c --arg path "$closure_path" \
              '.graph.references[$path]' "$request_meta_file")" || {
              failure_reason="metadata malformed"
              return 1
            }
            entry_json="$("$jq" -c --arg path "$closure_path" \
              '[.[] | select(.storePath == $path)] | if length == 1 then .[0] else null end' \
              "$info_file")" || {
              failure_reason="metadata malformed"
              return 1
            }
            if [[ "$entry_json" == null ]]; then
              failure_reason="metadata missing"
              return 1
            fi
            if "$jq" -e '
              . as $entry
              | any(["narHash", "narSize", "references", "signatures"][];
                . as $key | $entry[$key] == null)
            ' <<<"$entry_json" >/dev/null 2>&1; then
              failure_reason="metadata missing"
              return 1
            fi
            if ! "$jq" -e \
              --arg path "$closure_path" \
              --argjson expectedReferences "$expected_references_json" \
              --argjson trustedKeyIds "$trusted_key_ids" '
                .storePath == $path
                and (.narHash | type == "string" and length > 0 and length <= 512
                  and test("^sha256[-:][A-Za-z0-9+/=]+$"))
                and (.narSize | type == "number" and isfinite and floor == . and . >= 0)
                and (.references | type == "array"
                  and . == (sort | unique)
                  and all(.[]; type == "string"
                    and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+?=-]+$")))
                and (.signatures | type == "array" and length > 0
                  and all(.[]; type == "string"
                    and length <= 4096
                    and test("^[A-Za-z0-9._-]+:[A-Za-z0-9+/=_-]+$")))
                and any(.signatures[];
                  (split(":")[0]) as $key
                  | ($trustedKeyIds | index($key)) != null)
              ' <<<"$entry_json" >/dev/null 2>&1; then
              failure_reason="metadata malformed"
              return 1
            fi
            if ! "$jq" -e \
              --arg path "$closure_path" \
              --argjson expectedReferences "$expected_references_json" \
              '.references | map(select(. != $path)) == ($expectedReferences | map(select(. != $path)))' \
              <<<"$entry_json" >/dev/null 2>&1; then
              failure_reason="reference mismatch"
              return 1
            fi
            metadata_file="$cache_directory/''${closure_path##*/}.json"
            printf '%s\n' "$entry_json" >"$metadata_file" || {
              failure_reason="metadata malformed"
              return 1
            }
          done < <("$jq" -r '.[]' <<<"$closure_json")
          return 0
        }

        validate_path() {
          local cache_index="$1"
          local store_path="$2"
          local cache_directory="$validation_root/cache-$cache_index"
          local store_name="''${store_path##*/}"
          local status_file="$cache_directory/$store_name.status"
          local visiting_file="$cache_directory/$store_name.visiting"
          local info_file
          local own_reason=""

          if [[ -f "$status_file" ]]; then
            failure_reason="$($head -n 1 "$status_file" 2>/dev/null)"
            if [[ "$failure_reason" == valid ]]; then
              return 0
            fi
            return 1
          fi
          if [[ -f "$visiting_file" ]]; then
            failure_reason="graph cycle"
            return 1
          fi
          : >"$visiting_file"
          if ! prepare_cache "$cache_index" "$store_path"; then
            own_reason="$failure_reason"
          elif ! native_cache_verify "$cache_index" "$store_path"; then
            own_reason="$failure_reason"
          elif ! info_file="$(native_path_info "$cache_index" "$store_path")"; then
            own_reason="$failure_reason"
          elif ! validate_native_metadata "$cache_index" "$store_path" "$info_file"; then
            own_reason="$failure_reason"
          fi
          "$rm" -f -- "$visiting_file"
          if [[ -z "$own_reason" ]]; then
            printf '%s\n' valid >"$status_file"
            failure_reason="valid"
            return 0
          fi
          printf '%s\n' "$own_reason" >"$status_file"
          failure_reason="$own_reason"
          return 1
        }

        record_cut() {
          local cache_index="$1"
          local root_path="$2"
          local closure_json
          local closure_digest
          local cache_directory="$validation_root/cache-$cache_index"
          local common_key_ids
          local signing_key_id
          local narinfos_json
          local closure_path
          local metadata_file
          local -a metadata_files=()

          closure_json="$(closure_for_root "$root_path")" || {
            failure_reason="metadata malformed"
            return 1
          }
          if "$jq" -n -e \
            --arg topOutput "$top_output" \
            --argjson closure "$closure_json" \
            '($closure | index($topOutput)) != null' >/dev/null 2>&1; then
            failure_reason="top output in closure"
            return 1
          fi
          while IFS= read -r closure_path; do
            [[ -n "$closure_path" ]] || continue
            metadata_file="$cache_directory/''${closure_path##*/}.json"
            if [[ ! -f "$metadata_file" || -L "$metadata_file" ]]; then
              failure_reason="metadata missing"
              return 1
            fi
            metadata_files+=("$metadata_file")
          done < <("$jq" -r '.[]' <<<"$closure_json")
          common_key_ids="$("$jq" -s -c '
            map(.signatures | map(split(":")[0]) | unique) as $sets
            | if ($sets | length) == 0 then []
              else ($sets[0]
                | map(select(. as $key | all($sets[]; index($key) != null)))
                | sort)
              end
          ' "''${metadata_files[@]}")" || {
            failure_reason="signature mismatch"
            return 1
          }
          signing_key_id="$($jq -r '.[0] // empty' <<<"$common_key_ids")"
          if [[ -z "$signing_key_id" ]]; then
            failure_reason="signature mismatch"
            return 1
          fi
          narinfos_json="$($jq -s -c 'sort_by(.storePath)' "''${metadata_files[@]}")" || {
            failure_reason="metadata malformed"
            return 1
          }
          closure_digest="$(printf '%s' "$closure_json" | "$sha256sum" | "$cut" -d ' ' -f 1)" || {
            failure_reason="metadata malformed"
            return 1
          }
          "$jq" -n -cS \
            --arg rootPath "$root_path" \
            --argjson closure "$closure_json" \
            --arg closureDigest "sha256:$closure_digest" \
            --arg endpoint "$("$jq" -n -r --argjson index "$cache_index" \
              --argjson configurations "$approved_cache_configurations" \
              '$configurations[$index].endpoint' 2>/dev/null)" \
            --arg signingKeyId "$signing_key_id" \
            --argjson narinfos "$narinfos_json" \
            '{
              rootPath: $rootPath,
              closure: $closure,
              closureDigest: $closureDigest,
              endpoint: $endpoint,
              signingKeyId: $signingKeyId,
              narinfos: $narinfos
            }' >>"$cuts_file" || {
            failure_reason="metadata malformed"
            return 1
          }
          while IFS= read -r closure_path; do
            [[ -n "$closure_path" ]] || continue
            if ! path_in_file "$closure_path" "$covered_paths_file"; then
              printf '%s\n' "$closure_path" >>"$covered_paths_file"
            fi
          done < <("$jq" -r '.[]' <<<"$closure_json")
          return 0
        }

        process_branch() {
          local root_path="$1"
          local cache_index=0
          local candidate_reason=""

          if [[ "$root_path" == "$top_output" ]]; then
            append_traversal "$root_path" "top output"
            return 0
          fi
          if [[ "$("$jq" -r --arg path "$root_path" \
            '.graph.references[$path] | if . == null then "no" else "yes" end' "$request_meta_file")" != yes ]]; then
            append_traversal "$root_path" "outside requested graph"
            return 0
          fi
          if path_in_file "$root_path" "$covered_paths_file" \
            || path_in_file "$root_path" "$processed_branches_file"; then
            return 0
          fi

          while (( cache_index < approved_cache_count )); do
            if validate_path "$cache_index" "$root_path"; then
              if record_cut "$cache_index" "$root_path"; then
                return 0
              fi
              candidate_reason="$failure_reason"
            else
              candidate_reason="''${candidate_reason:-$failure_reason}"
            fi
            cache_index=$((cache_index + 1))
          done
          [[ -n "$candidate_reason" ]] || candidate_reason="narinfo unavailable"
          append_traversal "$root_path" "$candidate_reason"
          while IFS= read -r child; do
            [[ -n "$child" ]] || continue
            process_branch "$child"
          done < <("$jq" -r --arg path "$root_path" '.graph.references[$path][]?' "$request_meta_file")
        }

        while IFS= read -r candidate_root; do
          [[ -n "$candidate_root" ]] || continue
          process_branch "$candidate_root"
        done < <("$jq" -r '.candidateRoots[]?' "$request_meta_file")

        cut_count="$($wc -l <"$cuts_file" 2>/dev/null)"
        traversal_count="$($wc -l <"$traversal_file" 2>/dev/null)"
        cut_count="''${cut_count//[[:space:]]/}"
        traversal_count="''${traversal_count//[[:space:]]/}"
        if [[ "$traversal_count" =~ ^[0-9]+$ ]] && (( traversal_count > 0 )); then
          emit_result traverse "incomplete cache coverage" "unresolved cache branches remain in traversal"
        elif [[ "$cut_count" =~ ^[0-9]+$ ]] && (( cut_count > 0 )); then
          emit_result cut "" "complete approved public-cache cuts verified"
        else
          emit_result traverse "no cache cut" "no complete approved public-cache cut was verified"
        fi
        exit 0
  '';
}
