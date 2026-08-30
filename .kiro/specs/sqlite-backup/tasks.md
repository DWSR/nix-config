# Implementation Plan

- [x] 1. Litestream overlay
  - Add `overlays/litestream.nix` that lifts `pkgs.litestream` from `pkgs.unstable.litestream` via the existing `unstable-packages` overlay machinery.
  - Register the new overlay in `flake.nix` alongside the existing overlay composition.
  - Confirm: `nix eval '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.litestream.version'` returns `0.5.11` or higher.
  - _Requirements: 11.1, 11.3_
  - _Boundary: Litestream Overlay_

- [ ] 2. HM module declarative surface

- [x] 2.1 Option surface and dormant-default evaluation
  - Create `home-manager/common/sqlite-backup.nix` with `home.sqliteBackup.{enable, rcloneDestinations, databases, archivePassphraseSecret, rcloneConfigPassphraseSecret}` options and explicit Nix types.
  - Define `rcloneDestinations` as `attrsOf (submodule {…})` with at minimum a `type` field plus arbitrary non-credential rclone backend attributes.
  - Define `databases` as `listOf (submodule {…})` with `name`, `path`, `remote`, `remotePath`, `replicationTier.{cadenceSeconds,retention}`, `archiveTier.{schedule,retention}` and the documented defaults from `design.md`.
  - Confirm: with `enable = true; databases = [ ]; rcloneDestinations = { }`, the module evaluates cleanly and produces no `launchd.agents` entries.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 5.1, 5.2, 5.3, 5.5, 14.3_

- [x] 2.2 Eval-time assertions
  - Add an `assertions` block that fails evaluation when any `databases[*].remote` references a key not present in `rcloneDestinations`, naming both the missing destination and the database that referenced it.
  - Add a `lib.hm.assertions.assertPlatform pkgs lib.platforms.darwin` gate so non-darwin evaluation fails with a darwin-only message.
  - Add a version assertion that fails when `pkgs.litestream.version < "0.5.7"`, naming both the available and required versions; declare the minimum-version constants in a single `let` binding.
  - Confirm: each assertion fires with the named cause when triggered by a deliberate invalid input (validated by Task 8.2).
  - _Requirements: 1.5, 10.1, 10.2, 11.1, 11.2, 11.3_

- [x] 2.3 Manifest renderer
  - Render the manifest JSON via `pkgs.writeText "sqlite-backup-manifest.json" (builtins.toJSON manifestData)` containing the destinations attrset, the databases list with computed `stagingDir` and `repoDir` paths under `${config.xdg.dataHome}/sqlite-backup/<db>/{litestream-staging,restic}`, and the secret service names.
  - Expose the resulting store path as a private read-only option `home.sqliteBackup._manifestPath` so the system-tier verification module and the CLI binary can both consume it.
  - Confirm: `cat $(nix eval --raw '.#…home.sqliteBackup._manifestPath')` prints a JSON document matching the schema in `design.md` §Data Models.
  - _Requirements: 1.1, 5.5, 16.1_

- [x] 2.4 Halt-flag clearing activation hook
  - Declare `home.activation.sqlite-backup-clear-halts` as a `lib.hm.dag.entryAfter ["writeBoundary"]` Bash fragment that removes any halt-flag files under `${config.xdg.stateHome}/sqlite-backup/halt-*.flag`.
  - Activation script must respect `DRY_RUN` (no-op when set) and use the HM `run`/`verboseEcho` helpers per the HM-activation convention.
  - Confirm: writing `${XDG_STATE_HOME}/sqlite-backup/halt-cavemem.flag` manually and then running `darwin-rebuild switch` removes the file.
  - _Requirements: 13.15_

- [x] 2.5 Per-database launchd agent declarations
  - For each entry in `databases`, declare four `launchd.agents` entries:
    - `dev.dwsr.sqlite-backup.litestream.<db>` — `KeepAlive = true; RunAtLoad = true; ProgramArguments = [ "<sqlite-backup>/bin/sqlite-backup" "__litestream-trigger" "<db.name>" ];`; the guarded trigger execs Litestream with generated YAML.
    - `dev.dwsr.sqlite-backup.replicate.<db>` — `StartInterval = db.replicationTier.cadenceSeconds; ProgramArguments = [ "<sqlite-backup>/bin/sqlite-backup" "__replicate-trigger" "<db.name>" ];`
    - `dev.dwsr.sqlite-backup.archive.<db>` — `StartCalendarInterval = db.archiveTier.schedule; ProgramArguments = [ "<sqlite-backup>/bin/sqlite-backup" "__archive-trigger" "<db.name>" ];`
    - `dev.dwsr.sqlite-backup.guard.<db>` — `RunAtLoad = true; StartInterval = pressureGuard.checkIntervalSeconds; ProgramArguments = [ "<sqlite-backup>/bin/sqlite-backup" "__pressure-guard" "<db.name>" ];`
  - Each agent declares `StandardOutPath` and `StandardErrorPath` under `${config.home.homeDirectory}/Library/Logs/sqlite-backup-<db>-<role>.{log,error.log}`.
  - Confirm: with one synthetic database in the config, `launchctl list | grep dev.dwsr.sqlite-backup` shows four labels after `darwin-rebuild switch`.
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 12.3, 14.2, 14.3, 15.1, 15.5_

- [ ] 3. Operator CLI binary

- [x] 3.1 CLI dispatcher and shared helpers
  - Create `scripts/sqlite-backup-cli.nix` as a `pkgs.writeShellApplication` taking `pkgs`, `lib`, and `manifestPath` as args; emit a binary named `sqlite-backup`.
  - Implement case-on-`$1` dispatch for all public subcommands (`list`, `status`, `backup`, `restore`, `start`, `stop`, `clear-pressure`, `verify-credentials`, `--help`) and internal subcommands (`__litestream-trigger`, `__replicate-trigger`, `__archive-trigger`, `__pressure-guard`).
  - Implement shared helper functions: read manifest via baked path + `jq`, read Keychain secret via absolute-path `/usr/bin/security find-generic-password -s <svc> -a mcp-hub -w`, acquire/release per-database mkdir lockfile under `${TMPDIR:-/var/tmp}/sqlite-backup-<db>.lock`, log start/end with timestamps to `~/Library/Logs/sqlite-backup-<db>-cli.log`.
  - Implement common error UX: when invoked without a required `<db>` arg or with a `<db>` not present in the manifest, list all configured database names on stderr.
  - Confirm: `sqlite-backup --help` lists exactly the seven public subcommands; `sqlite-backup backup nonexistent` exits non-zero and prints the configured DB names.
  - _Requirements: 13.1, 13.2, 13.10_
  - _Boundary: CLI Script_

- [x] 3.2 Read-only subcommands: list and status
  - `sqlite-backup list` reads the manifest and prints each configured DB name on its own line; produces no output and exit 0 when `databases = [ ]`.
  - `sqlite-backup status [<db>]` for each configured DB (or just `<db>` when supplied) prints: name, replication-state derived from halt-flag content + `launchctl list <label>`, last-replication-snapshot timestamp from `restic snapshots --tag replication --json`, last-archive-snapshot timestamp from `restic snapshots --tag archive --json`.
  - Status `replication-state` value is one of: `running`, `halted-replication-only`, `halted-whole-pipeline`, derived from the halt-flag contents specified in `design.md`.
  - Confirm: with one DB and no halt flag set, `sqlite-backup status cavemem` reports `replication-state: running`.
  - _Requirements: 13.17, 13.18_
  - _Boundary: CLI Script_

- [x] 3.3 verify-credentials subcommand
  - Pre-flight: invoke `rclone config encryption check` with `RCLONE_PASSWORD_COMMAND` set to the Keychain-read for the rclone-config passphrase; on failure, print a global decryption-failure error distinguished from per-destination errors and exit non-zero without per-destination work.
  - Iterate over either all configured destinations (no arg) or just the one referenced by `<db>` (with arg); for each, invoke `rclone lsd <name>:<remotePath>/<db>` (a low-cost read-only access check) and capture per-destination outcome.
  - Report per-destination success/failure with failure cause to the operator's terminal; non-zero exit on any failure, zero on all-success.
  - Confirm: with a deliberately wrong rclone-config passphrase in Keychain, the command exits non-zero with the global decryption-failure message and no per-destination output.
  - _Requirements: 13.20, 13.21, 13.22, 13.23, 13.24_
  - _Boundary: CLI Script_

- [x] 3.4 Lifecycle subcommands: start and stop
  - `sqlite-backup stop <db> [--include-archive]` writes a halt flag at `${XDG_STATE_HOME}/sqlite-backup/halt-<db>.flag` with content `replication-only` (default) or `whole-pipeline` (with the flag), then runs `launchctl bootout gui/$(id -u) <litestream-agent-label>` to halt the per-DB Litestream daemon.
  - `sqlite-backup start <db>` removes the halt flag and runs `launchctl bootstrap gui/$(id -u) <litestream-plist-path>` to re-bootstrap the per-DB Litestream agent.
  - Both commands are idempotent: if `start` is invoked while no halt flag exists, report "already running" without error or change; if `stop` is invoked while a matching halt is already set, report "already halted (<state>)" without change.
  - Confirm: `stop cavemem` then `start cavemem` results in the halt flag absent and the per-DB Litestream agent loaded; rerunning `start` reports the already-running state.
  - _Requirements: 13.11, 13.12, 13.13, 13.14, 13.16_
  - _Boundary: CLI Script_

- [x] 3.5 Tier-trigger subcommands: __replicate-trigger and __archive-trigger
  - Implement both internal subcommands sharing a common helper that takes the tier name and retention args; the only differences are `--tag <tier>` and the retention policy.
  - Implement all 10 steps per `design.md` §CLI Script Batch contract:
    1. Halt-flag check: replication-only halt skips replicate-trigger; whole-pipeline halt skips both. Skip = exit 0 with logged reason.
    2. Acquire mkdir lock under `${TMPDIR}/sqlite-backup-<db>.lock`; early exit 0 with logged reason if held.
    3. Export `RESTIC_PASSWORD_COMMAND` and `RCLONE_PASSWORD_COMMAND` from the shared Keychain-read helper; export `RESTIC_FROM_PASSWORD_COMMAND` for `restic copy` invocations.
    4. Local repo init: `restic -r <repoDir> snapshots >/dev/null 2>&1 || restic -r <repoDir> init` (idempotent).
    5. Remote repo init with chunker-param sharing: `restic -r rclone:<remote>:<remotePath>/<db> snapshots >/dev/null 2>&1 || restic init --copy-chunker-params --from-repo <repoDir> --repo rclone:<remote>:<remotePath>/<db>` (idempotent; preserves dedup).
    6. `restic backup --tag <tier> --host $(hostname -s) --exclude='*.tmp' <stagingDir>` — the `*.tmp` exclude prevents capturing Litestream's atomic-rename intermediates.
    7. `restic copy --from-repo <repoDir> --repo rclone:<remote>:<remotePath>/<db>` propagates new snapshots.
    8. `restic forget --tag <tier> <retention args> --prune` against the LOCAL repo.
    9. `restic -r rclone:<remote>:<remotePath>/<db> forget --tag <tier> <retention args> --prune` against the REMOTE repo, mirroring local prune (preserves R16.5 mirror-equivalence).
    10. Release lock; on any step failure, log cause and exit non-zero so launchd captures it; on success, exit 0.
  - Confirm: a manually-invoked `sqlite-backup __replicate-trigger cavemem` against a synthetic DB produces a `replication`-tagged snapshot in both local and remote restic repos, and a subsequent invocation correctly applies forget+prune to both.
  - _Requirements: 2.2, 2.3, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.4, 6.1, 6.2, 6.3, 6.4, 8.1, 8.2, 8.3, 12.1, 12.2, 12.4, 14.1, 14.4, 14.5, 15.2, 15.3, 15.4, 16.1, 16.2, 16.3, 16.4, 16.5_
  - _Boundary: CLI Script_

- [x] 3.6 backup subcommand (on-demand)
  - `sqlite-backup backup <db>` invokes the same internal helper as `__archive-trigger` but bypasses the halt-flag check at step 1 (R19 — explicit operator override).
  - The halt flag is consulted (for logging) but never written, modified, or removed by this subcommand; halt state is preserved across the on-demand run.
  - Exit status propagates from the internal trigger; non-zero on any pipeline step failure with cause printed to stderr.
  - Confirm: with `sqlite-backup stop cavemem --include-archive` previously executed, `sqlite-backup backup cavemem` runs the archive-tier flow successfully and the halt flag remains present afterward.
  - _Requirements: 13.3, 13.4, 13.5, 13.19_
  - _Boundary: CLI Script_

- [x] 3.7 restore subcommand
  - `sqlite-backup restore <db> [--target <path>] [--time <ts>] [--from-remote] [--force]` with documented defaults: `--target = ${PWD}/<db>-restored.db`, `--time = latest`, `--from-remote = false`, `--force = false`.
  - Pre-flight check: if `<target>` exists and is non-empty, refuse and print the corrective `--force` flag instructions.
  - Restore is two-stage: (a) `restic restore <snapshot-id-or-latest> --target <tmp-dir>` (selecting the snapshot at-or-before `<ts>` from either tag if `--time` was supplied), then (b) `litestream restore -o <target> [-timestamp <ts>] file://<tmp-dir>/<staging-subpath>` to materialize the SQLite file.
  - With `--from-remote`, the restic invocation uses `-r rclone:<remote>:<remotePath>/<db>` directly, bypassing the local repo (host-loss recovery scenario).
  - Confirm: `sqlite-backup restore cavemem --target /tmp/test.db --time latest` produces a queryable SQLite file at `/tmp/test.db`; rerunning without `--force` against the same path refuses with a clear error.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 13.6, 13.7, 13.8, 13.9_
  - _Boundary: CLI Script_

- [x] 4. HM module integration with CLI binary and secrets
  - Add two entries to `home.mcp.keychainSecrets`: one keyed on `archivePassphraseSecret` value and one on `rcloneConfigPassphraseSecret` value, each pointing at a `op://Private/...` URL the operator will populate.
  - Add the CLI binary derivation to `home.packages` via `(import ../../scripts/sqlite-backup-cli.nix { inherit pkgs lib; manifestPath = config.home.sqliteBackup._manifestPath; })`.
  - Confirm: after `darwin-rebuild switch` on a host with the dormant scaffold, `which sqlite-backup` resolves and `sqlite-backup --help` exits 0.
  - _Requirements: 7.1, 7.2, 7.3, 13.1, 13.2_
  - _Boundary: HM Module_
  - _Depends: 2.5, 3.1_

- [ ] 5. System-tier verification of rclone config (R17)

- [x] 5.1 (P) Verification script
  - Create `pkgs.writeShellApplication` (defined inside `configurations/common-darwin/sqlite-backup-verify.nix`) named `sqlite-backup-verify-rclone-config` taking the manifest path as `$1` and `runtimeInputs = [ pkgs.rclone pkgs.jq ]`.
  - Implement R17 verification flow with distinguished failure modes (R17.5):
    - Resolve passphrase Keychain entries via `/usr/bin/security find-generic-password -s <name> -a mcp-hub -w`; on missing entry, fail with "missing passphrase in Keychain: ..." message naming the secret.
    - Check `[ -f "$HOME/.config/rclone/rclone.conf" ]`; on missing file, fail with "rclone config not found at <path>; run rclone config".
    - Run `rclone config encryption check` with `RCLONE_PASSWORD_COMMAND` set to the Keychain-read; distinguish exit codes for plaintext-config vs decryption-failure with appropriate error messages.
    - Run `rclone listremotes --long --json | jq` to build a `{name → type}` map of actual destinations; for each Nix-declared destination, verify its name appears in the map (R17.3) and its declared type matches the actual type (R17.4); on mismatch, fail with the affected name + expected/actual type + corrective action.
  - Confirm: with a synthetic plaintext rclone.conf, the script exits non-zero with the documented "config is plaintext; run rclone config encryption set" message; with all checks passing, the script exits 0 silently.
  - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_
  - _Boundary: System Verify Module_
  - _Depends: 2.3_

- [x] 5.2 System activation wiring at mkOrder 10000
  - In `configurations/common-darwin/sqlite-backup-verify.nix`, hook into `system.activationScripts.postActivation.text` at `lib.mkOrder 10000` (strictly after `mcp-secrets-activate` at 9999).
  - Read `cfg = config.home-manager.users.${username}.home.sqliteBackup`; conditionally invoke verification only when `cfg.enable && (length cfg.databases > 0)` (R17.6 dormant exemption).
  - Invocation pattern: `launchctl asuser $(id -u ${username}) sudo -u ${username} --set-home ${verifyScript}/bin/sqlite-backup-verify-rclone-config ${cfg._manifestPath}` (mirrors HM's nix-darwin activation pattern).
  - On verification failure, the activation script's non-zero exit propagates and aborts `darwin-rebuild switch`.
  - Confirm: with `databases = [ ]` and an absent `~/.config/rclone/rclone.conf`, `darwin-rebuild switch` succeeds (no verification fires); with one synthetic database declared and the same absent rclone.conf, the rebuild fails with the "config not found" message.
  - _Requirements: 7.4, 17.6_
  - _Boundary: System Verify Module_
  - _Depends: 2.3, 5.1_

- [ ] 6. Per-host wiring (dormant landing)

- [x] 6.1 (P) Personal host scaffold
  - Create `configurations/personal/home-manager/sqlite-backup.nix` setting `home.sqliteBackup = { enable = true; rcloneDestinations = { }; databases = [ ]; }`.
  - Append `./sqlite-backup.nix` to `configurations/personal/home-manager/default.nix` imports list.
  - Confirm: `nix flake check` passes for `darwinConfigurations.Brandons-MacBook-Pro` with the new scaffold.
  - _Requirements: 1.2, 1.3_
  - _Boundary: Per-host Scaffolds_
  - _Depends: 2.1_

- [x] 6.2 (P) Shopify host scaffold
  - Create `configurations/shopify/home-manager/sqlite-backup.nix` with the same dormant shape as Personal.
  - Append `./sqlite-backup.nix` to `configurations/shopify/home-manager/default.nix` imports list.
  - Confirm: `nix flake check` passes for `darwinConfigurations.ShopifyLaptop` with the new scaffold.
  - _Requirements: 1.2, 1.3_
  - _Boundary: Per-host Scaffolds_
  - _Depends: 2.1_

- [x] 6.3 Common-darwin and HM common import additions
  - Append `./sqlite-backup.nix` to the explicit imports list in `home-manager/common/default.nix` (sibling to existing `./atuin.nix`, `./cc-sdd.nix`, etc.).
  - Append `./sqlite-backup-verify.nix` to the imports list in `configurations/common-darwin/default.nix` (sibling to existing `./mcp-sops-bridge.nix`).
  - Confirm: both `darwinConfigurations` evaluate cleanly under `nix flake check` with all wiring in place.
  - _Requirements: 1.1_
  - _Depends: 5.2, 6.1, 6.2_

- [ ] 7. Operator runbook

- [x] 7.1 (P) Bootstrap procedure
  - Create `.kiro/specs/sqlite-backup/runbook.md` with a numbered phase-by-phase one-time-per-host setup procedure:
    - Bootstrap rclone destinations interactively (`rclone config` per remote; OAuth dance).
    - Encrypt the rclone config (`rclone config encryption set`).
    - Stash both passphrases (rclone-config, restic-archive) in 1Password under `op://Private/sqlite-backup-...` paths.
    - Sync passphrases to `secrets/mcp.<host>.yaml` via the existing sops workflow.
    - Add `home.mcp.keychainSecrets` entries pointing at the 1Password URLs.
    - Declare destinations in the per-host scaffold's `home.sqliteBackup.rcloneDestinations`.
    - Run `darwin-rebuild switch`; verify R17 verification passes.
    - Run `sqlite-backup verify-credentials` for round-trip access confirmation.
  - Document the "adding a new database" follow-up procedure: scaffold edit → rebuild → first scheduled cycle auto-inits remote repo with `--copy-chunker-params` → log inspection.
  - Confirm: a fresh-host operator following the runbook step-by-step lands at "first successful scheduled archive-tier run" without ambiguous steps.
  - _Requirements: 9.1, 9.2_
  - _Boundary: runbook.md_
  - _Depends: 1_ (only needs the spec; no code dependency — true earliest start is right after Task 1 even though listed under Major 7 for phase clarity)

- [x] 7.2 Recovery procedures
  - Add a Recovery section to `.kiro/specs/sqlite-backup/runbook.md` covering each scenario:
    - **Recovery to latest committed transaction** (local repo intact): single-line `sqlite-backup restore <db> --target <path>` plus the underlying `restic restore` + `litestream restore` decomposition for operators who prefer manual control.
    - **Recovery to specific point-in-time**: `sqlite-backup restore <db> --target <path> --time <iso8601>` with explanation of how `--time` maps to restic snapshot selection + `litestream restore -timestamp`.
    - **Recovery from off-host destination only** (host-loss): step-by-step new-host bootstrap (rclone config + Keychain re-stash on new host, same passphrases) followed by `sqlite-backup restore <db> --from-remote ...`.
    - **Recovery from on-host repo only** (off-host destination unreachable): default `sqlite-backup restore <db>` flow, no extra steps.
  - Document inspection patterns: `restic snapshots --tag <any>` for unified per-tier listing (R16.3).
  - Confirm: each scenario has both a `sqlite-backup` one-liner and the underlying tool decomposition, so an operator can choose based on confidence level.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 16.3_
  - _Boundary: runbook.md_

- [ ] 8. Validation

- [x] 8.1 nix flake check on both architectures passes for dormant config
  - Run `nix flake check --all-systems` against the repo root after all integration tasks complete.
  - Verify both `aarch64-darwin` and `x86_64-darwin` evaluations pass for `darwinConfigurations.{Brandons-MacBook-Pro, ShopifyLaptop}`.
  - Confirm: zero new errors, zero new warnings beyond pre-existing baseline; pre-commit checks (statix, deadnix, nixfmt) all pass.
  - _Requirements: 1.3, 10.3_

- [x] 8.2* (P) Synthetic eval-time assertion tests
  - Build three temporary expressions that instantiate the module with deliberately invalid inputs:
    - (a) `databases = [ { remote = "missing"; ... } ]` with `rcloneDestinations = { }` — should fail R1.5 assertion naming "missing".
    - (b) Override `nixpkgs.system` to `x86_64-linux` — should fail R10.2 platform assertion.
    - (c) Override `pkgs.litestream` to a stubbed `0.3.13` package — should fail R11.2 version assertion.
  - For each, verify `nix eval` exits non-zero and the error message contains the expected named cause.
  - Confirm: all three assertion paths fire as documented in their failure messages; no false-pass, no false-fail.
  - _Requirements: 1.5, 10.2, 11.2_

- [x] 8.3 (P) Pre-commit hooks pass on all new and modified files
  - Run `pre-commit run --all-files` (or equivalent via the symlinked `.pre-commit-config.yaml`).
  - Verify no `/tmp/` literals in any new `.nix` files, no literal `/Users/...` paths outside `${...}` interpolations, no `builtins.fetch*` outside `flake.nix`.
  - Confirm: pre-commit run exits 0 across all new and modified files.
  - _Requirements: implied by repo conventions; lint-pass gate for landing_

- [ ] 9. Persistent emergency halts

- [x] 9.1 Separate pressure state and guarded recovery
  - Preserve manual `halt-<db>.flag` behavior and add persistent `pressure-<db>.json` emergency state with a versioned structured schema.
  - Make activation preserve pressure markers; make `start` refuse them; make replication, archive, and on-demand backup skip before locking.
  - Add `clear-pressure <db>` with fail-closed current threshold validation and no automatic launchd transition; expose the halt reason through `status`.
  - Add a focused hermetic flake check using temporary state and stubbed `launchctl`, `df`, and `du`, including execution of the rendered HM activation fragment.
  - _Requirements: 18.1-18.9_
  - _Boundary: HM Module, CLI Script, sqlite-backup focused tests_

- [ ] 10. Proactive disk-pressure guard

- [x] 10.1 Add periodic and synchronous byte-limit enforcement
  - Add host-wide minimum filesystem available bytes and check interval options plus a per-database maximum managed local bytes option; render integer limits and managed paths into the manifest.
  - Render Litestream `meta-path` inside each database's managed root and include staging, restic, and metadata paths in physical allocated-byte accounting.
  - Add an independent per-database RunAtLoad/StartInterval guard and run the same guard before every backup lock acquisition.
  - Atomically persist the Requirement 18 marker and unload only the affected Litestream agent on threshold or measurement failure.
  - Configure ShopifyLaptop with a 128 GiB floor, 60-second interval, and 96 GiB OpenCode ceiling; add hermetic boundary, error, render, and preflight tests.
  - _Requirements: 19.1-19.12_
  - _Boundary: HM Module, CLI Script, Shopify sqlite-backup wiring, sqlite-backup focused tests_
  - _Depends: 9.1_

- [ ] 11. Shopify local Google Drive destination

- [x] 11.1 Route Shopify repository copies through the Drive File Provider folder
  - Replace the configured `gdrive` remote with rclone's synthetic `:local`
    backend and use the existing `My Drive/sqlite-backup` folder as the absolute
    destination root for both Shopify databases.
  - Exclude `:local` from configured-remote matching while preserving encrypted
    rclone config and passphrase preflight behavior.
  - Include each local destination repository in pressure accounting and state
    explicitly that local write success does not prove Google Drive sync.
  - Add render and pinned Restic/rclone integration coverage for the exact
    backend syntax and a Drive-style path containing spaces.
  - _Requirements: 5.3, 5.4, 5.6, 19.4_
  - _Boundary: Shopify sqlite-backup wiring, HM manifest, rclone verification, focused tests_

## Parallel Execution Wave Map

The `(P)` markers above capture parallelism between immediately-adjacent peers,
but the true dependency graph allows broader concurrent execution across
swimlanes. This appendix documents the wave structure for `/kiro-impl` to
consume when dispatching subagents.

### Dependency edges (non-obvious cross-major)

- 4 → 2.5, 3.1
- 5.1 → 2.3
- 5.2 → 2.3, 5.1
- 6.1 → 2.1
- 6.2 → 2.1
- 6.3 → 5.2, 6.1, 6.2
- 7.1 → 1 (spec-only; no code dependency)
- 7.2 → 7.1 (same file)

All other dependencies are implied by document order.

### Concurrent waves

```
Wave 0  Foundation
        └── 1.    Litestream overlay

Wave 1  Module skeleton (gated by 1)
        ├── 2.1   HM module option surface
        └── 7.1   Bootstrap runbook (lane: docs; no code dep beyond the spec)

Wave 2  Module body + parallel scaffolds + verify-script (gated by 2.1, then 2.3)
        ├── Code lane (sequential within sqlite-backup.nix):
        │   ├── 2.2   Eval-time assertions
        │   ├── 2.3   Manifest renderer
        │   ├── 2.4   Halt-flag activation
        │   └── 2.5   launchd agents
        ├── Host-scaffold lane (parallel after 2.1):
        │   ├── 6.1   Personal scaffold
        │   └── 6.2   Shopify scaffold
        ├── Verify-script lane (starts after 2.3):
        │   └── 5.1   Verify script
        └── Docs lane:
            └── 7.2   Recovery runbook (after 7.1)

Wave 3  CLI binary (gated by 2.3)
        ├── CLI lane (sequential within sqlite-backup-cli.nix):
        │   ├── 3.1   Dispatcher and helpers
        │   ├── 3.2   list and status
        │   ├── 3.3   verify-credentials
        │   ├── 3.4   start and stop
        │   ├── 3.5   __replicate-trigger and __archive-trigger
        │   ├── 3.6   backup (on-demand)
        │   └── 3.7   restore
        └── (Verify-script lane from Wave 2 may still be running here)

Wave 4  Integration (gated by 2.5 + 3.1 for Task 4; by 5.1 for 5.2)
        ├── 4.    HM-CLI integration (after 2.5 + 3.1)
        └── 5.2   System activation wiring (after 5.1; depends on 2.3 already done)

Wave 5  Final wiring (gated by 4 + 5.2 + 6.1 + 6.2)
        └── 6.3   Common-darwin and HM common imports

Wave 6  Validation (parallel after 6.3)
        ├── 8.1   nix flake check on both arches
        ├── 8.2*  Synthetic assertion tests
        └── 8.3   Pre-commit hooks
```

### Schedule implications

- **Critical path** (longest dependency chain):
  `1 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 4 → 6.3 → 8.1`
  ≈ 15 sequential tasks × ~1.5h average = ~22h on the critical path.
- **Off-critical-path tasks** (`6.1`, `6.2`, `5.1`, `7.1`, `7.2`, `5.2`, `8.2`, `8.3`)
  total ≈ 9h of work, parallelizable into the schedule slack.
- **Total work** ≈ 31h. **Wall-clock with parallelism** ≈ 22–24h
  (roughly 25–30% faster than purely sequential at ~31h).

### Recommended dispatch for `/kiro-impl`

If the implementer can run multiple subagents concurrently:

- After Task 1 completes: dispatch 2.1 + 7.1 in parallel (different files,
  no shared dep).
- After 2.1: dispatch 6.1, 6.2, 7.2 in parallel with the continuing 2.2
  → 2.5 chain.
- After 2.3: dispatch 5.1 in parallel with the continuing 2.4 → 2.5 chain
  AND with 3.1 once 2.5 + 3.1's data dep is satisfied (3.1 starts after
  2.3 since it bakes the manifest path).
- 5.1 typically completes before 5.2 unblocks, fitting naturally into
  the gap between Wave 3 and Wave 4.
- Wave 6 (8.x) can be dispatched as three concurrent jobs since they
  only read repo state.

If running purely sequential (no parallel dispatch capability), follow
document order — the (P) markers and dependencies still validate correctness
even when not exploited.

## Implementation Notes

- **Task 3.2** introduced a 4th `replication-state` value `not-running` (when no halt flag is set but the launchd Litestream agent is not loaded — happens in pre-bootstrap and synthetic test environments). Tasks.md and R13.18 originally specified a closed 3-value enum. The implementer's choice is operationally sound (don't lie about pipeline health). Future spec amendment should reconcile: extend the enum to include `not-running` (preferred) or document that the 3-value enum applies only on a host with the agent live. The literal R13.18 confirm criterion (`status cavemem` reports `running` with one DB and no halt) is satisfied on a live host where the agent is loaded.
- **Task 3.2** also surfaced minor spec-vs-implementation field-name drift (design.md uses `last-archival-snapshot-timestamp` / `last-replicate-shipment-timestamp`; tasks.md uses `last-replication-snapshot timestamp` / `last-archive-snapshot timestamp`; implementation matched tasks.md). Not implementation-blocking; reconcile in spec.
- **Tasks 6.1 / 6.2 deferred their per-host import-list additions to Task 6.3** (Approach A from the review). The per-host scaffolds reference `home.sqliteBackup.enable`, an option only defined when the HM module is imported via `home-manager/common/default.nix` — which is also Task 6.3's job. Task 6.3 must therefore append `./sqlite-backup.nix` to BOTH `configurations/personal/home-manager/default.nix` AND `configurations/shopify/home-manager/default.nix` IN ADDITION TO its documented work on `home-manager/common/default.nix` and `configurations/common-darwin/default.nix`. Without this, R1.2/R1.3 (dormant declaration on each host) silently fails to land.
- **Post-implementation amendment (2026-05-13): per-database staging+restic nesting.** The original spec rendered staging and restic paths as `${xdg.dataHome}/sqlite-backup/{litestream-staging,restic}/<db>` (per-artifact-type, then per-DB). Operator preference shifted to per-DB nesting: `${xdg.dataHome}/sqlite-backup/<db>/{litestream-staging,restic}`. Rationale: groups all per-DB content together, simpler to reason about per-DB destruction/migration/inspection. Implementation touched only `home-manager/common/sqlite-backup.nix` (manifest renderer + `stagingDirFor` helper for the launchd Litestream agent ProgramArguments); the CLI script reads paths from the manifest and required no changes. Verified by building the manifest derivation against a synthetic one-DB config and inspecting the rendered `stagingDir`/`repoDir`. No on-disk migration was needed — the feature is dormant on both hosts (`databases = [ ]`). All spec docs (design, tasks, research, runbook, brief, requirements) updated to match. The `brief.md` and `requirements.md` architecture diagrams additionally renamed `litestream/<db>` → `<db>/litestream-staging` to align with the design doc's "litestream-staging" terminology (the brief/requirements diagrams predated that rename).
- **Task 9.1** established fail-closed pressure state: absence must be provable through searchable ancestors, and marker writers share a transition lock with `clear-pressure`, which measures an immutable snapshot and version-checks before removal.
- **Task 10.1** follows command-line managed-root symlinks with `du -H` without traversing nested links; every marker-generation failure preserves a durable `.failed` sentinel.
- **Task 11.1** treats Google Drive File Provider synchronization as external: `restic copy` success covers the local `:local:` repository only, and that repository remains inside pressure accounting.
