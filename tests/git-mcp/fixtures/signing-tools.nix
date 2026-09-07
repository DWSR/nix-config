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

      if [[ ! -r "$fixture_scenario" ]]; then
        printf 'missing fixture scenario: %s\n' "$fixture_scenario" >&2
        return 64
      fi

      mkdir -p "$fixture_root"
    }

    fixture_log_call() {
      local argv_json
      argv_json="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')"
      jq -cn \
        --arg tool "$fixture_tool" \
        --arg operation "$fixture_operation" \
        --argjson argv "$argv_json" \
        --arg pid "''${BASHPID:-$$}" \
        --arg provider "''${SSH_SK_PROVIDER:-}" \
        '{kind: "call", tool: $tool, operation: $operation, argv: $argv, pid: $pid, provider: $provider}' \
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
      message="$(fixture_failure_for "$fixture_tool" "$fixture_operation")"
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
      fixture_log_call "$@"
      trap 'status=$?; set +e; fixture_log_result "$status"; exit "$status"' EXIT
      fixture_hang "ctk-''${fixture_operation}" "preflight-ctk-''${fixture_operation}"
      fixture_maybe_fail

      case "$fixture_operation" in
        list)
          fixture_identity_snapshot
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
      fixture_log_call "$@"
      trap 'status=$?; set +e; fixture_log_result "$status"; exit "$status"' EXIT
      case "$fixture_operation" in
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
          printf 'fixture-ssh-signature\n'
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
  };

  alternateIdentity = {
    hash = "2222222222222222222222222222222222222222";
    label = "fixture-alternate";
    publicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixturealternate";
    fingerprint = "SHA256:fixturealternate";
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
    inherit (primaryIdentity) publicKey fingerprint;
    stubName = "id_ecdsa_sk_rk";
    stub = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yZXNpZGVudC1oYW5kbGUtcHJpbWFyeQ==\n-----END OPENSSH PRIVATE KEY-----";
  };

  alternateExport = {
    inherit (alternateIdentity) publicKey fingerprint;
    stubName = "id_ecdsa_sk_rk-alternate";
    stub = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yZXNpZGVudC1oYW5kbGUtYWx0ZXJuYXRl\n-----END OPENSSH PRIVATE KEY-----";
  };

  baseScenario = {
    identitySnapshots = {
      before = [ ];
      after = [ primaryIdentity ];
    };
    rawIdentityListings = { };
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
    multipleResidentExports = baseScenario // {
      residentExports = [
        primaryExport
        alternateExport
      ];
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
