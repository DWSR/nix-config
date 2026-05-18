# Gap Analysis: v2-diagnosis

Generated: 2026-05-18

This document maps the approved `requirements.md` against the existing
`opencode-cost-diagnosis` v1 codebase (the asset v2 extends in place)
and against external dependencies (Anthropic pricing data, the model
identity opencode persists). It is the brownfield gap-analysis pass
for v2 and the input to `/kiro-spec-design v2-diagnosis`.

## Critical findings up front

1. **v2 is overwhelmingly an extension, not a rewrite.** v1 already
   carries a forward-compat seam (`PER_BUCKET_COST_KEYS` constant +
   `makeZeroCostBuckets()` setting them to `null` by Iteration 2.5
   decision; `per_bucket_cost_deferred` finding on every session).
   v2's main job is to populate those nulls. All seven of v2's
   requirements map to existing classes; the only genuinely new
   component is a `PricingTable` + a pinned JSON pricing asset.

2. **The session schema already exposes everything v2's per-agent
   decomposition needs.** Verified live: `session` table column 20
   is `agent TEXT`. v1's `SqliteReader.rootSessionsMatching` and
   `descendantSessionsOf` already `SELECT *`, so each row already
   carries the `agent` field. The `SubagentAggregator` currently
   collapses across descendants; the extension is a single per-agent
   bucket map. Low risk.

3. **Pricing model identity lives across two columns + the message
   JSON.** Verified live: `session.model TEXT` (column 21) holds the
   per-session "primary" model, but per-turn `tokens.cache.{read,
   write}` + `cost` semantics in opencode require per-message
   accuracy (a session can change models mid-stream). v1's research
   noted `message.data.{providerID, modelID}` as the per-turn key.
   v2's pricing lookup keys by per-turn identity, not per-session,
   so the AttributionEngine must read message JSON during cost
   computation. Design-phase decision: do we pivot to per-message
   cost computation or accept session-level approximation? See
   Open Question 1.

4. **The cachedRead decomposition is the hardest sub-problem.**
   opencode's `part` rows carry **no cache marker** (v1 code
   comment, `opencode-cost-report.js:640-646`). The cached/uncached
   split comes only from session-level `tokens_cache_read /
   tokens_cache_write` totals. v2 must reconstruct, by content
   shape and chronological walk, which parts contributed to the
   cached prefix vs the uncached delta on each turn. Two viable
   approaches; both have accuracy caveats inheritable from v1's
   tokenizer disclaimer. See Open Question 2.

5. **The existing tokenizer + sum-correctness pattern is reusable
   verbatim for v2's three new decompositions.** v1's Flow 2 math
   (`bucket_sys + bucket_hist + bucket_tool == T_input` via
   proportional split with last-bucket rounding absorption) is the
   exact template for v2's cachedRead-into-sub-buckets, tool-output-
   into-per-tool, and subagentDispatch-into-per-agent. Same
   relative-only accuracy class; same disclaimer surface.

6. **Forward compatibility is structurally guaranteed** if v2
   preserves alphabetical JSON key ordering and never renames v1
   fields. v1's `ReportAssembler` already enforces alphabetical
   serialization; new sub-bucket keys are additive. R7 is mostly a
   discipline requirement, not an engineering one.

## Requirement-to-Asset Map

### Requirement 1: Drop-in replacement of v1

| Asset | Status | Notes |
| --- | --- | --- |
| CLI entry-point name on PATH | **Exists** | `scripts/opencode-cost-report.nix` (writeShellApplication, name=`opencode-cost-report`). v2 keeps the same name; the HM module surfaces `programs.opencode-cost-diagnosis.package` which v2 replaces in place. |
| Flag surface (`--last`, `--session`, `--cwd`, `--include-content`, `--format`, `--output`, `--supported-opencode-version`, `--help`) | **Exists** | `ArgumentParser` at `opencode-cost-report.js:2096-2280`. v2 may add flags but must not break v1's interpretation. |
| Default output location + per-format pruning | **Exists** | `FileWriter` at `opencode-cost-report.js:1146-1440`; default path `$XDG_STATE_HOME/opencode-cost-diagnosis/reports/<iso8601>.{md,json}`, mode 0600, last-10-per-extension prune. v2 reuses verbatim. |
| All v1 invariants in R1.AC5 (read-only, concurrent-safe, byte-identical JSON, default-exclude privacy, file-permission posture, schema-drift loud-failure, host parity, declarative install) | **Exists** | Spread across `SqliteReader.open()`, `ReportSerializer`, `FileWriter`, `home-manager/common/opencode-cost-diagnosis.nix`. v2 inherits by not touching them. |
| Replace-not-coexist on PATH | **Pattern** | HM module exposes `programs.opencode-cost-diagnosis.package`; binary name is fixed; replacing the derivation is automatic on `darwin-rebuild switch`. No coexistence work needed. |

**Gap**: None. R1 is satisfied by NOT regressing v1.

### Requirement 2: Per-bucket dollar attribution

| Asset | Status | Notes |
| --- | --- | --- |
| `PER_BUCKET_COST_KEYS` constant (`cachedRead`, `cachedWrite`, `uncachedInput`, `output`, `reasoning`, `subagentDispatch`) | **Exists** | `opencode-cost-report.js:1471-1478`. The exact six fields R2.AC1 needs to populate. |
| `makeZeroCostBuckets()` setting per-bucket fields to `null` | **Exists, must be updated** | `opencode-cost-report.js:1486-1492`. v2 must change `null` → computed value. The function name is forward-compat (zero ≠ null in v1's intent, but v2 populates real values). |
| `per_bucket_cost_deferred` finding | **Exists, must be removed** | `AttributionEngine.attributeSession` emits this finding every session (per v1 design.md:859-861). v2 stops emitting it once per-bucket cost is populated. v1 readers won't break (R7.AC4 says "may add new findings but shall not remove or rename existing findings" — this needs an exception, see Open Question 3). |
| `session.cost` authoritative source (for reconciliation) | **Exists** | `SubagentAggregator.rollup()` reads `session.cost` (line 577). AttributionEngine already populates `CostBuckets.total` from this. v2 reconciles per-bucket sum against this same value. |
| Per-project and global aggregation | **Exists** | `ReportAssembler` already does cost aggregation at all three levels for `cost.total`. The same code paths can populate per-bucket fields once non-null. |
| `cost_invariant_violation` finding | **Missing** | New finding name; design picks the exact wording. Tolerance value also a design pick (brief default: 0.5%). |
| Sub-bucket dollar inheritance from parent bucket rate (R2.AC5) | **Trivially derivable** | Since sub-buckets sum to parent bucket tokens and share the parent's per-token rate, sub-bucket dollars = sub-bucket tokens × parent rate. Free arithmetic. |

**Gap**: Three changes. (a) `makeZeroCostBuckets` returns computed values not nulls; (b) drop `per_bucket_cost_deferred` finding emission (R7 exception); (c) add `cost_invariant_violation` finding and tolerance constant.

**Effort**: S — straightforward extension of AttributionEngine and ReportAssembler.

### Requirement 3: Bundled pricing data

| Asset | Status | Notes |
| --- | --- | --- |
| Vendored deps tree at `overlays/opencode-cost-diagnosis-deps/` | **Exists** | `package.json` pins `better-sqlite3@12.10.0` + `tiktoken@^1.0.22`. v2 may add a JS dep if needed, but ideally pricing is a plain JSON asset. |
| Mechanism for shipping a static JSON asset with the diagnostic | **Pattern available, none used yet** | Two choices: (1) inline JSON in `opencode-cost-report.js` (smallest; requires regenerating the JS on price refresh); (2) separate `scripts/opencode-cost-report-pricing.json` shipped alongside the JS in the same Nix derivation. (2) is cleaner; mirrors how `scripts/cavemem-import-vault.js` is co-located with its `.nix` wrapper. |
| `PricingTable` class | **Missing — new component** | Small class: constructor loads JSON, `lookup(providerID, modelID)` returns rates or null, `pinDate` + `pinSource` accessors for report metadata. ~30-50 LOC. |
| Per-turn provider+model identity in opencode's data | **Exists** | `message.data.providerID` + `message.data.modelID` per v1 research. Verified via `session.model TEXT` column (column 21) for the session-level fallback. Need to confirm exact field names via fixture inspection in design phase. |
| `pricing_table_drift` finding | **Missing** | New finding shape. Design names the exact wording. |
| Null-fallback for affected session (preserves v1 behavior on drift) | **Existing pattern** | `makeZeroCostBuckets` already returns nulls; v2 conditionally returns the v1 shape if model lookup fails. |
| Pin metadata visible in report (R3.AC3) | **Missing** | New disclaimer extension. Existing `ReportSerializer` already emits the tokenizer disclaimer; pricing metadata becomes a second structured block. |
| `--refresh-pricing` workflow (R3.AC5) | **Trivial** | Refresh = edit the bundled JSON + re-run derivation; no special flag needed. The "no other reconfiguration step" promise is satisfied by the build pipeline alone. |

**Gap**: Two new components (PricingTable class + pricing JSON asset), one new disclaimer block. Sourcing the initial pricing values is the operator-facing research item (Open Question 4).

**Effort**: S — small new class, small JSON file, integration into Attribution Engine.

### Requirement 4: Cached-read decomposition

| Asset | Status | Notes |
| --- | --- | --- |
| `TokenizerSplitter.classifyAndCount(parts, messages)` | **Exists, must be extended** | `opencode-cost-report.js:706-806`. Currently classifies parts by role+type into `{systemPrompt, history, toolOutput, unclassifiedCount}`. v2 extends to ALSO classify content into the new cachedRead sub-buckets. |
| Part-row content extraction (text body, tool output body, fallback JSON-stringify) | **Exists** | Same classifier, same content extraction. v2 reuses this; new logic is per-part SUB-classification within the existing buckets. |
| tiktoken encoder lazy-init + per-process cache | **Exists** | `_ensureEncoding()` pattern. v2 reuses. |
| Proportional-split sum-correctness pattern | **Exists** | `AttributionEngine.attributeSession` Flow 2 math at design.md:574-586. v2 applies the same pattern to cachedRead with last-sub-bucket rounding absorption. |
| Detection of "this part is system prompt" vs "AGENTS.md content" vs "MCP tool schema" within the cached prefix | **Missing — requires heuristic** | The system-role message body is a single concatenated text blob. Splitting it requires content-shape heuristics: MCP schemas have a recognizable JSON-shape (`{"name":"...","description":"...","input_schema":...}`); AGENTS.md content has markdown headings + the inline AGENTS.md path comment from opencode's prompt assembly; base system prompt is the residual. **This is the dominant accuracy risk.** See Open Question 2. |
| Detection of "this part was cached" vs "fell out of cache this turn" | **Missing — not directly recoverable** | opencode's part rows carry no cache marker (v1 code comment lines 640-646). v2 must approximate via chronological walk + per-turn cache_read/cache_write deltas. Same proportional approximation pattern as v1's uncached split. |
| Disclaimer extension covering cachedRead sub-buckets (R4.AC4) | **Missing** | Existing tokenizer disclaimer at `ReportSerializer`'s header block. v2 extends the same block to name the new affected sub-buckets. |
| Classification-residual sub-bucket and finding (R4.AC5) | **Pattern available** | v1 already has `unclassifiedCount` + `schema_partial_data` finding for unclassifiable content. v2 mirrors the pattern at the cachedRead sub-bucket level. |

**Gap**: Most consequential gap. New classifier logic for splitting system-side content into named sub-buckets is heuristic; per-turn cached/uncached attribution within history & tool outputs is approximation. Both inherit v1's "relative-only" accuracy class and disclaimer pattern.

**Effort**: M — 3-5 days. New classifier rules, sum-correctness math at a new level, disclaimer surgery, residual handling, unit + integration tests with golden refresh.

### Requirement 5: Subagent-dispatch per-agent-type decomposition

| Asset | Status | Notes |
| --- | --- | --- |
| `session.agent TEXT` column | **Exists** (verified live: column 20 on session table) | The agent type is a first-class column, not buried in JSON. `SubagentAggregator` already pulls `SELECT *` so each descendant row carries the agent field. Zero new SQL. |
| `SubagentAggregator.rollup(rootSessionId)` | **Exists, must be extended** | `opencode-cost-report.js:501-586`. Currently returns `{ totals: { tokensTotal, cost, childCount }, findings: [] }`. v2 returns the same shape PLUS a `byAgent` map (`Map<string, { tokensTotal, cost, childCount }>`). Sum-correctness: sum of `byAgent` values equals `totals`. |
| Per-agent aggregation at session/project/global levels | **Pattern available** | `ReportAssembler` already aggregates `subagentDispatch` at all three levels. v2 extends the same aggregation paths to carry the per-agent map. |
| Unknown-agent residual (R5.AC4 condition a) | **Missing — defensive only** | If `session.agent` is `NULL` (older opencode rows?) or unrecognized, those tokens fold into a named residual. Defensive against opencode schema evolution. |
| Low-volume folding residual (R5.AC4 condition b) | **Missing** | New behavior. Threshold is a design pick. Report surfaces the threshold so the operator can interpret. |
| Per-agent-type cost (R2.AC5 inheritance) | **Trivially derivable** | `byAgent[type].cost = byAgent[type].tokensTotal × subagentDispatch_rate_per_token`. Sub-bucket dollar inheritance just works. |

**Gap**: Single class extension on `SubagentAggregator`, one new map field, two named residuals. Low risk.

**Effort**: S — 1-2 days.

### Requirement 6: Tool-output per-tool decomposition

| Asset | Status | Notes |
| --- | --- | --- |
| `TokenizerSplitter` already iterates tool parts | **Exists** | Lines 766-777 currently classify tool parts into the `toolOutput` bucket. The tool name is in `part.data.name` (per opencode's part shape; needs verification in design phase). |
| Per-tool name dimension in the classifier output | **Missing — small extension** | Change `toolOutput: number` to `toolOutput: { total: number, byTool: Map<string, number> }`. AttributionEngine adapts to the new shape. |
| Cached vs uncached portion split for tool outputs (R6.AC2) | **Inherits R4 complexity** | Tool-output tokens may live in both `cachedRead` and `uncached input` sub-buckets across turns. v2's tool decomposition piggybacks on R4's cached vs uncached classification. |
| Aggregation at session/project/global | **Pattern available** | Same as R5 — ReportAssembler extension. |
| Low-volume folding residual | **Missing** | Same shape as R5.AC4 condition b. |
| Per-tool name resolution for MCP tools | **Trivial** | Opencode records tool names with the `hub_<server>_<tool>` prefix verbatim. No name normalization needed unless design phase decides to group by server. |

**Gap**: Small classifier extension + named residual.

**Effort**: S — 1-2 days, mostly testing.

### Requirement 7: Forward compatibility for v1 report consumers

| Asset | Status | Notes |
| --- | --- | --- |
| Alphabetical JSON key ordering for byte-identical determinism | **Exists** | `ReportSerializer` uses a custom replacer (per v1 design + R6.AC3). v2 inherits; new fields slot into alphabetical position. |
| `per_bucket_cost_deferred` finding (v1) | **Exists, conflict with R7.AC4** | v2 stops emitting this finding (because per-bucket cost is now populated). R7.AC4 says v2 must not remove v1 findings. **This is an apparent contradiction.** See Open Question 3. |
| `BUCKET_TOTAL_KEYS` constant (8 fields) | **Exists** | v2 preserves all 8; sub-bucket fields are additive within nested objects, not replacements at the top level. |
| `PER_BUCKET_COST_KEYS` constant (6 fields) | **Exists** | v2 preserves the 6 keys but flips them from null-valued to number-valued. The null-to-value transition is exactly R7.AC5's contract. |
| v1 integration test golden files at `tests/opencode-cost-diagnosis/integration/golden/*.{md,json}` | **Exists** | v2 must refresh these AND keep the old goldens around for one cycle so the PR diff is reviewable (per brief). Mechanically straightforward via `UPDATE_GOLDEN=1`. |
| Sum-correctness invariant for uncached sub-buckets | **Exists** | `AttributionEngine` enforces it and exits code 5 on violation (v1 design.md:855). v2 preserves and adds new sum-correctness invariants for cachedRead/per-tool/per-agent. |

**Gap**: Resolve the `per_bucket_cost_deferred` removal-vs-R7.AC4 contradiction (Open Question 3). Otherwise inherited.

**Effort**: S — discipline + golden refresh.

## Implementation Approach Options

### Option A: Extend Existing Components (RECOMMENDED — and required by brief)

**Rationale**: The brief explicitly mandated this: *"Build v2 as a successor to v1 in the same Node CLI codebase, NOT a parallel binary."* The gap analysis confirms it's feasible: every v2 requirement maps to extension points already present in v1's class structure, with one new class (PricingTable) and one new data asset (pricing JSON).

**Files to extend**:

| File | Change shape |
| --- | --- |
| `scripts/opencode-cost-report.js` | Edit in place. New `PricingTable` class. Extend `TokenizerSplitter.classifyAndCount` for cachedRead sub-classification and per-tool dimension. Extend `SubagentAggregator.rollup` to emit `byAgent` map. Wire `PricingTable` into `AttributionEngine.attributeSession`. Replace `null` per-bucket cost with computed values. Add `cost_invariant_violation`, `pricing_table_drift`, classification-residual findings. Extend `ReportAssembler` aggregation paths to carry new sub-bucket structures. Extend `ReportSerializer` Markdown + JSON sections. ~600-1000 LOC added; file grows from 2,665 to ~3,500. |
| `scripts/opencode-cost-report-pricing.json` (new) | Pinned pricing JSON keyed by `providerID:modelID`. Includes `pinDate`, `pinSource`. ~50-200 LOC depending on model coverage. |
| `scripts/opencode-cost-report.nix` | Inline the pricing JSON path or include it as a build input so it ships in `$out`. ~5 LOC change. |
| `tests/opencode-cost-diagnosis/integration/golden/*.{md,json}` | Refresh via `UPDATE_GOLDEN=1`. Keep v1 goldens for the migration PR; remove after merge. |
| `tests/opencode-cost-diagnosis/unit/*.test.js` | New tests for PricingTable, cost reconciliation, cached-read decomposition, per-agent, per-tool. ~6-10 new tests. |
| `tests/opencode-cost-diagnosis/integration/*.test.js` | New tests for cost-invariant tolerance, pricing-drift fallback, new findings. ~3-5 new tests. |
| `home-manager/common/opencode-cost-diagnosis.nix` | No change. The HM module is opaque to v2's internal structure. |
| `overlays/opencode-cost-diagnosis-deps/package.json` | No change. No new JS deps needed (pricing is plain JSON). |

**Integration points**:
- `programs.opencode-cost-diagnosis.package` HM-option already surfaces the binary; v2 replaces the derivation transparently on `darwin-rebuild switch`.
- `xdg.dataHome` for source DB path — unchanged.
- `xdg.stateHome` for output dir — unchanged.

**Trade-offs**:
- ✅ Brief-mandated; no decision cost.
- ✅ Every v2 capability maps to a documented extension seam.
- ✅ Forward-compat (R7) is structurally guaranteed by preserving alphabetical JSON ordering and not renaming v1 fields.
- ✅ No new install pipeline; no new HM module; no new deps tree.
- ❌ `opencode-cost-report.js` grows to ~3,500 LOC, which is at the upper end of "single-file is OK" — but v1's `Component-to-File Mapping` decision was explicit about single-file even at this scale, and v2 doesn't justify breaking that.
- ❌ Golden-file diff in the cutover PR will be large; reviewer needs to inspect carefully.

### Option B: Create New Binary Alongside v1 (REJECTED)

**Rationale**: Theoretically v2 could ship as `opencode-cost-report-v2` until v1 is deprecated.

**Trade-offs**:
- ❌ Directly contradicts the brief's explicit "drop-in replacement" requirement.
- ❌ Violates R1.AC3 ("only one diagnostic binary exists per host").
- ❌ Doubles install footprint; doubles maintenance burden during the deprecation window.
- ✅ Lower-risk cutover (operator can A/B compare reports).

**Verdict**: Not viable. The brief forbids it; R1 codifies the forbid.

### Option C: Hybrid (Partial extension + separate enrichment pass)

**Rationale**: Keep v1 untouched; ship a second binary `opencode-cost-report-enrich` that reads v1's JSON output and adds v2's columns.

**Trade-offs**:
- ❌ Adds operator workflow complexity (two commands instead of one).
- ❌ Cached-read decomposition fundamentally needs access to source `part` rows; reading v1's JSON is not enough. Forces re-reading the SQLite DB anyway.
- ❌ Pricing drift handling becomes two-step.
- ✅ Could be useful for a transitional period but does not survive the brief's drop-in mandate.

**Verdict**: Not recommended.

## Open Questions for Design Phase

### Open Question 1: Per-turn vs per-session model identity for pricing lookup

opencode persists model identity in two places:
- `session.model TEXT` (column 21) — the session's "primary" model
- `message.data.{providerID, modelID}` — per-message (verified per v1 research; needs design-phase confirmation of exact field names from a live message row)

**Question**: For per-bucket cost computation, does v2 key pricing by per-session model or per-message model?

- **Per-session** (simpler): assume one model per session. Wrong if a session changes models mid-stream (e.g., model fallback on failure).
- **Per-message** (more accurate): walk message rows, accumulate tokens × per-message rates. Matches the reality of opencode's `session.cost` computation which is per-turn.

**Recommendation**: Per-message, since per-turn `session.cost` is per-message-aware and the reconciliation invariant (R2.AC3) requires our per-bucket sum to match `session.cost`. Per-session approximation would systematically diverge during model fallbacks.

**Trade-off**: per-message adds a `message.data` JSON parse per turn (already happens for parts; trivial incremental cost).

### Open Question 2: cachedRead decomposition strategy

The cachedRead bucket contains content the operator wants split into:
- base system prompt
- AGENTS.md content
- MCP tool schemas
- accumulated conversation history
- accumulated tool outputs

opencode's part rows don't tell us which content was cached on which turn. Two approaches:

**Strategy A: Content-shape heuristic (preferred)**
- Walk system-role parts; split by structural markers within the text body:
  - MCP tool schemas: detect `"name":"hub_…"` JSON-schema-shaped blocks
  - AGENTS.md sections: detect the opencode-injected `# AGENTS.md` heading + path comment + the global `<env>` block boundary
  - base system prompt: the residual
- Walk user/assistant/tool parts chronologically; the proportional split of `tokens_cache_read` is divided across all such parts by tiktoken count.
- Sum-correctness: enforce that sub-buckets sum to cachedRead total.

**Strategy B: Allocate cachedRead by simple bucket proportions**
- Use the SAME proportional split tiktoken already does for uncached input. Apply the systemPrompt:history:toolOutput ratio to cachedRead too.
- Misses the AGENTS.md vs MCP schemas vs base system prompt distinction (lumps them into "systemPrompt cached"). Cheaper to implement.
- Three sub-buckets instead of five.

**Recommendation**: Strategy A. Strategy B doesn't actually answer the cost-driver questions the deferred specs need (e.g. `mcp-server-allowlist` trigger needs MCP-schema attribution specifically). Strategy A's heuristic is brittle but transparent; it inherits v1's "relative-only" accuracy class via the same disclaimer pattern.

**Trade-off**: Strategy A's marker detection is fragile — opencode could change its system-prompt assembly and break the heuristic silently. Mitigation: a `cachedRead_classification_drift` finding fires when the marker-detected portions don't sum to a reasonable fraction of the system-role text length.

### Open Question 3: `per_bucket_cost_deferred` finding removal vs R7.AC4

v1 emits `per_bucket_cost_deferred` on every session as the operator-facing reminder that per-bucket cost is null. v2 populates per-bucket cost; the finding's premise no longer holds. R7.AC4 says "shall not remove or rename existing findings."

**Resolution options**:
- **(a) Keep emitting the finding** but change its detail message to "per-bucket cost is now populated; this finding is retained for v1 forward-compatibility." Operator-confusing but R7-compliant.
- **(b) Stop emitting the finding** and treat R7.AC4 as having an implicit "unless the finding's precondition no longer applies" exception. Requires a requirements addendum or design-phase justification.
- **(c) Replace with a new finding** like `per_bucket_cost_populated` (carries the same key shape so JSON readers don't see field disappear, but operator sees the change is intentional).

**Recommendation**: (b). The finding's literal text is "per-bucket cost is deferred to a follow-on spec" — v2 IS that follow-on spec; emitting the finding from v2 is semantically incorrect. R7.AC4's spirit is "don't break consumers"; a finding that has factually become untrue is itself a break. Design phase should document the exception in design.md and surface the cutover in the migration disclaimer.

**Alternative if (b) is unacceptable**: (c) — replace, not remove. Same key shape, new name, accurate semantics.

### Open Question 4: Initial pricing source

The brief says "Source values from Anthropic's public docs at pin time." Concrete options:

- **(a) Manual hand-curate from <https://docs.anthropic.com/en/docs/about-claude/pricing>**: copy rates for each supported model; commit JSON. Simplest, transparent, brittle to format changes on Anthropic's page.
- **(b) Snapshot models.dev (the registry opencode itself uses internally)**: vendor a JSON pin from the models.dev npm package or its GitHub repo. Closes the loop: opencode's `session.cost` was computed against models.dev rates, so v2's per-bucket cost reconciliation will be more accurate. Adds an implicit dep on a third-party catalog.
- **(c) Compute pricing from `session.cost`**: back-derive rates from opencode's stored costs (cost / total_tokens_at_that_rate). Reflects exactly what opencode billed. Doesn't generalize to per-bucket because opencode's cost doesn't decompose per-bucket — circular.

**Recommendation**: (b) — vendor a models.dev snapshot. It's the source of truth opencode already uses, so reconciliation tolerance will be tight (likely <0.1%, well within the brief's 0.5% default). Pin metadata records `pinDate` + `pinSource: "models.dev@<commit-or-version>"`. Operator refreshes by bumping the pin.

**Trade-off**: implicit upstream dep on a community catalog (models.dev is maintained by Sourcegraph; same risk class as any vendored npm dep).

### Open Question 5: Cost-invariant tolerance default

Brief proposes 0.5% per session. Live cost data range: sessions span $0.10 to $128 (per the 2026-05-18T00:45 report). At $0.10, 0.5% = $0.0005 (likely below opencode's rounding granularity); at $128, 0.5% = $0.64 (probably acceptable noise floor).

**Design-phase decision**: pin 0.5% with two-direction tolerance, OR use a hybrid (max(0.5%, $0.01)) to handle low-cost sessions where percentage tolerance is below rounding. Surface in design.md.

### Open Question 6: Single-file vs split

v1's `opencode-cost-report.js` is 2,665 LOC. v2 adds an estimated 600-1000 LOC. At ~3,500 LOC, the single-file decision starts to feel costly for navigation, but the v1 design's Component-to-File Mapping explicitly chose single-file and Node's `require` ergonomics don't favor splitting mid-stream.

**Recommendation**: Keep single-file for v2. Revisit if v3 ever materializes. Mitigation: enforce class-level `// =====` section banners (already present in v1) to ease navigation.

## Effort and Risk

| Component | Effort | Risk | Justification |
| --- | --- | --- | --- |
| `PricingTable` class + JSON asset | S (1-2 days) | Low | Small new class; sourcing pricing is the open question, not the implementation |
| Per-bucket cost computation in AttributionEngine | S (1-2 days) | Low | Existing seam (`PER_BUCKET_COST_KEYS`); arithmetic is trivial |
| `cost_invariant_violation` finding + tolerance | S (0.5-1 day) | Low | New finding name; tolerance value pinned in design |
| `pricing_table_drift` finding + null fallback | S (0.5-1 day) | Low | Mirrors v1's null-valued forward-compat shape |
| cachedRead decomposition (TokenizerSplitter extension) | M (3-5 days) | Medium | Heuristic content classification; accuracy disclaimer; sum-correctness; residual handling |
| Per-tool decomposition | S (1-2 days) | Low | Small classifier extension; tool names are already in `part.data.name` |
| Per-agent-type decomposition (SubagentAggregator extension) | S (1-2 days) | Low | `session.agent` is a real column; trivial GROUP BY in JS |
| ReportAssembler aggregation extensions | S (1-2 days) | Low | Existing aggregation paths; new fields slot in alphabetically |
| ReportSerializer Markdown + JSON sections | S (1-2 days) | Low | Existing templating pattern |
| Disclaimer extension (cachedRead sub-buckets + pricing pin) | S (0.5-1 day) | Low | Existing disclaimer surface |
| Golden-file refresh + new tests | S (1-2 days) | Low | `UPDATE_GOLDEN=1` mechanic exists; new tests follow v1 pattern |
| Forward-compat enforcement (R7) | (No effort) | Low | Structural; covered by tests |

**Total v2 estimate**: **M, 10-15 days** end-to-end. Risk concentrated in:
- cachedRead decomposition heuristic accuracy (Medium)
- pricing source choice (Open Question 4; Medium until pinned, Low after)
- `per_bucket_cost_deferred` removal vs R7.AC4 (Open Question 3; resolvable in design)

## Recommendations for Design Phase

- **Approach**: Option A (Extend v1 in place). Brief-mandated, gap-validated.
- **Pricing source**: Recommend vendoring a `models.dev` snapshot (Open Question 4 option b) — closes the reconciliation loop with opencode's own cost computation.
- **Per-turn vs per-session model**: Recommend per-message (Open Question 1) — required for tight reconciliation tolerance.
- **cachedRead decomposition**: Recommend content-shape heuristic (Open Question 2 Strategy A) — required to satisfy the cost-driver questions the deferred specs need.
- **`per_bucket_cost_deferred` removal**: Recommend dropping the finding (Open Question 3 option b) with an explicit design.md note explaining the exception to R7.AC4.
- **Cost-invariant tolerance**: Recommend `max(0.5%, $0.01)` hybrid (Open Question 5) to handle the low-cost-session edge.
- **File layout**: Recommend keeping single-file (Open Question 6) with enforced section banners.

## Research Items to Carry Forward

1. **Confirm exact field names** for `message.data.providerID` and `message.data.modelID` against the live opencode DB. v1 research asserted them; verify with a `SELECT data FROM message WHERE session_id IS ... LIMIT 1` inspection in design phase.
2. **Confirm models.dev licensing** (Apache-2.0 expected; verify) and the snapshot-vs-runtime trade-off if the design picks Open Question 4 option b.
3. **Confirm the system-prompt assembly markers** in opencode's source for the cachedRead heuristic (Strategy A). Specifically: does opencode wrap AGENTS.md with consistent boundary markers? Are MCP tool schemas always emitted in the same JSON shape?
4. **Verify `session.data` JSON shape** for descendant sessions to confirm `agent` field is present (column 20 confirms it on the row; need to check it's populated on descendant rows specifically, not just root sessions).
5. **Decide the per-tool name normalization policy**: do we group `hub_observe_list_traces` and `hub_observe_get_trace` under "observe", or report them separately? Design-phase call. Recommendation: report separately, since the deferred `rtk-install` and `tool-output-compressor` specs need tool-level granularity.

## Out-of-Scope for This Gap Analysis

- Operator-visible UX for refreshing the pricing pin (covered in design.md when Open Question 4 resolves).
- Smoke-test extensions for v2 (the existing `opencode-cost-diagnosis-smoke-test.nix` covers v1 invariants; v2 may add a pricing-pin-freshness check but that's design-scope).
- Multi-currency / contract pricing (explicitly out per requirements Boundary Context).
- Cross-host data merge (explicitly out per v1 + v2 Boundary Context).

---

# Gap Analysis: v2-diagnosis — Round 2 (Live Verification)

Generated: 2026-05-18

Round 2 supplements Round 1 by **verifying with live data** the four
items Round 1 flagged as "Research Items to Carry Forward." Three of
the six Open Questions from Round 1 are resolved here with hard
evidence; two are refined with new constraints; one (cachedRead
classifier markers) remains design-phase work but with a sharper
specification of what needs to be verified.

## Live evidence collected

All evidence below was collected by direct query of the operator's
live opencode SQLite DB at
`~/.local/share/opencode/opencode-stable.db` and direct fetch of the
models.dev project page.

### Evidence A — assistant `message.data` shape (resolves Open Question 1)

A single query of one assistant-role message with `cost` populated
returned the following top-level keys:

```
['agent', 'cost', 'error', 'mode', 'modelID', 'parentID', 'path',
 'providerID', 'role', 'time', 'tokens', 'variant']
```

with `tokens` containing `{cache, input, output, reasoning}`.

**Implications**:

- v1's research was correct: assistant messages DO carry `providerID`
  and `modelID` at the top level of `message.data`. v2 keys pricing
  by per-message `(providerID, modelID)`.
- A `variant` field is also present per-message (e.g. `"default"`,
  `"max"`, `"xhigh"`). This was not anticipated in Round 1 and
  introduces a new pricing-key dimension (see Open Question 7 below).
- A per-message `agent` field exists (separate from `session.agent`).
  Round 2 does not investigate whether these ever diverge within a
  session; design phase decides whether to use message-level or
  session-level agent for the per-agent-type rollup. Recommendation
  below.
- The opencode-stored per-message `cost` field is the AUTHORITATIVE
  reconciliation target at message granularity, not just session
  granularity. v2's per-bucket sum could be reconciled per-message
  instead of per-session for tighter tolerance.

### Evidence B — `session.model` is JSON, not a string (NEW Open Question 7)

The session table's `model TEXT` column holds JSON, not a bare model
name. A live aggregate query returns:

```
{"id":"claude-opus-4-7","providerID":"anthropic","variant":"default"} | 216 sessions
{"id":"claude-opus-4-7","providerID":"anthropic","variant":"max"}     |  18 sessions
{"id":"claude-sonnet-4-5","providerID":"anthropic","variant":"default"}|  4 sessions
{"id":"gpt-5.5-pro","providerID":"openai","variant":"xhigh"}          |   1 session
```

**Implications**:

- The session-level "primary" model is structured and includes the
  variant. v2 can read it as a fallback when message-level model is
  absent on older messages.
- Multi-model sessions exist: 5 sessions in the live history had 2-3
  distinct `modelID` values across messages. Per-message lookup is
  required for accurate reconciliation on those sessions, confirming
  Round 1's recommendation.
- Variants (`default`, `max`, `xhigh`) likely correspond to
  Anthropic-Max / OpenAI-reasoning-effort tiers. models.dev's schema
  does NOT include variant-level pricing — it's per-(provider,
  model) only. This is **the new gap**; see Open Question 7.

### Evidence C — `session.agent` distribution on descendants (refines Open Question 5)

Aggregate of the 565 descendant sessions in the live history:

```
agent IS NULL : 345  (61%)
agent SET     : 220  (39%)
   - 'general'         : 210
   - 'vault-synthesizer':   4
   - 'explore'         :   4
   - 'yb-sleuth'       :   2
```

Joined with parent session to disambiguate continuation-vs-dispatch:

```
child_agent  parent_agent  count
(null)       (null)         274   ← continuations / pre-attribution era
'general'    'build'        210   ← the dominant subagent dispatch
(null)       'build'         71   ← unattributed dispatches from build sessions
'explore'    'build'          4
'vault-synthesizer' 'build'   4
'yb-sleuth'  'build'          2
```

**Implications**:

- The 274 NULL/NULL pairs are almost certainly NOT subagent
  dispatches but continuation sessions from before opencode tracked
  agent attribution. The Subagent Aggregator can either include or
  exclude these from per-agent rollup; design phase decides.
- Of TRUE subagent dispatches (parent has an agent), `'general'`
  dominates (74%), unattributed (NULL with build parent) is second
  (25%), named subagents are <1% combined.
- **The (none)/(unattributed) bucket is NOT an edge case** — it's
  the second-largest. v2's residual handling needs to surface it
  prominently with a distinct label rather than burying it; this
  may also surface a finding so the operator knows whether it's
  pre-attribution-era data or a current bug.
- The downstream `subagent-context-budget` spec's "trim general"
  hypothesis is empirically supported: ~98% of attributable
  subagent dispatches go to `general` or are unattributed; trimming
  general's context is the highest-leverage intervention.

### Evidence D — models.dev (resolves Open Question 4)

GitHub repo `anomalyco/models.dev` confirmed:

- **MIT licensed.**
- **Used internally by opencode itself** for cost computation (per
  the repo README: "We also use it internally in opencode").
- **JSON API**: `curl https://models.dev/api.json` returns the full
  catalog as a single JSON document. Suitable for snapshot vendoring.
- **TOML source of truth** in the repo's `providers/<provider>/`
  tree with the schema below.
- **3.8k stars, 87 open issues, 130 PRs** — actively maintained.

The TOML schema for each model includes:

```
[cost]
input       = 3.00   # per million input tokens (USD)
output      = 15.00  # per million output tokens
reasoning   = 15.00  # per million reasoning tokens
cache_read  = 0.30   # per million cache-read tokens
cache_write = 3.75   # per million cache-write tokens
input_audio  = ...
output_audio = ...
```

**Implications**:

- models.dev exposes **exactly the cost fields v2 needs**, with the
  exact bucket shapes (input / output / reasoning / cache_read /
  cache_write) v1's `BUCKET_TOTAL_KEYS` already aligns to.
- Because opencode computes `session.cost` against these same
  values, v2's per-bucket reconciliation should be very tight — the
  cost-invariant tolerance (Open Question 5 in Round 1) likely
  needs to absorb only opencode's own rounding, not pricing
  divergence. Recommend default tolerance can probably be tighter
  than the brief's 0.5% — perhaps 0.1% — and the floor `$0.01`
  becomes the dominant constraint at low-cost sessions.
- Variant pricing (max, xhigh) is NOT covered by models.dev. See
  Open Question 7.

### Evidence E — opencode source for system-prompt assembly markers

GitHub URL fetches for `sst/opencode` returned non-2xx (the dev branch
file path doesn't match what I guessed). The repo itself exists at
`anomalyco/opencode` with branches `dev` + tagged releases (latest
v1.15.4 as of fetch). The system-prompt assembly source was not
located in this Round 2 pass.

**Status**: still unverified. Design phase must read the locally-
installed opencode binary's bundled prompts (via `nix path-info
github:anomalyco/opencode#opencode` + grep) OR clone the repo
locally and grep for the prompt-assembly site. This is the only
Round-1 research item that survives Round 2 unresolved.

## Updated Open Question Status

| Open Question | Round 1 Status | Round 2 Status |
| --- | --- | --- |
| Q1: Per-turn vs per-session model identity | Recommended per-message | **RESOLVED** — per-message confirmed feasible (top-level `providerID` / `modelID` on assistant messages). Multi-model sessions exist (5 in live history). Per-message required. |
| Q2: cachedRead decomposition strategy | Recommended Strategy A | **REFINED** — strategy unchanged, but the system-prompt-assembly markers (Strategy A heuristic) require reading opencode upstream source in design phase. Brief: locate the AGENTS.md inject site + MCP-schema emit site in opencode's session-prompt builder. |
| Q3: `per_bucket_cost_deferred` finding removal vs R7.AC4 | Recommended drop with design note | Unchanged. |
| Q4: Initial pricing source | Recommended models.dev (option b) | **RESOLVED** — models.dev is MIT-licensed, used by opencode itself, has a single JSON API, and ships the exact bucket-aligned cost schema v2 needs. Vendor `https://models.dev/api.json` snapshot. |
| Q5: Cost-invariant tolerance default | Recommended `max(0.5%, $0.01)` | **REFINED** — given Evidence D's "opencode uses the same source," tolerance can probably be 0.1% with a $0.01 floor. Brief's 0.5% remains a safe default; tighten in design after measuring against live reports. |
| Q6: Single-file vs split | Recommended single-file | Unchanged. |

## NEW Open Question 7: Variant pricing

`session.model.variant` and `message.data.variant` carry tier
information (`default`, `max`, `xhigh`). models.dev's catalog does
not include variant-level pricing. Variants likely change effective
rates: Anthropic's Max plan and OpenAI's `xhigh` reasoning effort
both have different effective billing than `default`.

**Options for design phase**:

- **(a) Variant-blind pricing**: ignore variant; use the base
  `cost.{input, output, cache_read, cache_write}` from models.dev.
  Reconciliation tolerance absorbs the discrepancy via
  `cost_invariant_violation` findings on Max-plan sessions.
- **(b) Static variant multipliers**: ship a small lookup table
  alongside the models.dev snapshot mapping variants to
  multipliers (e.g. `{max: 1.0, xhigh: 1.2}`). Operator-tunable.
- **(c) Back-derive from `session.cost`**: for any session whose
  per-bucket sum diverges from `session.cost` beyond tolerance,
  scale all per-bucket fields proportionally so they sum to the
  authoritative total. Variant becomes invisible in the report but
  costs reconcile.

**Recommendation**: (a) initially with `cost_invariant_violation`
surfacing the gap, so the operator can see WHICH sessions are
variant-affected. If the gap is small (<2%) in practice, leave as-is.
If large, escalate to (b).

**Trade-off**: (a) loses fidelity on Max-plan sessions (18 out of
243 live sessions, ~7%). Operator-visible in findings.

## NEW Open Question 8: Per-message vs per-session agent for rollup

`message.data.agent` (per-message) and `session.agent` (per-session)
both exist. Round 2 evidence shows the message-level field exists
but Round 2 did NOT investigate whether they diverge in practice.

**Options for design phase**:

- **(a) Use `session.agent` as the rollup key.** Mirrors v1's
  conceptual model: one subagent dispatch = one child session = one
  agent type. Trivially queryable from the existing `SELECT *`.
- **(b) Use the modal `message.data.agent` for each session.**
  Defensive against edge cases where session.agent is NULL but
  individual messages carry the agent type.
- **(c) Use both**: agent type is `session.agent` if present, else
  the modal `message.data.agent` across that session's assistant
  messages. Eliminates the NULL bucket as a separate category.

**Recommendation**: (a) for v2 first pass, but emit a finding
when `session.agent IS NULL` AND any of that session's
`message.data.agent` is non-null — this surfaces the 71
NULL-but-build-parent cases as fixable rather than as an opaque
residual.

## Refined Effort and Risk

| Component | Round 1 estimate | Round 2 revised | Why |
| --- | --- | --- | --- |
| `PricingTable` class + JSON asset | S (1-2 days) | **XS (0.5-1 day)** | models.dev gives us the exact schema; the class is a `JSON.parse` + a `Map.get` |
| Per-bucket cost computation in AttributionEngine | S (1-2 days) | Unchanged | Trivial arithmetic; per-message identity confirmed reachable |
| `cost_invariant_violation` + tolerance | S (0.5-1 day) | Unchanged |  |
| `pricing_table_drift` + null fallback | S (0.5-1 day) | Unchanged |  |
| cachedRead decomposition | M (3-5 days) | Unchanged | Still the dominant risk; opencode source-marker verification deferred to design |
| Per-tool decomposition | S (1-2 days) | Unchanged |  |
| Per-agent-type decomposition | S (1-2 days) | **S (1 day)** | `session.agent` column confirmed populated for the 39% of descendants where it's set; SubagentAggregator extension is mechanical |
| ReportAssembler aggregation extensions | S (1-2 days) | Unchanged |  |
| ReportSerializer Markdown + JSON sections | S (1-2 days) | **S (1-2 days)** | Need to add a NEW pricing-pin disclaimer block + the agent residual finding wording |
| Disclaimer extension | S (0.5-1 day) | **S (0.5-1 day)** | Now two new blocks (cachedRead sub-buckets AND pricing pin) instead of one |
| Variant pricing handling (NEW) | — | **S (0.5-1 day)** | Option (a) is essentially free; just don't pivot on variant |
| Golden-file refresh + new tests | S (1-2 days) | **M (2-3 days)** | More new fields means more golden surface to refresh; need to verify per-message reconciliation on multi-model fixtures |
| Forward-compat enforcement (R7) | (No effort) | Unchanged |  |

**Revised total**: **M, 9-13 days** end-to-end (was 10-15 in Round 1).
The reduction is mostly due to models.dev simplifying Open Question 4
and `session.agent` being a real column for Q5.

**Risk register**:

- **Medium**: cachedRead decomposition heuristic (unchanged from
  Round 1).
- **Low-Medium**: variant pricing accuracy on Max-plan sessions
  (~7% of sessions; option (a) surfaces via findings).
- **Low**: opencode upstream source-marker stability for Strategy A
  (mitigated by classification-residual finding when markers don't
  match).

## Refined Recommendations

- **Pricing**: vendor a `https://models.dev/api.json` snapshot at
  pin time, committed at `scripts/opencode-cost-report-pricing.json`.
  Pin metadata records `pinDate` + `pinSource:
  "https://models.dev/api.json"` + the api response's own version
  field if present.
- **Per-message identity**: pricing keyed by
  `message.data.{providerID, modelID}`; fall back to
  `session.model.{providerID, id}` if the message field is absent.
- **Variant handling**: implement Option (a) (variant-blind) in v2;
  surface the gap via `cost_invariant_violation`. Revisit in a
  follow-on if Max-plan sessions show systematic
  reconciliation drift.
- **Per-agent rollup**: use `session.agent` (Option 8a), surface a
  finding when session.agent is NULL but message-level agents exist.
- **Cost-invariant tolerance**: start with `max(0.1%, $0.01)`,
  not the brief's 0.5%. Live test against current report data; widen
  only if false-positive findings flood the output.
- **Design-phase verification still required**: opencode upstream
  system-prompt assembly markers (for Strategy A cachedRead
  classifier). Concrete approach: `nix shell github:anomalyco/opencode --command sh -c 'find $(dirname $(which opencode)) -name "*.js" | xargs grep -l "system\\.prompt\\|systemPrompt"'`
  or clone the repo and grep `packages/opencode/src/` for the
  prompt builder.

## Resolved → Carried Forward → New (Net Status)

| Item | Status |
| --- | --- |
| message.data field locations for providerID/modelID | **Resolved** — top-level on assistant messages |
| session.agent populated on descendants | **Resolved with caveat** — yes but NULL is 61% of descendants; design needs a residual strategy |
| models.dev licensing + mechanics | **Resolved** — MIT, JSON API, exact schema match |
| opencode system-prompt assembly markers | **Carried forward** to design phase |
| Variant pricing | **NEW Open Question 7** |
| Per-message vs per-session agent rollup | **NEW Open Question 8** |
| Per-tool name normalization | Unchanged (design-phase call) |

---

# Design Phase Synthesis and Decisions

Generated: 2026-05-18 (during `/kiro-spec-design v2-diagnosis -y`)

This section records the Step-3 synthesis outcomes and the design-phase
verification of v1 extension seams. It supplements Rounds 1 and 2 above
and is the canonical link between this research log and `design.md`.

## Code-Level Verification of v1 Extension Seams

Before drafting `design.md`, the design phase ran a targeted explore
sub-agent against the live v1 codebase to confirm the specific class,
method, and line-level extension points the gap analysis identified.
Key findings that shaped the design beyond what Rounds 1-2 surfaced:

### No `// =====` section banners in v1

The Round 1 analysis suggested using existing section banners as v2
navigation anchors. The live code has none. v1 uses JSDoc `/* --- */`
block comments above each class declaration plus the class declaration
itself. Design phase decision: use class names + JSDoc blocks as
navigation anchors; do NOT introduce banner-style markers in v2
(unnecessary scope expansion).

### Cost shape ≠ token shape in v1

v1's `PER_BUCKET_COST_KEYS` (line 1471-1478) carries 6 keys with the
three uncached sub-buckets collapsed into a single `uncachedInput`
field. v1's `BUCKET_TOTAL_KEYS` (line 1456-1465) carries 8 keys with
the three uncached sub-buckets exploded (`uncachedSystemPrompt`,
`history`, `toolOutputs`).

Design implication: v2 must add the three uncached cost sub-buckets
*alongside* (not in place of) v1's `uncachedInput`, because R7.AC1
forbids field removal. The v2 `CostBuckets` shape is:

```
cost: {
  total, cachedRead, cachedWrite,
  uncachedInput,                              // v1, preserved
  uncachedSystemPrompt, history, toolOutputs, // v2 additions
  output, reasoning, subagentDispatch,
  cachedReadBreakdown: {...},                 // v2 nested
  subagentDispatchByAgent: {...},             // v2 nested
  toolOutputsByTool: {...},                   // v2 nested
}
```

The invariant `uncachedInput ≈ uncachedSystemPrompt + history +
toolOutputs` holds within rounding (Flow 2 pattern).

### Tool name is in `part.data.name`, currently unread

The v1 tokenizer reads `part.data.state.output` for tool parts but
never accesses `part.data.name`. The per-tool decomposition (R6) adds
this field-extraction; defensive handling for null/missing names folds
into a `(unknown-tool)` residual.

### `session.agent` already on every descendant row

The `SqliteReader.descendantSessionsOf` query does `SELECT *` on every
descendant. The `agent` field is column 20 (TEXT). `SubagentAggregator`
currently does not read it; the v2 extension is to group by `agent` in
the rollup. Zero new SQL.

### Naming inconsistency: `toolOutput` vs `toolOutputs`

The tokenizer return field is `toolOutput` (singular, line 805); every
downstream consumer uses `toolOutputs` (plural). v2 design keeps the
v1 names verbatim (renaming would violate R7.AC1); the per-tool
extension uses `byTool` with cached/uncached partition.

### `generatedAt` is in Markdown only, not JSON (load-bearing)

Confirmed at lines 1731 and 1862. This asymmetry is what enables the
byte-identical JSON determinism invariant (R7.AC2). v2's pricing pin
metadata (`pinDate`, `pinSource`, `pinVersion`) is included in JSON
because those are deterministic per-pin values, not wall-clock.

## Design Synthesis: Generalization

Three of v2's requirements (R4 cachedRead, R5 subagentDispatch, R6
toolOutputs) are variations of the same underlying problem: "decompose
a bucket B by some dimension D into sub-buckets that sum exactly to B,
with the last sub-bucket absorbing rounding."

Decision: generalize the **interface** but not the **implementation**.
A small shared helper at the AttributionEngine layer (conceptually,
`absorbRoundingInLastKey(perKeyTokens, total)` returning a Map) is
sufficient. Each requirement's classification logic is genuinely
different (content-shape heuristics for cachedRead, simple groupby for
subagent and per-tool) and does not benefit from a shared
`BucketDecomposer` class hierarchy.

The shared interface point is **sum-correctness** with last-bucket
absorbing rounding — already proven in v1 Flow 2 at lines 929-981.

## Design Synthesis: Build vs Adopt

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Pricing data source | ADOPT `models.dev` snapshot | MIT-licensed, used by opencode internally, exact bucket-aligned schema match (Round 2 Evidence D) |
| Pricing wrapper | BUILD `PricingTable` class (~50 LOC) | No existing wrapper handles the v2 drift-fallback semantics (R3.4) |
| Tokenization | ADOPT (no change): `tiktoken@^1.0.22` + `cl100k_base` | Already in v1 deps; relative-only accuracy class is acceptable for v2 |
| SQLite reading | ADOPT (no change): `better-sqlite3@12.10.0` | Already pinned in v1's overlay |
| File output, pruning, mode | ADOPT (no change): v1's `FileWriter` | No behavior change; R1.4 / R1.5 require preserving v1 behavior |
| Test harness | ADOPT (no change): existing `UPDATE_GOLDEN=1` mechanic at `_helpers.js:213` | Already mature; v2 only refreshes existing goldens and adds new fixtures |

**No new npm dependencies.** The vendored deps tree at
`overlays/opencode-cost-diagnosis-deps/package.json` is unchanged.

## Design Synthesis: Simplification

The smallest design satisfying all 7 requirements:

- **Single-file** v1+v2 codebase (per brief mandate + Open Question 6).
- **No `BucketDecomposer` class hierarchy** — implement sum-correctness
  via a small helper function. Single-call-site usage in three places.
- **No variant pricing tables** (Decision 2: variant-blind, surface
  via `cost_invariant_violation` for Max-plan sessions).
- **No per-message agent attribution** (Decision: session.agent only;
  surface drift via `subagent_agent_attribution_drift` finding).
- **No per-tool name normalization** (report tool names verbatim; the
  deferred specs `rtk-install` and `tool-output-compressor` need
  granularity, not aggregation).
- **No single-source-of-truth refactor** for the schema-pin constants
  (current shared discipline between JS and the smoke-test Nix file
  is acceptable for v2 scope; explicit follow-on).
- **No new HM module options** — the existing
  `programs.opencode-cost-diagnosis.package` option is opaque to the
  derivation's internals.

## Final Design Decisions

| Issue | Decision | Documented in design.md as |
|-------|----------|---------------------------|
| `per_bucket_cost_deferred` finding (R7.AC4 tension) | **Preserve kind code, rewrite detail string**. v2 continues to emit the finding per session; the detail string explains the rewritten v2 meaning. R7.AC4 satisfied literally. | Open Decisions §1 |
| Variant pricing | **Variant-blind** (Option 7a). Surface gap via `cost_invariant_violation` for Max-plan sessions (~7%). | Open Decisions §2 |
| Per-message vs per-session pricing lookup | **Per-message** (`message.data.providerID, modelID`). Required for tight reconciliation on multi-model sessions (5 in live history). | Open Decisions §3 |
| cachedRead decomposition strategy | **Strategy A** (content-shape heuristic), 5 sub-buckets + 1 residual. Residual + `cached_read_classification_residual` finding when >5% mitigates marker drift. | Open Decisions §4 |
| Cost-invariant tolerance | **`max(0.1%, $0.01)`** per session. Tighter than brief's 0.5% because models.dev = opencode's own catalog. | AttributionEngine §Implementation Notes |
| Per-agent rollup key | **`session.agent`** (Option 8a). Surface drift via `subagent_agent_attribution_drift` when `session.agent IS NULL` but `message.data.agent IS NOT NULL`. | SubagentAggregator §Responsibilities |
| Per-tool name normalization | **No normalization** — report tool names verbatim. | TokenizerSplitter §Postconditions |
| Schema-pin single source-of-truth | **Deferred to follow-on**; v2 keeps the current JS-and-Nix duplication with manual-discipline sync. | Open Decisions §5 |
| opencode system-prompt assembly markers | **Implementation-time verification** required before cachedRead classifier lands. Fallback: degrade Strategy A to 2-bucket split + residual if markers prove unreliable. | Open Decisions §6 |
| Single-file vs split | **Single-file** maintained per brief mandate + Open Question 6. ~3,500 LOC end state. | Architecture §Existing Architecture Analysis |

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| cachedRead content-shape markers prove unreliable in opencode upstream | Medium | Implementation-time verification before classifier lands. Fallback: degrade to 2-bucket split + residual. The `cached_read_classification_residual` finding makes drift loud. |
| Max-plan sessions show systematic cost-invariant tolerance violations | Low-Medium | Surfaces via `cost_invariant_violation` findings; ~7% of live sessions affected. Follow-on can add variant multipliers if pattern proves stable. |
| Per-tool name dimension silently degrades if opencode changes `part.data.name` shape | Low | Defensive `(unknown-tool)` residual. Smoke test asserts at least one tool part has a non-null `data.name`. |
| `per_bucket_cost_deferred` rewritten body is operator-confusing during migration | Low | One-time migration disclaimer line in Markdown disclaimer block; removed in follow-up commit after cutover. |
| Single-file growth to ~3,500 LOC reduces navigability | Low | v1's JSDoc `/* --- */` blocks above each class are preserved; v2 follows the same convention. A split-into-modules refactor is an explicit follow-on. |
| Golden refresh diff is large in the migration PR | Low | v1 goldens preserved side-by-side under `fixture-365d-all-v1.{md,json}` for review; removed in follow-up commit after merge. |

## References (Design Phase Additions)

- `/Users/brandonmcnama/src/github.com/DWSR/nix-config/scripts/opencode-cost-report.js` — line-level reference points captured in Code-Level Verification above.
- `/Users/brandonmcnama/src/github.com/DWSR/nix-config/.kiro/specs/v2-diagnosis/design.md` — the v2 design generated from this research.
- `https://models.dev/api.json` — pricing source pin reference.

# Marker Verification Results (Decision 6 — Implementation-Time Round)

This section closes Decision 6's pre-implementation gate: each of the five
cachedRead sub-buckets plus the residual is classified against opencode
upstream source so the classifier-logic task knows whether Strategy A or
the degraded fallback ships. Round 2 left Evidence E unresolved; this
round resolves it by cloning the upstream source and grepping the
prompt-assembly path.

## Verdict

**Degraded fallback path ships.** Three of the five named sub-buckets
(`systemPromptCached`, `agentsMdCached`, `mcpToolSchemasCached`) are
`marker-unreliable` because their content is **not persisted as part
rows** in opencode's session DB — opencode constructs system-role
content (provider prompt + env block + AGENTS.md + skills) per turn at
request time, and emits MCP tool schemas as a structured `tools`
parameter on the `streamText` call, never as text in any part row.
Only `accumulatedHistoryCached` and `accumulatedToolOutputsCached` have
reliable signals in the parts table, and even those are `inferred-marker`
(structural part-type / role patterns, not literal opencode-emitted
header strings).

Per design.md Decision 6, `AttributionEngine` must therefore set
`markersDegraded: true` on every session's `TokenizerProvenance` output
and apportion `session.tokens_cache_read` across the five named
sub-buckets via the proportional-from-uncached split
(`systemPrompt : history : toolOutput` ratio from the uncached side,
with `agentsMdCached` and `mcpToolSchemasCached` carrying `0`). The
`cached_read_classifier_degraded` finding fires per session, naming the
three failed markers and the ratios used. R4.AC1's "at minimum five
named sub-buckets" requirement is satisfied: every named sub-bucket
remains present in the report at every aggregation level, with two of
them explicitly zero.

## Source location

- Cloned `github.com/anomalyco/opencode` (default branch) into
  `/private/var/folders/q7/.../T/opencode/opencode-src` and grepped
  `packages/opencode/src/session/` for the prompt-assembly path.
- The installed Nix-store `opencode-1.14.50` ships as a compiled
  Mach-O binary at
  `/nix/store/6zssjsyrchcdl2gl8qfkh903rhk04jbf-opencode-1.14.50/bin/.opencode-wrapped`,
  so the upstream source is the only readable surface for marker
  verification (the installed binary cannot be grep'd for `*.js`
  symbols — there are none).
- Prompt assembly entry point: `packages/opencode/src/session/prompt.ts`
  lines 1812-1818 build the per-turn `system: string[]` from three
  effects:
  - `sys.environment(model)` — env block (`session/system.ts:51-63`)
  - `instruction.system()` — AGENTS.md and other instruction files
    (`session/instruction.ts:154-167`)
  - `sys.skills(agent)` — skill catalog (`session/system.ts:67-77`)
- `packages/opencode/src/session/llm.ts` lines 103-115 prepend the
  base provider prompt (`SystemPrompt.provider(input.model)` →
  `session/prompt/anthropic.txt | default.txt | gpt.txt | gemini.txt |
  ...`) and then sends the joined array as system-role `ModelMessage`
  entries (lines 152-159), with `tools: sortedTools` as the structured
  parameter on the streamText call (line 357).
- Critically: none of `sys.environment`, `instruction.system`,
  `sys.skills`, or the provider prompts are persisted as `messages`
  rows in opencode's session DB. They are reconstructed per turn at
  request time. The diagnostic's `SqliteReader.partsOfSession` walker
  never sees them.

## Per-sub-bucket classification

### `systemPromptCached`

- **Classification**: `marker-unreliable`
- **Content shape upstream**: `packages/opencode/src/session/system.ts`
  emits exact literal strings:
  - Provider prompts begin with `You are ` (anthropic.txt:
    `"You are OpenCode, the best coding agent on the planet."`;
    default.txt: `"You are opencode, an interactive CLI tool..."`;
    gpt.txt: `"You are OpenCode, You and the user share..."`;
    gemini.txt: `"You are opencode, an interactive CLI agent..."`).
  - Env block: `"You are powered by the model named ${model.api.id}.
    The exact model ID is ${model.providerID}/${model.api.id}"` then
    `"Here is some useful information about the environment you are
    running in:"` then `"<env>"` block
    (`session/system.ts:51-63`).
  - Skills block:
    `"Skills provide specialized instructions and workflows for
    specific tasks."` then
    `"Use the skill tool to load a skill when a task matches its
    description."` (`session/system.ts:67-77`).
- **Source path(s)**:
  `packages/opencode/src/session/system.ts:51-77`,
  `packages/opencode/src/session/prompt/*.txt`,
  `packages/opencode/src/session/llm.ts:103-115`.
- **Rationale**: The literal markers DO exist upstream and are stable
  across opencode versions, but the content they demarcate is never
  persisted as a part row in the opencode session DB the diagnostic
  reads. The diagnostic's parts walker has no access to this content
  and therefore cannot count its tokens or attribute it. Even though
  the marker strings are unambiguous, the marker is unreliable for
  the design's parts-walking architecture because the corresponding
  bytes simply are not present in the data structure being walked.
  An alternative architecture that reads `session/prompt/*.txt` from
  the upstream source plus re-runs the per-turn env / skills
  construction at report-run time could measure it — but that is
  out-of-scope per the design's parts-only seam.

### `agentsMdCached`

- **Classification**: `marker-unreliable`
- **Content shape upstream**: `packages/opencode/src/session/instruction.ts`
  lines 159-160 emit each instruction file as
  `` `Instructions from: ${item}\n${files[i]}` `` (one literal
  `Instructions from: <absolute-path>` header per file before its
  contents). The same prefix appears in `resolve()` for nested
  AGENTS.md attachment at line 205, and for HTTP-URL instructions at
  the URL emit path. Files matched: `AGENTS.md`, `CLAUDE.md` (unless
  `disableClaudeCodePrompt` flag is set), `CONTEXT.md` (deprecated),
  plus any user-configured `instructions` glob.
- **Source path(s)**:
  `packages/opencode/src/session/instruction.ts:14-18` (file list),
  `packages/opencode/src/session/instruction.ts:154-167` (system()
  method), `packages/opencode/src/session/prompt.ts:1815-1818`
  (consumed into the system array).
- **Rationale**: Same root cause as `systemPromptCached` — the
  `Instructions from: ` header is an exact, stable literal, but the
  rendered string is constructed per turn and concatenated into the
  ephemeral `system: string[]` that goes directly to the streamText
  call. It is never persisted as a `parts.data` row. The diagnostic
  could approximate AGENTS.md token count by reading the AGENTS.md
  file from the filesystem at report-run time, but that is a
  different architecture from the parts-walking seam the design
  specifies, and it would also miss the env / skills / provider
  prompt portions that are part of the same uncached system block.

### `mcpToolSchemasCached`

- **Classification**: `marker-unreliable`
- **Content shape upstream**: Tools are emitted as a **structured
  API parameter**, not as text. The relevant emit point is
  `packages/opencode/src/session/llm.ts:357` where
  `streamText({ ..., tools: sortedTools, ... })` is called with a
  Record mapping tool names to their `inputSchema` JSON-schema
  objects. Anthropic counts the JSON-serialized representation of
  this `tools` parameter as part of the cached prefix when prompt
  caching is enabled, but no text in any message body or any part
  row carries it.
- **Source path(s)**:
  `packages/opencode/src/session/llm.ts:195-216` (tools resolution and
  sorting), `packages/opencode/src/session/llm.ts:357` (emit). No
  marker in any message or part — the schemas live entirely in the
  `tools` parameter of the streamText call.
- **Rationale**: Not a marker-text problem at all; a structural
  problem. The diagnostic walks part rows and tokenizes their `data`
  payloads. MCP tool schemas never enter that data structure — they
  are transmitted as a separate field in the API request body. No
  amount of grepping for header strings would surface them. The only
  way to measure MCP schema token contribution would be to snapshot
  opencode's registered tool set at report-run time and tiktoken-count
  the JSON-serialized schemas — which is a different architecture
  from the design's parts walker.

### `accumulatedHistoryCached`

- **Classification**: `inferred-marker`
- **Content shape upstream**: Prior user and assistant messages are
  persisted to opencode's `messages` table with stable role values.
  The structural pattern that identifies history content is:
  `messages.get(part.message_id).role ∈ {"user", "assistant"}` AND
  `part.type ∈ {"text", "reasoning"}` (the reasoning case being
  assistant chain-of-thought that DOES get cached on subsequent
  turns).
- **Source path(s)**: `packages/opencode/src/session/message-v2.ts:692-758`
  (user message conversion), `:741-873` (assistant message conversion).
  Part-type schema literals: `Schema.Literal("text")` at lines 61, 99,
  398; `Schema.Literal("reasoning")` at line 115. v1's classifier
  already keys off the same pattern at
  `scripts/opencode-cost-report.js:599-602`.
- **Rationale**: No literal opencode-emitted header string demarcates
  the start of "history" within the cached prefix — opencode does NOT
  prepend a `## HISTORY` marker or similar. Classification relies on
  the structural pattern (`role`, `type`) which is load-bearing in
  opencode's own message construction code and therefore stable. This
  is the closest to a reliable signal among the five, but classifies
  via shape rather than literal text, hence `inferred-marker`.

### `accumulatedToolOutputsCached`

- **Classification**: `inferred-marker`
- **Content shape upstream**: Tool result content is persisted in
  parts with `part.type === "tool"` (per the v2 schema literal at
  `packages/opencode/src/session/message-v2.ts:312`). The classifier
  reads `part.data.state.output` for the body text; compacted entries
  contain the literal string `"[Old tool result content cleared]"`
  (`packages/opencode/src/session/message-v2.ts:790-791`). At
  serialization time these parts are converted to AI-SDK
  `tool-${name}` part types
  (`packages/opencode/src/session/message-v2.ts:812-820`).
- **Source path(s)**:
  `packages/opencode/src/session/message-v2.ts:312` (Schema literal),
  `:787-857` (assistant-turn tool-part processing). v1 classifier:
  `scripts/opencode-cost-report.js:603-604`,
  `scripts/opencode-cost-report.js:769-771` (tiktoken-encoding
  `part.data.state.output`).
- **Rationale**: Like history, classification is via the part-type
  schema literal `"tool"` rather than via a literal opencode-emitted
  header string. The schema literal is load-bearing in opencode's
  message-v2 module (the entire tool-call flow keys off it) and is
  therefore stable. The `"[Old tool result content cleared]"`
  compaction marker is a useful sub-signal but is conditional — it
  only fires when the tool result has been compacted, so it cannot
  carry the bucket on its own.

### `unclassifiedCached` (residual)

- **Classification**: not a marker — residual bucket per R4.AC5
- **Rationale**: Any cachedRead token that the classifier cannot
  attribute to one of the five named sub-buckets above is folded into
  this residual. Under the degraded fallback path the residual
  absorbs the rounding error from the proportional split (last
  bucket absorbs rounding, mirroring v1 Flow 2 pattern). When the
  residual / total ratio exceeds 5%, the
  `cached_read_classification_residual` finding fires per the design's
  contract.

## Implications for design and tasks

- **AttributionEngine wiring**: the implementation MUST default to
  the degraded fallback. The classifier task should set
  `markersDegraded: true` unconditionally on every TokenizerProvenance
  output, populate `agentsMdCached` and `mcpToolSchemasCached` as `0`,
  and apportion the other three from the uncached
  `systemPrompt : history : toolOutput` ratio. The
  `cached_read_classifier_degraded` finding wiring must name the three
  failed markers and surface the proportional ratios used per session.
- **Design.md Decision 6 status**: the gate this verification opens is
  CLOSED with the degraded-fallback outcome. The Strategy A code path
  described in design.md should be SKIPPED for v2 — none of its three
  required upstream markers are reachable from the parts walker, so
  there is no code path to land for it. The two `inferred-marker`
  sub-buckets (`accumulatedHistoryCached`,
  `accumulatedToolOutputsCached`) could still be classified by their
  structural patterns under a hybrid Strategy A — but the design's
  current wording treats the degraded fallback as all-or-nothing, so
  a hybrid would be a design-edit, not an implementation choice.
- **Follow-on possibility (not in v2 scope)**: a future spec could
  measure `agentsMdCached` and `systemPromptCached` directly by
  reading the AGENTS.md file from the filesystem at report-run time
  and embedding opencode's compiled-in provider prompts via either
  binary inspection or a vendored snapshot of `session/prompt/*.txt`.
  That would be a different architecture and is explicitly deferred.
- **Tasks ordering**: the design.md Decision 6 pre-implementation
  gate is satisfied by this round; the classifier-logic task can now
  land knowing the fallback shape it implements.

## Evidence summary table

| Sub-bucket | Classification | Marker / pattern | Source |
| --- | --- | --- | --- |
| `systemPromptCached` | `marker-unreliable` | `You are `, `You are powered by the model named `, `Skills provide specialized instructions` (literals upstream; not in parts table) | `session/system.ts:51-77`, `session/prompt/*.txt`, `session/llm.ts:103-115` |
| `agentsMdCached` | `marker-unreliable` | `Instructions from: <path>` (literal upstream; not in parts table) | `session/instruction.ts:14-18`, `:154-167`, `session/prompt.ts:1815-1818` |
| `mcpToolSchemasCached` | `marker-unreliable` | no marker — structured `tools` parameter on streamText | `session/llm.ts:195-216`, `:357` |
| `accumulatedHistoryCached` | `inferred-marker` | `message.role ∈ {user, assistant}` AND `part.type ∈ {text, reasoning}` | `session/message-v2.ts:61, 99, 115, 398`, `:692-873`; v1 `scripts/opencode-cost-report.js:599-602` |
| `accumulatedToolOutputsCached` | `inferred-marker` | `part.type === "tool"` (schema literal); `[Old tool result content cleared]` for compacted | `session/message-v2.ts:312`, `:787-857`; v1 `scripts/opencode-cost-report.js:603-604, :769-771` |
| `unclassifiedCached` | n/a (residual) | catch-all for unmatched parts; absorbs proportional-split rounding | design.md Flow 2 pattern, R4.AC5 |

## References (Marker Verification Round)

- Upstream source: `github.com/anomalyco/opencode`, default branch at
  clone time, packages/opencode/src/session/.
- v1 classifier source for comparison:
  `scripts/opencode-cost-report.js:595-805`.
- design.md Decision 6 (lines 829-835 in the live design): degraded
  fallback wiring and pre-implementation gate.
- requirements.md Requirement 4 (4.1, 4.5): at-minimum-five named
  sub-buckets, residual + finding handling.
