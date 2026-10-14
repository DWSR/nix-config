{ pkgs }:
# fabro-sync-from-1password: refresh the fabro host's encrypted secret
# store (secrets/fabro.fabro.yaml) from 1Password.
#
# Sibling of scripts/mcp-sync-from-1password.nix with the three
# differences the fabro NixOS guest forces:
#
#   1. The source manifest is the guest config's
#      `fabro.onePasswordSecrets` map (configurations/fabro-vm/default.nix:
#      sops secret name -> `op://…` URI), read from
#      `.#nixosConfigurations.fabro-vm` instead of a darwinConfiguration's
#      `home.mcp` namespace (the guest runs no home-manager).
#   2. The guest's age PRIVATE key is not on the mac: /var/lib/sops-nix/
#      key.txt here is the PERSONAL host key and cannot open this store.
#      The script pulls the fabro host key from the 1Password stash
#      (op://Private/sops-age-key-fabro/notesPlain) into a mode-0600 file
#      inside an encrypted-at-rest tempdir for both the carry-forward
#      decrypt and the recipient addressing (see secrets/README.md,
#      "Fabro host store (NixOS guest)" — same credential the manual edit
#      flow uses).
#   3. No sudo leg: the key arrives from 1Password, not from
#      /var/lib/sops-nix/key.txt.
#
# Semantics mirrored from mcp-sync-from-1password (see its header for the
# full rationale): every value is fetched via `op read --no-newline`
# BEFORE any write (gather-then-commit), keys are sorted for idempotent
# re-encryption, sops-declared-but-not-1Password-backed keys are carried
# forward verbatim from the prior store (matched by sopsFile basename,
# never hard-coded), the plaintext and encrypted temp file live in a
# tempdir under secrets/ so the final `mv` is an atomic rename(2), and
# `--filename-override` makes sops apply the secrets/fabro\.fabro\.yaml$
# creation rule even though the tempfile lives in a sibling hidden dir.
# One hardening over the sibling: a sync that would DROP a key declared
# in sops.secrets (not in the manifest and not carried) aborts with a
# listed diff instead of proceeding — a dropped key fails the guest's
# next `nixos-rebuild switch` at the sops activation step, so saying no
# up front beats breaking the switch later.
#
# Token shape assumption: values are single-line printable strings,
# emitted as YAML 1.2 single-quoted scalars with embedded `'` doubled.
# Multi-line values (e.g. the opencode SSH signing key) are emitted as
# YAML double-quoted scalars instead, with backslashes, double quotes,
# and newlines escaped (`\\`, `\"`, `\n`), so every key stays on one
# physical line — the line-based carry-forward parser and the coverage
# gate below stay valid verbatim. NUL bytes remain unsupported.
#
# Exit codes:
#   0    success
#   1    not inside a git working tree, or flake evaluation failed
#   2    1Password CLI not authenticated (run `op signin`)
#   3    1Password URI not resolvable (key stash or a manifest entry;
#        item missing, field renamed, or vault inaccessible)
#   4    sops decryption or encryption failed
#   5    declared-secret coverage gap: a sops.secrets key would be
#        dropped (not manifest-mapped, not carried from the prior store)
let
  sopsBin = "${pkgs.sops}/bin/sops";
in
pkgs.writeShellApplication {
  name = "fabro-sync-from-1password";
  runtimeInputs = with pkgs; [
    _1password-cli
    sops
    coreutils
    nix
    jq
    gnugrep
    git
  ];
  text = ''
    case "''${1:-}" in
      ""|--help|-h)
        if [ -n "''${1:-}" ]; then
          cat <<'USAGE'
    fabro-sync-from-1password - refresh the fabro host's encrypted secret
    store (secrets/fabro.fabro.yaml) from 1Password.

    Usage:
      fabro-sync-from-1password   (no arguments; --help/-h for this text)

    The secret name -> 1Password URI manifest lives in the guest config
    (fabro.onePasswordSecrets, configurations/fabro-vm/default.nix) and
    is read via `nix eval` from the working tree, so manifest edits take
    effect without rebuilding anything.

    Exit codes:
      0    success
      1    not inside a git working tree / flake evaluation failed
      2    1Password CLI not authenticated (run `op signin`)
      3    1Password URI not resolvable
      4    sops decryption or encryption failed
      5    a sops-declared key would be dropped by this sync
    USAGE
          exit 0
        fi
        ;;
      *)
        echo "fabro-sync-from-1password: error: takes no arguments (got \"$1\")" >&2
        echo "  run --help for usage" >&2
        exit 1
        ;;
    esac

    if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
      echo "fabro-sync-from-1password: error: not inside a git working tree" >&2
      echo "  invoke from within the fabro-lima-vm repository" >&2
      exit 1
    fi
    DEST_REL="secrets/fabro.fabro.yaml"
    DEST="$REPO_ROOT/$DEST_REL"

    # Pre-flight: confirm an authenticated 1Password session before any
    # evaluation or key fetch, so an `op signin` reminder comes first.
    if ! op whoami >/dev/null 2>&1; then
      echo "fabro-sync-from-1password: error: 1Password CLI not authenticated" >&2
      echo "  run \"op signin\" and retry" >&2
      exit 2
    fi

    # The fabro host's age private key — the credential that owns this
    # store. Fetched from the 1Password stash into the tempdir below,
    # never to argv/logs/terminal. URI documented in secrets/README.md.
    KEY_URI="op://Private/sops-age-key-fabro/notesPlain"

    tmpdir="$(mktemp -d "$REPO_ROOT/secrets/.sync-XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    age_key="$tmpdir/age.key"
    tmpfile="$tmpdir/fabro.fabro.yaml"
    if ! op read --no-newline "$KEY_URI" > "$age_key"; then
      echo "fabro-sync-from-1password: error: failed to resolve the host age key" >&2
      echo "  URI: $KEY_URI" >&2
      echo "  (item missing, vault renamed, or note emptied)" >&2
      exit 3
    fi
    chmod 0600 "$age_key"
    if ! grep -q '^AGE-SECRET-KEY-' "$age_key"; then
      echo "fabro-sync-from-1password: error: the 1Password element under" >&2
      echo "  $KEY_URI is not a well-formed age key file" >&2
      exit 3
    fi
    export SOPS_AGE_KEY_FILE="$age_key"

    # Read the manifest (sops secret name -> 1Password URI) and the
    # declared sops.secrets set from the guest configuration in the
    # working tree — the same `fabro.onePasswordSecrets` map the config
    # comment describes. Stderr routes to a sibling file so nix's
    # non-fatal warnings (dirty-tree notice) never corrupt the JSON.
    eval_err="$tmpdir/eval-err"
    if ! MANIFEST_JSON="$(nix eval --json "$REPO_ROOT#nixosConfigurations.fabro-vm.config.fabro.onePasswordSecrets" 2>"$eval_err")"; then
      echo "fabro-sync-from-1password: error: failed to evaluate fabro.onePasswordSecrets" >&2
      [ -s "$eval_err" ] && sed 's/^/  /' "$eval_err" >&2
      exit 1
    fi
    if ! SOPS_SECRETS_JSON="$(nix eval --json "$REPO_ROOT#nixosConfigurations.fabro-vm.config.sops.secrets" 2>"$eval_err")"; then
      echo "fabro-sync-from-1password: error: failed to evaluate sops.secrets" >&2
      [ -s "$eval_err" ] && sed 's/^/  /' "$eval_err" >&2
      exit 1
    fi

    # Sort manifest keys for deterministic yaml line order — idempotent
    # re-encryption between successive syncs of unchanged values.
    mapfile -t SECRET_KEYS < <(printf '%s\n' "$MANIFEST_JSON" | jq -r 'keys_unsorted | sort | .[]')

    # Gather phase: resolve EVERY URI before writing anything. Aborting
    # on the first failure leaves the prior $DEST untouched.
    declare -A VALUES
    for key in "''${SECRET_KEYS[@]}"; do
      uri="$(printf '%s\n' "$MANIFEST_JSON" | jq -r --arg k "$key" '.[$k]')"
      if ! value="$(op read --no-newline "$uri" 2>/dev/null)"; then
        echo "fabro-sync-from-1password: error: failed to resolve 1Password URI for \"$key\"" >&2
        echo "  URI: $uri" >&2
        echo "  (item may be missing, field renamed, or vault inaccessible)" >&2
        exit 3
      fi
      VALUES["$key"]="$value"
    done

    # Carry-forward set: sops-declared keys in this store that the
    # manifest does not manage. Matched by sopsFile BASENAME (the store
    # is the guest's single sops file via sops.defaultSopsFile); nothing
    # is hard-coded, so future config-only keys are picked up
    # automatically. Their values are decrypted from the prior store and
    # re-emitted verbatim.
    DEST_NAME="$(basename "$DEST_REL")"
    synced_space=" ''${SECRET_KEYS[*]} "
    mapfile -t CARRY_KEYS < <(
      jq -r --arg name "$DEST_NAME" '
        to_entries
        | map(select((.value.sopsFile | split("/")[-1]) == $name) | .key)
        | sort | .[]' <<< "$SOPS_SECRETS_JSON" |
      while IFS= read -r carry_key; do
        case " $synced_space " in
          *" $carry_key "*) continue ;;
        esac
        printf '%s\n' "$carry_key"
      done
    )

    # Decrypt + harvest the carried values. Values pass only through
    # shell memory and the encrypted-at-rest tempdir. CARRIED_COUNT
    # guards every associative-array expansion: with `set -u`, bash 5
    # unbinds the length and key-list expansions of an empty associative
    # array.
    declare -A CARRIED
    CARRIED_COUNT=0
    if [ -f "$DEST" ] && [ "''${#CARRY_KEYS[@]}" -gt 0 ]; then
      prior_plaintext="$tmpdir/prior.yaml"
      if ! prior_decrypted="$(${sopsBin} -d --output-type yaml "$DEST" 2>/dev/null)"; then
        echo "fabro-sync-from-1password: error: could not decrypt prior $DEST_REL" >&2
        echo "  SOPS_AGE_KEY_FILE was fetched from $KEY_URI; if the note holds a" >&2
        echo "  rotated-out key, re-stash the live one (see secrets/README.md)" >&2
        exit 4
      elif [ -z "$prior_decrypted" ]; then
        echo "fabro-sync-from-1password: warning: prior $DEST_REL decrypted empty" >&2
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
        rm -f "$prior_plaintext"
      fi
    fi

    # Coverage gate (exit 5): every declared key in this store must be
    # either manifest-synced or carried — otherwise this rewrite would
    # DROP it and the guest's next switch fails at sops activation.
    DROPPED="$(jq -r --arg name "$DEST_NAME" --argjson synced "$(printf '%s\n' "$MANIFEST_JSON" | jq -c 'keys')" '
      to_entries
      | map(select((.value.sopsFile | split("/")[-1]) == $name) | .key)
      | map(select(. as $k | $synced | index($k) | not))
      | .[]' <<< "$SOPS_SECRETS_JSON")"
    dropped_missing=""
    while IFS= read -r dropped_key; do
      [ -n "$dropped_key" ] || continue
      case " ''${CARRIED[*]} " in
        *" $dropped_key "*) ;;
        *) dropped_missing="''${dropped_missing:+$dropped_missing, }$dropped_key" ;;
      esac
    done <<< "$DROPPED"
    if [ -n "$dropped_missing" ]; then
      echo "fabro-sync-from-1password: error: this sync would drop declared secret(s): $dropped_missing" >&2
      echo "  Each is declared in sops.secrets for $DEST_REL but has no" >&2
      echo "  fabro.onePasswordSecrets URI and no prior-store value to carry." >&2
      echo "  Add a manifest entry, or seed the value once via the manual" >&2
      echo "  sops edit flow in secrets/README.md, then retry." >&2
      exit 5
    fi

    # Emit plaintext yaml: manifest keys sorted; single-line values as
    # single-quoted scalars with embedded `'` doubled, multi-line values
    # as double-quoted scalars (escape order: backslash, quote, newline)
    # so every key stays on one physical line. Carried entries are
    # emitted verbatim (they preserve the prior file's escaping).
    {
      for key in "''${SECRET_KEYS[@]}"; do
        v="''${VALUES[$key]}"
        if [[ "$v" == *$'\n'* ]]; then
          v_escaped="''${v//\\/\\\\}"
          v_escaped="''${v_escaped//\"/\\\"}"
          v_escaped="''${v_escaped//$'\n'/\\n}"
          printf '%s: "%s"\n' "$key" "$v_escaped"
        else
          v_escaped="''${v//\'/\'\'}"
          printf "%s: '%s'\n" "$key" "$v_escaped"
        fi
      done
      if [ "$CARRIED_COUNT" -gt 0 ]; then
        printf '%s\n' "''${!CARRIED[@]}" | LC_ALL=C sort |
          while IFS= read -r carried_key; do
            [ -n "$carried_key" ] || continue
            printf "%s: %s\n" "$carried_key" "''${CARRIED[$carried_key]}"
          done
      fi
    } > "$tmpfile"

    # Encrypt the tempfile against the .sops.yaml creation_rule for
    # $DEST_REL (`--filename-override` bridges the sibling-hidden-dir
    # location to the secrets/fabro\.fabro\.yaml$ path_regex).
    if ! sops \
        --config "$REPO_ROOT/.sops.yaml" \
        --filename-override "$DEST_REL" \
        --input-type yaml --output-type yaml \
        --encrypt --in-place "$tmpfile"; then
      echo "fabro-sync-from-1password: error: sops encryption failed" >&2
      exit 4
    fi

    # Atomic move within the same filesystem: rename(2) replaces the
    # prior store in one syscall; readers never see a torn write.
    mv "$tmpfile" "$DEST"

    echo "fabro-sync-from-1password: wrote $(( ''${#SECRET_KEYS[@]} + CARRIED_COUNT )) entries to $DEST_REL"
    echo "  (synced from 1Password: ''${#SECRET_KEYS[@]}, carried from prior store: $CARRIED_COUNT)"
  '';
}
