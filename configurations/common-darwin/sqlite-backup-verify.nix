{ pkgs, ... }:
# sqlite-backup-verify: nix-darwin SYSTEM module that owns the
# activation-time verification of the operator's encrypted rclone
# configuration against the SQLite Backup module's Nix-declared
# destinations (R17.1 – R17.5).
#
# Task 5.1 (THIS FILE, INITIAL FORM) declares only the verification
# `pkgs.writeShellApplication` derivation. The activation wiring
# (`system.activationScripts.postActivation.text` at `lib.mkOrder
# 10000`, gated on `cfg.enable && length cfg.databases > 0` per the
# R17.6 dormant exemption) is added by Task 5.2 in the same file.
#
# The script runs as the operator (Task 5.2 invokes it via
# `launchctl asuser $(id -u <user>) sudo -u <user> --set-home`) so
# that `/usr/bin/security find-generic-password -a mcp-hub` reads
# from the correct user-scoped Keychain. It is pure-read: no
# Keychain mutation, no rclone config rewrite, no remote I/O beyond
# `rclone config encryption check` (which only decrypts in memory)
# and `rclone listremotes --long --json` (which enumerates the
# operator's already-configured remote names + types from the
# decrypted config — no network calls to the remotes themselves).
#
# Distinguished failure modes (R17.5) — each emits a categorized
# error to stderr and exits with a class-specific non-zero code so
# the activation log + any wrapper script can disambiguate:
#
#   exit 11  missing passphrase in Keychain (R17.5 missing-passphrase)
#   exit 12  rclone config file not found (R17.1, R17.5 missing-config)
#   exit 13  rclone config is plaintext (R17.2, R17.5 plaintext-config)
#   exit 14  rclone config encrypted but Keychain passphrase mismatch
#            (R17.5 passphrase-mismatch)
#   exit 15  one or more declared destinations missing from the
#            rclone config or have a mismatched backend type
#            (R17.3, R17.4)
#
# On success the script exits 0 silently — activation hooks should
# never spam stdout on the steady-state path.
#
# Manifest contract (consumed via `argv[1]`, written by the HM
# module's `_manifestPath` renderer at
# `home-manager/common/sqlite-backup.nix:342`): the script reads
# `.rcloneConfigPath`, `.rcloneConfigPassphraseSecret`,
# `.archivePassphraseSecret`, `.keychainAccount`, `.rcloneDestinations`
# (attrset of `{ type, ... }`), and `.databases[]` (for the
# referencing-database name in destination-missing errors). The
# manifest path itself is baked into the Nix store at HM render
# time, so any change to declared destinations re-renders the
# manifest and re-invokes verification on the next activation.
let
  verifyScript = pkgs.writeShellApplication {
    name = "sqlite-backup-verify-rclone-config";
    runtimeInputs = [
      pkgs.rclone
      pkgs.jq
    ];
    text = ''
      manifest_path="''${1:-}"
      if [ -z "$manifest_path" ]; then
        echo "sqlite-backup-verify-rclone-config: error: manifest path argument required" >&2
        echo "  usage: sqlite-backup-verify-rclone-config <manifest.json>" >&2
        exit 64
      fi
      if [ ! -f "$manifest_path" ]; then
        echo "sqlite-backup-verify-rclone-config: error: manifest not found at $manifest_path" >&2
        exit 64
      fi

      # All manifest fields fetched up-front; the manifest is the
      # single cross-component data contract per design.md
      # §"HM Module → State Management".
      rclone_config_path="$(jq -r '.rcloneConfigPath' "$manifest_path")"
      rclone_passphrase_secret="$(jq -r '.rcloneConfigPassphraseSecret' "$manifest_path")"
      archive_passphrase_secret="$(jq -r '.archivePassphraseSecret' "$manifest_path")"
      keychain_account="$(jq -r '.keychainAccount' "$manifest_path")"

      # ---- Step 1: Passphrase availability (R17.5 missing-passphrase) ----
      # Both passphrases are checked even though only the rclone-config
      # passphrase is consumed by the encryption check below — the
      # archive passphrase is required for every backup run, so its
      # absence at activation time is also an R17.5-class failure
      # surfacing the same Keychain-bridge breakage.
      for secret in "$archive_passphrase_secret" "$rclone_passphrase_secret"; do
        if ! /usr/bin/security find-generic-password \
              -s "$secret" -a "$keychain_account" -w >/dev/null 2>&1; then
          echo "sqlite-backup-verify-rclone-config: missing passphrase in Keychain: $secret (account: $keychain_account)" >&2
          echo "  ensure the secret is present in 'secrets/mcp.<host>.yaml' and declared in 'home.mcp.keychainSecrets'," >&2
          echo "  then re-run 'darwin-rebuild switch' so the mcp-secrets bridge populates the Keychain entry." >&2
          exit 11
        fi
      done

      # ---- Step 2: rclone config file presence (R17.1) ----
      if [ ! -f "$rclone_config_path" ]; then
        declared_destinations="$(jq -r '.rcloneDestinations | keys | join(", ")' "$manifest_path")"
        echo "sqlite-backup-verify-rclone-config: rclone config not found at $rclone_config_path" >&2
        echo "  run 'rclone config' as the operator to create it and add destinations: ''${declared_destinations:-<none declared>}" >&2
        echo "  then encrypt with 'rclone config encryption set' using the passphrase stored in Keychain ($rclone_passphrase_secret)." >&2
        exit 12
      fi

      # ---- Step 3: encryption + decryption (R17.2, R17.5 plaintext / mismatch) ----
      # `rclone config encryption check` returns 0 iff the config is
      # encrypted AND the supplied passphrase decrypts it. The output
      # disambiguates plaintext-config from passphrase-mismatch — both
      # are non-zero exits but with different messages.
      export RCLONE_PASSWORD_COMMAND="/usr/bin/security find-generic-password -s $rclone_passphrase_secret -a $keychain_account -w"
      encryption_output=""
      if encryption_output="$(rclone config encryption check 2>&1)"; then
        :
      else
        encryption_rc=$?
        if printf '%s\n' "$encryption_output" \
            | grep -qiE 'config is not encrypted|no encryption|not encrypted|unencrypted|no obscured password'; then
          echo "sqlite-backup-verify-rclone-config: rclone config is plaintext at $rclone_config_path" >&2
          echo "  run 'rclone config encryption set' and use the passphrase stored in Keychain ($rclone_passphrase_secret)." >&2
          exit 13
        else
          echo "sqlite-backup-verify-rclone-config: rclone config encrypted but Keychain passphrase does not match (rclone exit $encryption_rc)" >&2
          echo "  rclone output: $encryption_output" >&2
          echo "  either re-encrypt with the Keychain value (rclone config encryption remove; rclone config encryption set)" >&2
          echo "  or update the 1Password entry referenced by '$rclone_passphrase_secret' to match the passphrase rclone was encrypted with." >&2
          exit 14
        fi
      fi

      # ---- Steps 4 + 5: declared destinations vs actual (R17.3, R17.4) ----
      # `rclone listremotes --long --json` emits an array of
      # `{name, type, ...}` objects from the (now-decryptable)
      # config. Build a map and intersect with the Nix-declared
      # destination set so ordering errors don't conflate "missing"
      # with "wrong type".
      remotes_json="$(rclone listremotes --long --json)"

      verify_errors=0
      while IFS=$'\t' read -r dest_name expected_type; do
        actual_type="$(printf '%s' "$remotes_json" \
          | jq -r --arg n "$dest_name" 'map(select(.name == $n)) | (.[0].type // "")')"
        if [ -z "$actual_type" ]; then
          referencing_dbs="$(jq -r --arg n "$dest_name" \
            '[.databases[] | select(.remote == $n) | .name] | join(", ")' \
            "$manifest_path")"
          echo "sqlite-backup-verify-rclone-config: destination '$dest_name' is not in the rclone config" >&2
          if [ -n "$referencing_dbs" ]; then
            echo "  referenced by database(s): $referencing_dbs" >&2
          fi
          echo "  run 'rclone config' to add it as type '$expected_type'." >&2
          verify_errors=$((verify_errors + 1))
        elif [ "$actual_type" != "$expected_type" ]; then
          echo "sqlite-backup-verify-rclone-config: destination '$dest_name' is type '$actual_type' in rclone but declared as '$expected_type' in home.sqliteBackup.rcloneDestinations" >&2
          echo "  reconcile by editing either side (run 'rclone config' to change the rclone backend, or update the Nix declaration to match)." >&2
          verify_errors=$((verify_errors + 1))
        fi
      done < <(jq -r '.rcloneDestinations | to_entries[] | "\(.key)\t\(.value.type)"' "$manifest_path")

      if [ "$verify_errors" -gt 0 ]; then
        exit 15
      fi

      # All checks passed — activation hooks must be silent on the
      # steady-state path so `darwin-rebuild switch` output stays
      # readable.
      exit 0
    '';
  };
in
{
  # Task 5.1 declares the script only. The binding is exposed as a
  # passthru module argument so it is consumed (deadnix-clean)
  # without yet wiring activation. Task 5.2 will replace this line
  # with the real `system.activationScripts.postActivation.text`
  # invocation at `lib.mkOrder 10000`, referencing `verifyScript`
  # from the same `let` scope above.
  _module.args.sqliteBackupVerifyScript = verifyScript;
}
