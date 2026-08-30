# sqlite-backup Operator Runbook

Operator-facing procedures for the SQLite Backup pipeline declared in
`home-manager/common/sqlite-backup.nix` and verified at
`darwin-rebuild switch` time by
`configurations/common-darwin/sqlite-backup-verify.nix`. Includes
recovery procedures for every loss scenario (Section D).

## Overview

The pipeline replicates each configured SQLite database to an
encrypted off-host destination via three composed tools:

- **Litestream** — long-running daemon per database, captures
  committed WAL pages into a per-DB staging directory under
  `${XDG_DATA_HOME}/sqlite-backup/<db>/litestream-staging/`.
- **restic** — local repository at
  `${XDG_DATA_HOME}/sqlite-backup/<db>/restic/`; one repo per database
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
- **Recovering from a backup** — Section D. One subsection per
  scenario (latest, point-in-time, host-loss, off-host
  unreachable), each with both a `sqlite-backup` one-liner and the
  underlying `restic`/`litestream` decomposition.

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
2. The HM module declares four launchd agents per database:
   - `dev.dwsr.sqlite-backup.litestream.<db>` —
     `KeepAlive = true`, `RunAtLoad = true`. Long-running
     Litestream daemon replicating `<db>.path` into the staging
     dir.
   - `dev.dwsr.sqlite-backup.replicate.<db>` — fires every
     `replicationTier.cadenceSeconds` (default 300s).
   - `dev.dwsr.sqlite-backup.archive.<db>` — fires on
     `archiveTier.schedule` (default 03:00 daily).
   - `dev.dwsr.sqlite-backup.guard.<db>` — runs at load and every
     `pressureGuard.checkIntervalSeconds` (default 60s), independently of the
     backup schedules.
3. The manual halt-flag clearing activation hook runs (idempotent). Persistent
   `pressure-<db>.json` emergency markers are preserved.

Verify the agents are loaded:

```sh
launchctl list | grep dev.dwsr.sqlite-backup
# Expected: four lines per database (litestream, replicate, archive, guard)
```

### B.3 First scheduled cycle auto-inits the remote restic repo

Wait for the next replicate-tier tick (default: within 5 minutes
of activation; check `StartInterval` in your scaffold if you tuned
the cadence).

On the first invocation of `__replicate-trigger <db>`, the wrapper:

1. Runs the disk-pressure guard before acquiring the backup lock. A violated
   threshold persists `pressure-<db>.json`, unloads Litestream, and skips the
   backup. A measurement error does the same and exits non-zero.
2. Initializes the LOCAL restic repo at
   `${XDG_DATA_HOME}/sqlite-backup/<db>/restic` if it does not
   exist (`restic init`).
3. Initializes the REMOTE restic repo at
   `rclone:<remote>:<remotePath>/<db>` if it does not exist, using
   `restic init --copy-chunker-params --from-repo <local-repo>`.
   The `--copy-chunker-params` flag copies the chunker polynomial
   from the local repo into the remote repo, which preserves
   dedup boundaries between the two repos. Without this flag,
   `restic copy` would re-chunk every blob and balloon the
   off-host transfer.
4. Runs `restic backup --tag replication ${stagingDir}` against
   the local repo.
5. Runs `restic copy --from-repo <local-repo> --repo
   rclone:<remote>:<remotePath>/<db>` to ship the new snapshot
   off-host.
6. Runs the retention policy on both repos.

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
# Runs the archive-tier flow immediately, bypassing manual halts only.
# Pressure markers and a newly-failed guard still block the run.
```

### B.4 Confirm steady state

```sh
sqlite-backup status <db>
# Expected fields: name, replication-state, halt-reason, pressure-state,
# last-replication-snapshot, last-archive-snapshot.

sqlite-backup verify-credentials <db>
# Expected: <remote>:<remotePath>/<db>: OK   (exit 0)
```

You are now at "first successful scheduled archive-tier run".

### B.5 Shopify local Google Drive destination

Shopify database entries use rclone's synthetic `:local:` backend with this
destination root:

```text
~/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/sqlite-backup
```

Restic initializes one repository below that root per database. Backup
processes perform no direct Google Drive remote calls; Drive for desktop owns
background synchronization. A successful backup or `verify-credentials` run
proves only that the local File Provider folder is accessible and updated. It
does not prove that Google Drive has uploaded the changes. This reliability gap
is accepted to prevent Drive API quota and retry backpressure from blocking the
local pipeline.

The pressure guard includes each local destination repository in its managed
byte total. The 128 GiB OpenCode ceiling therefore covers both the primary local
restic repository and the copy under the Drive File Provider root.

## Section C — Common Operator Commands

Every command is on `$PATH` after a successful `darwin-rebuild
switch`. No `nix run` / `home-manager` / `darwin-rebuild` wrapper
required (R13.AC2). All read the manifest baked into the binary at
derivation time, so commands are self-contained.

| Command | Purpose |
|---|---|
| `sqlite-backup list` | One configured database name per line. Empty stdout + exit 0 when no databases declared. |
| `sqlite-backup status [<db>]` | Per-DB table including replication state, halt reason, and pressure state. `transition-active` means a guard is serializing with backup work, not that a threshold was crossed. Always exit 0. |
| `sqlite-backup backup <db>` | One-shot archive-tier run. Bypasses manual halt flags, but skips while an emergency pressure marker exists. Exit non-zero on pipeline failure. |
| `sqlite-backup restore <db> [--target <path>] [--time <ts>] [--from-remote] [--force]` | Two-stage restore: `restic restore` of staging dir, then `litestream restore -o <target>`. Defaults: `--target ${PWD}/<db>-restored.db`, `--time latest`, local repo. Refuses to overwrite a non-empty target without `--force`. (Detail in Task 7.2.) |
| `sqlite-backup start <db>` | Refuse an active pressure halt; otherwise clear a manual halt flag and bootstrap the per-DB Litestream agent when unloaded. Idempotent when launchctl confirms it is running. |
| `sqlite-backup stop <db> [--include-archive]` | Halts replication-only by default; `--include-archive` halts the whole pipeline. Unloads the Litestream agent via `launchctl bootout`. Idempotent. |
| `sqlite-backup clear-pressure <db>` | Validate the historical marker, then remeasure the current configured paths and thresholds and remove it only when healthy. Never starts the pipeline. |
| `sqlite-backup verify-credentials [<db>]` | Read-only destination probe. Pre-flights `rclone config encryption check`; synthetic `:local:` destinations check only their local folder and do not verify cloud synchronization. Reports per-destination `OK` / `FAIL: <cause>` to stdout. Exit 0 iff every check passed. |

State locations referenced by these commands:

- Manual halt flags: `${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup/halt-<db>.flag`.
  Cleared by every HM activation (R13.AC15).
- Emergency pressure markers:
  `${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup/pressure-<db>.json`.
  Preserved by HM activation and removed only by `clear-pressure` after current
  free-space and managed-byte measurements satisfy current configured limits.
- Pressure transition locks:
  `${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup/pressure-<db>.lock`.
  A guard write and `clear-pressure` hold this lock while changing marker state;
  its presence also blocks pipeline work. A lock without a JSON marker or
  failed-write sentinel appears as `pressure-state: transition-active`, not a
  disk-pressure halt.
- Failed marker-write sentinels:
  `${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup/pressure-<db>.failed`.
  The next guard or `clear-pressure` remeasures and converts this directory into
  a normal JSON marker before recovery continues.
- Per-DB lockfiles: `${TMPDIR:-/var/tmp}/sqlite-backup-<db>.lock`.
  Held by whichever wrapper (replicate / archive / on-demand backup)
  is currently inside the restic critical section.
- Logs: `~/Library/Logs/sqlite-backup-<db>-{litestream,replicate,archive,guard}.{log,error.log}`.
- Local restic repo: `${XDG_DATA_HOME}/sqlite-backup/<db>/restic/`.
- Litestream staging dir: `${XDG_DATA_HOME}/sqlite-backup/<db>/litestream-staging/`.
- Litestream metadata dir:
  `${XDG_DATA_HOME}/sqlite-backup/<db>/litestream-metadata/`. Litestream's
  generated YAML sets this as `meta-path`; the guard includes it in accounting.
- Encrypted rclone config: `~/.config/rclone/rclone.conf`.
- Manifest JSON (consumed by CLI + verify hook): rendered into the
  Nix store at HM build time; path exposed via
  `home.sqliteBackup._manifestPath`.

### C.1 Recovering an emergency pressure halt

Do not remove `pressure-<db>.json` manually and do not use `start` as a probe.
Resolve the disk-pressure cause first, then run the two explicit transitions:

```sh
sqlite-backup clear-pressure <db>
sqlite-backup start <db>
```

`clear-pressure` validates the marker, then measures filesystem available bytes
and physical allocation using the current manifest's managed paths and limits.
The marker's paths, observations, and limits remain historical audit evidence.
It exits non-zero and preserves the marker if either limit remains violated or
any measurement fails. At equality, the threshold is healthy. A successful
clear removes only the pressure marker; it does not invoke `launchctl`.

`start` prints the exact `clear-pressure` command and exits non-zero while the
marker exists. After a successful clear, `status` reports `not-running` until
the explicit `start` loads the Litestream agent.

### C.2 Disk-pressure policy

The guard sums physical allocated bytes for each database's staging, restic,
and Litestream metadata directories. It also reads available bytes from the
root filesystem. Missing managed paths count as zero; inaccessible paths or
command failures halt the database and return non-zero. A managed root symlink
is dereferenced, but nested symlinks are not. Equality at either limit is
healthy.

ShopifyLaptop uses:

```nix
home.sqliteBackup.pressureGuard = {
  minimumFilesystemAvailableBytes = 128 * 1024 * 1024 * 1024;
  checkIntervalSeconds = 60;
};

# On the OpenCode database entry:
pressureGuard.maximumManagedLocalBytes = 128 * 1024 * 1024 * 1024;
```

The host-wide floor applies to both Shopify databases. Databases without a
specific ceiling use the JSON-safe maximum and are constrained by the floor.
Inspect guard outcomes in
`~/Library/Logs/sqlite-backup-<db>-guard.{log,error.log}`. Every check prints
observed and configured byte values.

## Section D — Recovery Procedures

Recovery is the operator's exit path from "the live SQLite database
file is no longer the source of truth" — whether the cause is
accidental deletion, on-disk corruption, host loss, or wanting to
inspect a prior point-in-time. Each scenario below offers BOTH a
single-line `sqlite-backup restore` invocation AND the underlying
`restic` + `litestream` decomposition (R9.AC2), so an operator can
pick the abstraction layer that matches their confidence: lean on
the CLI for the common case, drop down to the primitives to verify
each step or to recover when the CLI binary itself is unavailable
(e.g., during a Nix rebuild).

The restore is always two-stage: `restic restore` extracts the LTX
staging directory under a tmp prefix, then `litestream restore -o
<target> file://<extracted-staging>` reads those LTX segments and
reconstructs the SQLite database file at `<target>`. The CLI handles
both stages plus tmp-dir cleanup; the manual flows show the same two
stages explicitly.

CLI defaults that are silently applied when omitted (per the
`sqlite-backup-cli.nix` `restore` arm — see Section C):

- `--target` defaults to `${PWD}/<db>-restored.db`. The default
  deliberately lives under `$PWD` with a `-restored.db` suffix so
  an absent-minded operator who omits `--target` cannot stomp the
  source DB.
- `--time` defaults to `latest`.
- The default repo is the local one under `${XDG_DATA_HOME}/sqlite-backup/<db>/restic`.
  Pass `--from-remote` to address `rclone:<remote>:<remotePath>/<db>`
  instead.
- The CLI refuses to overwrite a non-empty existing target without
  `--force` (R13.AC9).

### D.1 Recovery to the latest committed transaction (local repo intact)

Use case: the live DB is gone (accidental `rm`, on-disk corruption,
unrecoverable application bug) but the local restic repo at
`${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/<db>/restic/`
is still intact. This is the common case (R9.AC3 "latest" branch).

**One-liner:**

```sh
sqlite-backup restore <db> --target /tmp/<db>-restored.db
```

Defaults: `--time latest`, local repo (no `--from-remote`).

**Manual decomposition** (for operators who want explicit control
over each stage, or who are running on a host where the CLI binary
is temporarily unavailable):

```sh
DB=<db>
REPO="${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/$DB/restic"
STAGING="${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/$DB/litestream-staging"

# 1. Make restic able to decrypt the repo. The CLI exports the same
#    env var; setting it by hand is the equivalent.
export RESTIC_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-archive-passphrase -a mcp-hub -w'

# 2. (Optional) inspect what's in the repo before restoring (R16.3 —
#    both tiers visible in one listing).
restic -r "$REPO" snapshots

# 3. Extract the latest snapshot to a tmp directory. restic preserves
#    the snapshot's original absolute paths, so the staging dir lands
#    at $TMP$STAGING (with the leading slash preserved by restic).
TMP="$(mktemp -d -t sqlite-backup-restore.XXXXXX)"
restic -r "$REPO" restore latest --target "$TMP"

# 4. Reconstruct the SQLite file from the extracted LTX segments.
litestream restore -o "/tmp/$DB-restored.db" "file://$TMP$STAGING"

# 5. Clean up the staging extraction.
rm -rf -- "$TMP"
```

### D.2 Recovery to a specific point-in-time

Use case: the operator wants to inspect or recover the database
state as it was at some earlier timestamp within the retention
window — e.g., "the state from yesterday at 14:30 UTC, before I ran
that bad migration" (R9.AC3 "specific PIT" branch).

**One-liner:**

```sh
sqlite-backup restore <db> --target /tmp/<db>-pit.db --time 2026-05-12T14:30:00Z
```

The `--time` argument is an ISO-8601 timestamp. The CLI selects the
most recent restic snapshot whose `time` is at-or-before `<ts>`
(across both the `replication` and `archive` tags — both share the
same staging-directory contents, so the PIT semantic is "the most
recent snapshot of either tier that does not exceed `<ts>`"), then
passes `-timestamp <ts>` to `litestream restore`. PIT precision is
bounded by the closest at-or-before snapshot's capture timestamp:
inside that snapshot's window, `-timestamp` truncates the LTX
replay at any instant up to capture time, but the recovered state
cannot advance past the snapshot's own capture moment.

If `<ts>` falls between snapshots, the recovered state is the
chosen snapshot's capture moment, not `<ts>` exactly — restic
captures the staging directory at each snapshot, so the LTX
segments inside a snapshot terminate at that snapshot's capture
time, and `litestream restore -timestamp <ts>` replays through
`min(<ts>, T_capture)`. Replication-tier snapshots are taken at
sub-5-minute cadence (the module default), so this rounding is
small in practice when the replication tier is intact;
archive-tier-only PIT (e.g., the on-host repo has been pruned to
archive snapshots only, or recovery is from off-host where
replication-tier retention is short) may round down by hours-to-
days. If `<ts>` is older than the oldest retained snapshot across
both tiers, both the CLI and the manual flow fail with
"no snapshot at-or-before `<ts>`" — that state is unrecoverable.

**Manual decomposition:**

```sh
DB=<db>
REPO="${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/$DB/restic"
STAGING="${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/$DB/litestream-staging"
TS=2026-05-12T14:30:00Z

export RESTIC_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-archive-passphrase -a mcp-hub -w'

# 1. Pick the snapshot at-or-before the target timestamp. This jq
#    filter mirrors the CLI's selection logic in scripts/sqlite-backup-cli.nix
#    (`restore` arm): tag-agnostic, most recent that does not exceed $TS.
SNAPSHOT_ID="$(restic -r "$REPO" snapshots --json \
  | jq -r --arg ts "$TS" '[.[] | select(.time <= $ts)] | sort_by(.time) | last | .id')"
test -n "$SNAPSHOT_ID" && test "$SNAPSHOT_ID" != "null" \
  || { echo "no snapshot at-or-before $TS in $REPO" >&2; exit 1; }

# 2. Extract that snapshot.
TMP="$(mktemp -d -t sqlite-backup-restore.XXXXXX)"
restic -r "$REPO" restore "$SNAPSHOT_ID" --target "$TMP"

# 3. Replay the LTX chain forward only as far as $TS. Without
#    -timestamp, litestream would replay to the end of the chain
#    (i.e., latest), which would defeat the point-in-time intent.
litestream restore -o "/tmp/$DB-pit.db" -timestamp "$TS" "file://$TMP$STAGING"

rm -rf -- "$TMP"
```

### D.3 Recovery from off-host destination only (host-loss scenario)

Use case: the original host is gone — disk dead, laptop stolen,
re-provisioned to a fresh OS install. The off-host restic repo at
`rclone:<remote>:<remotePath>/<db>` is the only surviving copy of
the data. This is R9.AC4 "off-host only" branch and the case
diagrammed in design.md §"System Flows → Recovery from Off-Host
Destination Only".

The new host MUST end up with the SAME two passphrases the original
host used: the restic archive passphrase (which decrypts every
snapshot in the off-host repo) and the rclone-config passphrase
(which decrypts the rclone config that names the destination).
Both are recovered from 1Password — neither is regenerable from
anything on disk, and there is no fallback if both 1Password copies
have been lost as well.

**One-liner** (after the new-host bootstrap below is complete):

```sh
sqlite-backup restore <db> --from-remote --target /tmp/<db>-restored.db
```

`--from-remote` tells the CLI to address `rclone:<remote>:<remotePath>/<db>`
directly instead of the local repo. Both `RESTIC_PASSWORD_COMMAND`
(archive passphrase) and `RCLONE_PASSWORD_COMMAND` (rclone-config
passphrase) are needed; the CLI reads both from Keychain
automatically once Keychain is populated by the bootstrap below.

For Shopify's synthetic `:local:` destination, host-loss recovery has a
different prerequisite. Install and sign in to Google Drive for desktop on the
replacement host, then wait for or explicitly hydrate:

```text
~/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/sqlite-backup/<db>
```

Rebuild the same Shopify configuration and run the one-liner above. The CLI
will address that hydrated folder as `rclone::local:<path>`. Do not recreate a
named OAuth remote for this branch. If Drive for desktop never uploaded the
repository before the original host was lost, this recovery path has no usable
off-host copy; local backup success alone does not establish otherwise.

**Manual decomposition for configured remotes** (the new-host bootstrap is the same whether
the operator uses the one-liner or the manual flow — only the
restore stages at the end differ):

```sh
DB=<db>
REMOTE=<your-rclone-remote>            # e.g. gdrive (matches Phase 5 declaration)
REMOTE_PATH=<your-remote-path>         # e.g. sqlite-backup (the manifest default)

# --- Phase 1: stash the same passphrases on the new host's Keychain ---
# Both passphrases come from 1Password (originally stashed in
# Section A.2). The Keychain SERVICE / ACCOUNT names below MUST
# match what the CLI looks up — see scripts/sqlite-backup-cli.nix
# read_keychain_secret().
op read 'op://<vault>/sqlite-backup-archive/passphrase' \
  | /usr/bin/security add-generic-password -U \
      -s sqlite-backup-archive-passphrase -a mcp-hub -w

op read 'op://<vault>/sqlite-backup-rclone-config/passphrase' \
  | /usr/bin/security add-generic-password -U \
      -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w

# After the new host's first `darwin-rebuild switch` lands a
# configuration that declares this database, mcp-sops-bridge will
# also populate these entries from sops yaml (see Section A Phase
# 6). Doing it manually here lets the operator restore BEFORE the
# new host's nix-darwin / home-manager is fully wired.

# --- Phase 2: re-bootstrap rclone for the same destination ---
# Run `rclone config` interactively, recreate a remote with name
# == $REMOTE, walk through the same backend OAuth dance (or restore
# ~/.config/rclone/rclone.conf from a separate backup if you have
# one). Then re-encrypt the config with the SAME passphrase that
# was used on the old host.
rclone config encryption set
# When prompted, paste the rclone-config passphrase from 1Password.

# Verify both decryption AND reachability of the destination.
RCLONE_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w' \
  rclone config encryption check
RCLONE_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w' \
  rclone lsd "$REMOTE:$REMOTE_PATH/$DB"

# --- Phase 3: restore directly from the remote restic repo ---
export RESTIC_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-archive-passphrase -a mcp-hub -w'
export RCLONE_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s sqlite-backup-rclone-config-passphrase -a mcp-hub -w'
REMOTE_REPO="rclone:$REMOTE:$REMOTE_PATH/$DB"

# (Optional) sanity check — both tiers' snapshots show up here (R16.3).
restic -r "$REMOTE_REPO" snapshots

# Pull both the snapshot ID we want AND the original absolute
# staging path it was captured under, in one query. The original
# staging path was rooted at the OLD host's $XDG_DATA_HOME and may
# differ from the new host's, so we read it back from the snapshot
# rather than guessing.
SNAPSHOT_META="$(restic -r "$REMOTE_REPO" snapshots --json \
  | jq -c 'sort_by(.time) | last')"
SNAPSHOT_ID="$(printf '%s' "$SNAPSHOT_META" | jq -r '.id')"
ORIG_STAGING="$(printf '%s' "$SNAPSHOT_META" | jq -r '.paths[0]')"

TMP="$(mktemp -d -t sqlite-backup-restore.XXXXXX)"
restic -r "$REMOTE_REPO" restore "$SNAPSHOT_ID" --target "$TMP"

litestream restore -o "/tmp/$DB-restored.db" "file://$TMP$ORIG_STAGING"

rm -rf -- "$TMP"
```

Once the database file is restored the operator can either copy it
into place at the new host's expected `<db>.path` and then run a
normal `darwin-rebuild switch` to bring the pipeline back up, or
first rebuild a fresh local restic repo from the off-host one with

```sh
LOCAL_REPO="${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/$DB/restic"
restic copy --from-repo "$REMOTE_REPO" --repo "$LOCAL_REPO"
```

and resume scheduled operation from there (subsequent replicate /
archive cycles will then be incremental against the freshly mirrored
local repo).

### D.4 Recovery from on-host repo only (off-host destination unreachable)

Use case: the off-host destination is unreachable — cloud provider
outage, network partition, expired OAuth token, throttled API quota
— but the local restic repo is intact. This is R9.AC4 "on-host
only" branch.

There is nothing scenario-specific to do: the default restore flow
already uses the local repo and never touches the off-host
destination. The CLI does not even invoke `rclone` in this code
path, so an unreachable destination has no effect on recovery.

**One-liner:**

```sh
sqlite-backup restore <db> --target /tmp/<db>-restored.db
```

This is byte-identical to the D.1 one-liner; the absence of
`--from-remote` is what scopes the restore to the local repo.
Recovery proceeds even when `rclone lsd <remote>:<path>` would fail.

**Manual decomposition:** identical to D.1. Note that the manual
flow never invokes `rclone` at all — that is the explicit
confirmation that the off-host destination's reachability is
irrelevant to this scenario.

If the operator wants to USE this opportunity to also confirm the
off-host destination is the cause (rather than something more
serious), the `verify-credentials` subcommand from Section C is the
read-only probe:

```sh
sqlite-backup verify-credentials <db>
# Expected when off-host is the only thing wrong:
#   <remote>:<remotePath>/<db>: FAIL: <rclone error message>
```

### D.5 Inspection patterns

Discovering what is recoverable BEFORE running a restore — useful
when the operator is unsure which timestamp to target, which tier
holds the snapshot they need, or whether the local and off-host
repos are in sync. R16.AC3 mandates a single-listing inspection
across both tiers; restic's tag-filter surface is the mechanism.

For all `restic` rows below, `RESTIC_PASSWORD_COMMAND` must be
exported (see D.1 step 1). For rows referencing the remote repo,
`RCLONE_PASSWORD_COMMAND` must also be exported (see D.3 Phase 3).

| Question | Command |
|---|---|
| What snapshots exist in the local repo, both tiers in one listing? (R16.AC3) | `restic -r "$REPO" snapshots` |
| Just the replication-tier (sub-5-minute granularity, short retention) snapshots? | `restic -r "$REPO" snapshots --tag replication` |
| Just the archive-tier (daily/weekly/monthly retention) snapshots? | `restic -r "$REPO" snapshots --tag archive` |
| Same listings against the off-host repo, to confirm it is in sync (R16.AC5)? | `restic -r "rclone:$REMOTE:$REMOTE_PATH/$DB" snapshots [--tag …]` |
| Pipeline state for one DB at a glance — most-recent snapshot per tier and whether the Litestream daemon is running? | `sqlite-backup status <db>` |
| Same, across every configured DB? | `sqlite-backup status` |
| What's actually inside a specific snapshot (which files, sizes)? | `restic -r "$REPO" ls <snapshot-id>` |
| Verify on-host repo integrity (no corrupt blobs)? | `restic -r "$REPO" check` |

`$REPO` throughout is `${XDG_DATA_HOME:-$HOME/.local/share}/sqlite-backup/<db>/restic`.
