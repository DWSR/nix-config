{
  lib,
  coreutils,
  writeShellApplication,
  scAuthPath ? "/usr/sbin/sc_auth",
  providerPath ? "/usr/lib/ssh-keychain.dylib",
  sshKeygenPath ? "/usr/bin/ssh-keygen",
  ...
}:

writeShellApplication {
  name = "git-mcp-secure-enclave-signer";
  runtimeInputs = [
    coreutils
  ];
  text = ''
    sc_auth_path=${lib.escapeShellArg scAuthPath}
    provider_path=${lib.escapeShellArg providerPath}
    ssh_keygen_path=${lib.escapeShellArg sshKeygenPath}

    fail() {
      printf '[git-mcp-secure-enclave-signer] %s\n' "$1" >&2
      exit 1
    }

    is_signing_operation() {
      local previous=""
      local argument

      for argument in "$@"; do
        if [[ "$previous" == "-Y" && "$argument" == "sign" ]]; then
          return 0
        fi
        previous="$argument"
      done

      return 1
    }

    normalize_public_key() {
      local public_key="$1"
      local key_type
      local key_data

      read -r key_type key_data _ <<< "$public_key"
      if [[ "$key_type" != "sk-ecdsa-sha2-nistp256@openssh.com" || -z "$key_data" ]]; then
        return 1
      fi
      if [[ ! "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]]; then
        return 1
      fi
      printf '%s %s\n' "$key_type" "$key_data"
    }

    parse_identity_listing() {
      local identity_listing="$1"
      local expected_hash="$2"
      local line
      local normalized_line
      local header_seen=0
      local matching_count=0
      local normalized_expected_hash
      local -a row_fields
      local key_type
      local public_hash
      local protection
      local label
      local common_name
      local email_address
      local valid_to_date
      local valid_to_time
      local valid

      normalized_expected_hash="''${expected_hash,,}"

      while IFS= read -r line || [[ -n "$line" ]]; do
        line="''${line%$'\r'}"
        line="''${line#"''${line%%[![:space:]]*}"}"
        line="''${line%"''${line##*[![:space:]]}"}"
        [[ -z "$line" ]] && continue

        normalized_line="$(printf '%s' "$line" | tr -s '[:space:]' ' ')"
        if [[ "$normalized_line" == "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid" ]]; then
          if (( header_seen != 0 )); then
            return 1
          fi
          header_seen=1
          continue
        fi

        if (( header_seen == 0 )); then
          return 1
        fi

        read -r -a row_fields <<< "$normalized_line"
        case "''${#row_fields[@]}" in
          8)
            key_type="''${row_fields[0]}"
            public_hash="''${row_fields[1]}"
            protection="''${row_fields[2]}"
            label="''${row_fields[3]}"
            common_name="''${row_fields[4]}"
            email_address=""
            valid_to_date="''${row_fields[5]}"
            valid_to_time="''${row_fields[6]}"
            valid="''${row_fields[7]}"
            ;;
          9)
            key_type="''${row_fields[0]}"
            public_hash="''${row_fields[1]}"
            protection="''${row_fields[2]}"
            label="''${row_fields[3]}"
            common_name="''${row_fields[4]}"
            email_address="''${row_fields[5]}"
            valid_to_date="''${row_fields[6]}"
            valid_to_time="''${row_fields[7]}"
            valid="''${row_fields[8]}"
            ;;
          *)
            return 1
            ;;
        esac

        case "$key_type" in
          p-256|p-256-ne|p-384|p-384-ne|p-521)
            ;;
          *)
            return 1
            ;;
        esac

        if [[ ! "$public_hash" =~ ^[[:xdigit:]]{40}$ \
          || ( "$protection" != "bio" && "$protection" != "none" ) \
          || -z "$label" \
          || -z "$common_name" \
          || ( -n "$email_address" && "$email_address" == "-" ) \
          || ! "$valid_to_date" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2},$ \
          || ! "$valid_to_time" =~ ^[0-9]{2}:[0-9]{2}$ \
          || "$valid" != "YES" ]]; then
          return 1
        fi

        public_hash="''${public_hash,,}"
        if [[ "$key_type" == "p-256-ne" \
          && "$protection" == "none" \
          && "$public_hash" == "$normalized_expected_hash" ]]; then
          matching_count=$((matching_count + 1))
        fi
      done <<< "$identity_listing"

      if (( header_seen != 1 )); then
        return 1
      fi
      printf '%s\n' "$matching_count"
    }

    signing_worker() {
      local expected_provider="''${SSH_SK_PROVIDER:-}"
      local ctk_hash="''${GIT_MCP_SIGNING_CTK_HASH:-}"
      local selector="''${KEYCHAIN_CERTIFICATES:-}"
      local expected_public_key="''${GIT_MCP_SIGNING_PUBLIC_KEY:-}"
      local expected_fingerprint="''${GIT_MCP_SIGNING_FINGERPRINT:-}"
      local configured_stub="''${GIT_MCP_SIGNING_STUB:-}"
      local argument
      local configured_argument=""
      local configured_argument_count=0
      local index=1
      local next_index

      if [[ "$expected_provider" != "$provider_path" ]]; then
        fail "SSH_SK_PROVIDER must be $provider_path; restore the Apple provider path and retry"
      fi
      if [[ ! -r "$provider_path" ]]; then
        fail "signing provider $provider_path is absent or unreadable; restore the Apple provider and retry"
      fi
      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable; restore macOS signing tools and retry"
      fi
      if [[ ! -x "$ssh_keygen_path" ]]; then
        fail "ssh-keygen $ssh_keygen_path is absent or not executable; restore macOS signing tools and retry"
      fi
      if [[ ! "$ctk_hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "configured CTK identity hash is missing or malformed; run the signing doctor command"
      fi
      if [[ "$selector" != "$ctk_hash" ]]; then
        fail "KEYCHAIN_CERTIFICATES must equal configured CTK hash $ctk_hash; restore the git-mcp signing environment"
      fi
      if [[ -z "$expected_public_key" ]]; then
        fail "configured signing public key is missing; restore the git-mcp signing environment"
      fi
      if [[ -z "$expected_fingerprint" ]]; then
        fail "configured signing fingerprint is missing; restore the git-mcp signing environment"
      fi
      if [[ ! "$expected_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "configured signing fingerprint is malformed; run the signing doctor command"
      fi
      if [[ -z "$configured_stub" ]]; then
        fail "configured resident stub path is missing; run the signing recovery command"
      fi

      while (( index <= $# )); do
        argument="''${!index}"
        if [[ "$argument" == "-f" ]]; then
          next_index=$((index + 1))
          if (( next_index > $# )); then
            fail "ssh-keygen -f requires the configured resident stub $configured_stub"
          fi
          configured_argument="''${!next_index}"
          configured_argument_count=$((configured_argument_count + 1))
          index=$((index + 1))
        elif [[ "$argument" == -f* ]]; then
          configured_argument="''${argument#-f}"
          configured_argument_count=$((configured_argument_count + 1))
        fi
        index=$((index + 1))
      done

      if (( configured_argument_count != 1 )); then
        fail "signing requires exactly one -f argument for resident stub $configured_stub"
      fi
      if [[ "$configured_argument" != "$configured_stub" ]]; then
        fail "ssh-keygen -f path $configured_argument does not match configured resident stub $configured_stub"
      fi
      if [[ ! -f "$configured_stub" || ! -r "$configured_stub" || ! -s "$configured_stub" ]]; then
        fail "resident stub $configured_stub is absent, unreadable, or malformed; run recover-stub and retry"
      fi
      if [[ ! -f "$configured_stub.pub" || ! -r "$configured_stub.pub" || ! -s "$configured_stub.pub" ]]; then
        fail "resident public key $configured_stub.pub is absent, unreadable, or malformed; run recover-stub and retry"
      fi

      local identity_listing
      if ! identity_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail "sc_auth identity listing failed; complete the first unlock after reboot and retry"
      fi

      local actual_public_key
      if ! actual_public_key="$(<"$configured_stub.pub")"; then
        fail "cannot read resident public key $configured_stub.pub; run recover-stub and retry"
      fi
      local expected_key_material
      if ! expected_key_material="$(normalize_public_key "$expected_public_key")"; then
        fail "configured signing public key is malformed; run the signing doctor command"
      fi
      local actual_key_material
      if ! actual_key_material="$(normalize_public_key "$actual_public_key")"; then
        fail "resident public key $configured_stub.pub is malformed; run recover-stub and retry"
      fi
      if [[ "$actual_key_material" != "$expected_key_material" ]]; then
        fail "resident public key $configured_stub.pub does not match configured public key; run recover-stub and retry"
      fi

      local stub_public_key
      if ! stub_public_key="$("$ssh_keygen_path" -y -f "$configured_stub")"; then
        fail "ssh-keygen rejected resident stub $configured_stub; run recover-stub and retry"
      fi
      local stub_key_material
      if ! stub_key_material="$(normalize_public_key "$stub_public_key")"; then
        fail "ssh-keygen returned a malformed resident public key for $configured_stub; run recover-stub and retry"
      fi
      if [[ "$stub_key_material" != "$expected_key_material" ]]; then
        fail "resident stub $configured_stub does not match configured public key; run recover-stub and retry"
      fi

      local fingerprint_listing
      if ! fingerprint_listing="$("$ssh_keygen_path" -lf "$configured_stub.pub")"; then
        fail "ssh-keygen could not inspect resident public key $configured_stub.pub; run recover-stub and retry"
      fi
      local actual_fingerprint="''${fingerprint_listing#* }"
      actual_fingerprint="''${actual_fingerprint%% *}"
      if [[ ! "$actual_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "ssh-keygen returned a malformed fingerprint for $configured_stub.pub; run recover-stub and retry"
      fi
      if [[ "$actual_fingerprint" != "$expected_fingerprint" ]]; then
        fail "resident fingerprint $actual_fingerprint does not match configured fingerprint $expected_fingerprint; run recover-stub and retry"
      fi

      local matching_identity_count
      if ! matching_identity_count="$(parse_identity_listing "$identity_listing" "$ctk_hash")"; then
        fail "sc_auth returned malformed CTK identity state; run the signing doctor command"
      fi
      if [[ "$matching_identity_count" != "1" ]]; then
        fail "configured CTK identity $ctk_hash does not match exactly one resident identity; complete first unlock or run recover-stub"
      fi

      export SSH_SK_PROVIDER="$provider_path"
      if "$ssh_keygen_path" "$@"; then
        return 0
      else
        local delegated_status=$?
        printf '%s\n' "Apple signing provider rejected the request; complete the first unlock after reboot and retry" >&2
        return "$delegated_status"
      fi
    }

    if [[ "''${1:-}" == "--signing-worker" ]]; then
      shift
      signing_worker "$@"
      exit $?
    fi

    if ! is_signing_operation "$@"; then
      exec "$ssh_keygen_path" "$@"
    fi

    timeout_status=0
    timeout --signal=TERM --kill-after=1s 20s "$0" --signing-worker "$@" || timeout_status=$?
    if (( timeout_status == 124 )); then
      printf '%s\n' "signing worker timed out after 20 seconds; CTK/provider state was not available before the deadline" >&2
    fi
    exit "$timeout_status"
  '';
}
