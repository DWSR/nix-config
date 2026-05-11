{ pkgs }:
# mcp-secrets-activate: bridge sops-decrypted MCP secrets into the
# macOS Keychain at `darwin-rebuild switch` time.
#
# Invoked from `system.activationScripts.postActivation` by the
# `mcp-sops-bridge` module (see Task 2.5). Runs as root, then drops
# privileges to the target user via `sudo -u "$USERNAME" -H` for every
# Keychain and gh CLI invocation so the entries land in that user's
# `login.keychain-db` and gh auth state.
#
# Defensive guard (R&D Q7, sops-nix ordering): every name listed in the
# manifest is asserted present under `/run/secrets/` BEFORE any state
# mutation. If sops-nix has not yet decrypted (ordering regression,
# missing recipient, locked yaml), the script aborts with exit 1 and
# names the missing path so the operator can diagnose without partial
# state.
#
# gh-token short-circuit (D6, R1.3/R1.4 offline-capable invariant): the
# SHA-256 of the decrypted gh-token is compared against the previously
# recorded hash at `/var/lib/mcp-keychain-sync/gh-token-hash`. When the
# hashes match AND `gh auth status --hostname github.com` exits 0, the
# script logs `skip gh-login no work needed` and skips the network
# round-trip entirely. Otherwise it runs `gh auth login --with-token`
# and atomically updates the hash file.
#
# Stale cleanup (R5.1 + R5.2, registry-driven): the previous declared
# set is read from `/var/lib/mcp-keychain-sync/installed-services` (one
# service per line, sorted), and `comm -23 was current` yields services
# that are no longer declared. Each stale entry is removed via
# `security delete-generic-password`. Entries we never installed are
# never touched — R5.2 forbids enumerating the Keychain for cleanup.
#
# Registry update is atomic: a tempfile is written, then `mv` renames
# it over `/var/lib/mcp-keychain-sync/installed-services` in a single
# rename(2) syscall. The `gh-token-installed` flag is touched/removed
# alongside, mirroring the gh-token slot's declared/undeclared state.
#
# Logging: every Keychain add/update/remove and gh login/logout/skip
# emits a single `mcp-secrets:` line to stderr (R5.3) so the operator
# sees per-entry activity in the `darwin-rebuild` activation log.
#
# Secret-value-on-argv caveat: `security add-generic-password -w "$value"`
# briefly exposes the secret in `ps`. The legacy `mcp-sync-secrets`
# script does the same; the design accepts this risk because (a) the
# host is trusted, (b) the alternative `-w` (prompt for password) is
# not scriptable, and (c) the window is sub-second.
pkgs.writeShellApplication {
  name = "mcp-secrets-activate";
  runtimeInputs = with pkgs; [
    jq
    coreutils
    gh
    diffutils
  ];
  text = ''
    case "''${1:-}" in
      --help|-h)
        cat <<'USAGE'
    mcp-secrets-activate - bridge sops-decrypted MCP secrets into macOS Keychain.

    Usage:
      mcp-secrets-activate <username> <manifest-path>

    Arguments:
      username        target user (the mcp-hub Keychain account holder)
      manifest-path   JSON manifest rendered by mcp-sops-bridge module

    Manifest schema:
      {"keychainSecrets": ["mcp-github-token", ...], "ghAuthToken": true|false}

    Side effects:
      - Adds/updates/removes Keychain entries with service in keychainSecrets
      - Conditionally invokes gh auth login --with-token / gh auth logout
      - Updates /var/lib/mcp-keychain-sync/installed-services (atomic)
      - Touches/removes /var/lib/mcp-keychain-sync/gh-token-installed
      - Writes /var/lib/mcp-keychain-sync/gh-token-hash on gh login

    Invoked from system.activationScripts.postActivation by mcp-sops-bridge.

    Exit codes:
      0    success
      1    guard failure (missing /run/secrets/<name> or invalid manifest)
      2    Keychain add/update/delete failure
      3    gh auth login/logout/status failure
      4    registry write failure
    USAGE
        exit 0
        ;;
    esac

    if [ $# -ne 2 ]; then
      echo "mcp-secrets-activate: error: expected 2 arguments (username, manifest-path), got $#" >&2
      echo "  run --help for usage" >&2
      exit 1
    fi

    USERNAME="$1"
    MANIFEST_PATH="$2"

    if [ ! -e "$MANIFEST_PATH" ]; then
      echo "mcp-secrets-activate: error: manifest not found at $MANIFEST_PATH" >&2
      exit 1
    fi

    # Parse manifest. `jq` failures (malformed JSON, schema mismatch)
    # surface as exit 1 with jq's own diagnostic on stderr.
    if ! GH_AUTH_TOKEN_DECLARED="$(jq -r '.ghAuthToken' "$MANIFEST_PATH")"; then
      echo "mcp-secrets-activate: error: failed to parse .ghAuthToken from $MANIFEST_PATH" >&2
      exit 1
    fi
    case "$GH_AUTH_TOKEN_DECLARED" in
      true|false) ;;
      *)
        echo "mcp-secrets-activate: error: .ghAuthToken must be boolean, got \"$GH_AUTH_TOKEN_DECLARED\"" >&2
        exit 1
        ;;
    esac

    mapfile -t SECRET_NAMES < <(jq -r '.keychainSecrets[]' "$MANIFEST_PATH")

    # Defensive guard: catch sops-nix ordering regressions before any
    # mutation. Naming the missing path makes the failure self-diagnosing.
    for name in "''${SECRET_NAMES[@]}"; do
      if [ ! -e "/run/secrets/$name" ]; then
        echo "mcp-secrets-activate: error: /run/secrets/$name does not exist" >&2
        echo "  this usually means sops-nix did not run before this script;" >&2
        echo "  check activation log for sops decryption errors." >&2
        exit 1
      fi
    done

    if [ "$GH_AUTH_TOKEN_DECLARED" = "true" ] && [ ! -e /run/secrets/gh-token ]; then
      echo "mcp-secrets-activate: error: /run/secrets/gh-token does not exist (manifest declares ghAuthToken=true)" >&2
      echo "  this usually means sops-nix did not run before this script;" >&2
      echo "  check activation log for sops decryption errors." >&2
      exit 1
    fi

    KEYCHAIN_PATH="/Users/$USERNAME/Library/Keychains/login.keychain-db"
    REGISTRY_DIR="/var/lib/mcp-keychain-sync"
    REGISTRY_FILE="$REGISTRY_DIR/installed-services"
    GH_FLAG="$REGISTRY_DIR/gh-token-installed"
    GH_HASH="$REGISTRY_DIR/gh-token-hash"

    # Registry dir is root-owned mode 0700 — never readable by the
    # target user. It only stores service NAMES (not values) and a
    # SHA-256 of the gh token, so leakage would be metadata only.
    mkdir -p "$REGISTRY_DIR"
    chmod 700 "$REGISTRY_DIR"

    # Per-secret loop. `add-generic-password -U` is idempotent: it
    # updates an existing entry's value or creates one if missing.
    # No-op when value already matches (R1.5).
    for service in "''${SECRET_NAMES[@]}"; do
      value="$(cat "/run/secrets/$service")"
      if ! sudo -u "$USERNAME" -H /usr/bin/security add-generic-password \
           -U -s "$service" -a mcp-hub -w "$value" "$KEYCHAIN_PATH" >/dev/null 2>&1; then
        echo "mcp-secrets-activate: error: failed to add Keychain entry for $service" >&2
        exit 2
      fi
      printf 'mcp-secrets: %s %s\n' add-or-update "$service" >&2
    done

    # gh-token slot. Three states:
    #   1. Declared + (hash unchanged AND gh auth status OK) → skip
    #   2. Declared + (hash drift OR gh auth status fail)    → login
    #   3. Not declared + flag exists                         → logout
    if [ "$GH_AUTH_TOKEN_DECLARED" = "true" ]; then
      current_hash="$(sha256sum < /run/secrets/gh-token | awk '{print $1}')"
      recorded_hash=""
      if [ -f "$GH_HASH" ]; then
        recorded_hash="$(cat "$GH_HASH")"
      fi

      if [ "$current_hash" = "$recorded_hash" ] \
         && sudo -u "$USERNAME" -H gh auth status --hostname github.com >/dev/null 2>&1; then
        printf 'mcp-secrets: skip gh-login no work needed\n' >&2
      else
        # shellcheck disable=SC2024
        # The stdin redirect happens in root's shell BEFORE sudo drops
        # privileges; root can read /run/secrets/gh-token (mode 0400
        # root:root) and the open fd is inherited by the sudo'd gh
        # process. Process substitution (<(...)) doesn't reliably work
        # under sudo -u, so this stdin form is the documented invocation.
        if ! sudo -u "$USERNAME" -H gh auth login --with-token --hostname github.com \
             < /run/secrets/gh-token >/dev/null 2>&1; then
          echo "mcp-secrets-activate: error: gh auth login failed" >&2
          exit 3
        fi
        new_hash_tmp="$(mktemp)"
        printf '%s\n' "$current_hash" > "$new_hash_tmp"
        if ! mv "$new_hash_tmp" "$GH_HASH"; then
          rm -f "$new_hash_tmp"
          echo "mcp-secrets-activate: error: failed to update gh-token hash at $GH_HASH" >&2
          exit 4
        fi
        chmod 600 "$GH_HASH"
        touch "$GH_FLAG"
        printf 'mcp-secrets: gh login\n' >&2
      fi
    elif [ -f "$GH_FLAG" ]; then
      # Transition: gh-token was previously declared, now removed.
      # `gh auth logout` failure is non-fatal — proceed to clear local
      # tracking files so the next switch doesn't re-attempt logout.
      if ! sudo -u "$USERNAME" -H gh auth logout --hostname github.com >/dev/null 2>&1; then
        echo "mcp-secrets-activate: warning: gh auth logout failed (proceeding)" >&2
      fi
      rm -f "$GH_FLAG" "$GH_HASH"
      printf 'mcp-secrets: gh logout\n' >&2
    fi

    # Stale Keychain cleanup. Driven entirely by the registry diff
    # (R5.2) — entries we never installed are never enumerated.
    current_sorted="$(printf '%s\n' "''${SECRET_NAMES[@]}" | sort)"
    previous_sorted=""
    if [ -f "$REGISTRY_FILE" ]; then
      previous_sorted="$(cat "$REGISTRY_FILE")"
    fi

    if [ -n "$previous_sorted" ]; then
      while IFS= read -r stale_service; do
        if [ -z "$stale_service" ]; then
          continue
        fi
        # `|| true` because deletion of a missing entry is benign
        # (someone already removed it; we still want to clear our
        # registry tracking on the next step).
        sudo -u "$USERNAME" -H /usr/bin/security delete-generic-password \
          -s "$stale_service" -a mcp-hub "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
        printf 'mcp-secrets: remove %s\n' "$stale_service" >&2
      done < <(comm -23 <(echo "$previous_sorted") <(echo "$current_sorted"))
    fi

    # Atomic registry update: tempfile + mv replaces the prior file
    # in a single rename(2) syscall. Concurrent readers (none expected
    # at activation time, but safe regardless) see either the old or
    # the new file, never a torn write.
    new_registry_tmp="$(mktemp)"
    printf '%s\n' "$current_sorted" > "$new_registry_tmp"
    if ! mv "$new_registry_tmp" "$REGISTRY_FILE"; then
      rm -f "$new_registry_tmp"
      echo "mcp-secrets-activate: error: failed to update registry at $REGISTRY_FILE" >&2
      exit 4
    fi
    chmod 600 "$REGISTRY_FILE"

    exit 0
  '';
}
