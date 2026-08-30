# Requirements Document

## Project Description (Input)

A new `home.sqliteBackup` home-manager module that gives the operator
of this nix-config (a single user across two darwin hosts:
`Brandons-MacBook-Pro` / Personal and `ShopifyLaptop` / Shopify)
durable, declarative, end-to-end-encrypted backups of WAL-mode SQLite
databases.

**Who has the problem.** The repo's operator. The Cavemem MCP server
is the imminent first consumer (a WAL-mode SQLite + FTS5 + BLOB-vector
observations DB), but any future personal SQLite-backed service
inherits the same gap. There is currently no nix-managed SQLite backup
mechanism in this repo at all.

**Current situation.**

- No `home-manager/common/sqlite-backup.nix` exists.
- `pkgs.rclone` is installed
  (`home-manager/common/default.nix:101`) but with no managed config
  and no declared remotes.
- `pkgs.litestream` and `pkgs.restic` are not installed anywhere.
- nixpkgs-25.11 ships `pkgs.litestream` v0.3.13; the LTX-segments file
  backend this design depends on requires v0.5.7+ (upstream is
  v0.5.11).
- The recently-landed `mcp-secrets-sops-nix` spec (verified through
  Phase 5) provides the canonical secrets-handling pattern this work
  must reuse: sops → `/run/secrets/*` →
  `mcp-secrets-activate` → macOS Keychain (account `mcp-hub`) →
  consumed at runtime via
  `/usr/bin/security find-generic-password -s <svc> -a mcp-hub -w`.
- A May 9 2026 research + design pass produced two memories
  (`memories/2026-05-09-sqlite-backup-tooling-survey.md`,
  `memories/2026-05-09-sqlite-cloud-backup-plan.md`) but never
  produced a module. This spec evolves that design — see
  `memories/2026-05-12-sqlite-backup-pipeline-pivot.md` for the
  delta.

**What should change.** Land a single
`home-manager/common/sqlite-backup.nix` module plus an
`overlays/litestream.nix` package override, both consumed dormant
(`databases = [ ]`) on both hosts at first activation. The module
configures, per database, a three-tier chained pipeline:

```
[live SQLite WAL]
      ↓ continuous (~1s RPO), Litestream KeepAlive launchd agent
${xdg.dataHome}/sqlite-backup/<db>/litestream-staging/   ← LTX segments, plaintext, local
      ↓ daily (StartCalendarInterval), restic + chained rclone wrapper
${xdg.dataHome}/sqlite-backup/<db>/restic/               ← encrypted, dedup, one repo per DB
      ↓ inline `rclone sync` after restic, same wrapper, flock-guarded
<rclone remote>:<path>/restic/<db>/              ← any rclone backend, OR local: path
```

Live SQLite never traverses the network in plaintext; only the
restic-encrypted repo does. rclone remotes are declared in Nix and
rendered into `${xdg.configHome}/rclone/rclone.conf`, with OAuth
tokens / API keys injected at activation time from sops via the
existing bridge. Recovery is documented end-to-end:
`rclone copy` the restic repo back → `restic restore` the Litestream
segments dir → `litestream restore` from those segments → SQLite DB at
any chosen point-in-time.

**Hard constraints inherited from the discovery viability check** (must
appear as testable requirements):

1. Litestream pinned to **≥ v0.5.7** (LTX file backend; dodge
   `benbjohnson/litestream#1037` silent-stall bug).
2. Restic backup of the Litestream segments dir **must
   `--exclude='*.tmp'`** (Litestream's atomic-rename emits transient
   `.tmp` files per `file/replica_client.go` `WriteLTXFile`).
3. Restic + rclone in each wrapper **must be `flock`-serialized**
   (restic does not refuse concurrent writers per
   `restic/restic#711`; `rclone sync` racing
   `restic forget --prune` is the failure mode).
4. Use **local restic repo + `rclone sync`**, NOT
   `restic -r rclone:remote:path` — preserves
   local-fast-path + remote-durability.
5. **macOS only.** No NixOS module. Both hosts are darwin
   (`aarch64-darwin` active, `x86_64-darwin` build-only).
6. Pre-commit hooks ban `/tmp/` literals, `/Users/...` literals
   outside `${...}` interpolations, and `builtins.fetch*` outside
   `flake.nix` — all paths must use
   `${config.home.homeDirectory}` / `${config.xdg.dataHome}` /
   `${config.xdg.configHome}`.
7. Activation scripts that read `/run/secrets/*` **must use
   `lib.mkOrder 9999`** post-sops-nix
   (precedent: `configurations/common-darwin/mcp-sops-bridge.nix:142`).

**Out of scope.** Wiring any actual database (cavemem and others are
follow-up PRs against the dormant module); NixOS support; in-line
dead-man-switch / external monitoring; `rclone config password`
encryption of the rendered config; multi-destination per DB;
SQLite-engine alternatives (Turso, libSQL, D1, rqlite, marmot,
LiteFS); Time Machine integration; `sqlite3_rsync`.

The full discovery output — including the canonical pipeline diagram,
boundary candidates, upstream/downstream wiring, and the complete list
of constraints — is in `.kiro/specs/sqlite-backup/brief.md`. Treat the
brief as the authoritative input alongside this Project Description
when generating requirements.

## Introduction

The SQLite Backup feature provides a declarative home-manager module
that gives the operator durable, encrypted, off-host backups of
WAL-mode SQLite databases on macOS hosts. The module supports any
number of databases per host, replicates each one continuously
(sub-second on-host RPO), captures encrypted point-in-time archival
snapshots on a configurable schedule, and ships every database's
complete backup repository — both continuous replication state and
scheduled archival snapshots — to any rclone-supported destination on
a continuous basis (approximately five-minute off-host RPO under
healthy network conditions). Replication and archival continue
functioning on the host whenever the off-host destination is
unreachable; off-host shipment resumes and converges automatically
when connectivity returns. The live SQLite database never traverses
the network in plaintext; only encrypted artifacts do. The module
ships dormant on first activation: declaring it enabled with no
databases configured must produce a no-op pipeline so the change can
land safely on every host before any specific database is wired in.

## Boundary Context

- **In scope**: declarative configuration of per-database backup
  pipelines (continuous replication + scheduled archival snapshots +
  continuous off-host shipment of both replication state and archival
  snapshots through a single per-database backup repository);
  offline-resilient local operation when the off-host destination is
  unreachable; declarative configuration of named rclone destinations
  in Nix (each declaring at minimum its backend type plus any
  non-credential rclone backend attributes that identify it), with
  database entries referencing those destinations by name only;
  eval-time failure when a database entry references a destination not
  present in the named destination set; operator-managed rclone
  configuration outside Nix that holds destination credentials in an
  encrypted-at-rest configuration file; secret materialization of the
  rclone-configuration encryption passphrase and the archival
  passphrase via the existing sops → Keychain bridge; activation-time
  verification that the operator's rclone configuration is present,
  encrypted at rest, and contains every Nix-declared rclone
  destination with a matching backend type; an end-to-end
  recovery procedure; operator-facing commands on the operator's shell
  `PATH` for listing configured databases, inspecting each database's
  current pipeline status, triggering an on-demand backup of a
  configured database, restoring a configured database from its
  archival snapshots, starting or stopping continuous replication for
  a configured database, and verifying live credentials for each
  configured destination; behavior of a single darwin host (the
  module is per-host, not multi-host-coordinating).
- **Out of scope**: wiring any actual database into the dormant module
  (each database is a follow-up change); NixOS support; in-line
  dead-man-switch / external monitoring; encrypted-at-rest storage of
  the rendered rclone configuration file (filesystem permissions are
  the only confidentiality mechanism applied to the rendered file —
  the file itself holds no plaintext secrets per Requirement 7);
  multiple destinations per database; SQLite engine alternatives
  (Turso, libSQL, Cloudflare D1, rqlite, marmot, LiteFS); Time Machine
  integration; `sqlite3_rsync`; backup of any non-SQLite data.
- **Adjacent expectations**: the `mcp-secrets-sops-nix` spec provides
  the canonical secrets-bridge pattern (sops →
  `/run/secrets/*` → activation script → macOS Keychain), and this
  feature consumes that bridge unchanged. `pkgs.rclone` is already
  present in `home.packages`; this feature relies on it but does not
  own its installation. The Cavemem MCP server is the expected first
  downstream consumer of a configured database entry but is not part
  of this feature.
- **Shopify local-sync exception**: Shopify database repositories are written
  through rclone's synthetic `:local:` backend into the Google Drive File
  Provider folder. A successful pipeline run proves the local folder was
  updated; Google Drive synchronization is external, unmonitored, and not an
  off-host durability guarantee. The operator accepts this reliability gap to
  remove direct Drive API backpressure from backup runs.

## Requirements

### Requirement 1: Declarative module with dormant default

**Objective:** As the operator, I want a declarative `home.sqliteBackup`
module that activates safely with no databases configured, so that I
can land the module on every host before wiring any specific database.

#### Acceptance Criteria

1. The SQLite Backup module shall expose a configuration surface that
   accepts an enable flag, a named set of rclone destinations, an
   archival passphrase reference, and a list of database entries that
   each reference an rclone destination by name.
2. When the operator enables the SQLite Backup module without
   configuring any databases, the SQLite Backup module shall not create
   any backup runtime agents and shall not require any rclone
   destination or archival passphrase to be configured.
3. When the operator enables the SQLite Backup module without
   configuring any databases, the SQLite Backup module shall pass the
   repository's `nix flake check` on every supported architecture.
4. When the operator adds a database entry to the configuration, the
   SQLite Backup module shall create the runtime pipeline for that
   database without requiring any change to any other database entry.
5. If a database entry references a destination that is not present in
   the configured destination set, the SQLite Backup module shall fail
   evaluation with an error that names both the missing destination
   and the database entry that referenced it.

### Requirement 2: Continuous replication of each configured database

**Objective:** As the operator, I want every configured database to be
replicated continuously so that the recoverable state of the database
is never more than a few seconds behind the live database.

#### Acceptance Criteria

1. While the SQLite Backup module is active and a database is
   configured, the SQLite Backup pipeline shall continuously capture
   committed transactions from that database into a local on-host
   replica.
2. While the SQLite Backup pipeline is replicating a database under the
   workload profile this feature targets (low-write personal
   observation databases), the recoverable state on disk shall be no
   more than approximately one second behind the latest committed
   transaction in the live database.
3. The SQLite Backup pipeline shall keep the live database file
   accessible to its writer at all times during replication; the
   replicator shall not require exclusive access to the database file.
4. If the replicator process exits or is terminated, the SQLite Backup
   pipeline shall automatically restart it without operator
   intervention.
5. While the host is asleep, the SQLite Backup pipeline shall pause
   replication and shall resume it on wake without losing any committed
   transactions that occurred before sleep.
6. The SQLite Backup pipeline shall keep the on-host replica artifacts
   strictly local; no on-host replica artifact shall be transmitted
   off-host by the replication tier.

### Requirement 3: Scheduled archival snapshots of each configured database

**Objective:** As the operator, I want each configured database's
replicated state to be captured into encrypted, deduplicated archival
snapshots on a schedule I control, so that I can recover any past
version of the database within the retention window.

#### Acceptance Criteria

1. The SQLite Backup module shall accept a schedule and a retention
   policy independently for each configured database.
2. When the configured schedule fires for a database, the SQLite Backup
   pipeline shall capture an archival snapshot of that database's
   on-host replica.
3. After capturing each archival snapshot, the SQLite Backup pipeline
   shall apply the configured retention policy and shall remove
   archival snapshots that no longer satisfy that policy.
4. While the configured archival schedule has not yet fired for a
   database for the first time, the SQLite Backup pipeline shall
   preserve the on-host backup repository for that database without
   truncation; the absence of any archival-tier snapshot shall not
   cause any replication-tier state already captured into the
   repository to be removed.
5. The SQLite Backup pipeline shall produce archival snapshots that,
   when restored, recover the on-host replica state regardless of
   whether the replicator was mid-rotation when the snapshot was
   captured.

### Requirement 4: Off-host shipment of archival snapshots

**Objective:** As the operator, I want each completed archival snapshot
to reach the off-host destination so that a single host failure cannot
destroy any archival snapshot that has already been captured.

#### Acceptance Criteria

1. After each successful archival snapshot for a database, the SQLite
   Backup pipeline shall propagate the new on-host backup repository
   state — including the new archival snapshot — to the destination
   configured for that database, using the same continuous off-host
   shipment mechanism described in Requirement 14.
2. The SQLite Backup pipeline shall never transmit the live database
   file or any unencrypted replica artifact to an off-host destination.
3. If any off-host shipment for a database fails, the SQLite Backup
   pipeline shall preserve the on-host backup repository intact so
   that a later shipment can complete it.
4. If any off-host shipment for a database fails, the SQLite Backup
   pipeline shall record a non-zero exit status for the failed run
   and shall write the failure cause to the run's log destination.

### Requirement 5: Pluggable destination set

**Objective:** As the operator, I want each database to ship to any
rclone-supported destination — cloud or local — so that I can pick the
right destination per host without changing the module.

#### Acceptance Criteria

1. The SQLite Backup module shall accept any rclone-supported backend
   type as a configured destination, including but not limited to
   S3-compatible object stores, Backblaze B2, Google Drive, Microsoft
   OneDrive, Dropbox, SFTP, WebDAV, and local filesystem paths.
2. The SQLite Backup module shall allow the operator to assign
   different destinations to different databases on the same host.
3. The SQLite Backup module shall accept either a remote object-store
   destination or a local filesystem destination using the same
   destination configuration shape.
4. When the configured destination is a local filesystem path, the
   SQLite Backup pipeline shall ship archival snapshots to that path
   using the same off-host shipment behavior described in
   Requirement 4.
5. The SQLite Backup module's configuration surface for rclone
   destinations shall be a named set in which each entry declares at
   minimum the destination's rclone backend type and any additional
   non-credential rclone backend attributes (for example, region,
   endpoint URL, scopes) that identify the destination; database
   entries shall reference these destinations by name only and shall
   not embed the destination's backend type or any other backend
   attribute inline.
6. When a database references the synthetic `:local` destination, its
   `remotePath` shall be absolute, the destination shall be excluded from
   configured-remote matching, and the pipeline shall address it through
   rclone's on-the-fly local backend.

### Requirement 6: Confidentiality of archival snapshots

**Objective:** As the operator, I want every archival snapshot that
leaves the host to be confidential, so that whoever holds the
destination cannot read the database contents.

#### Acceptance Criteria

1. The SQLite Backup pipeline shall encrypt every archival snapshot
   before it leaves the host's local disk.
2. The SQLite Backup pipeline shall use the operator-supplied archival
   passphrase to encrypt every database's archival snapshots; the
   passphrase shall not be embedded in the configuration or in any
   artifact stored outside the host's secret store.
3. If the archival passphrase is not available at the time an archival
   snapshot is scheduled, the SQLite Backup pipeline shall fail the
   snapshot, shall record the failure cause to the run's log
   destination, and shall not proceed with off-host shipment.
4. The SQLite Backup module shall not require the operator to provide
   the archival passphrase interactively for any scheduled snapshot.

### Requirement 7: Secret management via the existing sops-to-Keychain bridge

**Objective:** As the operator, I want all secrets used by this
feature — rclone destination credentials and the archival passphrase —
to flow through the same sops-to-Keychain bridge already used by the
rest of this repository, so that I have one declarative pattern for
managing secrets.

#### Acceptance Criteria

1. The SQLite Backup module shall consume secrets from the host's
   macOS Keychain via the same sops-managed pipeline used by the
   existing `mcp-secrets-sops-nix` work.
2. The SQLite Backup module shall not write any plaintext credential
   or passphrase into the Nix store, into any rendered configuration
   file committed to the repository, or into any module evaluation
   artifact.
3. The SQLite Backup module shall not accept any per-destination
   credential value inline in its Nix configuration. Destination
   credentials shall be supplied only by the operator through the
   operator-managed encrypted rclone configuration (per Requirement
   7.AC5). The SQLite Backup module's secret references shall be
   limited to the rclone-configuration encryption passphrase and the
   archival snapshot passphrase.
4. If any secret referenced by the SQLite Backup module is missing
   from the host's secret store at activation time, the SQLite Backup
   module's activation step shall fail with an error that names both
   the missing secret and the SQLite Backup module function (for
   example, rclone-configuration decryption or archival snapshot
   encryption) that required it.
5. The SQLite Backup module shall not allow any plaintext credential
   or passphrase to exist at rest in any rendered or operator-managed
   configuration file on the operator's local filesystem. Where the
   operator's rclone configuration contains credentials at rest (for
   example, OAuth tokens, refresh tokens, or API keys), the rclone
   configuration shall be encrypted using rclone's native
   configuration-encryption mechanism, with the encryption passphrase
   stored only in the operator's secret store; runtime tools shall
   acquire that passphrase from the secret store on each invocation.

### Requirement 8: Concurrency safety inside the archival pipeline

**Objective:** As the operator, I want the archival pipeline to behave
correctly under unexpected concurrent invocation so that overlapping
runs cannot corrupt either the on-host or the off-host archive.

#### Acceptance Criteria

1. While an archival pipeline run for a database is in progress, the
   SQLite Backup pipeline shall not start a second concurrent run for
   the same database.
2. The SQLite Backup pipeline shall ensure that an off-host shipment
   in progress completes without producing an inconsistent or
   corrupted off-host backup repository, even if new replication-tier
   state or archival-tier snapshots are being written to the on-host
   backup repository concurrently with the shipment.
3. If a scheduled archival run fires while the previous run for the
   same database has not yet completed, the SQLite Backup pipeline
   shall skip the new run and shall record the skip in the run's log
   destination.

### Requirement 9: Recovery procedure

**Objective:** As the operator, I want a documented end-to-end recovery
procedure so that I can restore any configured database to a chosen
point-in-time after losing the host.

#### Acceptance Criteria

1. The SQLite Backup feature shall provide an operator-facing recovery
   procedure that begins with retrieving an archival snapshot from the
   off-host destination and ends with a usable SQLite database file at
   a chosen point-in-time within the retention window.
2. The recovery procedure may use the SQLite Backup module's operator
   commands (Requirement 13) or the standard command-line interfaces
   of the underlying replication, archival, and shipment tools, and
   shall not require any other custom tooling.
3. The recovery procedure shall describe how to recover to the latest
   committed transaction and how to recover to a specific earlier
   point-in-time within the available replication window.
4. The recovery procedure shall describe how to recover when only the
   off-host destination is available (no on-host state remains) and
   how to recover when only the on-host state is available (the
   off-host destination is unreachable).

### Requirement 10: macOS-only targeting

**Objective:** As the operator, I want the module to clearly target
macOS so that it does not silently appear to work or fail confusingly
on other platforms.

#### Acceptance Criteria

1. The SQLite Backup module shall be intended for use on darwin hosts
   only.
2. If the SQLite Backup module is enabled in a configuration that is
   being evaluated for a non-darwin platform, the SQLite Backup module
   shall fail evaluation with an error that states the feature is
   darwin-only.
3. The SQLite Backup module shall build successfully on both
   `aarch64-darwin` and `x86_64-darwin` for both the dormant
   configuration and a representative active configuration.

### Requirement 11: Pre-flight gating on tooling viability

**Objective:** As the operator, I want the module to refuse to activate
when its underlying tools are not at versions known to be safe for
this pipeline, so that I cannot unknowingly run the pipeline against a
buggy or incompatible version.

#### Acceptance Criteria

1. The SQLite Backup module shall require a version of the replication
   tool known to support the on-host replica format on which this
   pipeline depends, and known to be free of any open silent-failure
   defect that would cause replication to stop without surfacing an
   error.
2. If the replication tool available to the SQLite Backup module is
   older than the required minimum version, the SQLite Backup module
   shall fail evaluation with an error that names both the available
   version and the required minimum.
3. The SQLite Backup module shall declare its required minimum versions
   for each underlying tool in a single, discoverable location so that
   future maintenance can update them without changing the rest of the
   module.

### Requirement 12: Operational visibility

**Objective:** As the operator, I want every backup run to leave a
discoverable record of its outcome on the host so that I can audit
successes and diagnose failures without standing up external
monitoring.

#### Acceptance Criteria

1. The SQLite Backup pipeline shall write a log entry for the start
   and the end of every archival pipeline run, identifying the
   database name and the configured destination.
2. If any step of the archival pipeline fails, the SQLite Backup
   pipeline shall record both the failing step and the failure cause
   in the run's log destination.
3. The SQLite Backup pipeline shall expose its log destinations at a
   stable, documented location under the operator's home directory so
   that the operator can find them without consulting the module
   source.
4. The SQLite Backup pipeline shall propagate non-zero exit statuses
   from any failing step to the launchd-visible exit status of the
   wrapper run.

### Requirement 13: Operator commands for on-demand backup, restore, replication control, and credential verification

**Objective:** As the operator, I want simple command-line tools —
installed on my shell `PATH` and runnable without invoking any Nix
wrapper — that let me list configured databases, inspect each
database's current pipeline status, trigger a full backup of any
configured database on demand, restore any configured database from
its archival snapshots, start or stop continuous replication for any
configured database, and verify the live credentials for each
configured destination, so that I can perform routine ad-hoc
operations, emergency recoveries, status checks, runtime pipeline
control, and credential health checks without rebuilding my
home-manager configuration or learning the underlying tools' command
surfaces.

#### Acceptance Criteria

1. The SQLite Backup module shall install operator commands for
   on-demand backup and for restore into the operator's user profile
   so that they are available on the operator's shell `PATH` after a
   successful home-manager activation.
2. The SQLite Backup module's operator commands shall be invokable
   directly from any interactive shell without requiring the operator
   to invoke `nix`, `nix run`, `nix-shell`, `home-manager`,
   `darwin-rebuild`, or any other Nix wrapper command.
3. When the operator runs the on-demand backup command for a
   configured database, the SQLite Backup pipeline shall execute the
   same archival pipeline run for that database (capture archival
   snapshot, apply retention, ship to the configured destination) as
   the scheduled run defined by Requirements 3 and 4.
4. When the operator runs the on-demand backup command, the SQLite
   Backup pipeline shall obey the same concurrency safety as scheduled
   runs (Requirement 8) and shall not start a second concurrent run
   if a scheduled run for the same database is already in progress.
5. When the operator runs the on-demand backup command, the SQLite
   Backup pipeline shall propagate a non-zero exit status and a
   human-readable failure cause to the operator's terminal if any
   step of the pipeline fails.
6. When the operator runs the restore command for a configured
   database, the SQLite Backup pipeline shall produce a usable SQLite
   database file at an operator-chosen target path.
7. When the operator runs the restore command, the SQLite Backup
   pipeline shall accept either a request for the latest recoverable
   state or a request for a specific point-in-time within the
   available replication window, consistent with Requirement 9.
8. When the operator runs the restore command and the off-host
   destination is reachable, the SQLite Backup pipeline shall be able
   to satisfy the restore from the off-host destination alone, without
   requiring any pre-existing on-host state for that database.
9. If the operator runs the restore command with a target path that
   already exists as a non-empty file, the SQLite Backup pipeline
   shall refuse to overwrite that file unless the operator explicitly
   opts into overwriting.
10. If the operator invokes any operator command without supplying a
    database name when one is required, or with a database name that
    does not match any configured database, the SQLite Backup pipeline
    shall list the configured database names in its error output so
    that the operator can re-invoke the command with a valid name.
11. The SQLite Backup module's operator commands shall include a "stop
    replication" command that, when invoked for a configured database
    whose replication is currently running, halts continuous capture
    of that database's committed transactions to its on-host replica.
12. The SQLite Backup module's operator commands shall include a
    "start replication" command that, when invoked for a configured
    database whose replication has been halted by a prior operator
    command, resumes the database's pipeline to the running state
    defined by Requirements 2 (continuous replication), 3 (scheduled
    archival), and 14 (continuous off-host shipment).
13. By default, when the operator invokes the "stop replication"
    command for a configured database, the SQLite Backup pipeline
    shall halt only continuous replication for that database;
    scheduled archival snapshots (Requirement 3) and off-host shipment
    (Requirement 14) for that database shall continue independently,
    capturing and shipping whatever replication state was most
    recently committed to the on-host replica.
14. The SQLite Backup module's "stop replication" command shall accept
    an opt-in operator flag that, when supplied, escalates the halt
    to cover the entire backup pipeline for that database (continuous
    replication, scheduled archival snapshots, and continuous off-host
    shipment).
15. A halted state — whether replication-only or whole-pipeline — set
    via the operator commands shall persist on the host until either
    (a) the operator invokes "start replication" for that database, or
    (b) the home-manager activation re-runs (for example via
    `darwin-rebuild switch`), at which point the declarative
    `home.sqliteBackup.databases` configuration shall take precedence
    and the affected database's pipeline shall return to the running
    state declared in configuration.
16. When the operator invokes a "stop replication" or "start
    replication" command for a configured database whose pipeline is
    already in the requested state, the SQLite Backup pipeline shall
    report the existing state to the operator's terminal without
    producing an error and without modifying that database's pipeline.
17. The SQLite Backup module's operator commands shall include a
    `list` command that, when invoked, prints the names of all
    configured databases — one entry per database — without requiring
    a database-name argument. When no databases are configured, the
    `list` command shall print no entries and shall not produce an
    error.
18. The SQLite Backup module's operator commands shall include a
    `status` command that, when invoked without arguments, prints —
    for each configured database — at minimum the database's name and
    the current state of its backup pipeline (running, halted via
    replication-only stop, or halted via whole-pipeline stop). When
    invoked with a database name as an argument, the `status` command
    shall scope its output to that single database.
19. When the operator invokes the on-demand backup command for a
    configured database whose pipeline is currently halted via the
    operator commands (whether replication-only or whole-pipeline),
    the SQLite Backup pipeline shall execute the requested backup run
    as a one-time override and shall not modify the database's halt
    state; after the backup completes, the database's pipeline shall
    remain in the same halted state it had before the on-demand
    backup was invoked.
20. The SQLite Backup module's operator commands shall include a
    `verify-credentials` command that, when invoked without a
    database-name argument, shall attempt a low-cost read-only access
    check against each rclone destination configured for any database
    in the SQLite Backup module's configuration, and shall report the
    per-destination outcome (success or failure with the failure
    cause) to the operator's terminal.
21. When the operator invokes the `verify-credentials` command with a
    database name as an argument, the command shall scope its
    verification to the destination configured for that database
    alone.
22. The `verify-credentials` command shall not modify any backup
    repository, on-host or off-host, shall not initiate any backup or
    shipment work, and shall not modify any database's halt state; it
    shall perform only read-only access checks against each verified
    destination.
23. If any destination's verification fails, the `verify-credentials`
    command shall exit with a non-zero status; if all verifications
    succeed, it shall exit with a zero status, so that the command
    can be used in scripted health checks.
24. If the `verify-credentials` command cannot decrypt the operator's
    rclone configuration with the passphrase from the operator's
    secret store, the command shall report the decryption failure as
    a global error (distinguishing the failure cause from a
    per-destination credential failure) and shall exit with a
    non-zero status without attempting per-destination verification.

### Requirement 14: Continuous off-host shipment of replication state

**Objective:** As the operator, I want every configured database's
continuous replication state — not just its scheduled archival
snapshots — to be shipped off-host on a continuous basis, so that a
sudden host failure cannot lose more than a few minutes of committed
transactions even between scheduled archival runs.

#### Acceptance Criteria

1. While the SQLite Backup pipeline is replicating a database, the
   SQLite Backup pipeline shall propagate replication state to that
   database's configured destination on a continuous basis, without
   waiting for the next scheduled archival snapshot.
2. While off-host connectivity to the configured destination is
   healthy and the operator has not changed the default shipment
   cadence, the off-host recoverable state for a database shall lag
   the latest committed transaction in the live database by no more
   than approximately five minutes under the workload profile this
   feature targets (low-write personal observation databases).
3. The SQLite Backup module shall accept an operator-configurable
   shipment cadence per database for off-host shipment of replication
   state, with a default cadence that satisfies acceptance
   criterion 2.
4. The off-host shipment of replication state shall use the same
   encryption mechanism required by Requirement 6 and the same
   secret-management mechanism required by Requirement 7 as the
   off-host shipment of archival snapshots.
5. The off-host shipment of replication state and the off-host
   shipment of archival snapshots shall converge to the same single
   per-database backup repository on the destination, consistent with
   Requirement 16.

### Requirement 15: Offline-resilient local operation

**Objective:** As the operator, I want continuous replication and
scheduled archival snapshots to continue functioning on the host even
when the host has no network connectivity to the configured
destination, so that I can rely on local recoverability during
travel, network outages, or any other period when the off-host
destination is unreachable.

#### Acceptance Criteria

1. While the host has no network connectivity to the configured
   destination for a database, the SQLite Backup pipeline shall
   continue to capture committed transactions from that database into
   the on-host replica without interruption.
2. While the host has no network connectivity to the configured
   destination for a database, the SQLite Backup pipeline shall
   continue to capture scheduled archival snapshots for that database
   into the on-host backup repository on the configured schedule.
3. While the host has no network connectivity to the configured
   destination for a database, the SQLite Backup pipeline shall queue
   all pending off-host shipment work for that database and shall not
   lose, drop, or corrupt any pending shipment of replication-tier
   state or archival-tier snapshots.
4. When network connectivity to the configured destination is restored
   after a period of unavailability, the SQLite Backup pipeline shall
   resume off-host shipment without operator intervention and shall
   converge the off-host backup repository to match the on-host
   backup repository.
5. The SQLite Backup pipeline shall not block, delay, or otherwise
   interfere with live database writes due to the absence of network
   connectivity to the configured destination.

### Requirement 16: Single backup repository per database

**Objective:** As the operator, I want each configured database's
continuous replication state and scheduled archival snapshots to be
stored in a single coherent backup repository per database, so that I
can manage retention, integrity, and recovery as one cohesive unit
rather than juggling separate stores.

#### Acceptance Criteria

1. The SQLite Backup pipeline shall store both continuous
   replication-tier state and scheduled archival-tier snapshots for
   each configured database in a single backup repository for that
   database.
2. The SQLite Backup module shall accept retention policies for the
   replication tier and the archival tier independently per database,
   and the SQLite Backup pipeline shall apply both tiers' policies to
   the same backup repository in a coordinated manner.
3. The single backup repository per database shall be inspectable as
   one unit through the standard tooling for that repository's
   format, with both replication-tier and archival-tier snapshots
   discoverable in a single listing.
4. The SQLite Backup pipeline shall not maintain separate, divergent
   on-host or off-host backup repositories for replication-tier state
   versus archival-tier snapshots for the same database.
5. The off-host backup repository for a database shall be a complete
   and consistent copy of the on-host backup repository for that
   database following a successful off-host shipment cycle (including
   propagation of any retention-driven snapshot deletions), such that
   recovery from the off-host repository alone produces the same
   database state as recovery from the on-host repository.

### Requirement 17: Activation-time verification of rclone configuration

**Objective:** As the operator, I want the SQLite Backup module to
verify, during home-manager activation, that the operator-managed
rclone configuration is present, encrypted at rest, and structurally
matches the destinations the SQLite Backup module is configured to
use, so that misconfiguration (missing config file, plaintext
credentials, passphrase mismatch, missing remote, wrong backend type)
is surfaced at rebuild time rather than discovered later when a
scheduled backup run fails.

#### Acceptance Criteria

1. While the SQLite Backup module is enabled and at least one database
   is configured with a destination, the SQLite Backup module's
   activation step shall verify that the operator's rclone
   configuration file exists at its expected path on the host's
   filesystem; if the file is missing, activation shall fail with an
   error that names the expected path and the operator action
   required to create it.
2. While the SQLite Backup module is enabled and at least one database
   is configured with a destination, the SQLite Backup module's
   activation step shall verify that the operator's rclone
   configuration file is encrypted at rest using rclone's native
   configuration-encryption mechanism (consistent with
   Requirement 7.AC5); if the file is not encrypted, activation shall
   fail with an error that names the file path and the operator
   action required to encrypt it.
3. While the SQLite Backup module is enabled and at least one database
   is configured with a destination, the SQLite Backup module's
   activation step shall verify, by decrypting the rclone
   configuration with the passphrase retrieved from the operator's
   secret store, that every rclone remote referenced by a configured
   database's destination is present in the rclone configuration; if
   any referenced remote is missing, activation shall fail with an
   error that names the missing remote, the database that referenced
   it, and the operator action required to add it.
4. While the SQLite Backup module is enabled and at least one database
   is configured with a destination, the SQLite Backup module's
   activation step shall verify, for every rclone remote referenced
   by a configured database's destination, that the actual backend
   type recorded in the operator's rclone configuration matches the
   backend type declared for that destination in the SQLite Backup
   module's named-destination set (per Requirement 5); if any
   mismatch is detected, activation shall fail with an error that
   names the affected remote, the declared backend type, the actual
   backend type, and the operator action required to reconcile.
5. If the encryption passphrase retrieved from the operator's secret
   store cannot decrypt the rclone configuration file (passphrase
   mismatch), or if the passphrase is missing from the secret store,
   the SQLite Backup module's activation step shall fail with an
   error that distinguishes the failure cause (missing passphrase vs.
   passphrase mismatch vs. missing config file vs. plaintext config)
   and that names the operator action required to remediate.
6. While the SQLite Backup module is enabled but no databases are
   configured (the dormant default), the SQLite Backup module's
   activation step shall not perform any of the verification steps
   defined in this requirement and shall not fail on the absence of
   an rclone configuration file or its encryption state.

### Requirement 18: Persistent emergency pressure halts

**Objective:** As the operator, I want safety-triggered halts to survive
routine rebuilds and require validated recovery, so that declarative
activation cannot restart a pipeline that was stopped to protect the host.

#### Acceptance Criteria

1. When disk-safety logic halts a configured database, the SQLite Backup
   pipeline shall represent that state separately from operator-created
   `replication-only` and `whole-pipeline` halt flags.
2. The emergency halt record shall identify the database, halt reason,
   trigger, observed byte values, configured byte limits, measurement paths,
   and timestamp in a structured JSON document.
3. A home-manager activation shall preserve every emergency pressure halt
   record while retaining Requirement 13.15 behavior for operator-created
   halt flags.
4. While an emergency pressure halt exists, `sqlite-backup start <db>` shall
   exit non-zero, shall not invoke `launchctl`, and shall print
   `sqlite-backup clear-pressure <db>` as the recovery command.
5. While an emergency pressure halt exists, replication-tier, archive-tier,
   and on-demand backup invocations shall skip before acquiring the
   per-database backup lock.
6. `sqlite-backup status [<db>]` shall expose `halt-reason: disk-pressure`
   while an emergency pressure halt exists.
7. `sqlite-backup clear-pressure <db>` shall preserve the emergency halt if
   its record is malformed, a current measurement fails, filesystem available
   bytes are below the recorded minimum, or managed local bytes are above the
   recorded maximum.
8. When both current thresholds are healthy, `sqlite-backup clear-pressure
   <db>` shall remove only the emergency halt record and shall not start the
   pipeline.
9. After a successful `clear-pressure`, `sqlite-backup start <db>` shall be
   required to load an otherwise-unloaded Litestream agent.

### Requirement 19: Proactive disk-pressure guard

**Objective:** As the operator, I want every configured database constrained by
host free-space and per-database local-data limits before backup growth can
exhaust the root filesystem.

#### Acceptance Criteria

1. The SQLite Backup module shall accept a host-wide minimum filesystem
   available-byte floor, a guard check interval, and a per-database maximum
   managed-local-byte ceiling as integer byte values.
2. The rendered manifest shall include both configured limits, the root
   filesystem measurement path, the guard interval, and every managed path.
3. Each configured database shall have an independent launchd guard agent that
   runs at load and at the configured interval.
4. The managed-local total shall include the database's Litestream staging
   directory, restic repository, Litestream metadata directory, and any
   synthetic-local destination repository.
5. Litestream shall use the metadata directory rendered inside the database's
   managed SQLite Backup root.
6. The guard shall measure filesystem available bytes and physical allocated
   managed bytes with locale-independent command output.
7. Filesystem available bytes equal to the configured minimum and managed bytes
   equal to the configured maximum shall be healthy.
8. Filesystem available bytes below the configured minimum or managed bytes
   above the configured maximum shall atomically create the Requirement 18
   pressure marker and unload only that database's Litestream agent.
9. Replication-tier, archive-tier, and on-demand backup execution shall run the
   same guard synchronously before acquiring the per-database backup lock.
10. Missing managed paths shall contribute zero bytes. Inaccessible paths and
    measurement failures shall create a pressure marker, unload Litestream,
    emit an actionable error, and return non-zero.
11. Guard output shall include observed and configured byte values without
    secret material.
12. ShopifyLaptop shall use a 128 GiB root free-space floor, a 60-second check
    interval, and a 96 GiB OpenCode managed-local ceiling.
