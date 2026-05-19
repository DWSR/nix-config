**TOKENIZER ACCURACY DISCLAIMER (tiktoken / cl100k_base)**

Bucket totals for uncachedSystemPrompt, history, toolOutputs, systemPromptCached, agentsMdCached, mcpToolSchemasCached, accumulatedHistoryCached, accumulatedToolOutputsCached, unclassifiedCached, toolOutputsByTool, subagentDispatchByAgent are tiktoken (cl100k_base) estimates derived from a proportional split of opencode's authoritative session.tokens_input; they are relative-only and suitable for ranking cost drivers, but are NOT billing-grade absolute counts. The three buckets nevertheless sum exactly to opencode's stored tokens_input value (last bucket absorbs rounding). Authoritative buckets (cachedRead, cachedWrite, output, reasoning, subagentDispatch) are read directly from opencode and require no estimation. Supported opencode version range: >=0.18.0 <0.30.0.

- Affected buckets (tokenizer-derived, relative-only): uncachedSystemPrompt, history, toolOutputs, systemPromptCached, agentsMdCached, mcpToolSchemasCached, accumulatedHistoryCached, accumulatedToolOutputsCached, unclassifiedCached, toolOutputsByTool, subagentDispatchByAgent
- Authoritative buckets (read directly from opencode): cachedRead, cachedWrite, output, reasoning, subagentDispatch
- Accuracy class: relative-only
- Sum-correctness guarantee: Uncached sub-buckets sum exactly to opencode.session.tokens_input

**PRICING PIN**: rates from https://models.dev/api.json pinned 2026-05-18. Per-bucket dollar values reflect list-price rates only; contract rates, discounts, prepaid credits, and Max-plan variants are not modeled.

- per-agent fold threshold: 1% of total descendants (floor 1 child)
- per-tool fold threshold: 1% of bucket

**v1→v2 migration**: per-bucket cost fields now carry populated values; the v1 `per_bucket_cost_deferred` finding is preserved (R7.AC4) with its detail string rewritten to reflect the populated state.

_Report generated: <REDACTED-FOR-GOLDEN>_

---

## Global Totals

- Sessions: 3
- Cost total: 0.15000000000000002

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 15000 |
| cachedWrite | 3000 |
| uncachedSystemPrompt | 6666 |
| history | 15555 |
| toolOutputs | 7779 |
| output | 1500 |
| reasoning | 300 |
| subagentDispatch | 20700 |

## Per-Project Breakdown

### /Users/test/project-a

- Sessions: 1
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 10350 |

### /Users/test/project-b

- Sessions: 1
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 10350 |

### /Users/test/project-c

- Sessions: 1
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 0 |

## Per-Session Detail

### ses_root_a

- Directory: /Users/test/project-a
- Agent: build
- Model: claude-opus-4-7
- Time created: 1778775290084
- Time updated: 1778775290184
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 10350 |

- Uncached system prompt: 0.011111111111111113
- History: 0.02592592592592593
- Tool outputs: 0.01296296296296296

| CachedRead sub-bucket | Cost |
| --- | ---: |
| systemPromptCached | 0.0005555 |
| agentsMdCached | 0 |
| mcpToolSchemasCached | 0 |
| accumulatedHistoryCached | 0.0012965 |
| accumulatedToolOutputsCached | 0.0006479999999999999 |
| unclassifiedCached | 4.336808689942018e-19 |

| Agent | Cost |
| --- | ---: |
| general | 0.03 |

_No per-tool data._

### ses_root_b

- Directory: /Users/test/project-b
- Agent: general
- Model: claude-opus-4-7
- Time created: 1778775291084
- Time updated: 1778775291184
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 10350 |

- Uncached system prompt: 0.011111111111111113
- History: 0.02592592592592593
- Tool outputs: 0.01296296296296296

| CachedRead sub-bucket | Cost |
| --- | ---: |
| systemPromptCached | 0.0005555 |
| agentsMdCached | 0 |
| mcpToolSchemasCached | 0 |
| accumulatedHistoryCached | 0.0012965 |
| accumulatedToolOutputsCached | 0.0006479999999999999 |
| unclassifiedCached | 4.336808689942018e-19 |

| Agent | Cost |
| --- | ---: |
| general | 0.03 |

_No per-tool data._

### ses_root_c

- Directory: /Users/test/project-c
- Agent: explore
- Model: claude-opus-4-7
- Time created: 1778775292084
- Time updated: 1778775292184
- Cost: 0.05

| Bucket | Tokens |
| --- | ---: |
| cachedRead | 5000 |
| cachedWrite | 1000 |
| uncachedSystemPrompt | 2222 |
| history | 5185 |
| toolOutputs | 2593 |
| output | 500 |
| reasoning | 100 |
| subagentDispatch | 0 |

- Uncached system prompt: 0.011111111111111113
- History: 0.02592592592592593
- Tool outputs: 0.01296296296296296

| CachedRead sub-bucket | Cost |
| --- | ---: |
| systemPromptCached | 0.0005555 |
| agentsMdCached | 0 |
| mcpToolSchemasCached | 0 |
| accumulatedHistoryCached | 0.0012965 |
| accumulatedToolOutputsCached | 0.0006479999999999999 |
| unclassifiedCached | 4.336808689942018e-19 |

_No per-agent data._

_No per-tool data._

## Findings

- **per_bucket_cost_deferred** (session ses_root_a): session ses_root_a: per-bucket cost is now populated by v2 (was null in v1). This finding kind is retained for R7.AC4 forward-compatibility and now records the v1->v2 migration of the per-bucket cost fields rather than a deferred state.
- **cost_invariant_violation** (session ses_root_a): session ses_root_a: per-bucket sum diverged from session.cost beyond tolerance. expected=0.05 actual=0.10125 |delta|=0.051250000000000004 tolerance=0.01 (= max(0.001 × 0.05, 0.01)). Informational only; report continues to emit.
- **cached_read_classifier_degraded** (session ses_root_a): session ses_root_a: TokenizerSplitter content-shape markers fired unreliably for 3 of 5 cachedRead sub-bucket(s): [systemPrompt, agentsMd, mcpToolSchemas]. AttributionEngine fell back to the proportional-from-uncached split (design.md Decision 6); agentsMdCached and mcpToolSchemasCached are 0; the other three named sub-buckets carry the systemPrompt:history:toolOutput ratio from the uncached side. R4.AC1 satisfied: all 5 named sub-buckets present on cost.cachedReadBreakdown.
- **per_bucket_cost_deferred** (session ses_root_b): session ses_root_b: per-bucket cost is now populated by v2 (was null in v1). This finding kind is retained for R7.AC4 forward-compatibility and now records the v1->v2 migration of the per-bucket cost fields rather than a deferred state.
- **cost_invariant_violation** (session ses_root_b): session ses_root_b: per-bucket sum diverged from session.cost beyond tolerance. expected=0.05 actual=0.10125 |delta|=0.051250000000000004 tolerance=0.01 (= max(0.001 × 0.05, 0.01)). Informational only; report continues to emit.
- **cached_read_classifier_degraded** (session ses_root_b): session ses_root_b: TokenizerSplitter content-shape markers fired unreliably for 3 of 5 cachedRead sub-bucket(s): [systemPrompt, agentsMd, mcpToolSchemas]. AttributionEngine fell back to the proportional-from-uncached split (design.md Decision 6); agentsMdCached and mcpToolSchemasCached are 0; the other three named sub-buckets carry the systemPrompt:history:toolOutput ratio from the uncached side. R4.AC1 satisfied: all 5 named sub-buckets present on cost.cachedReadBreakdown.
- **per_bucket_cost_deferred** (session ses_root_c): session ses_root_c: per-bucket cost is now populated by v2 (was null in v1). This finding kind is retained for R7.AC4 forward-compatibility and now records the v1->v2 migration of the per-bucket cost fields rather than a deferred state.
- **cost_invariant_violation** (session ses_root_c): session ses_root_c: per-bucket sum diverged from session.cost beyond tolerance. expected=0.05 actual=0.07125000000000001 |delta|=0.021250000000000005 tolerance=0.01 (= max(0.001 × 0.05, 0.01)). Informational only; report continues to emit.
- **cached_read_classifier_degraded** (session ses_root_c): session ses_root_c: TokenizerSplitter content-shape markers fired unreliably for 3 of 5 cachedRead sub-bucket(s): [systemPrompt, agentsMd, mcpToolSchemas]. AttributionEngine fell back to the proportional-from-uncached split (design.md Decision 6); agentsMdCached and mcpToolSchemasCached are 0; the other three named sub-buckets carry the systemPrompt:history:toolOutput ratio from the uncached side. R4.AC1 satisfied: all 5 named sub-buckets present on cost.cachedReadBreakdown.
