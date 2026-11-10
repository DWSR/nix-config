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
| fabro (fabro-vm Lima VM guest) | `fabro`  | Private         | `op://Private/sops-age-key-fabro` | `secrets/fabro.fabro.yaml`    |
| mac-builder (macOS remote builder guest) | `mac-builder` | Private | `op://Private/sops-age-key-mac-builder` | `secrets/remote-builder.mac-builder.yaml` |
| linux-builder (NixOS Linux remote builder guest) | `linux-builder` | Private | `op://Private/sops-age-key-linux-builder` | `secrets/remote-builder.linux-builder.yaml` |

The short-name (`shopify` / `personal` / `fabro`) is the value passed to the
helper apps (`mcp-sync-from-1password`, `mcp-verify-secrets`) and
appears in the `mcp.<host>.yaml` filename. It also matches the YAML
anchor name in `.sops.yaml`.

The `fabro` host is the NixOS guest of the `fabro-vm` Lima VM
(`nixosConfigurations.fabro-vm`, guest hostname `fabro`). It is
enrolled in `.sops.yaml` as `&host_fabro` but has no darwin
configuration; see "Fabro host store (NixOS guest)" below.

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

One secret has a third consumer outside the Keychain:
`mcp-github-token` is also exposed to Nix itself as
`access-tokens = github.com=<token>`. See
"Nix GitHub access token" below.

## Fabro host store (NixOS guest)

`secrets/fabro.fabro.yaml` is the fabro host's store: one file for the
guest's application services (the fabro server, the LiteLLM proxy, and
the OpenCode v1 server).
The guest is a NixOS host, so there is no macOS Keychain bridge —
values are consumed from the `sops.secrets` / `sops.templates`
declarations in `configurations/fabro-vm/default.nix` (deployed: the
services read sops-rendered env files). The guest's age private key is
installed at `/var/lib/sops-nix/key.txt` (mode 0600, root); it was
installed during the 2026-10-12 bootstrap and also lives in the
Private-vault note `sops-age-key-fabro`.

| SOPS key | 1Password source | Consumer |
| --- | --- | --- |
| `fabro-session-secret` | `op://Private/Fabro/Session Secret` | fabro server `SESSION_SECRET` |
| `fabro-dev-token` | `op://Private/Fabro/Dev Token` | fabro server `FABRO_DEV_TOKEN` |
| `litellm-master-key` | `op://Private/LiteLLM/Master Key` | LiteLLM proxy master key |
| `opencode-api-key` | `op://Private/OpenCode/API Key` | LiteLLM `os.environ/OPENCODE_API_KEY` deployments |
| `github-token` | `op://Private/GitHub/Tokens/Fabro` | fabro-host GitHub PAT — exported to the fabro service as `GITHUB_TOKEN` via `sops.templates."fabro-env"` (the `integrations.github.strategy = "token"` env source) |
| `tailscale-oauth-secret` | `op://Infrastructure/Fabro Host Tailscale Credentials/Client Secret` | `services.tailscale.authKeyFile` (tailnet registration; `configurations/fabro-vm/tailscale.nix`) |
| `opencode-github-token` | `op://Private/GitHub/Tokens/OpenCode` | OpenCode server's dedicated GitHub PAT — exported as `GITHUB_TOKEN` and `GH_TOKEN` via `sops.templates."opencode-env"`; git pushes authenticate through `gh auth git-credential` (`configurations/fabro-vm/opencode.nix`) |
| `opencode-server-password` | `op://Private/OpenCode/Server Password` | OpenCode server basic-auth password (`OPENCODE_SERVER_PASSWORD`; username defaults to `opencode`) |
| `opencode-signing-key` | `op://Private/OpenCode Signing Key/private key` | git SSH commit-signing key; handed to the opencode service as a systemd credential (`LoadCredential=`, `configurations/fabro-vm/opencode.nix`) |

The `opencode-signing-key` row differs from the token rows: its 1Password
source is an **SSH Key item** (not a note/text field), so the value is a
multi-line PEM. `fabro-sync-from-1password` supports that — multi-line
values are emitted as YAML double-quoted scalars (every key stays on one
physical line, which the carry-forward parser and coverage gate rely on).
If 1Password renames the key field, the fallback field-id form is
`op://Private/OpenCode Signing Key/privateKey`.

Values are seeded from the 1Password items above (not from the
keychain bridge). The fabro service consumes this sops-rendered pair
(switched over from the imperative `/var/lib/fabro/env` pair the VM
had generated in-guest; that one-time move invalidated the sessions
bound to the old pair).

The Tailscale row differs from the rest of the table: its source lives
in the `Infrastructure` vault, not `Private`. The item
`Fabro Host Tailscale Credentials` holds a Tailscale OAuth client
(Client ID + `tskey-client-…` Client Secret, `auth_keys` scope) whose
secret doubles as the node auth key (tailscale.com/kb/1215). Only the
secret is mirrored into the store; the client ID is embedded in the
secret value. Registration tags the guest `tag:fabro`
(`services.tailscale.extraUpFlags`), and rotation affects only future
node registrations — an already-registered guest keeps its bond until
`tailscale logout` runs in-guest.

### Syncing the store from 1Password

`nix run '.#fabro-sync-from-1password'` rewrites the whole store from
the 1Password items in the table above: it evaluates the
`fabro.onePasswordSecrets` manifest from the guest configuration,
`op read`s every URI, and atomically re-encrypts
`secrets/fabro.fabro.yaml` against the `&host_fabro` recipient. It
pulls the fabro host's age key from the `sops-age-key-fabro` note (the
mac's `/var/lib/sops-nix/key.txt` is the personal key and cannot open
this store), carries forward any declared-but-manifest-less keys from
the prior store, and aborts — leaving the store untouched — if a sync
would drop a declared key or any URI fails to resolve. `op` must be
signed in (`op signin`) for the run.

```sh
nix run '.#fabro-sync-from-1password'
```

Adding a secret: declare it in `sops.secrets`
(`configurations/fabro-vm/default.nix`), add its URI to
`fabro.onePasswordSecrets` in the same file, run the sync, commit the
re-encrypted store, then deploy the guest. **Ordering matters**: each
`sops.secrets` entry becomes active on the guest's next
`nixos-rebuild switch`, which fails at sops activation until the store
actually contains that key — sync (and commit) before switching.

Exit codes: 0 success; 1 not a git working tree / flake-eval failure;
2 `op` not authenticated; 3 a 1Password URI unresolvable; 4 sops
failure; 5 the sync would drop a declared key.

### Editing / rotating

Value refreshes of manifest-mapped keys are the sync helper's job (run
it after rotating the 1Password item). The manual flow below is for
everything the manifest does not cover: structural edits, keys without
a 1Password source, and re-encrypting after a recipient change.

`sops-nix-sudo` points at the personal host's key, which cannot open
this store. Pull the fabro host's key from 1Password for the duration
of the edit, then destroy the staging copy:

```sh
T=$(mktemp -d)
op read 'op://Private/sops-age-key-fabro/notesPlain' > "$T/key.txt"
SOPS_AGE_KEY_FILE="$T/key.txt" \
  nix shell --inputs-from . nixpkgs#sops -c \
  sops --config .sops.yaml edit secrets/fabro.fabro.yaml
rm -rf "$T"
```

Rotate the value in the 1Password item first where one exists (see
table), then mirror it here. After any `.sops.yaml` recipient change,
re-encrypt with the same `SOPS_AGE_KEY_FILE` trick via `sops
updatekeys secrets/fabro.fabro.yaml`.

## Builder host store (macOS remote builder)

`secrets/remote-builder.mac-builder.yaml` is the builder host's store: one
file for the `builder-authorized-keys` secret (newline-separated client
public keys) and the `builder-tailscale-oauth-secret` credential consumed
by sops-nix on the builder host. It is encrypted to the
`&host_mac_builder` recipient only. The personal host's
`secrets/mac-builder-client.personal.yaml` separately holds the SSH client
private key consumed by nix-daemon, encrypted only to `&host_personal` and
decrypted to a root-owned mode-0400 path.

| Item | Value |
| --- | --- |
| Encrypted file | `secrets/remote-builder.mac-builder.yaml` |
| SOPS keys | `builder-authorized-keys`, `builder-tailscale-oauth-client-id`, `builder-tailscale-oauth-secret` |
| Recipient anchor | `&host_mac_builder` |
| 1Password item (age key) | `op://Private/sops-age-key-mac-builder` (Secure Note, `notesPlain`) |
| 1Password sources | `op://Infrastructure/mac-builder authorized keys/notesPlain`; `op://Infrastructure/mac-builder Tailscale OAuth/Client ID`; `op://Infrastructure/mac-builder Tailscale OAuth/Client Secret` |
| Private key on host | `/var/lib/sops-nix/key.txt` (mode `0600`, root) |

The SSH client key is sourced from
`op://Infrastructure/mpbezzwylhzlupl7epao2mp5za/private key` and synced
into the separate personal-host store by `nix run
'.#mac-builder-sync-from-1password'`. The personal host age key is read from
`op://Private/sops-age-key-personal/notesPlain` for that encryption.

The builder age private key is generated once with `age-keygen` and
stashed in 1Password under the item above, mirroring the per-host
bootstrap. Its public recipient is
`age10puuz9e0nj3u9va2mg7uaad5m5v2sdfs73e97tgsd3r4cykk2gcsk5laq5`.

### Age-key-before-first-switch bootstrap order

The builder age key must be installed before the first
`darwin-rebuild switch` on the builder host:

1. Generate the keypair (or reuse the stored one) and capture the
   public recipient.
2. Stash the private key in 1Password at
   `op://Private/sops-age-key-mac-builder/notesPlain`.
3. Install the private key on the builder host at
   `/var/lib/sops-nix/key.txt` (mode `0600`, root) — the deploy
   command does this from 1Password before applying the configuration.
4. Only then run the first switch; sops-nix decrypts
   `secrets/remote-builder.mac-builder.yaml` using that key.

### Builder OAuth credential

The builder joins the tailnet with its own OAuth client secret,
`builder-tailscale-oauth-secret`, distinct from the guest's
`tailscale-oauth-secret`. The sync command also stores the separate client ID
as `builder-tailscale-oauth-client-id`. The console owns the OAuth client's
`auth_keys` scope and its `tag:nix-remote-builder` tag.

Refresh the builder's OAuth values from 1Password with:

```sh
nix run '.#mac-builder-sync-from-1password'
```

The command reads the mac-builder age key from its 1Password Secure Note,
fetches `op://Infrastructure/mac-builder authorized keys/notesPlain`,
`op://Infrastructure/mac-builder Tailscale OAuth/Client ID`, and
`op://Infrastructure/mac-builder Tailscale OAuth/Client Secret`, then updates
`secrets/remote-builder.mac-builder.yaml` encrypted to the builder recipient.
The authorized-keys note must contain newline-separated public keys and may not
be empty. Sign in to `op` first; this command does not deploy or switch the
builder.

1. Store the client secret in 1Password at
   `op://Infrastructure/mac-builder Tailscale OAuth/Client Secret` and the
   client ID at `op://Infrastructure/mac-builder Tailscale OAuth/Client ID`.
2. Alternatively, update the encrypted store manually with the builder age key,
   passing the value by file so it never reaches shell history.
   `sops --value-file` JSON-decodes the file, so write
   the token as a JSON string. `sops set` rewrites only the named key and
   preserves `builder-authorized-keys`:

   ```sh
   T=$(mktemp -d); chmod 0700 "$T"
   op read 'op://Infrastructure/mac-builder Tailscale OAuth/Client Secret' \
     | tr -d '\n' | jq -Rs . > "$T/secret"
   SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt \
     nix shell --inputs-from . nixpkgs#sops -c \
     sops set --value-file secrets/remote-builder.mac-builder.yaml \
     '["builder-tailscale-oauth-secret"]' "$T/secret"
   rm -rf "$T"
   ```

   `sops edit` with the same `SOPS_AGE_KEY_FILE` is the alternative when the
   store needs several structural edits.
3. Verify the key decrypts without printing the value. The output must contain
   no embedded newline, and `builder-authorized-keys` must still hold every
   authorized client key:

   ```sh
   SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt \
     nix shell --inputs-from . nixpkgs#sops -c \
     sops -d --extract '["builder-tailscale-oauth-secret"]' \
     secrets/remote-builder.mac-builder.yaml | wc -c
   ```

### Fabro build-session keys

The guest presents `build-client-key` for build sessions and pins the builder
host key in `build-host-key`. Both live in `secrets/fabro.fabro.yaml` and are
declared in `fabro.onePasswordSecrets`, so the 1Password items are the source
of truth.

1. Generate the pair out of band, outside the checkout:

   ```sh
   ssh-keygen -t ed25519 -N '' -C 'fabro-mac-builder' -f /tmp/build-client-key
   ```

   This writes `/tmp/build-client-key` (private) and
   `/tmp/build-client-key.pub` (public).
2. Store the private half at
   `op://Infrastructure/Fabro nix remote builder key/private key`
   and the builder's `ssh_host_ed25519_key.pub` at
   `op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key`.
3. Refresh the fabro store from 1Password:

   ```sh
   nix run '.#fabro-sync-from-1password'
   ```

   The sync aborts instead of dropping a declared key, so the store always
   ends with both entries.
4. Append the public half of the client key to the 1Password item
   `op://Infrastructure/mac-builder authorized keys/notesPlain` (one key per
   line), then refresh the builder store:

   ```sh
   nix run '.#mac-builder-sync-from-1password'
   ```
5. Verify with `sops -d --extract` for each key using the store's own host key;
   never print a value. The `build-host-key` value must match the builder's
   host public key, and the client public half must appear in
   `builder-authorized-keys`.

### Authorized-key rotation

`builder-authorized-keys` holds every client public key the builder accepts,
including the public half of the fabro `build-client-key`. Rotate one client
key by generating the new pair, updating the fabro store's 1Password item and
re-running `nix run '.#fabro-sync-from-1password'`, then replacing only that
key's public half in `builder-authorized-keys` and re-encrypting
`secrets/remote-builder.mac-builder.yaml` against `&host_mac_builder`.
Preserve the other authorized keys, and never drop a recipient or weaken the
builder store encryption. Re-run deploy/switch and confirm the new key is
accepted while the old one is refused.

## Linux builder host store (NixOS remote builder)

The Linux builder is the separate NixOS `aarch64-linux` Lima guest
(`nixosConfigurations.linux-builder`, instance `linux-builder`) managed by the
personal host. Its secret material is split across three per-host stores:

- `secrets/remote-builder.linux-builder.yaml` — the builder host's own store:
  the authorized client public keys and the builder's Tailscale OAuth
  credential, encrypted only to the builder's `&host_linux_builder` age
  recipient.
- `secrets/linux-builder-client.personal.yaml` — the personal Mac's dedicated
  Linux-builder SSH client key, encrypted only to `&host_personal` and
  decrypted on the Mac to a root-owned runtime path.
- `secrets/fabro.fabro.yaml` — the Fabro guest's store, which also holds the
  Fabro guest's dedicated Linux-builder client key (see "Fabro host store"
  above).

Every value is operator-provisioned; the repository contributes declarations,
runtime paths, and the sync command only. The authoritative table of secret,
source, provisioning command, verification command, and owner is the design's
`## Operator Provisioning` section in
`.kiro/specs/create-a-linux-nix-remote-builder-instance/design.md`; this
section is its operational runbook.

| Item | Value |
| --- | --- |
| Builder encrypted file | `secrets/remote-builder.linux-builder.yaml` |
| Builder SOPS keys | `builder-authorized-keys`, `builder-tailscale-oauth-secret` |
| Builder recipient | `&host_linux_builder` (operator-enrolled; see below) |
| Builder age key | `op://Private/sops-age-key-linux-builder/notesPlain` |
| Builder authorized keys source | `op://Infrastructure/linux-builder authorized keys/notesPlain` (one public key per line) |
| Builder OAuth source | `op://Infrastructure/linux-builder Tailscale OAuth/Client Secret` |
| Guest runtime paths | `/run/secrets/builder-authorized-keys` (mode `0400`, root) → `/home/builder/.ssh/authorized_keys`; `/run/secrets/builder-tailscale-oauth-secret` (mode `0400`, root) |
| Personal client store | `secrets/linux-builder-client.personal.yaml` (key `linux-builder-client-key`) |
| Personal client source | `op://Infrastructure/Brandons Mac Linux nix remote builder key/private key` (read with `?ssh-format=openssh`) |
| Personal runtime path | `/run/secrets/linux-builder-client-key` (mode `0400`, root) |
| Fabro client store | `secrets/fabro.fabro.yaml` (key `linux-builder-client-key`) |
| Fabro client source | `op://Infrastructure/Fabro Linux nix remote builder key/private key` |
| Fabro runtime path | `/run/secrets/linux-builder-client-key` (mode `0400`, root) |

The builder age key is installed on the guest at `/var/lib/sops-nix/key.txt`
(mode `0600`, root), exactly like the other NixOS guest stores. Only the
encrypted stores are committed; no private key or OAuth value ever enters the
checkout or the Nix store.

The builder store's creation rule in `.sops.yaml` starts with an empty `age`
list on purpose. The real `host_linux_builder` recipient does not exist until
the operator provisions the builder age identity (design's
`## Operator Provisioning`), and a fabricated recipient would either be a
placeholder or make the store undecryptable. The sync command therefore
derives the recipient from the operator-held age key with `age-keygen -y` and
passes it to sops with `--age`; a config-only encryption of that path fails
closed ("empty key group provided"). Once the operator enrolls the derived
public key as `&host_linux_builder` in `.sops.yaml` and lists it in the
builder rule, the sync also refuses to run if the derived recipient differs
from the configured one.

### Bootstrap order

Run these steps from the personal-host checkout with `op` signed in. They are
operator-owned: the sync command writes the encrypted stores and the operator
copies the public host-key pin, but no step mints, guesses, or records a
secret value. The order matters because each activation reads what the
previous step installed.

1. **Create the builder age identity.** Generate the keypair out of band,
   stash the full file in 1Password, and print its public recipient — all in
   one shell session, because the temp directory is removed on exit:

   ```sh
   T=$(mktemp -d); chmod 0700 "$T"; trap 'rm -rf "$T"' EXIT
   nix shell nixpkgs#age -c age-keygen -o "$T/linux-builder-age-key.txt"
   op item create --vault=Private --category="Secure Note" \
     --title="sops-age-key-linux-builder" \
     "notesPlain=$(cat "$T/linux-builder-age-key.txt")"
   nix shell nixpkgs#age -c age-keygen -y "$T/linux-builder-age-key.txt"
   ```

   Enroll the printed recipient as the `&host_linux_builder` anchor in
   `.sops.yaml`, then list that anchor in the
   `secrets/remote-builder\.linux-builder\.yaml$` creation rule so future
   config-driven sops operations address the same recipient.

2. **Create the two dedicated client keypairs.** These are distinct from the
   Darwin builder's `build-client-key`; reused or shared keys are not
   acceptable. Generate each pair inside a mode-`0700` temp directory that is
   removed only after both private halves are stored:

   ```sh
   T=$(mktemp -d); chmod 0700 "$T"
   ssh-keygen -t ed25519 -N '' -C 'fabro-linux-builder' \
     -f "$T/fabro-linux-builder-client"
   ssh-keygen -t ed25519 -N '' -C 'personal-linux-builder' \
     -f "$T/personal-linux-builder-client"
   ```

   Store each private half in its 1Password SSH Key item's `private key`
   field (`.../Fabro Linux nix remote builder key` and
   `.../Brandons Mac Linux nix remote builder key`), then delete the temp
   directory. Never copy a private half into the checkout, a commit, a shell
   history, or a log. Append each `.pub` line to
   `op://Infrastructure/linux-builder authorized keys/notesPlain` — one public
   key per line, preserving any existing authorized keys.

3. **Create the builder's Tailscale OAuth client.** In the Tailscale admin
   console, create a client that is separate from the Fabro guest's OAuth
   client, grant it the `auth_keys` scope, and authorize it to apply
   `tag:linux-nix-remote-builder`. Store only its client secret at
   `op://Infrastructure/linux-builder Tailscale OAuth/Client Secret`; the
   secret value carries the client ID, so no separate field is mirrored.

4. **Sync the stores from 1Password.** This creates the builder and personal
   client stores from the values above, so every later activation can decrypt
   what it declares (see "Syncing the stores from 1Password" below). Commit
   the stores and the `.sops.yaml` change before continuing:

   ```sh
   nix run '.#linux-builder-sync-from-1password'
   nix run '.#fabro-sync-from-1password'
   ```

5. **Start the instance and install the builder age key before the first
   switch.** The guest's `sops-install-secrets` pre-start check fails the
   switch when either `/var/lib/sops-nix/key.txt` or the encrypted store is
   missing, so install the key first:

   ```sh
   launchctl kickstart "gui/$(id -u)/dev.dwsr.lima-linux-builder"
   lima-vmctl list linux-builder    # wait until the instance reports Running

   lima-vmctl shell linux-builder sudo -n install -d -m 0755 -o root -g root \
     /var/lib/sops-nix
   op read 'op://Private/sops-age-key-linux-builder/notesPlain' \
     | lima-vmctl shell linux-builder sudo -n install -m 0600 -o root -g root \
       /dev/stdin /var/lib/sops-nix/key.txt
   ```

   `install` may warn that `/dev/stdin` changed before being copied (it stats
   the pipe twice); the content is correct — confirm with `sudo -n stat -c
   '%a %U' /var/lib/sops-nix/key.txt`.

   `lima-vmctl` is the personal host's `limactl` wrapper that pins the shared
   managed Lima home (`~/.local/state/lima` by default) for every instance;
   the supervisor and the deploy command use the same `LIMA_HOME`.

6. **Deploy the host configuration into the guest.** `linux-builder-deploy`
   streams the checkout (`.git` and local results excluded) and runs
   `nixos-rebuild switch --sudo --flake <scratch>#linux-builder` in the guest:

   ```sh
   linux-builder-deploy
   ```

   The first switch generates the persistent OpenSSH host key at
   `/var/lib/ssh/ssh_host_ed25519_key`, enrolls the node with the synced
   OAuth credential, and materializes the authorized keys. Do not proceed to
   the clients until the pin is committed (next step).

7. **Capture and commit the host-key pin** (see "Host-key pin" below). The
   Fabro renderer fails closed without it, so it must exist in the deployed
   tree before the Fabro switch.

8. **Deploy the clients.** Refresh Fabro with `lima-vm-deploy` from the
   personal host and the Mac with `sudo darwin-rebuild switch --flake .`.
   Fabro's `fabro-darwin-builders.service` renders both machine records before
   `nix-daemon` starts, and the Mac's generated `nix-builders` file contains
   the Darwin and Linux records. If the pin was skipped, the Mac switch still
   succeeds with a warning but its Linux record omits the host-key field and
   Linux builds fail closed.

### Syncing the stores from 1Password

`nix run '.#linux-builder-sync-from-1password'` refreshes both Linux-builder
stores in one gather-then-commit pass:

1. It resolves the builder age key, the personal age key, the authorized-key
   note, the Tailscale OAuth secret, and the personal client key from the
   1Password references in the table above.
2. It validates every value before writing anything — the age keys are
   well-formed age files, every authorized-keys line is a public key, the
   OAuth secret is a single non-empty token, and the personal key is an
   OpenSSH private key — so one bad input leaves both prior stores untouched.
3. It writes each store through a mode-`0700` temporary directory under
   `secrets/` and an atomic rename, addressing the builder store to the
   recipient derived from the builder age key and the personal store to
   `&host_personal`.

The command never mints, generates, rotates, or prints a secret value. Run it
from the repository checkout after `op signin`.

`nix run '.#fabro-sync-from-1password'` separately mirrors the Fabro guest's
`linux-builder-client-key` into `secrets/fabro.fabro.yaml` with the rest of
the Fabro store; its coverage gate aborts (exit 5) if the run would drop a key
that the guest configuration declares.

Exit codes for the builder sync: 0 success; 1 not a git working tree or an
invalid invocation; 2 `op` not authenticated; 3 an unresolvable 1Password URI
or an invalid supplied value; 4 a sops encryption failure. Commit the
re-encrypted stores and the `.sops.yaml` recipient/rule change before
deploying: the Linux builder guest's activation fails at sops when its store
or age key is missing, and each client's switch fails when a declared secret
cannot be decrypted.

### Builder Tailscale credential and tailnet grants

The builder joins the tailnet as the stable node `linux-builder` with
MagicDNS name `linux-builder.tuxedo-musical.ts.net` and the dedicated tag
`tag:linux-nix-remote-builder`. Enrollment uses the builder-specific OAuth
client from the table, separate from the Fabro guest's client:

- The client must have the `auth_keys` scope and be authorized to apply
  `tag:linux-nix-remote-builder`.
- Only its client secret is mirrored, as `builder-tailscale-oauth-secret` in
  the builder store.
- On the guest, `builder-tailscale-auth.service` waits for
  `sops-install-secrets.service` and `tailscaled.service`, then reads
  `/run/secrets/builder-tailscale-oauth-secret` and runs `tailscale up
  --hostname=linux-builder --advertise-tags=tag:linux-nix-remote-builder
  --accept-dns=false` with the secret as the auth key. The node is
  persistent, not ephemeral, so its identity survives guest restarts.
- Rotation affects future enrollments only. An already-registered guest keeps
  its node until `sudo tailscale logout` runs in-guest; restart
  `builder-tailscale-auth.service` afterwards to enroll with the new
  credential.

Tag ownership and the SSH-only grants are **external tailnet policy**: they
live in the Tailscale admin console (or the operator's policy-as-code source),
not in this repository, and this runbook does not create, edit, or commit
them. Mirror the macOS builder's model with the Linux builder's own tag and
both client identities:

```json
{
  "hosts": {
    "brandons-macbook-pro": "100.x.y.z"
  },
  "tagOwners": {
    "tag:linux-nix-remote-builder": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:fabro", "brandons-macbook-pro"],
      "dst": ["tag:linux-nix-remote-builder"],
      "ip": ["tcp:22"]
    }
  ]
}
```

Merge these entries into the existing policy and preserve every other entry.
`tag:fabro` is the Fabro guest's existing tag. A host alias is referenced by
its bare name in `src`. The personal Mac is untagged, so it is selected
through such an alias: read its tailnet IPv4 address on the Mac and use it in
place of the sample address above (the alias name itself is free-form; the
one shown only mirrors the host's name):

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json \
  | jq -r '.Self.TailscaleIPs[0]'
```

The grant controls reachability only: SSH client keys authenticate the
session and the pinned host key verifies the builder. Tailscale SSH is not
used (the guest joins without `--ssh`).

Verify resolution and TCP/22 reachability from both clients —
`getent ahostsv4 linux-builder.tuxedo-musical.ts.net` must resolve in the
NixOS guest and `dscacheutil -q host -a name
linux-builder.tuxedo-musical.ts.net` on the Mac; an allowed client's
`nc -vz linux-builder.tuxedo-musical.ts.net 22` (or an equivalent bash
`/dev/tcp` probe in the guest) must connect. Confirm an identity that is
neither `tag:fabro` nor the aliased Mac cannot reach TCP/22.

### Verifying the stores and the guest

Decrypt only the key being checked, and never print a private or OAuth value.
The builder store is readable with the builder age key from 1Password:

```sh
T=$(mktemp -d); chmod 0700 "$T"; trap 'rm -rf "$T"' EXIT
op read 'op://Private/sops-age-key-linux-builder/notesPlain' > "$T/key.txt"
# Public keys only: safe to print.
SOPS_AGE_KEY_FILE="$T/key.txt" nix shell --inputs-from . nixpkgs#sops -c \
  sops -d --extract '["builder-authorized-keys"]' \
  secrets/remote-builder.linux-builder.yaml
# Length only: never print the OAuth value.
SOPS_AGE_KEY_FILE="$T/key.txt" nix shell --inputs-from . nixpkgs#sops -c \
  sops -d --extract '["builder-tailscale-oauth-secret"]' \
  secrets/remote-builder.linux-builder.yaml | wc -c
```

The first output must be the newline-separated public keys of the Fabro and
personal Mac clients; compare each line with the public half of the matching
keypair — `ssh-keygen -y -f <private-key-copy>` prints only that public half.
The second output must be a positive byte count with no embedded newline.

The personal client store is readable with the personal host's key, which
sops-nix installs at `/var/lib/sops-nix/key.txt`:

```sh
T=$(mktemp -d); chmod 0700 "$T"; trap 'rm -rf "$T"' EXIT
SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt \
  nix shell --inputs-from . nixpkgs#sops -c \
  sops -d --extract '["linux-builder-client-key"]' \
  secrets/linux-builder-client.personal.yaml > "$T/key"
chmod 0600 "$T/key"
ssh-keygen -y -f "$T/key"   # prints only the public half
```

The Fabro store needs the fabro host's age key from 1Password (the Mac's
`/var/lib/sops-nix/key.txt` cannot open it). Use the same
`SOPS_AGE_KEY_FILE` pattern as "Editing / rotating" in the Fabro host store
section above, with `--extract '["linux-builder-client-key"]'`.

On the guest, confirm sops-nix materialized the secrets and the consuming
units are active:

```sh
lima-vmctl shell linux-builder sudo -n stat -c '%a %U' /run/secrets/builder-authorized-keys
lima-vmctl shell linux-builder sudo -n stat -c '%a %U' /home/builder/.ssh/authorized_keys
lima-vmctl shell linux-builder sudo -n stat -c '%a %U' /run/secrets/builder-tailscale-oauth-secret
lima-vmctl shell linux-builder systemctl is-active sshd builder-authorized-keys tailscaled builder-tailscale-auth
lima-vmctl shell linux-builder sudo -n tailscale status --json \
  | jq -e '.Self.DNSName | startswith("linux-builder.")'
```

`stat` must report `400 root` for the `/run/secrets` files and `600 builder`
for `authorized_keys`. `builder-authorized-keys.service` fails closed when the
secret is missing or empty, and `sshd` is ordered after it, so a builder
without authorized keys does not accept SSH sessions.

### Host-key pin

The builder's SSH host key is generated on the guest at the persistent path
declared by `services.openssh.hostKeys`, `/var/lib/ssh/ssh_host_ed25519_key`.
That path is outside the Nix store, so the host identity survives VM restarts.
Only its public half is trust material for the clients:

```sh
lima-vmctl shell linux-builder sudo -n cat /var/lib/ssh/ssh_host_ed25519_key.pub
```

Create `certificates/linux-builder/` and save that single line as
`certificates/linux-builder/ssh_host_ed25519_key.pub`, then `git add` and
commit it before deploying either client. Never copy the private host key out
of the guest and never commit the private host key; never generate a
replacement pin to work around a mismatch.

Both clients embed the base64 of the pin file as the machine record's
host-key field: Fabro's `fabro-darwin-builders.service` renderer and the
personal Mac's generated `nix-builders` file. Fabro's service fails closed if
the pin is missing, unreadable, or not a single-line `ssh-ed25519` public key,
and `nix.settings.builders = @/run/fabro-darwin-builders/machines` then refers
to a file the daemon cannot load, so the guest fails rather than falling back
to local builds. The personal Mac evaluates with a warning and omits the
host-key field until the pin exists, so its builds fail closed instead of
trusting an unverified host.

Verify the pin matches the live guest:

```sh
ssh-keygen -lf certificates/linux-builder/ssh_host_ed25519_key.pub
lima-vmctl shell linux-builder sudo -n \
  ssh-keygen -lf /var/lib/ssh/ssh_host_ed25519_key.pub
```

The two fingerprints must be identical. A mismatch is a hard failure: stop,
compare the guest's key with the committed pin, and treat a changed key as a
deliberate operator review. Never disable host-key checking, and never point
the machine record at an unpinned host as a workaround.

### Live acceptance after provisioning

Run this after the builder is deployed, the pin is committed, both clients
have switched, and the tailnet grants are active. Every check is read-only
except the no-fallback check, which stops and restarts the builder.

**1. Linux build from the Fabro guest.** The Fabro guest cannot build
`aarch64-linux` locally (`max-jobs = 0`), so a returned output proves the
Linux route:

```sh
out=$(lima-vmctl shell fabro nix build --no-link --print-out-paths --impure \
  --expr 'derivation { name = "linux-builder-acceptance"; system = "aarch64-linux"; builder = "/bin/sh"; args = [ "-c" "echo linux-builder > $out" ]; }')
lima-vmctl shell linux-builder test -e "$out" && echo "linux build ran on linux-builder"
```

**2. Linux build from `Brandons-MacBook-Pro`.** Run from the repo checkout on
the Mac; the returned output must exist in the builder's store:

```sh
out=$(nix build --no-link --print-out-paths --impure \
  --expr 'derivation { name = "linux-builder-acceptance-mac"; system = "aarch64-linux"; builder = "/bin/sh"; args = [ "-c" "echo linux-builder > $out" ]; }')
lima-vmctl shell linux-builder test -e "$out" && echo "linux build ran on linux-builder"
```

**3. Darwin dispatch is preserved.** From the Fabro guest, an
`aarch64-darwin` derivation must still return through the existing mac-builder
entry (Fabro cannot build Darwin locally either, so success proves the Darwin
route):

```sh
lima-vmctl shell fabro nix build --no-link --print-out-paths --impure \
  --expr 'derivation { name = "mac-builder-acceptance"; system = "aarch64-darwin"; builder = "/bin/sh"; args = [ "-c" "echo mac-builder > $out" ]; }'
```

The existing `ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net
aarch64-darwin …` record in `/run/fabro-darwin-builders/machines` must be
unchanged. A Darwin build that starts failing for Linux-entry reasons means
the Linux record disturbed the Darwin record.

**4. Unsupported platforms are rejected.** No machine record advertises
`x86_64-linux`, and the builder sets `extra-platforms = [ ]`. From either
client:

```sh
nix build --no-link --impure --expr 'derivation { name = "unsupported-linux-platform"; system = "x86_64-linux"; builder = "/bin/sh"; args = [ "-c" "echo no > $out" ]; }'
```

Expect a nonzero exit naming the requested platform and the client's own
system (`a 'x86_64-linux' … is required to build … but I am a
'aarch64-linux'` on Fabro, `'aarch64-darwin'` on the Mac). A success, or a
build attempted on the Linux builder, means the machine record advertises
more than `aarch64-linux`.

**5. Fabro has no local fallback.** Stop the builder cleanly, then request a
Linux build on Fabro. The build must fail without producing the output
locally; `nix.settings.max-jobs = 0` is what makes that the intentional
behavior:

```sh
lima-vmctl stop linux-builder          # clean stop; launchd leaves it stopped
lima-vmctl shell fabro nix build --no-link --impure \
  --expr 'derivation { name = "linux-builder-outage"; system = "aarch64-linux"; builder = "/bin/sh"; args = [ "-c" "echo local > $out" ]; }'
lima-vmctl shell fabro grep '^max-jobs' /etc/nix/nix.conf   # max-jobs = 0
```

Expect a nonzero exit from the build naming the remote builder or the SSH
transport (`Connection refused`, `Could not resolve hostname`, or a remote
build failure). A locally built output is a policy regression: check that
`max-jobs` is still `0` and that the Linux machine record was not dropped.

Restore supervision by restarting the launchd agent — a clean stop exits 0,
so launchd itself does not restart the VM:

```sh
launchctl kickstart "gui/$(id -u)/dev.dwsr.lima-linux-builder"
lima-vmctl list linux-builder    # wait until the instance reports Running
```

Then repeat check 1 to confirm the builder is serving builds again.

### Rotating builder secrets

- **Client key.** Generate a new dedicated keypair out of band, replace that
  client's private key in its 1Password SSH Key item, replace only that key's
  public half in the authorized-keys note, and re-run
  `nix run '.#linux-builder-sync-from-1password'` (plus
  `nix run '.#fabro-sync-from-1password'` when the Fabro key rotates). Then
  redeploy the guest and the affected client. Preserve every other authorized
  key and never drop the builder store's recipient.
- **Tailscale credential.** Replace the client secret in 1Password, re-run the
  builder sync, and re-enroll only if a new registration is intended (an
  existing node keeps its identity until `sudo tailscale logout`).
- **Builder age key.** Generate a new identity, update 1Password and the
  `&host_linux_builder` recipient in `.sops.yaml`, install the new key at
  `/var/lib/sops-nix/key.txt` on the guest, and re-run the builder sync so the
  builder store is re-encrypted to the new recipient (the personal store is
  re-encrypted to `&host_personal` as usual). Keep the previous age key in
  1Password until the re-encrypted store decrypts with the new key: the sync
  replaces the file by rename, so the old ciphertext only survives in git
  history and stays readable only with the old key.

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

Encrypted-store edits should use the devshell wrapper instead of raw
`sops`:

```sh
nix develop -c sops-nix-sudo <sops-arguments>
```

The wrapper runs the pinned `sops` binary under `sudo` with
`SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt`, so it can read the
root-owned sops-nix age key and is not affected by sudo's PATH reset.

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
   yaml against the new recipient:

   ```sh
   nix develop -c sops-nix-sudo updatekeys secrets/mcp.<host>.yaml
   ```

   Commit the changes to `.sops.yaml` AND the re-encrypted secrets
   file together.

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
   nix develop -c sops-nix-sudo updatekeys secrets/mcp.<newname>.yaml
   ```

   `sops-nix-sudo updatekeys` reads `.sops.yaml`, recomputes the
   recipients for the file, and re-wraps the data key against them in
   place. It does not change the underlying secret values.

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
HTTP API (`/api/v1/*`). The opencode wrapper, managed import commands,
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

2. **Edit the encrypted store.** `sops-nix-sudo edit` decrypts
   in-place, drops you into `$EDITOR`, and re-encrypts on save:

   ```sh
   nix develop -c sops-nix-sudo edit secrets/mcp.<host>.yaml
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
   clients that present the new key (opencode wrapper, managed import commands)
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
   `nix develop -c sops-nix-sudo updatekeys secrets/mcp.<host>.yaml`
   to re-encrypt the per-host file against the new recipient. Commit
   and push.

3. On the recovering host: install the new private key (Bootstrap
   step 3), pull the repo, and `sudo darwin-rebuild switch
   --flake .`.

If both hosts have lost their keys at the same time, recovery
requires re-creating every secret value from the upstream system
(rotate everything in 1P, then sync), since the existing
`secrets/mcp.<host>.yaml` files are no longer decryptable by
anyone. This is a deliberate trade-off — see `requirements.md`
section 9.5.

## Nix GitHub access token

`nix` and `darwin-rebuild` authenticate `github:` flake-input and
tarball fetches with a token read from
`/etc/nix/nix.conf.d/github-access-token.conf`:

```conf
access-tokens = github.com=<token>
```

This reuses the existing `mcp-github-token` secret (the same PAT MCP
and `gh` already use), wired per host via
`home.mcp.nixAccessTokenSecret = "mcp-github-token"`. The token is
NEVER placed in `nix.settings.access-tokens`, which would serialize it
into the world-readable Nix store; it lives only in the file below,
which `nix.extraOptions` pulls in with an optional `!include`.

### How it is maintained (steady state)

On every `darwin-rebuild switch`, the SOPS bridge
(`mcp-secrets-activate`) decrypts `mcp-github-token` to
`/run/secrets/mcp-github-token` and rewrites
`/etc/nix/nix.conf.d/github-access-token.conf` from it. The file is
owned by your login user at mode `0600`: Nix reads `access-tokens` in
the user's client process during flake-input evaluation, while the
root `nix-daemon` can still read it via superuser. Rotation is
automatic — rotating `mcp-github-token` (see "Rotating a secret")
re-renders this file as a side effect; there is no separate step.

### Bootstrap (no Nix required)

The steady-state path needs Nix installed and the host's age key in
place. On a fresh host you may need the token for Nix *before* either
exists — e.g. so the first `darwin-rebuild switch` can fetch private
`github:` inputs. Seed the file directly from 1Password with the
standalone helper, which uses only `op` and base macOS tools (no nix,
jq, or git):

```sh
./scripts/bootstrap-nix-github-token.sh <shopify|personal>
```

It writes the exact same file the bridge later manages, so the first
post-bootstrap switch is a content no-op.

The `!include` in `nix.conf` only becomes active once a configuration
with `home.mcp.nixAccessTokenSecret` set has been activated. If the
*very first* switch itself needs the private token (before that
`!include` exists), pass it inline for that one invocation — this
reads straight from 1Password, so the token is never written to shell
history:

```sh
# shopify (use the personal URI / --flake path on the personal host)
sudo env NIX_CONFIG="extra-access-tokens = github.com=$(op read --no-newline 'op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub')" \
  darwin-rebuild switch --flake .
```

After that first switch, the file and its `!include` are both in
place and every later `nix` / `darwin-rebuild` invocation reads the
token automatically.

### Verify

```sh
# File exists, owned by you, mode 0600:
ls -l /etc/nix/nix.conf.d/github-access-token.conf

# Nix is reading it. NOTE: `nix config show access-tokens` prints the
# token value to the terminal; prefer just confirming the setting is
# populated without echoing it:
nix config show | grep -q '^access-tokens = .*github\.com=' && echo "access-tokens: set"
```

### Disable on a host

Set `home.mcp.nixAccessTokenSecret = null` and switch; the `!include`
is dropped from `nix.conf`. The activation script does not delete the
now-unreferenced file, so remove it by hand:

```sh
sudo rm -f /etc/nix/nix.conf.d/github-access-token.conf
```

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

- `scripts/bootstrap-nix-github-token.sh` — no-Nix 1Password seeder
  for the Nix GitHub access-token file.
- `scripts/linux-builder-sync-from-1password.nix` — builder and personal
  Linux-builder client store sync from the 1Password sources above.
- Repo-root `.sops.yaml` — the recipient policy file.
- `.kiro/specs/create-a-linux-nix-remote-builder-instance/design.md` —
  Linux builder architecture, data contracts, and its
  `## Operator Provisioning` table.
- `.kiro/specs/mcp-secrets-sops-nix/requirements.md` sections 3.4,
  9.1–9.5 — the underlying requirements this runbook satisfies.
- `.kiro/specs/mcp-secrets-sops-nix/design.md` — architecture and
  flow diagrams.
