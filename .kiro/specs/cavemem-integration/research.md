# Research & Design Decisions

## Summary

- **Feature**: `cavemem-integration`
- **Discovery Scope**: Complex Integration (existing nix-darwin host fleet,
  multiple integration seams: overlay, home-manager, mcphub, opencode
  wrapper, AGENTS.md, custom data importer, vendored upstream patches)
- **Key Findings**:
  - Cavemem v0.2.1 is the latest released upstream version. Bugs #14, #39,
    and #25 each have upstream PRs open but unreleased; v0.3.0 (PR #31) has
    been queued for ~6 days with no merge activity. The two viable paths are
    (a) wait indefinitely or (b) vendor v0.2.1 and cherry-pick the three
    fixes ourselves. The roadmap chose (b).
  - `pr0d1r2/nix-cavemem` is two cavemem versions behind, has no
    home-manager module, and only ships a flake package output. It is not a
    viable starting point; we package cavemem ourselves in the existing
    `overlays/mcp-servers.nix` (or a sibling overlay file) using the same
    `buildNpmPackage` pattern as the other npm-sourced MCP servers.
  - Cavemem's broken `cavemem import` (bug #28, closed unfixed) drops
    `ended_at`, `metadata`, and the entire `summaries` table on import.
    We therefore write our own importer that opens `cavemem.db` directly
    via `better-sqlite3` and `INSERT`s into the schema documented in
    `packages/storage/src/schema.ts` (sessions / observations / summaries).
    Idempotency comes from a content-hash check the importer maintains
    itself; cavemem's schema does not enforce uniqueness on observations.
  - Cavemem's installer (`packages/installers/src/opencode.ts`) writes both
    `~/.config/opencode/opencode.json` (mutating `mcpServers` and
    `plugin`) and `~/.config/opencode/plugins/cavemem.js`. Both targets
    are home-manager-managed in this repo, so running the installer would
    fight HM on every rebuild. We replace it: opencode.json's
    `mcpServers.cavemem` flows through `programs.opencode.settings`, and
    the plugin file is a vendored `.js` shipped via `xdg.configFile` from
    a path under `home-manager/common/opencode-plugins/cavemem.js` so a
    cavemem version bump updates both the package and the plugin together.
  - The opencode wrapper at `home-manager/common/opencode.nix` already
    hard-fails when the obsidian MCP is unreachable (lines 55–61 in the
    rendered file). Adding a cavemem analogue is a small extension to the
    existing `wrapperCommands` list option — no new abstraction needed.
  - The 111 transcription + 91 summary `.md` files live under the
    Obsidian vault path that home-manager already knows about
    (`home.mcp.obsidianVaultPath`). The importer can read that option at
    Nix-eval time so the operator never has to re-state the path.

## Research Log

### Topic: Upstream cavemem state and patch availability

- **Context**: Three blocker bugs (#14, #39, #25) need to be patched in
  the vendored package. We need to know exactly what each patch looks
  like and where to source it from.
- **Sources Consulted**:
  - JuliusBrussee/cavemem repo (issues, PRs, main branch) summarized in
    `memories/2026-05-09-cavemem-architecture.md` and
    `memories/2026-05-13-cavemem-viability-recheck.md`.
  - PR #31 (changeset bundle for v0.3.0) — contains the bug #14 fix at
    commit f2e2f49 (opencode hook payload-shape correction) and the
    bug #25 doc fix.
  - PR #21 — one-line cwd filter in the session-start handler that
    fixes bug #39 (cross-project context leak).
- **Findings**:
  - Bug #14 fix is a small change to `packages/installers/src/opencode.ts`
    (or to the generated plugin template, depending on where the
    payload shape is read). Patch surface is small (single-digit
    changed lines); will cherry-pick from the f2e2f49 commit.
  - Bug #39 fix is a one-line addition to the session-start handler
    that filters prior-session lookups by `cwd`. Cherry-pick from PR #21.
  - Bug #25 fix is a Zod `.describe(...)` string change in the
    `search.alpha` schema. Cherry-pick from PR #31's diff.
- **Implications**:
  - Three discrete `.patch` files are sufficient. Each can carry a
    header comment naming the upstream bug ID + PR/commit, mirroring the
    existing `overlays/zellij-*.patch` convention.
  - When cavemem v0.3.0 (or later) ships, all three patches become
    obsolete simultaneously and the patches list in the overlay can be
    cleared in one change. Requirement 1.AC5 codifies this.

### Topic: Cavemem packaging shape

- **Context**: Cavemem is published as a single `cavemem` npm package
  bundling the CLI, MCP server, and worker. We need to package it the
  same way our other npm-sourced MCP servers are packaged so it
  composes with the existing overlay shape.
- **Sources Consulted**:
  - `overlays/mcp-servers.nix` — `mcp-obsidian` block uses
    `buildNpmPackage` against a `fetchFromGitHub` source with
    `importNpmLock` for `npmDeps`.
  - Cavemem's own `packages/installers/src/opencode.ts` — informs what
    the bundled CLI does at install time so we can replace it.
- **Findings**:
  - The same `buildNpmPackage` + `fetchFromGitHub` + `importNpmLock`
    pattern works for cavemem v0.2.1. The only addition is the
    `patches` attribute pointing at the three `.patch` files in the
    overlay tree.
  - Cavemem's `bin/cavemem` is the entry point; a `makeWrapper`
    invocation in `postInstall` (mirroring `mcp-obsidian`) is the
    cleanest way to expose it on PATH.
  - Better-sqlite3 native binding fetches happen at install time;
    `buildNpmPackage` handles this correctly when `npmDeps` is built
    via `importNpmLock`. No special handling needed for darwin arm64.
- **Implications**:
  - Cavemem package definition lives in the existing
    `overlays/mcp-servers.nix` (or a sibling
    `overlays/cavemem.nix`; either is acceptable per the brief). The
    spec design picks `overlays/mcp-servers.nix` to minimize file
    surface and avoid touching `flake.nix`.

### Topic: Cavemem SQLite schema (for the importer)

- **Context**: The custom importer writes directly to cavemem.db. We
  need to know the exact tables and column shapes so inserts succeed
  without violating constraints.
- **Sources Consulted**:
  - Cavemem `packages/storage/src/schema.ts` summarized in
    `memories/2026-05-09-cavemem-architecture.md`.
- **Findings**:
  - Tables: `sessions(id, ide, cwd, started_at, ended_at, metadata)`,
    `observations(id, session_id, kind, content, compressed, intensity,
    ts, metadata)`, `summaries(id, session_id, scope, content, ...)`.
  - WAL mode, foreign keys on. `observations` has no UNIQUE constraint
    so we cannot rely on database-level dedup; the importer must
    maintain its own content-hash check.
  - `observations_fts` is a virtual table maintained by triggers; we
    insert into the base table and the FTS index updates automatically.
  - `embeddings` is populated asynchronously by the worker; the
    importer can leave embeddings unpopulated and cavemem's worker (or
    a later `cavemem reindex` operation) will catch up.
- **Implications**:
  - Importer scope is three table inserts per file plus a hash-tracking
    table the importer adds itself (or hash storage in the row's
    `metadata` JSON column). Design picks `metadata`-based hashing to
    avoid migrating cavemem's schema.

### Topic: Cavemem hook payload shape (for bug #14 verification)

- **Context**: The bug #14 patch fixes the plugin's payload extraction
  so observations save non-empty `input`/`output`. The smoke test must
  simulate a payload shape that exercises the patched code path.
- **Sources Consulted**:
  - Cavemem hook handler source via PR #31 commit f2e2f49.
  - Opencode plugin event API surfaced in
    `home-manager/common/opencode-plugins/` (existing patterns).
- **Findings**:
  - The plugin spawns `cavemem hook run <event>` detached with the
    payload piped to stdin. Bug #14 was that the plugin extracted
    `output?.output ?? output?.title` from the wrong nesting level;
    the fix corrects the nesting. Smoke-testing it does not require a
    full opencode session: a `printf '<json>' | cavemem hook run
    post-tool-use` invocation against a temp `dataDir` is sufficient,
    followed by a `cavemem search` (or direct sqlite query) that
    inspects `input`/`output` columns of the latest observation row.
- **Implications**:
  - Smoke test 9.AC1 is implementable as a small shell script that
    stages a temp dataDir, fires a known payload, and asserts the
    inserted row's content. No opencode binary required.

### Topic: Existing notes inventory

- **Context**: 111 transcription + 91 summary `.md` files need to migrate.
  The importer must handle both vault paths (Shopify Google Drive,
  personal iCloud) by reading them from `home.mcp.obsidianVaultPath`.
- **Sources Consulted**:
  - `home-manager/mcp/default.nix` — `obsidianVaultPath` option.
  - The vault directory listings (per the brief).
  - `home-manager/common/agents/vault-curator.md` — note format
    (frontmatter YAML + body) is consistent across hosts.
- **Findings**:
  - File naming convention is `{timestamp}-{project}.md`. Frontmatter
    has `date`, `project`, `session`, plus tags. Transcription bodies
    have `## Exchange N` blocks alternating `**User:**` /
    `**Assistant:**`. Summary bodies have fixed `## What was
    accomplished` / `## Key decisions` / `## Discoveries` /
    `## Open questions` / `## Files touched` sections.
  - The format is consistent enough that a single Node parser can
    handle both file types.
- **Implications**:
  - Importer can be a single Node script. Frontmatter parsing via
    `js-yaml` (npm-vendored) or a tiny hand-rolled parser; design
    prefers `js-yaml` for robustness against quoting edge cases.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Vendor + patch + custom HM module | Package cavemem in our overlay with three cherry-picked `.patch` files; write a HM module that emits settings.json, plugin, mcphub entry, and opencode `mcpServers` declaratively; ship a custom Node-based importer. | Full control over patches and configuration. Bypasses upstream's slow merge cadence. Reuses every existing pattern in the repo (overlay shape, HM module shape, mcphub `extraServers` hook, opencode wrapper extension). | Three patches drift if upstream changes their internal file layout in v0.3+. Importer is custom code we have to maintain. | **Selected.** Roadmap explicitly chose this; brief reaffirms. |
| Adopt `pr0d1r2/nix-cavemem` and write only the HM module | Use the third-party flake input for the package; write our HM module against it. | Less Nix code in our overlay. | Stuck on cavemem v0.1.3 (two versions behind, missing the v0.2.1 MCP-silent-exit fix). No HM module exists upstream. Patches still need to land somewhere. | Rejected: the staleness of nix-cavemem makes this strictly worse than vendoring ourselves. |
| Wait for cavemem v0.3.0 + pr0d1r2 to bump | Block this whole spec on upstream. | Zero patch maintenance. | Indefinite block; PR #31 has sat 6 days with no merge. Bug #28 is closed unfixed regardless of v0.3.0. | Rejected by the roadmap. |
| Build a custom memory store from scratch | Write our own ambient capture + retrieval. | Full ownership. | Massive scope; cavemem already solves the hard parts (compression, FTS+vector hybrid, MCP shape). | Rejected by the roadmap. |

## Design Decisions

### Decision: Replace `cavemem install` entirely; do not invoke it from activation

- **Context**: Cavemem's installer writes to two HM-managed targets
  (`~/.config/opencode/opencode.json` and the opencode plugin file). Any
  imperative invocation fights HM on every rebuild.
- **Alternatives Considered**:
  1. Run `cavemem install` once in an activation script, then leave it.
     Risky: future cavemem versions could re-run differently and silently
     re-mutate HM-managed files.
  2. Replace the installer's outputs with HM-managed equivalents.
- **Selected Approach**: HM emits settings.json from option values, ships
  the opencode plugin as a vendored `.js` via `xdg.configFile`, and adds
  the mcphub + opencode `mcpServers.cavemem` entries through existing
  module surfaces. `cavemem install` is never invoked.
- **Rationale**: Keeps every cavemem-touchable file under HM control,
  matches the established declarative-first invariant, and isolates a
  cavemem version bump to a single overlay version change + an optional
  plugin source refresh.
- **Trade-offs**: We track the plugin source ourselves (small file, but
  one more thing to keep in sync). In exchange, we never get surprise
  config edits.
- **Follow-up**: Document the plugin source path in the HM module's
  description and in the troubleshooting memory note (Requirement 11).

### Decision: Importer maintains its own content-hash dedup, written into row `metadata`

- **Context**: Cavemem's `observations` table has no UNIQUE constraint
  on content. Re-running the importer must not duplicate rows.
- **Alternatives Considered**:
  1. Add a UNIQUE constraint via `PRAGMA user_version` migration. Rejected:
     would conflict with cavemem's own schema migrations.
  2. Maintain a sidecar `import_state.json` mapping source file paths to
     hashes. Rejected: another file to lose.
  3. Encode the source-file content hash into each inserted row's
     `metadata` JSON, then `SELECT ... WHERE json_extract(metadata, '$.import_hash') = ?`
     before inserting.
- **Selected Approach**: Option 3. Each candidate row carries an
  `import_hash` value in `metadata` (sha256 of the canonical normalized
  text); insertion is gated on a pre-check for that hash.
- **Rationale**: Stays inside the existing schema, survives schema
  migrations, and is operator-visible (`sqlite3 cavemem.db "SELECT ... json_extract(metadata, '$.import_hash')"`).
- **Trade-offs**: Pre-check adds one SELECT per candidate row; trivial
  for ~200 source files.

### Decision: Three `.patch` files alongside the package definition, header-commented

- **Context**: Patches must be reviewable and version-pinnable.
- **Alternatives Considered**:
  1. In-line `substituteInPlace` calls in the package's `postPatch`.
     Rejected: opaque, hard to diff against upstream.
  2. A patches subdirectory like `overlays/cavemem/patches/`.
  3. Three flat `.patch` files in `overlays/`, mirroring the
     `overlays/zellij-*.patch` precedent.
- **Selected Approach**: Option 3 (flat in `overlays/`), names of the
  form `cavemem-<bug-id>-<short-description>.patch`. Each file's leading
  lines are a comment block naming the upstream bug ID and source
  PR/commit.
- **Rationale**: Matches the existing zellij precedent so reviewers
  recognize the pattern; flat layout makes it easy to grep for all
  patches the overlay applies.
- **Follow-up**: When cavemem version bumps, refresh patches against the
  new tag and remove any patch whose underlying fix has landed upstream
  (Requirement 1.AC5).

### Decision: Smoke tests via a single shell script, runnable in isolation

- **Context**: Patch verification is a non-negotiable safety net for
  future cavemem version bumps.
- **Alternatives Considered**:
  1. Property-based unit tests inside the cavemem source (would require
     us to fork the test suite).
  2. A standalone shell script that spawns cavemem against a temp
     dataDir and asserts on observed behavior.
  3. A Nix `checkPhase` invoked at build time.
- **Selected Approach**: Option 2. The smoke-test script lives at
  `scripts/cavemem-smoke-test.nix` (writeShellApplication wrapping a
  bash + sqlite3 + jq script), takes no arguments, and exits non-zero
  with a clear failure label when any of the three patches fail to
  hold at runtime.
- **Rationale**: Operator-runnable on demand and from CI; doesn't
  require a full opencode session; uses the same `writeShellApplication`
  pattern as `cc-sdd-init` and `sqlite-backup`.
- **Trade-offs**: Tests run against a temp `dataDir`, not the operator's
  real cavemem.db; an operator who wants to validate their actual setup
  must point the script at their real path manually.

### Decision: Embedding provider is a single enum option with conditional sub-options

- **Context**: Four embedding providers (`local`, `ollama`, `openai`,
  `none`) have different config requirements (model, endpoint, apiKey).
- **Alternatives Considered**:
  1. Four separate top-level options with mutual-exclusion assertions.
  2. A `provider` enum with optional `endpoint`/`apiKey`/`model` siblings,
     validated at evaluation time.
- **Selected Approach**: Option 2 — single `provider` enum, sibling
  options used only by the providers that need them. Module emits a
  `lib.warn` at evaluation when `provider = "openai"` and `apiKey` is
  unset.
- **Rationale**: Smaller surface, mirrors how settings.json lays out
  embedding config, and the warn nudges operators toward the
  `mcp-secrets-sops-nix` flow without making it a hard dependency for
  the default `local` provider.

## Risks & Mitigations

- **Upstream patch drift**: A future cavemem version bump may move the
  files our patches touch. Mitigation: each patch carries a header
  comment naming its source commit; the version-bump procedure (per
  the Requirement 11 troubleshooting memory) explicitly walks
  through re-cherry-picking each patch.
- **better-sqlite3 native binding instability across Node versions**:
  Cavemem bug #37 means Node 26 breaks better-sqlite3 ≤11. Mitigation:
  pin to nixpkgs Node 24 (the current default) and document the
  constraint in the HM module's option descriptions; revisit when
  nixpkgs bumps the default.
- **Importer parsing fragility**: Vault notes have evolved over time;
  some early notes may have inconsistent frontmatter. Mitigation:
  importer logs (and skips with a warning) any file whose frontmatter
  fails to parse, so a partial migration succeeds even if a handful of
  files need manual touch-up.
- **Cavemem MCP startup race at first activation**: Smoke tests assume
  cavemem.db exists. The importer (Requirement 8.AC7) explicitly checks
  for the file and instructs the operator to run cavemem once first.
  Smoke tests use a temp dataDir so they don't have this dependency.
- **Loss of historical conversations during importer development**:
  The importer only reads `.md` files; it never deletes them. Mitigation
  is structural: source files remain on disk after import.

## References

- `memories/2026-05-09-cavemem-architecture.md` — full upstream
  architecture deep-dive (storage schema, hooks, settings shape, known
  bugs).
- `memories/2026-05-13-cavemem-viability-recheck.md` — confirms bugs
  #14, #39, #25 are still open and PR #31 is unmerged; documents the
  decision to integrate via vendor+patch.
- `memories/2026-05-13-cavemem-integration-decomposition.md` — the
  3-spec decomposition rationale (this spec is the foundation).
- `overlays/mcp-servers.nix` — `mcp-obsidian` block is the closest
  packaging precedent.
- `overlays/zellij-*.patch` — `.patch` file convention precedent.
- `home-manager/common/opencode.nix` lines 55–61 — obsidian MCP
  health-check pattern this spec extends.
- `home-manager/mcp/default.nix` — mcphub server registration pattern
  and the `extraServers` extension surface.
- `home-manager/common/sqlite-backup.nix` and
  `scripts/sqlite-backup-cli.nix` — script-packaging precedent for the
  importer and smoke-test scripts.
