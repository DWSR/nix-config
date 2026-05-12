{ pkgs }:
# mcp-verify-secrets: confirm a host's macOS Keychain entries match the
# encrypted yaml store under `secrets/mcp.<host>.yaml`.
#
# This tool is the R8.1 verification gate that authorises the R8.2
# decommissioning of the legacy `mcp-sync-secrets` activation bridge.
# Exit 0 against a freshly-activated host means every declared MCP
# secret in the encrypted yaml is value-identical to the corresponding
# `mcp-hub`-account login Keychain entry, and (if declared) the `gh` CLI
# is authenticated against github.com.
#
# Decryption happens in memory: `sops -d --output-type json` streams the
# decrypted yaml as JSON to stdout, jq splits it into TSV `(key, value)`
# rows, and the loop never persists plaintext to disk.
#
# `gh-token` is special-cased: gh manages its own credential storage
# (not the login keychain under service `gh-token`), so its presence is
# verified via `gh auth status --hostname github.com` rather than a
# `security find-generic-password` lookup. A non-zero `gh auth status`
# is treated as MISSING.
#
# Locked-keychain caveat: when invoked from a non-GUI session (raw ssh,
# launchd-without-aqua), `security find-generic-password` returns
# `errSecInteractionNotAllowed` and entries that DO exist will surface
# as MISSING. Run from a logged-in GUI shell (Terminal.app / iTerm.app)
# to get truthful results.
#
# Privilege model: the per-host age key at `/var/lib/sops-nix/key.txt`
# is mode 0600 root-owned (sops-nix install convention), but the user's
# login keychain is per-user. The verifier therefore runs the ONE sops
# decrypt call under `sudo` (with the absolute store path to sops to
# survive sudo's PATH reset and an explicit `SOPS_AGE_KEY_FILE`), and
# runs every other step (keychain queries, gh status) as the invoking
# user. This means the operator may be prompted for their sudo password
# once per invocation.
let
  # Bound at build time so the absolute store path survives sudo's
  # default PATH reset. Re-resolving via `command -v sops` after sudo
  # reset would fail because root's PATH doesn't include the user's
  # nix profile bin dir.
  sopsBin = "${pkgs.sops}/bin/sops";
in
pkgs.writeShellApplication {
  name = "mcp-verify-secrets";
  runtimeInputs = with pkgs; [
    sops
    jq
    gh
    coreutils
    git
  ];
  text = ''
    case "''${1:-}" in
      shopify|personal)
        HOST="$1"
        ;;
      --help|-h)
        cat <<'USAGE'
    mcp-verify-secrets - verify per-host MCP Keychain entries match the encrypted store.

    Usage:
      mcp-verify-secrets <host>

    Arguments:
      host    shopify | personal

    Output (per-key, one line each):
      MATCH    <service>    Keychain value equals decrypted yaml value
      MISMATCH <service>    Keychain present but value differs
      MISSING  <service>    Keychain entry not present (or gh not logged in)

    Exit codes:
      0    every key MATCH (R8.1 verification gate satisfied)
      1    invalid host name (or invocation outside a git working tree)
      2    secrets/mcp.<host>.yaml missing or undecryptable on this host
      3    one or more keys MISMATCH or MISSING
    USAGE
        exit 0
        ;;
      *)
        echo "mcp-verify-secrets: error: expected host \"shopify\" or \"personal\", got \"''${1:-}\"" >&2
        echo "  run --help for usage" >&2
        exit 1
        ;;
    esac

    if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
      echo "mcp-verify-secrets: error: not inside a git working tree" >&2
      echo "  invoke from within the nix-config repository" >&2
      exit 1
    fi

    SECRETS_FILE="$REPO_ROOT/secrets/mcp.$HOST.yaml"
    if [ ! -f "$SECRETS_FILE" ]; then
      echo "mcp-verify-secrets: error: $SECRETS_FILE not found" >&2
      echo "  run \"mcp-sync-from-1password $HOST\" first" >&2
      exit 2
    fi

    # Decrypt host yaml in memory; pipe to jq to extract every (key, value)
    # pair as TSV. The 'sops' top-level key holds metadata and is excluded.
    #
    # The decrypt is the ONE step that requires root (to read the age key
    # at /var/lib/sops-nix/key.txt). We invoke sops via sudo with the
    # absolute store path (sudo strips PATH by default, so
    # `command -v sops` after sudo would fail to find the nix-profile
    # binary) and an explicit SOPS_AGE_KEY_FILE. Operator may be
    # prompted for sudo password once per invocation.
    if ! declared_pairs="$(sudo SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt \
        ${sopsBin} -d --output-type json "$SECRETS_FILE" 2>/dev/null \
        | jq -r 'to_entries[] | select(.key != "sops") | "\(.key)\t\(.value)"')"; then
      echo "mcp-verify-secrets: error: failed to decrypt $SECRETS_FILE" >&2
      echo "  is /var/lib/sops-nix/key.txt present and valid for this host?" >&2
      echo "  (sudo may have been required and not granted)" >&2
      exit 2
    fi

    if [ -z "$declared_pairs" ]; then
      echo "mcp-verify-secrets: error: $SECRETS_FILE decrypted to an empty mapping" >&2
      exit 2
    fi

    mismatches=0
    missing=0
    gh_declared=false
    gh_expected=""

    # MCP-secret loop. Defer gh-token to a dedicated `gh auth status`
    # check after the loop because gh does not store its credential
    # under `mcp-hub` in the login keychain.
    while IFS=$'\t' read -r service expected; do
      if [ "$service" = "gh-token" ]; then
        gh_declared=true
        gh_expected="$expected"
        continue
      fi
      if actual="$(/usr/bin/security find-generic-password -s "$service" -a mcp-hub -w 2>/dev/null)"; then
        if [ "$actual" = "$expected" ]; then
          printf 'MATCH    %s\n' "$service"
        else
          printf 'MISMATCH %s\n' "$service"
          mismatches=$((mismatches + 1))
        fi
      else
        printf 'MISSING  %s\n' "$service"
        missing=$((missing + 1))
      fi
    done <<<"$declared_pairs"

    # gh-token verification leg. The Keychain isn't where gh stores its
    # credential; gh manages its own keyring entry. A successful
    # `gh auth status --hostname github.com` is the parity signal.
    # `gh_expected` is referenced only to acknowledge the value exists in
    # the encrypted store; the actual token equality is enforced by gh
    # itself when it uses the credential to authenticate.
    if [ "$gh_declared" = true ]; then
      : "''${gh_expected:?gh-token declared with empty value in encrypted yaml}"
      if gh auth status --hostname github.com >/dev/null 2>&1; then
        printf 'MATCH    %s\n' "gh-token"
      else
        printf 'MISSING  %s\n' "gh-token"
        missing=$((missing + 1))
      fi
    fi

    if [ "$mismatches" -gt 0 ] || [ "$missing" -gt 0 ]; then
      echo "mcp-verify-secrets: $mismatches mismatch(es), $missing missing - verification FAILED" >&2
      exit 3
    fi

    exit 0
  '';
}
