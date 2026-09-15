# Roadmap

## Overview

Reduce LLM API spend on this user's opencode workflows by first measuring
where tokens actually go, then targeting interventions at the largest cost
drivers with evidence rather than guesses. The diagnostic phase produces a
durable, re-runnable cost-attribution tool against opencode's local SQLite
session database. Follow-on specs (prompt caching enablement, MCP tool
surface trim, AGENTS.md modularization, session compaction, subagent
context budgeting, etc.) are explicitly deferred until the diagnostic
produces evidence.

This roadmap supersedes the now-complete cavemem-integration work
(archived at `roadmap-cavemem-integration.md`).

## Approach Decision

- **Chosen**: Diagnose-first roadmap. Spec 1 (`opencode-cost-diagnosis`)
  builds a local cost-attribution tool that reads opencode's existing
  SQLite session DB and decomposes spend by source: system prompt
  (cached vs uncached), conversation history, tool outputs, subagent
  dispatches. Subsequent specs are sized and ordered by what the
  diagnostic actually shows.
- **Why**: The user has real Anthropic cost data but no per-component
  attribution. Without that breakdown, all candidate interventions are
  hypothesis-grade. The opencode source already persists per-turn
  `tokens.{input, output, reasoning, cache.read, cache.write}` plus
  pre-computed cost to a Drizzle-managed SQLite DB at
  `~/.local/share/opencode/opencode-stable.db`, so the data layer is
  free; we only need to build the attribution + reporter layer on top.
  A small, repeatable diagnostic also doubles as the success metric for
  every follow-on spec: re-run after each intervention to confirm impact.
- **Rejected alternatives**:
  - **`rtk` (Rust Token Killer) plugin install**: Initial trigger for
    this discovery. Researched in depth (see
    Step-5 sub-agent results in cavemem session 2026-05-15 if needed).
    rtk only intercepts opencode's Bash tool, not the native Read /
    Grep / Glob / Webfetch / Task tools that this repo's AGENTS.md
    explicitly biases toward. Real-world savings would be a small
    fraction of the 80% headline. Re-evaluate after diagnostic if
    Bash-tool costs are actually large.
  - **Parallel-stack roadmap** (4 specs at once: prompt-caching, MCP
    allowlist, AGENTS.md modularization, session compaction): Rejected
    because we'd risk building 2-3 specs that don't move the needle.
    Multi-week wasted work if priority is wrong.
  - **ROI-ordered sequential roadmap** (ship best-guess interventions
    one at a time, measure between each): Rejected because the *first*
    intervention is still a guess. Diagnose-first removes that guess.
  - **Install rtk anyway as a known easy win**: Considered as a hybrid
    with diagnose-first. Rejected for now to avoid muddling the
    baseline measurement. Revisit after diagnostic if Bash tool cost
    is large enough to justify it.

## Scope

- **In**:
  - A diagnostic CLI / library that reads opencode's local SQLite
    session DB and produces a Markdown + JSON cost-attribution report
  - Per-session and per-project (cwd-grouped) breakdowns
  - Cached vs uncached prefix split (Anthropic prompt-caching metric)
  - Subagent dispatch attribution (with the caveat that parent-child
    session linkage may need design-time investigation)
  - Multi-host parity: works on both Shopify and personal nix-darwin
    configurations
  - Re-runnable: the diagnostic is the success metric for follow-on
    interventions

- **Out**:
  - **Any cost-reduction intervention**, including but not limited to:
    prompt caching, MCP tool trimming, AGENTS.md slimming, session
    compaction, subagent prompt budgeting, model routing, API-wire
    caching proxies. These become their own specs after the diagnostic
    produces data.
  - Real-time cost dashboards or web UIs (the report is Markdown / JSON
    consumed locally; a UI is out of scope)
  - Cross-host data merge (each host produces its own report)
  - Anthropic Admin Cost Report API integration as the primary data
    source (Admin API is daily-granularity only; useful for total
    cross-check, not per-session attribution)

## Constraints

- **macOS-first** (nix-darwin on both target hosts).
- **Declarative install**: The diagnostic CLI ships via Nix overlay +
  Home Manager module, like all other tooling in this repo. No
  imperative installers.
- **No upstream dependency on Helicone SaaS or similar**: There's an
  `opencode-helicone-session` plugin that forwards data to Helicone,
  but the diagnostic must work fully locally. Helicone integration
  remains an open option for future specs but is not in scope here.
- **Schema stability assumption**: We read opencode's SQLite schema
  directly. If opencode changes schema in a future release, the
  diagnostic must fail loudly with a clear error rather than silently
  miscount. Pin the supported opencode version range explicitly.
- **No agent rewrites**: The diagnostic is a read-only consumer of the
  existing session DB. It does not modify opencode behavior, prompts,
  or any AGENTS.md / skill content.

## Boundary Strategy

- **Why this split**: Diagnostic is the foundation — it produces the
  evidence that scopes every subsequent spec. The diagnostic spec
  itself has 3-4 internal seams (data layer, attribution logic,
  reporter, optional live logger plugin) that stay inside one spec
  because they ship together and fail together. Cross-spec boundaries
  appear after the diagnostic lands; those boundaries will be informed
  by which cost drivers actually dominate.

- **Shared seams to watch** (for future specs):
  - The diagnostic's normalized per-turn dataset (output of the data
    layer) becomes the canonical fixture for measuring intervention
    impact. Future specs (e.g. `prompt-caching-enablement`) will
    re-run the diagnostic before and after to verify savings.
  - The cost-attribution categories defined here (system prompt /
    conversation history / tool outputs / subagent dispatches) shape
    every follow-on spec's success criteria. If the diagnostic surfaces
    a fifth category we didn't anticipate, follow-on specs must absorb
    that taxonomy change.
  - opencode's plugin hooks (`message.updated`, `tool.execute.before/
    after`) are reused by the optional live-logger seam here, AND will
    be reused by any future "tool output compressor" or "MCP
    allowlist" spec. Don't lock in opinionated hook semantics here.

## Specs (dependency order)

- [x] opencode-cost-diagnosis -- Build a local CLI that reads
  opencode's SQLite session DB and emits a Markdown + JSON
  cost-attribution report broken down by system prompt
  (cached/uncached), conversation history, tool outputs, and
  subagent dispatches. Multi-host parity via Nix + HM module.
  Dependencies: none. **Status**: tasks-generated, v2-diagnosis
  follow-on shipped. v1 + v2 reports are producing actionable data.
- [ ] rtk-install -- Install RTK for OpenCode's Bash-tool subset on
  both nix-darwin hosts via declarative Nix packaging and repo-owned
  OpenCode plugin/config wiring. Dependencies: opencode-cost-diagnosis
  (for baseline + validation). **Status**: promoted from Deferred
  Specs on 2026-05-22 by operator request; bounded Bash-subset
  intervention, not a replacement for native tool-output compression.
- [ ] session-compaction -- Opencode plugin that watches per-turn
  token growth and triggers opencode's native compaction
  (`session.summarize` via the SDK) when configurable thresholds
  trip, plus a manual `/compact` slash command and a steering doc.
  Augments opencode's continuation prompt with cavemem-derived
  context via the `experimental.session.compacting` hook. Cavemem
  stays a read-only augmentation source (no upstream cavemem
  changes). Dependencies: opencode-cost-diagnosis (for baseline +
  validation); strongly prefers v2-diagnosis upstream for sharper
  per-tool / per-agent before/after.
- [ ] mcpproxy-migration -- Replace `ravitemer/mcp-hub` with
  `smart-mcp-proxy/mcpproxy-go` as the single MCP entrypoint.
  Big-bang cutover (Approach 2 / Clean-cut). Adopts mcpproxy's
  retrieve_tools mode (4-tool surface: `retrieve_tools` +
  `call_tool_read`/`write`/`destructive`) for context savings;
  rewrites the SOPS→Keychain bridge with swapped axes
  (`service=mcpproxy, account=<secret-name>`); closes the
  cavemem split-brain (cavemem-via-mcpproxy only, no direct
  opencode local-MCP entry); drops nvim MCP integration entirely
  (`mcphub.nvim` + codecompanion extension + lualine status +
  2 flake inputs); renames sqlite-backup's keychain account off
  the `mcp-hub` name. Dependencies: opencode-cost-diagnosis (for
  before/after token measurement); modifies
  `mcp-secrets-sops-nix`, `cavemem-integration`, and
  `sqlite-backup` implementations (specs not re-opened for
  rework). Supersedes the deferred `mcp-server-allowlist`.
- [ ] grep-app-mcp -- Package `ai-tools-all/grep_app_mcp` and
  register it as a grep.app-backed public-code-search upstream through
  mcpproxy on both nix-darwin hosts. Uses mcpproxy's existing
  retrieve_tools surface; does not change opencode MCP routing,
  secrets plumbing, or mcpproxy core defaults. Dependencies:
  mcpproxy-migration (current mcpproxy module and per-host
  `home.mcp.extraServers` extension point).

## Deferred Specs (decided after diagnosis)

These are candidate follow-on workstreams. None are committed; the
diagnostic results decide which ship, in what order, with what scope.
Listed alphabetically, not by priority.

- **agents-md-modularization** -- Split AGENTS.md into lazy-loaded
  steering docs. Move Graphite catalog and similar reference material
  into memory notes loaded on-demand. Trigger: diagnostic shows
  system-prompt-uncached cost is large. **Status**: trigger NOT
  evaluable from 2026-05-19 diagnostic (`systemPromptCached` and
  `agentsMdCached` are structurally $0 due to TokenizerSplitter
  classifier degradation; resolution depends on the
  content-shape-markers work in v2-diagnosis or a successor).
- **mcp-server-allowlist** -- Per-project / per-task MCP server
  scoping so unused tool schemas don't pollute the system prompt.
  Trigger: diagnostic shows MCP tool schemas dominate uncached prefix
  tokens. **Status**: SUPERSEDED by `mcpproxy-migration` (active in
  Specs above). mcpproxy's retrieve_tools mode replaces the
  unfiltered tool-schema exposure with a 4-tool indirection surface;
  per-project scoping becomes unnecessary because all schemas are
  hidden behind `retrieve_tools` regardless of project. The
  classifier-degradation question that blocked the original trigger
  is moot in the new design.
- **prompt-caching-enablement** -- Enable Anthropic `cache_control`
  breakpoints on the static prefix. Trigger: diagnostic shows
  `cache_read` ratio is low. **Status**: NOT TRIGGERED. Diagnostic
  shows cache-read is already 88% of input tokens; caching is
  working. Drop from active consideration unless a regression
  surfaces.
- **subagent-context-budget** -- Slim subagent prompts so each Task
  dispatch ships a minimal context. Trigger: diagnostic shows
  subagent dispatches are a major cost driver. **Status**: TRIGGER
  MET — subagentDispatch = 41% of post-exclusion spend. An
  in-flight brief exists at `.kiro/specs/subagent-context-budget/`
  (no spec.json yet). Promote to active Specs once
  session-compaction's design phase confirms boundary independence.
- **tool-output-compressor** -- rtk-style compression for native
  Read/Grep/Glob tool outputs (custom opencode plugins). Trigger:
  diagnostic shows tool outputs dominate input tokens, AND `rtk`'s
  Bash-only surface isn't enough on its own. **Status**: TRIGGER
  MET — `accumulatedToolOutputsCached` = 36% of post-exclusion
  spend; `read` ($547), `bash` ($492), and `task` ($213) are the
  top three emitters. Composes with session-compaction (this spec
  bounds N turns; tool-output-compressor bounds bytes-per-turn).
  Re-evaluate after session-compaction lands and the diagnostic
  re-runs.

## Diagnostic findings forwarded to deferred-spec evaluation

(From 2026-05-19 cost report, post-exclusion of the 30-day outlier
session: 128 sessions, $6,128.06 real spend.)

- Per-bucket attribution: `cachedWrite` 44.1%, `subagentDispatch`
  40.8%, `cachedRead` 40.7%, `output` 5.3%. (Sum exceeds 100%
  because subagentDispatch is a re-attribution of subagent session
  totals; see opencode-cost-diagnosis design.)
- `cachedRead` sub-breakdown: `accumulatedToolOutputsCached` 89%,
  `accumulatedHistoryCached` 11%. The other three sub-buckets are
  structurally 0 due to classifier degradation.
- Long-running sessions (>24h wall time): 27 sessions, $4,104
  (67% of post-exclusion spend). The original 30-day session
  was the worst case but the pattern survives without it.
- Subagent attribution: `general` $1,254, `(unattributed)` $1,216
  (recoverable per finding kind `subagent_agent_attribution_drift`),
  `explore` $24, `vault-synthesizer` $4. The unattributed bucket is
  ~50% recoverable per the findings catalog.
- Findings still firing every session due to classifier
  degradation and migration: `per_bucket_cost_deferred` (128),
  `cached_read_classifier_degraded` (128) — both are informational
  noise pending a classifier fix.
- 27 sessions tripped `pricing_table_drift` because of
  `anthropic/claude-opus-4-6` (a model not in the pinned pricing
  table). These sessions have null per-bucket attribution; only
  their total cost is recorded. A pricing-pin refresh is the
  highest-leverage fix outside any spec.

## Additional Specs (operator UX)

- [ ] opencode-turn-timestamps -- Patch the pinned OpenCode TUI so live
  user/assistant turns display local timestamps from existing message metadata.
  Dependencies: none. **Status**: brief-written. This is separate from the
  cost-reduction roadmap and does not change session persistence, cavemem, or
  cost diagnostics.

## Additional Specs (operator safety)

- [ ] opencode-nono-sandbox -- Wrap OpenCode launches with nono and render
  validated sandbox profiles with staged rollout state. Topology (2026-06-03):
  preflight launcher (host-privileged, outside nono) → nono → bare opencode, so
  Keychain/`security`/`curl` stay out of the sandbox. Dependencies:
  mcpproxy-migration and opencode-cost-diagnosis as existing integration
  surfaces. **Status**: design-generated 2026-06-03; design split on 2026-06-03
  (audit/compat/review moved to opencode-nono-audit). Does not replace OpenCode
  permission prompts or mcpproxy quarantine controls.
- [ ] opencode-nono-audit -- Read-only CLI that audits historical OpenCode tool
  usage, assesses it against the managed nono profiles, and emits a ranked
  common-tool-use list with advisory MCP-replacement decisions (incl. git → Git
  MCP). Reuses `SqliteReader` from opencode-cost-diagnosis and `nono profile
  show --json`; writes the freshness marker opencode-nono-sandbox's
  strict-enforcement check reads. Dependencies: opencode-nono-sandbox (rendered
  profiles + metadata), opencode-cost-diagnosis (SqliteReader). **Status**:
  design-generated 2026-06-03 (split from opencode-nono-sandbox). Advisory only;
  never changes OpenCode permissions or MCP registrations.

## Additional Specs (harness memory)

- [ ] agentmemory-opencode-migration -- Replace cavemem only for the OpenCode
  harness with a patched, declaratively managed agentmemory runtime; migrate
  existing OpenCode history and adapt recall consumers. Dependencies:
  mcpproxy-migration,
  cavemem-integration, session-compaction, vault-synthesizer-agent,
  memory-sync-cli, sqlite-backup, and opencode-nono-sandbox. **Status**:
  tasks-generated 2026-09-05; immediate-cutover runtime risk accepted by the
  operator; simplified to 25 tasks using stock AgentMemory behavior and the
  existing patched OpenCode plugin; Pi remains on cavemem with future
  AgentMemory plugin compatibility preserved.
- [ ] agentmemory-obsidian-migration -- Import curated `memories/*.md` notes
  into each selected host-local AgentMemory store, then remove Obsidian from
  mcpproxy, startup checks, and active agent prompts. Dependencies:
  agentmemory-opencode-migration. **Status**: tasks-generated 2026-09-14; hard
  cutover selected, with no rollback or bidirectional sync.
