{ pkgs }:
# mcp-sync-from-1password: refresh a host's encrypted MCP secrets store
# from 1Password.
#
# Reads `home.mcp.keychainSecrets` and `home.mcp.ghAuthToken` from the
# host's `darwinConfiguration` via `nix eval`, fetches each value via
# `op read --no-newline`, builds a flat plaintext YAML mapping, encrypts
# it via sops against the matching `.sops.yaml` `creation_rule`, and
# atomically replaces the host's encrypted yaml in the repo working
# tree.
#
# Atomicity (R4.5): every `op read` and the sops encrypt happen in a
# tempdir on the same filesystem as the destination. Any failure aborts
# before the final `mv`, leaving the prior encrypted store untouched.
#
# Per-host scoping: `--filename-override` makes sops apply the
# `path_regex` rule for the destination path even though the tempfile
# lives in a sibling hidden dir. Without it, sops would not find a
# matching `creation_rule` and the encrypt would fail with "no rule".
#
# Token shape assumption: declared values must be single-line printable
# strings. Each value is emitted as a YAML 1.2 single-quoted scalar with
# embedded `'` doubled, which safely escapes arbitrary `:`, `#`, leading
# whitespace, and embedded single quotes within a single line.
# Multi-line or NUL-byte values are NOT supported and would require pipe
# block scalar (`|-`) form; the current MCP token shapes are all
# single-line bearer strings.
#
# Username: derived from `id -un` by default. Override via the
# `MCP_SYNC_USERNAME` env var when running from an account that doesn't
# match the configured home-manager user.
pkgs.writeShellApplication {
  name = "mcp-sync-from-1password";
  runtimeInputs = with pkgs; [
    _1password-cli
    sops
    coreutils
    nix
    jq
    git
  ];
  text = ''
    case "''${1:-}" in
      shopify|personal)
        HOST="$1"
        ;;
      --help|-h)
        cat <<'USAGE'
    mcp-sync-from-1password - refresh per-host encrypted MCP secrets from 1Password.

    Usage:
      mcp-sync-from-1password <host>

    Arguments:
      host    shopify | personal

    Environment:
      MCP_SYNC_USERNAME    Override `id -un` for home-manager user lookup.

    Exit codes:
      0    success
      1    invalid host name (or invocation outside a git working tree)
      2    1Password CLI not authenticated (run `op signin`)
      3    1Password URI not resolvable (item missing or field renamed)
      4    sops encryption failed
    USAGE
        exit 0
        ;;
      *)
        echo "mcp-sync-from-1password: error: expected host \"shopify\" or \"personal\", got \"''${1:-}\"" >&2
        echo "  run --help for usage" >&2
        exit 1
        ;;
    esac

    case "$HOST" in
      shopify)  DARWIN_HOST="ShopifyLaptop" ;;
      personal) DARWIN_HOST="Brandons-MacBook-Pro" ;;
    esac

    # Pre-flight: confirm authenticated 1P session (R4.2).
    if ! op whoami >/dev/null 2>&1; then
      echo "mcp-sync-from-1password: error: 1Password CLI not authenticated" >&2
      echo "  1Password authentication required; run \"op signin\"" >&2
      exit 2
    fi

    if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
      echo "mcp-sync-from-1password: error: not inside a git working tree" >&2
      echo "  invoke from within the nix-config repository" >&2
      exit 1
    fi

    USERNAME="''${MCP_SYNC_USERNAME:-$(id -un)}"
    SECRETS_DIR="$REPO_ROOT/secrets"
    DEST_REL="secrets/mcp.$HOST.yaml"
    DEST="$REPO_ROOT/$DEST_REL"

    if [ ! -d "$SECRETS_DIR" ]; then
      echo "mcp-sync-from-1password: error: $SECRETS_DIR does not exist" >&2
      exit 1
    fi

    # Tempdir lives inside $SECRETS_DIR so the final `mv` is a rename
    # within a single filesystem (atomic per POSIX rename(2)). Cleanup
    # on every exit path; trap is set immediately after creation so the
    # leak window is one statement wide.
    tmpdir="$(mktemp -d "$SECRETS_DIR/.sync-XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    tmpfile="$tmpdir/mcp.$HOST.yaml"

    # Read declared secret list from the host's darwinConfiguration.
    HM_PATH=".#darwinConfigurations.$DARWIN_HOST.config.home-manager.users.$USERNAME.home.mcp"
    if ! KEYCHAIN_JSON="$(nix eval --json "$HM_PATH.keychainSecrets" 2>&1)"; then
      echo "mcp-sync-from-1password: error: failed to evaluate $HM_PATH.keychainSecrets" >&2
      printf '  %s\n' "$KEYCHAIN_JSON" >&2
      exit 1
    fi
    if ! GH_URI_JSON="$(nix eval --json "$HM_PATH.ghAuthToken" 2>&1)"; then
      echo "mcp-sync-from-1password: error: failed to evaluate $HM_PATH.ghAuthToken" >&2
      printf '  %s\n' "$GH_URI_JSON" >&2
      exit 1
    fi

    # Sort keys for deterministic yaml line order — supports R4.4
    # value-level idempotence between successive syncs.
    mapfile -t SECRET_KEYS < <(printf '%s\n' "$KEYCHAIN_JSON" | jq -r 'keys_unsorted | sort | .[]')

    # Gather phase: resolve EVERY declared URI before writing anything
    # to disk. Aborting on the first failure leaves the prior $DEST
    # untouched (R4.3, R4.5).
    declare -A VALUES
    for key in "''${SECRET_KEYS[@]}"; do
      uri="$(printf '%s\n' "$KEYCHAIN_JSON" | jq -r --arg k "$key" '.[$k]')"
      if ! value="$(op read --no-newline "$uri" 2>/dev/null)"; then
        echo "mcp-sync-from-1password: error: failed to resolve 1Password URI for \"$key\"" >&2
        echo "  URI: $uri" >&2
        echo "  (item may be missing, field renamed, or vault inaccessible)" >&2
        exit 3
      fi
      VALUES["$key"]="$value"
    done

    GH_PRESENT=false
    GH_VALUE=""
    if [ "$GH_URI_JSON" != "null" ]; then
      GH_URI="$(printf '%s\n' "$GH_URI_JSON" | jq -r '.')"
      if ! GH_VALUE="$(op read --no-newline "$GH_URI" 2>/dev/null)"; then
        echo "mcp-sync-from-1password: error: failed to resolve 1Password URI for \"gh-token\"" >&2
        echo "  URI: $GH_URI" >&2
        echo "  (item may be missing, field renamed, or vault inaccessible)" >&2
        exit 3
      fi
      GH_PRESENT=true
    fi

    # Emit plaintext yaml. Each value is a single-quoted YAML scalar
    # with embedded single quotes doubled (YAML 1.2 single-quote-style
    # escape). Keys are unquoted plain scalars — safe for the existing
    # `mcp-<name>` and `gh-token` shapes (alphanumeric + hyphens).
    {
      for key in "''${SECRET_KEYS[@]}"; do
        v="''${VALUES[$key]}"
        v_escaped="''${v//\'/\'\'}"
        printf "%s: '%s'\n" "$key" "$v_escaped"
      done
      if [ "$GH_PRESENT" = true ]; then
        v_escaped="''${GH_VALUE//\'/\'\'}"
        printf "gh-token: '%s'\n" "$v_escaped"
      fi
    } > "$tmpfile"

    # Encrypt against the .sops.yaml creation_rule for $DEST_REL.
    # `--filename-override` makes sops match the path_regex against the
    # destination path even though the tempfile lives in a sibling
    # hidden dir. `--config` pins the rules file to avoid any recursive
    # search picking up an unrelated .sops.yaml.
    if ! sops \
        --config "$REPO_ROOT/.sops.yaml" \
        --filename-override "$DEST_REL" \
        --input-type yaml --output-type yaml \
        --encrypt --in-place "$tmpfile"; then
      echo "mcp-sync-from-1password: error: sops encryption failed" >&2
      exit 4
    fi

    # Atomic move within the same filesystem: rename(2) replaces the
    # prior $DEST in a single syscall. Concurrent readers see either
    # the old or the new file, never a torn write (R4.5).
    mv "$tmpfile" "$DEST"

    secret_count="''${#SECRET_KEYS[@]}"
    if [ "$GH_PRESENT" = true ]; then
      secret_count=$((secret_count + 1))
    fi
    echo "mcp-sync-from-1password: wrote $secret_count entries to $DEST_REL"
  '';
}
