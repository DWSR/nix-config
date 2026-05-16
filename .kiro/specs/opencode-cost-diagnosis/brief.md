# Brief: opencode-cost-diagnosis

## Problem

The user (the sole operator of this nix-config) is paying for Anthropic
API usage driven by opencode sessions and has no per-component
attribution of where those tokens go. Cost data exists at the monthly
billing level and at the per-turn level (opencode logs it locally), but
no tool currently aggregates that into a usable breakdown of: system
prompt (cached vs uncached), conversation history, tool outputs,
subagent dispatches. Without that attribution, every candidate
cost-reduction intervention -- prompt caching, MCP allowlists,
AGENTS.md trimming, session compaction, tool-output compression, rtk,
etc. -- is hypothesis-grade. Building any of them without evidence
risks multi-week wasted work on the wrong layer.

## Current State

- **opencode persists per-turn token usage locally** to
  `~/.local/share/opencode/opencode-stable.db` (SQLite, Drizzle-
  managed). The `message.data` JSON blob already records
  `tokens.{input, output, reasoning, cache.read, cache.write}` and
  pre-computed `cost` per assistant turn.
- **Tool calls live in the `part` table** (FK to `message`), so we can
  reconstruct which tool outputs preceded each turn.
- **Subagent sessions are separate `session` rows.** The link from
  parent to child session is unverified -- design-phase TODO to confirm
  the schema exposes `parent_session_id` or equivalent. If not,
  subagent attribution lumps into the parent turn that dispatched it.
- **Anthropic Admin Cost Report API** exists but is daily-granularity
  only (`bucket_width: "1d"`), with `group_by` over workspace and
  description. Useful as a cross-check on monthly totals; insufficient
  for per-session attribution.
- **No existing tool** does the specific breakdown we want for
  opencode. `opencode-helicone-session` forwards data to Helicone SaaS
  but doesn't produce a local component breakdown. `langfuse` is
  generic and would need a plugin shim. `tokencost` is a tokenization
  library, useful as a dependency.

## Desired Outcome

A repeatable command -- something like `opencode-cost-report
--last 30d` or `opencode-cost-report --session <id>` -- produces a
Markdown + JSON breakdown of token cost by attribution category, per
session and per project (grouped by cwd). The report makes it
unambiguous which cost driver dominates the user's actual workflow, so
the next spec can target it with evidence. The diagnostic is durable:
it stays installed via Nix + HM and gets re-run after every
cost-reduction intervention as the success-measurement primitive.

## Approach

Build a small Node CLI (matches opencode's own runtime; reuses
`@anthropic-ai/tokenizer` if we go the re-tokenize route) installed via
a Nix overlay + Home Manager module on both target hosts. The CLI:

1. Opens the opencode SQLite DB read-only.
2. Iterates `session` -> `message` rows, parses `message.data` JSON.
3. Attributes each turn's input tokens across four categories:
   - **System prompt** (constant prefix; further split into cached vs
     uncached using `tokens.cache.read` and `tokens.cache.write`)
   - **Conversation history** (prior-turn messages still in context)
   - **Tool outputs** (computed via the delta method: `input_tokens[N+1] -
     input_tokens[N] - output_tokens[N]` after accounting for cache
     reads; or via re-tokenization of `part` rows -- design picks one)
   - **Subagent dispatches** (joined via parent-child session link if
     the schema supports it; otherwise rolled into the dispatching
     turn)
4. Emits the report in Markdown (for review) and JSON (for diffing
   between runs).
5. Optional: ships an opencode plugin hook (`message.updated`) that
   emits structured cost events into a separate log file for
   higher-frequency aggregation. Design-time decision whether this is
   in scope for v1 or deferred.

Why Node: matches opencode's runtime, allows reusing the same
tokenizer opencode uses if needed, keeps the dependency footprint
small. Why a CLI over a web UI: text reports are diff-able, archive-
able, and don't require running a service. Why SQLite-direct over
plugin-based ingest: all historical data is already in the DB; a
plugin-only approach would only see sessions going forward. SQLite-
direct gives us a baseline immediately.

## Scope

- **In**:
  - Node CLI installed via Nix overlay + HM module
  - Per-session and per-project (cwd-grouped) breakdowns
  - Cached vs uncached prefix split using `tokens.cache.{read, write}`
  - Tool-output attribution (delta method OR re-tokenization -- pick in
    design phase)
  - Subagent dispatch attribution (best-effort, with design-time
    verification of parent-child schema link)
  - Markdown + JSON report formats
  - Multi-host parity (Shopify + personal nix-darwin)
  - Pinned opencode version range with loud failure on schema drift
  - At least one optional live-logger plugin design-phase decision
    (in scope for v1 OR explicitly deferred -- not left undecided)

- **Out**:
  - Any cost-reduction intervention itself (those become follow-on
    specs informed by this diagnostic's output)
  - Real-time dashboards, web UIs, hosted services
  - Anthropic Admin Cost Report API integration (deferred; not the
    primary data source)
  - Cross-host data merge (each host runs its own report)
  - Cost forecasting or anomaly detection
  - Per-model breakdown beyond what opencode's `cost` field already
    encodes (model attribution is already in the DB; not a new layer
    to build)
  - Comparison reports between runs (just-emit-the-data; diffing two
    JSON reports can be a follow-on convenience if desired)

## Boundary Candidates

- **Data layer**: SQLite reader, schema-version check, normalized
  per-turn dataset projection
- **Attribution logic**: Token bucketing into the four categories;
  cached vs uncached split; subagent linkage
- **Reporter**: Markdown + JSON output, per-session and per-cwd
  aggregations
- **(Optional) Live logger plugin**: opencode plugin hook that emits
  structured cost events on `message.updated` for future cross-session
  aggregation. Either in v1 or explicitly deferred -- design-phase
  decision

## Out of Boundary

- Building any cost-reduction intervention (follow-on specs only)
- A web UI or live dashboard (Markdown + JSON only)
- Cross-host aggregation (single-host reports only)
- Anthropic Admin Cost Report API as a data source (deferred; daily
  granularity is the wrong layer)
- Replacing opencode's own usage display (we read its DB; we don't
  modify how opencode reports usage to the user during a session)
- Helicone or Langfuse integration (complementary tools, not in scope)

## Upstream / Downstream

- **Upstream**:
  - opencode's local SQLite session DB schema (read-only consumer; we
    must track which opencode versions we support and fail loudly on
    drift)
  - Anthropic's prompt-caching metrics surfaced via opencode's
    `tokens.cache.{read, write}` fields (the diagnostic depends on
    these being populated, which requires opencode to enable caching;
    if opencode doesn't, the diagnostic will show 0% cache hit and
    that itself is a finding)
- **Downstream** (likely consumers; all deferred):
  - Every cost-reduction spec listed in `roadmap.md` under "Deferred
    Specs" reuses the diagnostic as its success-measurement primitive
  - Re-runs of the diagnostic in CI / pre-commit hooks (out of scope
    for v1; possible future addition)

## Existing Spec Touchpoints

- **Extends**: none (greenfield project)
- **Adjacent**:
  - `cavemem-integration` -- pattern reference for Nix overlay + HM
    module install of a CLI on both hosts. Reuse the wiring approach.
  - `memory-sync-cli` -- pattern reference for a Node-based CLI shipped
    via `scripts/<name>.nix` and exposed through HM. Reuse the
    derivation shape.
  - `sqlite-backup` -- The opencode session DB at
    `${config.xdg.dataHome}/opencode/opencode-stable.db` is now in the
    backup target list on the Shopify host (added 2026-05-15 alongside
    this discovery as a direct host-config change in
    `configurations/shopify/home-manager/sqlite-backup.nix`). Personal-
    host wiring intentionally deferred, mirroring the cavemem
    precedent. The diagnostic should treat the backed-up DB as its
    durable baseline; if a session DB is unrecoverable on a given
    host, the diagnostic falls back to whatever the local DB still
    holds and emits a warning.

## Constraints

- **macOS-first** (nix-darwin on both Shopify and personal hosts)
- **Read-only access** to opencode's SQLite DB; never write
- **Schema versioning**: pin supported opencode version range
  explicitly; fail loudly on drift rather than silently miscount
- **Node runtime**: stay on the Node version opencode itself uses, to
  match the tokenizer if we go that route
- **Declarative install**: Nix overlay + HM module, like all other
  tooling in this repo. No imperative install steps.
- **Zero secret exposure**: report output may include cwd paths and
  session IDs but must not include message bodies or tool outputs by
  default (a `--include-content` flag for debugging is acceptable but
  off by default)
- **No GPL contamination**: any Node deps used must be permissive
  (MIT, Apache, BSD, ISC)
- **No upstream dependency on Helicone / Langfuse SaaS**
