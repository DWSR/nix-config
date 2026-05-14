# sqlite-backup Operator Runbook

Operator-facing procedures for the SQLite Backup pipeline declared in
`home-manager/common/sqlite-backup.nix` and verified at
`darwin-rebuild switch` time by
`configurations/common-darwin/sqlite-backup-verify.nix`. Recovery
procedures (point-in-time, host-loss, etc.) are owned by Task 7.2 and
will be appended to this file.

## Overview

The pipeline replicates each configured SQLite database to an
encrypted off-host destination via three composed tools:

- **Litestream** — long-running daemon per database, captures
  committed WAL pages into a per-DB staging directory under
  `${XDG_DATA_HOME}/sqlite-backup/litestream-staging/<db>/`.
- **restic** — local repository at
  `${XDG_DATA_HOME}/sqlite-backup/restic/<db>/`; one repo per database
  to keep dedup boundaries clean.
- **rclone** — config at `~/.config/rclone/rclone.conf` (encrypted),
  used by `restic`'s `rclone:<remote>:<path>` backend to ship the
  local repo off-host. The same restic repo is mirrored to the
  off-host destination via `restic copy`.

Two passphrases gate the pipeline:

- `sqlite-backup-archive-passphrase` — the symmetric passphrase
  restic uses for every snapshot in both the local and the off-host
  repository.
- `sqlite-backup-rclone-config-passphrase` — the passphrase
  protecting `~/.config/rclone/rclone.conf`.

Both passphrases live in 1Password, are mirrored into
`secrets/mcp.<host>.yaml` by `mcp-sync-from-1password`, and are
landed in the user's macOS login Keychain (account `mcp-hub`) by the
`mcp-sops-bridge` activation hook. The CLI and the verification
hook read both via `/usr/bin/security find-generic-password`.

When to use this runbook:

- **Initial host bootstrap** — Section A. One-time per host. The
  module is currently dormant on both darwin hosts; this section
  takes a host from "dormant" to "first successful scheduled
  archive-tier run".
- **Adding a new database** — Section B. Repeatable; once per
  database per host.
- **Day-to-day operator commands** — Section C. The complete
  surface of the `sqlite-backup` CLI binary on `$PATH`.
- **Recovering from a backup** — owned by Task 7.2 (not yet in this
  file).

## Section A — One-Time Per-Host Bootstrap

Phases are STRICTLY ORDERED. In particular, Phases 1 and 2
(passphrase stash + sops sync) MUST complete before Phase 6
(`darwin-rebuild switch`). The keychainSecrets entries declared by
the module reference yaml keys that do not yet exist on a fresh
host; activating before the yaml is in place will fail at
`mcp-secrets-activate` because sops cannot decrypt yaml keys that
are not present, and `mcp-sops-bridge` cannot populate Keychain
entries it cannot read.

### A.1 Prerequisites

- Both darwin hosts have the module landed in dormant state
  (`configurations/{personal,shopify}/home-manager/sqlite-backup.nix`
  declares `enable = true; databases = [ ]; rcloneDestinations = { };`).
- `op` (1Password CLI) is signed in on the host. Verify with
  `op whoami`.
- The host's per-host age private key is installed at
  `/var/lib/sops-nix/key.txt` (per `secrets/README.md` Bootstrap).
- An active GUI session (Phases 6 and 7 write to and read from the
  user's login Keychain — see `secrets/README.md` Prerequisites).

Decide which 1Password vault holds the passphrases. The module
defaults to `op://Private/...` (matches the `personal` host). On the
`shopify` host where secrets live in vault `Employee`, you will
also override `home.mcp.keychainSecrets` in the per-host scaffold
(Phase 5).

### A.2 Phase 1 — Generate and stash both passphrases in 1Password

Generate two strong, distinct passphrases. `openssl rand -base64 33`
gives a paste-safe 44-character string; use whatever generator you
trust.

```sh
openssl rand -base64 33 | tr -d '\n' | pbcopy   # archive passphrase
openssl rand -base64 33 | tr -d '\n' | pbcopy   # rclone config passphrase
```

Stash each in 1Password under the canonical titles. The field path
on each URI MUST be `/passphrase` to match the HM module defaults
at `home-manager/common/sqlite-backup.nix:503-504`:

| Passphrase | 1P URI (`personal` host) | 1P URI (`shopify` host) |
|---|---|---|
| restic archive  | `op://Private/sqlite-backup-archive/passphrase`        | `op://Employee/sqlite-backup-archive/passphrase`        |
| rclone config   | `op://Private/sqlite-backup-rclone-config/passphrase`  | `op://Employee/sqlite-backup-rclone-config/passphrase`  |

The field name `passphrase` (rather than the Password category's
default `password`) is intentional: these strings are restic / rclone
encryption passphrases, not user-account passwords. Naming the field
`passphrase` lets the URI read straightforwardly and avoids any
implication that you can rotate them like an account password.

`op item create` defaults the field name from `--category`. To force
a custom field name (`passphrase`) inside a Password item, use the
section-field assignment syntax `passphrase[password]=<value>`. The
`[password]` type marker keeps the field concealed in the 1Password
UI:

```sh
PHRASE_ARCHIVE="$(openssl rand -base64 33 | tr -d '\n')"
op item create --vault=<Private|Employee> --category=password \
  --title=sqlite-backup-archive       "passphrase[password]=$PHRASE_ARCHIVE"
unset PHRASE_ARCHIVE

PHRASE_RCLONE="$(openssl rand -base64 33 | tr -d '\n')"
op item create --vault=<Private|Employee> --category=password \
  --title=sqlite-backup-rclone-config "passphrase[password]=$PHRASE_RCLONE"
unset PHRASE_RCLONE
```

Verify the round-trip — `op read` MUST resolve at the
`/passphrase` path:

```sh
op read 'op://<vault>/sqlite-backup-archive/passphrase' | wc -c          # expect ~44
op read 'op://<vault>/sqlite-backup-rclone-config/passphrase' | wc -c    # expect ~44
```

Discard the in-shell copies. The 1Password copy is now the source
of truth.

### A.3 Phase 2 — Sync passphrases into `secrets/mcp.<host>.yaml`

If you are overriding the URI on the `shopify` host (Phase 5),
land that override BEFORE running the sync — `mcp-sync-from-1password`
reads `home.mcp.keychainSecrets` from the evaluated darwin
configuration to discover both the keys to write and the URIs to
read. If you are on the `personal` host with the default URIs, this
ordering is moot.

From a workstation checkout (or the host itself):

```sh
nix run '.#mcp-sync-from-1password' -- <host>     # <host> = personal | shopify
```

Verify the new keys landed:

```sh
sops --decrypt secrets/mcp.<host>.yaml | grep '^sqlite-backup-'
# Expected:
#   sqlite-backup-archive-passphrase: '...'
#   sqlite-backup-rclone-config-passphrase: '...'
```

Commit:

```sh
git add secrets/mcp.<host>.yaml
git commit -m "secrets(<host>): add sqlite-backup passphrases"
```

The yaml keys (`sqlite-backup-archive-passphrase`,
`sqlite-backup-rclone-config-passphrase`) MUST match the
`archivePassphraseSecret` / `rcloneConfigPassphraseSecret` option
defaults in `home-manager/common/sqlite-backup.nix:202-221`. If you
have overridden either option in the per-host scaffold, the yaml
key must match the override.

### A.4 Phase 3 — Bootstrap rclone destinations interactively

`rclone config` is fully interactive (browser OAuth dance for cloud
backends). Run it ONCE per backend you want to ship to. From the
host:

```sh
rclone config
```

Walk through `n` (new remote) → name (e.g. `gdrive`) → backend type
(e.g. `drive`) → backend-specific prompts. For OAuth backends
(Google Drive, OneDrive, Dropbox, etc.), rclone will print a URL
and either auto-launch the browser or wait for a paste-back token.
Complete the flow.

Repeat for every destination you intend to declare in Phase 5.
Verify the result:

```sh
rclone listremotes
# Expected: each remote name on its own line, suffixed with `:`
```

### A.5 Phase 4 — Encrypt the rclone config

```sh
rclone config encryption set
# Prompts for the passphrase twice; paste the rclone-config
# passphrase from Phase 1 (`op read 'op://<vault>/sqlite-backup-rclone-config/passphrase'`).
```

Verify:

```sh
RCLONE_PASSWORD_COMMAND="op read 'op://<vault>/sqlite-backup-rclone-config/passphrase'" \
  rclone config encryption check
# Expected: exit 0, no output
```

If `rclone config encryption check` fails, either the config is
still plaintext (the encryption set step did not commit) or the
passphrase you supplied does not match what rclone was encrypted
with. Re-run `rclone config encryption set` (or
`rclone config encryption remove` first) before proceeding.

### A.6 Phase 5 — Declare destinations in the per-host scaffold

Edit the per-host scaffold:

- `personal` host → `configurations/personal/home-manager/sqlite-backup.nix`
- `shopify` host → `configurations/shopify/home-manager/sqlite-backup.nix`

Add one entry per rclone remote you bootstrapped in Phase 3, plus
any non-default keychainSecrets URI overrides:

```nix
_: {
  home.sqliteBackup = {
    enable = true;
    rcloneDestinations = {
      gdrive = { type = "drive"; };
      # b2-east = { type = "b2"; hard_delete = "true"; };  # extra example
    };
    databases = [ ];   # leave empty for now; databases land in Section B
  };

  # ONLY on the shopify host, override the default URIs to vault Employee.
  # On the personal host, omit this whole block — the module defaults
  # at home-manager/common/sqlite-backup.nix:503-504 already point at
  # op://Private/sqlite-backup-{archive,rclone-config}/passphrase, which
  # matches what Phase 1 stashed.
  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase        = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase  = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
```

The destination `name` keys (e.g. `gdrive`) MUST match the rclone
remote names from Phase 3 EXACTLY — the R17 verification hook
compares manifest declarations against `rclone listremotes --long
--json`. The destination `type` field MUST match the rclone backend
type used in `rclone config`; mismatch is an R17.4 failure.

Commit the scaffold change.

### A.7 Phase 6 — Activate

```sh
sudo darwin-rebuild switch --flake .
```

Activation flow:

1. sops-nix decrypts `secrets/mcp.<host>.yaml`.
2. `mcp-sops-bridge` (at `lib.mkOrder 9999`) populates Keychain
   entries `sqlite-backup-archive-passphrase` and
   `sqlite-backup-rclone-config-passphrase` under account `mcp-hub`.
3. `sqlite-backup-verify` (at `lib.mkOrder 10000`, fires only when
   `enable && databases != [ ]`) is currently a no-op because
   `databases = [ ]`. R17 verification will only become active in
   Section B Phase 2 below, when you add the first database.

Confirm both Keychain entries are present:

```sh
/usr/bin/security find-generic-password -s sqlite-backup-archive-passphrase       -a mcp-hub -w >/dev/null && echo OK
/usr/bin/security find-generic-password -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w >/dev/null && echo OK
```

If either command fails, sops or the bridge did not run cleanly —
check `/var/log/system.log` and `secrets/mcp.<host>.yaml` for the
expected keys.

### A.8 Phase 7 — Verify rclone credentials

```sh
sqlite-backup verify-credentials
# Expected on a host with no databases yet:
#   exit 0, no output (vacuous-truth: all 0 destinations succeeded)
```

This is a vacuous pass on a host with `databases = [ ]` — the per-
destination loop has nothing to iterate over. The interesting
verification will fire in Section B Phase 3 once a database is
declared. To prove the credentials work BEFORE adding a database,
exercise the same primitive directly:

```sh
RCLONE_PASSWORD_COMMAND="/usr/bin/security find-generic-password -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w" \
  rclone lsd gdrive:                 # replace gdrive with each declared remote
# Expected: directory listing exits 0
```

A non-zero exit here means the OAuth token expired (re-run
`rclone config reconnect <remote>`), the passphrase mismatch (re-run
`rclone config encryption set`), or the destination is unreachable
(network).

## Section B — Adding a New Database

Once Section A has landed for the host, each subsequent database is
a three-step loop: declare, rebuild, observe.

### B.1 Edit the per-host scaffold

Append a database entry to `home.sqliteBackup.databases`:

```nix
_: { config, ... }: {
  home.sqliteBackup = {
    enable = true;
    rcloneDestinations = { gdrive = { type = "drive"; }; };
    databases = [
      {
        name = "cavemem";
        path = "${config.home.homeDirectory}/.cavemem/data.db";
        remote = "gdrive";
        # remotePath defaults to "sqlite-backup"; override only if needed.
        # replicationTier defaults to { cadenceSeconds = 300; retention = ["--keep-hourly" "24"]; }
        # archiveTier defaults to { schedule = { Hour = 3; Minute = 0; }; retention = ["--keep-daily" "7" ...]; }
      }
    ];
  };
}
```

Constraints (eval-time; failure aborts `darwin-rebuild switch`
before any side effect):

- `databases[*].remote` MUST be a key in `rcloneDestinations`.
- `databases[*].name` MUST be unique within the host (used in
  launchd labels, log paths, lock paths).
- The platform must be darwin (R10).
- `pkgs.litestream.version >= 0.5.7` (R11).

Commit.

### B.2 Activate

```sh
sudo darwin-rebuild switch --flake .
```

This time the activation does more work:

1. `sqlite-backup-verify` runs (R17, now active because
   `databases != [ ]`). It checks both passphrases in Keychain,
   confirms `~/.config/rclone/rclone.conf` exists and is encrypted,
   confirms the rclone passphrase decrypts it, and confirms each
   declared destination exists in the rclone config with the
   expected backend type. Activation fails with a categorized
   error and one of exit codes `11..15` if any check fails — see
   the docstring at `configurations/common-darwin/sqlite-backup-verify.nix:42-54`.
2. The HM module declares three launchd agents per database:
   - `dev.dwsr.sqlite-backup.litestream.<db>` —
     `KeepAlive = true`, `RunAtLoad = true`. Long-running
     Litestream daemon replicating `<db>.path` into the staging
     dir.
   - `dev.dwsr.sqlite-backup.replicate.<db>` — fires every
     `replicationTier.cadenceSeconds` (default 300s).
   - `dev.dwsr.sqlite-backup.archive.<db>` — fires on
     `archiveTier.schedule` (default 03:00 daily).
3. The halt-flag clearing activation hook runs (idempotent).

Verify the agents are loaded:

```sh
launchctl list | grep dev.dwsr.sqlite-backup
# Expected: three lines per database (litestream, replicate, archive)
```

### B.3 First scheduled cycle auto-inits the remote restic repo

Wait for the next replicate-tier tick (default: within 5 minutes
of activation; check `StartInterval` in your scaffold if you tuned
the cadence).

On the first invocation of `__replicate-trigger <db>`, the wrapper:

1. Initializes the LOCAL restic repo at
   `${XDG_DATA_HOME}/sqlite-backup/restic/<db>` if it does not
   exist (`restic init`).
2. Initializes the REMOTE restic repo at
   `rclone:<remote>:<remotePath>/<db>` if it does not exist, using
   `restic init --copy-chunker-params --from-repo <local-repo>`.
   The `--copy-chunker-params` flag copies the chunker polynomial
   from the local repo into the remote repo, which preserves
   dedup boundaries between the two repos. Without this flag,
   `restic copy` would re-chunk every blob and balloon the
   off-host transfer.
3. Runs `restic backup --tag replication ${stagingDir}` against
   the local repo.
4. Runs `restic copy --from-repo <local-repo> --repo
   rclone:<remote>:<remotePath>/<db>` to ship the new snapshot
   off-host.
5. Runs the retention policy on both repos.

Inspect the logs:

```sh
tail -F ~/Library/Logs/sqlite-backup-<db>-replicate.log
tail -F ~/Library/Logs/sqlite-backup-<db>-replicate.error.log
```

Look for: `restic init` lines (first run only), then
`Files: ... new` and `processed ... in ...` blocks per cycle.

The first archive-tier cycle fires at `archiveTier.schedule`
(default 03:00 next morning). Logs land at
`~/Library/Logs/sqlite-backup-<db>-archive.{log,error.log}`.

You can shortcut the wait:

```sh
sqlite-backup backup <db>
# Runs the archive-tier flow immediately, regardless of halt state.
```

### B.4 Confirm steady state

```sh
sqlite-backup status <db>
# Expected columns: name, replication-state, last-archival-snapshot-timestamp,
# last-replicate-shipment-timestamp.

sqlite-backup verify-credentials <db>
# Expected: <remote>:<remotePath>/<db>: OK   (exit 0)
```

You are now at "first successful scheduled archive-tier run".

## Section C — Common Operator Commands

Every command is on `$PATH` after a successful `darwin-rebuild
switch`. No `nix run` / `home-manager` / `darwin-rebuild` wrapper
required (R13.AC2). All read the manifest baked into the binary at
derivation time, so commands are self-contained.

| Command | Purpose |
|---|---|
| `sqlite-backup list` | One configured database name per line. Empty stdout + exit 0 when no databases declared. |
| `sqlite-backup status [<db>]` | Per-DB table: name, replication state, last archive snapshot, last replicate shipment. Always exit 0. |
| `sqlite-backup backup <db>` | One-shot archive-tier run. Bypasses any halt flag. Exit non-zero on pipeline failure. |
| `sqlite-backup restore <db> [--target <path>] [--time <ts>] [--from-remote] [--force]` | Two-stage restore: `restic restore` of staging dir, then `litestream restore -o <target>`. Defaults: `--target ${PWD}/<db>-restored.db`, `--time latest`, local repo. Refuses to overwrite a non-empty target without `--force`. (Detail in Task 7.2.) |
| `sqlite-backup start <db>` | Clear halt flag. Bootstraps the per-DB Litestream agent if it was unloaded by `stop`. Idempotent. |
| `sqlite-backup stop <db> [--include-archive]` | Halts replication-only by default; `--include-archive` halts the whole pipeline. Unloads the Litestream agent via `launchctl bootout`. Idempotent. |
| `sqlite-backup verify-credentials [<db>]` | Read-only credential probe per destination. Pre-flights `rclone config encryption check`; reports per-destination `OK` / `FAIL: <cause>` to stdout. Exit 0 iff every check passed. |

State locations referenced by these commands:

- Halt flags: `${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup/halt-<db>.flag`.
  Cleared by every HM activation (R13.AC15).
- Per-DB lockfiles: `${TMPDIR:-/var/tmp}/sqlite-backup-<db>.lock`.
  Held by whichever wrapper (replicate / archive / on-demand backup)
  is currently inside the restic critical section.
- Logs: `~/Library/Logs/sqlite-backup-<db>-{litestream,replicate,archive}.{log,error.log}`.
- Local restic repo: `${XDG_DATA_HOME}/sqlite-backup/restic/<db>/`.
- Litestream staging dir: `${XDG_DATA_HOME}/sqlite-backup/litestream-staging/<db>/`.
- Encrypted rclone config: `~/.config/rclone/rclone.conf`.
- Manifest JSON (consumed by CLI + verify hook): rendered into the
  Nix store at HM build time; path exposed via
  `home.sqliteBackup._manifestPath`.

## Section D — Recovery

Owned by Task 7.2 — to be appended.
