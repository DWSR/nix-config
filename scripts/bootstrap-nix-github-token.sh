#!/bin/sh
# bootstrap-nix-github-token: seed /etc/nix/nix.conf.d/github-access-token.conf
# from 1Password, WITHOUT requiring a working Nix install.
#
# Why this exists
# ---------------
# The sops bridge (configurations/common-darwin/mcp-sops-bridge.nix +
# scripts/mcp-secrets-activate.nix) maintains this file on every
# `darwin-rebuild switch`. But that path requires Nix to already be
# installed AND the host's sops age key to be in place at
# /var/lib/sops-nix/key.txt. On a brand-new machine you may need a GitHub
# access token for Nix BEFORE either of those exists -- e.g. to let the
# very first `darwin-rebuild switch` fetch private `github:` flake inputs.
# This script closes that gap using only the 1Password CLI and base macOS
# tools.
#
# It writes the same file, with the same `access-tokens = github.com=<token>`
# line, that the sops bridge later manages, so the first post-bootstrap
# switch is a content no-op (it only re-asserts owner/mode).
#
# Dependencies: `op` (1Password CLI) + base macOS tools (sudo, mktemp,
# install, id, printf). It does NOT use nix, jq, git, or the repo flake,
# so it runs on a freshly-imaged host before any of those are configured.
#
# Usage:
#   ./scripts/bootstrap-nix-github-token.sh personal
#
# See secrets/README.md ("Nix GitHub access token") for the surrounding
# bootstrap flow, including how to feed the token to the very first switch
# that itself needs private inputs (NIX_CONFIG one-liner).
set -eu

PROG="bootstrap-nix-github-token"
NIX_CONF_D="/etc/nix/nix.conf.d"
NIX_TOKEN_FILE="$NIX_CONF_D/github-access-token.conf"

usage() {
  cat <<USAGE
$PROG - seed $NIX_TOKEN_FILE from 1Password (no Nix required).

Usage:
  $PROG personal

Arguments:
  personal   reuse op://Private/GitHub/Tokens/Full Control

Environment:
  OP_GITHUB_TOKEN_URI   override the 1Password secret reference to read

Exit codes:
  0  success
  1  bad/missing host argument (or refusing to own the file as root)
  2  1Password CLI missing or not authenticated
  3  empty/failed token read from 1Password
  4  failed to write $NIX_TOKEN_FILE
USAGE
}

case "${1:-}" in
  personal)
    OP_URI="op://Private/GitHub/Tokens/Full Control"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  "")
    echo "$PROG: error: missing host argument (personal)" >&2
    usage >&2
    exit 1
    ;;
  *)
    echo "$PROG: error: unknown host \"$1\" (expected personal)" >&2
    exit 1
    ;;
esac

# Allow an explicit override of the secret reference (e.g. a distinct
# Nix-scoped PAT) without editing this script.
OP_URI="${OP_GITHUB_TOKEN_URI:-$OP_URI}"

if ! command -v op >/dev/null 2>&1; then
  echo "$PROG: error: 1Password CLI (op) not found on PATH" >&2
  echo "  install it (e.g. \`brew install 1password-cli\`), then run \`op signin\`" >&2
  exit 2
fi

if ! op whoami >/dev/null 2>&1; then
  echo "$PROG: error: 1Password CLI is not authenticated; run \`op signin\`" >&2
  exit 2
fi

# Owner of the rendered file: the human login user, NOT root. Nix reads
# access-tokens in the user's client process during flake-input
# evaluation, so the user must be able to read the file; the root
# nix-daemon can still read a user-owned 0600 file via superuser. When
# invoked under sudo, honour the calling user.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$TARGET_USER" = "root" ]; then
  echo "$PROG: error: refusing to own $NIX_TOKEN_FILE as root" >&2
  echo "  run as your login user (Nix reads this token as you, not root)" >&2
  exit 1
fi

# Restrict perms on the tempfile from creation; the secret never exists
# on disk group/world-readable, even briefly.
umask 077
tmp="$(mktemp "${TMPDIR:-/tmp}/$PROG.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

if ! token="$(op read --no-newline "$OP_URI")"; then
  echo "$PROG: error: failed to read token from 1Password reference:" >&2
  echo "  $OP_URI" >&2
  exit 3
fi
if [ -z "$token" ]; then
  echo "$PROG: error: 1Password returned an empty token for:" >&2
  echo "  $OP_URI" >&2
  exit 3
fi

{
  printf '%s\n' "# Seeded by $PROG from 1Password ($OP_URI)."
  printf '%s\n' "# Subsequently managed by the sops bridge on each darwin-rebuild switch."
  printf 'access-tokens = github.com=%s\n' "$token"
} >"$tmp"
unset token

# Create the dir root-owned (standard for /etc), then install the token
# file owned by the human user at mode 0600.
if ! sudo /usr/bin/install -d -m 0755 -o root -g wheel "$NIX_CONF_D"; then
  echo "$PROG: error: failed to create $NIX_CONF_D" >&2
  exit 4
fi
if ! sudo /usr/bin/install -m 0600 -o "$TARGET_USER" -g staff "$tmp" "$NIX_TOKEN_FILE"; then
  echo "$PROG: error: failed to write $NIX_TOKEN_FILE" >&2
  exit 4
fi

echo "$PROG: wrote $NIX_TOKEN_FILE (owner $TARGET_USER, mode 0600)"
echo "$PROG: nix.conf reads it once the nix-config sops bridge is active"
echo "  (it adds \`!include $NIX_TOKEN_FILE\` when home.mcp.nixAccessTokenSecret is set)."
