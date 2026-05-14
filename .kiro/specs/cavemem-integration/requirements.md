# Requirements Document

## Introduction

Adopt JuliusBrussee/cavemem v0.2.1 as the ambient capture layer for opencode
sessions on this nix-darwin host fleet, displacing the manual Obsidian
transcription/summary workflow that currently dominates `home-manager/common/agents.md`.
Obsidian remains the curated long-term knowledge surface (memories + MOCs);
cavemem owns the high-volume, hooks-driven "what happened in this session" log.

This spec delivers the foundation: a vendored, patched cavemem package; a
home-manager module that wires cavemem into opencode declaratively (no
imperative `cavemem install`); a custom Node-based importer that bypasses
cavemem's broken `cavemem import` API to migrate the existing 111
transcription + 91 summary `.md` notes; an AGENTS.md restructure that removes
the now-obsolete transcription/summary write rules while keeping the memory
write rules intact; an update to `vault-curator.md` reflecting the new vault
topology; and an opencode-wrapper hard-fail guard so a missing cavemem MCP
prevents opencode from starting (matching the pre-existing obsidian invariant).

Three upstream patches must land for the integration to be useful at all:
bug #14 (opencode hooks save empty input/output), bug #39 (cross-project
session-start context leak), and bug #25 (`search.alpha` Zod docstring is
inverted). All three have upstream PRs from which we cherry-pick.

## Boundary Context

- **In scope**: Nix packaging of cavemem v0.2.1 + 3 cherry-picked patches; a
  home-manager module that materializes cavemem's settings.json, opencode
  plugin file, mcphub server entry, and opencode `mcpServers.cavemem`
  declaratively; configurable embedding provider with 4 options (local,
  ollama, openai, none); a custom one-shot SQLite-direct importer for the
  existing transcription/summary `.md` notes; AGENTS.md restructure;
  vault-curator.md update; opencode wrapper cavemem health-check; smoke
  tests that prove the three patched bugs are actually fixed at runtime.
- **Out of scope**: The vault-synthesizer subagent (separate spec); the
  `memory-sync` orchestration command (separate spec); adding data.db
  to the sqlite-backup target list (separate existing-spec extension);
  cross-host data.db sync (upstream-deferred, not viable); auto-scheduled
  cavemem maintenance such as compaction or vacuum; patching cavemem bugs
  unrelated to this integration (#11, #18, #20, #28, #37); generalizing
  the importer to other memory tools or building a roundtripping
  cavemem→.md exporter.
- **Adjacent expectations**: The downstream `vault-synthesizer-agent` spec
  expects (a) cavemem MCP to be reachable under a stable server name in
  mcphub, (b) the AGENTS.md memory criteria block to remain intact and
  well-anchored so it can be quoted verbatim by the synthesizer, and (c)
  cavemem observations to actually contain non-empty input/output
  (validates the bug #14 patch). The downstream `memory-sync-cli` spec
  expects the same and additionally relies on the synthesizer being
  available. The existing `sqlite-backup` spec's planned extension
  expects `home.cavemem.dataDir` to be a stable, declaratively-managed
  path that it can add to its backup target list. The
  `mcp-secrets-sops-nix` spec is adjacent only when an operator opts
  into the OpenAI embedding provider (the default `local` provider
  needs no secret).

## Requirements

### Requirement 1: Vendored, Patched Cavemem Package

**Objective:** As a host operator, I want cavemem available on PATH built
from a vendored, patched v0.2.1 source, so that I get the three
upstream-deferred bug fixes without waiting for an unreleased v0.3.0.

#### Acceptance Criteria

1. The Nix overlay shall provide a `cavemem` package built from
   JuliusBrussee/cavemem v0.2.1 source.
2. When the host activates the overlay, the cavemem binary shall be
   resolvable via `command -v cavemem` and shall report its version
   when invoked with `cavemem --version`.
3. Where the package builds cavemem v0.2.1 source, the build shall apply
   patch files for upstream bug #14 (opencode hook empty input/output),
   upstream bug #39 (cross-project session-start context leak), and
   upstream bug #25 (`search.alpha` Zod docstring inversion), each
   sourced as a `.patch` file alongside the package definition in the
   overlay tree.
4. Each patch file shall include a header comment that names the
   upstream bug ID and the upstream PR or commit it cherry-picks from,
   so a future maintainer can verify provenance and re-cherry-pick on a
   version bump.
5. If the cavemem source is bumped to a different upstream version that
   already includes any of the three fixes, the obsoleted patch files
   shall be removed from the overlay so the package never tries to apply
   a patch that no longer matches.

### Requirement 2: Declarative Home-Manager Module

**Objective:** As a host operator, I want a home-manager module that
manages every cavemem-touchable user-level file declaratively, so that
rebuilds are idempotent and `cavemem install` never has to run.

#### Acceptance Criteria

1. The home-manager module shall expose `home.cavemem.enable` as a boolean
   option with a default that does not silently activate cavemem when
   the module is merely imported.
2. The home-manager module shall expose `home.cavemem.dataDir` as a path
   option with a default of `${config.xdg.dataHome}/cavemem`.
3. While `home.cavemem.enable` is true, the module shall add the patched
   cavemem package to `home.packages`.
4. While `home.cavemem.enable` is true, the module shall generate
   `${home.cavemem.dataDir}/settings.json` from the module's option
   values such that a rebuild after activation produces no diff against
   the rendered file.
5. While `home.cavemem.enable` is true, the module shall generate
   `${config.xdg.configHome}/opencode/plugins/cavemem.js` from a
   vendored opencode plugin source that ships with the module, NOT by
   invoking `cavemem install`.
6. While `home.cavemem.enable` is true, the module shall not invoke any
   imperative cavemem subcommand (such as `cavemem install`,
   `cavemem config set`, or `cavemem import`) as part of activation.
7. If `home.cavemem.enable` is false, the module shall not add the
   cavemem package, shall not generate `settings.json`, shall not
   generate the plugin file, and shall not register cavemem with mcphub
   or opencode.

### Requirement 3: Configurable Embedding Provider

**Objective:** As a host operator, I want the embedding provider
configurable through home-manager options, so that hosts can choose
between fully local inference, an Ollama endpoint, the OpenAI API, or
no embedding at all without hand-editing settings.json.

#### Acceptance Criteria

1. The home-manager module shall expose `home.cavemem.embedding.provider`
   as an enum option with values `local`, `ollama`, `openai`, and
   `none`, defaulting to `local`.
2. The home-manager module shall expose `home.cavemem.embedding.model`
   as a string option, defaulting to `Xenova/all-MiniLM-L6-v2` (the
   provider-appropriate default for `local`).
3. The home-manager module shall expose
   `home.cavemem.embedding.endpoint` and
   `home.cavemem.embedding.apiKey` as optional string options, used
   only when the provider value selects them.
4. When the embedding provider is `local`, the rendered settings.json
   shall set `embedding.provider` to `local` and shall not require an
   endpoint or API key to be present.
5. When the embedding provider is `ollama`, the rendered settings.json
   shall include the configured endpoint and shall not include an API
   key.
6. When the embedding provider is `openai`, the rendered settings.json
   shall include both the endpoint and the API key, and the module
   shall warn at evaluation time when an `openai` provider is selected
   without an `apiKey` value supplied.
7. When the embedding provider is `none`, the rendered settings.json
   shall set `embedding.provider` to `none` so cavemem skips embedding
   work entirely.

### Requirement 4: MCP Hub and Opencode Wiring

**Objective:** As a host operator, I want cavemem registered as an MCP
server in mcphub and as a `mcpServers.cavemem` entry in opencode's
settings, so that opencode can reach the cavemem MCP tools without any
imperative configuration step.

#### Acceptance Criteria

1. While `home.cavemem.enable` is true, the home-manager module shall
   add a `cavemem` entry to mcphub's server configuration, exposing
   the cavemem CLI's `mcp` subcommand as the server's command.
2. The mcphub server name for cavemem shall be the literal string
   `cavemem`.
3. While `home.cavemem.enable` is true, the home-manager module shall
   add a `cavemem` entry to `programs.opencode.settings.mcpServers`
   that points at the same cavemem CLI invocation as the mcphub entry.
4. After a rebuild that toggles `home.cavemem.enable` from false to
   true, restarting the mcphub launchd agent shall result in a
   `cavemem` server reachable through the mcphub HTTP API.
5. The home-manager module shall not write opencode's `opencode.json`
   directly; it shall contribute its `mcpServers.cavemem` entry through
   `programs.opencode.settings`.

### Requirement 5: Opencode Wrapper Hard-Fail On Cavemem Unavailability

**Objective:** As an opencode user, I want the opencode wrapper to
refuse to start when cavemem MCP is unreachable, so that I never
accidentally run a session whose ambient capture is silently
discarded.

#### Acceptance Criteria

1. While `home.cavemem.enable` is true, the opencode wrapper's
   pre-launch checks shall include a probe for cavemem MCP availability.
2. If the cavemem MCP probe fails, the opencode wrapper shall print an
   actionable error message to stderr and shall exit non-zero before
   exec-ing the underlying opencode binary.
3. The cavemem health-check failure message shall name cavemem
   explicitly and shall include the same kind of recovery hint as the
   pre-existing obsidian health check (a `launchctl kickstart` example
   is acceptable).
4. While `home.cavemem.enable` is false, the opencode wrapper shall
   not attempt the cavemem health check.
5. The cavemem health check shall not interfere with the obsidian
   health check; both checks shall run, and the wrapper shall fail
   if either fails.

### Requirement 6: AGENTS.md Restructure

**Objective:** As a maintainer of the global agent rules, I want the
transcription and summary write rules removed from AGENTS.md and the
memory write rules kept intact, so that agents stop spending context
on bookkeeping that cavemem now handles automatically while curated
memory creation remains an explicit, agent-driven act.

#### Acceptance Criteria

1. The restructured `home-manager/common/agents.md` shall not contain
   the existing "Transcription" section that mandates writing
   `conversations/transcriptions/{timestamp}-{project}.md` after every
   exchange.
2. The restructured `home-manager/common/agents.md` shall not contain
   the existing "Session Summary" section that mandates writing
   `conversations/summaries/{timestamp}-{project}.md` periodically.
3. The restructured `home-manager/common/agents.md` shall include a
   replacement section that explains transcription and summary are now
   captured automatically by cavemem hooks, names the cavemem MCP tool
   prefix that agents may call, and points readers at `cavemem search`
   for ad hoc lookups.
4. The restructured `home-manager/common/agents.md` shall preserve
   the semantic intent of the "Memories" section (memory note format,
   when-to-create rules, deduplication rules, and tag guidelines) so
   the downstream synthesizer agent can continue to quote those rules
   verbatim. The frontmatter `sessions:` placeholder shall be evolved
   to document two acceptable shapes: a session timestamp value (e.g.,
   `2026-05-13T143022`) for human-driven memory writes, and
   `cavemem-session-<id>` (where `<id>` is cavemem's SQLite
   auto-increment session identifier) for synthesizer-generated memory
   writes that need traceability back to the source observations.
   Preservation here is by intent — the criteria, format, and tag
   rules remain — not byte-for-byte identity; the placeholder evolution
   is the only intentional deviation.
5. The restructured `home-manager/common/agents.md` shall keep the
   "Memory Recall" section (search-memories-first rule) intact, since
   curated memory recall is independent of ambient capture.
6. The restructured `home-manager/common/agents.md` shall keep the
   "Obsidian Tool Reference" and "Tag Guidelines" sections intact for
   the surviving memory operations.
7. The startup-check rule shall remain in place but shall be updated
   to reflect that both the obsidian MCP tools and the cavemem MCP
   tools must be available before an agent proceeds.

### Requirement 7: Vault-Curator Agent Update

**Objective:** As a curator-agent operator, I want
`home-manager/common/agents/vault-curator.md` updated to reflect the
new vault topology, so that the curator never proposes edits to
transcription or summary directories that no longer have agent-
authored content.

#### Acceptance Criteria

1. The updated `vault-curator.md` shall remove or revise statements
   that imply agents write to `conversations/transcriptions/` or
   `conversations/summaries/`.
2. The updated `vault-curator.md` shall state that both
   `conversations/transcriptions/` and `conversations/summaries/`
   directories now hold archived/migrated history only and shall
   instruct the curator not to modify their contents during curation
   passes.
3. The updated `vault-curator.md` shall keep the existing
   memory-dedup, MOC-proposal, and tag-hygiene workflows intact (these
   remain the curator's primary responsibility).
4. The "Vault topology" section of `vault-curator.md` shall be updated
   to describe the conversations directories as historical archives.

### Requirement 8: One-Shot Vault Importer

**Objective:** As a host operator, I want a one-shot Node-based
importer that reads existing transcription and summary `.md` notes
and writes equivalent rows directly into data.db, so that the
historical session record is searchable through the new MCP tools
without depending on cavemem's broken `cavemem import`.

#### Acceptance Criteria

1. The Nix overlay shall expose a `cavemem-import-vault` script
   package that is runnable from the command line.
2. When invoked, `cavemem-import-vault` shall walk
   `<vault>/conversations/transcriptions/*.md` and
   `<vault>/conversations/summaries/*.md` from the configured vault
   path.
3. For each transcription file processed, the importer shall insert
   one row into cavemem's `sessions` table (with `ide` set to a fixed
   migration marker, `cwd` set to a clearly synthetic value, and
   `metadata` recording that the row was migrated) and one row into
   `observations` per recognizable exchange in the file.
4. For each summary file processed, the importer shall insert one row
   into cavemem's `summaries` table with `scope` set to `session` and
   the summary content captured verbatim.
5. The importer shall be idempotent: running it twice against the same
   set of source files shall not produce duplicate rows in any of
   `sessions`, `observations`, or `summaries`. It shall achieve this
   by hashing the content of each candidate row and skipping inserts
   whose hash already exists.
6. The importer shall open `data.db` using the same `better-sqlite3`
   binding cavemem itself uses, against the path
   `${home.cavemem.dataDir}/data.db`, and shall not attempt to
   create or migrate the schema (it relies on cavemem having already
   created the file at first run).
7. If `data.db` does not exist at the expected path, the importer
   shall exit non-zero with an actionable error message instructing the
   operator to run `cavemem` once first to bootstrap the schema.
8. The importer shall print a one-line summary at the end reporting the
   counts of sessions, observations, and summaries inserted in this run
   (and the counts skipped due to dedup).

### Requirement 9: Patch Verification Smoke Tests

**Objective:** As a maintainer of this integration, I want runnable
smoke tests that prove each of the three patched bugs is actually
fixed at runtime, so that a future cavemem version bump cannot
silently regress the integration's value proposition.

#### Acceptance Criteria

1. The integration shall ship a smoke-test script that, when run
   against an installed and started cavemem, simulates an opencode
   tool-execute hook payload and asserts that the resulting cavemem
   observation row has non-empty `input` and non-empty `output`
   (verifies the bug #14 patch).
2. The integration shall ship a smoke-test step that, given two
   distinct working directories on the same host, asserts that
   session-start in one cwd does not surface prior-session context
   from sessions started in the other cwd (verifies the bug #39
   patch).
3. The integration shall ship a smoke-test step that asserts the
   `search.alpha` Zod docstring rendered by `cavemem config show`
   describes alpha=1 as keyword-only and alpha=0 as vector-only
   (verifies the bug #25 patch).
4. The smoke-test script shall exit zero only when all three
   verifications pass, and shall identify the specific failing
   verification when it exits non-zero.
5. The smoke-test script shall be idempotent enough to run repeatedly
   without leaving permanent observation/session pollution in the
   operator's real data.db (it is acceptable to use a temporary
   `dataDir` override).
6. The smoke-test script shall additionally assert that the cavemem
   MCP server exposes the four tools enumerated in Requirement 10.AC6
   (`list_sessions`, `timeline`, `get_observations`, `search`) so a
   cavemem version bump that silently renames or drops a tool fails
   the smoke test rather than silently breaking the downstream
   vault-synthesizer-agent. The assertion may probe mcphub's
   `/api/servers/cavemem` endpoint or invoke `cavemem mcp` over stdio
   and inspect the tools list directly; either is acceptable so long
   as the four literal names are checked.

### Requirement 10: Downstream Contract Stability

**Objective:** As a downstream spec author (vault-synthesizer-agent,
memory-sync-cli, sqlite-backup extension), I want this spec to lock
the integration points my future work consumes, so that I can build
against a stable surface.

#### Acceptance Criteria

1. The home-manager module shall expose `home.cavemem.dataDir` as a
   read-back-able option whose default is documented as the canonical
   source of the cavemem database location for downstream consumers
   (sqlite-backup extension, importer, synthesizer).
2. The mcphub server name for cavemem shall be the literal string
   `cavemem`, documented in the module so the synthesizer agent's
   tool allow-list can target it without ambiguity.
3. The "Memories" block in the restructured AGENTS.md shall be
   wrapped in a clearly named anchor (heading + comment markers
   acceptable) so the synthesizer can extract that block verbatim
   without depending on line numbers.
4. The vendored opencode plugin source location shall be a single
   path under `home-manager/common/opencode-plugins/` (or a similarly
   conventional location) so a future cavemem version bump can update
   the package and the plugin source together in one change.
5. The home-manager module's documented option set shall include a
   short description for each option that names the downstream
   consumer, where applicable.
6. The cavemem MCP server shall expose four tools that downstream
   consumers may target by their literal names: `list_sessions`,
   `timeline`, `get_observations`, and `search`. When surfaced through
   mcphub these become `hub_cavemem__list_sessions`,
   `hub_cavemem__timeline`, `hub_cavemem__get_observations`, and
   `hub_cavemem__search` respectively, and the vault-synthesizer-agent
   spec depends on those literal names. A cavemem version bump that
   renames, removes, or replaces any of these four tools shall be
   treated as a breaking contract change and shall be caught by the
   smoke-test assertion in Requirement 9.AC6 before the bump lands.

### Requirement 11: Documentation Memory Note

**Objective:** As a future operator who encounters cavemem's role in
the memory system, I want a single Obsidian memory that explains the
new transcription/summary-vs-memory split and the troubleshooting
sequence when ambient capture stops working, so that I do not have to
re-derive the architecture from scratch.

#### Acceptance Criteria

1. The integration shall ship a memory note under `memories/` in the
   vault that explains: (a) cavemem owns transcription/summary; (b)
   Obsidian owns curated memories and MOCs; (c) AGENTS.md memory
   creation rules still apply to memory writes; (d) where to find
   the importer, the smoke tests, and the dataDir.
2. The memory note shall include a troubleshooting checklist for the
   most likely failure modes: opencode wrapper refuses to start
   because cavemem MCP is down; cavemem observations are present but
   `input`/`output` are empty; cross-project session-start leak
   recurs.
3. The memory note shall reference the upstream bug IDs (#14, #39,
   #25) and the patch file names so a future maintainer can confirm
   the patches are still applied after a version bump.
