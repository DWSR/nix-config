# Roadmap

## Overview

Adopt JuliusBrussee/cavemem as the ambient capture layer for opencode
sessions, displacing the Obsidian transcription/summary workflow that the
current AGENTS.md mandates. Obsidian becomes the curated long-term notes
surface only. A new vault-synthesizer subagent crawls cavemem on demand
and promotes high-signal observations into Obsidian memories using the
existing memory criteria; the existing vault-curator then dedups and MOC's
the result. A `memory-sync` shell command wraps both agents with a marker
file so the user can run periodic syncs without re-processing observations.

The 2026-05-09 research (memories/2026-05-09-cavemem-architecture.md and
2026-05-09-obsidian-vs-cavemem-comparison.md) deferred this work because
of upstream bugs. The 2026-05-13 viability re-check
(memories/2026-05-13-cavemem-viability-recheck.md) found the bugs are still
open upstream. We unblock by vendoring cavemem v0.2.1 in our overlay and
patching the three blockers ourselves; we do not depend on `pr0d1r2/nix-cavemem`
(stale at v0.1.3, no HM module).

## Approach Decision

- **Chosen**: Vendor + patch + custom HM module. Take ownership of cavemem
  packaging in our overlay (`buildNpmPackage` against patched v0.2.1 source),
  write a home-manager module that declaratively wires cavemem into opencode
  (no imperative `cavemem install`), build a custom Node-based importer that
  writes directly to cavemem's SQLite schema (bypassing the broken `cavemem
  import` API), and ship a synthesizer subagent + `memory-sync` orchestration
  command.
- **Why**: User explicitly chose to integrate now rather than wait for upstream
  v0.3.0 release. Three blockers must be patched: bug #14 (opencode hooks save
  empty observations) is a showstopper for the entire integration, bug #39
  (cross-project context leak) breaks the privacy/relevance value, bug #25
  (search.alpha doc inverted) is trivial documentation. All three have
  upstream PRs we can cherry-pick from. Cavemem's broken import API (bug #28,
  closed unfixed) requires us to write our own importer if we want to migrate
  the existing 111 transcription + 91 summary notes — user chose to migrate
  rather than archive or skip.
- **Rejected alternatives**:
  - **Wait for upstream v0.3.0**: PR #31 has been queued for 6 days; bug #28
    is closed unfixed; nix-cavemem is two versions behind. Indefinite block.
  - **Build custom memory store from scratch**: User chose to integrate
    existing cavemem rather than reinvent the wheel.
  - **Use cavemem as-is without patches**: With bug #14 still open, cavemem on
    opencode is effectively a no-op (hooks fire but observations save empty
    input/output). Useless for the synthesis use case.
  - **Single mega-spec**: Would produce 25+ tasks and block parallelization.
  - **Five finer-grained specs (split cavemem-integration into packaging/HM
    module/AGENTS.md)**: User preferred the 3-spec decomposition.

## Scope

- **In**:
  - Nix packaging of cavemem v0.2.1 + patches in our overlay
  - Home-manager module for cavemem (settings.json, opencode plugin file,
    opencode.json declarative wiring, mcphub server registration)
  - Configurable embedding provider (default: local Xenova/all-MiniLM-L6-v2);
    Ollama, OpenAI, and "none" supported via HM options
  - One-shot Node-based migration importer for existing transcription/summary
    .md files (bypasses broken `cavemem import`)
  - AGENTS.md restructure: remove transcription and summary write rules,
    redirect them to cavemem ambient capture; keep memory rules intact
  - vault-curator.md update: reflect that transcription/summary no longer
    come from agents writing .md
  - New vault-synthesizer subagent: reads cavemem timeline in [start, end],
    applies memory criteria selectivity, drafts new memory notes
  - `memory-sync` shell command (scripts/memory-sync.nix) orchestrating
    synthesizer + curator with `$XDG_STATE_HOME/memory-sync/last-run`
    marker file
  - sqlite-backup spec extension: add `~/.cavemem/data.db` to backup target list
  - Health-check / hard-fail in opencode wrapper for cavemem availability
    (analogous to existing obsidian wrapper enforcement)
  - Multi-host parity: works on both Shopify and personal configurations

- **Out**:
  - Cross-host cavemem sync (cavemem is local SQLite; #33 is unaddressed
    upstream and out of scope for this roadmap). Synthesized Obsidian memories
    continue to cross hosts via the existing iCloud/Google Drive vault sync.
  - Patching cavemem bugs not directly impacting our integration (#11/#18
    Windows worker spawn, #20 Docker/musl ONNX segfault, #28 export/import,
    #37 Node 26 V8 GetPrototype)
  - Replacing the opencode hub-of-MCPs pattern; cavemem joins the existing
    mcphub set
  - Auto-running `memory-sync` on a schedule (launchd / systemd timer). User
    invokes manually for now; periodic scheduling can be added later.
  - Migrating existing memories (those stay in Obsidian as the curated
    surface; only transcriptions and summaries migrate into cavemem)

## Constraints

- **macOS-first**: Both target hosts are nix-darwin. We don't need to address
  the Linux musl/Docker ONNX bugs or Windows worker spawn issues.
- **Node version**: Stay on a Node version cavemem's better-sqlite3 supports
  (Node 24 today; bug #37 means Node 26 would break). Track if/when we bump
  the nodejs_X overlay.
- **Declarative-first**: opencode.json is HM-managed via
  `programs.opencode.settings`. The cavemem HM module MUST extend that
  declaratively; we do NOT run upstream `cavemem install` (which writes the
  config imperatively and fights HM on every rebuild).
- **No GPL contamination**: cavemem is MIT, Xenova transformers MIT, ONNX
  runtime MIT. Safe.
- **Existing health-check pattern**: Opencode wrapper hard-fails on Obsidian
  MCP unavailability today. Cavemem must follow the same pattern; if cavemem
  MCP is down, opencode should refuse to start (because ambient capture is
  now the source of truth for transcription/summary).
- **Migration is one-shot**: The 111+91 existing notes import once. After
  migration, those .md files can be archived or left in place as historical
  record (user preference at implementation time).
- **No mass deletion**: Existing memory notes in `memories/` are curated and
  stay untouched. Synthesizer adds new memories; curator dedups them like
  any other memory.

## Boundary Strategy

- **Why this split**: cavemem-integration is the foundation — the package,
  the HM module, the agents.md rewrite, the importer. Nothing else can ship
  without it. vault-synthesizer-agent is a pure consumer of cavemem's MCP
  output; it has no Nix dependency beyond the agent .md file shipping
  through the existing agents directory pattern. memory-sync-cli is a thin
  orchestration wrapper; its only job is invoking the two agents in sequence
  with a time range and managing the marker file. Each spec delivers a
  testable capability: cavemem-integration → ambient capture works;
  vault-synthesizer-agent → manual `@vault-synthesizer 30 days` invocation
  produces memory drafts; memory-sync-cli → `memory-sync` end-to-end runs
  produce committed memories.

- **Shared seams to watch**:
  - Cavemem dataDir path — fixed by HM module (likely
    `${config.xdg.dataHome}/cavemem`); consumed by sqlite-backup extension,
    importer, and memory-sync (marker default time-range queries).
  - Cavemem MCP server name in mcphub (likely `cavemem`) — consumed by
    vault-synthesizer-agent's tool allow-list and memory-sync's MCP-availability
    health checks.
  - AGENTS.md memory criteria block — consumed by vault-synthesizer-agent
    as the selectivity rubric. Restructure must keep that block intact and
    well-anchored so the synthesizer can quote it verbatim.
  - opencode-runner contract for memory-sync — open design question:
    whether `memory-sync` invokes a non-interactive opencode session or
    talks to LLM APIs directly. Decide in memory-sync-cli's design phase;
    earlier specs should not lock either choice.

## Existing Spec Updates

- [x] sqlite-backup -- Add cavemem to backup target list. Resolved on
  2026-05-14 via direct implementation (commits 90a2446 + d13242b),
  not a spec extension: per the kiro-spec-requirements clarification
  pass, the existing sqlite-backup module's Req 1.AC4 already covers
  per-database wiring as host-config; no requirement change was
  needed. Path corrected to `${config.xdg.dataHome}/cavemem/data.db`
  (the legacy roadmap text said `~/.cavemem/data.db` which the
  CAVEMEM_DATA_DIR patch + dataDir option superseded).
  Shopify-host wired to its existing `gdrive` destination; personal-
  host wiring deferred (operator-decision pending on the personal
  destination — see kiro-spec-requirements pass for context).
  Side-effect: surfaced and fixed a latent SC2046 bug in the R17
  verification activation script (commit 90a2446) that was masked by
  the dormant default. Dependencies: cavemem-integration (satisfied).

## Specs (dependency order)

- [x] cavemem-integration -- Vendor cavemem v0.2.1 + patches in overlay,
  HM module wiring opencode declaratively, custom SQLite-direct importer
  for existing transcription/summary notes, AGENTS.md and vault-curator.md
  updates. Dependencies: none. Spec generated 2026-05-13 (27 tasks).
- [x] vault-synthesizer-agent -- New subagent that crawls cavemem timeline
  in [start, end], applies AGENTS.md memory criteria with selectivity, drafts
  memory notes. Dependencies: cavemem-integration. Spec generated 2026-05-13
  (16 tasks).
- [x] memory-sync-cli -- `memory-sync` shell command (scripts/memory-sync.nix)
  with `$XDG_STATE_HOME/memory-sync/last-run` marker file; orchestrates
  vault-synthesizer-agent then vault-curator. Dependencies:
  cavemem-integration, vault-synthesizer-agent. Spec generated 2026-05-13
  (25 tasks). Subagent invocation mechanism: opencode run --agent (Option 1).
