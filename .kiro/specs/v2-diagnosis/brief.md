# Brief: v2-diagnosis

## Problem

The v1 `opencode-cost-diagnosis` CLI produces a usable bucket-level
token report, but two structural gaps in v1 leave the majority of
the deferred-spec triggers in `roadmap.md` still hypothesis-grade.
The most recent full-history report (122 sessions, $7,478 total,
generated 2026-05-18T00:45) makes both gaps unambiguous:

**Gap 1: Per-bucket dollar attribution is deferred.** Every report
v1 emits carries the `per_bucket_cost_deferred` finding. The report
shows `cost.total` per session and per project (authoritative,
read from `session.cost`), but the per-bucket `cost.{cachedRead,
cachedWrite, uncachedInput, output, reasoning, subagentDispatch}`
fields are all `null`. As a result, the report ranks cost drivers
by **token count**, not by dollars. Those two rankings disagree
materially:

- Anthropic Opus-4 pricing has roughly 50× spread between cache-read
  (~$1.50/M) and output (~$75/M), and 12.5× spread between cache-read
  and cache-write (~$18.75/M).
- v1's report shows `cachedRead` = 6.99B tokens (64.2% of input
  volume) vs `cachedWrite` = 568M tokens (5.2%). By tokens,
  cachedRead is ~12× larger. By dollars (at the rates above),
  cachedWrite is comparable or larger — `6.99B × $1.50/M ≈ $10,489`
  vs `568M × $18.75/M ≈ $10,650`.
- Without per-bucket dollar attribution, we cannot tell whether the
  marginal optimization target is "reduce cache reads" (cheap per
  token, dominant by volume) or "reduce cache writes" (expensive
  per token, smaller by volume but plausibly larger by spend).

**Gap 2: `cachedRead` is monolithic.** v1 reports `cachedRead` as a
single bucket. Inside it sit at least four distinct content
populations:

- the base opencode system prompt (constant prefix)
- enabled MCP servers' tool schemas (this user has ~30 MCP servers
  active, so this is substantial)
- the layered AGENTS.md content (global + project)
- accumulated prior-turn content (history + tool outputs that fell
  into the cache as later turns added)

v1's tokenizer Splitter already classifies parts by role and type
for the **uncached** sub-buckets (`uncachedSystemPrompt`, `history`,
`toolOutputs`). The same classifier is not yet applied to cached
content, so the 64.2%-of-all-tokens bucket is opaque. Four of seven
deferred specs in `roadmap.md` (`agents-md-modularization`,
`mcp-server-allowlist`, `tool-output-compressor`, `rtk-install`)
have triggers that are *only* verifiable by decomposing
`cachedRead`:

- "system-prompt-uncached cost is large" — the v1 report shows
  uncached = 0 (caching works); the actual content of the cached
  prompt is unmeasured
- "MCP tool schemas dominate uncached prefix tokens" — same problem;
  schemas live in the cached prefix
- "tool outputs dominate input tokens" — toolOutputs bucket in v1
  is uncached-only (1M of 11B); the cached portion is invisible
- "Bash tool calls produce enough output to justify rtk" — no
  per-tool breakdown exists at all in v1

Until both gaps close, the only deferred spec with sufficient
evidence to ship is `subagent-context-budget`. v2-diagnosis exists
to unblock the rest.

## Current State

- **v1 ships at `~/.local/share/opencode/opencode-stable.db`** as a
  read-only consumer; declarative install via Nix overlay + HM
  module on both nix-darwin hosts.
- **v1 emits Markdown + JSON** under `$XDG_STATE_HOME/opencode-cost-diagnosis/reports/`,
  pruned to 10 files per format.
- **v1 schema is forward-compatible** for per-bucket cost: the
  `CostBuckets` type already has `cachedRead, cachedWrite,
  uncachedInput, output, reasoning, subagentDispatch` fields,
  populated with `null` per the deferred decision recorded in
  `opencode-cost-diagnosis/design.md`.
- **Pricing data does not exist anywhere in this repo.** opencode's
  own SQLite DB stores `cost` (a pre-computed dollar value
  per assistant turn) and `tokens.*` (per-category counts) but not
  per-token rate tables. Anthropic publishes pricing on its
  marketing pages and via the Admin API; neither is currently
  consumed by anything here.
- **opencode model metadata**: `message.data.providerID` +
  `message.data.modelID` are persisted per turn; this is enough to
  key into a pricing table once one exists.
- **The Tokenizer Splitter classifier** (v1, `scripts/opencode-cost-report.js`,
  per `opencode-cost-diagnosis/design.md` lines 760-784) already
  knows how to classify parts by role + type. It currently runs
  only over each session's part rows for the uncached sub-bucket
  split; extending it to the cached fraction is the natural lift.
- **Per-tool attribution does not exist.** v1 records tool calls
  via `part.type='tool'` rows but does not aggregate tokens per
  tool name. A future "Bash dominates" finding requires this.
- **subagentDispatch is single-number per parent session.** Per-agent-type
  breakdown is not in v1 (this gap is the one
  `subagent-context-budget`'s audit step needs filled).

## Desired Outcome

A v2 of the diagnostic that is a drop-in replacement for v1 (same
CLI surface, same install pipeline, same output locations) and
emits a richer report. After v2 lands, every deferred spec trigger
in `roadmap.md` resolves to YES or NO with evidence, not guesswork.

Concretely:

- The Markdown + JSON report contains a non-null `cost.{cachedRead,
  cachedWrite, uncachedInput, output, reasoning, subagentDispatch}`
  per session, per project, and at the global level.
- The `cachedRead` bucket is decomposed into named sub-buckets:
  `systemPromptCached`, `agentsMdCached`, `mcpToolSchemasCached`,
  `accumulatedHistoryCached`, `accumulatedToolOutputsCached` (final
  names settled in design). Sum-correctness invariant preserved:
  sub-buckets sum exactly to the bucket total, with the last one
  absorbing rounding (mirrors v1's pattern for the uncached split).
- The `subagentDispatch` bucket is decomposed by agent type
  (`general`, `explore`, `nix-pkg`, etc.). Sum-correctness preserved.
- The `toolOutputs` bucket is decomposed by tool name (Read, Grep,
  Glob, Bash, the MCP `hub_*` tools, etc.).
- A pricing-table file ships with the CLI, pinned per supported
  model. Unknown `providerID:modelID` combos emit a
  `pricing_table_drift` finding and fall back to v1 behavior
  (per-bucket cost = null) for those sessions, while still
  populating dollar costs for known models.
- The accuracy disclaimer block is updated to describe the new
  sub-buckets' accuracy class (still tiktoken-derived for the
  cached splits, so still "relative-only" for those).
- v1's golden-file integration tests still pass with `UPDATE_GOLDEN=1`
  applied; new tests cover the cached decomposition, per-tool
  breakdown, per-agent-type breakdown, dollar attribution, and
  pricing-table drift handling.

## Approach

Build v2 as a successor to v1 in the same Node CLI codebase, NOT a
parallel binary. The HM module's `package` option swings from the
v1 wrapper to the v2 wrapper at cutover. The two cannot coexist on
PATH (same binary name).

Five workstreams, mostly stackable in parallel after the data layer:

1. **Pricing table layer.** Ship a JSON pricing table (one row per
   `providerID:modelID` we support, columns for input / output /
   cache-read / cache-write per million tokens). Source values from
   Anthropic's public docs at pin time; document the pin in the
   table. Add a `PricingTable` module that loads the JSON, keys by
   `providerID:modelID`, and returns rates with explicit handling
   for unknown keys. Tested with a synthetic table + a known-unknown
   key fixture.

2. **Per-bucket cost computation.** Extend the existing Attribution
   Engine: for each `SessionAttribution`, populate per-bucket cost
   fields by multiplying that bucket's token total by the
   appropriate per-token rate from the pricing table. INVARIANT:
   `sum(per-bucket cost) == session.cost`, within a documented
   tolerance to account for opencode's internal rounding. Mismatch
   emits a `cost_invariant_violation` finding (does not block
   report emission).

3. **`cachedRead` decomposition.** Reuse v1's Tokenizer Splitter
   classifier, applied to the chronological part stream up to the
   cache-write boundary for each session. Classify each part as:
   system prompt (role=system, source=opencode core), AGENTS.md
   (role=system, source=AGENTS.md inclusion — needs a heuristic or
   marker), MCP tool schema (role=system, source=tool definition
   block — distinguishable by JSON-schema-shaped content), history
   (role=user/assistant, prior turns), tool outputs cached (tool
   parts that survived into the cache prefix on a subsequent
   write). Each classified token count proportionally allocates the
   `cachedRead` total across sub-buckets; the last sub-bucket
   absorbs rounding (mirrors v1).

4. **Per-tool and per-agent-type breakdown.** Extend the Subagent
   Aggregator to group child sessions by their agent type
   (read from child `session.data` JSON). Extend the part-row scan
   to bucket tool tokens by `part.data.name` (the MCP-prefixed tool
   name). Both emit non-cardinality-bounded sub-buckets: low-volume
   tools and agent types may be folded into an `other` bucket if
   they fall below a threshold (e.g. <1% of their parent bucket).

5. **Report format + golden-file refresh.** Update the Markdown and
   JSON serializers to emit the new fields. Preserve JSON key
   ordering (alphabetical within each object) so the byte-identical
   guarantee from R6.AC3 carries through. Refresh integration-test
   golden files via `UPDATE_GOLDEN=1`; commit both old (v1) and new
   (v2) goldens side-by-side for the migration window so a v1→v2
   diff is reviewable in PR.

## Scope

- **In**:
  - Pricing-table file (JSON) + `PricingTable` module + per-bucket
    cost computation in the Attribution Engine
  - `cachedRead` decomposition into named sub-buckets via re-use of
    v1's tokenizer classifier
  - Per-tool breakdown of `toolOutputs` (cached + uncached portions
    where distinguishable)
  - Per-agent-type breakdown of `subagentDispatch`
  - Findings: `pricing_table_drift` (unknown model),
    `cost_invariant_violation` (sum mismatch), retain v1 findings
  - Updated disclaimer naming the new sub-buckets and their
    accuracy class
  - Drop-in replacement for v1 (same CLI surface, same output
    paths, same HM module name)
  - Refreshed golden-file tests; v1 goldens retained for diff review

- **Out**:
  - **Any cost-reduction intervention** (still the v1 constraint;
    this remains a diagnostic, not an optimizer)
  - Anthropic Admin Cost Report API integration (still deferred;
    daily granularity is still the wrong layer)
  - Helicone, Langfuse, or any SaaS forwarding
  - Real-time / web dashboards
  - Cross-host data merge
  - Cost forecasting or anomaly detection
  - Comparison/diff between report runs (still a follow-on
    convenience, not v2 scope)
  - Per-model breakdown beyond what the pricing-table key naturally
    provides (we already have model attribution in opencode's data;
    no new layer)
  - The optional live-logger plugin from v1 (still deferred)

## Boundary Candidates

- **Pricing layer**: JSON file + `PricingTable` module + the
  enrichment hook in Attribution Engine. Smallest self-contained
  seam.
- **Cached classifier**: extends v1's Tokenizer Splitter; lives in
  the same `scripts/opencode-cost-report.js` per v1's single-file
  decision. Internal-only seam.
- **Per-tool and per-agent-type aggregation**: minor extensions to
  Subagent Aggregator + Tokenizer Splitter (and possibly the
  Attribution Engine to wire them). Could be a single PR.
- **Report serializer + golden refresh**: independent file; can land
  last.

## Out of Boundary

- Anything in v1's "Out" list, carried forward unchanged
- Pricing-table auto-update / fetch-on-run (the table is a pinned
  static asset; manual refresh on Anthropic price changes)
- Multi-currency support (USD only)
- Discounts, prepaid credits, or contract-rate accounting
  (list-price rates only; if real spend ≠ list price, the report's
  per-bucket dollars will not match billing; this is documented in
  the disclaimer)

## Upstream / Downstream

- **Upstream**:
  - `opencode-cost-diagnosis` v1 — codebase, test fixture, golden
    files, HM module, smoke test, pinned `SUPPORTED_MIGRATION_SET`
    are all reused. v1 ships first; v2 amends.
  - opencode's `session.cost` field — used as the source-of-truth
    total against which per-bucket sums are reconciled.
  - opencode's `message.data.{providerID,modelID}` — keys the
    pricing-table lookup.
  - Anthropic published pricing — the source of pinned values for
    the pricing table. The table records the URL and date pinned.

- **Downstream**:
  - `subagent-context-budget` (concurrent spec) — uses the per-agent-type
    `subagentDispatch` breakdown introduced here as its baseline
    measurement. If v2 ships first, that spec's audit step is
    materially cheaper.
  - `agents-md-modularization`, `mcp-server-allowlist`,
    `tool-output-compressor`, `rtk-install` (all deferred in
    `roadmap.md`) — each becomes verifiable / unblocked after v2
    decomposes `cachedRead` and `toolOutputs`.

## Existing Spec Touchpoints

- **Extends**: `opencode-cost-diagnosis` (v1). Same codebase, same
  tests directory, same HM module, same install pipeline. v2 is a
  forward upgrade, not a parallel project.
- **Adjacent**:
  - `subagent-context-budget` (concurrent) — consumer of the
    per-agent-type breakdown; design phase confirms whether v2 or
    subagent-context-budget ships first based on ordering pressure
    from the operator
  - `sqlite-backup` — the opencode session DB at
    `${XDG_DATA_HOME}/opencode/opencode-stable.db` is the v1 data
    source and remains so for v2; nothing changes about the backup
    target list
  - `cavemem-integration` — the AGENTS.md restructuring it
    performed is one of the markers used by the cached-classifier's
    AGENTS.md detection heuristic (workstream 3). Coupling is one
    way: v2 reads what cavemem-integration produced; cavemem
    has no reason to read anything from v2.

## Constraints

- **Forward-compatible**: v1 output consumers (humans reading
  Markdown; the find/awk filter that generates this brief's
  numbers) keep working. JSON schema is additive: new fields
  appear, existing fields keep their shape (null becomes a number
  for per-bucket cost; everything else stable).
- **macOS-first** (nix-darwin on both hosts), same as v1.
- **Declarative install**: HM module update only; no imperative
  steps. The pricing-table JSON ships as part of the Nix
  derivation.
- **Read-only**: no writes to the opencode DB ever. Same constraint
  as v1.
- **Schema versioning**: v2 pins the same `SUPPORTED_MIGRATION_SET`
  as v1. The pricing table introduces a second drift surface
  (`pricing_table_drift` finding) — same loud-failure ethos.
- **No GPL deps**: any new Node deps stay permissive (MIT, Apache,
  BSD, ISC). Likely no new deps; tiktoken + better-sqlite3 already
  cover everything needed.
- **Zero secret exposure**: same as v1. The pricing table is
  public data; no API keys, no per-user identifiers in the report.
- **No upstream SaaS dependency** (no Helicone, Langfuse, etc.).
- **Pricing drift is operator-visible**: when Anthropic publishes
  new pricing, the operator updates the pinned table manually. The
  report's disclaimer names the pin date so stale prices cannot
  silently mislead.
- **Cost-invariant tolerance**: the per-bucket sum vs
  `session.cost` reconciliation tolerance is documented in
  design.md; default 0.5% per session, configurable. Beyond
  tolerance emits a finding but does not block report emission
  (continuing to ship dollar attribution is more valuable than
  blocking on a rounding edge case).
- **No regression in v1 invariants**: the v1 sum-correctness
  guarantee for uncached sub-buckets is preserved verbatim. JSON
  byte-identical determinism (R6.AC3) is preserved.
