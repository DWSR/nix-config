---
description: Synthesize curated Obsidian memory notes from recent cavemem observations over a caller-supplied time range. Invoke with @vault-synthesizer <time-range> when the user says "synthesize my recent sessions" / "draft memories from cavemem" / "promote yesterday's work into vault memories". Drafts only — vault-curator handles dedup downstream.
mode: subagent
model: anthropic/claude-sonnet-4-5
temperature: 0.2
permission:
  edit: deny
  write: deny
  webfetch: deny
  bash:
    "*": ask
    "ls *": allow
    "find *": allow
    "rg *": allow
    "grep *": allow
    "wc *": allow
    "head *": allow
    "tail *": allow
---

# vault-synthesizer

<!-- Section bodies are populated by tasks 1.2 through 1.10 of the
     vault-synthesizer-agent spec. This commit (task 1.1) ships only the
     frontmatter and the section skeleton in the canonical order from
     `.kiro/specs/vault-synthesizer-agent/tasks.md` and `design.md`. -->

## Mission

<!-- Body filled by task 1.2: mission paragraph naming the synthesizer's
     job (promote high-signal cavemem observations into curated memory
     notes), its place in the pipeline (synthesizer drafts; curator
     dedups; memory-sync-cli orchestrates), and its invocation surface
     (`@vault-synthesizer <time-range>`). -->

## Operating rules (INVARIANTS)

<!-- Body filled by task 1.2: numbered list of at least eight invariants
     mirroring vault-curator's structure (vault-writes only via
     hub_obsidian__*; repo source out of scope; webfetch denied; NEVER
     dedup against existing memories; cavemem session_id(s) in
     `sessions:` for provenance; no hub_obsidian__search-* calls; no
     MCP tools outside the documented allow-list; defense-in-depth note
     on the OS-level deny posture). -->

## Memory criteria (inlined verbatim from agents.md)

<!-- Body filled by task 1.3: one-line preamble plus the
     <!-- BEGIN: memory-criteria --> .. <!-- END: memory-criteria -->
     block from `home-manager/common/agents.md`, copied byte-for-byte
     with the anchor markers preserved so future maintainers can grep
     for them and confirm provenance. -->

## Selectivity rubric

<!-- Body filled by task 1.4: conservative principle ("err on the side
     of NOT promoting"), a `### Promote — examples` subsection with at
     least three concrete cluster sketches, and a `### Skip — examples`
     subsection with at least three. Each example cites the AGENTS.md
     criterion (or "do NOT create" rule) it invokes. -->

## Workflow

<!-- Body filled by task 1.5: five H3-headed stages in order — `### Stage
     1 — gather`, `### Stage 2 — group`, `### Stage 3 — score`, `### Stage
     4 — draft`, `### Stage 5 — report` — with prose describing the
     cavemem and Obsidian MCP calls each stage makes, plus an explicit
     non-stage call-out that the agent never invokes
     hub_obsidian__search-vault or hub_obsidian__search-by-tags. -->

## Drafted memory note format

<!-- Body filled by task 1.6: path convention
     (`memories/<YYYY-MM-DD>-<slug>.md`), frontmatter shape (`tags`,
     `date`, `project`, `sessions` in that order; `sessions` uses
     `cavemem-session-<id>` form), body section order (H1, ## Context,
     ## Details, ## Related files), the date-floor invariant (date >=
     earliest observation timestamp), and a 30-50 line worked example
     in a fenced ```markdown``` block. -->

## Invocation

<!-- Body filled by task 1.7: documentation of the four accepted
     time-range argument shapes (relative, absolute date pair, ISO-8601
     duration, ISO-8601 timestamp pair `YYYY-MM-DDTHH:MM:SSZ`), the
     missing-argument default (last 24 hours), per-shape timezone rules,
     unparseable-input refusal behavior, empty-window behavior, and a
     summary table with one example per shape. The ISO-8601 timestamp
     pair shape is what `memory-sync-cli` emits per its Decision 4. -->

## Report

<!-- Body filled by task 1.8: structured-return contract emitted at the
     end of every successful run. Seven required fields — `time_range`,
     `observations_scanned`, `clusters_identified`, `clusters_promoted`,
     `clusters_skipped`, `drafts_written`, `draft_paths` — plus the
     conservation invariant (clusters_promoted + clusters_skipped =
     clusters_identified) and a fenced code-block example so
     memory-sync-cli can extract each field. -->

## Tool usage notes

<!-- Body filled by task 1.9: documented MCP tool allow-list — Obsidian
     write/read tools (hub_obsidian__write-note, hub_obsidian__read-note),
     the four cavemem MCP tools (hub_cavemem__list_sessions,
     hub_cavemem__timeline, hub_cavemem__get_observations,
     hub_cavemem__search), reused vault-curator MCP-quirk notes, plus
     bash inspection allow-list reminder and webfetch/edit/write deny
     posture restated. -->

## Success criteria

<!-- Body filled by task 1.10: manual smoke-test recipe — invoke with a
     known small time window, confirm the structured return matches the
     contract, confirm at least one drafted note conforms to the
     drafted-note format, confirm no calls were made to disallowed MCP
     tools, confirm no calls were made to hub_obsidian__search-*. -->

## Vault references

<!-- Optional section per design.md. Not assigned to any 1.x task; may
     be populated alongside task 1.10 or in a follow-up if useful
     pointers emerge (e.g., links to AGENTS.md, vault-curator.md, the
     memory-sync-cli spec). Safe to leave empty if no references are
     warranted at ship time. -->
