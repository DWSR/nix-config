# AgentMemory Performance Risks and Improvements

This document records the performance and reliability risks identified in the
managed AgentMemory deployment, the evidence behind them, and the proposed
improvement order. It covers the pinned AgentMemory `0.9.29` package at
revision `0d9306db408b1243a5b27dfa0d0c3c2790d9f6a6` and iii-engine `0.11.5`.

## Current Profile

AgentMemory is the OpenCode memory backend on the personal and Shopify hosts.
The managed runtime uses:

| Area | Current configuration |
| --- | --- |
| BM25 in-memory cap | `100000` entries |
| BM25 persistence cap | `50000` entries |
| Shopify LLM compression | Disabled |
| Shopify embeddings | OpenAI-compatible provider, `text-embedding-3-small` |
| Shopify graph extraction | Enabled |
| MCP exposure | Eight stock core tools through mcpproxy |
| OTel worker and engine exporters | Disabled in the current tree |

The relevant configuration is in `home-manager/common/agentmemory.nix`,
`configurations/shopify/home-manager/default.nix`, and
`overlays/agentmemory.nix`.

## Evidence

The evaluation found the following concrete signals:

- A historical log entry recorded a BM25 rebuild of `645646` entries followed
  by V8 heap exhaustion at approximately 4.1 GB.
- The local AgentMemory error log contained approximately 714,000 lines and
  118 MB of output.
- The same log contained 14,679 compression XML parse failures, 5,918
  successful compressions marked as retried, 24,600 enrichment completions,
  and 25,007 search completions.
- `memory_sessions` returned 9,351 session records. An all-category
  `memory_diagnose` call timed out while scanning the corpus.
- `agentmemory-status` reported `failed-startup` and `health=unreachable`
  because the launchd wrapper could not resolve the bearer from Keychain.
  Listening ports were present, so stale listeners must not be treated as a
  healthy daemon.
- The correctness harness disables the expensive production paths with a noop
  provider, disabled auto-compression, disabled graph extraction, and disabled
  consolidation. It does not represent the Shopify workload.

The log measurements are historical observations from the host-local runtime,
not a substitute for a controlled benchmark.

## Risk Register

| ID | Priority | Risk | Impact | Status |
| --- | --- | --- | --- | --- |
| R1 | P0 | Oversized persisted BM25 indexes can be restored without applying the live cap. | Node heap exhaustion, daemon crash, failed startup, and long rebuilds. | Open |
| R2 | P0 | The BM25 in-memory cap is higher than the persistence cap. Serialization rejects indexes over the persistence limit instead of saving a bounded snapshot. | Repeated persistence failures and full rebuilds after restart. | Open |
| R3 | P0 | Compression, embedding, and graph work can grow faster than the capture workload. | iii-engine queue pressure, provider saturation, memory growth, and user-visible latency. | Open |
| R4 | P0 | The daemon can fail Keychain startup while old listeners remain observable. | OpenCode preflight failures and misleading health signals. | Open |
| R5 | P1 | Each observation performs several KV and stream operations, and the plugin awaits REST capture calls. | Per-event latency and reduced capture throughput. | Open |
| R6 | P1 | The observation limit check lists the entire session before reading the session counter. | O(n) work per observation and O(n^2) behavior in long sessions. | Open |
| R7 | P1 | Context generation lists all sessions and lessons before selecting a small project-local subset. | Startup context latency and engine response pressure as the corpus grows. | Open |
| R8 | P1 | File enrichment scans sessions, observations, and memories and runs on the tool path. | File tools and subsequent model turns wait on global scans. | Open |
| R9 | P1 | The OpenCode plugin does not consistently pass project scope to enrichment and search work. | More candidates, worse relevance, and unnecessary cross-project IO. | Open |
| R10 | P1 | Session summaries and graph extraction can rescan full sessions on lifecycle events. | Duplicate reads, duplicate LLM work, and growing stop/session latency. | Open |
| R11 | P1 | Persistence serializes complete BM25 and vector indexes and writes shards plus audit records. | CPU, memory copies, KV write bursts, and possible overlapping saves. | Open |
| R12 | P1 | The vector index is unbounded and performs an exact scan for every vector query. | Query latency and memory usage grow linearly with embedded observations. | Open |
| R13 | P2 | BM25 prefix expansion and full result sorting can become expensive on large vocabularies. | Search p95 grows with term and posting-list cardinality. | Open |
| R14 | P2 | Smart search combines BM25, embeddings, graph retrieval, and lesson recall. | A single recall request can trigger several independent expensive paths. | Open |
| R15 | P2 | Context is injected into every model request even when the startup snapshot is unchanged. | Repeated input tokens, context-window pressure, and model cost. | Open |
| R16 | P2 | Auto-forget, retention, consolidation, and diagnostics use broad corpus scans. | Maintenance work competes with interactive work and can time out. | Open |
| R17 | P2 | Patch files target upstream source with fuzz-prone context. | Upstream drift can break activation or silently weaken patch correctness. | Open |
| R18 | P2 | High-volume structured logging creates large local log files. | Disk IO, log retention pressure, and slower diagnostics. | Partially mitigated |
| R19 | P2 | Production performance is not covered by a representative benchmark or soak test. | Regressions can pass correctness tests unnoticed. | Open |

## Priority Improvements

### P0: Prevent Crashes and Unbounded Work

#### 1. Guard persisted index loading

Files: `overlays/agentmemory-patches/bm25-index-cap.patch`, upstream
`src/state/search-index.ts`, upstream `src/state/index-persistence.ts`.

Implement all of the following:

- Apply the configured cap in `deserialize()` and `restoreFrom()`, not only in
  `add()`.
- Store an entry count in the persistence manifest and reject stale or
  oversized generations before allocating a full index copy.
- Add an explicit stale-index recovery path that preserves observations and
  memories while discarding only the derived index.
- Make the in-memory and persisted defaults coherent. Start with `50000` for
  both until a corpus benchmark justifies a larger value.
- Add regression fixtures for an oversized persisted index and a restart after
  an interrupted save.

R1 is the highest priority because the observed failure is a process-fatal OOM.
Increasing the Node heap is not a sufficient fix.

#### 2. Bound background processing

Files: upstream `src/functions/compress.ts`, `src/functions/graph.ts`,
`src/triggers/events.ts`, and Shopify host wrapper configuration.

- Put LLM compression behind a bounded queue with an explicit concurrency cap.
- Preserve synthetic compression as the immediate searchable representation.
- Retry only transient/provider failures; cap XML parse retries and record the
  failed observation for later repair.
- Process graph extraction incrementally over new observations, with a maximum
  batch size and a durable cursor.
- Do not send an entire session to graph extraction on every stop event.
- Keep graph extraction and auto-compression disabled during recovery or bulk
  import, then re-enable them after queue depth and memory are observable.

#### 3. Make daemon health authoritative

Files: `home-manager/common/agentmemory.nix`,
`scripts/agentmemory-status.nix`, and the launchd wrapper.

- Ensure failed Keychain resolution removes or invalidates stale runtime
  metadata rather than leaving healthy-looking listeners.
- Keep liveness, authenticated health, and worker/engine identity checks
  distinct.
- Expose queue depth, index readiness, index sizes, and last persistence result
  in the status output.
- Do not benchmark or declare the service healthy when the bearer check fails.

### P1: Reduce Interactive Latency and Write Amplification

#### 4. Batch capture writes

Files: the patched OpenCode plugin and upstream `src/functions/observe.ts`.

Replace one awaited REST request per event with a bounded client queue or a
batch observation endpoint. Preserve ordering per session and define behavior
when the queue is full:

- Keep prompts, tool failures, completed tool calls, and assistant summaries.
- Drop or sample low-value status and notification events first.
- Keep a bounded timeout so an AgentMemory outage cannot stall OpenCode.
- Make viewer stream publication asynchronous when the viewer is not in use.

#### 5. Remove repeated session enumeration from observation capture

In `mem::observe`, read the session's `observationCount` under the existing
per-session lock and reject at the configured limit. Use a one-time fallback
enumeration only for legacy sessions that have no counter. This removes the
current full-session list from every observation.

#### 6. Replace global context scans with maintained indexes

Files: upstream `src/functions/context.ts` and `src/state/kv.ts`.

Maintain bounded recent-session data by project and agent. Context generation
should not list every session and every lesson to select ten recent sessions.
Possible implementations, in increasing order of scope:

- Cache the project context with invalidation on session end and summary write.
- Maintain a project-to-session recent index.
- Add paginated or prefix-scoped KV listing instead of only unbounded `list()`.

#### 7. Make enrichment project-scoped and indexed

Files: `overlays/agentmemory-patches/opencode-cache-stability.patch`, upstream
`src/functions/enrich.ts`, `src/functions/file-index.ts`.

- Pass `projectFor(sessionId).name` through `/enrich`.
- Maintain a file-to-observation and file-to-memory index on compressed writes.
- Replace the current scan of recent sessions and all bug memories with indexed
  lookups.
- Cache repeated file lookups during a session.
- Keep enrichment off the critical path for low-value reads, or cap it to once
  per model turn.

#### 8. Make lifecycle work incremental

Files: upstream `src/functions/summarize.ts`, `src/functions/graph.ts`,
`src/triggers/events.ts`.

- Track the last summarized observation and summarize only new data.
- Debounce summaries per session.
- Share the loaded compressed observation batch between summary and graph work.
- Run full consolidation and crystallization only on a scheduled maintenance
  path, not as a direct response to every session lifecycle event.
- Keep the existing global consolidation cooldown, but ensure direct plugin
  routes cannot bypass it with forced full-corpus requests.

#### 9. Make persistence incremental and serialized

Files: upstream `src/state/index-persistence.ts` and
`overlays/agentmemory-patches/bm25-index-cap.patch`.

- Prevent overlapping saves with one in-flight save and one dirty bit.
- Coalesce changes over a load-aware interval instead of serializing every five
  seconds under sustained writes.
- Persist deltas or a bounded append log; compact to a full snapshot during
  maintenance or shutdown.
- Aggregate ordinary shard audit events instead of emitting one audit write per
  shard.

#### 10. Bound vector indexing

Files: upstream `src/state/vector-index.ts` and `src/functions/search.ts`.

- Evict vectors with the same retention policy as BM25 entries.
- Remove vectors when BM25 entries are evicted.
- Record vector count and query scan duration.
- Use approximate nearest-neighbor search or a project-partitioned candidate
  set when the embedded corpus exceeds the measured linear-scan threshold.

### P2: Improve Search Cost, Token Cost, and Operability

#### 11. Optimize BM25 candidate generation

Files: upstream `src/state/search-index.ts` and `src/state/hybrid-search.ts`.

- Bound prefix expansion for short query terms.
- Use a top-k heap instead of sorting every matching document.
- Cache sorted terms and invalidate only when the vocabulary changes.
- Partition or prefilter by project before scoring when a project is known.
- Reduce the current over-fetch multiplier for filters after project indexes are
  available.

#### 12. Reduce smart-search fan-out

Files: upstream `src/functions/smart-search.ts` and `src/state/hybrid-search.ts`.

Measure each stream separately, then make expensive streams conditional:

- Run lesson recall only when lessons are requested or likely relevant.
- Run graph retrieval only when entity hints are present.
- Use BM25-only recall for exact file/path queries.
- Use embeddings only for semantic queries that do not produce adequate BM25
  candidates.

#### 13. Control repeated context injection

Files: `overlays/agentmemory-patches/opencode-cache-stability.patch` and
`home-manager/common/agents-agentmemory.md`.

The current cache prevents repeated `/context` server calls, but the same
startup context is appended to each model request. Add an explicit policy for:

- A smaller startup context budget.
- Refresh on compaction or project change rather than every request.
- A concise static tool instruction block.
- Prompt caching where the provider supports it.

Measure input tokens and time-to-first-token before changing injection cadence.

#### 14. Move maintenance off interactive capacity

Review auto-forget, retention scoring, diagnostics, consolidation, and reflect
operations. Each should have:

- A bounded page size.
- A resumable cursor.
- A maximum work budget per run.
- A metric for rows scanned, rows changed, and elapsed time.

Maintenance should yield to interactive capture and search work.

#### 15. Reduce local log volume

OTel metrics, traces, and engine observability are disabled in the current tree
by `overlays/agentmemory-patches/disable-otel.patch` and the environment in
`home-manager/common/agentmemory.nix`. Normal local logs remain available via
the SDK console fallback and launchd log files.

Remaining work:

- Rate-limit repetitive compression failure messages.
- Aggregate observation-captured messages by interval and hook type.
- Add log rotation or a bounded retention policy for AgentMemory logs.
- Keep detailed per-observation logging behind an explicit debug flag.

#### 16. Harden patch maintenance

Existing AgentMemory patches apply with fuzz against the pinned source. Treat
fuzz as a release risk:

- Keep each patch scoped to one source file or configuration asset.
- Add package-build coverage for every patch.
- Review rejected hunks as a hard failure.
- Refresh patches deliberately when the upstream revision changes.

## Measurement Plan

Add a benchmark profile separate from the correctness suite. Run it with the
same feature combinations used in production:

| Dimension | Required cases |
| --- | --- |
| Corpus size | 10K, 50K, 100K, and historical large-corpus fixtures |
| Session count | 100, 1K, and 10K sessions |
| Search mode | BM25-only, BM25 plus graph, hybrid vector, smart search |
| Capture mode | Synthetic compression, bounded LLM compression, graph extraction |
| Query shape | Exact paths, short terms, project terms, semantic questions |
| Failure mode | Daemon restart, stale index, provider timeout, Keychain failure |

Record:

- Search, context, enrichment, and capture p50/p95/p99 latency.
- Node heap, RSS, CPU, event-loop delay, and iii-engine queue depth.
- BM25 entry count, vocabulary size, vector count, serialized bytes, and save
  duration.
- Observations captured per second and dropped or delayed events.
- LLM request count, retry count, parse failure count, and token usage.
- Context and enrichment output token counts.
- Startup time to authenticated health and index-ready state.

Suggested acceptance gates:

- No process-fatal OOM at the largest supported corpus.
- No index persistence failure under the configured cap.
- Interactive capture and context p95 remain within the agreed OpenCode
  latency budget while maintenance is active.
- A daemon restart does not trigger an unbounded rebuild.
- Provider and Keychain failures degrade capture without blocking OpenCode.

## Rollout Order

1. Recover the bearer and establish a trustworthy health baseline.
2. Add persisted-index load guards and align BM25/vector eviction behavior.
3. Run the large-corpus restart and persistence benchmark.
4. Bound graph queues before enabling Shopify's remaining expensive feature
   flags.
5. Remove per-observation enumeration and reduce capture write amplification.
6. Add project/file indexes for context and enrichment.
7. Serialize or delta-encode index persistence.
8. Tune BM25, vector retrieval, smart-search fan-out, and context injection from
   measured p95 data.
9. Add scheduled, resumable maintenance and log retention.

## References

- `home-manager/common/agentmemory.nix`
- `configurations/shopify/home-manager/default.nix`
- `overlays/agentmemory.nix`
- `overlays/agentmemory-patches/bm25-index-cap.patch`
- `overlays/agentmemory-patches/opencode-capture.patch`
- `overlays/agentmemory-patches/opencode-cache-stability.patch`
- `overlays/agentmemory-patches/disable-otel.patch`
- `tests/agentmemory-opencode/core-surface.test.js`
- `tests/agentmemory-opencode/capture-smoke.test.js`
- `tests/agentmemory-opencode/package-contract.test.js`
- Pinned upstream source: `https://github.com/DWSR/agentmemory/tree/0d9306db408b1243a5b27dfa0d0c3c2790d9f6a6`
