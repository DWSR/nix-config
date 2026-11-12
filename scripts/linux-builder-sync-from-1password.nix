{ pkgs }:
# linux-builder-sync-from-1password: refresh the Linux builder's encrypted
# secret stores from 1Password.
#
# This command is the builder-side counterpart of
# scripts/fabro-sync-from-1password.nix and
# scripts/mac-builder-sync-from-1password.nix. It writes two independent
# stores and never mints, generates, or rotates a secret value:
#
#   * secrets/remote-builder.linux-builder.yaml — the builder host's store,
#     encrypted to the operator-provisioned `host_linux_builder` age
#     identity. It holds:
#       - builder-authorized-keys: newline-separated public keys of the
#         Fabro and personal-Mac Linux builder clients.
#       - builder-tailscale-oauth-secret: the Tailscale OAuth client secret
#         used by configurations/linux-builder/default.nix.
#
#   * secrets/linux-builder-client.personal.yaml — the personal Mac's
#     dedicated SSH client key for the Linux builder, encrypted only to
#     `&host_personal` so neither the builder nor Fabro can decrypt it.
#
# Source material (design's `## Operator Provisioning` section):
#   builder age key          op://Private/sops-age-key-linux-builder/notesPlain
#   personal age key         op://Private/sops-age-key-personal/notesPlain
#   authorized public keys   op://Infrastructure/mac-builder authorized keys/notesPlain
#   Tailscale OAuth secret   op://Infrastructure/mac-builder Tailscale OAuth/Client Secret
#   personal client key      op://Infrastructure/Brandons Mac Linux nix remote builder key/private key
#
# Recipient handling: `.sops.yaml` intentionally carries an empty recipient
# list for the builder store because the real `host_linux_builder` public
# key does not exist until the operator provisions the age identity. This
# script derives that recipient from the operator-held private key with
# `age-keygen -y` and passes it to sops with `--age`; a config-only
# encryption therefore fails closed instead of committing a placeholder or
# writing a store that no operator key can decrypt.
#
# Semantics: every value is resolved (and every private key validated)
# before any write, so a missing or invalid input leaves both prior stores
# untouched. Plaintext and encrypted temporary files live in a mode-0700
# directory under secrets/ so the final `mv` is an atomic rename(2) on the
# destination filesystem.
#
# `OP_BIN` is a test seam that lets the fixture suite substitute a mock
# `op`; production runs use the pinned 1Password CLI from runtimeInputs.
#
# Exit codes:
#   0    success
#   1    not inside a git working tree, or invalid invocation
#   2    1Password CLI not authenticated (run `op signin`)
#   3    1Password URI not resolvable or a supplied value is invalid
#   4    sops encryption failed
let
  sopsBin = "${pkgs.sops}/bin/sops";
in
pkgs.writeShellApplication {
  name = "linux-builder-sync-from-1password";
  runtimeInputs = with pkgs; [
    _1password-cli
    age
    coreutils
    git
    gnugrep
    jq
    openssh
    sops
  ];
  text = ''
    case "''${1:-}" in
      ""|--help|-h)
        if [ -n "''${1:-}" ]; then
          cat <<'USAGE'
    linux-builder-sync-from-1password - refresh the Linux builder's encrypted
    secret stores from 1Password.

    Usage:
      linux-builder-sync-from-1password   (no arguments; --help/-h for this text)

    Writes:
      secrets/remote-builder.linux-builder.yaml
      secrets/linux-builder-client.personal.yaml

    It reads the operator-provisioned values named in the design's
    `## Operator Provisioning` section, validates them, and encrypts each
    store atomically. It does not generate, mint, rotate, or print secrets.

    Exit codes:
      0    success
      1    not inside a git working tree / invalid invocation
      2    1Password CLI not authenticated (run `op signin`)
      3    1Password URI not resolvable or a supplied value is invalid
      4    sops encryption failed
    USAGE
          exit 0
        fi
        ;;
      *)
        echo "linux-builder-sync-from-1password: error: takes no arguments (got \"$1\")" >&2
        echo "  run --help for usage" >&2
        exit 1
        ;;
    esac

    if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
      echo "linux-builder-sync-from-1password: error: not inside a git working tree" >&2
      echo "  invoke from within the nix-config repository" >&2
      exit 1
    fi

    OP_BIN="''${OP_BIN:-op}"
    if ! command -v "$OP_BIN" >/dev/null 2>&1; then
      echo "linux-builder-sync-from-1password: error: 1Password CLI not found (OP_BIN=$OP_BIN)" >&2
      exit 1
    fi
    if ! "$OP_BIN" whoami >/dev/null 2>&1; then
      echo "linux-builder-sync-from-1password: error: 1Password CLI not authenticated" >&2
      echo "  run \"op signin\" and retry" >&2
      exit 2
    fi

    DEST_BUILDER_REL="secrets/remote-builder.linux-builder.yaml"
    DEST_PERSONAL_REL="secrets/linux-builder-client.personal.yaml"
    DEST_BUILDER="$REPO_ROOT/$DEST_BUILDER_REL"
    DEST_PERSONAL="$REPO_ROOT/$DEST_PERSONAL_REL"

    BUILDER_AGE_KEY_URI="op://Private/sops-age-key-linux-builder/notesPlain"
    PERSONAL_AGE_KEY_URI="op://Private/sops-age-key-personal/notesPlain"
    AUTHORIZED_KEYS_URI="op://Infrastructure/mac-builder authorized keys/notesPlain"
    TAILSCALE_SECRET_URI="op://Infrastructure/mac-builder Tailscale OAuth/Client Secret"
    PERSONAL_CLIENT_KEY_URI="op://Infrastructure/Brandons Mac Linux nix remote builder key/private key?ssh-format=openssh"

    tmpdir="$(mktemp -d "$REPO_ROOT/secrets/.linux-builder-sync-XXXXXX")"
    chmod 0700 "$tmpdir"
    trap 'rm -rf "$tmpdir"' EXIT
    builder_age_key="$tmpdir/builder-age.key"
    personal_age_key="$tmpdir/personal-age.key"
    builder_plaintext="$tmpdir/remote-builder.linux-builder.yaml"
    personal_plaintext="$tmpdir/linux-builder-client.personal.yaml"

    read_secret() {
      label="$1"
      uri="$2"
      destination="$3"
      if ! "$OP_BIN" read --no-newline "$uri" > "$destination"; then
        echo "linux-builder-sync-from-1password: error: failed to resolve $label" >&2
        echo "  URI: $uri" >&2
        echo "  (item may be missing, field renamed, or vault inaccessible)" >&2
        exit 3
      fi
    }

    read_secret "the Linux builder age key" "$BUILDER_AGE_KEY_URI" "$builder_age_key"
    chmod 0600 "$builder_age_key"
    if ! grep -q '^AGE-SECRET-KEY-' "$builder_age_key"; then
      echo "linux-builder-sync-from-1password: error: the element under" >&2
      echo "  $BUILDER_AGE_KEY_URI is not a well-formed age key file" >&2
      exit 3
    fi
    if ! BUILDER_RECIPIENT="$(age-keygen -y "$builder_age_key" 2>/dev/null)"; then
      echo "linux-builder-sync-from-1password: error: cannot derive the builder recipient" >&2
      echo "  from $BUILDER_AGE_KEY_URI" >&2
      exit 3
    fi
    # Once the operator enrolls the real public recipient in .sops.yaml,
    # the derived recipient must match it. This catches a stale or
    # mismatched age key without printing either value. An absent anchor is
    # the documented pre-provisioning state (see .sops.yaml).
    configured_recipient="$(grep -oE '&host_linux_builder age1[0-9a-z]+' "$REPO_ROOT/.sops.yaml" 2>/dev/null | head -n1 | cut -d' ' -f2 || true)"
    if [[ -n "$configured_recipient" && "$configured_recipient" != "$BUILDER_RECIPIENT" ]]; then
      echo "linux-builder-sync-from-1password: error: the derived builder recipient does not match the host_linux_builder recipient in .sops.yaml" >&2
      echo "  re-check $BUILDER_AGE_KEY_URI and the .sops.yaml anchor" >&2
      exit 3
    fi

    read_secret "the personal host age key" "$PERSONAL_AGE_KEY_URI" "$personal_age_key"
    chmod 0600 "$personal_age_key"
    if ! grep -q '^AGE-SECRET-KEY-' "$personal_age_key"; then
      echo "linux-builder-sync-from-1password: error: the element under" >&2
      echo "  $PERSONAL_AGE_KEY_URI is not a well-formed age key file" >&2
      exit 3
    fi

    authorized_keys_file="$tmpdir/authorized-keys"
    tailscale_secret_file="$tmpdir/tailscale-oauth-secret"
    personal_client_key_file="$tmpdir/personal-client-key"
    read_secret "builder-authorized-keys" "$AUTHORIZED_KEYS_URI" "$authorized_keys_file"
    read_secret "builder-tailscale-oauth-secret" "$TAILSCALE_SECRET_URI" "$tailscale_secret_file"
    read_secret "the personal Linux builder client key" "$PERSONAL_CLIENT_KEY_URI" "$personal_client_key_file"

    # Gather phase: validate every supplied value before writing anything.
    authorized_keys="$(cat "$authorized_keys_file")"
    authorized_keys="''${authorized_keys//$'\r'/}"
    if [[ ! "$authorized_keys" =~ [^[:space:]] ]]; then
      echo "linux-builder-sync-from-1password: error: builder-authorized-keys contains no public keys" >&2
      echo "  URI: $AUTHORIZED_KEYS_URI" >&2
      exit 3
    fi
    if [[ "$authorized_keys" == *"PRIVATE KEY"* ]]; then
      echo "linux-builder-sync-from-1password: error: builder-authorized-keys contains private key material" >&2
      exit 3
    fi
    authorized_count=0
    while IFS= read -r line; do
      line="''${line%$'\r'}"
      [ -n "$line" ] || continue
      read -r key_type key_data _ <<< "$line"
      if [[ ! "$key_type" =~ ^(ssh-|ecdsa-|sk-) || -z "$key_data" ]]; then
        echo "linux-builder-sync-from-1password: error: builder-authorized-keys has an invalid public key line" >&2
        echo "  expected one public key per line" >&2
        exit 3
      fi
      authorized_count=$((authorized_count + 1))
    done <<< "$authorized_keys"
    if [ "$authorized_count" -eq 0 ]; then
      echo "linux-builder-sync-from-1password: error: builder-authorized-keys contains no usable public keys" >&2
      exit 3
    fi

    tailscale_secret="$(cat "$tailscale_secret_file")"
    if [[ -z "$tailscale_secret" || "$tailscale_secret" =~ [[:space:]] ]]; then
      echo "linux-builder-sync-from-1password: error: builder-tailscale-oauth-secret is empty or contains whitespace" >&2
      echo "  URI: $TAILSCALE_SECRET_URI" >&2
      exit 3
    fi

    personal_client_key="$(cat "$personal_client_key_file")"
    personal_client_key="''${personal_client_key//$'\r'/}"
    personal_key_check="$tmpdir/personal-client-check.key"
    printf '%s\n' "$personal_client_key" > "$personal_key_check"
    chmod 0600 "$personal_key_check"
    if [[ "$(head -n 1 "$personal_key_check")" != "-----BEGIN OPENSSH PRIVATE KEY-----" ]] \
      || ! ssh-keygen -y -f "$personal_key_check" >/dev/null 2>&1; then
      echo "linux-builder-sync-from-1password: error: the personal Linux builder client key is not a valid OpenSSH private key" >&2
      echo "  Ensure its 1Password reference includes ?ssh-format=openssh" >&2
      echo "  URI: $PERSONAL_CLIENT_KEY_URI" >&2
      exit 3
    fi
    rm -f "$personal_key_check"

    # Emit the two plaintext YAML documents. JSON string syntax is valid
    # YAML 1.2, so multi-line public/private keys stay on one physical line
    # and round-trip exactly through sops.
    printf '%s' "$authorized_keys" | jq -Rs . > "$tmpdir/authorized-keys.json"
    printf '%s' "$tailscale_secret" | jq -Rs . > "$tmpdir/tailscale-secret.json"
    printf '%s\n' "$personal_client_key" | jq -Rs . > "$tmpdir/personal-client-key.json"
    {
      printf 'builder-authorized-keys: '
      tr -d '\n' < "$tmpdir/authorized-keys.json"
      printf '\nbuilder-tailscale-oauth-secret: '
      tr -d '\n' < "$tmpdir/tailscale-secret.json"
      printf '\n'
    } > "$builder_plaintext"
    {
      printf 'linux-builder-client-key: '
      tr -d '\n' < "$tmpdir/personal-client-key.json"
      printf '\n'
    } > "$personal_plaintext"
    unset authorized_keys tailscale_secret personal_client_key

    # Encrypt both stores to their respective recipients before replacing
    # either destination. The builder recipient is derived from the
    # operator-provisioned age key above; the personal store uses the
    # &host_personal rule in .sops.yaml.
    if ! SOPS_AGE_KEY_FILE="$builder_age_key" ${sopsBin} \
      --config "$REPO_ROOT/.sops.yaml" \
      --filename-override "$DEST_BUILDER_REL" \
      --age "$BUILDER_RECIPIENT" \
      --input-type yaml --output-type yaml --encrypt --in-place "$builder_plaintext"; then
      echo "linux-builder-sync-from-1password: error: sops encryption failed for $DEST_BUILDER_REL" >&2
      exit 4
    fi
    if ! SOPS_AGE_KEY_FILE="$personal_age_key" ${sopsBin} \
      --config "$REPO_ROOT/.sops.yaml" \
      --filename-override "$DEST_PERSONAL_REL" \
      --input-type yaml --output-type yaml --encrypt --in-place "$personal_plaintext"; then
      echo "linux-builder-sync-from-1password: error: sops encryption failed for $DEST_PERSONAL_REL" >&2
      exit 4
    fi

    mv "$builder_plaintext" "$DEST_BUILDER"
    mv "$personal_plaintext" "$DEST_PERSONAL"
    echo "linux-builder-sync-from-1password: wrote $DEST_BUILDER_REL and $DEST_PERSONAL_REL"
    echo "  (builder authorized keys: $authorized_count)"
  '';
}
