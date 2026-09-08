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
       fixture_allowed_signers=""

      if [[ ! -r "$fixture_scenario" ]]; then
        printf 'missing fixture scenario: %s\n' "$fixture_scenario" >&2
        return 64
      fi

      mkdir -p "$fixture_root"
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
      if [[ -r "$fixture_root/identity-snapshot" ]]; then
        snapshot="$(<"$fixture_root/identity-snapshot")"
      fi

      if jq -e --arg snapshot "$snapshot" \
        '.rawIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        jq -j --arg snapshot "$snapshot" \
          '.rawIdentityListings[$snapshot]' "$fixture_scenario"
        return
      fi

      printf '%s\n' 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid'
      jq -r --arg snapshot "$snapshot" \
        '.identitySnapshots[$snapshot] // [] | .[] |
          ([
            "p-256-ne",
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
      if [[ -r "$fixture_root/identity-snapshot" ]]; then
        snapshot="$(<"$fixture_root/identity-snapshot")"
      fi

      if jq -e --arg snapshot "$snapshot" \
        '.sshIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        jq -j --arg snapshot "$snapshot" \
          '.sshIdentityListings[$snapshot]' "$fixture_scenario"
        return
      fi

      if jq -e --arg snapshot "$snapshot" \
        '.rawSshIdentityListings // {} | .[$snapshot] != null' "$fixture_scenario" >/dev/null; then
        jq -j --arg snapshot "$snapshot" \
          '.rawSshIdentityListings[$snapshot]' "$fixture_scenario"
        return
      fi

      printf '%s\n' 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid'
      jq -r --arg snapshot "$snapshot" \
        '.identitySnapshots[$snapshot] // [] | .[] |
          ([
            "p-256-ne",
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
        esac
      done
       fixture_allowed_signers=""
        if [[ "$fixture_operation" == "verify" ]]; then
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
           printf '%s\n' "$(<"$stub_path.pub")"
           ;;
         sign)
           fixture_hang "preflight-ssh-keygen" "ssh-keygen-sign"
           if [[ "''${SSH_SK_PROVIDER:-}" != ${builtins.toJSON providerPath} ]]; then
             printf 'fixture refused non-fixture provider: %s\n' "''${SSH_SK_PROVIDER:-<unset>}" >&2
             exit 43
            fi
            "''${SSH_SK_PROVIDER}" sign "$@"
            printf 'fixture-ssh-signature:%s\n' "$fixture_signing_public_key"
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
             '[.residentExports[]? | select(.publicKey == $public_key) | .fingerprint] |
               if length == 1 then .[0] else empty end' "$fixture_scenario")"
           if [[ -z "$fingerprint" ]]; then
             printf 'fixture has no unique fingerprint for public-key artifact: %s\n' "$public_key_path" >&2
             exit 44
           fi
           printf '256 %s fixture-key\n' "$fingerprint"
           ;;
          verify)
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
            printf 'fixture-ssh-keygen-verified\n'
           ;;
         passthrough)
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

  nativeToolArgs = nativeTools // {
    inherit nativeToolPaths;
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
      inherit nativeToolPaths scenarios;
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
    packages
    scenarioFiles
    scenarios
    ;

  mkSignerPackage = injectPackage;
  mkAdminPackage = injectPackage;
  signerPackage = injectedSignerPackage;
  adminPackage = injectedAdminPackage;
}
