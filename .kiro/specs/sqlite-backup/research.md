# Gap Analysis: sqlite-backup

Date: 2026-05-12. Inputs: `requirements.md` (R1–R13), `brief.md`,
discovery memories (`2026-05-09-sqlite-backup-tooling-survey.md`,
`2026-05-09-sqlite-cloud-backup-plan.md`,
`2026-05-12-sqlite-backup-pipeline-pivot.md`), the discovery-time
codebase scan, and a targeted recon dispatched specifically for this
phase.

Context limitations: `.kiro/steering/` is empty (no `product.md` /
`tech.md` / `structure.md`); analysis falls back on the brief and the
two existing specs as the source of truth for repo conventions.

## 1. Current State

### 1.1 Domain-relevant assets already in the repo

- **`pkgs.rclone`** is installed at
  `home-manager/common/default.nix:101`. No managed config, no
  declared remotes, no consumer.
- **`pkgs.litestream`**: NOT installed anywhere in the tree.
  `pkgs.litestream` in `nixpkgs-25.11` is v0.3.13 (legacy
  generations layout, NOT the LTX-segments file backend the pipeline
  depends on). However, **`pkgs.unstable.litestream` is v0.5.11**
  (verified via
  `nix eval --raw '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.unstable.litestream.version'`),
  available because `flake.nix:4` pins `nixpkgs-unstable` as a flake
  input and `configurations/common-darwin/default.nix:84` wires the
  `unstable-packages` overlay. **This collapses the "overlay strategy"
  question down to a one-line lift from `unstable`.**
- **`pkgs.restic`**: NOT installed anywhere in the tree. nixpkgs-25.11
  ships restic v0.18.1 (current upstream).
- **`mcp-secrets-sops-nix`** (just landed, phase verified through
  Phase 5): provides the canonical secrets pipeline this spec must
  consume. See §1.3 for integration depth.

### 1.2 Module & wiring conventions

- `home-manager/common/default.nix:8-21` uses an **explicit import
  list** — every neighbor `.nix` file is listed by name. No
  `lib.filesystem.listFilesRecursive`-style auto-import anywhere.
  Adding `home-manager/common/sqlite-backup.nix` requires one new line
  in that import list.
- **Per-host scaffolding** lives at
  `configurations/{personal,shopify}/home-manager/default.nix`. Each
  host imports `../../../home-manager/common` and `../../../home-manager/mcp`
  plus host-specific neighbors.
- **launchd agent surface**: home-manager-Darwin's `launchd.agents.<name>`
  (NOT nix-darwin's `launchd.user.agents`). Canonical always-on
  example: `home-manager/mcp/default.nix:124-147` (KeepAlive=true,
  RunAtLoad=true, StandardOutPath/StandardErrorPath under
  `~/Library/Logs/`). Canonical one-shot example:
  `home-manager/common/opencode.nix:199-211` (RunAtLoad only).
  **There is no `StartCalendarInterval` precedent in the repo** —
  the scheduled-archival agent for this spec will be the first.

### 1.3 mcp-secrets-sops-nix integration contract

Bridge module: `configurations/common-darwin/mcp-sops-bridge.nix`.
Activation script: `scripts/mcp-secrets-activate.nix`. Verifier:
`scripts/mcp-verify-secrets.nix`. Pipeline:

```
secrets/mcp.<host>.yaml  (sops-encrypted, flat <service>: ENC[…])
    │
    ▼  decrypted by sops-nix at activation
/run/secrets/*  (mode-0400, root-owned)
    │
    ▼  mcp-secrets-activate (system.activationScripts.postActivation, lib.mkOrder 9999)
~/Library/Keychains/login.keychain-db  (Keychain account: mcp-hub, HARDCODED)
    │
    ▼  consumers
home.mcp.readKeychainSecret "<service-name>"
    = "${cmd: /usr/bin/security find-generic-password -s '<service>' -a mcp-hub -w}"
```

Key contract points relevant to sqlite-backup:

- **Account `mcp-hub` is hardcoded** at `scripts/mcp-secrets-activate.nix:154-162`
  (`security add-generic-password -s "$service" -a mcp-hub -w`) and at
  `scripts/mcp-verify-secrets.nix:140`. Supporting a separate
  `sqlite-backup` account requires generalising
  `mcp-secrets-activate` to accept an account argument and threading
  it through the manifest.
- **Single shared `keychainSecrets` attrset** per host —
  `mcp-sops-bridge.nix:74` aggregates `home.mcp.keychainSecrets` from
  any HM module on the host via standard module merging. A NEW HM
  module CAN contribute additional `keychainSecrets = { ... }` entries
  declaratively without modifying the bridge.
- **Only output shape supported is the lazy `${cmd:…}` mcphub
  token.** There is NO precedent for materialising a decrypted secret
  as a launchd `EnvironmentVariables` value or as a mode-0600 file on
  disk. A new module that needs runtime credentials must either shell
  out to `/usr/bin/security find-generic-password -s <name> -a
  mcp-hub -w` itself, or extend the bridge.
- **Activation script ordering**: the bridge uses
  `lib.mkOrder 9999` on `system.activationScripts.postActivation.text`
  (`mcp-sops-bridge.nix:142`) to sort strictly after
  `sops-install-secrets`. Any new activation client reading
  `/run/secrets/*` must do the same; the comment block at lines 22-53
  explains why `lib.mkAfter` alone is insufficient.
- **Sops yaml shape** (`secrets/mcp.<host>.yaml`): flat top-level
  `<keychain-service-name>: ENC[…]` entries. The repo's `mcp-sync-from-1password`
  script (exposed as flake app, `flake.nix:152-157`) is the canonical
  add path.

### 1.4 Operator-command installation precedent

- `home-manager/common/cc-sdd.nix:58-62` adds a `writeShellApplication`-derived
  script (`cc-sdd-init`, imported from `scripts/cc-sdd-init.nix`) to
  `home.packages`. After `home-manager switch`, `cc-sdd-init` is on
  the operator's PATH via `~/.nix-profile/bin/`.
- `home-manager/mcp/default.nix:90-93` uses `pkgs.writeScriptBin`
  inline (`restart-mcp-hub`).
- **Manifest pattern** for baking per-database config into a script:
  `mcp-sops-bridge.nix:72-77` renders a JSON manifest via
  `pkgs.writeText`, then passes its store path as a command-line arg
  to the activation script. The script reads with `jq` at runtime.
  **This is the right pattern for the sqlite-backup operator
  commands** — keeps the script content decoupled from eval-time
  data so config changes re-render the manifest without re-deriving
  the script.

### 1.5 home-manager / nix-darwin built-in rclone support

- **home-manager DOES ship `programs.rclone`** at
  `<home-manager>/modules/programs/rclone.nix`, with declarative
  remote config rendering, secret-file injection, and FUSE mounts.
- **BUT it is Linux-only** — the module's `config` block emits
  `systemd.user.services` (lines 397-403). On Darwin it evaluates
  but only sets `home.packages = [ cfg.package ]`; the
  secret-injection oneshot and mounts are dead.
- **nix-darwin ships no `programs.rclone`**.
- **Conclusion**: hand-roll `xdg.configFile."rclone/rclone.conf"`.
  Don't consume the HM module beyond optionally enabling
  `programs.rclone.enable` for its package installation (which is
  redundant with the existing `home.packages` entry).

### 1.6 launchd `StartCalendarInterval` schema (for the first-time-in-repo agent)

Reference: home-manager 25.11 `modules/launchd/types.nix:98-149`.
`launchd.agents.<name>.config.StartCalendarInterval` accepts a single
submodule OR a non-empty list of submodules; each submodule has:

| Key | Type | Notes |
|-----|------|-------|
| `Minute` | `nullOr (ints.between 0 59)` | null = wildcard |
| `Hour` | `nullOr (ints.between 0 23)` | null = wildcard |
| `Day` | `nullOr (ints.between 1 31)` | day of month |
| `Weekday` | `nullOr (ints.between 0 7)` | 0 and 7 both = Sunday |
| `Month` | `nullOr (ints.between 1 12)` | |

Empty attrset = "every minute". For daily 03:00:
`{ Hour = 3; Minute = 0; }`.

`StartInterval` (seconds, fixed cadence) is the alternative if
calendar semantics are not needed. `StandardOutPath` /
`StandardErrorPath` work for any agent type regardless of trigger;
no schema distinction between periodic and KeepAlive.

### 1.7 Lint hooks and pre-commit posture

`.pre-commit-config.yaml` is a symlink to a Nix-store JSON. Active
hooks (from `flake.nix:228-271`):

- `nixfmt-rfc-style`, `statix`, `deadnix --fail`, `flake-checker`.
- **`no-tmp-paths`**: bans `/tmp/` literals in `*.nix`. New module
  must use `${config.xdg.cacheHome}` or wrapper-script-supplied
  paths.
- **`no-builtins-fetch`**: bans `builtins.fetchGit/fetchTarball/fetchurl`
  outside `flake.nix` and `configurations/shopify/default.nix`.
  Litestream overlay must lift from `pkgs.unstable` (already an
  available channel) rather than fetch source — perfectly aligned
  with the recon's v0.5.11-already-available finding.
- **`no-hardcoded-users`**: bans literal `/Users/...` outside
  `${...}` interpolations. Module must use
  `${config.home.homeDirectory}` consistently.

`nix flake check` covers formatting, pre-commit-check, and (on
aarch64-darwin only) three nixvim tiers via `pkgs.runCommand`. **No
HM-module smoke-test precedent exists outside nixvim** — this spec
either inherits the nixvim test style or establishes a lighter
convention.

## 2. Requirement-to-Asset Map

For each requirement, the assets that already exist, the gap, and
the classification (Missing / Partial / Convention exists / Constraint).

| # | Requirement | Existing assets | Gap | Status |
|---|-------------|-----------------|-----|--------|
| R1 | Declarative module, dormant default | HM module convention (`home-manager/common/default.nix:8-21`); `mkOption` / `mkEnableOption` idioms used throughout | New module file with option surface | **Missing** |
| R2 | Continuous replication | `pkgs.unstable.litestream` v0.5.11; launchd `KeepAlive` pattern at `home-manager/mcp/default.nix:124-147` | Litestream-config rendering, launchd agent, sleep/wake observation | **Missing** |
| R3 | Scheduled archival snapshots | `pkgs.restic` 0.18.1 in nixpkgs; `launchd.agents.<name>.config.StartCalendarInterval` schema available (§1.6) | restic via wrapper, schedule per DB, retention policy | **Missing** |
| R4 | Off-host shipment | `pkgs.rclone` already installed (`home-manager/common/default.nix:101`) | rclone invocation in same wrapper as restic | **Partial** (rclone present, no usage) |
| R5 | Pluggable destination set | `pkgs.rclone` (backends universe), `xdg.configFile."rclone/rclone.conf"` mechanism | Hand-rolled rclone.conf rendering (HM's `programs.rclone` is Linux-only per §1.5) | **Missing** |
| R6 | Confidentiality of archives | restic built-in client-side AES-256 | Passphrase plumbing through Keychain | **Missing** (mechanism exists in tool) |
| R7 | sops-to-Keychain bridge consumption | `configurations/common-darwin/mcp-sops-bridge.nix`; `home.mcp.keychainSecrets`; `home.mcp.readKeychainSecret` helper; `mcp-hub` account hardcoded (§1.3) | Decision: reuse `mcp-hub` account vs extend bridge for `sqlite-backup` account; how the launchd agent reads (cmd-shell-out vs new bridge path) | **Partial** (bridge exists; integration model needs design choice) |
| R8 | Concurrency safety | None | `flock`-mutex in wrapper script | **Missing** |
| R9 | Recovery procedure | None | Documentation (runbook) + R13 commands | **Missing** |
| R10 | macOS-only targeting | `flake.nix:309-330` declares only `darwinConfigurations` | Eval-time platform assertion | **Missing** (need explicit guard) |
| R11 | Tool version gating | None | Eval-time assertion against `pkgs.litestream.version` (constants declared in one place per AC3) | **Missing** |
| R12 | Operational visibility | Logging precedent at `home-manager/mcp/default.nix:144-145` (`~/Library/Logs/<name>.log`) | Apply pattern per-agent | **Convention exists** |
| R13 | Operator commands on PATH | `home-manager/common/cc-sdd.nix:58-62` precedent (writeShellApplication → home.packages); manifest pattern at `mcp-sops-bridge.nix:72-77` | New commands; per-DB manifest | **Missing** (pattern clear) |

**Summary**: 10 Missing, 2 Partial, 1 Convention-exists, 0 Constraint
blockers. There is nothing to "extend" in the existing-domain sense
— the SQLite-backup pipeline is new-feature work inside a brownfield
repo that supplies infrastructure (sops bridge, launchd surface,
rclone install) the new module will compose.

## 3. Implementation Approach Options

### Option A: Extend existing components

**Not applicable for the main thrust.** No SQLite backup mechanism
exists to extend. The only "extension" candidates are:

- Extending `mcp-sops-bridge` to support a parallel `sqlite-backup`
  Keychain account (see Option C below).
- Extending `home-manager/common/default.nix` import list — that's a
  one-liner, not a meaningful "approach".

### Option B: All-new module composing existing infrastructure (Recommended)

- New `home-manager/common/sqlite-backup.nix` HM module.
- New `overlays/litestream.nix` (one-line lift from `pkgs.unstable.litestream`).
- New per-host scaffolding files in
  `configurations/{personal,shopify}/home-manager/sqlite-backup.nix`
  (dormant: `enable = true; databases = [ ]; rcloneRemotes = { }`).
- New operator commands as `pkgs.writeShellApplication` derivations
  added to `home.packages`.
- Reuse `mcp-sops-bridge` unchanged with the existing `mcp-hub`
  Keychain account; add new `keychainSecrets` entries to the
  per-host HM config alongside the existing mcp entries (the bridge
  picks them up via module merging per §1.3).
- The launchd wrapper shells out to
  `/usr/bin/security find-generic-password -s <svc> -a mcp-hub -w`
  at runtime to acquire credentials — mirrors the cmd-token shape
  without requiring new bridge infrastructure.

**Trade-offs**:
- ✅ Lowest blast radius — no edits to already-shipped plumbing.
- ✅ Single PR, single spec, single test surface.
- ✅ Inherits the bridge's audit story (verifier already covers
  any new entries).
- ❌ Conflates two namespaces in the Keychain (`mcp-hub` account
  holds MCP secrets AND sqlite-backup secrets).
- ❌ Operator browsing the Keychain sees a mixed list of
  `mcp-*` and `sqlite-backup-*` services under one account.

### Option C: New module + targeted bridge extension

Same as B, but also extend `scripts/mcp-secrets-activate.nix` and
`mcp-sops-bridge.nix` to accept a per-consumer Keychain account
name. `home.mcp.keychainAccount` becomes a default (`"mcp-hub"`) and
`home.sqliteBackup.keychainAccount` can override to `"sqlite-backup"`.
The manifest then names the account per-entry.

**Trade-offs**:
- ✅ Clean namespace separation per consumer.
- ✅ Idiomatic for future consumers (the third HM module to need
  secrets won't have to invent a new pattern).
- ❌ Touches mcp-secrets-sops-nix-shipped plumbing — changes the
  verifier, the activation script, the JSON manifest schema, and
  every consumer's options (defaulting in for backward compat).
- ❌ Larger PR surface; harder to test in isolation.
- ❌ Strictly speaking, this is work for a separate spec (refactor
  mcp-secrets-sops-nix's account model). Bundling it into
  sqlite-backup conflates two concerns.

### Recommendation

**Option B** for this spec. Option C's namespace cleanup is a
worthwhile future refactor, but it's not gated on sqlite-backup and
the discovery brief's `Out of Boundary` section explicitly notes
"wholesale replacement of the existing `mcp-secrets-sops-nix`
plumbing" is out of scope. R7's wording ("the same sops-managed
pipeline used by the existing `mcp-secrets-sops-nix` work") is
satisfied by either option — Option B re-uses the SAME pipeline
unchanged.

If, during design, namespace conflation becomes uncomfortable enough
to address, file a separate spec to generalise the bridge's account
model and migrate both consumers.

## 4. Effort and Risk

**Effort: M (3–7 days, 1 operator)**

- HM module: ~200–400 LoC of Nix (option declarations, assertions,
  config rendering, launchd agent definitions).
- Overlay: ~10–20 LoC of Nix (lift from `pkgs.unstable.litestream`).
- Backup wrapper script: ~80–150 LoC of bash via
  `writeShellApplication` (flock, restic invocation, rclone sync,
  logging, exit-code propagation).
- Operator commands (backup-on-demand + restore): ~100–200 LoC of
  bash, manifest-driven.
- Runbook: ~150–300 lines of markdown.
- Smoke test: ~30–80 LoC of Nix (pure-eval, dormant config
  evaluation passes; mirrors nixvim-tier style at smaller scale).

**Risk: Medium-Low**

- Pipeline architecture pre-validated (discovery viability check).
- All upstream tools available in pinned channels (v0.5.11 from
  unstable for Litestream; current restic in 25.11; rclone already
  on disk).
- `lib.mkOrder 9999` activation ordering pattern documented and
  proven (`mcp-sops-bridge.nix:142`).
- Lowest-risk integration model (Option B) doesn't touch shipped
  plumbing.
- Main remaining unknowns are R-1 / R-3 (see §5) — both are bash-and-
  config questions, not architectural ones.

The previously-flagged Litestream version showstopper is mooted by
the v0.5.11-in-unstable finding.

## 5. Research Items for Design Phase

Items to resolve during `/kiro-spec-design`. None are blocking; each
has a viable default the design can either accept or refine.

- **R-1: rclone secrets injection model.** Three credible patterns
  for getting Keychain-stored OAuth tokens / API keys into rclone at
  invocation time:
  1. **Env-var-only** — rendered `rclone.conf` contains only
     non-secret config (remote `type`, region, endpoint, etc.). The
     wrapper exports `RCLONE_CONFIG_<REMOTE>_<KEY>` env vars from
     `security find-generic-password` before invoking `rclone sync`.
     rclone's documented mechanism. No secrets on disk in
     `~/.config/rclone/rclone.conf` at any point.
  2. **Activation-rendered conf with secrets inlined** — activation
     script reads `/run/secrets/*` and writes a complete
     `rclone.conf` to `~/.config/rclone/rclone.conf` with mode 0600.
     Simpler at invocation; secrets live in a single mode-0600 file.
  3. **Cmd-token style** — rclone.conf contains command-substitution
     tokens (rclone supports `--password-command` for crypt; less
     clear for arbitrary backend fields). Not all rclone backends
     support this.
   
   **Default**: pattern 1 (env-var-only). Cleanest privacy story;
   matches the existing `${cmd:…}` philosophy in this repo.

- **R-2: Keychain account namespace.** Stick with `mcp-hub` (Option
  B in §3) or extend the bridge (Option C). **Default**: `mcp-hub`.

- **R-3: Operator command surface (R13).** Single multi-subcommand
  binary (`sqlite-backup backup <db>`, `sqlite-backup restore <db> ...`)
  vs two separate commands (`sqlite-backup-now <db>`,
  `sqlite-backup-restore <db> ...`). **Default**: single binary
  with subcommands; better discoverability (`sqlite-backup --help`
  shows the surface) and one entry in `home.packages`.

- **R-4: R11 eval-time version assertion mechanism.** nix-darwin /
  HM accept `assertions = [ { assertion = ...; message = ...; } ]`
  natively. **Default**: declare the minimum-version constants in a
  single `let`-binding at the top of the module; emit `assertions`
  entries that compare against `pkgs.litestream.version`,
  `pkgs.restic.version`, `pkgs.rclone.version`. R11.AC3 is satisfied
  by the single `let`-binding location.

- **R-5: Smoke test mechanism.** The nixvim tier uses
  `pkgs.runCommand` for three-tier tests. **Default**: lightest
  possible — a single `nix flake check` smoke test that evaluates
  the module with `enable = true; databases = [ ]; rcloneRemotes = { }`
  on both architectures. Confirms the dormant default passes
  evaluation. Defer integration-tier testing.

- **R-6: launchd agent label convention.** The brief noted
  vendor-rooted labels for upstream tools (`io.litestream.replicate`)
  and repo-rooted labels for owned wrappers (`dev.dwsr.sqlite-backup.<db>`).
  **Default**: as briefed.

- **R-7: Restore-time access to off-host repo when on-host state is
  missing (R13.AC8 + R9.AC4 "off-host destination is available, no
  on-host state remains").** The wrapper must be able to point
  restic at a remote restic repo accessed via rclone — meaning the
  RESTORE path DOES use `restic -r rclone:<remote>:<path>` even
  though the BACKUP path uses `restic -r <local-path>`. Confirm
  this asymmetry is acceptable (it should be — backup wants
  local-fast-path, restore-after-host-loss has no local choice).
  **Default**: yes, restore uses rclone backend when local repo is
  absent or `--from-remote` flag is passed.

## 6. Recommendations for Design Phase

- **Adopt Option B** as the implementation approach.
- Lock in defaults R-1 through R-7 in `design.md` unless explicit
  reason to deviate. Each default is the least-surprising answer
  that satisfies the relevant requirement.
- Sequence the module-internal pieces of work in `tasks.md` roughly
  as: overlay → module skeleton (option surface only, dormant) →
  pre-flight assertions (R10, R11) → litestream agent (R2) →
  rclone.conf rendering + sops wiring (R5, R7) → archival wrapper
  (R3, R4, R6, R8) → operator commands (R13) → runbook (R9) →
  smoke test (mechanical Nix check) → host activation (dormant on
  both).
- Defer ALL operational testing (real DB, real remote, end-to-end
  restore drill) to the follow-up PR that wires the first real
  database. The dormant landing is the deliverable for this spec.

## 7. Constraints to Carry Forward

These have already been encoded as requirements (R10, R11, R8,
R6/R7) but are restated here for the design phase's reference:

- macOS-only (R10).
- Litestream ≥ v0.5.7 (R11) — satisfied by v0.5.11 in unstable.
- `--exclude='*.tmp'` in restic backup of Litestream segments dir
  (R3.AC5 — encoded as "produce archival snapshots that, when
  restored, recover state regardless of mid-rotation timing").
- `flock` serialization (R8) — encoded as concurrency-safety
  invariants.
- Lint hooks: no `/tmp/`, no literal `/Users/...`, no
  `builtins.fetch*` outside `flake.nix` — design must use
  `${config.home.homeDirectory}`, `${config.xdg.dataHome}`,
  `${config.xdg.configHome}` exclusively, and the overlay must lift
  from `pkgs.unstable` (no source-build).
- Activation ordering: `lib.mkOrder 9999` post-sops-nix.

---

# Gap Analysis Refresh: 2026-05-13

The May-12 analysis above was written against the original architecture
(two on-disk stores: Litestream segments dir + separate restic repo;
Mechanism B / env-var-injection as the recommended secrets model).
The spec has since pivoted substantially. This refresh re-evaluates
all 17 requirements against the current architecture:

- **Single restic repository per database** holds both
  continuous-replication-tier snapshots (high-frequency) and
  archival-tier snapshots (scheduled), distinguished by tag (R16).
- **Continuous off-host shipment** of the repo at ~5-min cadence,
  decoupled from the archival schedule (R14).
- **Offline-resilient local operation** — replication and archival
  continue when the destination is unreachable; off-host shipment
  queues and converges on reconnect (R15).
- **Mechanism A locked in** for rclone secrets: operator-managed
  rclone configuration encrypted at rest with rclone's native
  `RCLONE_ENCRYPT_V0` mechanism; encryption passphrase in Keychain
  (R7.AC5).
- **Activation-time verification** of the operator's rclone config
  (R17) — file exists, is encrypted, decrypts cleanly with the
  Keychain-supplied passphrase, contains every Nix-declared
  destination with a matching backend type.
- **Named-set destination configuration** in Nix
  (`rcloneDestinations = { gdrive = { type = "drive"; ... }; ... }`)
  with database entries referencing destinations by name; eval-time
  failure on missing reference (R1.AC5, R5.AC5).
- **Operator commands** expanded to include `list`, `status`,
  `verify-credentials`, plus `start`/`stop` replication and the
  whole-pipeline halt flag (R13, 24 ACs).

Sources for this refresh: requirements.md (775 lines, 17 reqs);
discovery brief.md; targeted recon dispatched 2026-05-13. Steering
directory still empty (no `product.md` / `tech.md` / `structure.md`).

## Refreshed Current State (deltas only)

The repo conventions documented in §1 of the May-12 analysis remain
valid; only the deltas relevant to the new requirements are listed
here.

- **`pkgs.unstable.litestream` v0.5.11** confirmed (May-12). One-line
  overlay still the right plan. The May-12 SHOWSTOPPER is fully
  retired.
- **`rclone v1.72.1`** is what's installed via
  `home-manager/common/default.nix:101`. All four CLI surfaces R17
  and R13 need are confirmed working with `RCLONE_PASSWORD_COMMAND`:
  - `rclone config encryption check` (exit 0 if encrypted +
    correct password; non-zero if unencrypted; non-zero with clear
    error if password wrong) — perfect for R17.AC2 + R17.AC5.
  - `rclone listremotes --long --json` returns
    `[{"name":"...","type":"...","source":"file","description":""}]`
    — perfect for R17.AC3 + R17.AC4 (parse JSON, build name→type
    map, compare against Nix-declared `rcloneDestinations`).
  - `rclone config dump` for deeper per-remote option verification
    (not strictly needed for current R17 ACs but available).
  - `rclone lsd <remote>:` round-trips to the provider — perfect
    for R13.AC20 `verify-credentials` live access check.
- **Encrypted rclone config on-disk format** (per local empirical
  test): three deterministic header lines —
  `# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:`
  followed by base64 ciphertext. Cheap fast-path detection via
  `head -3 <file> | grep -q '^RCLONE_ENCRYPT_V0:$'`; authoritative
  detection via `rclone config encryption check`.
- **`home.activation.<name>`** is HM 25.11's user-tier activation
  hook. Schema: `lib.hm.types.dagOf types.str` (Bash strings wrapped
  via `lib.hm.dag.entryAfter ["writeBoundary"] ''…''`). Runs as the
  user with `HOME` set, via `launchctl asuser … sudo -u $user
  --set-home …/activate`. PATH constrained to a curated whitelist
  (coreutils, jq, gnused, etc.); absolute paths bypass it, so
  `/usr/bin/security find-generic-password` works. **No live use of
  `home.activation.<name>` anywhere in this repo today** — the
  sqlite-backup module will be the first user. (HM internally uses
  it for `home.activation.setupLaunchAgents` but that's HM's own
  plumbing.)
- **HM activation runs BEFORE `mcp-secrets-activate`.** HM appends
  user activation at default priority (`mkOrder 1000`); the bridge
  runs at `mkOrder 9999`. Important consequence below in §3.
- **`launchd.agents.<name>.config.StartInterval`** is exposed by
  HM 25.11 (`modules/launchd/launchd.nix:388-396`) as
  `nullOr int`, no upper bound. For 5-min cadence:
  `StartInterval = 300`. Sleep coalescing is launchd-native — one
  catch-up invocation on wake, not 12 queued. Not affected by
  `ThrottleInterval` (default 10s, only matters if job exits in
  <10s).
- **`flock(1)` is NOT on macOS by default.** The May-12 R8
  concurrency-safety AC required `flock` serialization; this is no
  longer trivially available. Workarounds: nixpkgs `pkgs.flock`
  (BSD-licensed util-linux port for macOS), `mkdir`-based atomic
  lockfile pattern in bash, or launchd's `LaunchOnlyOnce` + manual
  semaphore. Design call.
- **`restic 0.18.1`** in nixpkgs-25.11 supports the tagging primitives
  R3 + R14 + R16 jointly need: `restic backup --tag <name>` (multiple
  allowed); `restic forget --tag <name>` (filter scope, NOT
  protect — that's `--keep-tag`); `restic forget --group-by tag`
  (apply policies independently per tag-group). The right pattern
  for two-tier retention in one repo is **two separate `restic
  forget` calls per tier**, each with `--tag` filter + tier-specific
  `--keep-*` policy. (Single call with `--group-by tag` works but
  conflates the two policies into one decision tree, which is harder
  to reason about; two calls is cleaner.)
- **Codebase deltas since May-12**: 7 commits, all in
  `mcp-secrets-sops-nix` cleanup tail (`826c23d` … `422727b`). None
  touch the sqlite-backup planned territory. The `mcp-sync-secrets`
  legacy bridge is now fully removed (commit `3443af1`), confirming
  sqlite-backup will be the first repo-local `home.activation`
  consumer.

## Refreshed Requirement-to-Asset Map

For each of the 17 current requirements: existing assets, the gap,
and classification.

| # | Requirement | Existing assets | Gap | Status |
|---|-------------|-----------------|-----|--------|
| R1 | Declarative module, dormant default, named-set + reference-by-name + eval-time validation | HM module convention; `mkOption` / `mkEnableOption` idioms; `assertions = [...]` precedent in HM modules (`launchd/default.nix:116-125`); `lib.hm.assertions.assertPlatform` for darwin gate | New module file with `attrsOf (submodule {...})` for `rcloneDestinations` (no in-repo precedent — first user); `assertions` for missing-reference eval-time failure | **Missing** (new module, new pattern in this repo) |
| R2 | Continuous replication, live-DB-accessible, sleep/wake, restart, on-host-only | `pkgs.unstable.litestream` v0.5.11; launchd `KeepAlive` pattern at `home-manager/mcp/default.nix:124-147` | Litestream config rendering (`xdg.configFile."litestream/litestream.yml"`), one always-on launchd agent multiplexing all DBs, segments dir under `${xdg.dataHome}/sqlite-backup/<db>/litestream-staging/` | **Missing** (no precedent) |
| R3 | Scheduled archival snapshots into single repo, per-DB schedule + retention | `pkgs.restic` 0.18.1; `--tag` and `--tag`-filtered `forget --keep-*` flags confirmed; `launchd.agents.<name>.config.StartCalendarInterval` for daily-03:00-style cadence | Per-DB scheduled launchd agent; restic backup with `--tag archive`; restic forget with `--tag archive --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` | **Missing** |
| R4 | Off-host shipment of archival snapshots (now references R14's continuous mechanism) | `pkgs.rclone` 1.72.1; rclone destinations reachable via `RCLONE_PASSWORD_COMMAND` | The shipment is no longer chained-after-archival; subsumed under R14's continuous mechanism — see R14 row | **Subsumed** by R14 |
| R5 | Pluggable destinations as named set; reference by name only | `pkgs.rclone`'s backend universe; `attrsOf (submodule {...})` Nix idiom | New `rcloneDestinations` option of type `attrsOf (submodule { options.type = mkOption {...}; ... })`; HM-level patterns at `programs/sftpman.nix:95` and `xdg-desktop-entries.nix:214` are the closest reference | **Missing** (new module shape) |
| R6 | Confidentiality of archival snapshots | restic's mandatory client-side AES-256 encryption | Passphrase plumbing through Keychain (single shared archival passphrase per host) | **Missing** (mechanism in tool, plumbing new) |
| R7 | sops-to-Keychain bridge consumption (encrypted rclone config + archival passphrase) | `mcp-sops-bridge.nix` aggregator; `home.mcp.keychainSecrets` attrs (module merging means new HM module CAN add entries declaratively); `lib.mkOrder 9999` activation precedent | Two new Keychain entries (`sqlite-backup-rclone-config-passphrase`, `sqlite-backup-archive-passphrase`); operator workflow to stash via 1Password sync | **Partial** (bridge works as-is; new entries to declare) |
| R8 | Concurrency safety inside archival pipeline | None | Wrapper-script mutex around restic + rclone serialization. **`flock(1)` not on macOS by default** — must add `pkgs.flock` to runtimeInputs OR use `mkdir`-based lockfile pattern. **Also**: launchd `StartInterval` does NOT prevent overlapping invocations on its own; mutex is required at the wrapper layer | **Missing** + **new constraint** (flock-on-macOS) |
| R9 | Recovery procedure | None | Documentation (operator runbook) showing: `rclone copy <remote>:<path> <local>` to fetch repo; `restic restore <snapshot> --target <path>` to extract a Litestream segments dir state at a point in time; `litestream restore -o <out.db> file://<segments-dir>` to materialize the SQLite DB | **Missing** (doc artifact) |
| R10 | macOS-only targeting | `flake.nix:309-330` declares only `darwinConfigurations`; `lib.hm.assertions.assertPlatform` available | `meta.platforms` declaration on the module + `lib.hm.assertions.assertPlatform pkgs lib.platforms.darwin` to fail evaluation on non-darwin | **Missing** (idiomatic, low effort) |
| R11 | Tool version gating | None | `assertions = [{ assertion = pkgs.litestream.version >= "0.5.7"; message = "..."; } …]`. With Litestream sourced from `pkgs.unstable` (v0.5.11), this is trivially satisfied today; the assertion is forward-protection | **Missing** (idiomatic, trivial) |
| R12 | Operational visibility | Logging precedent at `home-manager/mcp/default.nix:144-145` | Apply `~/Library/Logs/sqlite-backup-<db>.log` + `-error.log` per-agent | **Convention exists** |
| R13 | Operator commands (24 ACs covering backup, restore, list, status, start/stop, verify-credentials) | `home-manager/common/cc-sdd.nix:58-62` precedent (writeShellApplication → home.packages); `mcp-secrets-activate.nix:56-89` precedent for case-on-`$1` dispatch | New `sqlite-backup` single binary with subcommands; manifest pattern (per May-12 finding) for per-DB config | **Missing** (pattern clear, content new) |
| R14 | Continuous off-host shipment of replication state at ~5-min default cadence | `pkgs.rclone` 1.72.1; `launchd.agents.<name>.config.StartInterval = 300` confirmed | New per-DB shipment launchd agent with `StartInterval`; **NEW DESIGN QUESTION**: which rclone command to use — `rclone sync` (race-unsafe vs concurrent restic writers; needed for prune-driven deletions) vs `rclone copy --update` (race-safe; needs separate periodic reconciliation) vs `restic copy` to a remote restic repo (restic-native; structurally race-safe). See §3 below. | **Missing** + **design decision** |
| R15 | Offline-resilient operation | None | Local pipeline doesn't depend on network; rclone sync naturally retries on next invocation when destination becomes reachable. **NEW VERIFICATION**: must confirm rclone exit codes on transport failure don't leave the local restic repo in a corrupt state — they shouldn't (restic doesn't even run if rclone is the only thing failing) but worth a smoke test | **Missing** (mostly free; design verification pass) |
| R16 | Single backup repository per database, two tag-tiers, independent retention | `restic --tag` + `restic forget --tag --keep-*` confirmed; per-tier independent retention via two separate `restic forget` calls | Wrapper logic: replication agent does `restic backup --tag replication`; archival agent does `restic backup --tag archive`; each tier's forget runs independently. Operator's `restic snapshots` lists all (filter by `--tag`) | **Missing** (idiomatic restic) |
| R17 | Activation-time verification of rclone config (exists, encrypted, decrypts, names match, types match, distinguished failure modes) | `home.activation.<name>` schema (lib.hm.types.dagOf types.str); `rclone config encryption check`; `rclone listremotes --long --json`; `/usr/bin/security find-generic-password`; lib.hm.assertions.assertPlatform | New `home.activation.sqlite-backup-verify-rclone-config` script (~80 LoC bash, takes the `rcloneDestinations` JSON manifest as input via Nix string interpolation, walks each AC). **CRITICAL CONSTRAINT** — see §3 | **Missing** + **ordering constraint** (HM activation runs BEFORE mcp-secrets-activate) |

**Summary**: 14 Missing, 2 Partial, 1 Convention-exists, 0 Constraint
blockers. Two requirements (R8, R17) carry new constraints surfaced
by this refresh.

## Refreshed Implementation Approach

The May-12 recommendation of **Option B (all-new module composing
existing infrastructure)** still applies. The architectural pivots
don't change the high-level approach; they only change what the
module's internal pipeline does. Specifically:

- Still: new `home-manager/common/sqlite-backup.nix` HM module.
- Still: new `overlays/litestream.nix` (one-line lift from
  `pkgs.unstable.litestream`).
- Still: per-host scaffolding files dormant on landing.
- Still: reuse the existing `mcp-sops-bridge` unchanged with the
  `mcp-hub` Keychain account; new `keychainSecrets` entries for the
  rclone-config encryption passphrase and the archival passphrase.
- Still: launchd wrapper shells out to `/usr/bin/security
  find-generic-password -s <svc> -a mcp-hub -w` at runtime.

What's new vs the May-12 recommendation:

- **Single restic repo per database** at `${xdg.dataHome}/sqlite-backup/<db>/restic/`
  (the May-12 design had separate `litestream/<db>/` and
  `restic/<db>/` directories — under R16 the litestream segments
  dir is now demoted to implementation-internal staging at
  `${xdg.dataHome}/sqlite-backup/<db>/litestream-staging/`).
- **Two launchd agents per DB**: replication-tier (KeepAlive
  Litestream daemon, plus a `StartInterval = 300` restic+rclone
  wrapper that snapshots staging into the repo with
  `--tag replication` then ships); archival-tier (`StartCalendarInterval`
  daily wrapper that does `restic backup --tag archive` then
  shipment, then per-tier `restic forget`). Or, a hybrid: one
  always-on Litestream daemon multiplexing all DBs (per the May-12
  design) plus per-DB periodic agents for replication-tier
  snapshots, archival-tier snapshots, and shipment. Design call.
- **Module API** uses `attrsOf (submodule {...})` for
  `rcloneDestinations` (new pattern in this repo; HM modules have
  precedent).
- **`home.activation.sqlite-backup-verify-rclone-config`** for R17
  (first `home.activation.<name>` user in this repo).
- **Operator command** is a single `sqlite-backup` binary with
  case-on-`$1` subcommand dispatch (matches existing repo idiom).

## §3 New Design Tensions Surfaced by This Refresh

Three architectural decisions the design phase must resolve. Each
has at least two viable resolutions; none is a blocker.

### §3.A Activation ordering vs Keychain dependency

**Constraint**: HM `home.activation.<name>` runs at default priority
inside `system.activationScripts.postActivation` (HM's nix-darwin
integration appends without `mkOrder`); `mcp-secrets-activate` runs
at `mkOrder 9999`. → HM activation runs FIRST.

**Implication**: when the `home.activation.sqlite-backup-verify-rclone-config`
script runs, the Keychain entries it depends on (rclone-config
passphrase) may not yet have been refreshed from sops by
`mcp-secrets-activate`. The same activation cycle that adds a new
secret to `mcp.<host>.yaml` will not have populated Keychain yet
when HM activation runs.

**Resolutions**:

1. **Soft-fail on missing passphrase**: R17's verification script
   detects the passphrase-missing case (security command exits with
   the documented "could not find item" status) and emits an
   ADVISORY warning rather than failing activation. Operator's
   second rebuild — by which time the bridge has populated
   Keychain — fully verifies. Hidden cost: an operator who broke
   the rclone config in some other way wouldn't be alerted on the
   first rebuild after declaring a database.

2. **Promote verification to system tier**: define the verification
   inside `system.activationScripts.postActivation` at
   `mkOrder 10000` (after the bridge), shelling out as the user via
   `sudo -u $username`. Mirrors the bridge's own approach. Gives
   strict ordering. Cost: the script lives outside the HM module
   (in a per-host wiring file or `configurations/common-darwin/`).

3. **Two-pass activation**: HM activation does cheap checks (file
   exists, on-disk format is encrypted) only; system-tier
   activation (after bridge) does the decryption + remote-set
   checks. Splits R17 across two execution sites.

Recommended: **#2 (system-tier verification)**. Aligns with the
existing `mcp-secrets-activate` pattern; gives strict ordering;
keeps R17's failure semantics deterministic. Trade-off: the
verification script lives in `configurations/common-darwin/`
rather than `home-manager/common/`. The HM module declares the
verification's INPUT (the rclone destination manifest); the system
module consumes it.

### §3.B `rclone sync` vs `rclone copy --update` vs `restic copy` for continuous shipment

**Constraint**: restic and rclone run concurrently in the new
architecture. `rclone sync`'s deletion phase can race-delete pack
files restic just created (recently in flight, not yet visible to
rclone's source-walk).

**Resolutions**:

1. **`rclone copy --update` for continuous shipment + periodic
   `rclone sync` after archival forget+prune**: continuous path is
   race-safe (additive only); deletions propagate via a separate
   reconciliation job that runs serialized with restic operations
   (acquire restic write-lock, sync, release).

2. **`restic copy` to remote restic repo via rclone backend**:
   `restic -r rclone:gdrive:<path> copy <local-snapshot>` —
   restic's native repo-to-repo copy understands its own
   append-only invariants and is structurally race-safe. The "off-host
   repo" becomes a real restic repo accessed via rclone bridge,
   not a file-level mirror. Operator can `restic snapshots` the
   remote directly.

3. **Single mutex around restic+rclone always**: serialize
   absolutely everything per-database. Defeats some of the
   parallelism the chained-pipeline architecture was designed for,
   but is the simplest correctness story.

Recommended: **#2 (restic copy via rclone backend)** as the
primary choice. Architecturally cleanest; preserves R16's
"single coherent repo" semantics on both ends; sidesteps the
race entirely. The May-12 viability check (research.md §4 above)
recommended AGAINST `restic -r rclone:` for the BACKUP path
because it forced every backup write through rclone (latency).
That recommendation still stands — but the SHIPMENT path is
exactly the use case `restic copy` was designed for, and it
operates on completed local snapshots without blocking new ones.

### §3.C Mutex primitive on macOS without `flock(1)`

**Constraint**: `flock` not in macOS base. Three options:

1. **`pkgs.flock`** (util-linux port; MIT/GPLv2): tested,
   well-documented `flock` semantics; adds one runtime dep.
2. **`mkdir`-based lockfile**: `mkdir <lockdir>` is atomic on
   POSIX. Pattern: `mkdir /tmp/sqlite-backup-<db>.lock 2>/dev/null
   || exit 0` (early-exit if held). Cleanup via `trap rmdir … EXIT`.
   No new dep.
3. **`launchd LaunchOnlyOnce`** + explicit semaphore: launchd's
   own dedup primitive. Less portable; tightly couples mutex to
   launchd lifecycle.

Recommended: **#2 (mkdir lockfile)** for the wrapper's per-DB
mutex. Avoids a new dep; the pattern is well-understood; bash idiom
fits the existing wrapper-script style. Only consider `pkgs.flock`
if the design surfaces a need for waiting-with-timeout (mkdir is
non-blocking).

## Refreshed Effort and Risk

**Effort: M (3–7 days, single operator)**, slight increase from
the May-12 estimate due to:

- One new Nix module pattern (`attrsOf (submodule {...})`) — small
  ramp-up.
- One new HM activation hook with delicate ordering — see §3.A.
- One new operator-command shape (subcommand dispatch with ~7
  subcommands) — manageable.
- Additional logic for two restic tag-tiers + two retention policies
  per DB.
- Either `restic copy` integration (§3.B option 2) OR
  `rclone copy --update` + serialized reconciliation (§3.B option 1).

Updated rough LoC estimate:

- HM module: ~300–500 LoC of Nix (was 200–400).
- Overlay: ~10–20 LoC.
- Wrapper script: ~150–250 LoC bash (was 80–150) — more logic for
  tag-tier dispatch, mutex, encrypted-config decryption.
- Operator commands (single binary): ~150–300 LoC bash.
- Verification script (R17, may live in per-host wiring): ~80–120
  LoC bash.
- Runbook: ~300–500 lines of markdown (more recovery scenarios).
- Smoke test: ~30–80 LoC of Nix (unchanged).

**Risk: Medium-Low** (essentially unchanged from May-12).

- Pipeline architecture re-validated in this refresh; viability
  intact.
- All upstream tools confirmed available and usable.
- Three new design decisions (§3.A/B/C) each have multiple viable
  resolutions; no blockers.
- HM `home.activation.<name>` is well-documented in HM source even
  without an in-repo precedent.
- The single biggest unknown — `rclone sync` race vs concurrent
  restic — has a clean resolution (`restic copy` via rclone
  backend); the design phase needs to commit to it (or one of the
  alternatives) explicitly.

## Refreshed Research Items for Design Phase

Carrying forward May-12 items where still relevant; replacing /
adding where the architecture has changed.

- **R-1 (REPLACED)**: rclone secrets injection model is no longer
  in question — Mechanism A (encrypted config + Keychain
  passphrase) is locked in by the spec. The design just specifies
  the `RCLONE_PASSWORD_COMMAND` invocation contract.
- **R-2 (RETIRED)**: Keychain account namespace stays as `mcp-hub`
  per May-12 recommendation; no further investigation needed.
- **R-3 (RETAINED)**: Operator command surface — single binary with
  subcommands recommended (this refresh confirms the case-on-`$1`
  dispatch fits the repo idiom).
- **R-4 (RETAINED)**: `assertions = [...]` in HM module is the
  right primitive for R1.AC5 eval-time validation; idiom confirmed
  via HM-vendored module references.
- **R-5 (REFINED)**: Smoke test scope — pure-Nix-eval check on
  dormant default. The new R17 verification script can also be
  smoke-tested by feeding it a synthetic empty-rcloneDestinations
  manifest (it should no-op).
- **R-6 (RETAINED)**: launchd label conventions —
  `io.litestream.replicate.<db>` for upstream-tool agents,
  `dev.dwsr.sqlite-backup.<role>.<db>` for repo-owned wrappers.
- **R-7 (RETIRED)**: Restore-path asymmetry — under the new
  architecture, both backup and restore use restic against the
  same repo (whether local or remote-via-rclone). No asymmetry.
- **R-8 (NEW)**: Activation ordering — §3.A above. Pick one of the
  three resolutions; recommend system-tier verification.
- **R-9 (NEW)**: Continuous shipment mechanism — §3.B above. Pick
  `restic copy` (recommended), `rclone copy --update`+sync, or
  full mutex.
- **R-10 (NEW)**: Mutex primitive — §3.C above. Pick `mkdir`
  lockfile (recommended), `pkgs.flock`, or launchd-only.
- **R-11 (NEW)**: Two-tier retention invocation pattern — confirm
  two separate `restic forget --tag <tier>` calls (not a combined
  `--group-by tag` call) are the cleanest; design.md should
  encode the per-tier retention defaults explicitly. Default
  proposal: replication-tier `--keep-hourly 24` (24h × 1 snapshot
  per hour); archive-tier `--keep-daily 7 --keep-weekly 4
  --keep-monthly 6` (~6 months).
- **R-12 (NEW)**: Litestream segment-staging directory location —
  no longer part of the user-observable backup repository (R16),
  but Litestream still needs SOMEWHERE to write. Default proposal:
  `${xdg.dataHome}/sqlite-backup/<db>/litestream-staging/`. Wiped
  on each archival cycle? Persist forever? (Restic snapshots from
  it, so persisting is implicit; but the staging dir itself
  doesn't need to be backed up.)
- **R-13 (NEW)**: rclone destination type validation — R17.AC4
  verifies declared `type` matches actual `type`. R5.AC5 mentions
  "any additional non-credential rclone backend attributes (for
  example, region, endpoint URL, scopes)". Should R17 verify those
  too, or just `type`? Spec currently says just `type`; design
  confirms scope.

## §6 Recommendations for Design Phase

- **Adopt Option B** (unchanged from May-12) — all-new module
  composing existing infrastructure.
- **Resolve §3.A by promoting R17 verification to system tier** —
  lives in `configurations/common-darwin/sqlite-backup-verify.nix`
  (or similar), runs at `mkOrder 10000` after `mcp-secrets-activate`.
  Consumes a JSON manifest rendered by the HM module.
- **Resolve §3.B by using `restic copy` via rclone backend** for
  continuous shipment. The local restic repo is the source of
  truth; the remote restic repo is its `restic copy` mirror. Both
  ends are fully restic-managed; rclone is just the transport.
- **Resolve §3.C by using `mkdir`-based lockfile** for wrapper
  mutex. No new runtime dep.
- Architecture sketch for `tasks.md`: overlay → module skeleton
  (option surface only, dormant) → eval-time assertions
  (R1.AC5, R10, R11) → per-host scaffolds (dormant) → Litestream
  daemon (R2) → replication-tier wrapper (R14, R15, R16, R8) →
  archival-tier wrapper (R3, R6) → shipment via `restic copy`
  (R4 subsumed by R14) → operator commands (R13, all 24 ACs) →
  R17 verification (system-tier activation script) → runbook
  (R9) → smoke test (mechanical Nix check) → host activation
  (dormant on both).
- **Defer all operational testing** (real DB, real remote, real
  recovery drill) to follow-up PR per the original plan.

## §7 Constraints to Carry Forward (Updated)

Already encoded as requirements; restated for design's reference:

- macOS-only (R10).
- Litestream ≥ v0.5.7 (R11) — satisfied by `pkgs.unstable.litestream`
  v0.5.11.
- Two restic tag-tiers in single repo (R16) with per-tier
  independent retention via two `restic forget --tag <tier>`
  calls.
- `rclone copy` semantics in continuous shipment must not race-delete
  active restic writes (resolved by §3.B's `restic copy`
  recommendation).
- Wrapper-level mutex required (R8) using `mkdir` lockfile (§3.C).
- Lint hooks unchanged: no `/tmp/`, no literal `/Users/...`, no
  `builtins.fetch*` outside `flake.nix`.
- Activation ordering: HM activation BEFORE `mcp-secrets-activate`
  — design must accommodate (§3.A).
- HM activation script as `lib.hm.dag.entryAfter ["writeBoundary"]`
  Bash text; PATH curated; `/usr/bin/security` accessible by
  absolute path.
- `flock(1)` not on macOS — use `mkdir` lockfile or `pkgs.flock`.
- Litestream staging dir distinct from the (single) restic
  repo (R16); design picks the path.

---

# Design Synthesis Log: 2026-05-13

This section records the three-lens synthesis (Generalization, Build
vs Adopt, Simplification) applied between the May-13 gap-analysis
refresh and the design.md draft. Per design-synthesis.md, this step
required the full discovery picture and was not parallelized.

## Generalization

- **Operator commands + internal triggers collapsed into one binary.**
  R13's seven public subcommands (`list`, `status`, `backup`,
  `restore`, `start`, `stop`, `verify-credentials`) and the two
  internal triggers (`__replicate-trigger`, `__archive-trigger`)
  invoked by launchd all dispatch on `$1` from a manifest-aware
  bash script. The interface generalizes to "single binary,
  case-on-`$1`"; the implementation per subcommand stays small.
  Recorded in design.md `scripts/sqlite-backup-cli.nix` component.
- **Two restic tag-tiers as a parametric pattern.** Replication-tier
  and archive-tier wrappers differ only in `--tag` value, retention
  policy, and launchd trigger. The wrapper logic generalizes to a
  single inline shell function with tier-as-argument; per-tier
  behavior is just data. Recorded in CLI script's batch contract.
- **Per-database manifest entry as a uniform shape.** Each database
  declaration carries its own schedule, retention, and
  destination-name reference. The N-databases case is the same as
  the 1-database case; the launchd-agent count just multiplies.
  No special cases for "single DB" vs "multi DB". Recorded in HM
  module's option type signature.

## Build vs Adopt

- **Litestream / restic / rclone**: ADOPT. All three are mature,
  upstream-supported, MIT/BSD/Apache-2 licensed, and cover the
  pipeline tiers natively. Already verified in research.md §1
  (May-12 + May-13).
- **`mcp-sops-bridge`**: ADOPT unchanged. Account namespace stays
  `mcp-hub`; this spec adds two `home.mcp.keychainSecrets` entries
  via standard module merging. Considered Option C (bridge
  extension for `sqlite-backup` namespace) and rejected per May-12
  research.md §3 — extending the bridge is a separate concern.
- **`restic copy` for off-host shipment**: ADOPT (over `rclone
  sync`). Restic-native repo-to-repo copy is structurally
  race-safe vs concurrent restic writers; rclone sync's delete
  phase has the documented race risk per research.md §3.B (May-13).
- **mkdir-based mutex**: BUILD (over adopting `pkgs.flock`). The
  mkdir-atomic pattern is ~5 lines of bash, no new runtime dep.
  Considered `pkgs.flock` and rejected because the mkdir pattern
  satisfies the requirement at lower cost.
- **Operator command CLI**: BUILD. No reasonable adopt-candidate;
  bash with case-on-`$1` is the simplest fit and matches existing
  repo idiom (`mcp-secrets-activate.nix:56-89`).
- **Activation-time verification script**: BUILD. No adopt-candidate;
  combination of `rclone config encryption check`, `rclone
  listremotes --long --json`, jq filtering, and Keychain reads is
  unique to this verification.
- **HM module (`attrsOf submodule {…}`)**: BUILD. New pattern in
  this repo (no precedent). Reference patterns from HM 25.11's
  vendored modules (`programs/sftpman.nix:95`,
  `xdg-desktop-entries.nix:214`).

## Simplification

- **Dropped the multiplexed Litestream daemon design** (originally
  considered: one daemon per host reading a single litestream.yml
  with all DBs). Replaced with per-DB Litestream daemons. Rationale:
  R13.AC11's "halt continuous capture for THIS db" is naturally
  expressible as `launchctl bootout` of the per-DB agent; the
  multiplexed alternative would need dynamic config reload (or
  whole-daemon restart on any halt), which is structurally more
  complex. Trade-off: 3·N agents instead of 1 + 2N; acceptable
  for personal scale (1-3 DBs per host).
- **Dropped `xdg.configFile."litestream/litestream.yml"` rendering.**
  With per-DB daemons, each agent invokes Litestream directly via
  command-line args (`litestream replicate <db> <staging-url>`).
  No config file to render and keep in sync.
- **Dropped per-destination credential references in Nix module.**
  Mechanism A puts credentials in operator-managed encrypted rclone
  config; Nix only declares destination shape (`name + type +
  non-credential attrs`) plus two passphrase references (encryption
  passphrase + archive passphrase). Recorded in R7.AC3 reword and
  R5.AC5 named-set framing.
- **Dropped two-store on-disk architecture.** Single restic repo per
  database (R16). Litestream segments staging directory is
  implementation-internal, not user-observable.
- **Dropped multiple-destinations-per-database.** Considered
  multi-destination for cross-provider redundancy; rejected because
  the chained pipeline already gives defense-in-depth (live SQLite
  → Litestream staging → restic local → restic remote), and
  multi-destination would multiply complexity by N×M. Recorded as
  Out of Boundary.

## Carry-forward to tasks.md

- Five components, each with a clear file boundary, can be
  implemented as five primary tasks plus per-host scaffolding tasks.
- Recommended ordering: Litestream Overlay → CLI Script (depends
  only on tools from nixpkgs) → HM Module (depends on overlay +
  CLI for `home.packages` entry) → System Verify Module (depends
  on HM Module's manifest path) → Per-host Scaffolds (dormant) →
  runbook.md.
- Each can be reviewed independently; no cross-component review
  dependency forcing serial implementation.

