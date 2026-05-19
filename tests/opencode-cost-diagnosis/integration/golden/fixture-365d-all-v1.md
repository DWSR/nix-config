**TOKENIZER ACCURACY DISCLAIMER (tiktoken / cl100k_base)**

Bucket totals for uncachedSystemPrompt, history, toolOutputs are tiktoken (cl100k_base) estimates derived from a proportional split of opencode's authoritative session.tokens_input; they are relative-only and suitable for ranking cost drivers, but are NOT billing-grade absolute counts. The three buckets nevertheless sum exactly to opencode's stored tokens_input value (last bucket absorbs rounding). Authoritative buckets (cachedRead, cachedWrite, output, reasoning, subagentDispatch) are read directly from opencode and require no estimation. Supported opencode version range: >=0.18.0 <0.30.0.

- Affected buckets (tokenizer-derived, relative-only): uncachedSystemPrompt, history, toolOutputs
- Authoritative buckets (read directly from opencode): cachedRead, cachedWrite, output, reasoning, subagentDispatch
- Accuracy class: relative-only
- Sum-correctness guarantee: Uncached sub-buckets sum exactly to opencode.session.tokens_input

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

## Findings

- **per_bucket_cost_deferred** (session ses_root_a): session ses_root_a: cost.total = 0.05 is populated from opencode's authoritative session.cost; per-bucket cost fields (cachedRead/cachedWrite/uncachedInput/output/reasoning/subagentDispatch) require recomputing from token counts × model pricing and are deferred to a follow-on spec. Set to null in v1; shape preserved for forward-compat.
- **per_bucket_cost_deferred** (session ses_root_b): session ses_root_b: cost.total = 0.05 is populated from opencode's authoritative session.cost; per-bucket cost fields (cachedRead/cachedWrite/uncachedInput/output/reasoning/subagentDispatch) require recomputing from token counts × model pricing and are deferred to a follow-on spec. Set to null in v1; shape preserved for forward-compat.
- **per_bucket_cost_deferred** (session ses_root_c): session ses_root_c: cost.total = 0.05 is populated from opencode's authoritative session.cost; per-bucket cost fields (cachedRead/cachedWrite/uncachedInput/output/reasoning/subagentDispatch) require recomputing from token counts × model pricing and are deferred to a follow-on spec. Set to null in v1; shape preserved for forward-compat.
