{
  lib,
  coreutils,
  gnugrep,
  jq,
  writeShellApplication,
  scAuthPath ? "/usr/sbin/sc_auth",
  providerPath ? "/usr/lib/ssh-keychain.dylib",
  sshKeygenPath ? "/usr/bin/ssh-keygen",
  ...
}:

writeShellApplication {
  name = "git-mcp-secure-enclave-admin";
  runtimeInputs = [
    coreutils
    gnugrep
    jq
  ];
  text = ''
    sc_auth_path=${lib.escapeShellArg scAuthPath}
    provider_path=${lib.escapeShellArg providerPath}
    ssh_keygen_path=${lib.escapeShellArg sshKeygenPath}

    work_dir=""
    export_dir=""
    install_dir=""
    orphan_hashes=""
    orphan_unknown=0

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
          || ! "$valid_to_date" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2},$ \
          || ! "$valid_to_time" =~ ^[0-9]{2}:[0-9]{2}$ \
          || "$valid" != "YES" ]]; then
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
          || ! "$valid_to_date" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2},$ \
          || ! "$valid_to_time" =~ ^[0-9]{2}:[0-9]{2}$ \
          || "$valid" != "YES" \
          || ! "$ssh_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]]; then
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

    native_ssh_keygen() {
      SSH_SK_PROVIDER="$provider_path" \
        KEYCHAIN_CERTIFICATES="$orphan_hashes" \
        "$ssh_keygen_path" "$@"
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

    case "''${1:-}" in
      bootstrap)
        shift
        bootstrap "$@"
        ;;
      *)
        fail 'usage: bootstrap --label <label>'
        ;;
    esac
  '';
}
