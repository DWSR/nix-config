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
# Carry-forward (non-1Password-backed system entries): the sops bridge
# (configurations/common-darwin/mcp-sops-bridge.nix) can declare entries
# in the per-host yaml whose values are NOT managed via
# `home.mcp.keychainSecrets` and therefore have no URI this script can
# `op read`. Because this script REWRITES the yaml from scratch, such
# keys would silently vanish on every sync and the host build would then
# fail sops `validateSopsFiles` checks. The exact set is computed from
# `.#darwinConfigurations.<host>.config.sops` by matching each entry's
# `sopsFile` BASENAME against the destination file name (the per-host
# yaml is unique by the documented `mcp.<host>.yaml` naming; basename
# matching is required because `sops.defaultSopsFile` and per-entry
# `sopsFile` resolve to DIFFERENT store paths, so a full-path equality
# never matches); `gh-token` and the synced keychainSecrets names are
# excluded, and nothing is hard-coded, so new bridge-owned entries are
# picked up automatically. Their values are decrypted from the prior
# file and re-emitted verbatim, passing only through shell memory and
# the encrypted-at-rest tempdir (never argv, logs, or the terminal).
# Keys a sync deliberately removed from `keychainSecrets` do NOT come
# back: their sops declaration lives in the bridge's mapAttrs over that
# same set, so once removed they are no longer candidates and the
# rewrite drops them. On a first bootstrap there is no prior file, so
# the no-carry path is a silent no-op; seeding such an entry still
# happens once outside this script (e.g. `sops` decrypt-restore from a
# previous generation).
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
let
  # Absolute store path for the sudo-decrypted leg: sudo strips PATH, so
  # the same pattern mcp-verify-secrets.nix uses (see sopsBin there) keeps
  # the carry-forward decrypt reachable.
  sopsBin = "${pkgs.sops}/bin/sops";
in
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
      personal)
        HOST="$1"
        ;;
      --help|-h)
        cat <<'USAGE'
    mcp-sync-from-1password - refresh per-host encrypted MCP secrets from 1Password.

    Usage:
      mcp-sync-from-1password <host>

    Arguments:
      host    personal

    Environment:
      MCP_SYNC_USERNAME    Override `id -un` for home-manager user lookup.

    Exit codes:
      0    success
      1    invalid host name (or invocation outside a git working tree)
      2    1Password CLI not authenticated (run `op signin`)
      3    1Password URI not resolvable (item missing or field renamed)
      4    sops encryption failed

    Behavior:
      Replaces secrets/mcp.<host>.yaml with the 1Password-backed entries
      (home.mcp.keychainSecrets + gh-token) plus every SYSTEM-declared
      sops entry in that file the sync does not manage (the bridge-owned
      set; empty today after `mcpproxy-api-key` moved into
      keychainSecrets), so syncs never drop keys other modules declare.
      Entries removed from keychainSecrets stay dropped — carry-forward
      only preserves keys the sync never manages.
    USAGE
        exit 0
        ;;
      *)
        echo "mcp-sync-from-1password: error: expected host \"personal\", got \"''${1:-}\"" >&2
        echo "  run --help for usage" >&2
        exit 1
        ;;
    esac

    case "$HOST" in
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
    # Stderr is routed to a sibling tempfile rather than captured into the
    # JSON variable: `nix eval` emits non-fatal warnings (e.g. "Git tree
    # has uncommitted changes") on stderr, and concatenating those into
    # the JSON would break downstream jq parsing. The tempfile is read
    # only on failure to surface the actual eval error to the operator.
    HM_PATH=".#darwinConfigurations.$DARWIN_HOST.config.home-manager.users.$USERNAME.home.mcp"
    SYS_PATH=".#darwinConfigurations.$DARWIN_HOST.config"
    eval_err="$tmpdir/eval-err"
    if ! KEYCHAIN_JSON="$(nix eval --json "$HM_PATH.keychainSecrets" 2>"$eval_err")"; then
      echo "mcp-sync-from-1password: error: failed to evaluate $HM_PATH.keychainSecrets" >&2
      [ -s "$eval_err" ] && sed 's/^/  /' "$eval_err" >&2
      exit 1
    fi
    if ! GH_URI_JSON="$(nix eval --json "$HM_PATH.ghAuthToken" 2>"$eval_err")"; then
      echo "mcp-sync-from-1password: error: failed to evaluate $HM_PATH.ghAuthToken" >&2
      [ -s "$eval_err" ] && sed 's/^/  /' "$eval_err" >&2
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

    # Bridge-owned set (R-bridge-owned): keys the SYSTEM sops config
    # declares in the yaml FILE this script manages but this script does
    # not manage from 1Password. Empty today (mcpproxy-api-key moved into
    # keychainSecrets — see mcp-sops-bridge.nix); this stays generically
    # computed so future bridge-owned entries are picked up
    # automatically. They share the per-host yaml, so a rewrite from
    # scratch would drop them and the host build would fail sops
    # validateSopsFiles. Match by file
    # BASENAME rather than by store path: `sops.defaultSopsFile` and the
    # per-entry `sopsFile` evaluate to DIFFERENT store paths (the former
    # imports the file standalone, the latter keeps the source-tree copy),
    # so a path equality never matches. The basename is stable and unique
    # per host (`mcp.<host>.yaml`, the documented per-host secrets file
    # naming), and nothing is hard-coded, so new bridge-owned entries are
    # picked up automatically; their values are carried from the prior
    # file below.
    if ! SOPS_SECRETS_JSON="$(nix eval --json "$SYS_PATH.sops.secrets" 2>"$eval_err")"; then
      echo "mcp-sync-from-1password: error: failed to evaluate $SYS_PATH.sops.secrets" >&2
      [ -s "$eval_err" ] && sed 's/^/  /' "$eval_err" >&2
      exit 1
    fi
    DEST_NAME="$(basename "$DEST_REL")"
    synced_space=" ''${SECRET_KEYS[*]} "
    [ "$GH_PRESENT" = true ] && synced_space="''${synced_space} gh-token "
    mapfile -t CARRY_KEYS < <(
      jq -r --arg name "$DEST_NAME" '
        to_entries
        | map(select((.value.sopsFile | split("/")[-1]) == $name) | .key)
        | sort | .[]' <<< "$SOPS_SECRETS_JSON" |
      while IFS= read -r carry_key; do
        case "$carry_key" in
          # gh-token is managed via ghAuthToken, not synced above.
          gh-token) continue ;;
        esac
        case " $synced_space " in
          *" $carry_key "*) continue ;;
        esac
        printf '%s\n' "$carry_key"
      done
    )

    # Carry-forward phase: read the bridge-owned values from the prior
    # file. Values pass only through shell memory and the
    # encrypted-at-rest tempdir (never argv, logs, or the terminal).
    # CARRIED_COUNT guards every associative-array expansion: with `set
    # -u`, bash 5 unbinds the length and key-list expansions of an empty
    # associative array.
    #
    # The decrypt leg needs the host's age PRIVATE key, which the
    # bootstrap installs root-only at /var/lib/sops-nix/key.txt (the
    # operator shell has no sops identity of its own). Same sudo pattern
    # as scripts/mcp-verify-secrets.nix: explicit store-path sops binary
    # plus SOPS_AGE_KEY_FILE; sudo may prompt once.
    declare -A CARRIED
    CARRIED_COUNT=0
    if [ -f "$DEST" ] && [ "''${#CARRY_KEYS[@]}" -gt 0 ]; then
      prior_plaintext="$tmpdir/prior.yaml"
      # Command substitution (not a redirect) keeps SC2024 at bay; the
      # plaintext then lands in the user-owned tempdir file for the
      # harvest loop.
      if ! prior_decrypted="$(sudo SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt ${sopsBin} -d --output-type yaml "$DEST" 2>/dev/null)"; then
        echo "mcp-sync-from-1password: warning: could not decrypt prior $DEST_REL; no entries carried forward" >&2
        echo "  The decrypt runs via sudo with SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt" >&2
        echo "  (same pattern as mcp-verify-secrets). Declining the sudo prompt skips the" >&2
        echo "  carry-forward but the sync of the 1Password-backed entries still proceeds." >&2
      elif [ -z "$prior_decrypted" ]; then
        echo "mcp-sync-from-1password: warning: prior $DEST_REL decrypted empty; no entries carried forward" >&2
      else
        printf '%s\n' "$prior_decrypted" > "$prior_plaintext"
        while IFS= read -r line; do
          # Stop at the sops metadata block; skip comments and blanks.
          case "$line" in
            ""|\#*) continue ;;
            sops:*) break ;;
          esac
          key="''${line%%:*}"
          value_blob="''${line#*: }"
          if [ -z "$key" ] || [ -z "$value_blob" ]; then
            continue
          fi
          case "''${CARRY_KEYS[*]} " in
            *" $key "*) ;;
            *) continue ;;
          esac
          CARRIED[$key]="$value_blob"
          CARRIED_COUNT=$((CARRIED_COUNT + 1))
        done < "$prior_plaintext"
      fi
      if [ "$CARRIED_COUNT" -gt 0 ]; then
        carried_names="$(printf '%s\n' "''${!CARRIED[@]}" | LC_ALL=C sort | tr '\n' ',' | sed 's/,$//')"
        printf 'mcp-sync-from-1password: carried %s entry %s from prior %s\n' \
          "$CARRIED_COUNT" "$carried_names" "$DEST_REL" >&2
      fi
      rm -f "$prior_plaintext"
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
      # Carried entries last: their values are already YAML scalar text
      # straight from the prior file — emit verbatim to preserve escaping.
      if [ "$CARRIED_COUNT" -gt 0 ]; then
        printf '%s\n' "''${!CARRIED[@]}" | LC_ALL=C sort |
          while IFS= read -r carried_key; do
            [ -n "$carried_key" ] || continue
            printf "%s: %s\n" "$carried_key" "''${CARRIED[$carried_key]}"
          done
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
    secret_count=$((secret_count + CARRIED_COUNT))
    echo "mcp-sync-from-1password: wrote $secret_count entries to $DEST_REL"
  '';
}
