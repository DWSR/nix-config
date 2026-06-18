#!/usr/bin/env bash
#
# deskflow-generate-cert.sh
#
# Generate a 4096-bit self-signed TLS identity certificate for Deskflow on the
# host this script is run on, encrypt it for that host's sops-nix age recipient,
# commit the encrypted secret, and print the certificate's SHA-256 fingerprint.
#
# Why: Deskflow trusts peers by CERTIFICATE FINGERPRINT, not a CA chain. Each
# host has ONE long-lived self-signed identity cert -- the certificate and its
# private key concatenated into a single PEM, which is exactly what Deskflow's
# `security/certificate` setting expects. The private key is sensitive, so it is
# only ever stored as a sops-encrypted blob (never plaintext in git or the Nix
# store). Other hosts never need the key; they only need the PUBLIC fingerprint,
# which this script prints for pasting into their
# `home.deskflow.tls.trustedFingerprints`.
#
# Run this ON the host whose role you pass (e.g. `personal` on
# Brandons-MacBook-Pro, `shopify` on ShopifyLaptop), from a checkout of the
# nix-config repo (it is intentionally a standalone script, not run from inside
# the opencode sandbox):
#
#     bash scripts/deskflow-generate-cert.sh shopify          # generate (refuses to clobber)
#     bash scripts/deskflow-generate-cert.sh shopify --force  # ROTATE (replaces the identity)
#
# Requires openssl, sops, and git on PATH, e.g.:
#     nix shell nixpkgs#openssl nixpkgs#sops -c bash scripts/deskflow-generate-cert.sh shopify
#
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage: deskflow-generate-cert.sh <host-role> [--force]

  <host-role>  the sops-nix host role this cert belongs to (e.g. personal,
               shopify). Must match an `&host_<role>` age recipient anchor in
               .sops.yaml and the per-host darwinConfiguration. Run this script
               ON that host.
  --force      ROTATE an existing identity: changes the fingerprint and breaks
               trust on every peer until each one is updated.
EOF
}

# --- Configuration ----------------------------------------------------------
KEY_BITS=4096
CERT_DAYS=3650 # ~10 years; a self-signed identity, rotate deliberately
CERT_CN="Deskflow"

# --- Argument parsing -------------------------------------------------------
# The host role is required (no default) so the script can never silently
# generate a cert for the wrong host. It selects the secret path, the .sops.yaml
# creation rule, and the recipient anchor used below.
HOST_ROLE=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
  --force) FORCE=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  -*)
    usage
    die "unknown flag: $arg"
    ;;
  *)
    [ -z "$HOST_ROLE" ] || {
      usage
      die "unexpected extra argument: $arg"
    }
    HOST_ROLE="$arg"
    ;;
  esac
done
[ -n "$HOST_ROLE" ] || {
  usage
  die "missing required <host-role> argument"
}

SECRET_REL="secrets/deskflow-cert.${HOST_ROLE}.yaml"

# --- Preconditions ----------------------------------------------------------
command -v openssl >/dev/null 2>&1 || die "openssl not found (try: nix shell nixpkgs#openssl)"
command -v sops    >/dev/null 2>&1 || die "sops not found (try: nix shell nixpkgs#sops)"
command -v git     >/dev/null 2>&1 || die "git not found"

# Locate the repo root from the script's own location so the current working
# directory does not matter (the personal host checkout lives at a different
# path than other hosts).
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel) || die "not inside a git work tree"
cd "$repo_root"

sops_config="$repo_root/.sops.yaml"
[ -f "$sops_config" ] || die ".sops.yaml not found at repo root ($repo_root)"

secret_path="$repo_root/$SECRET_REL"
if [ -e "$secret_path" ] && [ "$FORCE" -ne 1 ]; then
  die "$SECRET_REL already exists. Re-run with --force to ROTATE -- this changes the fingerprint and breaks trust on every peer until they are updated."
fi

# Confirm this host's age-recipient anchor exists in .sops.yaml. We do NOT pass
# `--age`; encryption goes through the repo's .sops.yaml creation rule (added
# below) so the recipient is resolved from the `&host_<role>` anchor. Relying on
# the rule (rather than --age) is what makes path-based matching work and avoids
# the "no matching creation rules found" failure.
grep -qE "&host_${HOST_ROLE}([[:space:]]|\$)" "$sops_config" || die "no '&host_${HOST_ROLE}' age anchor in .sops.yaml"

printf 'Host role:       %s\n' "$HOST_ROLE"
printf 'Secret file:     %s\n' "$SECRET_REL"
printf 'Key / validity:  %s-bit RSA, %s days\n\n' "$KEY_BITS" "$CERT_DAYS"

# --- Generate the certificate + key (single PEM, Deskflow's layout) ---------
umask 077
tmp=$(mktemp -d)
# Cleanup: always drop the temp dir. If we exit before the secret is encrypted,
# restore a pre-existing secret (rotation) or remove the partially-written
# plaintext so a private key can never be left behind or committed.
encrypted=0
secret_backup=""
trap '
  rm -rf "$tmp"
  if [ "$encrypted" != 1 ]; then
    if [ -n "$secret_backup" ]; then mv -f "$secret_backup" "$secret_path"; else rm -f "$secret_path"; fi
  fi
' EXIT

openssl req -x509 -newkey "rsa:${KEY_BITS}" -nodes -sha256 \
  -days "$CERT_DAYS" -subj "/CN=${CERT_CN}" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem"

# Deskflow loads BOTH the certificate and the private key from the one file
# named by `security/certificate`. Concatenate certificate then key.
cat "$tmp/cert.pem" "$tmp/key.pem" > "$tmp/deskflow.pem"

# --- Fingerprint (SHA-256 of the DER cert == Deskflow's trust fingerprint) --
fp_hex=$(openssl x509 -in "$tmp/cert.pem" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')
[ "${#fp_hex}" -eq 64 ] || die "unexpected fingerprint length (${#fp_hex}); expected 64 hex chars"

# --- Ensure a .sops.yaml creation rule exists (idempotent) ------------------
# Needed so `sops updatekeys` / future edits re-encrypt to the right recipient.
if ! grep -qE "deskflow-cert\\.${HOST_ROLE}\\.yaml" "$sops_config"; then
  # Guarantee the file ends with a newline before appending a new list item.
  [ -z "$(tail -c1 "$sops_config")" ] || printf '\n' >> "$sops_config"
  cat >> "$sops_config" <<EOF
  - path_regex: secrets/deskflow-cert\\.${HOST_ROLE}\\.yaml\$
    key_groups:
      - age:
          - *host_${HOST_ROLE}
EOF
  printf 'Added .sops.yaml creation rule for %s\n' "$SECRET_REL"
fi

# --- Encrypt AT the target path so sops matches the .sops.yaml rule ---------
# sops selects the creation rule (hence the recipient) by the PATH it is asked
# to encrypt. A temp path outside secrets/ matches no rule and fails with
# "no matching creation rules found", so the file must be at its real location.
# Write the plaintext PEM there, encrypt it to a temp envelope, then move that
# back over it. The trap above guards the brief plaintext window.
mkdir -p "$(dirname "$secret_path")"
[ -e "$secret_path" ] && { secret_backup="$tmp/secret.bak"; cp "$secret_path" "$secret_backup"; }
install -m 600 "$tmp/deskflow.pem" "$secret_path"
sops --encrypt --input-type binary --output-type yaml "$secret_path" > "$tmp/secret.enc"
mv -f "$tmp/secret.enc" "$secret_path"
encrypted=1

# --- Commit the encrypted secret (and the rule, if it was just added) -------
git add "$SECRET_REL" .sops.yaml
git commit -m "chore(deskflow): add sops-encrypted 4096-bit TLS cert (${HOST_ROLE})

Self-signed Deskflow identity certificate for the ${HOST_ROLE} host, encrypted
to its age recipient. Certificate SHA-256 fingerprint:
  ${fp_hex}"

# --- Report -----------------------------------------------------------------
cat <<EOF

Committed ${SECRET_REL} (encrypted) on branch $(git rev-parse --abbrev-ref HEAD).
Push so the ${HOST_ROLE} host and reviewers can pull it:  git push

==============================================================================
Certificate SHA-256 fingerprint
==============================================================================
  ${fp_hex}

Add this to EVERY OTHER host that must trust this one (its Deskflow config):

  home.deskflow.tls.trustedFingerprints = [ "${fp_hex}" ];

(Deskflow records it as  v2:sha256:${fp_hex}  in tls/trusted-{servers,clients}.)
Sanity check: confirm it matches Deskflow's GUI "Local Fingerprint (SHA256)".

------------------------------------------------------------------------------
Wiring for THIS (${HOST_ROLE}) host -- apply once the deskflow-config module is
implemented. The secret is declared at the SYSTEM level because sops-nix's
home-manager module is broken on darwin:

  # configurations/${HOST_ROLE}/default.nix  (nix-darwin system module)
  sops.secrets."deskflow-cert" = {
    sopsFile = ../../${SECRET_REL};
    format   = "binary";
    owner    = username;   # so the user-run Deskflow process can read it
    mode     = "0400";
  };

  # the host's home-manager deskflow enablement (osConfig bridges system -> HM)
  home.deskflow.tls = {
    certificateFile = osConfig.sops.secrets."deskflow-cert".path;
    keySize         = ${KEY_BITS};
  };
==============================================================================
EOF
