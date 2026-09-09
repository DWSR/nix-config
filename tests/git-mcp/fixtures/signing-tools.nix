{
  pkgs,
  signerPackage ? null,
  adminPackage ? null,
}:
let
  inherit (pkgs) lib;

  runtimeInputs = [
    pkgs.coreutils
    pkgs.jq
  ];

  common = ''
    fixture_setup() {
      fixture_root="''${GIT_MCP_SIGNING_FIXTURE_ROOT:?GIT_MCP_SIGNING_FIXTURE_ROOT is required}"
       fixture_scenario="$fixture_root/scenario.json"
       fixture_calls="$fixture_root/calls.jsonl"
       fixture_events="$fixture_root/events.jsonl"
       fixture_owned_processes="$fixture_root/owned-processes.jsonl"
       fixture_deleted_hashes="$fixture_root/deleted-ctk-hashes"
       fixture_allowed_signers=""

      if [[ ! -r "$fixture_scenario" ]]; then
        printf 'missing fixture scenario: %s\n' "$fixture_scenario" >&2
        return 64
      fi

      mkdir -p "$fixture_root"
    }

     fixture_record_ownership() {
       local role="$1"
       local pid="$2"
       local expected_executable="$3"
       local identity
       local observed_pid
       local process_group
       local start_seconds
       local start_microseconds
       local executable
       local identity_helper="''${GIT_MCP_PROCESS_IDENTITY_HELPER:-}"
       local session_token="''${GIT_MCP_OWNERSHIP_TOKEN:-}"

       if [[ -z "$identity_helper" || -z "$session_token" ]]; then
         return 0
       fi
       if ! identity="$("$identity_helper" "$pid")"; then
         printf 'failed to capture fixture process identity for %s pid %s\n' "$role" "$pid" >&2
         return 70
       fi
       IFS=$'\t' read -r observed_pid process_group start_seconds start_microseconds executable <<< "$identity"
       if [[ "$observed_pid" != "$pid" || "$executable" != "$expected_executable" ]]; then
         printf 'fixture process identity mismatch for %s pid %s\n' "$role" "$pid" >&2
         return 70
       fi
       jq -cn \
         --argjson pid "$observed_pid" \
         --argjson process_group "$process_group" \
         --argjson start_seconds "$start_seconds" \
         --argjson start_microseconds "$start_microseconds" \
         --arg executable "$executable" \
         --arg expected_executable "$expected_executable" \
         --arg role "$role" \
         --arg session_token "$session_token" \
         '{pid: $pid, processGroup: $process_group, startSeconds: $start_seconds, startMicroseconds: $start_microseconds, executable: $executable, expectedExecutable: $expected_executable, role: $role, sessionToken: $session_token}' \
         >> "$fixture_owned_processes"
     }

     fixture_log_call() {
       local argv_json
       local allowed_signers="''${fixture_allowed_signers:-}"
       local signing_stub="''${fixture_signing_stub:-}"
       local signing_public_key="''${fixture_signing_public_key:-}"
       local export_empty="null"
       local -a export_entries=()

       if [[ "$fixture_tool" == "ssh-keygen" && "$fixture_operation" == "resident-export" ]]; then
         shopt -s nullglob dotglob
         export_entries=("$PWD"/*)
         shopt -u nullglob dotglob
         if (( ''${#export_entries[@]} == 0 )); then
           export_empty="true"
         else
           export_empty="false"
         fi
       fi

       fixture_record_ownership "$fixture_tool:$fixture_operation" "''${BASHPID:-$$}" "$BASH"
       argv_json="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')"
       jq -cn \
         --arg tool "$fixture_tool" \
         --arg operation "$fixture_operation" \
         --argjson argv "$argv_json" \
         --arg pid "''${BASHPID:-$$}" \
         --arg provider "''${SSH_SK_PROVIDER:-}" \
          --arg selector "''${KEYCHAIN_CERTIFICATES:-}" \
          --arg cwd "$PWD" \
          --arg allowed_signers "$allowed_signers" \
          --arg signing_stub "$signing_stub" \
          --arg signing_public_key "$signing_public_key" \
          --argjson export_empty "$export_empty" \
          '{kind: "call", tool: $tool, operation: $operation, argv: $argv, pid: $pid, provider: $provider, selector: $selector, cwd: $cwd, allowedSigners: (if $allowed_signers == "" then null else $allowed_signers end), signingStub: (if $signing_stub == "" then null else $signing_stub end), signingPublicKey: (if $signing_public_key == "" then null else $signing_public_key end), exportEmpty: $export_empty}' \
          >> "$fixture_calls"
     }

    fixture_log_result() {
      local status="$1"
      jq -cn \
        --arg tool "$fixture_tool" \
        --arg operation "$fixture_operation" \
        --arg status "$status" \
        --arg pid "''${BASHPID:-$$}" \
        '{kind: "result", tool: $tool, operation: $operation, status: ($status | tonumber), pid: $pid}' \
        >> "$fixture_events"
    }

    fixture_failure_for() {
      local tool="$1"
      local operation="$2"
      jq -r --arg tool "$tool" --arg operation "$operation" \
        '.failures[$tool][$operation] // empty' "$fixture_scenario"
    }

    fixture_maybe_fail() {
      local message
      message=""
      if [[ "$fixture_tool" == "sc_auth" && "$fixture_operation" == "list" \
        && -r "$fixture_root/identity-snapshot" ]]; then
        message="$(jq -r '.failures.sc_auth.listAfterCreate // empty' "$fixture_scenario")"
      fi
      if [[ -z "$message" ]]; then
        message="$(fixture_failure_for "$fixture_tool" "$fixture_operation")"
      fi
      if [[ -n "$message" ]]; then
        printf '%s\n' "$message" >&2
        return 42
      fi
    }

    fixture_has_phase() {
      local phase="$1"
      shift
      local candidate

      for candidate in "$phase" "$@"; do
        if jq -e --arg candidate "$candidate" \
          '.hangs // [] | index($candidate) != null' "$fixture_scenario" >/dev/null; then
          return 0
        fi
      done

      return 1
    }

    fixture_deleted_hashes_json() {
      if [[ -r "$fixture_deleted_hashes" ]]; then
        jq -Rsc 'split("\n") | map(select(length > 0) | ascii_downcase) | unique' \
          "$fixture_deleted_hashes"
      else
        printf '[]\n'
      fi
    }

    fixture_deleted_ssh_fingerprints_json() {
      local snapshot="$1"
      local deleted_hashes="$2"
      local listing_field="$3"

      jq -ce \
        --arg snapshot "$snapshot" \
        --argjson deleted_hashes "$deleted_hashes" \
        --arg listing_field "$listing_field" '
        def table_rows:
          split("\n")
          | map(
              try capture(
                "^[[:space:]]*(?<keyType>[^[:space:]]+)[[:space:]]+(?<selector>[^[:space:]\\r]+)[[:space:]]+(?<protection>[^[:space:]]+)[[:space:]]+(?<label>[^[:space:]]+)"
              ) catch null
            )
          | map(select(. != null));
        (if (.rawIdentityListings[$snapshot] // null) != null
          then [
            .rawIdentityListings[$snapshot]
            | table_rows[]
            | select(.selector | test("^[0-9A-Fa-f]{40}$"))
            | {hash: (.selector | ascii_downcase), label}
          ]
          else [
            .identitySnapshots[$snapshot] // []
            | .[]
            | {hash: (.hash | ascii_downcase), label}
          ]
          end) as $hash_rows
        | [
            .[$listing_field][$snapshot]
            | table_rows[]
            | select(.selector | test("^SHA256:[A-Za-z0-9+/=]+$"))
            | {fingerprint: .selector, label}
          ] as $ssh_rows
        | [
            $deleted_hashes[] as $deleted_hash
            | [$hash_rows[] | select(.hash == $deleted_hash)] as $target_hash_rows
            | if ($target_hash_rows | length) != 1
              then error("deleted CTK hash must have exactly one SHA1 row")
              else $target_hash_rows[0].label
              end as $target_label
            | if ([$hash_rows[] | select(.label == $target_label)] | length) != 1
              then error("deleted CTK hash label is ambiguous in the SHA1 listing")
              else .
              end
            | [$ssh_rows[] | select(.label == $target_label)] as $target_ssh_rows
            | if ($target_ssh_rows | length) != 1
              then error("deleted CTK hash label must have exactly one SSH row")
              else $target_ssh_rows[0].fingerprint
              end as $target_fingerprint
            | if ([$ssh_rows[] | select(.fingerprint == $target_fingerprint)] | length) != 1
              then error("deleted CTK hash fingerprint is ambiguous in the SSH listing")
              else $target_fingerprint
              end
          ]
      ' "$fixture_scenario"
    }

    fixture_filter_raw_listing() {
      local listing_field="$1"
      local snapshot="$2"
      local selectors="$3"
      local selector_kind="$4"

      jq -j \
        --arg listing_field "$listing_field" \
        --arg snapshot "$snapshot" \
        --argjson selectors "$selectors" \
        --arg selector_kind "$selector_kind" '
        def row_selector:
          (try capture("^[[:space:]]*[^[:space:]]+[[:space:]]+(?<selector>[^[:space:]\\r]+)").selector catch null)
          | if . == null then null
            elif $selector_kind == "hash" then ascii_downcase
            else .
            end;
        .[$listing_field][$snapshot]
        | endswith("\n") as $has_trailing_newline
        | split("\n") as $lines
        | [
            $lines[]
            | row_selector as $selector
            | select($selector != null and (($selectors | index($selector)) != null))
            | $selector
          ] as $matches
        | if ($matches | length) != ($selectors | length)
          then error("raw identity listing does not contain exactly one row per deleted selector")
          else
            $lines
            | map(
                . as $line
                | ($line | row_selector) as $selector
                | select($selector == null or (($selectors | index($selector)) == null))
              )
            | join("\n") + (if $has_trailing_newline then "\n" else "" end)
          end
      ' "$fixture_scenario"
    }

     fixture_hang() {
       local phase="$1"
       shift

      if ! fixture_has_phase "$phase" "$@"; then
        return 0
      fi

      (
        trap ':' TERM INT HUP
        printf '%s\n' "''${BASHPID:-$$}" >> "$fixture_root/descendants"
        while :; do
          sleep 1
        done
       ) &
       child_pid="$!"
       printf '%s %s\n' "$$" "$child_pid" >> "$fixture_root/process-tree"
       fixture_record_ownership "$fixture_tool:$fixture_operation:descendant" "$child_pid" "$BASH"
       trap ':' TERM INT HUP
      while :; do
        sleep 1
       done
     }

     fixture_check_selector() {
       local expected_selector
       expected_selector="$(jq -r '.expectedSelector // empty' "$fixture_scenario")"
       if [[ -n "$expected_selector" && "''${KEYCHAIN_CERTIFICATES:-}" != "$expected_selector" ]]; then
         printf 'fixture selector mismatch: expected %s, observed %s\n' \
           "$expected_selector" "''${KEYCHAIN_CERTIFICATES:-<unset>}" >&2
         return 43
       fi
     }

    fixture_identity_snapshot() {
      local snapshot="before"
      local deleted_hashes="[]"
      if [[ -r "$fixture_root/identity-snapshot" ]]; then
        snapshot="$(<"$fixture_root/identity-snapshot")"
      fi
      deleted_hashes="$(fixture_deleted_hashes_json)"

      if jq -e --arg snapshot "$snapshot" \
        '.rawIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        if [[ "$deleted_hashes" == "[]" ]]; then
          jq -j --arg snapshot "$snapshot" \
            '.rawIdentityListings[$snapshot]' "$fixture_scenario"
        else
          fixture_filter_raw_listing rawIdentityListings "$snapshot" "$deleted_hashes" hash
        fi
        return
      fi

      printf '%s\n' 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid'
      jq -r --arg snapshot "$snapshot" --argjson deleted_hashes "$deleted_hashes" \
        '.identitySnapshots[$snapshot] // [] | .[] | . as $identity |
          select(($deleted_hashes | index(($identity.hash | ascii_downcase))) == null) |
          ([
            (.keyType // "p-256-ne"),
            (.hash | ascii_upcase),
            (.protection // "none"),
            (.label // "ssh"),
            (.commonName // "ssh"),
            (.emailAddress // ""),
            (.validToDate // "23.11.26,"),
            (.validToTime // "17:09"),
            (.valid // "YES")
          ] + (.extraFields // [])) | @tsv' \
        "$fixture_scenario" | tr '\t' ' '
    }

    fixture_ssh_identity_snapshot() {
      local snapshot="before"
      local deleted_hashes="[]"
      local deleted_fingerprints="[]"
      if [[ -r "$fixture_root/identity-snapshot" ]]; then
        snapshot="$(<"$fixture_root/identity-snapshot")"
      fi
      deleted_hashes="$(fixture_deleted_hashes_json)"

      if jq -e --arg snapshot "$snapshot" \
        '.sshIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        if [[ "$deleted_hashes" == "[]" ]]; then
          jq -j --arg snapshot "$snapshot" \
            '.sshIdentityListings[$snapshot]' "$fixture_scenario"
        else
          deleted_fingerprints="$(
            fixture_deleted_ssh_fingerprints_json \
              "$snapshot" "$deleted_hashes" sshIdentityListings
          )"
          fixture_filter_raw_listing \
            sshIdentityListings "$snapshot" "$deleted_fingerprints" fingerprint
        fi
        return
      fi

      if jq -e --arg snapshot "$snapshot" \
        '.rawSshIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        if [[ "$deleted_hashes" == "[]" ]]; then
          jq -j --arg snapshot "$snapshot" \
            '.rawSshIdentityListings[$snapshot]' "$fixture_scenario"
        else
          deleted_fingerprints="$(
            fixture_deleted_ssh_fingerprints_json \
              "$snapshot" "$deleted_hashes" rawSshIdentityListings
          )"
          fixture_filter_raw_listing \
            rawSshIdentityListings "$snapshot" "$deleted_fingerprints" fingerprint
        fi
        return
      fi

      printf '%s\n' 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid'
      jq -r --arg snapshot "$snapshot" --argjson deleted_hashes "$deleted_hashes" \
        '.identitySnapshots[$snapshot] // [] | .[] | . as $identity |
          select(($deleted_hashes | index(($identity.hash | ascii_downcase))) == null) |
          ([
            (.keyType // "p-256-ne"),
            (.sshFingerprint // ""),
            (.protection // "none"),
            (.label // "ssh"),
            (.commonName // "ssh"),
            (.emailAddress // ""),
            (.validToDate // "23.11.26,"),
            (.validToTime // "17:09"),
            (.valid // "YES")
          ]) | @tsv' \
        "$fixture_scenario" | tr '\t' ' '
    }

    fixture_export_dir() {
      local argument
      local next_is_dir=0
      local output_dir="$fixture_root/export"

      for argument in "$@"; do
        if [[ "$next_is_dir" == 1 ]]; then
          output_dir="$argument"
          next_is_dir=0
          continue
        fi

        case "$argument" in
          --output-dir|-d)
            next_is_dir=1
            ;;
        esac
      done

      printf '%s\n' "$output_dir"
    }

    fixture_export() {
      local output_dir="$1"
      local count
      local index
      local stub_name
      local public_name
      local stub
      local public_key

      mkdir -p "$output_dir"
      count="$(jq '.residentExports // [] | length' "$fixture_scenario")"
      for ((index = 0; index < count; index += 1)); do
        stub_name="$(jq -r --argjson index "$index" \
          '.residentExports[$index].stubName // ("id_ecdsa_sk_rk-" + ($index | tostring))' \
          "$fixture_scenario")"
        public_name="$stub_name.pub"
        stub="$(jq -r --argjson index "$index" '.residentExports[$index].stub' "$fixture_scenario")"
        public_key="$(jq -r --argjson index "$index" '.residentExports[$index].publicKey' "$fixture_scenario")"

        printf '%s\n' "$stub" > "$output_dir/$stub_name"
        printf '%s\n' "$public_key" > "$output_dir/$public_name"
        chmod 600 "$output_dir/$stub_name"
        chmod 644 "$output_dir/$public_name"
      done
    }
  '';

  fakeAgentSocketTrap = pkgs.writeShellApplication {
    name = "fixture-agent-socket-trap";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
            socket_path="''${1:?socket path is required}"
            record_path="''${2:?agent record path is required}"
            ready_path="''${3:?ready path is required}"

            exec python3 - "$socket_path" "$record_path" "$ready_path" <<'PY'
      import json
      import os
      import socket
      import sys
      from pathlib import Path

      socket_path, record_path, ready_path = sys.argv[1:]
      Path(socket_path).unlink(missing_ok=True)
      Path(record_path).parent.mkdir(parents=True, exist_ok=True)
      Path(ready_path).parent.mkdir(parents=True, exist_ok=True)

      server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
      server.bind(socket_path)
      os.chmod(socket_path, 0o600)
      server.listen(8)
      Path(ready_path).touch()

      while True:
          connection, _ = server.accept()
          with connection:
              connection.settimeout(0.1)
              try:
                  payload = connection.recv(65536)
              except TimeoutError:
                  payload = b""
          with Path(record_path).open("a", encoding="utf-8") as record:
              json.dump({
                  "kind": "agent-attempt",
                  "pid": os.getpid(),
                  "bytesReceived": len(payload),
              }, record)
              record.write("\n")
      PY
    '';
  };

  fakeFallback = pkgs.writeShellApplication {
    name = "fixture-fallback-signer";
    inherit runtimeInputs;
    text = ''
      fixture_root="''${GIT_MCP_SIGNING_FIXTURE_ROOT:?GIT_MCP_SIGNING_FIXTURE_ROOT is required}"
      mkdir -p "$fixture_root"
      argv_json="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')"
      jq -cn \
        --argjson argv "$argv_json" \
        --arg command "$(basename "$0")" \
        --arg pid "''${BASHPID:-$$}" \
        '{kind: "fallback-attempt", command: $command, argv: $argv, pid: $pid}' \
        >> "$fixture_root/fallback-calls.jsonl"
      printf 'fixture fallback signer invoked\n' >&2
      exit 97
    '';
  };

  fakeScAuth = pkgs.writeShellApplication {
    name = "fixture-sc-auth";
    inherit runtimeInputs;
    text = ''
      fixture_tool="sc_auth"
      fixture_operation="unknown"
      ${common}

      fixture_setup
      for argument in "$@"; do
        case "$argument" in
          list-ctk-identities|list)
            fixture_operation="list"
            ;;
          export|export-*)
            fixture_operation="export"
            ;;
          create|create-*)
            fixture_operation="create"
            ;;
          delete|delete-*)
            fixture_operation="delete"
            ;;
        esac
      done
      if [[ " $* " == *" -t ssh "* ]]; then
        fixture_operation="list-ssh"
      fi
      fixture_log_call "$@"
      trap 'status=$?; set +e; fixture_log_result "$status"; exit "$status"' EXIT
      fixture_hang "ctk-''${fixture_operation}" "preflight-ctk-''${fixture_operation}"
      fixture_maybe_fail

      case "$fixture_operation" in
        list)
          fixture_identity_snapshot
          ;;
        list-ssh)
          fixture_ssh_identity_snapshot
          ;;
        export)
          fixture_export "$(fixture_export_dir "$@")"
          ;;
        create)
          printf 'after\n' > "$fixture_root/identity-snapshot"
          ;;
        delete)
          if (( $# != 3 )) || [[ "$1" != "delete-ctk-identity" || "$2" != "-h" \
            || ! "$3" =~ ^[0-9a-f]{40}$ ]]; then
            printf 'fixture-sc-auth: deletion requires delete-ctk-identity -h <hash>\n' >&2
            exit 64
          fi
          printf '%s\n' "$3" >> "$fixture_deleted_hashes"
          printf 'delete-complete\n'
          ;;
        *)
          printf 'fixture-sc-auth: unsupported operation\n' >&2
          exit 64
          ;;
      esac

    '';
  };

  fakeProvider = pkgs.writeShellApplication {
    name = "fixture-provider";
    inherit runtimeInputs;
    text = ''
      fixture_tool="provider"
      fixture_operation="''${1:-load}"
      ${common}

      fixture_setup
      fixture_log_call "$@"
      trap 'status=$?; set +e; fixture_log_result "$status"; exit "$status"' EXIT
      if ! fixture_check_selector; then
        exit 43
      fi
      case "$fixture_operation" in
        sign)
          fixture_hang "provider-sign" "preflight-provider" "preflight-provider-sign"
          ;;
        load|probe|*)
          fixture_hang "provider-load" "preflight-provider" "preflight-provider-load"
          ;;
      esac
      fixture_maybe_fail
      printf 'fixture-provider-%s\n' "$fixture_operation"
    '';
  };

  providerPath = "${fakeProvider}/bin/fixture-provider";

  fakeSshKeygen = pkgs.writeShellApplication {
    name = "fixture-ssh-keygen";
    inherit runtimeInputs;
    text = ''
      fixture_tool="ssh-keygen"
      fixture_operation="passthrough"
      ${common}

      fixture_setup
      for argument in "$@"; do
       case "$argument" in
         -Y)
           ;;
          -K)
            fixture_operation="resident-export"
            ;;
          sign)
            fixture_operation="sign"
            ;;
          -y)
            fixture_operation="stub"
            ;;
          -lf|-L)
            fixture_operation="fingerprint"
            ;;
           -Y\ verify|verify)
             fixture_operation="verify"
             ;;
           find-principals)
             fixture_operation="find-principals"
             ;;
         esac
       done
      fixture_allowed_signers=""
        if [[ "$fixture_operation" == "verify" || "$fixture_operation" == "find-principals" ]]; then
        fixture_allowed_signers_path=""
        next_value=""
        for argument in "$@"; do
          if [[ -n "$next_value" ]]; then
            if [[ "$next_value" == "-f" ]]; then
              fixture_allowed_signers_path="$argument"
            fi
            next_value=""
            continue
          fi
          case "$argument" in
            -f)
              next_value="-f"
              ;;
          esac
        done
        if [[ -n "$fixture_allowed_signers_path" && -r "$fixture_allowed_signers_path" ]]; then
          fixture_allowed_signers="$(<"$fixture_allowed_signers_path")"
         fi
       fi
      fixture_signing_stub=""
      fixture_signing_public_key=""
      fixture_emit_native_stderr() {
        jq -j '.nativeOutput.stderr // empty' "$fixture_scenario" >&2
      }

      fixture_prepare_signing_request() {
        local signing_stub_path=""
        local next_value=""
        local argument
        local stub_content
        local public_key
        local declared_public_key

        for argument in "$@"; do
          if [[ -n "$next_value" ]]; then
            signing_stub_path="$argument"
            next_value=""
            continue
          fi
          case "$argument" in
            -f)
              next_value="-f"
              ;;
            -f*)
              signing_stub_path="''${argument#-f}"
              ;;
          esac
        done
        if [[ -z "$signing_stub_path" || ! -f "$signing_stub_path" \
          || ! -r "$signing_stub_path" || ! -s "$signing_stub_path" ]]; then
          printf 'fixture missing resident stub: %s\n' "$signing_stub_path" >&2
          return 45
        fi
        if [[ ! -f "$signing_stub_path.pub" || ! -r "$signing_stub_path.pub" \
          || ! -s "$signing_stub_path.pub" ]]; then
          printf 'fixture missing resident public key: %s.pub\n' "$signing_stub_path" >&2
          return 45
        fi
        stub_content="$(<"$signing_stub_path")"
        public_key="$(<"$signing_stub_path.pub")"
        declared_public_key="$(jq -r --arg stub "$stub_content" \
          '[.residentExports[]? | select(.stub == $stub) | .publicKey] |
            if length == 1 then .[0] else empty end' "$fixture_scenario")"
        if [[ -z "$declared_public_key" || "$public_key" != "$declared_public_key" ]]; then
          printf 'fixture resident stub/public key does not match one declared resident export: %s\n' "$signing_stub_path" >&2
          return 45
        fi
        fixture_signing_stub="$signing_stub_path"
        fixture_signing_public_key="$public_key"
      }
      if [[ "$fixture_operation" == "sign" ]]; then
        if ! fixture_prepare_signing_request "$@"; then
          exit 45
        fi
      fi
      fixture_log_call "$@"
      trap 'status=$?; set +e; fixture_log_result "$status"; exit "$status"' EXIT
      case "$fixture_operation" in
        resident-export)
          if [[ "''${SSH_SK_PROVIDER:-}" != ${builtins.toJSON providerPath} ]]; then
            printf 'fixture refused non-fixture provider: %s\n' "''${SSH_SK_PROVIDER:-<unset>}" >&2
            exit 43
          fi
          fixture_hang "preflight-ssh-keygen-resident-export" "ssh-keygen-resident-export"
          fixture_maybe_fail
          "''${SSH_SK_PROVIDER}" load >/dev/null
          fixture_export "$PWD"
          ;;
        stub)
          fixture_hang "preflight-ssh-keygen-stub" "ssh-keygen-stub" "preflight-stub"
          stub_path=""
          next_is_stub_path=0
          for argument in "$@"; do
            if [[ "$next_is_stub_path" == 1 ]]; then
              stub_path="$argument"
              next_is_stub_path=0
              continue
            fi
            case "$argument" in
              -f)
                next_is_stub_path=1
                ;;
              -f*)
                stub_path="''${argument#-f}"
                ;;
            esac
          done
          if [[ -z "$stub_path" || ! -r "$stub_path" ]]; then
            printf 'fixture missing resident stub: %s\n' "$stub_path" >&2
            exit 45
          fi
          stub_content="$(<"$stub_path")"
          stub_header='-----BEGIN OPENSSH PRIVATE KEY-----'
          stub_footer='-----END OPENSSH PRIVATE KEY-----'
          if [[ "$stub_content" != "$stub_header"$'\n'*$'\n'"$stub_footer" ]]; then
            printf 'fixture rejected malformed resident stub: %s\n' "$stub_path" >&2
            exit 45
          fi
          stub_body="''${stub_content#"$stub_header"$'\n'}"
          stub_body="''${stub_body%$'\n'"$stub_footer"}"
          if ! printf '%s\n' "$stub_body" | base64 --decode >/dev/null 2>&1; then
            printf 'fixture rejected invalid resident stub encoding: %s\n' "$stub_path" >&2
            exit 45
          fi
          if [[ ! -r "$stub_path.pub" ]]; then
            printf 'fixture missing resident public key: %s.pub\n' "$stub_path" >&2
            exit 45
          fi
          if [[ "''${SSH_SK_PROVIDER:-}" != ${builtins.toJSON providerPath} ]]; then
            printf 'fixture refused non-fixture provider: %s\n' "''${SSH_SK_PROVIDER:-<unset>}" >&2
            exit 43
          fi
          "''${SSH_SK_PROVIDER}" load >/dev/null
          stub_public_key="$(jq -r '.stubPublicKey // empty' "$fixture_scenario")"
          if [[ -z "$stub_public_key" ]]; then
            stub_public_key="$(<"$stub_path.pub")"
          fi
          printf '%s\n' "$stub_public_key"
          ;;
        sign)
          fixture_hang "preflight-ssh-keygen" "ssh-keygen-sign"
          if [[ "''${SSH_SK_PROVIDER:-}" != ${builtins.toJSON providerPath} ]]; then
            printf 'fixture refused non-fixture provider: %s\n' "''${SSH_SK_PROVIDER:-<unset>}" >&2
            exit 43
          fi
          "''${SSH_SK_PROVIDER}" sign "$@"
          signature_content="fixture-ssh-signature:$fixture_signing_public_key"
          signing_input_path=""
          for argument in "$@"; do
            if [[ "$argument" != "$fixture_signing_stub" && -f "$argument" && "$argument" != -* ]]; then
              signing_input_path="$argument"
            fi
          done
          if [[ -n "$signing_input_path" ]]; then
            printf '%s\n' "$signature_content" > "$signing_input_path.sig"
          fi
          printf '%s\n' "$signature_content"
          ;;
        fingerprint)
          fixture_hang "preflight-ssh-keygen" "ssh-keygen-fingerprint" "preflight-fingerprint"
          fixture_maybe_fail
          public_key_path=""
          for argument in "$@"; do
            case "$argument" in
              -*)
                ;;
              *)
                public_key_path="$argument"
                ;;
            esac
          done
          if [[ -z "$public_key_path" || ! -r "$public_key_path" ]]; then
            printf 'fixture missing public-key artifact: %s\n' "$public_key_path" >&2
            exit 44
          fi
          public_key="$(<"$public_key_path")"
          fingerprint="$(jq -r --arg public_key "$public_key" \
            'if .fingerprintOutput then .fingerprintOutput
             else [.residentExports[]? | select(.publicKey == $public_key) | .fingerprint] |
               if length == 1 then .[0] else empty end
             end' "$fixture_scenario")"
          if [[ -z "$fingerprint" ]]; then
            printf 'fixture has no unique fingerprint for public-key artifact: %s\n' "$public_key_path" >&2
            exit 44
          fi
          printf '256 %s fixture-key\n' "$fingerprint"
          ;;
        verify)
          fixture_emit_native_stderr
          fixture_maybe_fail
           signature_path=""
           allowed_signers_path=""
           signer_identity=""
           namespace=""
           allowed_identity=""
           allowed_options=""
           allowed_key_type=""
           allowed_key_data=""
           allowed_public_key=""
           signature_content=""
           has_signature=0
           next_value=""
          for argument in "$@"; do
            if [[ -n "$next_value" ]]; then
              case "$next_value" in
                -f)
                  allowed_signers_path="$argument"
                  ;;
                -I)
                  signer_identity="$argument"
                  ;;
                -n)
                  namespace="$argument"
                  ;;
                -s)
                  signature_path="$argument"
                  has_signature=1
                  ;;
              esac
              next_value=""
              continue
            fi
            case "$argument" in
              -f|-I|-n|-s)
                next_value="$argument"
                ;;
            esac
          done
          if (( has_signature != 0 )) && [[ -z "$allowed_signers_path" || ! -r "$allowed_signers_path" \
            || -z "$signature_path" || ! -r "$signature_path" \
            || -z "$signer_identity" || "$namespace" != "git" ]]; then
            printf 'fixture rejected incomplete local verification request\n' >&2
            exit 44
          fi
           if (( has_signature != 0 )) && [[ ! "$(<"$allowed_signers_path")" == *"$signer_identity"* \
             || ! -s "$signature_path" ]]; then
             printf 'fixture rejected local verification artifacts\n' >&2
             exit 44
           fi
           if (( has_signature != 0 )); then
             read -r allowed_identity allowed_options allowed_key_type allowed_key_data _ <<< "$fixture_allowed_signers"
             allowed_public_key="$allowed_key_type $allowed_key_data"
             signature_content="$(<"$signature_path")"
             if [[ "$allowed_identity" != "$signer_identity" \
               || "$allowed_options" != 'namespaces="git"' \
               || "$allowed_key_type" != "sk-ecdsa-sha2-nistp256@openssh.com" \
               || -z "$allowed_key_data" \
               || "$signature_content" != *"fixture-ssh-signature:$allowed_public_key"* ]]; then
               printf 'fixture rejected key-bound local verification artifacts\n' >&2
               exit 44
             fi
            fi
             if [[ "$*" == *-Overify-time=* ]]; then
               verification_fingerprint="$(jq -r --arg public_key "$allowed_public_key" \
                 '[.residentExports[]? | select(.publicKey == $public_key) | .fingerprint] |
                   if length == 1 then .[0] else "SHA256:fixture" end' "$fixture_scenario")"
               printf 'Good "git" signature for %s with ED25519 key %s\n' \
                 "$signer_identity" "$verification_fingerprint"
             else
               printf 'fixture-ssh-keygen-verified\n'
             fi
           ;;
         find-principals)
           signer_identity=""
           read -r signer_identity _ <<< "$fixture_allowed_signers"
           if [[ -z "$signer_identity" ]]; then
             printf 'fixture missing allowed-signers identity\n' >&2
             exit 44
           fi
           printf '%s\n' "$signer_identity"
           ;;
          passthrough)
           fixture_emit_native_stderr
           fixture_maybe_fail
           printf 'fixture-ssh-keygen-passthrough\n'
          ;;
      esac

    '';
  };

  primaryIdentity = {
    hash = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    label = "fixture-primary";
    publicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixtureprimary";
    fingerprint = "SHA256:fixtureprimary";
    sshFingerprint = "SHA256:fixtureprimary";
  };

  alternateIdentity = {
    hash = "2222222222222222222222222222222222222222";
    label = "fixture-alternate";
    publicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixturealternate";
    fingerprint = "SHA256:fixturealternate";
    sshFingerprint = "SHA256:fixturealternate";
  };

  rotationIdentity = {
    hash = "3333333333333333333333333333333333333333";
    label = "fixture-rotation";
    publicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixturerotation";
    fingerprint = "SHA256:fixturerotation";
    sshFingerprint = "SHA256:fixturerotation";
  };

  staleSameLabelIdentity = alternateIdentity // {
    hash = "1111111111111111111111111111111111111111";
    inherit (primaryIdentity) label;
    publicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixturestale";
    fingerprint = "SHA256:fixturestale";
    sshFingerprint = "SHA256:fixturestale";
  };

  biometricIdentity = alternateIdentity // {
    protection = "bio";
  };

  biometricConfiguredIdentity = primaryIdentity // {
    protection = "bio";
  };

  malformedIdentity = primaryIdentity // {
    extraFields = [ "unexpected" ];
  };

  invalidStatusIdentity = primaryIdentity // {
    valid = "NO";
  };

  primaryExport = {
    inherit (primaryIdentity) publicKey;
    fingerprint = primaryIdentity.sshFingerprint;
    stubName = "id_ecdsa_sk_rk";
    stub = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yZXNpZGVudC1oYW5kbGUtcHJpbWFyeQ==\n-----END OPENSSH PRIVATE KEY-----";
  };

  alternateExport = {
    inherit (alternateIdentity) publicKey;
    fingerprint = alternateIdentity.sshFingerprint;
    stubName = "id_ecdsa_sk_rk-alternate";
    stub = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yZXNpZGVudC1oYW5kbGUtYWx0ZXJuYXRl\n-----END OPENSSH PRIVATE KEY-----";
  };

  rotationExport = {
    inherit (rotationIdentity) publicKey;
    fingerprint = rotationIdentity.sshFingerprint;
    stubName = "id_ecdsa_sk_rk-rotation";
    stub = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yZXNpZGVudC1oYW5kbGUtb3RhdGlvbg==\n-----END OPENSSH PRIVATE KEY-----";
  };

  baseScenario = {
    identitySnapshots = {
      before = [ ];
      after = [ primaryIdentity ];
    };
    rawIdentityListings = { };
    rawSshIdentityListings = { };
    sshIdentityListings = { };
    residentExports = [ primaryExport ];
    hangs = [ ];
    failures = { };
    nativeOutput = {
      stderr = "fixture-native-stderr\n";
    };
    workerTree = {
      enabled = false;
      descendantsFile = "descendants";
      processTreeFile = "process-tree";
    };
  };

  rawIdentityTable = lines: lib.concatStringsSep "\r\n" lines + "\r\n";

  sshIdentityTable =
    identity: fingerprint:
    rawIdentityTable [
      "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
      "p-256-ne ${fingerprint} none ${identity.label} ssh 23.11.26, 17:09 YES"
    ];

  sshIdentityTableRows =
    rows:
    rawIdentityTable (
      [
        "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
      ]
      ++ rows
    );

  rawTableVariants = baseScenario // {
    rawIdentityListings = {
      before = rawIdentityTable [
        "  Key Type  Public Key Hash Prot Label Common Name Email Address Valid To Valid  "
      ];
      after = rawIdentityTable [
        "  Key Type  Public Key Hash Prot Label Common Name Email Address Valid To Valid  "
        "  p-384-ne 3333333333333333333333333333333333333333 bio fixture-p384 ssh p384@example.test 23.11.26, 17:09 YES  "
        " p-384 4444444444444444444444444444444444444444 none fixture-p384 ssh 23.11.26, 17:09 YES "
        " p-521 5555555555555555555555555555555555555555 none fixture-p521 ssh 23.11.26, 17:09 YES "
        " p-256 6666666666666666666666666666666666666666 none fixture-p256 ssh 23.11.26, 17:09 YES "
        " p-256-ne ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD none fixture-primary ssh 23.11.26, 17:09 YES "
      ];
    };
  };

  rawBiometricConfiguredIdentity = baseScenario // {
    rawIdentityListings = {
      after = rawIdentityTable [
        "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
        "p-256-ne abcdefabcdefabcdefabcdefabcdefabcdefabcd bio fixture-primary ssh primary@example.test 23.11.26, 17:09 YES"
      ];
    };
  };

  rawMalformedIdentity = baseScenario // {
    rawIdentityListings = {
      after = rawIdentityTable [
        "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
        "p-256-ne abcdefabcdefabcdefabcdefabcdefabcdefabcd none fixture-primary ssh malformed extra 23.11.26, 17:09 YES"
      ];
    };
  };

  rawInvalidStatusIdentity = baseScenario // {
    rawIdentityListings = {
      after = rawIdentityTable [
        "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
        "p-256-ne abcdefabcdefabcdefabcdefabcdefabcdefabcd none fixture-primary ssh 23.11.26, 17:09 NO"
      ];
    };
  };

  rawDuplicateIdentity = baseScenario // {
    rawIdentityListings = {
      after = rawIdentityTable [
        "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
        "p-256-ne abcdefabcdefabcdefabcdefabcdefabcdefabcd none fixture-primary ssh 23.11.26, 17:09 YES"
        "p-256-ne abcdefabcdefabcdefabcdefabcdefabcdefabcd none fixture-primary ssh duplicate@example.test 23.11.26, 17:09 YES"
      ];
    };
  };

  rotationScenario = baseScenario // {
    identitySnapshots = {
      before = [ primaryIdentity ];
      after = [
        primaryIdentity
        rotationIdentity
      ];
    };
    residentExports = [
      primaryExport
      rotationExport
    ];
  };

  scenarios = {
    identitySnapshots = baseScenario // {
      identitySnapshots = {
        before = [ ];
        after = [
          primaryIdentity
          biometricIdentity
        ];
      };
    };
    zeroResidentExports = baseScenario // {
      residentExports = [ ];
    };
    oneResidentExport = baseScenario;
    selectorMismatch = baseScenario // {
      expectedSelector = alternateIdentity.hash;
    };
    multipleResidentExports = baseScenario // {
      residentExports = [
        primaryExport
        alternateExport
      ];
    };
    multipleResidentExportsExpectedSecond = baseScenario // {
      residentExports = [
        alternateExport
        primaryExport
      ];
    };
    rotation = rotationScenario;
    rotationCreateFailure = rotationScenario // {
      failures = {
        sc_auth = {
          create = "fixture rotation candidate creation failed";
        };
      };
    };
    rotationVerificationFailure = rotationScenario // {
      failures = {
        provider = {
          sign = "fixture rotation candidate verification failed; first unlock is required";
        };
      };
    };
    ambiguousResidentFingerprint = baseScenario // {
      residentExports = [
        primaryExport
        (
          alternateExport
          // {
            fingerprint = primaryIdentity.sshFingerprint;
          }
        )
      ];
    };
    mismatchedExpectedFingerprint = baseScenario // {
      sshIdentityListings = {
        after = sshIdentityTable primaryIdentity "SHA256:fixturewrong";
      };
    };
    stubKeyMismatch = baseScenario // {
      stubPublicKey = alternateIdentity.publicKey;
    };
    fingerprintOutputMismatch = baseScenario // {
      fingerprintOutput = "SHA256:fixturewrong";
    };
    ctkListingFailure = baseScenario // {
      failures = {
        sc_auth = {
          list = "fixture CTK listing rejected; first unlock is required";
        };
      };
    };
    staleSameLabel = baseScenario // {
      identitySnapshots = {
        before = [ staleSameLabelIdentity ];
        after = [
          staleSameLabelIdentity
          primaryIdentity
        ];
      };
      sshIdentityListings = {
        after = sshIdentityTable primaryIdentity primaryIdentity.sshFingerprint;
      };
    };
    duplicateSshIdentity = baseScenario // {
      sshIdentityListings = {
        after = sshIdentityTableRows [
          "p-256-ne ${primaryIdentity.sshFingerprint} none ${primaryIdentity.label} ssh 23.11.26, 17:09 YES"
          "p-256-ne ${staleSameLabelIdentity.sshFingerprint} none ${primaryIdentity.label} ssh 23.11.26, 17:09 YES"
        ];
      };
    };
    ambiguousIdentity = baseScenario // {
      identitySnapshots = {
        before = [ ];
        after = [
          primaryIdentity
          primaryIdentity
        ];
      };
    };
    biometricConfiguredIdentity = baseScenario // {
      identitySnapshots = {
        before = [ ];
        after = [ biometricConfiguredIdentity ];
      };
    };
    malformedIdentity = baseScenario // {
      identitySnapshots = {
        before = [ ];
        after = [ malformedIdentity ];
      };
    };
    invalidStatusIdentity = baseScenario // {
      identitySnapshots = {
        before = [ ];
        after = [ invalidStatusIdentity ];
      };
    };
    inherit
      rawTableVariants
      rawBiometricConfiguredIdentity
      rawMalformedIdentity
      rawInvalidStatusIdentity
      rawDuplicateIdentity
      ;
    hangCtkListing = baseScenario // {
      hangs = [ "ctk-list" ];
    };
    hangPreflightProvider = baseScenario // {
      hangs = [ "preflight-provider" ];
    };
    hangPreflightSshKeygen = baseScenario // {
      hangs = [ "preflight-ssh-keygen" ];
    };
    hangPreflightSshKeygenStub = baseScenario // {
      hangs = [ "preflight-ssh-keygen-stub" ];
    };
    hangProviderSigning = baseScenario // {
      hangs = [ "provider-sign" ];
    };
    postCreateListFailure = baseScenario // {
      failures = {
        sc_auth = {
          listAfterCreate = "fixture post-create CTK list unavailable";
        };
      };
    };
    postCreateMalformedIdentity = baseScenario // {
      rawIdentityListings = {
        after = rawIdentityTable [
          "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid"
          "p-256-ne ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD none fixture-primary ssh malformed extra 23.11.26, 17:09 YES"
        ];
      };
    };
    hangAllPreflightPhases = baseScenario // {
      hangs = [
        "preflight-provider"
        "preflight-ssh-keygen"
        "provider-sign"
      ];
    };
    providerFailure = baseScenario // {
      failures = {
        provider = {
          sign = "fixture provider rejected signing; first unlock is required";
        };
      };
    };
    workerTree = baseScenario // {
      hangs = [ "ssh-keygen-sign" ];
      workerTree = {
        enabled = true;
        descendantsFile = "descendants";
        processTreeFile = "process-tree";
      };
    };
  };

  nativeTools = {
    scAuth = fakeScAuth;
    provider = fakeProvider;
    sshKeygen = fakeSshKeygen;
  };

  nativeToolPaths = {
    scAuth = "${fakeScAuth}/bin/fixture-sc-auth";
    provider = providerPath;
    sshKeygen = "${fakeSshKeygen}/bin/fixture-ssh-keygen";
  };

  interceptorPaths = {
    agentSocketTrap = "${fakeAgentSocketTrap}/bin/fixture-agent-socket-trap";
    fallback = "${fakeFallback}/bin/fixture-fallback-signer";
  };

  nativeToolArgs = nativeTools // {
    inherit nativeToolPaths;
    inherit interceptorPaths;
    scAuthPath = nativeToolPaths.scAuth;
    providerPath = nativeToolPaths.provider;
    sshKeygenPath = nativeToolPaths.sshKeygen;
  };

  injectPackage =
    package:
    if package == null then
      null
    else if builtins.isFunction package || builtins.isPath package || builtins.isString package then
      pkgs.callPackage package nativeToolArgs
    else
      package.override nativeToolArgs;

  injectedSignerPackage = injectPackage signerPackage;
  injectedAdminPackage = injectPackage adminPackage;

  scenarioFiles = lib.mapAttrs (
    name: scenario:
    pkgs.writeText "git-mcp-signing-scenario-${name}.json" (builtins.toJSON scenario + "\n")
  ) scenarios;

  manifest = pkgs.writeText "git-mcp-signing-fixture-manifest.json" (
    builtins.toJSON {
      inherit interceptorPaths nativeToolPaths scenarios;
      scenarioFiles = lib.mapAttrs (_: path: builtins.unsafeDiscardStringContext "${path}") scenarioFiles;
    }
    + "\n"
  );

  packageEntries = [
    {
      name = "native/sc-auth";
      path = fakeScAuth;
    }
    {
      name = "native/provider";
      path = fakeProvider;
    }
    {
      name = "native/ssh-keygen";
      path = fakeSshKeygen;
    }
    {
      name = "interceptors/agent-socket-trap";
      path = fakeAgentSocketTrap;
    }
    {
      name = "interceptors/fallback";
      path = fakeFallback;
    }
    {
      name = "manifest.json";
      path = manifest;
    }
  ]
  ++ lib.mapAttrsToList (name: path: {
    name = "scenarios/${name}.json";
    inherit path;
  }) scenarioFiles
  ++ lib.optional (injectedSignerPackage != null) {
    name = "signer";
    path = injectedSignerPackage;
  }
  ++ lib.optional (injectedAdminPackage != null) {
    name = "admin";
    path = injectedAdminPackage;
  };

  packages = pkgs.linkFarm "git-mcp-signing-fixtures" packageEntries;
in
{
  inherit
    injectPackage
    manifest
    nativeToolArgs
    nativeToolPaths
    nativeTools
    interceptorPaths
    packages
    scenarioFiles
    scenarios
    ;

  mkSignerPackage = injectPackage;
  mkAdminPackage = injectPackage;
  signerPackage = injectedSignerPackage;
  adminPackage = injectedAdminPackage;
}
