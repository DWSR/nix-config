# Implementation Plan

## 1. Foundation: pricing data asset, runtime wiring, schema-pin verification, shared cost helpers

- [x] 1.1 Verify opencode upstream system-prompt assembly markers (Decision 6 gate)
  - Locate the installed opencode binary and the source repo at `github.com/anomalyco/opencode`
  - Grep the prompt-builder source for the AGENTS.md inclusion site, the MCP-schema emit site, and the base system-prompt residual marker
  - Capture findings in a new "Marker Verification Results" section appended to `.kiro/specs/v2-diagnosis/research.md`
  - Observable: research.md "Marker Verification Results" section lists each of the 5 cachedRead sub-buckets with one of `verified-marker-string`, `inferred-marker`, or `marker-unreliable`; this directly determines whether Strategy A or the degraded fallback ships
  - _Requirements: 4.1, 4.5_
  - _Boundary: research-only, no code_

- [x] 1.2 (P) Vendor the bundled pricing JSON from models.dev
  - Fetch a snapshot of `https://models.dev/api.json`; filter to the providers/models observed in the operator's live history (anthropic claude-opus-4-7, claude-sonnet-4-5; openai gpt-5.5-pro)
  - Persist as `scripts/opencode-cost-report-pricing.json` with top-level `pinDate` (ISO 8601), `pinSource: "https://models.dev/api.json"`, optional `pinVersion`, and a `models` map keyed `[providerID][modelID]` with `cost.{input, output, reasoning, cache_read, cache_write}` in USD per million tokens
  - Observable: `cat scripts/opencode-cost-report-pricing.json | jq '.models.anthropic."claude-opus-4-7".cost.input'` returns a numeric rate
  - _Requirements: 3.1, 3.2_
  - _Boundary: scripts/opencode-cost-report-pricing.json_

- [x] 1.3 Wire the pricing JSON into the Nix wrapper via OPENCODE_COST_PRICING_PATH
  - Extend `scripts/opencode-cost-report.nix` to add the pricing JSON as a build input via `${./opencode-cost-report-pricing.json}` path interpolation
  - Set `OPENCODE_COST_PRICING_PATH` to the store path in the wrapper text before the `exec ${nodejs}/bin/node ...` line
  - Observable: `cat $(which opencode-cost-report)` shows `export OPENCODE_COST_PRICING_PATH=/nix/store/...-opencode-cost-report-pricing.json`; the file at that path is readable
  - _Depends: 1.2_
  - _Requirements: 3.1, 3.5_
  - _Boundary: scripts/opencode-cost-report.nix_

- [x] 1.4 Extend the smoke test to validate pricing JSON and model coverage
  - Update `scripts/opencode-cost-diagnosis-smoke-test.nix` to parse the bundled `opencode-cost-report-pricing.json` (fail loudly if missing or malformed)
  - Assert that each modelID observed in the operator's live history (`claude-opus-4-7`, `claude-sonnet-4-5`, `gpt-5.5-pro`) is present in the table
  - Keep the smoke-test bash invocation interface unchanged
  - Observable: `nix run .#opencode-cost-diagnosis-smoke-test` succeeds on both hosts; deliberately removing a model from the JSON causes the smoke test to fail loudly with a clear error
  - _Depends: 1.2, 1.3_
  - _Requirements: 3.1, 3.5_
  - _Boundary: scripts/opencode-cost-diagnosis-smoke-test.nix_

- [x] 1.5 Add v2 module-level constants and the makeNullCostShape() helper
  - Extend `PER_BUCKET_COST_KEYS` with `uncachedSystemPrompt`, `history`, `toolOutputs`
  - Add `CACHED_READ_SUB_BUCKET_KEYS` (the 6 named sub-bucket keys including `unclassifiedCached`)
  - Add tolerance constants `COST_INVARIANT_TOLERANCE_PCT = 0.001` and `COST_INVARIANT_TOLERANCE_FLOOR_USD = 0.01`
  - Add residual labels `SUBAGENT_NULL_AGENT_LABEL`, `SUBAGENT_BELOW_THRESHOLD_LABEL`, `TOOL_BELOW_THRESHOLD_LABEL`
  - Add threshold constants `SUBAGENT_BELOW_THRESHOLD_PCT = 0.01`, `SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR = 1`, `TOOL_BELOW_THRESHOLD_PCT = 0.01`
  - Add classifier marker constants per 1.1 outcomes: if 1.1 confirmed reliable markers, insert their exact strings; if any marker was tagged unreliable, insert a recognized sentinel value that TokenizerSplitter (3.1) treats as "markers unreliable" → `markersDegraded=true`
  - Implement `makeNullCostShape()` producing the all-null v2 cost shape: every cost key (six v1 + three new uncached + every `cachedReadBreakdown` key) is `null`; `subagentDispatchByAgent` and `toolOutputsByTool` are `null`; only `total` carries `session.cost`
  - Export the helper via `module.exports` for unit test reach
  - Observable: a one-line node REPL invocation `require('./scripts/opencode-cost-report.js').makeNullCostShape()` returns the documented shape with every cost key null
  - _Depends: 1.1_
  - _Requirements: 2.1, 3.4, 5.4, 6.5, 7.5_
  - _Boundary: opencode-cost-report.js (constants + helpers section)_

## 2. PricingTable component

- [x] 2.1 Implement PricingTable class
  - Constructor accepts a path argument; reads the JSON file once; throws clear error on missing file, JSON parse error, or missing top-level keys (`pinDate`, `pinSource`, `models`)
  - `lookup(providerID, modelID)` returns the cached `Rates` object or `null` for unknown keys; no fuzzy matching, no default-model fallback
  - **Reasoning rate handling**: if a per-model entry omits `cost.reasoning` (e.g., Anthropic Claude models that have no reasoning tokens), the returned `Rates.reasoningPerM` is `0`. Lookup does not throw and the Rates output shape is always complete with all five rate fields.
  - `pinMetadata` and `knownModels` accessors return frozen data
  - Variant dimension NOT consumed (variant-blind per Decision 2)
  - Export class via `module.exports`
  - Observable: a unit test instantiates PricingTable against the bundled JSON, asserts `lookup('anthropic', 'claude-opus-4-7')` returns a non-null rate object with all five rate fields populated (with `reasoningPerM === 0` for Claude models), asserts `lookup('unknown', 'unknown')` returns null
  - _Depends: 1.3, 1.5_
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: PricingTable_

- [x] 2.2 PricingTable unit tests
  - Cover happy-path lookup, null on unknown, pin metadata accessor returns expected pinDate/pinSource, constructor throws on missing/malformed file, variant-blind behavior
  - Cover the reasoning-substitution rule: a synthetic fixture model omitting `cost.reasoning` is looked up successfully and returns `Rates.reasoningPerM === 0`
  - Use a synthetic fixture pricing JSON under `tests/opencode-cost-diagnosis/fixtures/` so tests are independent of the production pin
  - Observable: new file `tests/opencode-cost-diagnosis/unit/pricing-table.test.js` exists and passes via the unit runner
  - _Depends: 2.1_
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: pricing-table.test.js_

## 3. TokenizerSplitter: cachedRead sub-bucket classifier and per-tool dimension

- [x] 3.1 Extend TokenizerSplitter.classifyAndCount to produce cachedReadBreakdown counts
  - Walk parts; classify system-role parts via content-shape markers (from 1.5 constants) into `systemPromptCached`, `agentsMdCached`, or `mcpToolSchemasCached`
  - Classify user+assistant parts into `accumulatedHistoryCached`; tool parts into `accumulatedToolOutputsCached`; unclassifiable into `unclassifiedCached`
  - Reuse the existing `_ensureEncoding` pattern for tiktoken counts; do not duplicate encoder construction
  - If a marker constant from 1.5 is the unreliable-sentinel, set `markersDegraded: true` on the return object and tag the failed marker name(s)
  - Observable: a unit test fixture with mixed system/AGENTS/MCP/history/tool parts returns a `TokenizerProvenance` whose `cachedReadBreakdown` keys sum to a positive count, `markersDegraded` is `false` on the happy path, and an explicitly-broken fixture sets `markersDegraded: true`
  - _Depends: 1.5_
  - _Requirements: 4.1, 4.5_
  - _Boundary: TokenizerSplitter (cachedRead classifier)_

- [ ] 3.2 Extend TokenizerSplitter.classifyAndCount to produce the byTool map
  - For each tool part, extract `part.data.name` defensively; missing/non-string folds into `(unknown-tool)`
  - Sum tiktoken counts per tool name with a `{ cached, uncached }` partition based on whether the part falls into the system-role cached prefix vs an uncached input slot
  - Observable: a unit test fixture with multiple tool parts returns a `byTool` map with the correct partition; a fixture with a tool part missing `data.name` shows the `(unknown-tool)` key
  - _Depends: 1.5, 3.1_
  - _Requirements: 6.1, 6.2_
  - _Boundary: TokenizerSplitter (byTool extension)_

- [ ] 3.3 TokenizerSplitter unit tests (cachedRead + byTool)
  - New `tests/opencode-cost-diagnosis/unit/tokenizer-cached-read.test.js`: classifier correctness across the 5 named sub-buckets, residual when markers fail, `markersDegraded` signal correctness
  - Extend `tests/opencode-cost-diagnosis/unit/tokenizer.test.js`: byTool partition correctness, `(unknown-tool)` fold, legacy uncached split (systemPrompt/history/toolOutput/unclassifiedCount) still works
  - Observable: both test files pass under the existing unit runner
  - _Depends: 3.1, 3.2_
  - _Requirements: 4.1, 4.5, 6.1, 6.2_
  - _Boundary: tokenizer test files_

## 4. SubagentAggregator: per-agent rollup and null-agent descendant exposure

- [ ] 4.1 Extend SubagentAggregator.rollup with byAgent map and nullAgentDescendantIds list
  - Group descendants by `session.agent`: real agent types map to themselves; `NULL` maps to `SUBAGENT_NULL_AGENT_LABEL`; agent types whose `childCount` falls below `SUBAGENT_BELOW_THRESHOLD_PCT × totalDescendantCount` (with a floor of `SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR`) map to `SUBAGENT_BELOW_THRESHOLD_LABEL`
  - Sum tokens/cost/childCount per agent key into the `byAgent` map
  - Collect every descendant session ID where `session.agent IS NULL` into `nullAgentDescendantIds`
  - Architectural strictness: NO message-row access in this class; only `session.*` rows via `SqliteReader.descendantSessionsOf`
  - Preserve v1 cycle-detection at `scripts/opencode-cost-report.js:552` verbatim
  - Observable: a unit test with a fixture root session having descendants tagged `general`, `general`, `explore`, NULL, NULL returns `byAgent.get('general').childCount === 2`, `byAgent.get('explore').childCount === 1`, `byAgent.get(SUBAGENT_NULL_AGENT_LABEL).childCount === 2`, and `nullAgentDescendantIds.length === 2`
  - _Depends: 1.5_
  - _Requirements: 5.1, 5.2, 5.4_
  - _Boundary: SubagentAggregator_

- [ ] 4.2 SubagentAggregator unit test coverage
  - Extend `tests/opencode-cost-diagnosis/unit/aggregator.test.js`: byAgent grouping with real agent types, NULL handling, below-threshold folding (incl. the child-floor), nullAgentDescendantIds list correctness, sum-correctness of byAgent totals vs rollup totals
  - Confirm cycle detection still emits the v1 `schema_partial_data` finding
  - Observable: the existing aggregator.test.js file gains the new cases and continues to pass
  - _Depends: 4.1_
  - _Requirements: 5.1, 5.2, 5.4_
  - _Boundary: aggregator.test.js_

## 5. AttributionEngine: per-message cost compute, reconciliation, drift, and all new finding emit sites

- [ ] 5.1 Extend AttributionEngine constructor and wire PricingTable
  - Add `pricingTable` as the fourth constructor parameter
  - Update `main()` to construct PricingTable first (reading `OPENCODE_COST_PRICING_PATH`) and pass it into the AttributionEngine constructor
  - Observable: a CLI run completes (even without other v2 changes); `require('./scripts/opencode-cost-report.js').AttributionEngine.length === 4`
  - _Depends: 1.3, 2.1_
  - _Requirements: 3.1, 3.2_
  - _Boundary: AttributionEngine constructor + main()_

- [ ] 5.2 Implement per-message walk and per-bucket cost for the nine flat cost fields
  - In `attributeSession`, walk message rows in chronological order; parse `message.data` JSON per assistant message; extract `providerID`, `modelID`, and per-message tokens (input, output, reasoning, cache.read, cache.write)
  - Call `pricingTable.lookup(providerID, modelID)`; on null, mark the session for drift handling (the actual cost-shape assignment lives in 5.6)
  - For matched messages, compute per-bucket dollar contributions for the 9 flat cost fields (six v1: cachedRead, cachedWrite, uncachedInput, output, reasoning, subagentDispatch; plus three new uncached sub-buckets: uncachedSystemPrompt, history, toolOutputs) and accumulate into session totals
  - Pull per-agent dollar values from `SubagentAggregator.byAgent` (which already incorporates descendants' authoritative session.cost — no recomputation here)
  - Observable: a unit test with a synthetic matched single-model session returns a `SessionAttribution` whose `cost.uncachedSystemPrompt + cost.history + cost.toolOutputs` equals `cost.uncachedInput` within tolerance; `cost.cachedRead`, `cost.output`, and `cost.reasoning` are all populated; `cost.total === session.cost`
  - _Depends: 1.5, 2.1, 4.1_
  - _Requirements: 2.1, 2.2, 2.5, 3.2, 5.3, 7.5_
  - _Boundary: AttributionEngine per-message cost compute_

- [ ] 5.3 Implement cachedRead sub-bucket apportionment
  - Apportion `session.tokens_cache_read` across the 6 cachedRead sub-buckets via `TokenizerProvenance.cachedReadBreakdown` counts using v1 Flow 2 (last-sub-bucket-absorbs-rounding pattern; `unclassifiedCached` is the absorber)
  - Each sub-bucket's cost is `subBucketTokens × cache_read_rate_per_token` (cost derives via the parent rate)
  - Sum-correctness invariants: token sum equals `session.tokens_cache_read` exactly; cost sum equals `cost.cachedRead` within rounding
  - Observable: a unit test with a synthetic session shows `sum(cost.cachedReadBreakdown.*) === cost.cachedRead` within $0.01 AND `sum(cachedReadBreakdown token counts) === session.tokens_cache_read` exactly
  - _Depends: 3.1, 5.2_
  - _Requirements: 4.1, 4.2_
  - _Boundary: AttributionEngine cachedRead apportionment_

- [ ] 5.4 Implement per-tool sub-bucket apportionment with cached/uncached partition
  - For each tool in `byTool`: `cost = byTool[name].cached × cache_read_rate + byTool[name].uncached × input_rate`
  - The last per-tool bucket absorbs rounding within each cached and uncached partition independently
  - Sum-correctness invariants: per-tool cached cost sum equals the cached share of `cost.toolOutputs` within rounding; per-tool uncached cost sum equals the uncached share within rounding
  - Observable: a unit test shows per-tool cost sums match the parent toolOutputs slices within each partition; rounding is absorbed in the last per-tool bucket
  - _Depends: 3.2, 5.2_
  - _Requirements: 6.2, 6.3_
  - _Boundary: AttributionEngine per-tool apportionment_

- [ ] 5.5 Implement reconciliation and cost_invariant_violation finding
  - After all per-bucket cost accumulation (5.2 + 5.3 + 5.4 contributions), compute the total per-bucket sum and compare against `session.cost`
  - If `|delta| > max(COST_INVARIANT_TOLERANCE_PCT × session.cost, COST_INVARIANT_TOLERANCE_FLOOR_USD)`, emit a `cost_invariant_violation` finding with session ID + expected (`session.cost`) + actual (sum)
  - Never block report emission on this finding
  - Observable: a unit test with a synthetic out-of-tolerance session emits exactly one `cost_invariant_violation` finding; a within-tolerance session emits none; the report continues to emit either way
  - _Depends: 5.2, 5.3, 5.4_
  - _Requirements: 2.3, 2.4_
  - _Boundary: AttributionEngine reconciliation_

- [ ] 5.6 Implement pricing-drift fallback via makeNullCostShape and emit pricing_table_drift finding
  - On the drift branch (any message in the session had unmatched `(providerID, modelID)` per 5.2's mark): assign `attribution.cost = makeNullCostShape()` with `cost.total` preserved from `session.cost`; emit one `pricing_table_drift` finding naming the session ID and the unrecognized key
  - Continue populating token-side fields (no change to TokenBuckets on drift)
  - Other sessions in the same run retain populated cost
  - Observable: a unit test with two sessions (one matched, one with a synthetic missing modelID) returns the matched session with populated `cost.*` fields and the drift session with `cost.cachedRead === null` AND every other v2 cost field null EXCEPT `cost.total`; emits one `pricing_table_drift` finding tagged to the drift session
  - _Depends: 1.5, 5.2_
  - _Requirements: 3.4, 7.5_
  - _Boundary: AttributionEngine drift path_

- [ ] 5.7 Implement cachedRead classification residual and degraded-classifier finding emit sites
  - After cachedRead apportionment (5.3): if `unclassifiedCached / session.tokens_cache_read > 0.05`, emit `cached_read_classification_residual` finding naming the session and the residual ratio
  - If `tokenizerProvenance.markersDegraded === true`, apply the proportional-from-uncached degraded path: distribute `session.tokens_cache_read` across the 5 named sub-buckets in the `systemPrompt : history : toolOutput` ratio from the uncached side (`agentsMdCached` and `mcpToolSchemasCached` set to 0; `unclassifiedCached` absorbs rounding) AND emit `cached_read_classifier_degraded` finding naming the failed marker(s)
  - Observable: a unit test with a synthetic markersDegraded fixture returns `cost.cachedReadBreakdown.agentsMdCached === 0` and `cost.cachedReadBreakdown.mcpToolSchemasCached === 0` AND emits the `cached_read_classifier_degraded` finding; a synthetic high-residual fixture (60%+ unclassified) emits `cached_read_classification_residual`
  - _Depends: 3.1, 5.3_
  - _Requirements: 4.1, 4.5_
  - _Boundary: AttributionEngine cachedRead degradation_

- [ ] 5.8 Emit subagent_agent_attribution_drift finding from AttributionEngine
  - After `SubagentAggregator.rollup()` returns, for each descendant ID in `nullAgentDescendantIds`, call `SqliteReader.messagesOfSession(descendantId)` and inspect each message's parsed `data.agent` field
  - If any message in a null-agent descendant carries a non-null `message.data.agent`, emit `subagent_agent_attribution_drift` finding naming the descendant session ID and the modal observed `message.data.agent` value
  - Architectural strictness: this is the cross-layer message inspection; SubagentAggregator stays pure session-row work
  - Observable: a unit test with a parent + 2 NULL-agent descendants (one of which has messages tagged `general`, the other has no message-level agent) emits exactly one `subagent_agent_attribution_drift` finding pointing at the first descendant and naming `general`
  - _Depends: 4.1, 5.2_
  - _Requirements: 5.4_
  - _Boundary: AttributionEngine drift-detection_

- [ ] 5.9 Rewrite the per_bucket_cost_deferred detail string template
  - Update the existing emit site at `scripts/opencode-cost-report.js:1032-1041` to use the canonical v2 wording from design.md Decision 1: `"session ${id}: per-bucket cost is now populated by v2 (was null in v1). This finding kind is retained for R7.AC4 forward-compatibility and now records the v1->v2 migration of the per-bucket cost fields rather than a deferred state."`
  - Do NOT remove the emit site (R7.AC4 forbids removal of v1 finding codes)
  - Keep the per-session emit (same trigger as v1)
  - Observable: a unit test asserts the finding's `detail` field on a v2 attribution contains the substring `"per-bucket cost is now populated by v2"` and the `kind` is still `per_bucket_cost_deferred`
  - _Depends: 5.2_
  - _Requirements: 7.4_
  - _Boundary: AttributionEngine finding rewrite_

- [ ] 5.10 AttributionEngine unit tests
  - Extend `tests/opencode-cost-diagnosis/unit/attribution.test.js`: happy path (5.2); cachedRead apportionment + sum-correctness (5.3); per-tool apportionment + sum-correctness (5.4); reconciliation finding (5.5); drift fallback to all-null shape (5.6); markersDegraded → proportional-from-uncached (5.7); subagent drift finding (5.8); rewritten per_bucket_cost_deferred (5.9)
  - Observable: attribution.test.js gains at least 10 new cases and all pass
  - _Depends: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - _Requirements: 2.1, 2.3, 2.4, 3.4, 4.1, 4.2, 4.5, 5.4, 6.2, 6.3, 7.4, 7.5_
  - _Boundary: attribution.test.js_

## 6. ReportAssembler: aggregate new sub-buckets across project and global

- [ ] 6.1 Extend ReportAssembler aggregation loops for the extended cost shape
  - Update the global cost loop at `scripts/opencode-cost-report.js:1596-1605` to iterate over the expanded `PER_BUCKET_COST_KEYS` (six v1 + three new uncached sub-buckets) when populating `globalCost`; preserve `cost.total` accumulation
  - Update the per-project loop at `scripts/opencode-cost-report.js:1627-1633` symmetrically
  - Drift-session contributions: skip per-key accumulation for sessions whose `cost.X === null` (drift fallback), but still accumulate `cost.total`
  - Observable: a unit test with two attributions (one matched, one drift) returns `globalCost.cachedRead` equal to ONLY the matched session's value (drift session contributes null, skipped), and `globalCost.total` equal to BOTH sessions' totals combined
  - _Depends: 1.5, 5.2, 5.6_
  - _Requirements: 2.2, 7.3_
  - _Boundary: ReportAssembler cost aggregation_

- [ ] 6.2 Extend ReportAssembler aggregation for cachedReadBreakdown, byAgent, and byTool (with Map→Object conversion)
  - At global and per-project levels, deep-merge the `cachedReadBreakdown` nested object (sum per sub-bucket key)
  - At global and per-project levels, merge the `subagentDispatchByAgent` and `toolOutputsByTool` maps by key with rolling sums across sessions; for `toolOutputsByTool`, preserve the `{ cached, uncached }` partition during merge
  - **Convert `Map<string, *>` instances to plain objects via `Object.fromEntries(map)` at assembly time** so the JSON serializer's existing alphabetical-key replacer can sort them. Conversion happens here in ReportAssembler, NOT in ReportSerializer (per design § ReportSerializer Implementation Notes).
  - Drift-session contributions: skip per-key accumulation when the map is null (consistent with 6.1)
  - Observable: a unit test with multiple attributions across two projects shows `byProject[A].cachedReadBreakdown.systemPromptCached` equals the sum across A's sessions; same for `byAgent` and `byTool`; the assembled `DiagnosticReport`'s byAgent/byTool fields are plain objects (not Map instances) when inspected after assembly
  - _Depends: 5.2, 5.3, 5.4, 5.7, 6.1_
  - _Requirements: 4.3, 5.3, 6.4_
  - _Boundary: ReportAssembler sub-bucket aggregation_

- [ ] 6.3 Extend ReportAssembler to emit the pricing pin block, threshold metadata, and wire PricingTable through main()
  - Inject `pricing: { pinDate, pinSource, pinVersion? }` into the disclaimer object built around `scripts/opencode-cost-report.js:1685-1706`
  - Inject `thresholds: { subagentBelowThresholdPct, subagentBelowThresholdChildFloor, toolBelowThresholdPct }` into the same disclaimer block so 7.1 can render them and R5.4 / R6.5 are satisfied
  - Source pin metadata via PricingTable (passed to ReportAssembler at construction); update the ReportAssembler constructor signature accordingly
  - **Wire `main()` to construct ReportAssembler with the PricingTable instance** (mirrors the AttributionEngine wiring in 5.1)
  - Extend `TOKENIZER_AFFECTED_BUCKETS` to include the new cachedRead sub-buckets and the byTool/byAgent dimensions
  - Observable: a unit test against an assembled `DiagnosticReport` shows `report.pricing.pinDate` matches the bundled JSON's pinDate; `report.tokenizer_disclaimer.affectedBuckets` includes `systemPromptCached`; `report.tokenizer_disclaimer.thresholds.subagentBelowThresholdPct === 0.01`; `ReportAssembler.length` increased by 1 (now accepts pricingTable); a CLI run via main() still completes end-to-end
  - _Depends: 2.1, 6.1_
  - _Requirements: 3.3, 4.4, 5.4, 6.5_
  - _Boundary: ReportAssembler disclaimer + main() wiring_

- [ ] 6.4 ReportAssembler unit tests
  - Extend `tests/opencode-cost-diagnosis/unit/report-assembler.test.js`: cover global vs per-project aggregation across all new sub-buckets; drift-session null-skipping behavior; pricing pin block presence; threshold metadata block presence; tokenizer disclaimer extension; assert Map→Object conversion happened at assembly time (test the assembled object, not the serializer)
  - Observable: report-assembler.test.js gains at least 5 new cases and all pass
  - _Depends: 6.1, 6.2, 6.3_
  - _Requirements: 2.2, 4.3, 4.4, 5.3, 5.4, 6.4, 6.5_
  - _Boundary: report-assembler.test.js_

## 7. ReportSerializer: Markdown + JSON rendering for new sections

- [ ] 7.1 Extend ReportSerializer Markdown output for new sub-buckets, pricing pin, threshold rendering, and migration disclaimer
  - Insert the new pricing-pin disclaimer block immediately after the existing tokenizer disclaimer block (`scripts/opencode-cost-report.js:1834-1859` area) with wording: `**PRICING PIN**: rates from ${pinSource} pinned ${pinDate}. Per-bucket dollar values reflect list-price rates only; contract rates, discounts, prepaid credits, and Max-plan variants are not modeled.`
  - Render the per-agent and per-tool below-threshold fold percentages from `tokenizer_disclaimer.thresholds` inside the disclaimer area (e.g., `per-agent fold threshold: 1% of total descendants (floor 1 child); per-tool fold threshold: 1% of bucket`) so the operator can interpret the `(below-threshold-fold)` residuals
  - Add the v1→v2 migration disclaimer (gated by a module-level constant the operator can remove later in a follow-up commit)
  - Within each session detail block: render a cachedRead breakdown table, a per-agent table, and a per-tool table (with cached/uncached partition); render the three new uncached cost sub-bucket lines
  - Preserve the binding observable: the first line of Markdown still starts with `**TOKENIZER ACCURACY DISCLAIMER (`
  - Observable: a unit test renders a sample assembled report and asserts the output contains the substring `**PRICING PIN**:` immediately after the existing disclaimer block; asserts the threshold-rendering substring (e.g., `per-agent fold threshold:`); asserts cachedRead/agent/tool tables appear in per-session blocks
  - _Depends: 6.3_
  - _Requirements: 3.3, 4.4, 5.4, 6.5, 7.1_
  - _Boundary: ReportSerializer Markdown_

- [ ] 7.2 Extend ReportSerializer JSON output
  - Add the `pricing` top-level field; verify it slots alphabetically via the existing replacer at `scripts/opencode-cost-report.js:1785-1802` (no replacer change needed; the Map→Object conversion already happened in 6.2)
  - Preserve the `generatedAt`-not-in-JSON invariant (only present in Markdown) — this is load-bearing for R7.AC2 byte-identical determinism
  - Observable: a unit test serializes a sample report to JSON, parses it back, and asserts `parsed.pricing.pinDate` is present; the JSON contains no `generatedAt` key; `Object.keys(parsed)` is sorted alphabetically at every nested level (including byAgent and byTool maps which are now plain objects after 6.2)
  - _Depends: 6.2, 6.3_
  - _Requirements: 3.3, 7.1, 7.2_
  - _Boundary: ReportSerializer JSON_

- [ ] 7.3 ReportSerializer unit tests
  - Extend `tests/opencode-cost-diagnosis/unit/serializer.test.js`: cover Markdown pricing pin block placement, threshold rendering presence, migration disclaimer presence, new section rendering; cover JSON pricing field placement, alphabetical ordering preserved at every level, `generatedAt` absence, byAgent/byTool serialized as plain objects
  - Observable: serializer.test.js gains at least 5 new cases and all pass
  - _Depends: 7.1, 7.2_
  - _Requirements: 3.3, 4.4, 5.4, 6.5, 7.1, 7.2_
  - _Boundary: serializer.test.js_

## 8. Golden refresh and integration tests

- [ ] 8.1 Refresh integration golden files via UPDATE_GOLDEN=1
  - Run `UPDATE_GOLDEN=1 node tests/opencode-cost-diagnosis/integration/run.js` against the existing `fixture-365d-all` fixture
  - Manually inspect the diff to confirm the new fields, new sections, and pricing pin block appear in the expected positions; verify alphabetical JSON ordering is preserved
  - Commit the refreshed `fixture-365d-all.{md,json}` AND retain the prior v1 versions as `fixture-365d-all-v1.{md,json}` under the same golden directory for migration-PR review (per Migration Strategy)
  - Observable: `git diff tests/opencode-cost-diagnosis/integration/golden/` shows refreshed v2 goldens AND new `fixture-365d-all-v1.{md,json}` files; running the integration suite without `UPDATE_GOLDEN=1` passes byte-identical against the new goldens
  - _Depends: 7.1, 7.2_
  - _Requirements: 7.1, 7.2_
  - _Boundary: tests/opencode-cost-diagnosis/integration/golden/_

- [ ] 8.2 (P) Add cost-invariant integration test
  - Create `tests/opencode-cost-diagnosis/integration/cost-invariant.test.js`
  - Synthesize a fixture session whose per-bucket sum diverges beyond tolerance from `session.cost`; run the full pipeline; assert the report contains a `cost_invariant_violation` finding tagged to that session and is emitted (not blocked)
  - Synthesize a within-tolerance session; assert no such finding fires
  - Observable: integration test file exists and passes under `tests/opencode-cost-diagnosis/integration/run.js`
  - _Depends: 5.5, 7.2, 8.1_
  - _Requirements: 2.3, 2.4_
  - _Boundary: cost-invariant.test.js_

- [ ] 8.3 (P) Add pricing-drift integration test
  - Create `tests/opencode-cost-diagnosis/integration/pricing-drift.test.js`
  - Use a perturbed pricing JSON missing one of the live-history modelIDs; run the full pipeline against the standard fixture DB; assert the affected sessions have ALL v2 cost fields null (except `total`), other sessions retain populated cost, and the `pricing_table_drift` finding lists the unmatched key
  - Observable: integration test file exists, passes, and the assertion specifically verifies `cost.cachedRead === null` AND `cost.uncachedInput === null` AND `cost.cachedReadBreakdown === null` AND `cost.total !== null` for the affected session
  - _Depends: 5.6, 7.2, 8.1_
  - _Requirements: 3.4, 7.5_
  - _Boundary: pricing-drift.test.js_

- [ ] 8.4 Extend cli-integration test for new finding codes and disclaimer presence
  - Add cases to `tests/opencode-cost-diagnosis/integration/cli-integration.test.js`: assert each new finding (`cost_invariant_violation`, `pricing_table_drift`, `cached_read_classification_residual`, `cached_read_classifier_degraded`, `subagent_agent_attribution_drift`) appears in the report when triggered; assert the rewritten `per_bucket_cost_deferred` detail string contains the canonical substring; assert the pricing pin block follows the tokenizer disclaimer in the Markdown output
  - Observable: cli-integration.test.js gains at least 5 new cases; the suite passes overall after the goldens were refreshed in 8.1
  - _Depends: 7.1, 7.2, 8.1_
  - _Requirements: 3.3, 7.1, 7.4_
  - _Boundary: cli-integration.test.js_

## 9. Final validation: forward-compat sanity and v1 invariant preservation

- [ ] 9.1 Forward-compat structural verification pass
  - Write a verification helper (extending `tests/opencode-cost-diagnosis/integration/_helpers.js` or as a standalone script): parse the v1 golden JSON (`fixture-365d-all-v1.json`) AND the v2 output JSON; for each key in v1, assert it is present in v2 with the same type and the same alphabetical position; assert no v1 finding kind code was removed; assert each `cost.X` that was `null` in v1 is now a number in v2 for matched-pricing sessions (R7.AC5); confirm no `generatedAt` key appears in v2 JSON; confirm 0600 file-permission posture on the output files
  - Observable: the verification script prints a labeled PASS/FAIL checklist (`v1-keys-present: PASS|FAIL`, `alphabetical-ordering: PASS|FAIL`, `findings-preserved: PASS|FAIL`, `null-to-value: PASS|FAIL`, `no-generatedAt-in-json: PASS|FAIL`, `file-permission-0600: PASS|FAIL`); all PASS for cutover
  - _Depends: 8.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: forward-compat verification_

- [ ] 9.2 Performance sanity bound check
  - Run the full-history report against the operator's live opencode DB; capture wall-clock
  - Confirm it completes within the v1 envelope (sub-3-second p99 sanity bound per design Performance & Scalability section)
  - Confirm per-message pricing lookup overhead and cold-start JSON parse fit the sanity bounds documented in design
  - Observable: a timing log line (or test trace) shows the full-history report completes in <3s with the per-session breakdown
  - _Depends: 8.1_
  - _Requirements: 1.5_
  - _Boundary: performance sanity_

## Implementation Notes

- 1.1 → Decision 6 gate result: degraded fallback ships, not Strategy A. Only 2 of 5 cachedRead sub-buckets (`accumulatedHistoryCached`, `accumulatedToolOutputsCached`) have inferred markers; the other 3 (system prompt, AGENTS.md, MCP schemas) are constructed per-turn at request time and never persisted in the opencode `parts` table — Strategy A is structurally unreachable for them. Subsequent classifier work (3.1) should wire the `markersDegraded=true` proportional-from-uncached path described in design.md Decision 6 and emit `cached_read_classifier_degraded`. The classifier marker constants from task 1.5 should use a recognized sentinel value for the 3 unreliable sub-buckets so `markersDegraded` fires automatically.
- 1.2 → models.dev upstream catalog omits `cost.cache_read` and `cost.cache_write` for OpenAI `gpt-5.5-pro` (similar to how it omits `cost.reasoning` for Claude models). The vendored snapshot preserves the upstream "don't fabricate" shape (omit instead of writing 0). Task 2.1 `PricingTable.lookup` MUST substitute `0` for missing `cache_read` and `cache_write` exactly as design § PricingTable mandates for missing `reasoning` so the returned `Rates` shape stays complete with all five fields.
- 1.3 → The Nix wrapper now exports `OPENCODE_COST_PRICING_PATH=${./opencode-cost-report-pricing.json}` (Nix path interpolation, captured at build time). The on-PATH `opencode-cost-report` binary will NOT reflect this change until `darwin-rebuild switch` runs. Subsequent tasks that need to verify the env var on PATH (e.g., the smoke test in 1.4) should validate against the source file's text — the rebuild-and-cutover is a manual operator step at the end of the implementation cycle (see Migration Strategy in design.md).
- 1.4 → Smoke test now has check (e) `pricing_drift`. Note: design.md § Migration Strategy / Validation checkpoints says "four modelID values" but tasks.md + the bundled JSON track three (`claude-opus-4-7`, `claude-sonnet-4-5`, `gpt-5.5-pro`). Implementation correctly tracks the JSON. The design.md discrepancy is a minor spec-drift to fix in a follow-up commit if it becomes confusing. Smoke-test label is `pricing_drift` (parallels the JS CLI's `pricing_table_drift` finding code but lives in an independent namespace).
- 1.5 → V1/v2 decoupling: introduced a private internal `V1_PER_BUCKET_COST_KEYS` (6 entries) so `makeZeroCostBuckets()` continues to emit v1's 6-key cost shape — this is what keeps the integration goldens byte-identical at this scaffolding stage. The exported `PER_BUCKET_COST_KEYS` is the new 9-key v2 list and is consumed by `makeNullCostShape` and (eventually) by tasks 5.2+. Once task 5.2's v2 cost-compute path lands, the v1 callers will migrate to the v2 shape and the private 6-key list becomes dead. `MARKER_BY_STRUCTURE = Object.freeze({ kind: 'by-structure' })` is the structural-marker sentinel for the 2 inferred-marker sub-buckets (history, tool outputs); the 3 unreliable sub-buckets (systemPrompt, AGENTS.md, MCP schemas) use `MARKER_UNRELIABLE_SENTINEL = null`. Task 3.1's classifier dispatches on reference identity (`marker === MARKER_BY_STRUCTURE`) vs nullity.
- 2.1 → PricingTable performs EAGER per-model validation at construction time (rate fields type-checked, required `cost.input`/`cost.output` throws if missing/non-numeric). This DIVERGES from design.md § PricingTable Implementation Notes which says "Per-model entries are validated lazily on lookup." The deviation is intentional: (a) eager loud-fail at startup is the same posture design § PricingTable already prescribes for top-level validation and that requirements.md anchors to v1's schema-drift discipline; (b) the lookup-never-throws contract is materially easier to honor when malformed per-model entries surface at construction; (c) the bundled JSON has <100 entries so the cost is negligible. Tasks 5.1 (AttributionEngine constructor wiring) and 5.6 (drift finding emission) can rely on the fact that per-model validation has already fired by the time `lookup` runs — they only need to handle the `null` "unknown key" outcome, not malformed-but-known-key errors.
- 3.1 → Two design extensions that follow-on tasks must know about:
  1. `TokenizerSplitter` constructor now accepts an OPTIONAL `markers = DEFAULT_MARKERS` map for test injection. design.md § TokenizerSplitter (extended) Service Interface specifies a parameterless constructor; the markers arg is purely a testability extension (production callers pass no arg). Documented so 3.3 / 5.7 reviewers don't flag it as a drift.
  2. The test file `tests/opencode-cost-diagnosis/unit/tokenizer-cached-read.test.js` was CREATED by 3.1 (rather than 3.3 as the spec assigns) because 3.1's observable requires a unit test of `cachedReadBreakdown`. Two pre-existing `assert.deepEqual` calls in `tests/opencode-cost-diagnosis/unit/tokenizer.test.js` were destructured to v1-keys-only to preserve their semantic intent without crippling the suite when new return-shape fields land. Task 3.3 should be RE-SCOPED at start to "add byTool test coverage to the existing tokenizer-cached-read.test.js file (or tokenizer.test.js, per the byTool boundary)" instead of "create the cachedRead test file from scratch".
  3. Additive shape: classifyAndCount return now includes `cachedReadBreakdown` (6 keys), `markersDegraded` (boolean computed at construction), `failedMarkers` (frozen array of marker names). markersDegraded=true for the production default markers (3 unreliable sentinels from 1.5); markersDegraded=false only when ALL markers are by-structure. The 3 system-role sub-buckets (`systemPromptCached`, `agentsMdCached`, `mcpToolSchemasCached`) are present-but-0 under the production markers — Decision 6 degraded-fallback path. agentsMd/mcpToolSchemas remain 0 even when markers are by-structure (no content-shape grep ships; all role=system parts collapse to systemPromptCached). R4.AC1 satisfied: all 5 named sub-buckets physically present on every return.
