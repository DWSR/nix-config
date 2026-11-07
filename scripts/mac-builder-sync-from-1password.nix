{ pkgs }:
pkgs.writeShellApplication {
  name = "mac-builder-sync-from-1password";
  runtimeInputs = with pkgs; [
    _1password-cli
    coreutils
    git
    gnugrep
    jq
    sops
  ];
  text = ''
    case "''${1:-}" in
      ""|--help|-h) ;;
      *)
        echo "mac-builder-sync-from-1password: takes no arguments" >&2
        exit 1
        ;;
    esac

    if [ "''${1:-}" = --help ] || [ "''${1:-}" = -h ]; then
      cat <<'USAGE'
    mac-builder-sync-from-1password - refresh the mac-builder SOPS store.

    Reads the Tailscale OAuth Client ID and Client Secret plus
    builder-authorized-keys from 1Password, encrypts the result for mac-builder,
    and atomically replaces
    secrets/remote-builder.mac-builder.yaml.

    Requires an authenticated `op` session and the mac-builder age key stored
    at op://Private/sops-age-key-mac-builder/notesPlain.
    USAGE
      exit 0
    fi

    if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
      echo "mac-builder-sync-from-1password: error: not inside a git working tree" >&2
      exit 1
    fi
    DEST_REL=secrets/remote-builder.mac-builder.yaml
    DEST="$REPO_ROOT/$DEST_REL"
    if ! op vault list >/dev/null 2>&1; then
      echo "mac-builder-sync-from-1password: error: 1Password CLI not authenticated; run op signin" >&2
      exit 2
    fi

    SECRETS_DIR="$REPO_ROOT/secrets"
    tmpdir="$(mktemp -d "$SECRETS_DIR/.mac-builder-sync-XXXXXX")"
    chmod 0700 "$tmpdir"
    trap 'rm -rf "$tmpdir"' EXIT
    age_key="$tmpdir/age.key"
    personal_age_key="$tmpdir/personal-age.key"
    plaintext="$tmpdir/remote-builder.mac-builder.yaml"
    personal_plaintext="$tmpdir/mac-builder-client.personal.yaml"
    KEY_URI=op://Private/sops-age-key-mac-builder/notesPlain
    if ! op read --no-newline "$KEY_URI" > "$age_key"; then
      echo "mac-builder-sync-from-1password: error: failed to read mac-builder age key from $KEY_URI" >&2
      exit 3
    fi
    chmod 0600 "$age_key"
    if ! grep -q '^AGE-SECRET-KEY-' "$age_key"; then
      echo "mac-builder-sync-from-1password: error: invalid age key at $KEY_URI" >&2
      exit 3
    fi
    export SOPS_AGE_KEY_FILE="$age_key"

    PERSONAL_AGE_KEY_URI=op://Private/sops-age-key-personal/notesPlain
    if ! op read --no-newline "$PERSONAL_AGE_KEY_URI" > "$personal_age_key"; then
      echo "mac-builder-sync-from-1password: error: failed to read personal age key from $PERSONAL_AGE_KEY_URI" >&2
      exit 3
    fi
    chmod 0600 "$personal_age_key"
    if ! grep -q '^AGE-SECRET-KEY-' "$personal_age_key"; then
      echo "mac-builder-sync-from-1password: error: invalid personal age key at $PERSONAL_AGE_KEY_URI" >&2
      exit 3
    fi

    CLIENT_ID_URI='op://Infrastructure/mac-builder Tailscale OAuth/Client ID'
    CLIENT_SECRET_URI='op://Infrastructure/mac-builder Tailscale OAuth/Client Secret'
    AUTHORIZED_KEYS_URI='op://Infrastructure/mac-builder authorized keys/notesPlain'
    SSH_PRIVATE_KEY_URI='op://Infrastructure/mpbezzwylhzlupl7epao2mp5za/private key'
    if ! client_id="$(op read --no-newline "$CLIENT_ID_URI" 2>/dev/null)"; then
      echo "mac-builder-sync-from-1password: error: failed to resolve Tailscale OAuth Client ID" >&2
      echo "  URI: $CLIENT_ID_URI" >&2
      exit 3
    fi
    if ! client_secret="$(op read --no-newline "$CLIENT_SECRET_URI" 2>/dev/null)"; then
      echo "mac-builder-sync-from-1password: error: failed to resolve Tailscale OAuth Client Secret" >&2
      echo "  URI: $CLIENT_SECRET_URI" >&2
      exit 3
    fi
    if ! authorized_keys="$(op read --no-newline "$AUTHORIZED_KEYS_URI" 2>/dev/null)"; then
      echo "mac-builder-sync-from-1password: error: failed to resolve builder-authorized-keys" >&2
      echo "  URI: $AUTHORIZED_KEYS_URI" >&2
      exit 3
    fi
    if ! ssh_private_key="$(op read --no-newline "$SSH_PRIVATE_KEY_URI" 2>/dev/null)"; then
      echo "mac-builder-sync-from-1password: error: failed to resolve mac-builder SSH private key" >&2
      echo "  URI: $SSH_PRIVATE_KEY_URI" >&2
      exit 3
    fi
    if [ -z "$client_id" ] || [ -z "$client_secret" ] || [ -z "$authorized_keys" ] || [ -z "$ssh_private_key" ]; then
      echo "mac-builder-sync-from-1password: error: OAuth credentials, authorized keys, and SSH private key must be non-empty" >&2
      exit 3
    fi
    if [[ ! "$authorized_keys" =~ [^[:space:]] ]]; then
      echo "mac-builder-sync-from-1password: error: builder-authorized-keys contains no public keys" >&2
      echo "  URI: $AUTHORIZED_KEYS_URI" >&2
      exit 3
    fi

    # Quote values as JSON strings; JSON string syntax is valid YAML 1.2.
    printf '%s' "$client_id" | jq -Rs . > "$tmpdir/client-id.json"
    printf '%s' "$client_secret" | jq -Rs . > "$tmpdir/client-secret.json"
    printf '%s' "$authorized_keys" | jq -Rs . > "$tmpdir/authorized-keys.json"
    printf '%s' "$ssh_private_key" | jq -Rs . > "$tmpdir/ssh-private-key.json"
    {
      printf 'builder-tailscale-oauth-client-id: '
      tr -d '\n' < "$tmpdir/client-id.json"
      printf '\nbuilder-tailscale-oauth-secret: '
      tr -d '\n' < "$tmpdir/client-secret.json"
      printf '\nbuilder-authorized-keys: '
      tr -d '\n' < "$tmpdir/authorized-keys.json"
      printf '\n'
    } > "$plaintext"
    {
      printf 'mac-builder-ssh-private-key: '
      tr -d '\n' < "$tmpdir/ssh-private-key.json"
      printf '\n'
    } > "$personal_plaintext"
    unset client_id client_secret authorized_keys ssh_private_key

    if ! sops --config "$REPO_ROOT/.sops.yaml" \
      --filename-override "$DEST_REL" \
      --input-type yaml --output-type yaml --encrypt --in-place "$plaintext"; then
      echo "mac-builder-sync-from-1password: error: SOPS encryption failed" >&2
      exit 4
    fi
    mv "$plaintext" "$DEST"
    export SOPS_AGE_KEY_FILE="$personal_age_key"
    PERSONAL_DEST_REL=secrets/mac-builder-client.personal.yaml
    if ! sops --config "$REPO_ROOT/.sops.yaml" \
      --filename-override "$PERSONAL_DEST_REL" \
      --input-type yaml --output-type yaml --encrypt --in-place "$personal_plaintext"; then
      echo "mac-builder-sync-from-1password: error: SOPS encryption failed for personal builder credential" >&2
      exit 4
    fi
    mv "$personal_plaintext" "$REPO_ROOT/$PERSONAL_DEST_REL"
    echo "mac-builder-sync-from-1password: refreshed builder credentials in $DEST_REL and $PERSONAL_DEST_REL"
  '';
}
