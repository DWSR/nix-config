# MCP Secrets — Operator Runbook

This directory holds the per-host encrypted MCP secret stores
(`mcp.shopify.yaml`, `mcp.personal.yaml`) consumed by sops-nix at
activation time. The store is encrypted with a per-host age private
key that lives outside the repo, on each host, at
`/var/lib/sops-nix/key.txt`. The corresponding age public keys are
recorded as recipients in the repo-root `.sops.yaml`.

This document is the operator-facing runbook for everything that
involves touching either the encrypted store or the per-host age
keys: first-time bootstrap, enrolling a new host, rotating a secret,
recovering from a lost private key, and the deliberate scope
boundary of this pipeline.

## Conventions

| Host                   | Role short-name | 1Password vault | 1P item                          | Encrypted file                |
| ---------------------- | --------------- | --------------- | -------------------------------- | ----------------------------- |
| ShopifyLaptop          | `shopify`       | Employee        | `op://Employee/sops-age-key-shopify` | `secrets/mcp.shopify.yaml`  |
| Brandons-MacBook-Pro   | `personal`      | Private         | `op://Private/sops-age-key-personal` | `secrets/mcp.personal.yaml` |

The short-name (`shopify` / `personal`) is the value passed to the
helper apps (`mcp-sync-from-1password`, `mcp-verify-secrets`) and
appears in the `mcp.<host>.yaml` filename. It also matches the YAML
anchor name in `.sops.yaml`.

### Keychain account layout

The SOPS bridge writes the decrypted secret values into the macOS
login keychain in two distinct `service` namespaces. Both consume
the SAME per-host encrypted yaml; the split exists so the
sqlite-backup pathway can rotate independently and so the managed
mcpproxy launchd wrapper can export MCP secrets as `${env:<NAME>}`
variables before starting the daemon.

| Service              | Accounts (examples)                              | Consumer                       |
| -------------------- | ------------------------------------------------ | ------------------------------ |
| `mcpproxy`           | `mcp-github-token`, `mcp-vault-token`, `mcpproxy-api-key`, … (one account per MCP secret) | mcpproxy daemon + wrappers     |
| `nix-config-secrets` | `restic-archive-passphrase`, `rclone-config-passphrase` | sqlite-backup CLI + helpers    |

`security find-generic-password -s mcpproxy -a <account> -w` (or
`-s nix-config-secrets -a <account> -w`) returns the live value;
the SOPS bridge keeps these in sync with `secrets/mcp.<host>.yaml`
on every `darwin-rebuild switch`.

## Prerequisites — read this first

Two environmental preconditions apply to every operation below:

1. **GUI session must be active** when you run `darwin-rebuild
   switch`. The activation script writes credentials into the user's
   login keychain via `security add-generic-password`, which
   requires the login keychain to be unlocked. macOS locks the
   login keychain whenever there is no active GUI session — most
   commonly when activating over a headless SSH connection. If you
   run `sudo darwin-rebuild switch --flake .` over SSH from a host
   that is not currently logged in at the console, the activation
   will fail at the keychain-write step with an error similar to
   `SecKeychainItemCreateFromContent: User interaction is not
   allowed.` (errSecInteractionNotAllowed, -25308). Schedule the
   switch from a Terminal window inside an active GUI session
   instead.

2. **`gh` rotation requires GitHub network reachability, but
   unchanged-token switches do not.** Every `darwin-rebuild switch`
   compares the SHA-256 of `/run/secrets/gh-token` against the
   stored hash at `/var/lib/mcp-keychain-sync/gh-token-hash` and
   runs `gh auth status --hostname github.com`. If the hash matches
   AND `gh auth status` reports the existing token is valid, the
   `gh auth login --with-token` step is short-circuited and no
   GitHub API call is made. After a token rotation (where the hash
   changes) the next switch DOES require GitHub reachability so
   that `gh auth login --with-token` can validate the new token
   against `api.github.com`. If you are about to switch immediately
   after rotating `MCP_GITHUB_TOKEN`, make sure you are online and
   not behind a network that blocks `api.github.com`.

## Bootstrap

First-time setup of a host. Repeat once per host. Requires
`op` (1Password CLI) signed in. `age` and `age-keygen` come from
nixpkgs and are not assumed to be on `$PATH`; commands below invoke
them via `nix shell nixpkgs#age -c …`.

1. **Generate an age keypair.** Run wherever convenient (the
   recovering host itself, or any trusted machine with `op`
   access):

   ```sh
   nix shell nixpkgs#age -c age-keygen -o /tmp/age-key-<host>.txt
   nix shell nixpkgs#age -c age-keygen -y /tmp/age-key-<host>.txt   # prints the public key
   ```

   `<host>` is the role short-name (`shopify` or `personal`).
   Capture the public key (`age1…`) — Task 4.3 needs it to enroll
   the host as a recipient in `.sops.yaml`.

2. **Stash the private key in 1Password.** Create the per-host
   Secure Note using the canonical titles (one per host):

   - ShopifyLaptop → vault `Employee`, title `sops-age-key-shopify`
   - Brandons-MacBook-Pro → vault `Private`, title `sops-age-key-personal`

   The full file contents (header comment lines AND the
   `AGE-SECRET-KEY-…` line) go into the item's `notesPlain` field
   (the canonical body field for Secure Notes). Example:

   ```sh
   KEY_CONTENT=$(cat /tmp/age-key-<host>.txt)
   op item create \
     --vault=<Employee|Private> \
     --category="Secure Note" \
     --title="sops-age-key-<host>" \
     "notesPlain=$KEY_CONTENT"
   unset KEY_CONTENT
   ```

   Verify the round-trip — the stored copy must derive the SAME
   public key as the file we just wrote:

   ```sh
   op read 'op://<vault>/sops-age-key-<host>/notesPlain' \
     > /tmp/verify-age-<host>.txt
   nix shell nixpkgs#age -c age-keygen -y /tmp/verify-age-<host>.txt
   rm /tmp/age-key-<host>.txt /tmp/verify-age-<host>.txt
   ```

   The `op read` URI MUST include the field path (`/notesPlain`).
   `op` 2.x rejects bare `op://Vault/Item` URIs with `invalid secret
   reference: too few '/'` — the field path is required even when
   the item has only one obvious field.

3. **Install the private key on the host.** From the target host,
   with `op` signed in:

   ```sh
   # Pre-create the parent dir. sops-nix would create it on first
   # activation, but on first bootstrap we install the key BEFORE
   # the first `darwin-rebuild switch`, so the dir doesn't exist yet.
   sudo install -d -m 0755 -o root -g wheel /var/lib/sops-nix

   # Install the key. The /dev/stdin source emits a benign
   # "install: /dev/stdin: file changed before being copied" warning
   # because coreutils install fstats the source twice and the pipe
   # reports different sizes. The file content is correct; verify in
   # step 4.
   op read 'op://<vault>/sops-age-key-<host>/notesPlain' \
     | sudo install -m 0600 -o root -g wheel /dev/stdin /var/lib/sops-nix/key.txt
   ```

   Replace `<vault>` with `Employee` or `Private`, and `<host>`
   with `shopify` or `personal`, per the table at the top of this
   file.

4. **Verify.** Three lines should appear in the installed file:

   ```sh
   sudo head -3 /var/lib/sops-nix/key.txt
   # Expected (3 lines):
   #   # created: 2026-...
   #   # public key: age1...
   #   AGE-SECRET-KEY-1...
   ```

   Round-trip: derive the public key from the installed file and
   confirm it matches the one captured in step 1:

   ```sh
   sudo nix shell nixpkgs#age -c age-keygen -y /var/lib/sops-nix/key.txt
   # Should print the same age1... as step 1.
   ```

5. **Enroll the public key in `.sops.yaml`.** This is covered by
   Task 4.3 of the spec, but operationally: replace the
   `age1placeholder...` value at the matching anchor (`&host_shopify`
   or `&host_personal`) in repo-root `.sops.yaml` with the public
   key emitted by step 1. Then re-encrypt the existing per-host
   yaml against the new recipient with `sops updatekeys
   secrets/mcp.<host>.yaml`. Commit the changes to `.sops.yaml`
   AND the re-encrypted secrets file together.

6. **Activate.** `sudo darwin-rebuild switch --flake .` will now
   succeed because sops-nix can decrypt `secrets/mcp.<host>.yaml`
   using the private key at `/var/lib/sops-nix/key.txt`.

## Adding a new host

A brand-new host (one whose age public key has never appeared in
`.sops.yaml`) cannot decrypt anything in `secrets/`. This is the
chicken-and-egg constraint: the new host needs an existing host to
enroll it before its own first `darwin-rebuild switch` will succeed.

This is intentional — it is the property that prevents a
compromised host from reading any other host's secrets.

**Prerequisites:** at least one existing enrolled host that already
has a working `/var/lib/sops-nix/key.txt`, and `op` access to the
1Password vault for the new host.

### On the new host

1. Generate the age keypair locally (steps 1–2 of Bootstrap above).
   The private key goes to 1Password; the public key gets handed
   off to the existing host (paste over chat, encrypted email,
   etc. — the public key is not sensitive).

2. Do NOT yet attempt `darwin-rebuild switch`. It will fail.

### On the existing (already-enrolled) host

3. Pull the latest repo. Edit `.sops.yaml`:
   - Add a new YAML anchor for the new host alongside the existing
     ones, e.g., `&host_<newname> ageNEWPUBLICKEY...`.
   - Add a new `creation_rule` whose `path_regex` matches the new
     host's per-host file (e.g., `secrets/mcp\.<newname>\.yaml$`)
     and whose recipient list contains exactly that anchor.

4. If you have any existing per-host yaml that the new host will
   ALSO need to decrypt (rare — the design uses one file per host
   with one recipient), re-encrypt it to add the new recipient:

   ```sh
   sops updatekeys secrets/mcp.<newname>.yaml
   ```

   `sops updatekeys` reads `.sops.yaml`, recomputes the recipients
   for the file, and re-wraps the data key against them in place.
   It does not change the underlying secret values.

5. Create the new host's encrypted file. Easiest path is via the
   `mcp-sync-from-1password` helper (Task 7.x) once the
   corresponding 1P items exist:

   ```sh
   nix run '.#mcp-sync-from-1password' -- <newname>
   ```

6. Commit both `.sops.yaml` and `secrets/mcp.<newname>.yaml`. Push.

### Back on the new host

7. Pull the repo, run Bootstrap step 3 (install the private key
   from 1P), and finally `sudo darwin-rebuild switch --flake .`.
   It now succeeds because the per-host yaml is encrypted to the
   new host's recipient.

## Rotating a secret

Use this when a secret value (an MCP API token, a service
credential, etc.) needs to change but the host enrollment does
NOT change. This is the common-case maintenance flow.

### Rotating a 1Password-backed secret

Most MCP and sqlite-backup secrets (github token, vault token,
restic archive passphrase, rclone config passphrase, …) are
mirrored from 1Password into `secrets/mcp.<host>.yaml` by
`mcp-sync-from-1password`.

1. **Edit the secret in 1Password.** This is the source of truth.
   Update the field on the relevant 1P item (e.g.,
   `op://Employee/MCP/<service>/token`). All downstream copies are
   regenerated from this.

2. **Refresh the encrypted yaml from 1P.** From a workstation
   checkout with `op` signed in:

   ```sh
   nix run '.#mcp-sync-from-1password' -- <host>
   ```

   This re-reads every secret value declared in the per-host
   manifest from 1Password, re-encrypts to the host's age recipient
   per `.sops.yaml`, and writes `secrets/mcp.<host>.yaml` in
   place.

3. **Inspect and commit.** `git diff secrets/mcp.<host>.yaml` will
   show only the encrypted blob differences (sops keeps stable
   YAML structure for unchanged keys; values change). Commit:

   ```sh
   git add secrets/mcp.<host>.yaml
   git commit -m "secrets(<host>): rotate <service> token"
   ```

4. **Activate on the host.** Pull, then:

   ```sh
   sudo darwin-rebuild switch --flake .
   ```

   sops-nix decrypts the new value into `/run/secrets/...` and the
   activation phase rewrites any consumer artifacts (the gh
   keychain entry, OpenCode config, etc.) according to the
   short-circuit rules described under Prerequisites.

5. **Verify.** Confirm the rotated value is what consumers see:

   ```sh
   nix run '.#mcp-verify-secrets' -- <host>
   ```

   The verifier prompts for your sudo password once: it needs root
   to read `/var/lib/sops-nix/key.txt` for the in-process decrypt,
   then drops back to user privileges to query your login keychain
   and `gh auth status`. The keychain query MUST run as your user
   (MCP secrets are stored under `service = "mcpproxy"` keyed by
   the secret name as `account`; sqlite-backup secrets live under
   `service = "nix-config-secrets"` keyed the same way), and an
   active GUI session is required so the login keychain is unlocked.

   This helper re-reads the now-decrypted secrets and the consumer
   surfaces (login keychain entry, gh auth status hash) and exits
   0 only when they agree. A non-zero exit means something on the
   activation path failed silently and warrants investigation
   before declaring the rotation complete.

### Rotating `mcpproxy-api-key`

`mcpproxy-api-key` is the bearer token that gates mcpproxy's local
HTTP API (`/api/v1/*`). The opencode wrapper, the memory-sync CLI,
and any operator preflight commands authenticate against mcpproxy
with this value. It is NOT mirrored from 1Password — it is
generated locally and stored directly in the SOPS yaml. Rotate it
by replacing the value in the encrypted store and re-activating.

1. **Generate a new key.** 32 random bytes, hex-encoded:

   ```sh
   openssl rand -hex 32
   ```

   Copy the resulting 64-character hex string. Do not commit it,
   echo it into a shell history that will be uploaded anywhere,
   or paste it into chat — the next step is the only durable copy.

2. **Edit the encrypted store.** `sops edit` decrypts in-place,
   drops you into `$EDITOR`, and re-encrypts on save:

   ```sh
   sops edit secrets/mcp.<host>.yaml
   ```

   Replace the existing `mcpproxy-api-key:` value with the
   newly-generated hex string. Save and exit. `sops` re-encrypts
   the file against the host's age recipient automatically.

3. **Inspect and commit.** Only the encrypted blob for the
   rotated value should change:

   ```sh
   git diff secrets/mcp.<host>.yaml
   git add secrets/mcp.<host>.yaml
   git commit -m "secrets(<host>): rotate mcpproxy-api-key"
   ```

4. **Activate on the host.** Pull, then:

   ```sh
   sudo darwin-rebuild switch --flake .
   ```

   The SOPS bridge decrypts the new value and writes it into the
   login keychain at `service = "mcpproxy"`,
   `account = "mcpproxy-api-key"`, replacing the previous entry.
   mcpproxy's launchd agent restarts through the
   `mcpproxy-launchd-wrapper`, which reads that keychain entry and
   exports `MCPPROXY_API_KEY` for the rendered
   `${env:MCPPROXY_API_KEY}` placeholder.

5. **Verify.** The value visible to the managed wrapper should match
   what is now stored in the keychain:

   ```sh
   security find-generic-password -s mcpproxy -a mcpproxy-api-key -w
   ```

   The output is the rotated 64-character hex string. The rendered
   Home Manager source config should contain only the env placeholder,
   should remain a managed source file or symlink after restart, and
   should not gain an adjacent backup:

   ```sh
   source_config="${XDG_CONFIG_HOME:-$HOME/.config}/mcpproxy/mcp_config.json"

   grep -F '"api_key":"${env:MCPPROXY_API_KEY}"' "$source_config"
   ! grep -F '"tools_limit"' "$source_config"
   ls -l "$source_config"
   test ! -e "$source_config.bak"

   restart-mcpproxy
   sleep 2

   ls -l "$source_config"
   test ! -e "$source_config.bak"
   ls -l "$HOME/.mcpproxy/runtime-config/mcp_config.json"
   test ! -e "$HOME/.mcpproxy/runtime-config/mcp_config.json.bak" \
     || ls -l "$HOME/.mcpproxy/runtime-config/mcp_config.json.bak"
   ```

   The runtime config path is the mutable private copy mcpproxy may
   rewrite or back up. The source config path and its adjacent `.bak`
   path are the ownership-protection check: after a managed restart,
   mcpproxy should not have replaced the source file or created
   `$source_config.bak`.

   The mcpproxy daemon should also still respond on `/healthz`;
   clients that present the new key (opencode wrapper, memory-sync CLI)
   should continue to authenticate successfully.

   If `mcp-verify-secrets` is wired to check the api-key entry,
   run it as well to catch any drift the manual check missed.

## Recovery from lost key

A host's `/var/lib/sops-nix/key.txt` can be lost in several ways:
disk corruption, an accidental `rm`, a host wipe and reinstall, a
new SSD. Without that file, sops-nix on that host cannot decrypt
ANY of its secrets, and `darwin-rebuild switch` will fail at the
sops activation phase.

Two recovery paths, depending on whether the 1Password copy of the
private key still exists.

### Case 1 — 1Password copy still exists

This is the normal recovery path. Re-install from 1P (note the
`/notesPlain` field path on the URI — `op` 2.x rejects bare
`op://Vault/Item` URIs):

```sh
# Pre-create parent dir if /var/lib/sops-nix is also gone (e.g.,
# after a host wipe).
sudo install -d -m 0755 -o root -g wheel /var/lib/sops-nix

op read 'op://<vault>/sops-age-key-<host>/notesPlain' \
  | sudo install -m 0600 -o root -g wheel /dev/stdin /var/lib/sops-nix/key.txt
sudo head -3 /var/lib/sops-nix/key.txt   # verify 3-line file with AGE-SECRET-KEY- on line 3
sudo darwin-rebuild switch --flake .
```

This is the entire recovery — no `.sops.yaml` change, no commit,
no involvement from any other host. The on-disk public-key recipient
in `.sops.yaml` is unchanged because the underlying age keypair is
unchanged.

### Case 2 — 1Password copy is ALSO lost

The private key is permanently gone. The data encrypted to the old
public key is permanently undecryptable from this host. Recovery
requires re-enrollment: treat the host as a brand-new host and
walk through "Adding a new host" above. Concretely:

1. On the recovering host, generate a fresh age keypair (Bootstrap
   step 1) and stash the new private key in 1P (Bootstrap step 2).

2. On the existing (still-enrolled) host: replace the recovering
   host's recipient in `.sops.yaml` with the NEW public key. Run
   `sops updatekeys secrets/mcp.<host>.yaml` to re-encrypt the
   per-host file against the new recipient. Commit and push.

3. On the recovering host: install the new private key (Bootstrap
   step 3), pull the repo, and `sudo darwin-rebuild switch
   --flake .`.

If both hosts have lost their keys at the same time, recovery
requires re-creating every secret value from the upstream system
(rotate everything in 1P, then sync), since the existing
`secrets/mcp.<host>.yaml` files are no longer decryptable by
anyone. This is a deliberate trade-off — see `requirements.md`
section 9.5.

## Out of scope

The following secrets are deliberately NOT managed by this pipeline.
Each one has a different lifecycle that would be poorly served by
folding it into the per-host MCP-secrets boundary.

- **OpenCode `OPENCODE_API_KEY`.** Minted per-invocation by `devx
  llm-gateway`. The token has a short TTL and is intended to be
  refreshed on demand by the upstream tool, not stored at rest.
  Centralising it in the encrypted store would require frequent
  re-syncs and would defeat the short-TTL rotation model.

- **`~/.cache/tool-gateway-token`.** Populated by external Shopify
  tooling outside this repo's control. Lifecycle is owned by
  `devx`, refreshed automatically when expired. We do not have
  authoritative provenance for the value, so we cannot meaningfully
  re-encrypt or rotate it from here. mcpproxy consumes it through
  `home.mcp.fileSourcedEnv` as a runtime `${env:TOOL_GATEWAY_TOKEN}`
  placeholder; the value remains outside SOPS and outside the Nix
  store.

- **1Password SSH commit signing.** Uses in-band auth via the 1P
  agent (the agent socket is queried for each signing operation).
  No stable secret to encrypt at rest; doesn't fit the
  encrypted-store-at-rest model.

- **Atuin sync key, AWS credentials file, SSH host/user keys.**
  Distinct lifecycles, separate rotation cadences, different
  consumer surfaces. Folding them into this pipeline would
  violate the per-host MCP-secrets boundary the spec defines (see
  `requirements.md` section 9.4).

If a future need arises to manage one of these via sops-nix, it
should get its own spec rather than expanding this pipeline.

## See also

- Repo-root `.sops.yaml` — the recipient policy file.
- `.kiro/specs/mcp-secrets-sops-nix/requirements.md` sections 3.4,
  9.1–9.5 — the underlying requirements this runbook satisfies.
- `.kiro/specs/mcp-secrets-sops-nix/design.md` — architecture and
  flow diagrams.
