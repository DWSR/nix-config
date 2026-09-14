{
  lib,
  coreutils,
  git,
  gnugrep,
  jq,
  writeShellApplication,
  scAuthPath ? "/usr/sbin/sc_auth",
  providerPath ? "/usr/lib/ssh-keychain.dylib",
  sshKeygenPath ? "/usr/bin/ssh-keygen",
  swVersPath ? "/usr/bin/sw_vers",
  ...
}:

writeShellApplication {
  name = "git-mcp-secure-enclave-admin";
  runtimeInputs = [
    coreutils
    git
    gnugrep
    jq
  ];
  text = ''
    sc_auth_path=${lib.escapeShellArg scAuthPath}
    provider_path=${lib.escapeShellArg providerPath}
    ssh_keygen_path=${lib.escapeShellArg sshKeygenPath}
    sw_vers_path=${lib.escapeShellArg swVersPath}

    work_dir=""
    export_dir=""
    install_dir=""
    backup_dir=""
    backup_retained=0
    orphan_hashes=""
    orphan_unknown=0
    acceptance_temp=""

    fail() {
      local message="$1"

      printf '[git-mcp-secure-enclave-admin] %s\n' "$message" >&2
      if [[ -n "$orphan_hashes" ]]; then
        printf '[git-mcp-secure-enclave-admin] orphan CTK identity hash: %s\n' "$orphan_hashes" >&2
        printf '%s\n' 'Recover or explicitly decommission the orphan before retrying bootstrap; no local enrollment was installed.' >&2
      elif (( orphan_unknown != 0 )); then
        printf '%s\n' '[git-mcp-secure-enclave-admin] unknown CTK orphan: identity creation may have succeeded but CTK state could not be confirmed.' >&2
        printf '%s\n' 'Inspect sc_auth list-ctk-identities and explicitly recover or decommission the unknown CTK identity before retrying bootstrap; no local enrollment was installed.' >&2
      fi
      exit 1
    }

    cleanup() {
      if [[ -n "$install_dir" && -e "$install_dir" ]]; then
        rm -rf -- "$install_dir"
      fi
      if [[ -n "$acceptance_temp" && -e "$acceptance_temp" ]]; then
        rm -f -- "$acceptance_temp"
      fi
      if [[ "$backup_retained" == 0 && -n "$backup_dir" && -e "$backup_dir" ]]; then
        rm -rf -- "$backup_dir"
      fi
      if [[ -n "$export_dir" && -e "$export_dir" ]]; then
        rm -rf -- "$export_dir"
      fi
      if [[ -n "$work_dir" && -e "$work_dir" ]]; then
        rm -rf -- "$work_dir"
      fi
    }
    trap cleanup EXIT

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

    valid_ctk_date() {
      local value="$1"

      [[ "$value" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2},$ \
        || "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2},$ ]]
    }

    identity_rows() {
      local identity_listing="$1"
      local line
      local normalized_line
      local header_seen=0
      local public_hash
      local key_type
      local protection
      local label
      local common_name
      local email_address
      local valid_to_date
      local valid_to_time
      local valid
      local -a row_fields
      local -A seen_hashes=()

      while IFS= read -r line || [[ -n "$line" ]]; do
        line="''${line%$'\r'}"
        line="''${line#"''${line%%[![:space:]]*}"}"
        line="''${line%"''${line##*[![:space:]]}"}"
        if [[ -z "$line" ]]; then
          continue
        fi

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
           || ! "$valid_to_time" =~ ^[0-9]{2}:[0-9]{2}$ \
           || "$valid" != "YES" ]] \
          || ! valid_ctk_date "$valid_to_date"; then
          return 1
        fi

        public_hash="''${public_hash,,}"
        if [[ -n "''${seen_hashes[$public_hash]+present}" ]]; then
          return 1
        fi
        seen_hashes["$public_hash"]=1
        printf '%s\t%s\t%s\t%s\n' "$public_hash" "$key_type" "$protection" "$label"
      done <<< "$identity_listing"

      if (( header_seen != 1 )); then
        return 1
      fi
    }

    ssh_identity_rows() {
      local identity_listing="$1"
      local line
      local normalized_line
      local header_seen=0
      local key_type
      local protection
      local label
      local common_name
      local email_address
      local valid_to_date
      local valid_to_time
      local valid
      local ssh_fingerprint
      local -a row_fields
      local -A seen_fingerprints=()

      while IFS= read -r line || [[ -n "$line" ]]; do
        line="''${line%$'\r'}"
        line="''${line#"''${line%%[![:space:]]*}"}"
        line="''${line%"''${line##*[![:space:]]}"}"
        if [[ -z "$line" ]]; then
          continue
        fi

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
            ssh_fingerprint="''${row_fields[1]}"
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
            ssh_fingerprint="''${row_fields[1]}"
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

        if [[ ( "$protection" != "bio" && "$protection" != "none" ) \
           || -z "$label" \
           || -z "$common_name" \
           || ( -n "$email_address" && "$email_address" == "-" ) \
           || ! "$valid_to_time" =~ ^[0-9]{2}:[0-9]{2}$ \
           || "$valid" != "YES" \
           || ! "$ssh_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]] \
          || ! valid_ctk_date "$valid_to_date"; then
          return 1
        fi

        if [[ -n "''${seen_fingerprints[$ssh_fingerprint]+present}" ]]; then
          return 1
        fi
        seen_fingerprints["$ssh_fingerprint"]=1
        printf '%s\t%s\t%s\t%s\n' \
          "$ssh_fingerprint" "$key_type" "$protection" "$label"
      done <<< "$identity_listing"

      if (( header_seen != 1 )); then
        return 1
      fi
    }

    recover_orphan_hashes() {
      local raw_listing="$1"
      local extracted_hashes
      local candidate_hash
      local -a recovered_hashes=()
      local -A seen_hashes=()

      extracted_hashes="$(printf '%s\n' "$raw_listing" | grep -Eo '[[:xdigit:]]{40}' | sort -u || true)"
      while IFS= read -r candidate_hash; do
        if [[ -z "$candidate_hash" ]]; then
          continue
        fi
        candidate_hash="''${candidate_hash,,}"
        if [[ -n "''${before_hashes[$candidate_hash]+present}" \
          || -n "''${seen_hashes[$candidate_hash]+present}" ]]; then
          continue
        fi
        seen_hashes["$candidate_hash"]=1
        recovered_hashes+=("$candidate_hash")
      done <<< "$extracted_hashes"

      if (( ''${#recovered_hashes[@]} != 0 )); then
        orphan_hashes="''${recovered_hashes[*]}"
      fi
    }

    native_ssh_keygen_for_hash() {
      local selector="$1"
      shift

      SSH_SK_PROVIDER="$provider_path" \
        KEYCHAIN_CERTIFICATES="$selector" \
        "$ssh_keygen_path" "$@"
    }

    native_ssh_keygen() {
      native_ssh_keygen_for_hash "$orphan_hashes" "$@"
    }

    fingerprint_from_listing() {
      local listing="$1"
      local key_bits
      local fingerprint

      read -r key_bits fingerprint _ <<< "$listing"
      if [[ -z "$key_bits" || ! "$key_bits" =~ ^[0-9]+$ \
        || ! "$fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        return 1
      fi
      printf '%s\n' "$fingerprint"
    }

    diagnose() {
      local command_name="$1"
      local hash="$2"
      local home
      local xdg_config_home
      local active_marker
      local marker_values
      local marker_state_dir
      local marker_hash
      local marker_label
      local marker_public_key
      local marker_fingerprint
      local state_dir
      local identities_dir
      local identity_dir
      local stub_path
      local public_path
      local expected_public_key
      local actual_public_key
      local stub_public_key
      local stub_key_material
      local fingerprint_listing
      local actual_fingerprint
      local identity_listing
      local identity_rows_output
      local ssh_identity_listing
      local ssh_rows_output
      local identity_hash
      local identity_key_type
      local identity_protection
      local identity_label
      local ssh_fingerprint
      local ssh_key_type
      local ssh_protection
      local ssh_label
      local observed_identity_type=""
      local observed_identity_protection=""
      local observed_identity_label=""
      local observed_label_hash=""
      local observed_label_type=""
      local observed_label_protection=""
      local observed_label_label=""
      local observed_identity_rows=""
      local observed_ssh_fingerprint=""
      local observed_ssh_key_type=""
      local observed_ssh_protection=""
      local identity_match_count=0
      local identity_label_count=0
      local ssh_label_count=0
      local probe_file
      local signature_file
      local allowed_signers_file
      local temp_parent

      if [[ ! "$hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "requested CTK identity hash $hash is malformed; expected 40 lowercase hexadecimal characters"
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate the active enrollment marker'
      fi
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"
      if [[ ! -f "$active_marker" || ! -r "$active_marker" ]]; then
        fail "active enrollment marker $active_marker is missing or unreadable"
      fi
      if ! jq -e '
        ((.githubSigningKeyRegistered? | type) == "boolean")
        and (.githubSigningKeyRegistered == true)
      ' "$active_marker" >/dev/null 2>&1; then
        fail "active enrollment marker $active_marker has invalid githubSigningKeyRegistered; expected boolean true"
      fi
      if ! marker_values="$(jq -er '
        [.stateDir, .identityLabel, .ctkPublicKeyHash, .sshPublicKey, .sshFingerprint]
        | if all(.[]; type == "string") then @tsv else error("missing enrollment field") end
      ' "$active_marker" 2>/dev/null)"; then
        fail "active enrollment marker $active_marker is malformed; expected stateDir, identityLabel, ctkPublicKeyHash, sshPublicKey, and sshFingerprint"
      fi
      IFS=$'\t' read -r marker_state_dir marker_label marker_hash marker_public_key marker_fingerprint <<< "$marker_values"

      if [[ "$marker_hash" != "$hash" ]]; then
        fail "active enrollment marker $active_marker selects CTK hash $marker_hash; expected $hash"
      fi
      if [[ ! "$marker_hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "active enrollment marker $active_marker has malformed CTK hash $marker_hash; expected 40 lowercase hexadecimal characters"
      fi
      if [[ -z "$marker_state_dir" || "$marker_state_dir" != /* \
        || "$marker_state_dir" == *$'\n'* || "$marker_state_dir" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid stateDir; expected an absolute path, observed $marker_state_dir"
      fi
      if [[ -z "$marker_label" || "$marker_label" == *$'\n'* || "$marker_label" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid identityLabel; expected a non-empty label, observed $marker_label"
      fi
      if ! expected_public_key="$(normalize_public_key "$marker_public_key")"; then
        fail "active enrollment marker $active_marker has malformed sshPublicKey; expected sk-ecdsa-sha2-nistp256@openssh.com, observed $marker_public_key"
      fi
      if [[ ! "$marker_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "active enrollment marker $active_marker has malformed sshFingerprint; expected SHA256:<base64>, observed $marker_fingerprint"
      fi

      state_dir="$marker_state_dir"
      identities_dir="$state_dir/identities"
      identity_dir="$identities_dir/$hash"
      stub_path="$identity_dir/id_ecdsa_sk_rk"
      public_path="$stub_path.pub"
      if [[ ! -d "$state_dir" ]]; then
        fail "active enrollment state directory $state_dir is absent or not a directory"
      fi
      if [[ ! -d "$identities_dir" ]]; then
        fail "managed identities directory $identities_dir is absent or not a directory"
      fi
      if [[ ! -d "$identity_dir" ]]; then
        fail "managed identity directory $identity_dir is absent or not a directory"
      fi

      if [[ ! -r "$provider_path" ]]; then
        fail "signing provider $provider_path is absent or unreadable"
      fi
      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable"
      fi
      if [[ ! -x "$ssh_keygen_path" ]]; then
        fail "ssh-keygen $ssh_keygen_path is absent or not executable"
      fi
      if [[ ! -f "$stub_path" || ! -r "$stub_path" || ! -s "$stub_path" ]]; then
        fail "resident stub $stub_path is absent, unreadable, or empty"
      fi
      if [[ ! -f "$public_path" || ! -r "$public_path" || ! -s "$public_path" ]]; then
        fail "resident public key $public_path is absent, unreadable, or empty"
      fi

      if ! actual_public_key="$(<"$public_path")"; then
        fail "cannot read resident public key $public_path"
      fi
      if ! actual_public_key="$(normalize_public_key "$actual_public_key")"; then
        fail "resident public key $public_path is malformed; expected $expected_public_key"
      fi
      if [[ "$actual_public_key" != "$expected_public_key" ]]; then
        fail "resident public key $public_path does not match active marker; expected $expected_public_key, observed $actual_public_key"
      fi

      if ! identity_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail "sc_auth identity listing failed for CTK hash $hash; complete the first unlock after reboot and retry"
      fi
      if ! identity_rows_output="$(identity_rows "$identity_listing")"; then
        fail "sc_auth returned malformed CTK identity state; inspect $sc_auth_path and retry"
      fi
      while IFS=$'\t' read -r identity_hash identity_key_type identity_protection identity_label; do
        if [[ "$identity_hash" == "$hash" ]]; then
          identity_match_count=$((identity_match_count + 1))
          observed_identity_type="$identity_key_type"
          observed_identity_protection="$identity_protection"
          observed_identity_label="$identity_label"
        fi
        if [[ "$identity_label" == "$marker_label" ]]; then
          identity_label_count=$((identity_label_count + 1))
          observed_label_hash="$identity_hash"
          observed_label_type="$identity_key_type"
          observed_label_protection="$identity_protection"
          observed_label_label="$identity_label"
          if [[ -n "$observed_identity_rows" ]]; then
            observed_identity_rows="$observed_identity_rows; "
          fi
          observed_identity_rows="$observed_identity_rows$identity_hash/$identity_key_type/$identity_protection/$identity_label"
        fi
      done <<< "$identity_rows_output"
      if (( identity_label_count == 0 )); then
        if (( identity_match_count == 0 )); then
          fail "CTK identity $hash is missing; expected p-256-ne/none label $marker_label; complete the first unlock or bootstrap the enrollment"
        fi
        fail "CTK identity $hash mismatch; expected p-256-ne/none label $marker_label, observed $observed_identity_type/$observed_identity_protection label $observed_identity_label"
      fi
      if (( identity_label_count > 1 )); then
        fail "CTK identity label $marker_label has duplicate rows; expected exactly one p-256-ne/none row for hash $hash, observed rows: $observed_identity_rows"
      fi
      if (( identity_match_count == 0 )) || [[ "$observed_label_hash" != "$hash" \
        || "$observed_label_type" != "p-256-ne" \
        || "$observed_label_protection" != "none" \
        || "$observed_label_label" != "$marker_label" ]]; then
        fail "CTK identity $hash mismatch; expected p-256-ne/none label $marker_label, observed $observed_label_hash/$observed_label_type/$observed_label_protection label $observed_label_label"
      fi

      if ! ssh_identity_listing="$("$sc_auth_path" list-ctk-identities -t ssh)"; then
        fail "sc_auth SSH identity listing failed for label $marker_label; complete the first unlock after reboot and retry"
      fi
      if ! ssh_rows_output="$(ssh_identity_rows "$ssh_identity_listing")"; then
        fail "sc_auth returned malformed SSH identity state; inspect $sc_auth_path and retry"
      fi
      while IFS=$'\t' read -r ssh_fingerprint ssh_key_type ssh_protection ssh_label; do
        if [[ "$ssh_label" != "$marker_label" ]]; then
          continue
        fi
        ssh_label_count=$((ssh_label_count + 1))
        observed_ssh_fingerprint="$ssh_fingerprint"
        observed_ssh_key_type="$ssh_key_type"
        observed_ssh_protection="$ssh_protection"
      done <<< "$ssh_rows_output"
      if (( ssh_label_count == 0 )); then
        fail "CTK SSH identity for label $marker_label is missing or mismatched; expected p-256-ne/none fingerprint $marker_fingerprint"
      fi
      if (( ssh_label_count != 1 )); then
        fail "CTK SSH identity $marker_label has duplicate rows; expected exactly one p-256-ne/none fingerprint $marker_fingerprint"
      fi
      if [[ "$observed_ssh_fingerprint" != "$marker_fingerprint" ]]; then
        fail "CTK SSH identity $marker_label fingerprint mismatch; expected $marker_fingerprint, observed $observed_ssh_fingerprint ($observed_ssh_key_type/$observed_ssh_protection)"
      fi
      if [[ "$observed_ssh_key_type" != "p-256-ne" || "$observed_ssh_protection" != "none" ]]; then
        fail "CTK SSH identity $marker_label mismatch; expected p-256-ne/none fingerprint $marker_fingerprint, observed $observed_ssh_fingerprint ($observed_ssh_key_type/$observed_ssh_protection)"
      fi

      if ! stub_public_key="$(native_ssh_keygen_for_hash "$hash" -y -f "$stub_path")"; then
        fail "ssh-keygen rejected resident stub $stub_path; expected a stub matching $public_path; complete the first unlock or run recover-stub"
      fi
      if ! stub_key_material="$(normalize_public_key "$stub_public_key")"; then
        fail "ssh-keygen returned a malformed public key for resident stub $stub_path; expected $expected_public_key"
      fi
      if [[ "$stub_key_material" != "$expected_public_key" ]]; then
        fail "resident stub $stub_path does not match active marker; expected $expected_public_key, observed $stub_key_material"
      fi
      if [[ "$stub_key_material" != "$actual_public_key" ]]; then
        fail "resident stub $stub_path does not match public key $public_path; expected $actual_public_key, observed $stub_key_material"
      fi

      if ! fingerprint_listing="$(native_ssh_keygen_for_hash "$hash" -lf "$public_path")"; then
        fail "ssh-keygen could not inspect resident public key $public_path; expected fingerprint $marker_fingerprint"
      fi
      if ! actual_fingerprint="$(fingerprint_from_listing "$fingerprint_listing")"; then
        fail "ssh-keygen returned a malformed fingerprint for $public_path; expected $marker_fingerprint"
      fi
      if [[ "$actual_fingerprint" != "$marker_fingerprint" ]]; then
        fail "resident fingerprint $public_path does not match active marker; expected $marker_fingerprint, observed $actual_fingerprint"
      fi

      temp_parent="''${TMPDIR:-/tmp}"
      work_dir="$(mktemp -d "$temp_parent/git-mcp-secure-enclave-admin-diagnosis.XXXXXX")" \
        || fail "cannot create a temporary diagnosis directory under $temp_parent"
      probe_file="$work_dir/local-probe"
      signature_file="$work_dir/local-probe.sig"
      allowed_signers_file="$work_dir/local-allowed-signers"
      printf '%s\n' "git-mcp-secure-enclave-signing $command_name probe" > "$probe_file"
      printf '%s namespaces="git" %s\n' "$marker_label" "$expected_public_key" > "$allowed_signers_file"
      if ! native_ssh_keygen_for_hash "$hash" -Y sign -n git -f "$stub_path" < "$probe_file" > "$signature_file"; then
        fail "local sign failed for CTK identity $hash; complete the first unlock after reboot and retry"
      fi
      if [[ ! -s "$signature_file" ]]; then
        fail "local sign produced an empty disposable signature for CTK identity $hash"
      fi
      if ! native_ssh_keygen_for_hash "$hash" -Y verify -f "$allowed_signers_file" -I "$marker_label" -n git -s "$signature_file" < "$probe_file" >/dev/null; then
        fail "local verify failed for CTK identity $hash; expected the signature to match $public_path"
      fi

      if [[ "$command_name" == "doctor" ]]; then
        printf '%s\n' "doctor: enrollment $hash ($marker_label) is healthy; local sign/verify passed"
      else
        printf '%s\n' "probe: enrollment $hash ($marker_label) produced and verified a disposable signature"
      fi
    }

    recover_stub() {
      local hash="$1"
      local home
      local xdg_config_home
      local active_marker
      local marker_values
      local marker_state_dir
      local marker_hash
      local marker_label
      local marker_public_key
      local marker_fingerprint
      local state_dir
      local identities_dir
      local identity_dir
      local expected_public_key
      local identity_listing
      local identity_rows_output
      local identity_hash
      local identity_key_type
      local identity_protection
      local identity_label
      local ssh_identity_listing
      local ssh_rows_output
      local ssh_fingerprint
      local ssh_key_type
      local ssh_protection
      local ssh_label
      local observed_identity_hash=""
      local observed_identity_type=""
      local observed_identity_protection=""
      local observed_identity_label=""
      local observed_ssh_fingerprint=""
      local observed_ssh_key_type=""
      local observed_ssh_protection=""
      local identity_match_count=0
      local identity_label_count=0
      local ssh_label_count=0
      local selected_public
      local selected_stub
      local selected_public_key
      local derived_public_key
      local fingerprint_listing
      local fingerprint
      local selected_fingerprint
      local probe_file
      local signature_file
      local allowed_signers_file
      local temp_parent
      local entry
      local entry_name
      local -a public_candidates
      local -a matching_candidates
      local -a matching_fingerprints
      local -a existing_entries

      if [[ ! "$hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "requested CTK identity hash $hash is malformed; expected 40 lowercase hexadecimal characters"
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate the active enrollment marker'
      fi
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"
      if [[ ! -f "$active_marker" || ! -r "$active_marker" ]]; then
        fail "active enrollment marker $active_marker is missing or unreadable"
      fi
      if ! jq -e '
        ((.githubSigningKeyRegistered? | type) == "boolean")
        and (.githubSigningKeyRegistered == true)
      ' "$active_marker" >/dev/null 2>&1; then
        fail "active enrollment marker $active_marker has invalid githubSigningKeyRegistered; expected boolean true"
      fi
      if ! marker_values="$(jq -er '
        [.stateDir, .identityLabel, .ctkPublicKeyHash, .sshPublicKey, .sshFingerprint]
        | if all(.[]; type == "string") then @tsv else error("missing enrollment field") end
      ' "$active_marker" 2>/dev/null)"; then
        fail "active enrollment marker $active_marker is malformed; expected stateDir, identityLabel, ctkPublicKeyHash, sshPublicKey, and sshFingerprint"
      fi
      IFS=$'\t' read -r marker_state_dir marker_label marker_hash marker_public_key marker_fingerprint <<< "$marker_values"

      if [[ "$marker_hash" != "$hash" ]]; then
        fail "active enrollment marker $active_marker selects CTK hash $marker_hash; expected $hash"
      fi
      if [[ ! "$marker_hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "active enrollment marker $active_marker has malformed CTK hash $marker_hash; expected 40 lowercase hexadecimal characters"
      fi
      if [[ -z "$marker_state_dir" || "$marker_state_dir" != /* \
        || "$marker_state_dir" == *$'\n'* || "$marker_state_dir" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid stateDir; expected an absolute path, observed $marker_state_dir"
      fi
      if [[ -z "$marker_label" || "$marker_label" == *$'\n'* || "$marker_label" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid identityLabel; expected a non-empty label, observed $marker_label"
      fi
      if ! expected_public_key="$(normalize_public_key "$marker_public_key")"; then
        fail "active enrollment marker $active_marker has malformed sshPublicKey; expected sk-ecdsa-sha2-nistp256@openssh.com, observed $marker_public_key"
      fi
      if [[ ! "$marker_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "active enrollment marker $active_marker has malformed sshFingerprint; expected SHA256:<base64>, observed $marker_fingerprint"
      fi

      state_dir="$marker_state_dir"
      identities_dir="$state_dir/identities"
      identity_dir="$identities_dir/$hash"
      if [[ -L "$state_dir" || -L "$identities_dir" || -L "$identity_dir" ]]; then
        fail "managed enrollment state path for CTK hash $hash is symlinked; recover state before retrying"
      fi
      if [[ -e "$state_dir" && ! -d "$state_dir" ]]; then
        fail "active enrollment state directory $state_dir is not a directory"
      fi
      if [[ -e "$identities_dir" && ! -d "$identities_dir" ]]; then
        fail "managed identities directory $identities_dir is not a directory"
      fi
      if [[ -e "$identity_dir" && ! -d "$identity_dir" ]]; then
        fail "managed identity path $identity_dir is not a directory"
      fi
      if [[ -d "$identity_dir" ]]; then
        shopt -s nullglob dotglob
        existing_entries=("$identity_dir"/*)
        shopt -u nullglob dotglob
        for entry in "''${existing_entries[@]}"; do
          entry_name="''${entry##*/}"
          if [[ "$entry_name" != "id_ecdsa_sk_rk" && "$entry_name" != "id_ecdsa_sk_rk.pub" ]]; then
            fail "managed identity directory $identity_dir contains unexpected state $entry_name; preserve it and retry recovery"
          fi
        done
      fi

      if [[ ! -r "$provider_path" ]]; then
        fail "signing provider $provider_path is absent or unreadable"
      fi
      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable"
      fi
      if [[ ! -x "$ssh_keygen_path" ]]; then
        fail "ssh-keygen $ssh_keygen_path is absent or not executable"
      fi

      if ! identity_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail "sc_auth identity listing failed for CTK hash $hash; complete the first unlock after reboot and retry"
      fi
      if ! identity_rows_output="$(identity_rows "$identity_listing")"; then
        fail 'sc_auth returned malformed CTK identity state; inspect the active identity and retry recovery'
      fi
      while IFS=$'\t' read -r identity_hash identity_key_type identity_protection identity_label; do
        if [[ "$identity_hash" == "$hash" ]]; then
          identity_match_count=$((identity_match_count + 1))
          observed_identity_hash="$identity_hash"
          observed_identity_type="$identity_key_type"
          observed_identity_protection="$identity_protection"
          observed_identity_label="$identity_label"
        fi
        if [[ "$identity_label" == "$marker_label" ]]; then
          identity_label_count=$((identity_label_count + 1))
        fi
      done <<< "$identity_rows_output"
      if (( identity_label_count > 1 )); then
        fail "CTK identity label $marker_label has duplicate rows; expected exactly one p-256-ne/none row for hash $hash"
      fi
      if (( identity_match_count == 0 )); then
        fail "CTK identity $hash is missing; the non-exportable identity must be recreated before recovery"
      fi
      if (( identity_label_count == 0 )) \
        || [[ "$observed_identity_hash" != "$hash" \
          || "$observed_identity_type" != "p-256-ne" \
          || "$observed_identity_protection" != "none" \
          || "$observed_identity_label" != "$marker_label" ]]; then
        fail "CTK identity $hash mismatch; expected p-256-ne/none label $marker_label, observed $observed_identity_type/$observed_identity_protection label $observed_identity_label"
      fi

      if ! ssh_identity_listing="$("$sc_auth_path" list-ctk-identities -t ssh)"; then
        fail "sc_auth SSH identity listing failed for label $marker_label; complete the first unlock after reboot and retry"
      fi
      if ! ssh_rows_output="$(ssh_identity_rows "$ssh_identity_listing")"; then
        fail 'sc_auth returned malformed SSH identity state; inspect the active identity and retry recovery'
      fi
      while IFS=$'\t' read -r ssh_fingerprint ssh_key_type ssh_protection ssh_label; do
        if [[ "$ssh_label" != "$marker_label" ]]; then
          continue
        fi
        ssh_label_count=$((ssh_label_count + 1))
        observed_ssh_fingerprint="$ssh_fingerprint"
        observed_ssh_key_type="$ssh_key_type"
        observed_ssh_protection="$ssh_protection"
      done <<< "$ssh_rows_output"
      if (( ssh_label_count == 0 )); then
        fail "CTK SSH identity for label $marker_label is missing or mismatched; expected p-256-ne/none fingerprint $marker_fingerprint"
      fi
      if (( ssh_label_count != 1 )); then
        fail "CTK SSH identity $marker_label has duplicate rows; expected exactly one p-256-ne/none fingerprint $marker_fingerprint"
      fi
      if [[ "$observed_ssh_fingerprint" != "$marker_fingerprint" ]]; then
        fail "CTK SSH identity $marker_label fingerprint mismatch; expected $marker_fingerprint, observed $observed_ssh_fingerprint"
      fi
      if [[ "$observed_ssh_key_type" != "p-256-ne" || "$observed_ssh_protection" != "none" ]]; then
        fail "CTK SSH identity $marker_label mismatch; expected p-256-ne/none fingerprint $marker_fingerprint, observed $observed_ssh_fingerprint ($observed_ssh_key_type/$observed_ssh_protection)"
      fi

      temp_parent="''${TMPDIR:-/tmp}"
      work_dir="$(mktemp -d "$temp_parent/git-mcp-secure-enclave-admin-recovery.XXXXXX")" \
        || fail "cannot create a temporary recovery directory under $temp_parent"
      export_dir="$(mktemp -d "$work_dir/export.XXXXXX")" \
        || fail "cannot create a temporary resident-export directory under $work_dir"

      if ! (
        cd "$export_dir" &&
          native_ssh_keygen_for_hash "$hash" -K >/dev/null
      ); then
        fail "resident-key export failed for CTK identity $hash; prior resident state was preserved"
      fi

      shopt -s nullglob
      public_candidates=("$export_dir"/*.pub)
      shopt -u nullglob
      matching_candidates=()
      matching_fingerprints=()
      for selected_public in "''${public_candidates[@]}"; do
        selected_stub="''${selected_public%.pub}"
        if [[ ! -f "$selected_public" || ! -r "$selected_public" \
          || ! -f "$selected_stub" || ! -r "$selected_stub" ]]; then
          fail 'resident-key recovery produced an unreadable public/stub pair; prior resident state was preserved'
        fi
        if ! selected_public_key="$(<"$selected_public")"; then
          fail "cannot read exported public key $selected_public; prior resident state was preserved"
        fi
        if ! selected_public_key="$(normalize_public_key "$selected_public_key")"; then
          fail "resident recovery public key $selected_public is malformed; prior resident state was preserved"
        fi
        if ! derived_public_key="$(native_ssh_keygen_for_hash "$hash" -y -f "$selected_stub")"; then
          fail "ssh-keygen rejected exported resident stub $selected_stub; prior resident state was preserved"
        fi
        if ! derived_public_key="$(normalize_public_key "$derived_public_key")"; then
          fail "ssh-keygen returned a malformed public key for exported resident stub $selected_stub; prior resident state was preserved"
        fi
        if [[ "$derived_public_key" != "$selected_public_key" ]]; then
          fail "resident stub $selected_stub does not match its public key; prior resident state was preserved"
        fi
        if ! fingerprint_listing="$(native_ssh_keygen_for_hash "$hash" -lf "$selected_public")" \
          || ! fingerprint="$(fingerprint_from_listing "$fingerprint_listing")"; then
          fail "ssh-keygen returned a malformed fingerprint for exported public key $selected_public; prior resident state was preserved"
        fi
        if [[ "$fingerprint" == "$marker_fingerprint" ]]; then
          matching_candidates+=("$selected_stub")
          matching_fingerprints+=("$fingerprint")
        fi
      done

      if (( ''${#matching_candidates[@]} != 1 )); then
        fail "resident recovery must yield exactly one public-key fingerprint match for $hash (found ''${#matching_candidates[@]}); prior resident state was preserved"
      fi
      selected_stub="''${matching_candidates[0]}"
      selected_public="''${selected_stub}.pub"
      selected_fingerprint="''${matching_fingerprints[0]}"
      selected_public_key="$(normalize_public_key "$(<"$selected_public")")" \
        || fail "selected resident public key $selected_public is malformed; prior resident state was preserved"
      if [[ "$selected_public_key" != "$expected_public_key" \
        || "$selected_fingerprint" != "$marker_fingerprint" ]]; then
        fail "resident recovery identity mismatch; expected public key $expected_public_key and fingerprint $marker_fingerprint, observed $selected_public_key and $selected_fingerprint; prior resident state was preserved"
      fi

      probe_file="$work_dir/recovery-probe"
      signature_file="$work_dir/recovery-probe.sig"
      allowed_signers_file="$work_dir/recovery-allowed-signers"
      printf '%s\n' 'git-mcp-secure-enclave-signing recovery probe' > "$probe_file"
      printf '%s namespaces="git" %s\n' "$marker_label" "$expected_public_key" > "$allowed_signers_file"
      if ! native_ssh_keygen_for_hash "$hash" -Y sign -n git -f "$selected_stub" < "$probe_file" > "$signature_file"; then
        fail "local signing verification failed for CTK identity $hash; prior resident state was preserved"
      fi
      if [[ ! -s "$signature_file" ]]; then
        fail "local signing produced an empty disposable signature for CTK identity $hash; prior resident state was preserved"
      fi
      if ! native_ssh_keygen_for_hash "$hash" -Y verify -f "$allowed_signers_file" -I "$marker_label" -n git -s "$signature_file" < "$probe_file" >/dev/null; then
        fail "local signature verification failed for CTK identity $hash; prior resident state was preserved"
      fi

      mkdir -p -- "$identities_dir" \
        || fail "cannot create managed identities directory $identities_dir; prior resident state was preserved"
      if [[ -L "$state_dir" || -L "$identities_dir" ]]; then
        fail "managed enrollment state path for CTK hash $hash became symlinked; prior resident state was preserved"
      fi
      install_dir="$(mktemp -d "$identities_dir/.recover.XXXXXX")" \
        || fail "cannot create an atomic recovery directory under $identities_dir"
      chmod 700 "$install_dir"
      if ! cp -- "$selected_stub" "$install_dir/id_ecdsa_sk_rk" \
        || ! cp -- "$selected_public" "$install_dir/id_ecdsa_sk_rk.pub"; then
        fail "cannot stage verified resident artifacts for CTK identity $hash; prior resident state was preserved"
      fi
      chmod 600 "$install_dir/id_ecdsa_sk_rk"
      chmod 644 "$install_dir/id_ecdsa_sk_rk.pub"

      if [[ -e "$identity_dir" || -L "$identity_dir" ]]; then
        backup_dir="$(mktemp -d "$identities_dir/.recover-backup.XXXXXX")" \
          || fail "cannot create an atomic recovery backup for CTK identity $hash; prior resident state was preserved"
        if ! rmdir -- "$backup_dir"; then
          fail "cannot prepare an atomic recovery backup for CTK identity $hash; prior resident state was preserved"
        fi
        if ! mv -- "$identity_dir" "$backup_dir"; then
          backup_dir=""
          fail "cannot stage the previous resident state for CTK identity $hash; prior resident state was preserved"
        fi
        if ! mv -- "$install_dir" "$identity_dir"; then
          if mv -- "$backup_dir" "$identity_dir"; then
            backup_dir=""
          else
            backup_retained=1
            fail "cannot atomically install resident artifacts for CTK identity $hash; previous resident state was retained at $backup_dir. Restore it to $identity_dir after fixing the filesystem failure, then remove the retained backup and retry recovery"
          fi
          fail "cannot atomically install resident artifacts for CTK identity $hash; prior resident state was preserved"
        fi
        install_dir=""
        if ! rm -rf -- "$backup_dir"; then
          fail "cannot remove the superseded resident state for CTK identity $hash"
        fi
        backup_dir=""
      else
        if ! mv -- "$install_dir" "$identity_dir"; then
          fail "cannot atomically install resident artifacts for CTK identity $hash; prior resident state was preserved"
        fi
        install_dir=""
      fi

      printf '%s\n' "recover-stub: enrollment $hash ($marker_label) restored the verified resident stub"
    }

    bootstrap() {
      local label=""
      local home
      local xdg_state_home
      local xdg_config_home
      local state_dir
      local identities_dir
      local active_marker
      local before_listing
      local after_listing
      local ssh_listing
      local before_rows
      local after_rows
      local ssh_rows
      local retry_listing
      local create_status
      local hash
      local key_type
      local protection
      local selected_public=""
      local selected_stub=""
      local selected_public_key=""
      local selected_fingerprint=""
      local public_key
      local derived_public_key
      local fingerprint_listing
      local fingerprint
      local ssh_key_type
      local ssh_protection
      local ssh_label
      local ssh_fingerprint
      local expected_fingerprint=""
      local probe_file
      local signature_file
      local allowed_signers_file
      local temp_parent
      local identity_label
      local before_label_count=0
      local identity_dir
      local -a managed_entries
      local -a export_entries
      local -a public_candidates
      local -a matching_candidates
      local -a matching_fingerprints
      local -a new_hashes
      local -a expected_fingerprints
      local -A before_hashes=()
      local -A before_labels=()
      local -A after_hashes=()
      local -A after_labels=()
      local -A new_key_types=()
      local -A new_protections=()
      local -A new_labels=()

      if [[ "''${1:-}" != "--label" || -z "''${2:-}" || -n "''${3:-}" ]]; then
        fail 'usage: bootstrap --label <label>'
      fi
      label="$2"
      if [[ "$label" == *$'\n'* || "$label" == *$'\r'* ]]; then
        fail 'identity label must not contain newline characters'
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate managed enrollment state'
      fi
      xdg_state_home="''${XDG_STATE_HOME:-$home/.local/state}"
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      state_dir="$xdg_state_home/git-mcp-secure-enclave-signing"
      identities_dir="$state_dir/identities"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"

      if [[ -e "$active_marker" || -L "$active_marker" ]]; then
        fail "active Home Manager enrollment marker exists at $active_marker; use doctor, recover, or explicit decommission"
      fi
      if [[ -L "$state_dir" || -L "$identities_dir" ]]; then
        fail "managed enrollment state path $state_dir is symlinked; recover state before retrying"
      fi
      if [[ -e "$identities_dir" && ! -d "$identities_dir" ]]; then
        fail "managed identities path $identities_dir is not a directory; recover state before retrying"
      fi
      if [[ -d "$identities_dir" ]]; then
        shopt -s nullglob dotglob
        managed_entries=("$identities_dir"/*)
        shopt -u nullglob dotglob
        if (( ''${#managed_entries[@]} != 0 )); then
          fail "managed identities directory $identities_dir is not empty; use doctor, recover, or explicit decommission"
        fi
      fi

      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable"
      fi
      if [[ ! -r "$provider_path" ]]; then
        fail "signing provider $provider_path is absent or unreadable"
      fi
      if [[ ! -x "$ssh_keygen_path" ]]; then
        fail "ssh-keygen $ssh_keygen_path is absent or not executable"
      fi

      mkdir -p -- "$identities_dir"
      temp_parent="''${TMPDIR:-/tmp}"
      work_dir="$(mktemp -d "$temp_parent/git-mcp-secure-enclave-admin.XXXXXX")" \
        || fail "cannot create a temporary bootstrap directory under $temp_parent"
      before_rows="$work_dir/before-identity-rows"
      after_rows="$work_dir/after-identity-rows"
      ssh_rows="$work_dir/ssh-identity-rows"

      if ! before_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail 'cannot list CTK identities before creation; complete the first unlock and retry'
      fi
      if ! identity_rows "$before_listing" > "$before_rows"; then
        fail 'sc_auth returned malformed CTK identity state before creation'
      fi
      while IFS=$'\t' read -r hash key_type protection identity_label; do
        if [[ -n "$hash" ]]; then
          before_hashes["$hash"]=1
          before_labels["$hash"]="$identity_label"
          if [[ "$identity_label" == "$label" ]]; then
            before_label_count=$((before_label_count + 1))
          fi
        fi
      done < "$before_rows"
      if (( before_label_count != 0 )); then
        fail "CTK identity label $label already existed before creation; use rotation or decommission the existing enrollment"
      fi

      if "$sc_auth_path" create-ctk-identity -l "$label" -k p-256-ne -t none >/dev/null; then
        create_status=0
      else
        create_status=$?
      fi

      after_listing=""
      if ! after_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)" \
        || ! identity_rows "$after_listing" > "$after_rows"; then
        retry_listing=""
        if retry_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)" \
          && identity_rows "$retry_listing" > "$after_rows"; then
          after_listing="$retry_listing"
        else
          recover_orphan_hashes "$after_listing\n$retry_listing"
          if [[ -n "$orphan_hashes" ]]; then
            fail 'post-create CTK identity state could not be parsed or listed; inspect the recovered orphan before retrying'
          fi
          orphan_unknown=1
          fail 'post-create CTK identity state remains unavailable; inspect sc_auth for an unknown orphan before retrying'
        fi
      fi

      new_hashes=()
      while IFS=$'\t' read -r hash key_type protection identity_label; do
        if [[ -z "$hash" ]]; then
          continue
        fi
        after_hashes["$hash"]=1
        after_labels["$hash"]="$identity_label"
        if [[ -z "''${before_hashes[$hash]+present}" ]]; then
          new_hashes+=("$hash")
          new_key_types["$hash"]="$key_type"
          new_protections["$hash"]="$protection"
          new_labels["$hash"]="$identity_label"
        fi
      done < "$after_rows"
      orphan_hashes="''${new_hashes[*]}"
      for hash in "''${!before_hashes[@]}"; do
        if [[ -z "''${after_hashes[$hash]+present}" ]]; then
          fail 'the CTK identity set lost an existing identity during creation'
        fi
        if [[ "''${after_labels[$hash]-}" != "''${before_labels[$hash]}" ]]; then
          fail "the CTK identity label changed for existing hash $hash during creation"
        fi
      done
      if (( ''${#new_hashes[@]} != 1 )); then
        fail 'CTK identity creation must produce exactly one new identity hash'
      fi
      if (( create_status != 0 )); then
        fail 'CTK identity creation failed; inspect the reported orphan before retrying'
      fi

      hash="''${new_hashes[0]}"
      if [[ "''${new_key_types[$hash]}" != "p-256-ne" || "''${new_protections[$hash]}" != "none" ]]; then
        fail "created CTK identity $hash is not p-256-ne with protection none"
      fi
      if [[ "''${new_labels[$hash]}" != "$label" ]]; then
        fail "created CTK identity $hash has label ''${new_labels[$hash]} instead of requested label $label"
      fi

      if ! ssh_listing="$("$sc_auth_path" list-ctk-identities -t ssh)" \
        || ! ssh_identity_rows "$ssh_listing" > "$ssh_rows"; then
        fail "cannot obtain the independent SSH fingerprint for CTK identity $hash"
      fi
      expected_fingerprints=()
      while IFS=$'\t' read -r ssh_fingerprint ssh_key_type ssh_protection ssh_label; do
        if [[ -n "$ssh_fingerprint" \
          && "$ssh_key_type" == "p-256-ne" \
          && "$ssh_protection" == "none" \
          && "$ssh_label" == "$label" ]]; then
          expected_fingerprints+=("$ssh_fingerprint")
        fi
      done < "$ssh_rows"
      if (( ''${#expected_fingerprints[@]} != 1 )); then
        fail "CTK SSH identity listing must yield exactly one p-256-ne/none/YES row for label $label and hash $hash"
      fi
      expected_fingerprint="''${expected_fingerprints[0]}"

      export_dir="$(mktemp -d "$work_dir/export.XXXXXX")" \
        || fail "cannot create a temporary resident-export directory under $work_dir"
      shopt -s nullglob dotglob
      export_entries=("$export_dir"/*)
      shopt -u nullglob dotglob
      if (( ''${#export_entries[@]} != 0 )); then
        fail 'resident-export directory was not empty before export'
      fi
      if ! (
        cd "$export_dir" &&
          native_ssh_keygen -K >/dev/null
      ); then
        fail "resident-key export failed for CTK identity $hash"
      fi

      shopt -s nullglob
      public_candidates=("$export_dir"/*.pub)
      shopt -u nullglob
      matching_candidates=()
      matching_fingerprints=()
      for selected_public in "''${public_candidates[@]}"; do
        selected_stub="''${selected_public%.pub}"
        if [[ ! -f "$selected_public" || ! -r "$selected_public" \
          || ! -f "$selected_stub" || ! -r "$selected_stub" ]]; then
          fail 'resident-key export produced an unreadable public/stub pair'
        fi
        if ! public_key="$(<"$selected_public")"; then
          fail "cannot read exported public key $selected_public"
        fi
        if ! selected_public_key="$(normalize_public_key "$public_key")"; then
          fail "resident export public key $selected_public is malformed"
        fi
        if ! derived_public_key="$(native_ssh_keygen -y -f "$selected_stub")"; then
          fail "ssh-keygen rejected exported resident stub $selected_stub"
        fi
        if ! derived_public_key="$(normalize_public_key "$derived_public_key")"; then
          fail "ssh-keygen returned a malformed public key for exported resident stub $selected_stub"
        fi
        if [[ "$derived_public_key" != "$selected_public_key" ]]; then
          fail "resident stub $selected_stub does not match its public key"
        fi
        if ! fingerprint_listing="$(native_ssh_keygen -lf "$selected_public")" \
          || ! fingerprint="$(fingerprint_from_listing "$fingerprint_listing")"; then
          fail "ssh-keygen returned a malformed fingerprint for exported public key $selected_public"
        fi
        if [[ "$fingerprint" == "$expected_fingerprint" ]]; then
          matching_candidates+=("$selected_stub")
          matching_fingerprints+=("$fingerprint")
        fi
      done

      if (( ''${#matching_candidates[@]} != 1 )); then
        fail "resident export must yield exactly one public-key fingerprint match (found ''${#matching_candidates[@]})"
      fi
      selected_stub="''${matching_candidates[0]}"
      selected_public="''${selected_stub}.pub"
      selected_fingerprint="''${matching_fingerprints[0]}"
      selected_public_key="$(normalize_public_key "$(<"$selected_public")")" \
        || fail "selected resident public key $selected_public is malformed"

      probe_file="$work_dir/bootstrap-probe"
      signature_file="$work_dir/bootstrap-probe.sig"
      allowed_signers_file="$work_dir/bootstrap-allowed-signers"
      printf '%s\n' 'git-mcp-secure-enclave-signing bootstrap probe' > "$probe_file"
      printf '%s namespaces="git" %s\n' "$label" "$selected_public_key" > "$allowed_signers_file"
      if ! native_ssh_keygen -Y sign -n git -f "$selected_stub" < "$probe_file" > "$signature_file"; then
        fail "local signing verification failed for CTK identity $hash"
      fi
      if [[ ! -s "$signature_file" ]]; then
        fail "local signing produced an empty disposable signature for CTK identity $hash"
      fi
      if ! native_ssh_keygen -Y verify -f "$allowed_signers_file" -I "$label" -n git -s "$signature_file" < "$probe_file" >/dev/null; then
        fail "local signature verification failed for CTK identity $hash"
      fi

      identity_dir="$identities_dir/$hash"
      if [[ -e "$identity_dir" || -L "$identity_dir" ]]; then
        fail "managed identity directory $identity_dir appeared during bootstrap"
      fi
      install_dir="$(mktemp -d "$identities_dir/.bootstrap.XXXXXX")" \
        || fail "cannot create an atomic install directory under $identities_dir"
      chmod 700 "$install_dir"
      if ! cp -- "$selected_stub" "$install_dir/id_ecdsa_sk_rk" \
        || ! cp -- "$selected_public" "$install_dir/id_ecdsa_sk_rk.pub"; then
        fail "cannot stage verified resident artifacts for CTK identity $hash"
      fi
      chmod 600 "$install_dir/id_ecdsa_sk_rk"
      chmod 644 "$install_dir/id_ecdsa_sk_rk.pub"
      if ! mv -- "$install_dir" "$identity_dir"; then
        fail "cannot atomically install resident artifacts for CTK identity $hash"
      fi
      install_dir=""

      jq -cn \
        --arg label "$label" \
        --arg hash "$hash" \
        --arg public_key "$selected_public_key" \
        --arg fingerprint "$selected_fingerprint" \
        '{identityLabel: $label, ctkPublicKeyHash: $hash, sshPublicKey: $public_key, sshFingerprint: $fingerprint, githubSigningKeyRegistered: false}'
    }

    rotate() {
      local label=""
      local home
      local xdg_config_home
      local active_marker
      local marker_values
      local marker_state_dir
      local marker_hash
      local marker_label
      local marker_public_key
      local marker_fingerprint
      local expected_active_public_key
      local actual_active_public_key
      local state_dir
      local identities_dir
      local active_identity_dir
      local active_stub_path
      local active_public_path
      local before_listing
      local after_listing
      local ssh_listing
      local before_rows
      local after_rows
      local ssh_rows
      local retry_listing
      local create_status
      local hash
      local key_type
      local protection
      local identity_label
      local candidate_identity_count=0
      local active_identity_count=0
      local active_label_count=0
      local observed_active_type=""
      local observed_active_protection=""
      local observed_active_label=""
      local candidate_fingerprint=""
      local ssh_key_type
      local ssh_protection
      local ssh_label
      local selected_public=""
      local selected_stub=""
      local selected_public_key=""
      local derived_public_key=""
      local fingerprint_listing
      local fingerprint
      local selected_fingerprint=""
      local probe_file
      local signature_file
      local allowed_signers_file
      local temp_parent
      local identity_dir
      local -a export_entries
      local -a public_candidates
      local -a matching_candidates
      local -a matching_fingerprints
      local -a new_hashes
      local -a expected_fingerprints
      local -A before_hashes=()
      local -A before_labels=()
      local -A after_hashes=()
      local -A after_labels=()
      local -A new_key_types=()
      local -A new_protections=()
      local -A new_labels=()

      if [[ "''${1:-}" != "--label" || -z "''${2:-}" || -n "''${3:-}" ]]; then
        fail 'usage: rotate --label <label>'
      fi
      label="$2"
      if [[ "$label" == *$'\n'* || "$label" == *$'\r'* ]]; then
        fail 'identity label must not contain newline characters'
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate the active enrollment marker'
      fi
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"
      if [[ ! -f "$active_marker" || ! -r "$active_marker" ]]; then
        fail "active enrollment marker $active_marker is missing or unreadable; bootstrap an enrollment before rotating"
      fi
      if ! jq -e '
        ((.githubSigningKeyRegistered? | type) == "boolean")
        and (.githubSigningKeyRegistered == true)
      ' "$active_marker" >/dev/null 2>&1; then
        fail "active enrollment marker $active_marker has invalid githubSigningKeyRegistered; expected boolean true"
      fi
      if ! marker_values="$(jq -er '
        [.stateDir, .identityLabel, .ctkPublicKeyHash, .sshPublicKey, .sshFingerprint]
        | if all(.[]; type == "string") then @tsv else error("missing enrollment field") end
      ' "$active_marker" 2>/dev/null)"; then
        fail "active enrollment marker $active_marker is malformed; expected stateDir, identityLabel, ctkPublicKeyHash, sshPublicKey, and sshFingerprint"
      fi
      IFS=$'\t' read -r marker_state_dir marker_label marker_hash marker_public_key marker_fingerprint <<< "$marker_values"

      if [[ ! "$marker_hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "active enrollment marker $active_marker has malformed CTK hash $marker_hash; expected 40 lowercase hexadecimal characters"
      fi
      if [[ -z "$marker_state_dir" || "$marker_state_dir" != /* \
        || "$marker_state_dir" == *$'\n'* || "$marker_state_dir" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid stateDir; expected an absolute path, observed $marker_state_dir"
      fi
      if [[ -z "$marker_label" || "$marker_label" == *$'\n'* || "$marker_label" == *$'\r'* ]]; then
        fail "active enrollment marker $active_marker has invalid identityLabel; expected a non-empty label, observed $marker_label"
      fi
      if ! expected_active_public_key="$(normalize_public_key "$marker_public_key")"; then
        fail "active enrollment marker $active_marker has malformed sshPublicKey; expected sk-ecdsa-sha2-nistp256@openssh.com, observed $marker_public_key"
      fi
      if [[ ! "$marker_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "active enrollment marker $active_marker has malformed sshFingerprint; expected SHA256:<base64>, observed $marker_fingerprint"
      fi

      state_dir="$marker_state_dir"
      identities_dir="$state_dir/identities"
      active_identity_dir="$identities_dir/$marker_hash"
      active_stub_path="$active_identity_dir/id_ecdsa_sk_rk"
      active_public_path="$active_stub_path.pub"
      if [[ -L "$state_dir" || -L "$identities_dir" || -L "$active_identity_dir" ]]; then
        fail "active enrollment state for CTK hash $marker_hash is symlinked; recover state before retrying rotation"
      fi
      if [[ ! -d "$state_dir" || ! -d "$identities_dir" || ! -d "$active_identity_dir" ]]; then
        fail "active enrollment state for CTK hash $marker_hash is missing; recover the active enrollment before rotating"
      fi
      if [[ ! -f "$active_stub_path" || ! -r "$active_stub_path" || ! -s "$active_stub_path" \
        || ! -f "$active_public_path" || ! -r "$active_public_path" || ! -s "$active_public_path" ]]; then
        fail "active enrollment artifacts for CTK hash $marker_hash are missing or unreadable; recover the active enrollment before rotating"
      fi
      if ! actual_active_public_key="$(<"$active_public_path")" \
        || ! actual_active_public_key="$(normalize_public_key "$actual_active_public_key")"; then
        fail "active resident public key $active_public_path is malformed; recover the active enrollment before rotating"
      fi
      if [[ "$actual_active_public_key" != "$expected_active_public_key" ]]; then
        fail "active resident public key $active_public_path does not match the active marker; preserve the active enrollment and recover it before rotating"
      fi

      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable"
      fi
      if [[ ! -r "$provider_path" ]]; then
        fail "signing provider $provider_path is absent or unreadable"
      fi
      if [[ ! -x "$ssh_keygen_path" ]]; then
        fail "ssh-keygen $ssh_keygen_path is absent or not executable"
      fi

      mkdir -p -- "$identities_dir" \
        || fail "cannot access managed identities directory $identities_dir; prior enrollment was preserved"
      temp_parent="''${TMPDIR:-/tmp}"
      work_dir="$(mktemp -d "$temp_parent/git-mcp-secure-enclave-admin-rotation.XXXXXX")" \
        || fail "cannot create a temporary rotation directory under $temp_parent"
      before_rows="$work_dir/before-identity-rows"
      after_rows="$work_dir/after-identity-rows"
      ssh_rows="$work_dir/ssh-identity-rows"

      if ! before_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail "cannot list CTK identities before rotation; complete the first unlock and retry; prior enrollment was preserved"
      fi
      if ! identity_rows "$before_listing" > "$before_rows"; then
        fail 'sc_auth returned malformed CTK identity state before rotation; prior enrollment was preserved'
      fi
      while IFS=$'\t' read -r hash key_type protection identity_label; do
        if [[ -z "$hash" ]]; then
          continue
        fi
        before_hashes["$hash"]=1
        before_labels["$hash"]="$identity_label"
        if [[ "$hash" == "$marker_hash" ]]; then
          active_identity_count=$((active_identity_count + 1))
          observed_active_type="$key_type"
          observed_active_protection="$protection"
          observed_active_label="$identity_label"
        fi
        if [[ "$identity_label" == "$marker_label" ]]; then
          active_label_count=$((active_label_count + 1))
        fi
        if [[ "$identity_label" == "$label" ]]; then
          candidate_identity_count=$((candidate_identity_count + 1))
        fi
      done < "$before_rows"
      if (( active_identity_count != 1 )) \
        || [[ "$observed_active_type" != "p-256-ne" \
          || "$observed_active_protection" != "none" \
          || "$observed_active_label" != "$marker_label" ]]; then
        fail "active CTK identity $marker_hash is not exactly one p-256-ne/none row for label $marker_label; prior enrollment was preserved"
      fi
      if (( active_label_count != 1 )); then
        fail "active CTK identity label $marker_label is ambiguous; prior enrollment was preserved"
      fi
      if (( candidate_identity_count != 0 )); then
        fail "CTK identity label $label already exists; choose a new label for additive rotation; prior enrollment was preserved"
      fi

      if "$sc_auth_path" create-ctk-identity -l "$label" -k p-256-ne -t none >/dev/null; then
        create_status=0
      else
        create_status=$?
      fi

      after_listing=""
      if ! after_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)" \
        || ! identity_rows "$after_listing" > "$after_rows"; then
        retry_listing=""
        if retry_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)" \
          && identity_rows "$retry_listing" > "$after_rows"; then
          after_listing="$retry_listing"
        else
          recover_orphan_hashes "$after_listing\n$retry_listing"
          if [[ -n "$orphan_hashes" ]]; then
            fail 'post-creation CTK identity state could not be parsed or listed; inspect the rotation orphan before retrying'
          fi
          orphan_unknown=1
          fail 'post-creation CTK identity state remains unavailable; inspect sc_auth for an unknown rotation orphan before retrying'
        fi
      fi

      new_hashes=()
      while IFS=$'\t' read -r hash key_type protection identity_label; do
        if [[ -z "$hash" ]]; then
          continue
        fi
        after_hashes["$hash"]=1
        after_labels["$hash"]="$identity_label"
        if [[ -z "''${before_hashes[$hash]+present}" ]]; then
          new_hashes+=("$hash")
          new_key_types["$hash"]="$key_type"
          new_protections["$hash"]="$protection"
          new_labels["$hash"]="$identity_label"
        fi
      done < "$after_rows"
      orphan_hashes="''${new_hashes[*]}"
      for hash in "''${!before_hashes[@]}"; do
        if [[ -z "''${after_hashes[$hash]+present}" ]]; then
          fail "the CTK identity set lost active hash $hash during rotation; prior enrollment was preserved"
        fi
        if [[ "''${after_labels[$hash]-}" != "''${before_labels[$hash]}" ]]; then
          fail "the CTK identity label changed for existing hash $hash during rotation; prior enrollment was preserved"
        fi
      done
      if (( ''${#new_hashes[@]} != 1 )); then
        fail 'CTK identity rotation must produce exactly one new identity hash; prior enrollment was preserved'
      fi
      if (( create_status != 0 )); then
        fail 'CTK identity candidate creation failed; prior enrollment was preserved'
      fi

      hash="''${new_hashes[0]}"
      if [[ "''${new_key_types[$hash]}" != "p-256-ne" \
        || "''${new_protections[$hash]}" != "none" \
        || "''${new_labels[$hash]}" != "$label" ]]; then
        fail "created CTK identity $hash is not p-256-ne with protection none and label $label; prior enrollment was preserved"
      fi
      orphan_hashes="$hash"

      if ! ssh_listing="$("$sc_auth_path" list-ctk-identities -t ssh)" \
        || ! ssh_identity_rows "$ssh_listing" > "$ssh_rows"; then
        fail "cannot obtain the independent SSH fingerprint for rotation candidate $hash; prior enrollment was preserved"
      fi
      expected_fingerprints=()
      while IFS=$'\t' read -r candidate_fingerprint ssh_key_type ssh_protection ssh_label; do
        if [[ -n "$candidate_fingerprint" \
          && "$ssh_key_type" == "p-256-ne" \
          && "$ssh_protection" == "none" \
          && "$ssh_label" == "$label" ]]; then
          expected_fingerprints+=("$candidate_fingerprint")
        fi
      done < "$ssh_rows"
      if (( ''${#expected_fingerprints[@]} != 1 )); then
        fail "CTK SSH identity listing must yield exactly one p-256-ne/none/YES row for rotation label $label and hash $hash; prior enrollment was preserved"
      fi
      candidate_fingerprint="''${expected_fingerprints[0]}"

      export_dir="$(mktemp -d "$work_dir/export.XXXXXX")" \
        || fail "cannot create a temporary resident-export directory under $work_dir; prior enrollment was preserved"
      shopt -s nullglob dotglob
      export_entries=("$export_dir"/*)
      shopt -u nullglob dotglob
      if (( ''${#export_entries[@]} != 0 )); then
        fail 'resident-export directory was not empty before rotation export; prior enrollment was preserved'
      fi
      if ! (
        cd "$export_dir" &&
          native_ssh_keygen -K >/dev/null
      ); then
        fail "resident-key export failed for rotation candidate $hash; prior enrollment was preserved"
      fi

      shopt -s nullglob
      public_candidates=("$export_dir"/*.pub)
      shopt -u nullglob
      matching_candidates=()
      matching_fingerprints=()
      for selected_public in "''${public_candidates[@]}"; do
        selected_stub="''${selected_public%.pub}"
        if [[ ! -f "$selected_public" || ! -r "$selected_public" \
          || ! -f "$selected_stub" || ! -r "$selected_stub" ]]; then
          fail 'rotation export produced an unreadable public/stub pair; prior enrollment was preserved'
        fi
        if ! selected_public_key="$(<"$selected_public")"; then
          fail "cannot read exported rotation public key $selected_public; prior enrollment was preserved"
        fi
        if ! selected_public_key="$(normalize_public_key "$selected_public_key")"; then
          fail "rotation export public key $selected_public is malformed; prior enrollment was preserved"
        fi
        if ! derived_public_key="$(native_ssh_keygen -y -f "$selected_stub")"; then
          fail "ssh-keygen rejected exported rotation stub $selected_stub; prior enrollment was preserved"
        fi
        if ! derived_public_key="$(normalize_public_key "$derived_public_key")"; then
          fail "ssh-keygen returned a malformed public key for exported rotation stub $selected_stub; prior enrollment was preserved"
        fi
        if [[ "$derived_public_key" != "$selected_public_key" ]]; then
          fail "rotation stub $selected_stub does not match its public key; prior enrollment was preserved"
        fi
        if ! fingerprint_listing="$(native_ssh_keygen -lf "$selected_public")" \
          || ! fingerprint="$(fingerprint_from_listing "$fingerprint_listing")"; then
          fail "ssh-keygen returned a malformed fingerprint for exported rotation public key $selected_public; prior enrollment was preserved"
        fi
        if [[ "$fingerprint" == "$candidate_fingerprint" ]]; then
          matching_candidates+=("$selected_stub")
          matching_fingerprints+=("$fingerprint")
        fi
      done

      if (( ''${#matching_candidates[@]} != 1 )); then
        fail "rotation export must yield exactly one public-key fingerprint match for $hash (found ''${#matching_candidates[@]}); prior enrollment was preserved"
      fi
      selected_stub="''${matching_candidates[0]}"
      selected_public="''${selected_stub}.pub"
      selected_fingerprint="''${matching_fingerprints[0]}"
      selected_public_key="$(normalize_public_key "$(<"$selected_public")")" \
        || fail 'selected rotation public key is malformed; prior enrollment was preserved'
      if [[ "$selected_public_key" == "$expected_active_public_key" \
        || "$selected_fingerprint" == "$marker_fingerprint" ]]; then
        fail "rotation candidate $hash is not distinct from active CTK identity $marker_hash; prior enrollment was preserved"
      fi

      probe_file="$work_dir/rotation-probe"
      signature_file="$work_dir/rotation-probe.sig"
      allowed_signers_file="$work_dir/rotation-allowed-signers"
      printf '%s\n' 'git-mcp-secure-enclave-signing rotation probe' > "$probe_file"
      printf '%s namespaces="git" %s\n' "$label" "$selected_public_key" > "$allowed_signers_file"
      if ! native_ssh_keygen -Y sign -n git -f "$selected_stub" < "$probe_file" > "$signature_file"; then
        fail "local signing verification failed for rotation candidate $hash; prior enrollment was preserved"
      fi
      if [[ ! -s "$signature_file" ]]; then
        fail "local signing produced an empty disposable signature for rotation candidate $hash; prior enrollment was preserved"
      fi
      if ! native_ssh_keygen -Y verify -f "$allowed_signers_file" -I "$label" -n git -s "$signature_file" < "$probe_file" >/dev/null; then
        fail "local signature verification failed for rotation candidate $hash; prior enrollment was preserved"
      fi

      identity_dir="$identities_dir/$hash"
      if [[ -e "$identity_dir" || -L "$identity_dir" ]]; then
        fail "managed identity directory $identity_dir appeared during rotation; prior enrollment was preserved"
      fi
      install_dir="$(mktemp -d "$identities_dir/.rotate.XXXXXX")" \
        || fail "cannot create an atomic rotation staging directory under $identities_dir; prior enrollment was preserved"
      chmod 700 "$install_dir"
      if ! cp -- "$selected_stub" "$install_dir/id_ecdsa_sk_rk" \
        || ! cp -- "$selected_public" "$install_dir/id_ecdsa_sk_rk.pub"; then
        fail "cannot stage verified rotation artifacts for CTK identity $hash; prior enrollment was preserved"
      fi
      chmod 600 "$install_dir/id_ecdsa_sk_rk"
      chmod 644 "$install_dir/id_ecdsa_sk_rk.pub"
      if ! mv -- "$install_dir" "$identity_dir"; then
        fail "cannot atomically install rotation artifacts for CTK identity $hash; prior enrollment was preserved"
      fi
      install_dir=""

      jq -cn \
        --arg label "$label" \
        --arg hash "$hash" \
        --arg public_key "$selected_public_key" \
        --arg fingerprint "$selected_fingerprint" \
        '{identityLabel: $label, ctkPublicKeyHash: $hash, sshPublicKey: $public_key, sshFingerprint: $fingerprint, githubSigningKeyRegistered: false}'
    }

    verify_acceptance_commit() {
      local state_name="$1"
      local commit="$2"
      local resolved_commit
      local commit_body
      local verification_output
      local verification_diagnostic

      if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
        fail "$state_name acceptance commit $commit is malformed; expected a 40-character lowercase commit SHA"
      fi
      if ! resolved_commit="$(git rev-parse --verify "$commit^{commit}" 2>/dev/null)"; then
        fail "$state_name acceptance commit $commit is missing or does not name a commit"
      fi
      if [[ "$resolved_commit" != "$commit" ]]; then
        fail "$state_name acceptance commit $commit resolved to $resolved_commit; refusing ambiguous evidence"
      fi
      commit_body="$work_dir/$state_name-commit"
      if ! git cat-file commit "$commit" > "$commit_body" 2>/dev/null; then
        fail "$state_name acceptance commit $commit could not be read from the repository"
      fi
      if ! grep -q '^gpgsig ' "$commit_body"; then
        fail "$state_name acceptance commit $commit is unsigned; expected an SSH signature from the active enrollment"
      fi

      verification_output="$work_dir/$state_name-verify"
      if ! GIT_CONFIG_NOSYSTEM=1 \
        SSH_SK_PROVIDER="$provider_path" \
        KEYCHAIN_CERTIFICATES="$hash" \
        git \
          -c gpg.format=ssh \
          -c "gpg.ssh.program=$ssh_keygen_path" \
          -c "gpg.ssh.allowedSignersFile=$allowed_signers_file" \
          verify-commit --raw "$commit" < /dev/null > "$verification_output" 2>&1; then
        verification_diagnostic="$(tr '\n' ' ' < "$verification_output" 2>/dev/null || true)"
        fail "$state_name acceptance commit $commit is not verified against active public key $marker_fingerprint: $verification_diagnostic"
      fi
    }

    record_acceptance() {
      local hash="$1"
      local unlocked_commit="$2"
      local locked_commit="$3"
      local sleep_commit="$4"
      local reboot_commit="$5"
      local github_commit="$6"
      local home
      local xdg_config_home
      local active_marker
      local marker_values
      local marker_state_dir
      local marker_hash
      local marker_label
      local marker_public_key
      local marker_fingerprint
      local expected_public_key
      local state_dir
      local acceptance_dir
      local acceptance_record
      local allowed_signers_file
      local record_content
      local timestamp
      local host_name
      local macos_version

      if [[ ! "$hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "requested CTK identity hash $hash is malformed; expected 40 lowercase hexadecimal characters"
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate the active enrollment marker'
      fi
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"
      if [[ ! -f "$active_marker" || ! -r "$active_marker" ]]; then
        fail "active enrollment marker $active_marker is missing or unreadable; complete GitHub registration and activate the enrollment before recording acceptance"
      fi
      if ! jq -e '.githubSigningKeyRegistered == true' "$active_marker" >/dev/null 2>&1; then
        fail "active enrollment marker $active_marker is not registered through GitHub; refusing to record acceptance"
      fi
      if ! marker_values="$(jq -er '
        [.stateDir, .identityLabel, .ctkPublicKeyHash, .sshPublicKey, .sshFingerprint]
        | if all(.[]; type == "string") then @tsv else error("missing enrollment field") end
      ' "$active_marker" 2>/dev/null)"; then
        fail "active enrollment marker $active_marker is malformed; expected stateDir, identityLabel, ctkPublicKeyHash, sshPublicKey, and sshFingerprint"
      fi
      IFS=$'\t' read -r marker_state_dir marker_label marker_hash marker_public_key marker_fingerprint <<< "$marker_values"
      state_dir="$marker_state_dir"
      expected_public_key="$(normalize_public_key "$marker_public_key")" \
        || fail "active enrollment marker $active_marker has malformed sshPublicKey"
      if [[ "$marker_hash" != "$hash" ]]; then
        fail "active enrollment marker $active_marker selects CTK hash $marker_hash; expected $hash; refusing to write evidence"
      fi

      acceptance_dir="$state_dir/acceptance"
      acceptance_record="$acceptance_dir/$hash.json"
      if [[ -L "$state_dir" || -L "$acceptance_dir" || -L "$acceptance_record" ]]; then
        fail "managed acceptance state for CTK hash $hash is symlinked; refusing to write evidence"
      fi
      if [[ ! -d "$state_dir" ]]; then
        fail "active enrollment state directory $state_dir is absent or not a directory"
      fi
      if [[ -e "$acceptance_dir" && ! -d "$acceptance_dir" ]]; then
        fail "managed acceptance directory $acceptance_dir is not a directory; prior evidence was preserved"
      fi
      if [[ -e "$acceptance_record" && ! -f "$acceptance_record" ]]; then
        fail "managed acceptance record $acceptance_record is not a regular file; prior evidence was preserved"
      fi
      if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        fail 'record-acceptance must run inside the Git repository containing the probe commits'
      fi

      work_dir="$(mktemp -d "''${TMPDIR:-/tmp}/git-mcp-secure-enclave-admin-acceptance.XXXXXX")" \
        || fail 'cannot create a temporary acceptance verification directory'
      allowed_signers_file="$work_dir/acceptance-allowed-signers"
      printf '%s namespaces="git" %s\n' "$marker_label" "$expected_public_key" > "$allowed_signers_file"

      verify_acceptance_commit unlocked "$unlocked_commit"
      verify_acceptance_commit locked "$locked_commit"
      verify_acceptance_commit sleep "$sleep_commit"
      verify_acceptance_commit reboot "$reboot_commit"
      verify_acceptance_commit github "$github_commit"

      timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        || fail 'cannot determine the acceptance timestamp; prior evidence was preserved'
      host_name="''${GIT_MCP_ACCEPTANCE_HOST:-}"
      if [[ -z "$host_name" ]]; then
        host_name="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
      fi
      macos_version="''${GIT_MCP_ACCEPTANCE_OS_VERSION:-}"
      if [[ -z "$macos_version" && -x "$sw_vers_path" ]]; then
        macos_version="$($sw_vers_path -productVersion 2>/dev/null || true)"
      fi
      if [[ -z "$macos_version" ]]; then
        macos_version="$(uname -sr 2>/dev/null || true)"
      fi
      if [[ -z "$host_name" || "$host_name" == *$'\n'* || "$host_name" == *$'\r'* ]]; then
        fail 'acceptance host identity is empty or contains a newline; prior evidence was preserved'
      fi
      if [[ -z "$macos_version" || "$macos_version" == *$'\n'* || "$macos_version" == *$'\r'* ]]; then
        fail 'macOS version is empty or contains a newline; prior evidence was preserved'
      fi

      record_content="$(jq -cn \
        --arg host "$host_name" \
        --arg macos_version "$macos_version" \
        --arg hash "$hash" \
        --arg fingerprint "$marker_fingerprint" \
        --arg unlocked "$unlocked_commit" \
        --arg locked "$locked_commit" \
        --arg sleep "$sleep_commit" \
        --arg reboot "$reboot_commit" \
        --arg github "$github_commit" \
        --arg timestamp "$timestamp" \
        '{
          schemaVersion: 1,
          host: $host,
          macOSVersion: $macos_version,
          ctkPublicKeyHash: $hash,
          sshFingerprint: $fingerprint,
          probes: {
            unlocked: {commit: $unlocked, result: "verified"},
            locked: {commit: $locked, result: "verified"},
            sleep: {commit: $sleep, result: "verified"},
            reboot: {commit: $reboot, result: "verified"}
          },
          github: {commit: $github, verified: true, result: "verified"},
          result: "pass",
          recordedAt: $timestamp
        }')" \
        || fail 'cannot serialize acceptance evidence; prior evidence was preserved'

      if ! mkdir -p -- "$acceptance_dir" || ! chmod 700 "$acceptance_dir"; then
        fail "cannot prepare acceptance directory $acceptance_dir; prior evidence was preserved"
      fi
      acceptance_temp="$(mktemp "$acceptance_dir/.acceptance.XXXXXX")" \
        || fail "cannot stage acceptance evidence in $acceptance_dir; prior evidence was preserved"
      chmod 600 "$acceptance_temp" \
        || fail "cannot protect staged acceptance evidence in $acceptance_dir; prior evidence was preserved"
      if ! printf '%s\n' "$record_content" > "$acceptance_temp"; then
        fail "cannot write staged acceptance evidence in $acceptance_dir; prior evidence was preserved"
      fi
      if ! mv -- "$acceptance_temp" "$acceptance_record"; then
        fail "cannot atomically install acceptance record $acceptance_record; prior evidence was preserved"
      fi
      acceptance_temp=""
      printf '%s\n' "record-acceptance: CTK identity $hash passed unlocked, locked, sleep, reboot, and GitHub verification"
      printf '%s\n' "$record_content"
    }

    record_acceptance_command() {
      local hash=""
      local unlocked_commit=""
      local locked_commit=""
      local sleep_commit=""
      local reboot_commit=""
      local github_commit=""
      local github_verified=0
      local usage='usage: record-acceptance --hash <hash> --unlocked-commit <sha> --locked-commit <sha> --sleep-commit <sha> --reboot-commit <sha> --github-commit <sha> --github-verified'

      while (( $# > 0 )); do
        case "$1" in
          --hash|--unlocked-commit|--locked-commit|--sleep-commit|--reboot-commit|--github-commit)
            if [[ "$#" -lt 2 || -z "$2" || "$2" == --* ]]; then
              fail "$usage"
            fi
            case "$1" in
              --hash)
                [[ -z "$hash" ]] || fail "$usage"
                hash="$2"
                ;;
              --unlocked-commit)
                [[ -z "$unlocked_commit" ]] || fail "$usage"
                unlocked_commit="$2"
                ;;
              --locked-commit)
                [[ -z "$locked_commit" ]] || fail "$usage"
                locked_commit="$2"
                ;;
              --sleep-commit)
                [[ -z "$sleep_commit" ]] || fail "$usage"
                sleep_commit="$2"
                ;;
              --reboot-commit)
                [[ -z "$reboot_commit" ]] || fail "$usage"
                reboot_commit="$2"
                ;;
              --github-commit)
                [[ -z "$github_commit" ]] || fail "$usage"
                github_commit="$2"
                ;;
            esac
            shift 2
            ;;
          --github-verified)
            (( github_verified == 0 )) || fail "$usage"
            github_verified=1
            shift
            ;;
          *)
            fail "$usage"
            ;;
        esac
      done

      if [[ -z "$hash" || -z "$unlocked_commit" || -z "$locked_commit" \
        || -z "$sleep_commit" || -z "$reboot_commit" || -z "$github_commit" ]]; then
        fail "$usage"
      fi
      if (( github_verified == 0 )); then
        fail 'record-acceptance requires the explicit --github-verified GitHub Verified attestation'
      fi
      if [[ "$unlocked_commit" == "$locked_commit" \
        || "$unlocked_commit" == "$sleep_commit" \
        || "$unlocked_commit" == "$reboot_commit" \
        || "$unlocked_commit" == "$github_commit" \
        || "$locked_commit" == "$sleep_commit" \
        || "$locked_commit" == "$reboot_commit" \
        || "$locked_commit" == "$github_commit" \
        || "$sleep_commit" == "$reboot_commit" \
        || "$sleep_commit" == "$github_commit" \
        || "$reboot_commit" == "$github_commit" ]]; then
        fail 'record-acceptance requires five distinct commit references; duplicate references are not valid acceptance evidence'
      fi
      record_acceptance "$hash" "$unlocked_commit" "$locked_commit" "$sleep_commit" "$reboot_commit" "$github_commit"
    }

    decommission() {
      local hash="$1"
      local requested_fingerprint="$2"
      local home
      local xdg_state_home
      local xdg_config_home
      local active_marker
      local marker_values
      local marker_state_dir
      local marker_label
      local marker_hash
      local marker_public_key
      local marker_fingerprint
      local state_dir
      local identities_dir
      local identity_dir
      local acceptance_dir
      local acceptance_record
      local identity_listing
      local identity_rows_output
      local identity_hash
      local identity_key_type
      local identity_protection
      local identity_label
      local target_identity_count=0
      local target_label_count=0
      local target_key_type=""
      local target_protection=""
      local target_label=""
      local observed_identity_rows=""
      local ssh_identity_listing
      local ssh_rows_output
      local ssh_fingerprint
      local ssh_key_type
      local ssh_protection
      local ssh_label
      local target_ssh_count=0
      local observed_fingerprint=""
      local observed_ssh_key_type=""
      local observed_ssh_protection=""
      local had_identity_state=0
      local had_acceptance_record=0

      if [[ ! "$hash" =~ ^[0-9a-f]{40}$ ]]; then
        fail "requested CTK identity hash $hash is malformed; expected 40 lowercase hexadecimal characters"
      fi
      if [[ ! "$requested_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
        fail "requested SSH fingerprint $requested_fingerprint is malformed; expected SHA256:<base64>"
      fi

      home="''${HOME:-}"
      if [[ -z "$home" ]]; then
        fail 'HOME is required to locate managed enrollment state'
      fi
      xdg_state_home="''${XDG_STATE_HOME:-$home/.local/state}"
      xdg_config_home="''${XDG_CONFIG_HOME:-$home/.config}"
      active_marker="$xdg_config_home/git-mcp-secure-enclave-signing/active.json"
      state_dir="$xdg_state_home/git-mcp-secure-enclave-signing"

      if [[ -e "$active_marker" || -L "$active_marker" ]]; then
        if [[ -L "$active_marker" || ! -f "$active_marker" || ! -r "$active_marker" ]]; then
          fail "active enrollment marker $active_marker is missing or unreadable; refusing decommission"
        fi
        if ! jq -e '
          ((.githubSigningKeyRegistered? | type) == "boolean")
          and (.githubSigningKeyRegistered == true)
        ' "$active_marker" >/dev/null 2>&1; then
          fail "active enrollment marker $active_marker has invalid githubSigningKeyRegistered; refusing decommission"
        fi
        if ! marker_values="$(jq -er '
          [.stateDir, .identityLabel, .ctkPublicKeyHash, .sshPublicKey, .sshFingerprint]
          | if all(.[]; type == "string") then @tsv else error("missing enrollment field") end
        ' "$active_marker" 2>/dev/null)"; then
          fail "active enrollment marker $active_marker is malformed; refusing decommission"
        fi
        IFS=$'\t' read -r marker_state_dir marker_label marker_hash marker_public_key marker_fingerprint <<< "$marker_values"
        if [[ ! "$marker_hash" =~ ^[0-9a-f]{40}$ ]]; then
          fail "active enrollment marker $active_marker has malformed CTK hash $marker_hash; refusing decommission"
        fi
        if [[ "$marker_hash" == "$hash" ]]; then
          fail "active enrollment marker $active_marker selects CTK hash $hash; refusing to decommission the active identity"
        fi
        if [[ -z "$marker_state_dir" || "$marker_state_dir" != /* \
          || "$marker_state_dir" == *$'\n'* || "$marker_state_dir" == *$'\r'* ]]; then
          fail "active enrollment marker $active_marker has invalid stateDir; refusing decommission"
        fi
        if [[ -z "$marker_label" || "$marker_label" == *$'\n'* || "$marker_label" == *$'\r'* ]]; then
          fail "active enrollment marker $active_marker has invalid identityLabel; refusing decommission"
        fi
        if ! normalize_public_key "$marker_public_key" >/dev/null; then
          fail "active enrollment marker $active_marker has malformed sshPublicKey; refusing decommission"
        fi
        if [[ ! "$marker_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
          fail "active enrollment marker $active_marker has malformed sshFingerprint; refusing decommission"
        fi
        state_dir="$marker_state_dir"
      fi

      identities_dir="$state_dir/identities"
      identity_dir="$identities_dir/$hash"
      acceptance_dir="$state_dir/acceptance"
      acceptance_record="$acceptance_dir/$hash.json"
      if [[ -L "$state_dir" || -L "$identities_dir" || -L "$identity_dir" || -L "$acceptance_record" ]]; then
        fail "managed decommission state for CTK hash $hash is symlinked; recover state before retrying"
      fi
      if [[ -e "$state_dir" && ! -d "$state_dir" ]]; then
        fail "managed enrollment state directory $state_dir is not a directory; refusing decommission"
      fi
      if [[ -e "$identities_dir" && ! -d "$identities_dir" ]]; then
        fail "managed identities directory $identities_dir is not a directory; refusing decommission"
      fi
      if [[ -e "$identity_dir" && ! -d "$identity_dir" ]]; then
        fail "managed identity state $identity_dir is not a directory; refusing decommission"
      fi
      if [[ -L "$acceptance_dir" ]]; then
        fail "managed acceptance directory $acceptance_dir is symlinked; refusing decommission"
      fi
      if [[ ! -d "$acceptance_dir" ]]; then
        fail "managed acceptance directory $acceptance_dir is absent or not a directory; refusing decommission"
      fi
      if [[ -e "$acceptance_record" && ! -f "$acceptance_record" ]]; then
        fail "managed acceptance record $acceptance_record is not a regular file; refusing decommission"
      fi
      if [[ -e "$identity_dir" ]]; then
        had_identity_state=1
      fi
      if [[ -e "$acceptance_record" ]]; then
        had_acceptance_record=1
      fi

      if [[ ! -x "$sc_auth_path" ]]; then
        fail "CTK identity tool $sc_auth_path is absent or not executable"
      fi

      if ! identity_listing="$("$sc_auth_path" list-ctk-identities -t sha1 -e hex)"; then
        fail "cannot list CTK identities before decommissioning $hash; complete the first unlock and retry"
      fi
      if ! identity_rows_output="$(identity_rows "$identity_listing")"; then
        fail 'sc_auth returned malformed CTK identity state; refusing decommission'
      fi
      while IFS=$'\t' read -r identity_hash identity_key_type identity_protection identity_label; do
        if [[ "$identity_hash" != "$hash" ]]; then
          continue
        fi
        target_identity_count=$((target_identity_count + 1))
        target_key_type="$identity_key_type"
        target_protection="$identity_protection"
        target_label="$identity_label"
      done <<< "$identity_rows_output"
      if (( target_identity_count == 0 )); then
        fail "CTK identity $hash is absent; recover-stub --hash $hash can restore only a still-present CTK identity. Bootstrap a replacement with: git-mcp-secure-enclave-admin bootstrap --label <new-label>, then register the new signing key"
      fi
      if (( target_identity_count > 1 )); then
        fail "CTK identity $hash is ambiguous; refusing decommission without exactly one validated SHA1 row"
      fi
      while IFS=$'\t' read -r identity_hash identity_key_type identity_protection identity_label; do
        if [[ "$identity_label" != "$target_label" ]]; then
          continue
        fi
        target_label_count=$((target_label_count + 1))
        if [[ -n "$observed_identity_rows" ]]; then
          observed_identity_rows="$observed_identity_rows; "
        fi
        observed_identity_rows="$observed_identity_rows$identity_hash/$identity_key_type/$identity_protection/$identity_label"
      done <<< "$identity_rows_output"
      if (( target_label_count > 1 )); then
        fail "CTK identity label $target_label has duplicate SHA1 rows and is ambiguous; expected exactly one p-256-ne/none row for hash $hash, observed rows: $observed_identity_rows"
      fi
      if [[ "$target_key_type" != "p-256-ne" || "$target_protection" != "none" ]]; then
        fail "CTK identity $hash is not an exact p-256-ne/none target; observed $target_key_type/$target_protection label $target_label"
      fi

      if ! ssh_identity_listing="$("$sc_auth_path" list-ctk-identities -t ssh)"; then
        fail "cannot independently observe the SSH fingerprint for CTK identity $hash; refusing decommission"
      fi
      if ! ssh_rows_output="$(ssh_identity_rows "$ssh_identity_listing")"; then
        fail 'sc_auth returned malformed SSH identity state; refusing decommission'
      fi
      while IFS=$'\t' read -r ssh_fingerprint ssh_key_type ssh_protection ssh_label; do
        if [[ "$ssh_label" != "$target_label" ]]; then
          continue
        fi
        target_ssh_count=$((target_ssh_count + 1))
        observed_fingerprint="$ssh_fingerprint"
        observed_ssh_key_type="$ssh_key_type"
        observed_ssh_protection="$ssh_protection"
      done <<< "$ssh_rows_output"
      if (( target_ssh_count == 0 )); then
        fail "CTK SSH identity for CTK hash $hash and label $target_label is absent; refusing decommission"
      fi
      if (( target_ssh_count != 1 )); then
        fail "CTK SSH identity label $target_label is ambiguous; refusing decommission without one exact fingerprint"
      fi
      if [[ "$observed_fingerprint" != "$requested_fingerprint" ]]; then
        fail "CTK identity $hash fingerprint mismatch; expected $requested_fingerprint, observed $observed_fingerprint"
      fi
      if [[ "$observed_ssh_key_type" != "p-256-ne" || "$observed_ssh_protection" != "none" ]]; then
        fail "CTK SSH identity $target_label is not an exact p-256-ne/none target; observed $observed_fingerprint ($observed_ssh_key_type/$observed_ssh_protection)"
      fi

      if ! "$sc_auth_path" delete-ctk-identity -h "$hash" >/dev/null; then
        fail "CTK identity deletion failed for $hash; local state was preserved"
      fi
      if (( had_identity_state != 0 )) && ! rm -rf -- "$identity_dir"; then
        fail "CTK identity $hash was deleted, but local state $identity_dir could not be removed; remove only that exact path and retry GitHub cleanup"
      fi
      if (( had_acceptance_record != 0 )) && ! rm -f -- "$acceptance_record"; then
        fail "CTK identity $hash was deleted, but acceptance record $acceptance_record could not be removed; remove only that exact record and retry GitHub cleanup"
      fi

      printf '%s\n' "decommission: removed inactive CTK identity $hash with SSH fingerprint $requested_fingerprint"
      if (( had_identity_state != 0 || had_acceptance_record != 0 )); then
        printf '%s\n' "decommission: removed only the requested local non-secret state for $hash"
      else
        printf '%s\n' "decommission: no local non-secret state existed for $hash"
      fi
      printf '%s\n' "GitHub cleanup: remove the corresponding SSH signing key with fingerprint $requested_fingerprint from GitHub's signing-key settings; do not remove authentication keys"
      printf '%s\n' "Platform cleanup: CTK identity $hash was deleted; verify that no resident identity state remains for this fingerprint"
    }

    case "''${1:-}" in
      bootstrap)
        shift
        bootstrap "$@"
        ;;
      rotate)
        shift
        rotate "$@"
        ;;
      record-acceptance)
        shift
        record_acceptance_command "$@"
        ;;
      decommission)
        shift
        if [[ "$#" != 4 || "$1" != "--hash" || -z "$2" || "$3" != "--fingerprint" || -z "$4" ]]; then
          fail 'usage: decommission --hash <hash> --fingerprint <fingerprint>'
        fi
        decommission "$2" "$4"
        ;;
      doctor|probe)
        if [[ "$#" != 3 || "$2" != "--hash" || -z "$3" ]]; then
          fail 'usage: doctor|probe --hash <hash>'
        fi
        diagnose "$1" "$3"
        ;;
      recover-stub)
        if [[ "$#" != 3 || "$2" != "--hash" || -z "$3" ]]; then
          fail 'usage: recover-stub --hash <hash>'
        fi
        recover_stub "$3"
        ;;
      *)
        fail 'usage: bootstrap|rotate --label <label>; doctor|probe --hash <hash>; recover-stub --hash <hash>; record-acceptance --hash <hash> --unlocked-commit <sha> --locked-commit <sha> --sleep-commit <sha> --reboot-commit <sha> --github-commit <sha> --github-verified; decommission --hash <hash> --fingerprint <fingerprint>'
        ;;
    esac
  '';
}
