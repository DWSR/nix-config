{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  util-linux,
  nixExecutable ? "/run/current-system/sw/bin/nix",
  classifierExecutable ? "/run/current-system/sw/bin/shopify-remote-builder-source-classifier",
  curlExecutable ? "/run/current-system/sw/bin/curl",
  gitExecutable ? "/run/current-system/sw/bin/git",
  tarExecutable ? "/run/current-system/sw/bin/tar",
  unzipExecutable ? "/run/current-system/sw/bin/unzip",
  mvExecutable ? "/run/current-system/sw/bin/mv",
  setsidExecutable ? "${util-linux}/bin/setsid",
  commandTimeoutSeconds ? 1800,
  commandKillAfterSeconds ? 5,
  classifierTimeoutSeconds ? 30,
  maxRequestBytes ? 131072,
  maxCommandOutputBytes ? 64 * 1024,
  maxWorkspaceBytes ? 20 * 1024 * 1024 * 1024,
  policyProxyPort ? 1080,
  pinnedCaBundle ? "",
  pinnedCaBundleSha256 ? "",
}:

assert lib.isInt commandTimeoutSeconds;
assert commandTimeoutSeconds > 0;
assert lib.isInt commandKillAfterSeconds;
assert commandKillAfterSeconds > 0;
assert lib.isInt classifierTimeoutSeconds;
assert classifierTimeoutSeconds > 0;
assert lib.isInt maxRequestBytes;
assert maxRequestBytes > 0;
assert lib.isInt maxCommandOutputBytes;
assert maxCommandOutputBytes > 0;
assert lib.isInt maxWorkspaceBytes;
assert maxWorkspaceBytes > 0;
assert lib.isInt policyProxyPort;
assert policyProxyPort > 1023;
assert policyProxyPort <= 65535;
let
  coreutilsBin = "${coreutils}/bin";
  jqExecutablePath = "${jq}/bin/jq";
  safePath = lib.makeBinPath [
    coreutils
    jq
    util-linux
  ];
in
writeShellApplication {
  name = "shopify-remote-builder-source-replay";
  runtimeInputs = [
    coreutils
    jq
    util-linux
  ];
  text = ''
        export LC_ALL=C
        umask 077
        set -o pipefail

        jq=${lib.escapeShellArg jqExecutablePath}
         env_command=${lib.escapeShellArg "${coreutilsBin}/env"}
         du=${lib.escapeShellArg "${coreutilsBin}/du"}
         head=${lib.escapeShellArg "${coreutilsBin}/head"}
         kill_command=${lib.escapeShellArg "${coreutilsBin}/kill"}
         mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
         mkfifo=${lib.escapeShellArg "${coreutilsBin}/mkfifo"}
         mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
         move_command=${lib.escapeShellArg "${coreutilsBin}/mv"}
         realpath=${lib.escapeShellArg "${coreutilsBin}/realpath"}
         rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
         sha256sum=${lib.escapeShellArg "${coreutilsBin}/sha256sum"}
         setsid=${lib.escapeShellArg setsidExecutable}
         sleep_command=${lib.escapeShellArg "${coreutilsBin}/sleep"}
         stat=${lib.escapeShellArg "${coreutilsBin}/stat"}
         timeout=${lib.escapeShellArg "${coreutilsBin}/timeout"}
         wc=${lib.escapeShellArg "${coreutilsBin}/wc"}
        nix=${lib.escapeShellArg nixExecutable}
        classifier=${lib.escapeShellArg classifierExecutable}
        curl=${lib.escapeShellArg curlExecutable}
        git=${lib.escapeShellArg gitExecutable}
        tar=${lib.escapeShellArg tarExecutable}
        unzip=${lib.escapeShellArg unzipExecutable}
        mv=${lib.escapeShellArg mvExecutable}
        safe_path=${lib.escapeShellArg safePath}
        command_timeout_seconds=${toString commandTimeoutSeconds}
        command_kill_after_seconds=${toString commandKillAfterSeconds}
         classifier_timeout_seconds=${toString classifierTimeoutSeconds}
         max_request_bytes=${toString maxRequestBytes}
         max_command_output_bytes=${toString maxCommandOutputBytes}
         max_workspace_bytes=${toString maxWorkspaceBytes}
         policy_proxy_endpoint=${lib.escapeShellArg "socks5h://127.0.0.1:${toString policyProxyPort}"}
         pinned_ca_bundle=${lib.escapeShellArg (toString pinnedCaBundle)}
         pinned_ca_bundle_sha256=${lib.escapeShellArg (toString pinnedCaBundleSha256)}

         validation_root=""
         replay_store_root=""
         command_group_pid=""
         command_sequence=0
         last_command_status=0
         invocation_deadline_microseconds=0
         result_nonce=""
        result_profile=""
        result_primed=false
        result_check_runs=0

        emit_result() {
          local decision="$1"
          local reason="$2"
          local detail="$3"
          local evidence="''${4:-null}"
          "$jq" -n -cS \
            --argjson schemaVersion 1 \
            --arg nonce "$result_nonce" \
            --arg decision "$decision" \
            --arg reason "$reason" \
            --arg profile "$result_profile" \
            --argjson primed "$result_primed" \
            --argjson checkRuns "$result_check_runs" \
            --argjson evidence "$evidence" \
            --arg detail "$detail" \
            "{
              schemaVersion: \$schemaVersion,
              nonce: (if \$nonce == \"\" then null else \$nonce end),
              decision: \$decision,
              reason: (if \$reason == \"\" then null else \$reason end),
              profile: (if \$profile == \"\" then null else \$profile end),
              primed: \$primed,
              checkRuns: \$checkRuns,
              evidence: \$evidence,
              detail: \$detail
            }"
        }

        cleanup_process_group() {
          local group_pid="$1"
          local attempt=0
          if [[ "$group_pid" =~ ^[0-9]+$ ]]; then
            "$kill_command" -TERM -- "-$group_pid" 2>/dev/null || true
            "$sleep_command" 0.02 2>/dev/null || true
            "$kill_command" -KILL -- "-$group_pid" 2>/dev/null || true
            while (( attempt < 50 )); do
              if ! "$kill_command" -0 -- "-$group_pid" 2>/dev/null; then
                break
              fi
              "$sleep_command" 0.02 2>/dev/null || true
              attempt=$((attempt + 1))
            done
          fi
        }

        cleanup() {
         cleanup_process_group "$command_group_pid"
         command_group_pid=""
           if [[ -n "$replay_store_root" ]]; then
             "$rm" -rf -- "$replay_store_root" 2>/dev/null || true
             replay_store_root=""
           fi
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

         now_microseconds() {
           local timestamp="$EPOCHREALTIME"
           local seconds="''${timestamp%%.*}"
           local fraction="''${timestamp#*.}"
           fraction="''${fraction}000000"
           fraction="''${fraction:0:6}"
           printf '%s\n' "$((10#$seconds * 1000000 + 10#$fraction))"
         }

         remaining_microseconds() {
           local now
           local remaining
           now="$(now_microseconds)" || return 1
           remaining=$((invocation_deadline_microseconds - now))
           if (( remaining <= 0 )); then
             return 1
           fi
           printf '%s\n' "$remaining"
         }

         format_timeout_duration() {
           local duration_microseconds="$1"
           printf '%d.%06ds\n' \
             "$((duration_microseconds / 1000000))" \
             "$((duration_microseconds % 1000000))"
         }

         trap cleanup EXIT
        trap 'on_signal 129' HUP
        trap 'on_signal 130' INT
         trap 'on_signal 143' TERM

         invocation_start_microseconds="$(now_microseconds)" || {
           emit_result error "internal validation failure" "validation clock could not be read"
           exit 1
         }
         invocation_deadline_microseconds=$((invocation_start_microseconds + command_timeout_seconds * 1000000))

         temp_template="''${TMPDIR:-/tmp}/shopify-remote-builder-source-replay.XXXXXX"
        validation_root="$("$mktemp" -d "$temp_template" 2>/dev/null)" || {
          emit_result error "internal validation failure" "replay state could not be created"
          exit 1
        }
        validation_root="$("$realpath" "$validation_root" 2>/dev/null)" || {
          emit_result error "internal validation failure" "replay state could not be canonicalized"
          exit 1
        }
        replay_store_root="$validation_root.store"
        if ! "$mkdir" -p -- "$replay_store_root" 2>/dev/null; then
          emit_result error "internal validation failure" "replay store could not be created"
          exit 1
        fi
        replay_store_realpath="$("$realpath" "$replay_store_root" 2>/dev/null)" || {
          emit_result error "internal validation failure" "replay store could not be canonicalized"
          exit 1
        }
        if [[ "$replay_store_realpath" != "$replay_store_root" ]]; then
          emit_result error "internal validation failure" "replay store could not be canonicalized"
          exit 1
        fi
        replay_store="local?root=$replay_store_root"
        for directory in home tmp workspace nix-conf nix-config-home nix-state nix-log nix-cache; do
          if ! "$mkdir" -p -- "$validation_root/$directory" 2>/dev/null; then
            emit_result error "internal validation failure" "replay state could not be created"
            exit 1
          fi
        done

        request_file="$validation_root/request.json"
        request_limit=$((max_request_bytes + 1))
        set +e
        "$timeout" --signal=KILL 2s "$head" -c "$request_limit" >"$request_file" 2>/dev/null
        request_read_status=$?
        set -e
        if (( request_read_status == 124 || request_read_status == 137 )); then
          emit_result ineligible "resource limit" "replay request exceeded a validation limit"
          exit 0
        elif (( request_read_status != 0 )); then
          emit_result error "internal validation failure" "replay request could not be read"
          exit 1
        fi
        request_bytes="$($wc -c <"$request_file" 2>/dev/null)" || {
          emit_result error "internal validation failure" "replay request size could not be checked"
          exit 1
        }
        request_bytes="''${request_bytes//[[:space:]]/}"
        if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
          emit_result ineligible "resource limit" "replay request exceeded a validation limit"
          exit 0
        fi

        request_meta_file="$validation_root/request-meta.json"
        if ! "$jq" -c -e --arg proxyEndpoint "$policy_proxy_endpoint" "
          def exact_object(\$required; \$allowed):
            type == \"object\"
            and ((keys - \$allowed) | length) == 0
            and (. as \$object | all(\$required[]; . as \$key | (\$object | has(\$key))));
          def nonempty_string:
            type == \"string\" and utf8bytelength > 0 and utf8bytelength <= 4096;
          def store_path:
            type == \"string\"
            and utf8bytelength <= 266
            and test(\"^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+?=-]+\$\");
          def hash:
            type == \"string\"
            and utf8bytelength == 51
            and test(\"^sha256-[A-Za-z0-9+/]{43}=\$\");
          def valid_proxy:
            type == \"string\"
            and . == \$proxyEndpoint;
          if (type != \"object\")
            or ((keys - [\"schemaVersion\", \"nonce\", \"system\", \"source\", \"expected\", \"proxy\"]) | length) != 0
            or .schemaVersion != 1
            or (.nonce | nonempty_string | not)
            or (.nonce | test(\"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\$\") | not)
            or .system != \"aarch64-darwin\"
            or (.source | type != \"object\")
            or (.expected | exact_object([\"path\", \"hash\"]; [\"path\", \"hash\"]) | not)
            or (.expected.path | store_path | not)
            or (.expected.hash | hash | not)
            or (.proxy | exact_object([\"endpoint\", \"nonce\"]; [\"endpoint\", \"nonce\"]) | not)
            or (.proxy.endpoint | valid_proxy | not)
            or (.proxy.nonce != .nonce)
          then
            error(\"request rejected\")
          else
            .
          end
        " "$request_file" >"$request_meta_file" 2>/dev/null; then
          emit_result ineligible "schema drift" "replay request schema rejected"
          exit 0
        fi

         result_nonce="$($jq -r '.nonce' "$request_meta_file")"
        expected_path="$($jq -r '.expected.path' "$request_meta_file")"
        expected_hash="$($jq -r '.expected.hash' "$request_meta_file")"
        proxy_endpoint="$($jq -r '.proxy.endpoint' "$request_meta_file")"
        ca_bundle="$pinned_ca_bundle"
        source_file="$validation_root/source.json"
        "$jq" -c '.source' "$request_meta_file" >"$source_file" || {
          emit_result error "internal validation failure" "source profile could not be prepared"
          exit 1
        }
        if [[ -z "$ca_bundle" || ! -f "$ca_bundle" || -L "$ca_bundle" ]]; then
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        fi
        ca_bundle_realpath="$($realpath "$ca_bundle" 2>/dev/null)" || {
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        }
        if [[ "$ca_bundle_realpath" != "$ca_bundle" ]]; then
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        fi
        ca_bundle_metadata="$($stat -c '%u:%g:%a' -- "$ca_bundle" 2>/dev/null)" || {
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        }
        if [[ ! "$ca_bundle_metadata" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]]; then
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        fi
        ca_bundle_mode="''${ca_bundle_metadata##*:}"
        ca_bundle_mode="''${ca_bundle_mode: -3}"
        for mode_digit in ''${ca_bundle_mode:0:1} ''${ca_bundle_mode:1:1} ''${ca_bundle_mode:2:1}; do
          if (( 10#$mode_digit & 2 )); then
            emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
            exit 0
          fi
        done
        if [[ ! "$pinned_ca_bundle_sha256" =~ ^[0-9a-f]{64}$ ]]; then
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        fi
        ca_bundle_digest="$($sha256sum -- "$ca_bundle" 2>/dev/null)" || {
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        }
        ca_bundle_digest="''${ca_bundle_digest%%[[:space:]]*}"
        if [[ "$ca_bundle_digest" != "$pinned_ca_bundle_sha256" ]]; then
          emit_result ineligible "schema drift" "pinned CA bundle is unavailable"
          exit 0
        fi

        replay_env=(
          "HOME=$validation_root/home"
          "LANG=C"
          "LC_ALL=C"
          "PATH=$safe_path"
          "TMPDIR=$validation_root/tmp"
          "XDG_CACHE_HOME=$validation_root/nix-cache"
          "XDG_CONFIG_HOME=$validation_root/nix-config-home"
          "XDG_STATE_HOME=$validation_root/nix-state"
          "NIX_CACHE_DIR=$validation_root/nix-cache"
          "NIX_CONFIG_HOME=$validation_root/nix-config-home"
          "NIX_CONF_DIR=$validation_root/nix-conf"
          "NIX_LOG_DIR=$validation_root/nix-log"
          "NIX_STATE_DIR=$validation_root/nix-state"
          "NIX_USER_CONF_FILES=/dev/null"
          "NIX_CONFIG=experimental-features = nix-command flakes
    sandbox = true
    substituters =
    extra-substituters =
    trusted-substituters =
    builders =
    substitute = false
    post-build-hook =
    plugin-files =
    access-tokens =
    netrc-file = /dev/null
    flake-registry = /dev/null
    impure-envs ="
          "ALL_PROXY=$proxy_endpoint"
          "HTTP_PROXY=$proxy_endpoint"
          "HTTPS_PROXY=$proxy_endpoint"
          "all_proxy=$proxy_endpoint"
          "http_proxy=$proxy_endpoint"
          "https_proxy=$proxy_endpoint"
          "NO_PROXY="
          "no_proxy="
          "SSL_CERT_FILE=$ca_bundle"
          "CURL_CA_BUNDLE=$ca_bundle"
        )

        workspace_usage_exceeded() {
          local workspace_blocks
          local store_blocks
          workspace_blocks="$($du -sk -- "$validation_root" 2>/dev/null)" || return 1
          workspace_blocks="''${workspace_blocks%%[[:space:]]*}"
          [[ "$workspace_blocks" =~ ^[0-9]+$ ]] || return 1
          store_blocks="$($du -sk -- "$replay_store_root" 2>/dev/null)" || return 1
          store_blocks="''${store_blocks%%[[:space:]]*}"
          [[ "$store_blocks" =~ ^[0-9]+$ ]] || return 1
          workspace_blocks=$((workspace_blocks + store_blocks))
          (( workspace_blocks > (max_workspace_bytes + 1023) / 1024 ))
        }

        capture_command_stream() {
          local fifo="$1"
          local output_file="$2"
          local overflow_file="$3"
          local failure_file="$4"
          local capture_file
          local capture_status
          local stream_bytes

          capture_file="$($mktemp "$validation_root/capture.XXXXXX" 2>/dev/null)" || {
            : >"$failure_file"
            return 0
          }
          set +e
          "$head" -c "$((max_command_output_bytes + 1))" "$fifo" >"$capture_file" 2>/dev/null
          capture_status=$?
          set -e
          if (( capture_status != 0 )); then
            : >"$failure_file"
            "$rm" -f -- "$capture_file" 2>/dev/null || true
            return 0
          fi
          stream_bytes="$($wc -c <"$capture_file" 2>/dev/null)"
          stream_bytes="''${stream_bytes//[[:space:]]/}"
          if [[ ! "$stream_bytes" =~ ^[0-9]+$ ]]; then
            : >"$failure_file"
            "$rm" -f -- "$capture_file" 2>/dev/null || true
            return 0
          fi
          if (( stream_bytes > max_command_output_bytes )); then
            "$head" -c "$max_command_output_bytes" "$capture_file" >"$output_file" 2>/dev/null || true
            : >"$overflow_file"
          else
            "$move_command" -- "$capture_file" "$output_file" 2>/dev/null || : >"$failure_file"
          fi
          "$rm" -f -- "$capture_file" 2>/dev/null || true
        }

        monitor_command_limits() {
          local command_pid="$1"
          local stdout_overflow_file="$2"
          local stderr_overflow_file="$3"
          local workspace_overflow_file="$4"
          local deadline_file="$5"

          while "$kill_command" -0 "$command_pid" 2>/dev/null; do
            if [[ -e "$stdout_overflow_file" || -e "$stderr_overflow_file" ]] \
              || workspace_usage_exceeded; then
              : >"$workspace_overflow_file"
              cleanup_process_group "$command_pid"
              break
            elif ! remaining_microseconds >/dev/null 2>&1; then
              : >"$deadline_file"
              cleanup_process_group "$command_pid"
              break
            fi
            "$sleep_command" 0.02 2>/dev/null || true
          done
        }

        run_isolated_command() {
          local input_file="$1"
          local duration_seconds="$2"
          local output_file="$3"
          local error_file="$4"
          shift 4
          local command_id
          local stdout_fifo
          local stderr_fifo
          local stdout_overflow_file
          local stderr_overflow_file
          local workspace_overflow_file
          local capture_failure_file
          local stdout_capture_pid
          local stderr_capture_pid
          local monitor_pid
          local command_pid
          local command_status
          local monitor_status
          local stdout_capture_status
          local stderr_capture_status
          local deadline_file
          local remaining_budget
          local requested_budget
          local effective_budget
          local timeout_duration
          local deadline_exceeded=false

          if ! remaining_budget="$(remaining_microseconds)"; then
            last_command_status=124
            return 0
          fi
          requested_budget=$((duration_seconds * 1000000))
          if (( requested_budget < remaining_budget )); then
            effective_budget="$requested_budget"
          else
            effective_budget="$remaining_budget"
          fi
          timeout_duration="$(format_timeout_duration "$effective_budget")"

          command_sequence=$((command_sequence + 1))
          command_id="$command_sequence"
          stdout_fifo="$validation_root/command-$command_id.stdout.fifo"
          stderr_fifo="$validation_root/command-$command_id.stderr.fifo"
          stdout_overflow_file="$validation_root/command-$command_id.stdout.overflow"
          stderr_overflow_file="$validation_root/command-$command_id.stderr.overflow"
          workspace_overflow_file="$validation_root/command-$command_id.workspace.overflow"
          capture_failure_file="$validation_root/command-$command_id.capture.failure"
          deadline_file="$validation_root/command-$command_id.deadline"
          if ! "$mkfifo" "$stdout_fifo" "$stderr_fifo" 2>/dev/null; then
            last_command_status=125
            return 0
          fi

          capture_command_stream "$stdout_fifo" "$output_file" "$stdout_overflow_file" "$capture_failure_file" &
          stdout_capture_pid=$!
          capture_command_stream "$stderr_fifo" "$error_file" "$stderr_overflow_file" "$capture_failure_file" &
          stderr_capture_pid=$!
          set +e
          if [[ -n "$input_file" ]]; then
            "$setsid" "$timeout" \
              --signal=TERM \
              --kill-after="''${command_kill_after_seconds}s" \
              "$timeout_duration" \
              "$env_command" -i "''${replay_env[@]}" "$@" <"$input_file" >"$stdout_fifo" 2>"$stderr_fifo" &
          else
            "$setsid" "$timeout" \
              --signal=TERM \
              --kill-after="''${command_kill_after_seconds}s" \
              "$timeout_duration" \
              "$env_command" -i "''${replay_env[@]}" "$@" >"$stdout_fifo" 2>"$stderr_fifo" &
          fi
          command_pid=$!
          command_group_pid="$command_pid"
          monitor_command_limits "$command_pid" "$stdout_overflow_file" "$stderr_overflow_file" \
            "$workspace_overflow_file" "$deadline_file" &
          monitor_pid=$!
          wait "$command_pid"
          command_status=$?
          wait "$monitor_pid"
          monitor_status=$?
          wait "$stdout_capture_pid"
          stdout_capture_status=$?
          wait "$stderr_capture_pid"
          stderr_capture_status=$?
          set -e
          if workspace_usage_exceeded; then
            : >"$workspace_overflow_file"
          fi
          cleanup_process_group "$command_pid"
          command_group_pid=""
          if [[ -e "$deadline_file" ]]; then
            deadline_exceeded=true
          fi
          "$rm" -f -- "$stdout_fifo" "$stderr_fifo" "$deadline_file" 2>/dev/null || true
          if [[ "$deadline_exceeded" == true ]]; then
            last_command_status=124
          elif (( monitor_status != 0 || stdout_capture_status != 0 || stderr_capture_status != 0 )) \
            || [[ -e "$stdout_overflow_file" || -e "$stderr_overflow_file" \
              || -e "$workspace_overflow_file" || -e "$capture_failure_file" ]]; then
            last_command_status=125
          else
            last_command_status="$command_status"
          fi
          return 0
        }

        run_isolated() {
          local output_file="$1"
          local error_file="$2"
          shift 2
          run_isolated_command "" "$command_timeout_seconds" "$output_file" "$error_file" "$@"
        }

        run_isolated_with_input() {
          local input_file="$1"
          local output_file="$2"
          local error_file="$3"
          shift 3
          run_isolated_command "$input_file" "$classifier_timeout_seconds" "$output_file" "$error_file" "$@"
        }

        classifier_output="$validation_root/classifier.stdout"
        classifier_error="$validation_root/classifier.stderr"
        set +e
        run_isolated_with_input "$source_file" "$classifier_output" "$classifier_error" "$classifier"
        classifier_status="$last_command_status"
        set -e
        if (( classifier_status != 0 )); then
          emit_result error "command failure" "source classifier failed"
          exit 0
        fi
        if ! "$jq" -e '
          type == "object"
          and ((keys | sort) == ["decision", "profile", "reason"])
          and .decision == "supported"
          and (.profile == "fetchurl" or .profile == "fetchzip" or .profile == "fetchgit")
          and .reason == null
        ' "$classifier_output" >/dev/null 2>/dev/null; then
          classifier_decision="$($jq -r '.decision // "ineligible"' "$classifier_output" 2>/dev/null || printf ineligible)"
          classifier_reason="$($jq -r '.reason // "schema drift"' "$classifier_output" 2>/dev/null || printf 'schema drift')"
          case "$classifier_reason" in
            "credential syntax"|"custom hook"|"custom options"|"lfs"|"local input"|"mirrors"|"multiple sources"|"mutable source"|"schema drift"|"submodules"|"tags"|"unknown fetcher")
              safe_reason="$classifier_reason"
              ;;
            *)
              safe_reason="schema drift"
              ;;
          esac
          if [[ "$classifier_decision" == ineligible ]]; then
            emit_result ineligible "$safe_reason" "source profile is not in the replay policy"
          else
            emit_result error "schema drift" "source classifier response was invalid"
          fi
          exit 0
        fi

        result_profile="$($jq -r '.profile' "$classifier_output")"
        source_builder="$($jq -r '.builder' "$source_file")"
        source_url="$($jq -r '.urls[0]' "$source_file")"
        source_hash="$($jq -r '.hash' "$source_file")"
        source_hash_mode="$($jq -r '.hashMode' "$source_file")"
        source_revision="$($jq -r '.revision // ""' "$source_file")"
        if [[ "$source_builder" != "$result_profile" ]]; then
          emit_result error "schema drift" "source classifier did not bind the replay profile"
          exit 0
        fi
        if [[ "$source_hash" == null || "$source_url" == null ]]; then
          emit_result error "schema drift" "source replay profile was incomplete"
          exit 0
        fi

        expected_basename="''${expected_path##*/}"
        replay_name="''${expected_basename:33}"
        if [[ -z "$replay_name" || "$replay_name" == "$expected_basename" ]]; then
          emit_result error "schema drift" "expected replay output name was invalid"
          exit 0
        fi

        nix_quote() {
          "$jq" -Rn --arg value "$1" "\$value"
        }

        replay_name_nix="$(nix_quote "$replay_name")"
        source_url_nix="$(nix_quote "$source_url")"
        source_hash_nix="$(nix_quote "$source_hash")"
        source_hash_mode_nix="$(nix_quote "$source_hash_mode")"
        source_revision_nix="$(nix_quote "$source_revision")"
        proxy_nix="$(nix_quote "$proxy_endpoint")"
        ca_bundle_nix="$(nix_quote "$ca_bundle")"
        curl_nix="$(nix_quote "$curl")"
        git_nix="$(nix_quote "$git")"
        tar_nix="$(nix_quote "$tar")"
        unzip_nix="$(nix_quote "$unzip")"
        mv_nix="$(nix_quote "$mv")"
        mkdir_nix="$(nix_quote "${coreutilsBin}/mkdir")"
        rm_nix="$(nix_quote "${coreutilsBin}/rm")"

        case "$result_profile" in
          fetchurl)
            builder_script="set -eu
    export ALL_PROXY=\"\$REPLAY_PROXY\"
    export HTTP_PROXY=\"\$REPLAY_PROXY\"
    export HTTPS_PROXY=\"\$REPLAY_PROXY\"
    export SSL_CERT_FILE=\"\$REPLAY_CA_BUNDLE\"
    export CURL_CA_BUNDLE=\"\$REPLAY_CA_BUNDLE\"
    exec \"\$REPLAY_CURL\" --fail --silent --show-error --location --proto \"=https\" --tlsv1.2 --cacert \"\$REPLAY_CA_BUNDLE\" --proxy \"\$REPLAY_PROXY\" \"\$REPLAY_URL\" --output \"\$out\""
            ;;
          fetchzip)
            builder_script="set -eu
    export ALL_PROXY=\"\$REPLAY_PROXY\"
    export HTTP_PROXY=\"\$REPLAY_PROXY\"
    export HTTPS_PROXY=\"\$REPLAY_PROXY\"
    export SSL_CERT_FILE=\"\$REPLAY_CA_BUNDLE\"
    export CURL_CA_BUNDLE=\"\$REPLAY_CA_BUNDLE\"
    archive=\"\$TMPDIR/shopify-remote-builder-source.zip\"
    \"\$REPLAY_CURL\" --fail --silent --show-error --location --proto \"=https\" --tlsv1.2 --cacert \"\$REPLAY_CA_BUNDLE\" --proxy \"\$REPLAY_PROXY\" \"\$REPLAY_URL\" --output \"\$archive\"
          \"\$REPLAY_MKDIR\" -p \"\$out\"
          if \"\$REPLAY_TAR\" -xf \"\$archive\" -C \"\$out\"; then
            :
          else
            \"\$REPLAY_UNZIP\" -q \"\$archive\" -d \"\$out\"
          fi
          root=\"\"
          root_count=0
          for entry in \"\$out\"/*; do
            [ -e \"\$entry\" ] || continue
            root=\"\$entry\"
            root_count=\$((root_count + 1))
          done
          if [ \"\$root_count\" -eq 1 ] && [ -d \"\$root\" ]; then
            for entry in \"\$root\"/* \"\$root\"/.[!.]* \"\$root\"/..?*; do
              [ -e \"\$entry\" ] || continue
              \"\$REPLAY_MV\" \"\$entry\" \"\$out/\"
            done
            \"\$REPLAY_RM\" -rf \"\$root\"
          fi
          \"\$REPLAY_RM\" -f \"\$archive\""
            ;;
          fetchgit)
            builder_script="set -eu
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_TERMINAL_PROMPT=0
    export ALL_PROXY=\"\$REPLAY_PROXY\"
    export HTTP_PROXY=\"\$REPLAY_PROXY\"
    export HTTPS_PROXY=\"\$REPLAY_PROXY\"
    export SSL_CERT_FILE=\"\$REPLAY_CA_BUNDLE\"
    export GIT_SSL_CAINFO=\"\$REPLAY_CA_BUNDLE\"
            \"\$REPLAY_GIT\" -c \"http.proxy=\$REPLAY_PROXY\" -c \"http.sslCAInfo=\$REPLAY_CA_BUNDLE\" -c core.hooksPath=/dev/null clone --no-checkout --no-tags --no-recurse-submodules \"\$REPLAY_URL\" \"\$out\"
            \"\$REPLAY_GIT\" -C \"\$out\" checkout --detach \"\$REPLAY_REVISION\"
            \"\$REPLAY_RM\" -rf \"\$out/.git\""
            ;;
          *)
            emit_result error "unknown fetcher" "source profile is outside the replay policy"
            exit 0
            ;;
        esac
        builder_script_nix="$(nix_quote "$builder_script")"
        replay_expression="$({
          printf '%s\n' 'let' '  replay = builtins.derivation {'
          printf '    name = %s;\n' "$replay_name_nix"
          printf '    system = "aarch64-darwin";\n'
          printf '    builder = "/bin/sh";\n'
          printf '    args = [ "-c" %s ];\n' "$builder_script_nix"
          printf '    outputHashAlgo = "sha256";\n'
          printf '    outputHash = %s;\n' "$source_hash_nix"
          printf '    outputHashMode = %s;\n' "$source_hash_mode_nix"
          printf '    impureEnvVars = [];\n'
          printf '    REPLAY_URL = %s;\n' "$source_url_nix"
          printf '    REPLAY_REVISION = %s;\n' "$source_revision_nix"
          printf '    REPLAY_PROXY = %s;\n' "$proxy_nix"
          printf '    REPLAY_CA_BUNDLE = %s;\n' "$ca_bundle_nix"
          printf '    REPLAY_CURL = %s;\n' "$curl_nix"
          printf '    REPLAY_GIT = %s;\n' "$git_nix"
          printf '    REPLAY_TAR = %s;\n' "$tar_nix"
          printf '    REPLAY_UNZIP = %s;\n' "$unzip_nix"
          printf '    REPLAY_MV = %s;\n' "$mv_nix"
          printf '    REPLAY_MKDIR = %s;\n' "$mkdir_nix"
          printf '    REPLAY_RM = %s;\n' "$rm_nix"
          printf '  };'
          printf '%s\n' 'in replay'
        } )"

        common_build_args=(
          build
          --store "$replay_store"
          --no-link
          --expr "$replay_expression"
          --refresh
          --option sandbox true
          --option substitute false
          --option builders ""
          --option substituters ""
          --option extra-substituters ""
          --option trusted-substituters ""
          --option post-build-hook ""
          --option plugin-files ""
          --option access-tokens ""
          --option netrc-file /dev/null
          --option flake-registry /dev/null
          --option impure-envs ""
          --option max-build-log-size "$max_command_output_bytes"
          --option build-dir "$validation_root/workspace"
          --option http-proxy "$proxy_endpoint"
          --option ssl-cert-file "$ca_bundle"
        )

        presence_output="$validation_root/presence.stdout"
        presence_error="$validation_root/presence.stderr"
        set +e
        run_isolated "$presence_output" "$presence_error" "$nix" path-info --json --store "$replay_store" "$expected_path"
        presence_status="$last_command_status"
        set -e
        if (( presence_status == 0 )); then
          output_present=true
        elif (( presence_status == 1 )); then
          output_present=false
        else
          output_present=false
          presence_failed=true
        fi

        normal_status=0
        if [[ "''${output_present:-false}" == false && "''${presence_failed:-false}" != true ]]; then
          normal_output="$validation_root/normal.stdout"
          normal_error="$validation_root/normal.stderr"
          set +e
          run_isolated "$normal_output" "$normal_error" "$nix" "''${common_build_args[@]}"
          normal_status="$last_command_status"
          set -e
          if (( normal_status == 0 )); then
            result_primed=true
          fi
        fi

        result_check_runs=1
        check_output="$validation_root/check.stdout"
        check_error="$validation_root/check.stderr"
        set +e
        run_isolated "$check_output" "$check_error" "$nix" "''${common_build_args[@]}" --rebuild
        check_status="$last_command_status"
        set -e
        if (( check_status != 0 )); then
          emit_result error "command failure" "source replay Check failed"
          exit 0
        fi
        if (( presence_status != 0 && presence_status != 1 )); then
          emit_result error "command failure" "source replay output presence could not be checked"
          exit 0
        fi
        if (( normal_status != 0 )); then
          emit_result error "command failure" "source replay Normal priming failed"
          exit 0
        fi

        final_info_output="$validation_root/final-info.stdout"
        final_info_error="$validation_root/final-info.stderr"
        set +e
        run_isolated "$final_info_output" "$final_info_error" "$nix" path-info --json --store "$replay_store" "$expected_path"
        final_info_status="$last_command_status"
        set -e
        if (( final_info_status != 0 )); then
          emit_result error "command failure" "source replay output hash could not be checked"
          exit 0
        fi
        if ! remaining_microseconds >/dev/null 2>&1; then
          emit_result error "command failure" "source replay comparison exceeded its time limit"
          exit 0
        fi
        hash_convert_output="$validation_root/hash-convert.stdout"
        hash_convert_error="$validation_root/hash-convert.stderr"
        set +e
        run_isolated "$hash_convert_output" "$hash_convert_error" "$nix" hash convert --from sri --to nix32 "$source_hash"
        hash_convert_status="$last_command_status"
        set -e
        if (( hash_convert_status != 0 )); then
          emit_result error "command failure" "source replay expected hash could not be normalized"
          exit 0
        fi
        nix32_hash="$($jq -Rr -s 'sub("\\n$"; "")' "$hash_convert_output" 2>/dev/null)" || {
          emit_result error "command failure" "source replay expected hash could not be normalized"
          exit 0
        }
        if [[ ! "$nix32_hash" =~ ^[0-9a-z]{52}$ ]]; then
          emit_result error "command failure" "source replay expected hash could not be normalized"
          exit 0
        fi
        case "$source_hash_mode" in
          flat)
            expected_ca="fixed:sha256:$nix32_hash"
            ;;
          recursive)
            expected_ca="fixed:r:sha256:$nix32_hash"
            ;;
          *)
            emit_result error "schema drift" "source replay hash mode was invalid"
            exit 0
            ;;
        esac

        observed_info="$($jq -c --arg expected "$expected_path" "
          if type == \"object\" and has(\$expected) and (.[\$expected] | type == \"object\") then
            .[\$expected] as \$entry
            | {
                path: (\$entry.path // \$expected),
                narHash: (\$entry.narHash // null),
                ca: (\$entry.ca // null)
              }
          else
            { path: null, narHash: null, ca: null }
          end
        " "$final_info_output" 2>/dev/null)" || {
          emit_result error "command failure" "source replay output metadata was invalid"
          exit 0
        }
        observed_path="$($jq -r '.path // ""' <<<"$observed_info")"
        observed_nar_hash="$($jq -r '.narHash // ""' <<<"$observed_info")"
        observed_ca="$($jq -r '.ca // ""' <<<"$observed_info")"
        if [[ "$observed_path" != "$expected_path" ]]; then
          emit_result ineligible "output mismatch" "source replay output path did not match"
          exit 0
        fi
        if [[ ! "$observed_nar_hash" =~ ^sha256-[A-Za-z0-9+/]{43}=$ ]] \
          || [[ "$observed_ca" != "$expected_ca" ]]; then
          emit_result ineligible "hash mismatch" "source replay output hash did not match"
          exit 0
        fi
        if [[ "$source_hash_mode" == recursive && "$observed_nar_hash" != "$expected_hash" ]]; then
          emit_result ineligible "hash mismatch" "source replay output hash did not match"
          exit 0
        fi
        if ! remaining_microseconds >/dev/null 2>&1; then
          emit_result error "command failure" "source replay comparison exceeded its time limit"
          exit 0
        fi

        evidence="$($jq -cn \
           --arg output "$observed_path" \
           --arg hash "$source_hash" \
           "{ output: \$output, hash: \$hash, source: \"fresh-check\" }")" || {
          emit_result error "internal validation failure" "source replay evidence could not be recorded"
          exit 1
        }
        emit_result eligible "" "fresh source replay matched expected output" "$evidence"
  '';
}
