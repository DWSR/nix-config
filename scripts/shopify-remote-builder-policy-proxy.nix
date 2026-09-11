{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  util-linux,
  dante,
  proxyExecutable ? "${dante}/bin/sockd",
  routeExecutable ? "/sbin/route",
  maxRedirectsLimit ? 20,
  maxRequestBytes ? 65536,
  maxWorkspaceBytesLimit ? 20 * 1024 * 1024 * 1024,
  processStatusExecutable ? "/bin/ps",
  helperTimeoutSeconds ? 5,
  helperOutputBytesLimit ? 65536,
  timeoutSecondsLimit ? 1800,
  startupGraceMilliseconds ? 1000,
  policyPort ? 1080,
  proxyUser ? "_nixremote",
}:

assert lib.isInt policyPort;
assert policyPort > 1023;
assert policyPort <= 65535;
assert lib.isString proxyUser;
assert builtins.match "^[a-z_][a-z0-9_-]{0,31}$" proxyUser != null;
assert proxyUser != "root";
assert proxyUser != "nobody";
assert startupGraceMilliseconds > 0;
assert helperTimeoutSeconds > 0;
assert helperOutputBytesLimit > 0;
let
  coreutilsBin = "${coreutils}/bin";
  jqExecutable = "${jq}/bin/jq";
  safePath = lib.makeBinPath [
    coreutils
    jq
    util-linux
  ];
  startupGraceSeconds = startupGraceMilliseconds / 1000;

  # Snapshot of the IANA IPv4/IPv6 Special-Purpose Address Registries last
  # updated 2025-10-09. The multicast/reserved ranges are also denied
  # because they are not globally reachable destinations.
  ianaRegistryVersion = "2025-10-09";
  ipv4NonGlobalRanges = [
    "0.0.0.0/8"
    "10.0.0.0/8"
    "100.64.0.0/10"
    "127.0.0.0/8"
    "169.254.0.0/16"
    "172.16.0.0/12"
    "192.0.0.0/24"
    "192.0.2.0/24"
    "192.88.99.0/24"
    "192.168.0.0/16"
    "198.18.0.0/15"
    "198.51.100.0/24"
    "203.0.113.0/24"
    "224.0.0.0/4"
    "240.0.0.0/4"
    "255.255.255.255/32"
  ];
  ipv6NonGlobalRanges = [
    "::/128"
    "::1/128"
    "::ffff:0:0/96"
    "64:ff9b:1::/48"
    "100::/64"
    "100:0:0:1::/64"
    "2001::/23"
    "2001:2::/48"
    "2001:10::/28"
    "2001:db8::/32"
    "2002::/16"
    "3fff::/20"
    "5f00::/16"
    "fc00::/7"
    "fe80::/10"
    "ff00::/8"
  ];
  ipv4GlobalExceptionRanges = [
    "192.0.0.9/32"
    "192.0.0.10/32"
  ];
  ipv6GlobalExceptionRanges = [
    "64:ff9b::/96"
    "2001:1::1/128"
    "2001:1::2/128"
    "2001:1::3/128"
    "2001:3::/32"
    "2001:4:112::/48"
    "2001:20::/28"
    "2001:30::/28"
  ];
  # Dante rejects IPv4-mapped IPv6 CIDRs. Dante represents those requests as
  # IPv4, so the complete IPv4 policy covers this IANA range.
  danteIpv6NonGlobalRanges = lib.filter (range: range != "::ffff:0:0/96") ipv6NonGlobalRanges;
  ianaPolicyJson = builtins.toJSON {
    version = ianaRegistryVersion;
    ipv4NonGlobal = ipv4NonGlobalRanges;
    ipv6NonGlobal = ipv6NonGlobalRanges;
    ipv4GlobalExceptions = ipv4GlobalExceptionRanges;
    ipv6GlobalExceptions = ipv6GlobalExceptionRanges;
  };
  socksRule = action: sourceRange: destinationRange: ''
    socks ${action} {
      from: ${sourceRange}
      to: ${destinationRange} port = 443
      command: connect
      protocol: tcp
      proxyprotocol: socks_v5
      socksmethod: none
    }
  '';
  denyIpv4Rule = range: socksRule "block" "127.0.0.1/32" range;
  denyIpv6Rule = range: socksRule "block" "::1/128" range;
  proxyPassRule =
    family: range: socksRule "pass" (if family == "ipv4" then "127.0.0.1/32" else "::1/128") range;
  policyGlobalExceptionRules =
    lib.concatMapStringsSep "\n" (proxyPassRule "ipv4") ipv4GlobalExceptionRanges
    + "\n"
    + lib.concatMapStringsSep "\n" (proxyPassRule "ipv6") ipv6GlobalExceptionRanges;
  policyDenyRules =
    lib.concatMapStringsSep "\n" denyIpv4Rule ipv4NonGlobalRanges
    + "\n"
    + lib.concatMapStringsSep "\n" denyIpv6Rule danteIpv6NonGlobalRanges;
  policyGlobalPassRules =
    socksRule "pass" "127.0.0.1/32" "0.0.0.0/0" + "\n" + socksRule "pass" "::1/128" "::/0";
  policyDenyAllRules = ''
    socks block {
      from: 0.0.0.0/0
      to: 0.0.0.0/0
    }
    socks block {
      from: ::/0
      to: ::/0
    }
  '';
in
writeShellApplication {
  name = "shopify-remote-builder-policy-proxy";
  runtimeInputs = [
    coreutils
    jq
    util-linux
  ];
  text = ''
    unset ALL_PROXY all_proxy AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
    unset AWS_PROFILE AWS_DEFAULT_REGION AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
    unset GITHUB_TOKEN GH_TOKEN HOME HTTP_PROXY http_proxy HTTPS_PROXY https_proxy
    unset NO_PROXY no_proxy NETRC CURL_CA_BUNDLE SSL_CERT_FILE BASH_ENV ENV
    unset NIX_CACHE_DIR NIX_CONFIG
    unset NIX_CONFIG_HOME NIX_CONF_DIR NIX_LOG_DIR NIX_PATH NIX_REMOTE
    unset NIX_STATE_DIR NIX_SUBSTITUTERS NIX_USER_CONF_FILES POST_BUILD_HOOK
    unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_OPTIONS TMPDIR XDG_CACHE_HOME XDG_CONFIG_HOME
    unset XDG_DATA_HOME XDG_STATE_HOME
    export LC_ALL=C
    umask 077
    set -o pipefail

    jq=${lib.escapeShellArg jqExecutable}
    env_command=${lib.escapeShellArg "${coreutilsBin}/env"}
    kill_command=${lib.escapeShellArg "${coreutilsBin}/kill"}
    mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
    mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
    rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
    head=${lib.escapeShellArg "${coreutilsBin}/head"}
    setsid=${lib.escapeShellArg "${util-linux}/bin/setsid"}
    process_status=${lib.escapeShellArg processStatusExecutable}
    sleep_command=${lib.escapeShellArg "${coreutilsBin}/sleep"}
    timeout_command=${lib.escapeShellArg "${coreutilsBin}/timeout"}
    wc=${lib.escapeShellArg "${coreutilsBin}/wc"}
    proxy=${lib.escapeShellArg proxyExecutable}
    route=${lib.escapeShellArg routeExecutable}
    safe_path=${lib.escapeShellArg safePath}
    iana_policy_json=${lib.escapeShellArg ianaPolicyJson}
    policy_deny_rules=${lib.escapeShellArg policyDenyRules}
    policy_global_exception_rules=${lib.escapeShellArg policyGlobalExceptionRules}
    policy_global_pass_rules=${lib.escapeShellArg policyGlobalPassRules}
    policy_deny_all_rules=${lib.escapeShellArg policyDenyAllRules}
    max_redirects_limit=${toString maxRedirectsLimit}
    max_request_bytes=${toString maxRequestBytes}
    max_workspace_bytes_limit=${toString maxWorkspaceBytesLimit}
    helper_timeout_seconds=${toString helperTimeoutSeconds}
    helper_output_bytes_limit=${toString helperOutputBytesLimit}
    timeout_seconds_limit=${toString timeoutSecondsLimit}
    startup_grace_seconds=${toString startupGraceSeconds}
    policy_port=${toString policyPort}

    validation_root=""
    proxy_pid=""
    proxy_group_pid=""
    stdin_pid=""
    watchdog_pid=""
    watchdog_group_pid=""
    result_nonce=""

    run_clean() {
      "$env_command" -i "LC_ALL=C" "PATH=$safe_path" "$@"
    }

    run_bounded() {
      local duration="$1"
      shift
      run_clean "$timeout_command" --signal=TERM --kill-after=1s "''${duration}s" "$@"
    }

    run_bounded_output() {
      local output_file="$1"
      local duration="$2"
      shift 2
      run_bounded "$duration" "$@" \
        | run_clean "$head" -c "$((helper_output_bytes_limit + 1))" >"$output_file"
    }

    check_bounded_file() {
      local source_file="$1"
      local file_bytes
      file_bytes="$(run_bounded "$helper_timeout_seconds" "$wc" -c <"$source_file" 2>/dev/null)" || return 1
      file_bytes="''${file_bytes//[[:space:]]/}"
      [[ "$file_bytes" =~ ^[0-9]+$ ]] && (( file_bytes <= helper_output_bytes_limit ))
    }

    read_bounded_value() {
      local source_file="$1"
      local value=""
      IFS= read -r -n "$helper_output_bytes_limit" value <"$source_file" || [[ -n "$value" ]] || return 1
      printf '%s' "$value"
    }

    emit_result() {
      local decision="$1"
      local reason="$2"
      local detail="$3"
      # shellcheck disable=SC2016
      run_bounded "$helper_timeout_seconds" "$jq" -n -cS \
        --argjson schemaVersion 1 \
        --arg nonce "$result_nonce" \
        --arg decision "$decision" \
        --arg reason "$reason" \
        --arg detail "$detail" \
        '{
          schemaVersion: $schemaVersion,
          nonce: (if $nonce == "" then null else $nonce end),
          decision: $decision,
          reason: (if $reason == "" then null else $reason end),
          detail: $detail
        }'
    }

    cleanup_pid() {
      local process_id="$1"
      if [[ "$process_id" =~ ^[0-9]+$ ]]; then
        run_clean "$kill_command" -TERM "$process_id" 2>/dev/null || true
        run_clean "$sleep_command" 0.02 2>/dev/null || true
        run_clean "$kill_command" -KILL "$process_id" 2>/dev/null || true
        wait "$process_id" 2>/dev/null || true
      fi
    }

    # shellcheck disable=SC2329
    cleanup_process_group() {
      local group_pid="$1"
      local attempts=0
      if [[ "$group_pid" =~ ^[0-9]+$ ]]; then
        run_clean "$kill_command" -TERM -- "-$group_pid" 2>/dev/null || true
        run_clean "$sleep_command" 0.02 2>/dev/null || true
        run_clean "$kill_command" -KILL -- "-$group_pid" 2>/dev/null || true
        while (( attempts < 50 )); do
          if ! run_clean "$kill_command" -0 -- "-$group_pid" 2>/dev/null; then
            break
          fi
          run_clean "$sleep_command" 0.02 2>/dev/null || true
          attempts=$((attempts + 1))
        done
      fi
    }

    # shellcheck disable=SC2329
    cleanup() {
      local process_id
      cleanup_process_group "$proxy_group_pid"
      cleanup_process_group "$watchdog_group_pid"
      for process_id in "$watchdog_pid" "$stdin_pid" "$proxy_pid"; do
        cleanup_pid "$process_id"
      done
      watchdog_pid=""
      stdin_pid=""
      proxy_pid=""
      proxy_group_pid=""
      watchdog_group_pid=""
      if [[ -n "$validation_root" ]]; then
        run_clean "$rm" -rf -- "$validation_root" 2>/dev/null || true
        validation_root=""
      fi
    }

    # shellcheck disable=SC2329
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

    temp_suffix=X
    temp_template="/tmp/shopify-remote-builder-policy-proxy.''${temp_suffix}''${temp_suffix}''${temp_suffix}''${temp_suffix}''${temp_suffix}''${temp_suffix}"
    validation_root="$(run_clean "$mktemp" -d "$temp_template" 2>/dev/null)" || {
      emit_result error "internal validation failure" "proxy state could not be created"
      exit 1
    }
    if ! run_clean "$mkdir" -p -- "$validation_root/home" "$validation_root/tmp"; then
      emit_result error "internal validation failure" "proxy state could not be created"
      exit 1
    fi

    request_file="$validation_root/request.json"
    request_line=""
    request_read_limit=$((max_request_bytes + 1))
    request_read_status=0
    IFS= read -r -t 10 -n "$request_read_limit" request_line || request_read_status=$?
    if (( ''${#request_line} > max_request_bytes )); then
      emit_result ineligible "resource limit" "request exceeds a validation limit"
      exit 0
    fi
    if (( request_read_status != 0 )); then
      emit_result ineligible "schema drift" "request schema rejected"
      exit 0
    fi
    request_bytes="$(printf '%s' "$request_line" | run_bounded "$helper_timeout_seconds" "$wc" -c 2>/dev/null)" || {
      emit_result error "internal validation failure" "request size could not be checked"
      exit 1
    }
    request_bytes="''${request_bytes//[[:space:]]/}"
    if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
      emit_result ineligible "resource limit" "request exceeds a validation limit"
      exit 0
    fi
    printf '%s\n' "$request_line" >"$request_file"

    request_meta_file="$validation_root/request-meta.json"
    # shellcheck disable=SC2016
    if ! run_bounded_output "$request_meta_file" "$helper_timeout_seconds" "$jq" -c \
      --argjson maxRedirectsLimit "$max_redirects_limit" \
      --argjson maxWorkspaceBytesLimit "$max_workspace_bytes_limit" \
      --argjson timeoutSecondsLimit "$timeout_seconds_limit" \
      --argjson ianaPolicy "$iana_policy_json" \
      '
        def exact_object($required; $allowed):
          . as $object
          | if ($object | type) != "object" then
              false
            else
              (($object | keys - $allowed) | length) == 0
              and all($required[]; . as $key | ($object | has($key)))
            end;
        def finite_number:
          type == "number" and isfinite;
        def positive_integer($maximum):
          finite_number and floor == . and . > 0 and . <= $maximum;
        def unsigned_integer($maximum):
          finite_number and floor == . and . >= 0 and . <= $maximum;
        def valid_ipv4:
          type == "string"
          and test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$")
          and ((split(".") | map(tonumber)) | all(.[]; . >= 0 and . <= 255));
        def ipv4_canonical:
          split(".") | map(tonumber | tostring) | join(".");
        def hex_group:
          type == "string" and test("^[0-9A-Fa-f]{1,4}$");
        def valid_ipv6:
          type == "string"
          and (if contains("::") then
                 (split("::")) as $parts
                 | ($parts | length) == 2
                 and ((($parts[0] | if . == "" then [ ] else split(":") end)
                   + ($parts[1] | if . == "" then [ ] else split(":") end)) as $groups
                   | ($groups | length < 8 and all(.[]; hex_group)))
               else
                 (split(":") | length == 8 and all(.[]; hex_group))
               end);
        def ipv6_groups:
          if contains("::") then
            split("::") as $parts
            | ($parts[0] | if . == "" then [ ] else split(":") end) as $left
            | ($parts[1] | if . == "" then [ ] else split(":") end) as $right
            | ($left
              + ([range(0; 8 - ($left | length) - ($right | length))] | map("0000"))
              + $right)
          else
            split(":")
          end
          | map(ascii_downcase)
          | map(("0000" + .) | .[(length - 4):]);
        def hex_bits:
          {
            "0": "0000", "1": "0001", "2": "0010", "3": "0011",
            "4": "0100", "5": "0101", "6": "0110", "7": "0111",
            "8": "1000", "9": "1001", "a": "1010", "b": "1011",
            "c": "1100", "d": "1101", "e": "1110", "f": "1111"
          } as $bits
          | split("") | map($bits[.]) | join("");
        def byte_bits:
          . as $value
          | reduce [128, 64, 32, 16, 8, 4, 2, 1][] as $bit
              ({ remaining: $value, bits: [] };
               . as $state
               | (if $state.remaining >= $bit then 1 else 0 end) as $set
               | {
                   remaining: ($state.remaining - ($set * $bit)),
                   bits: ($state.bits + [($set | tostring)])
                 })
          | .bits | join("");
        def ipv4_bits:
          split(".") | map(tonumber | byte_bits) | join("");
        def ipv6_bits:
          ipv6_groups | map(hex_bits) | join("");
        def valid_ip:
          valid_ipv4 or valid_ipv6;
        def ip_info:
          if valid_ipv4 then
            { family: "ipv4", canonical: ipv4_canonical, bits: (ipv4_canonical | ipv4_bits) }
          elif valid_ipv6 then
            { family: "ipv6", canonical: (ipv6_groups | join(":")), bits: ipv6_bits }
          else
            null
          end;
        def in_cidr($address_bits; $cidr; $family):
          ($cidr | split("/")) as $parts
          | ($parts[0] | if $family == "ipv4" then ipv4_bits else ipv6_bits end) as $range_bits
          | ($parts[1] | tonumber) as $prefix
          | ($address_bits[0:$prefix] == $range_bits[0:$prefix]);
        def in_any($info; $ranges):
          any($ranges[]; in_cidr($info.bits; .; $info.family));
        def global_exception($info):
          if $info.family == "ipv4" then
            in_any($info; $ianaPolicy.ipv4GlobalExceptions)
          else
            in_any($info; $ianaPolicy.ipv6GlobalExceptions)
          end;
        def non_global:
          (ip_info) as $info
          | if $info == null then
              true
            elif global_exception($info) then
              false
            elif $info.family == "ipv4" then
              in_any($info; $ianaPolicy.ipv4NonGlobal)
            else
              in_any($info; $ianaPolicy.ipv6NonGlobal)
            end;
        def valid_hostname:
          type == "string"
          and utf8bytelength <= 253
          and test("^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$");
        def url_host:
          capture("^https://(?<host>\\[[0-9A-Fa-f:]+\\]|(?:[0-9]{1,3}\\.){3}[0-9]{1,3}|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::443)?(?:/[^?#]*)?$").host
          | if startswith("[") then .[1:-1] else . end;
        def valid_https_url:
          type == "string"
          and utf8bytelength <= 4096
          and (try (url_host | type == "string") catch false);
        def valid_nonce:
          if type != "string" then
            false
          else
            utf8bytelength >= 1
            and utf8bytelength <= 128
            and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")
          end;
        def valid_dns_record:
          exact_object(["hostname", "recordType", "answers"]; ["hostname", "recordType", "answers", "target"])
          and (.hostname | valid_hostname)
          and (.recordType == "A" or .recordType == "AAAA" or .recordType == "CNAME")
          and (.answers | type == "array" and length > 0 and all(.[]; valid_ip))
          and (if .recordType == "CNAME"
               then has("target") and (.target | valid_hostname) and .target != .hostname
               else (has("target") | not)
               end);
        def valid_destination:
          exact_object(["hostname", "addresses"]; ["hostname", "addresses"])
          and (.hostname | valid_hostname)
          and (.addresses | type == "array" and length > 0 and all(.[]; valid_ip));
        def valid_redirect:
          exact_object(["from", "to"]; ["from", "to"])
          and (.from | valid_https_url)
          and (.to | valid_https_url);
        def canonical_addresses:
          map(ip_info | .canonical) | sort;
        def records_for($network; $hostname):
          [$network.dnsRecords[] | select(.hostname == $hostname)];
        def resolved_dns_addresses($network; $hostname; $seen):
          if ($seen | index($hostname)) != null then
            null
          else
            (records_for($network; $hostname)) as $records
            | if ($records | length) == 0 then
                null
              elif all($records[]; .recordType == "CNAME") then
                if ($records | length) != 1 then
                  null
                else
                  $records[0] as $record
                  | resolved_dns_addresses($network; $record.target; ($seen + [$hostname]))
                end
              elif any($records[]; .recordType == "CNAME") then
                null
              elif all($records[]; .recordType == "A" or .recordType == "AAAA") then
                ($records | map(.answers) | add) as $answers
                | if ($answers | type == "array" and length > 0 and all(.[]; valid_ip)) then
                    ($answers | canonical_addresses)
                  else
                    null
                  end
              else
                null
              end
          end;
        def network_evidence_valid:
          . as $network
          | all($network.dnsRecords[];
              if .recordType == "CNAME" then
                . as $record
                | (resolved_dns_addresses($network; $record.target; [$record.hostname])) as $target
                | $target != null
                  and (($record.answers | canonical_addresses) == $target)
              else
                true
              end)
            and all($network.destinations[];
              . as $destination
              | (resolved_dns_addresses($network; $destination.hostname; [])) as $answers
              | $answers != null
                and (($destination.addresses | canonical_addresses) == $answers));
        def redirect_evidence($network; $url):
          ($url | url_host) as $host
          | ([ $network.destinations[] | select(.hostname == $host) ]) as $destinations
          | (resolved_dns_addresses($network; $host; [])) as $answers
          | if ($destinations | length) == 1 and $answers != null then
              {
                destination: $destinations[0].addresses,
                answers: $answers,
                destinationCanonical: ($destinations[0].addresses | map(ip_info | .canonical) | sort),
                answersCanonical: $answers
              }
            else
              null
            end;
        def redirects_have_public_evidence:
          . as $network
          | all($network.redirects[];
              . as $redirect
              | (redirect_evidence($network; $redirect.from)) as $from
              | (redirect_evidence($network; $redirect.to)) as $to
              | ($from != null and $to != null)
                and ($from.destinationCanonical == $from.answersCanonical)
                and ($to.destinationCanonical == $to.answersCanonical)
                and all($from.destination[]; (non_global | not))
                and all($to.destination[]; (non_global | not)));
        def valid_network:
          exact_object(["dnsRecords", "destinations", "redirects"]; ["dnsRecords", "destinations", "redirects"])
          and (.dnsRecords | type == "array" and length > 0 and all(.[]; valid_dns_record))
          and (.destinations | type == "array" and length > 0 and all(.[]; valid_destination))
          and (.redirects | type == "array" and all(.[]; valid_redirect));
        def request_network_reason:
          if (has("network") | not) then
            "schema drift"
          elif (.network | valid_network | not) then
            "schema drift"
          elif (.network | network_evidence_valid | not) then
            "private endpoint"
          elif any(.network.dnsRecords[]; any(.answers[]; non_global)) then
            "private endpoint"
          elif any(.network.destinations[]; any(.addresses[]; non_global)) then
            "private endpoint"
          elif (.network | redirects_have_public_evidence | not) then
            "private endpoint"
          elif ((.network.redirects | length) > .maxRedirects) then
            "resource limit"
          else
            "ok"
          end;
        if type != "object"
          or ((keys - ["schemaVersion", "nonce", "publicInterface", "declaredGateway", "maxRedirects", "timeoutSeconds", "maxWorkspaceBytes", "network"]) | length) != 0
          or .schemaVersion != 1
          or (.nonce | valid_nonce | not)
          or (.publicInterface | type != "string" or test("^[a-z][a-z0-9]*$") | not)
          or (.maxRedirects | unsigned_integer($maxRedirectsLimit) | not)
          or (.timeoutSeconds | positive_integer($timeoutSecondsLimit) | not)
          or ((has("maxWorkspaceBytes") and (.maxWorkspaceBytes | positive_integer($maxWorkspaceBytesLimit) | not)))
          or (.declaredGateway | valid_ip | not)
        then
          { valid: false, reason: "schema drift" }
        else
            (request_network_reason) as $networkReason
          | if $networkReason == "schema drift" then
              { valid: false, reason: "schema drift", nonce: .nonce }
            elif $networkReason == "resource limit" then
              { valid: false, reason: "resource limit", nonce: .nonce }
            elif $networkReason == "private endpoint" then
              { valid: false, reason: "private endpoint", nonce: .nonce }
            else
              { valid: true, reason: "ok", nonce: .nonce, publicInterface: .publicInterface,
                declaredGateway: .declaredGateway, maxRedirects: .maxRedirects,
                timeoutSeconds: .timeoutSeconds, maxWorkspaceBytes: (.maxWorkspaceBytes // $maxWorkspaceBytesLimit) }
            end
        end
      ' "$request_file" 2>/dev/null; then
      emit_result ineligible "schema drift" "request schema rejected"
      exit 0
    fi

    if ! check_bounded_file "$request_meta_file"; then
      emit_result ineligible "resource limit" "request metadata exceeds a validation limit"
      exit 0
    fi
    read_request_value() {
      local field="$1"
      local field_file="$validation_root/request-field"
      if ! run_bounded_output "$field_file" "$helper_timeout_seconds" "$jq" -r "$field" "$request_meta_file" 2>/dev/null; then
        return 1
      fi
      check_bounded_file "$field_file" || return 1
      read_bounded_value "$field_file"
    }
    request_valid="$(read_request_value '.valid')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    result_nonce="$(read_request_value '.nonce // ""')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    request_reason="$(read_request_value '.reason // "schema drift"')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    if [[ "$request_valid" != true ]]; then
      case "$request_reason" in
        "private endpoint")
          emit_result ineligible "private endpoint" "destination policy rejected"
          ;;
        "resource limit")
          emit_result ineligible "resource limit" "proxy request exceeds a validation limit"
          ;;
        *)
          emit_result ineligible "schema drift" "request schema rejected"
          ;;
      esac
      exit 0
    fi

    public_interface="$(read_request_value '.publicInterface')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    declared_gateway="$(read_request_value '.declaredGateway')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    max_redirects="$(read_request_value '.maxRedirects')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    timeout_seconds="$(read_request_value '.timeoutSeconds')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }
    max_workspace_bytes="$(read_request_value '.maxWorkspaceBytes')" || {
      emit_result error "internal validation failure" "request metadata could not be read"
      exit 1
    }

    route_output_file="$validation_root/route-output"
    if ! run_bounded_output "$route_output_file" "$helper_timeout_seconds" "$route" -n get default 2>/dev/null; then
      emit_result ineligible "unexpected route" "default route could not be inspected"
      exit 0
    fi
    if ! check_bounded_file "$route_output_file"; then
      emit_result ineligible "resource limit" "default route exceeds a validation limit"
      exit 0
    fi

    route_interface=""
    route_gateway=""
    route_vpn=false
    # shellcheck disable=SC2016
    if run_bounded "$helper_timeout_seconds" "$jq" -e '
      type == "object"
      and ((keys - ["interface", "gateway", "vpn"]) | length) == 0
      and (.interface | type == "string" and test("^[a-z][a-z0-9]*$"))
      and (.gateway | type == "string" and test("^[0-9A-Fa-f:.]+$"))
      and (.vpn | type == "boolean")
    ' "$route_output_file" >/dev/null 2>&1; then
      if ! run_bounded_output "$validation_root/route-interface" "$helper_timeout_seconds" "$jq" -r '.interface' "$route_output_file" 2>/dev/null \
        || ! run_bounded_output "$validation_root/route-gateway" "$helper_timeout_seconds" "$jq" -r '.gateway' "$route_output_file" 2>/dev/null \
        || ! run_bounded_output "$validation_root/route-vpn" "$helper_timeout_seconds" "$jq" -r '.vpn' "$route_output_file" 2>/dev/null; then
        emit_result ineligible "unexpected route" "default route could not be parsed"
        exit 0
      fi
      if ! check_bounded_file "$validation_root/route-interface" \
        || ! check_bounded_file "$validation_root/route-gateway" \
        || ! check_bounded_file "$validation_root/route-vpn"; then
        emit_result ineligible "resource limit" "default route metadata exceeds a validation limit"
        exit 0
      fi
      route_interface="$(read_bounded_value "$validation_root/route-interface")"
      route_gateway="$(read_bounded_value "$validation_root/route-gateway")"
      route_vpn="$(read_bounded_value "$validation_root/route-vpn")"
    else
      while IFS= read -r -n "$helper_output_bytes_limit" route_line; do
        case "$route_line" in
          *gateway:*) route_gateway="''${route_line##*gateway: }" ;;
          *interface:*) route_interface="''${route_line##*interface: }" ;;
        esac
      done <"$route_output_file"
      if [[ "$route_interface" =~ ^(utun|tun|tap|ppp|ipsec)[a-z0-9]*$ ]]; then
        route_vpn=true
      fi
      if [[ "$route_gateway" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
        route_vpn=true
      fi
    fi

    route_meta_file="$validation_root/route-meta.json"
    # shellcheck disable=SC2016
    if ! run_bounded "$helper_timeout_seconds" "$jq" -n -c \
      --arg interface "$route_interface" \
      --arg gateway "$route_gateway" \
      --argjson vpn "$route_vpn" \
      'def valid_ipv4:
         type == "string" and test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$")
         and ((split(".") | map(tonumber)) | all(.[]; . >= 0 and . <= 255));
       def hex_group:
         type == "string" and test("^[0-9A-Fa-f]{1,4}$");
       def valid_ipv6:
         type == "string"
         and (if . == "::" then
                true
              elif contains("::") then
                (split("::")) as $parts
                | if ($parts | length) != 2 then
                    false
                  else
                    (($parts[0] | if . == "" then [ ] else split(":") end)
                      + ($parts[1] | if . == "" then [ ] else split(":") end)) as $groups
                    | ($groups | length < 8 and all(.[]; hex_group))
                  end
              else
                (split(":") | length == 8 and all(.[]; hex_group))
              end);
       { interface: $interface, gateway: $gateway, vpn: $vpn }
       | select(.interface | test("^[a-z][a-z0-9]*$"))
       | select(.gateway | (valid_ipv4 or valid_ipv6))' >"$route_meta_file" 2>/dev/null; then
      emit_result ineligible "unexpected route" "default route is malformed"
      exit 0
    fi
    if ! check_bounded_file "$route_meta_file"; then
      emit_result ineligible "resource limit" "default route metadata exceeds a validation limit"
      exit 0
    fi
    observed_interface="$(run_bounded "$helper_timeout_seconds" "$jq" -r '.interface' "$route_meta_file")"
    observed_gateway="$(run_bounded "$helper_timeout_seconds" "$jq" -r '.gateway' "$route_meta_file")"
    observed_vpn="$(run_bounded "$helper_timeout_seconds" "$jq" -r '.vpn' "$route_meta_file")"
    if [[ "$observed_interface" != "$public_interface" || "$observed_vpn" != false ]]; then
      emit_result ineligible "unexpected route" "default route is not the declared non-VPN route"
      exit 0
    fi
    if [[ "$observed_gateway" != "$declared_gateway" ]]; then
      emit_result ineligible "unexpected route" "default route gateway changed"
      exit 0
    fi

    policy_config="$validation_root/sockd.conf"
    if ! {
      printf '%s\n' \
        'logoutput: stderr' \
        "# IANA special-purpose policy snapshot: ${ianaRegistryVersion}" \
        '# IPv4-mapped IPv6 is represented as IPv4 by Dante and covered by the IPv4 rules.' \
        "internal: 127.0.0.1 port = $policy_port" \
        "internal: ::1 port = $policy_port" \
        "internal: $public_interface port = $policy_port" \
        "external: $public_interface" \
        'clientmethod: none' \
        'socksmethod: none' \
        "user.privileged: ${proxyUser}" \
        "user.unprivileged: ${proxyUser}" \
        'client pass {' \
        '  from: 127.0.0.1/32' \
        '  to: 0.0.0.0/0' \
        '}' \
        'client pass {' \
        '  from: ::1/128' \
        '  to: ::/0' \
        '}' \
        'client block {' \
        '  from: 0.0.0.0/0' \
        '  to: 0.0.0.0/0' \
        '}' \
        'client block {' \
        '  from: ::/0' \
        '  to: ::/0' \
        '}'
      printf '%s\n' "$policy_global_exception_rules"
      printf '%s\n' "$policy_deny_rules"
      printf '%s\n' "$policy_global_pass_rules"
      printf '%s\n' "$policy_deny_all_rules"
    } >"$policy_config"; then
      emit_result error "internal validation failure" "proxy policy could not be written"
      exit 1
    fi
    policy_bytes="$(run_bounded "$helper_timeout_seconds" "$wc" -c <"$policy_config" 2>/dev/null)" || {
      emit_result error "internal validation failure" "proxy policy size could not be checked"
      exit 1
    }
    policy_bytes="''${policy_bytes//[[:space:]]/}"
    if [[ ! "$policy_bytes" =~ ^[0-9]+$ ]] || (( policy_bytes > max_workspace_bytes )); then
      emit_result ineligible "resource limit" "proxy policy exceeds a validation limit"
      exit 0
    fi

    set +e
    "$env_command" -i \
      "HOME=$validation_root/home" \
      "LANG=C" \
      "LC_ALL=C" \
      "PATH=$safe_path" \
      "TMPDIR=$validation_root/tmp" \
      "$setsid" "$proxy" -f "$policy_config" -N 1 >/dev/null 2>&1 &
    proxy_pid=$!
    proxy_group_pid="$proxy_pid"
    set -e
    process_is_running() {
      local process_id="$1"
      local status_file="$2"
      local process_state
      if [[ ! "$process_id" =~ ^[0-9]+$ ]] \
        || ! run_clean "$kill_command" -0 "$process_id" 2>/dev/null; then
        return 1
      fi
      if ! run_bounded_output "$status_file" "$helper_timeout_seconds" "$process_status" -p "$process_id" -o stat= 2>/dev/null; then
        return 1
      fi
      check_bounded_file "$status_file" || return 1
      process_state="$(read_bounded_value "$status_file")" || return 1
      [[ "$process_state" != *Z* ]]
    }
    proxy_is_running() {
      proxy_state_file="$validation_root/proxy-status"
      process_is_running "$proxy_pid" "$proxy_state_file"
    }
    run_bounded "$helper_timeout_seconds" "$sleep_command" "$startup_grace_seconds"
    if ! proxy_is_running; then
      cleanup_pid "$proxy_pid"
      proxy_pid=""
      emit_result ineligible "proxy startup failure" "policy proxy did not remain available"
      exit 0
    fi

    endpoint="socks5h://127.0.0.1:$policy_port"
    # shellcheck disable=SC2016
    run_bounded "$helper_timeout_seconds" "$jq" -n -cS \
      --argjson schemaVersion 1 \
      --arg nonce "$result_nonce" \
      --arg endpoint "$endpoint" \
      --arg bindInterface "$public_interface" \
      --argjson port "$policy_port" \
      --argjson maxRedirects "$max_redirects" \
      --arg allProxy "$endpoint" \
      '{
        schemaVersion: $schemaVersion,
        nonce: $nonce,
        decision: "ready",
        reason: null,
        endpoint: $endpoint,
        bindInterface: $bindInterface,
        port: $port,
        maxRedirects: $maxRedirects,
        proxyEnvironment: {
          ALL_PROXY: $allProxy,
          HTTPS_PROXY: $allProxy,
          HTTP_PROXY: $allProxy,
          NO_PROXY: "",
          all_proxy: $allProxy,
          https_proxy: $allProxy,
          http_proxy: $allProxy,
          no_proxy: ""
        }
      }'

    "$env_command" -i "LC_ALL=C" "PATH=$safe_path" \
      "$setsid" "$timeout_command" --signal=TERM --kill-after=1s "''${timeout_seconds}s" "$sleep_command" "''${timeout_seconds}s" &
    watchdog_pid=$!
    watchdog_group_pid="$watchdog_pid"
    stdin_open=true
    while [[ "$stdin_open" == true ]]; do
      read_status=0
      ignored_byte=""
      IFS= read -r -t 0.05 -n 1 ignored_byte || read_status=$?
      if (( read_status != 0 && read_status != 142 )); then
        stdin_open=false
        break
      fi
      : "$ignored_byte"
      if ! proxy_is_running; then
        emit_result error "proxy exited" "policy proxy exited during validation"
        exit 1
      fi
      if ! process_is_running "$watchdog_pid" "$validation_root/watchdog-status"; then
        emit_result ineligible "resource limit" "validation proxy timed out"
        exit 124
      fi
    done
    exit 0
  '';
}
