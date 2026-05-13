{
  pkgs,
  lib,
  config,
  username,
  ...
}:
# sqlite-backup-verify: nix-darwin SYSTEM module that owns the
# activation-time verification of the operator's encrypted rclone
# configuration against the SQLite Backup module's Nix-declared
# destinations (R17.1 – R17.5).
#
# Two halves of this module:
#
# 1. `verifyScript` (`pkgs.writeShellApplication`, defined in the
#    `let` block below) — Task 5.1: declares the verification
#    program. Pure-read against the operator's environment: no
#    Keychain mutation, no rclone config rewrite, no remote I/O
#    beyond `rclone config encryption check` (in-memory decrypt) and
#    `rclone listremotes --long --json` (config enumeration only —
#    no calls to the remote endpoints themselves).
#
# 2. `system.activationScripts.postActivation.text` at
#    `lib.mkOrder 10000` (THIS BLOCK, Task 5.2) — the eval-time
#    conditional gate + invocation. Strictly later than
#    `mcp-sops-bridge`'s `lib.mkOrder 9999`, guaranteeing the
#    Keychain entries this script reads have already been populated
#    by the bridge's `security add-generic-password` calls earlier
#    in the same `postActivation` fragment.
#
# The script is invoked via `launchctl asuser $(id -u <user>) sudo
# -u <user> --set-home` so it runs in the operator's launchd domain.
# This mirrors home-manager's own nix-darwin activation pattern
# (`nix-darwin/default.nix:27-37` in the home-manager flake) and is
# necessary because `/usr/bin/security find-generic-password -a
# mcp-hub` only reads from the user-scoped login Keychain — a bare
# `sudo -u $username` from root's launchd domain would not have the
# user's Keychain unlocked. `--set-home` ensures `$HOME` is rewritten
# to the operator's home directory so `~/.config/rclone/rclone.conf`
# resolves correctly.
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
# Dormant exemption (R17.6): the conditional
# `hmCfg.enable && hmCfg.databases != [ ]` is evaluated at
# module-eval time (Nix), NOT at activation runtime (bash). When
# the gate is false, `lib.mkOrder 10000` receives the empty string
# and the merged `postActivation.text` contains no verification
# fragment at all — `darwin-rebuild switch` never invokes the
# verification script and therefore never references
# `~/.config/rclone/rclone.conf`. This is what makes the dormant
# default (`enable = true; databases = [ ];`) survive on a host with
# no rclone config installed.
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
  hmCfg = config.home-manager.users.${username}.home.sqliteBackup;

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
  # `lib.mkOrder 10000` places this fragment strictly after
  # `mcp-sops-bridge`'s `lib.mkOrder 9999` in the merged
  # `postActivation.text`. Ordering matters because this script
  # reads from the macOS Keychain entries that the bridge populates
  # via `security add-generic-password` — running before the bridge
  # would surface a spurious R17.5 missing-passphrase failure on
  # any switch where a referenced secret was newly added.
  #
  # The conditional gate is in NIX, not BASH — when
  # `hmCfg.enable && hmCfg.databases != [ ]` is false the merged
  # activation text contains no verification fragment at all (R17.6
  # dormant exemption). This is also what lets the module survive
  # on a host with `databases = [ ]` and an absent
  # `~/.config/rclone/rclone.conf`: `darwin-rebuild switch`
  # succeeds because the verification call is never emitted.
  system.activationScripts.postActivation.text = lib.mkOrder 10000 (
    if hmCfg.enable && hmCfg.databases != [ ] then
      ''
        echo "[sqlite-backup-verify] running R17 verification for ${toString (lib.length hmCfg.databases)} database(s)"
        launchctl asuser $(id -u ${username}) sudo -u ${username} --set-home ${verifyScript}/bin/sqlite-backup-verify-rclone-config ${hmCfg._manifestPath}
      ''
    else
      ""
  );
}
