# Brief: sqlite-backup

## Problem

WAL-mode SQLite databases on macOS need durable replication and backup,
but consumer file-sync providers (iCloud Drive, Google Drive Desktop,
Dropbox) corrupt them when used directly — per SQLite's own
[How To Corrupt An SQLite Database File](https://www.sqlite.org/howtocorrupt.html)
§1.2 / §1.4 / §3 — because they capture the `.db` / `.db-wal` / `.db-shm`
trio at inconsistent points during writes. There is no nix-managed
SQLite backup mechanism in this repo today, so any future personal
SQLite-backed service (the Cavemem MCP server is the imminent example,
but anything else WAL-mode would inherit the same gap) lands without
durable cloud copies.

## Current State

- No `home-manager/common/sqlite-backup.nix` module exists.
- `pkgs.rclone` is installed via `home-manager/common/default.nix:101`
  but with no managed config and no declared remotes.
- `pkgs.litestream` and `pkgs.restic` are not installed anywhere in the
  repo.
- A May 9 2026 research + design pass produced two memories
  (`memories/2026-05-09-sqlite-backup-tooling-survey.md`,
  `memories/2026-05-09-sqlite-cloud-backup-plan.md`) but never produced
  a module or a spec. This spec evolves that design.
- The recently-landed `mcp-secrets-sops-nix` spec (commits cf3c00b …
  826c23d, phase verified through Phase 5) introduced the canonical
  secrets-handling pattern: sops → `/run/secrets/*` →
  `mcp-secrets-activate` script → macOS Keychain, consumed at runtime
  via `/usr/bin/security find-generic-password -s <svc> -a mcp-hub -w`.
- nixpkgs-25.11 pins `pkgs.litestream` at v0.3.13; the LTX-segments
  file backend this design depends on requires v0.5.7+ (upstream is
  v0.5.11 as of today).

## Desired Outcome

- A single `home.sqliteBackup` home-manager module that declaratively
  configures per-database backup pipelines: continuous Litestream
  replication + daily restic snapshots + chained `rclone sync` of the
  restic repo to any rclone-supported destination (cloud OR local
  directory).
- The live SQLite database never traverses the network in plaintext;
  only restic-encrypted artifacts do.
- Module ships dormant on both hosts (`databases = [ ]`) so first
  activation is a no-op; first real DB (likely cavemem on Personal)
  gets wired in a follow-up PR without further module changes.
- Litestream pinned to v0.5.x via an in-spec overlay so the module
  works against `nix flake check` immediately.
- All credentials (rclone OAuth tokens, restic passphrase, B2 keys,
  etc.) flow through the existing sops-nix → Keychain bridge; no new
  secret-management mechanism.
- Recovery is documented end-to-end: `rclone copy` the restic repo
  back → `restic restore` the Litestream segments dir → `litestream
  restore` from those segments → SQLite DB at any chosen point-in-time.

## Approach

Three-tier pipeline per database, glued together by a single module:

```
[live SQLite WAL]
      ↓  continuous (~1s RPO), Litestream KeepAlive launchd agent
${xdg.dataHome}/sqlite-backup/litestream/<db>/   ← LTX segments, plaintext, local
      ↓  daily (StartCalendarInterval), restic + chained rclone wrapper
${xdg.dataHome}/sqlite-backup/restic/<db>/       ← encrypted, dedup, one repo per DB
      ↓  inline `rclone sync` after restic, same wrapper, flock-guarded
<rclone remote>:<path>/restic/<db>/              ← any rclone backend, OR local: path
```

Module API at a glance:

```nix
home.sqliteBackup = {
  enable = true;
  rcloneRemotes = {
    gdrive = { type = "drive"; sopsToken = "rclone-gdrive-token"; … };
    b2 = { type = "b2"; sopsKeyId = "rclone-b2-key-id"; … };
  };
  restic.passphraseSopsKey = "sqlite-backup-restic-passphrase";
  databases = [
    {
      name = "cavemem";
      path = "${config.home.homeDirectory}/.cavemem/data.db";
      remote = "gdrive";
      remotePath = "sqlite-backup";
      litestream.snapshotInterval = "24h";
      restic.schedule = { Hour = 3; Minute = 0; };
      restic.retention = [ "--keep-daily" "7" "--keep-weekly" "4" "--keep-monthly" "6" ];
    }
  ];
};
```

A single Litestream daemon per host multiplexes all configured DBs.
Each DB gets its own restic repo and its own
restic-+-rclone wrapper agent on its own schedule. `rclone.conf` is
rendered to `${xdg.configHome}/rclone/rclone.conf` from
`rcloneRemotes`, with secrets injected at activation time from sops via
the existing bridge.

## Scope

- **In**:
  - `home-manager/common/sqlite-backup.nix` — the HM module.
  - `overlays/litestream.nix` — pin Litestream v0.5.x (≥ v0.5.7, ideally
    v0.5.10+). May lift from `pkgs.unstable` if available there;
    otherwise `overrideAttrs` against `pkgs.litestream`.
  - Declarative `rclone.conf` rendering via `xdg.configFile`, with
    sops-managed OAuth tokens / API keys per remote.
  - Activation-script integration (`lib.mkOrder 9999`, post-sops-nix)
    that materializes rclone secrets into the rendered config and
    stashes the restic passphrase + per-remote auth into Keychain.
  - launchd agents: one always-on Litestream replicate agent per host;
    one StartCalendarInterval restic + rclone wrapper per DB. `flock`
    mutex around restic + rclone serialization in each wrapper.
  - `*.tmp` exclusion in restic backup of the Litestream segments dir
    (Litestream emits transient `.tmp` files during atomic rename).
  - Per-host scaffolding files
    (`configurations/{personal,shopify}/home-manager/sqlite-backup.nix`)
    that import the module with `enable = true; databases = [ ];
    rcloneRemotes = { }` — module is dormant on both hosts at landing.
  - `nix flake check` smoke test for the module (pure Nix eval; no live
    DB; mirrors the nixvim-tier convention as far as that fits).
  - Operator runbook: keychain / sops bootstrap, `rclone config
    reconnect <remote>:` OAuth bootstrap, end-to-end recovery procedure.

- **Out**:
  - Wiring any actual database (cavemem or other) into the dormant
    module — that's a follow-up PR per DB.
  - NixOS support (the repo has darwin hosts only).
  - In-line dead-man-switch / external monitoring (cronitor.io,
    healthchecks.io) — deferred to a follow-up.
  - `rclone config password` encryption of `rclone.conf` (we rely on
    sops + macOS file perms instead).
  - Multi-destination per DB (one DB → one rclone remote at a time; the
    restic-pre-rclone tier already gives defense-in-depth).
  - SQLite-engine alternatives (Turso, libSQL, Cloudflare D1, rqlite,
    marmot, LiteFS) — see May-9 survey for the rationale.
  - Time Machine integration, `sqlite3_rsync`, direct iCloud sync of
    the live DB — covered and rejected in the May-9 survey.

## Boundary Candidates

- **Litestream packaging** (overlay) — could be its own PR but the
  delta is small; keeping it in-spec keeps the change set
  self-contained.
- **rclone-config rendering** (declarative remotes + OAuth bootstrap) —
  touches sops + Keychain bridge, but reuses the existing pattern;
  doesn't fork it.
- **launchd wiring** (Litestream daemon + restic-rclone wrapper) — the
  repo has no `StartCalendarInterval` precedent today; this spec
  establishes it.
- **Backup pipeline orchestration** (the wrapper script that snapshots
  Litestream segments via restic, then rclone-syncs the repo, with
  flock) — the actual runtime logic, mostly bash via
  `pkgs.writeShellApplication`.
- **Recovery / runbook** — documentation tier; lives next to the module
  README or as a standalone `.kiro/specs/sqlite-backup/runbook.md`.

## Out of Boundary

- The Cavemem MCP server itself (separate concern, not yet specced).
- Backup of non-SQLite data (dotfiles, `~/Library/Application
  Support/…` blobs, etc.) — that's restic's job in a future broader
  personal-data-backup spec, if ever.
- iCloud-Drive-as-rclone-backend (no first-class rclone iCloud backend;
  if ever needed, a future spec adds icloudpd or webdav-icloud
  scaffolding).
- Wholesale replacement of the existing
  `mcp-secrets-sops-nix` plumbing — this spec extends it (likely reuses
  the `mcp-hub` Keychain account, or introduces a parallel
  `sqlite-backup` account if that's cleaner).
- Real-time monitoring / alerting for backup health — explicitly
  deferred.

## Upstream / Downstream

- **Upstream**:
  - `mcp-secrets-sops-nix` spec (phase verified) — provides the sops →
    `/run/secrets/*` → activation → Keychain pattern this spec consumes.
  - `pkgs.rclone` already in `home.packages` — re-used as-is.
- **Downstream**:
  - Cavemem MCP server (future, not yet specced) — first real consumer
    of `home.sqliteBackup.databases`.
  - Any future SQLite-using HM module (Atuin's history.db, future MCP
    servers, etc.) can opt in by appending to `databases`.
  - Possible later companion spec for a "broader personal data restic"
    pipeline that snapshots dotfiles + secrets + this module's repos
    into one canonical archive.

## Existing Spec Touchpoints

- **Extends**: none directly — this is a brand-new module.
- **Adjacent**: `mcp-secrets-sops-nix` for the secrets-bridge pattern.
  Reuse, don't fork. The May-9 memos
  (`memories/2026-05-09-sqlite-backup-tooling-survey.md`,
  `memories/2026-05-09-sqlite-cloud-backup-plan.md`) are research input,
  not specs.

## Constraints

- **macOS only.** Both hosts are darwin; the integration surface is
  nix-darwin's `launchd.user.agents`. No NixOS module is in scope.
- **Litestream v0.5.7+ required** for the LTX-segments file backend;
  nixpkgs-25.11 ships v0.3.13, so an in-spec overlay is mandatory.
  Re-evaluate when nixpkgs catches up.
- **`*.tmp` exclude in restic** of the Litestream segments dir is
  mandatory (Litestream's atomic-rename emits transient `.tmp` files
  per `file/replica_client.go` `WriteLTXFile`).
- **restic + rclone serialization** required: a `flock` in each
  wrapper, so `rclone sync` never races `restic forget --prune` (restic
  doesn't refuse concurrent backups against the same repo — see
  `restic/restic#711`).
- **Pre-commit hooks** ban `/tmp/` literals, `/Users/...` literals
  outside `${...}` interpolations, and `builtins.fetch*` outside
  `flake.nix`. Module must use `${config.home.homeDirectory}` and
  `${config.xdg.dataHome}` / `${config.xdg.configHome}` consistently.
- **Activation ordering**: any new activation script that reads
  `/run/secrets/*` must use `lib.mkOrder 9999` (see
  `configurations/common-darwin/mcp-sops-bridge.nix:142` for the
  precedent and the long comment explaining why `lib.mkAfter` alone is
  insufficient).
- **Both arches**: must build on `aarch64-darwin` (active host) and
  `x86_64-darwin` (build-only). Both Litestream and restic ship for
  both via nixpkgs.
- **Licenses**: Litestream Apache-2.0, restic BSD-2, rclone MIT —
  permissive and mutually compatible. No GPL contamination.
- **Litestream v0.5.x stability**: the cavemem-style append-only,
  low-write workload dodges the high-write bugs (#1198, #1197, #1165,
  #1164). Pin ≥ v0.5.7 to also dodge the silent-stop-on-WAL-reuse bug
  (#1037). Re-evaluate stability story per nixpkgs bump.
