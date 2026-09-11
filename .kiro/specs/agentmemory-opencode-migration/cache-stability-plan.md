# Plan: Cache-Stable AgentMemory Context

Status: implemented with expedited validation at the user's request. No new
regression suite, fake-provider harness, or canary. Existing spec approvals were
not rewritten; the user explicitly authorized immediate implementation.

Implementation baseline: `/Users/brandonmcnama/scratch/agentmemory-opencode-migration`.
The main checkout does not yet contain that worktree's AgentMemory package and
tests. Integrate this addendum with the current worktree without overwriting its
concurrent spec, backup, or rollback changes.

## Goal And Boundary

Eliminate AgentMemory-induced prompt-prefix changes while retaining automatic
startup context, automatic file enrichment, capture, and MCP recall. Extend the
existing `agentmemory-opencode-migration` spec; do not create a new workstream.

Evidence: `memories/2026-09-10-agentmemory-opencode-cache-churn.md`. The deployed
plugin changes system content between requests; file-tool-following requests
had roughly 77% zero cache reads versus 2.7% without recent file tools.

Keep the pinned AgentMemory/OpenCode versions, daemon, REST/MCP routes, database,
importer, BM25 policy, Pi integration, provider settings, and native compaction
policy unchanged. Do not add a second plugin, custom memory store, history
rewriter, capture relay, or durable retry queue.

## Implemented Design

### Stable Startup Snapshot

- Retain the startup instructions and one resolved context snapshot, and render
  both on every eligible system-transform call. Replace the consumed-cache plus
  `contextInjectedSessions` behavior rather than adding another injection layer.
- Scope the guarantee to a session in one loaded plugin runtime. No TTL or refresh
  on tool calls, backend updates, idle summaries, or native compaction.
- Share an in-flight snapshot promise between session creation and the first model
  call. Reuse `/session/start` context for new sessions; use one `/context` lookup
  when resuming without startup state. Late responses cannot replace a snapshot
  already selected for a request.
- Freeze empty/failed retrieval as empty for that lifetime; keep the instructions
  stable and preserve existing timeout/logging behavior. Later recall and file
  enrichment remain available. No background refill of the system prefix.
- Use explicit session IDs for injection; isolate concurrent parent/child sessions
  and clean up snapshot state on deletion/disposal, including resumed sessions.
- A process/plugin restart may select a new snapshot and incur a cold transition.
  Cross-restart snapshot persistence is deliberately outside this bounded fix.

### Append-Only File Enrichment

- Remove `/enrich` and file-dependent text from the system-transform hook.
- Add enrichment to a new tool result through `tool.execute.after`, before
  OpenCode persists it. Preserve the original result as a byte-identical prefix;
  append a clearly delimited supplemental-memory suffix, not apparent file content.
- Enrich only newly produced results. Provider retries, replay, and resume use the
  stored bytes; never re-enrich or patch an already completed historical result.
- Keep tool-derived enrichment bounded to 4,000 new context characters per model
  preparation generation, not per tool. An eligible completion claims its slot before
  awaiting retrieval; parallel completions cannot allocate additional slots.
  Batch currently available paths within the existing count limits. Paths arriving
  after that slot is claimed are not backfilled into history; a later file-tool
  execution can retrieve their context again.
- Start a generation synchronously at each `chat.params` invocation, before any
  await. This identifies OpenCode preparation attempts, not HTTP transport retries
  or user messages. `tool.execute.before` binds `(sessionID, callID)` to that
  generation; `tool.execute.after` uses the binding, never the current user ID.
- A new preparation retires the prior generation. Do not rebind an outstanding
  call on retry/resume. Check that its generation is still current and its call
  nonterminal both before and after retrieval; otherwise leave its output alone.
  Completion/error events release bindings, and session teardown clears all state.
  A missing binding skips enrichment. Verify abort/resume and callback ordering
  through the real runtime, not invented direct-hook ordering.
- Preserve attachment-driven enrichment by adding a valid, tagged synthetic text
  part to the incoming user message in `chat.message`, before persistence.
  Attachments have a separate allowance: one bounded lookup and at most 4,000 new
  context characters per incoming message, shared by all of its attachments.
  Queued/noReply messages each consume their own allowance; there is deliberately
  no claim of a 4,000-character aggregate cap on the next provider request.
  Preserve user text and attachment metadata, and verify valid part IDs, ordering,
  persistence, and aggregate queued-message growth through the actual runtime.
- Do not inject from asynchronous observation/file-event callbacks. Retire stale
  stash producers or route explicitly attributable paths to the next new-result
  boundary; missing attribution must not select another session via a global ID.
- On empty results, failures, or timeouts, return the original tool/message content.
  Do not fail the underlying tool or introduce a retry loop.

### Preserve Capture Semantics

- The existing completed-tool observer receives the persisted, post-hook output.
  Prevent it from recording injected memory as fresh tool evidence.
- Persist a small namespaced injection-span marker: string offset, length, and
  digest of the inserted bytes. Validate its bounds and digest, then remove only
  that span from the capture payload before applying existing truncation limits.
  Preserve any diagnostics OpenCode appends afterward, such as image-omission
  notices. Never truncate capture to the original prefix length or duplicate the
  full raw output in a second store.
- Preserve call-ID deduplication and original title, metadata, and attachments.
  Validate marker handling and duplicate callbacks; never strip arbitrary matching
  text from original output. Invalid markers produce a diagnostic and leave the
  capture content intact rather than deleting unverified data; treat unexpected
  marker failures as a rollout blocker because recapture could then occur.
- Synthetic attachment context remains excluded from user-prompt capture. Ordinary
  assistant responses and capture lifecycle behavior remain unchanged.

### Compaction

Retain fresh memory augmentation of the native compaction prompt. Native
compaction owns summarization and history replacement; the normal startup
snapshot remains unchanged afterward. Persisted enrichment follows ordinary
tool/message history through compaction, with no custom replay or reinsertion.

## Delivery

- Added `overlays/agentmemory-patches/opencode-cache-stability.patch` after the
  existing capture patch, preserving its unrelated lifecycle changes.
- Built `/nix/store/ak753y2frpikr6gx7r0x44s7q3mm58da-agentmemory-0.9.29` and loaded
  its exported plugin factory successfully with Node 24, without network calls.
- Repointed only `~/.config/opencode/plugins/agentmemory-capture.ts` to the rebuilt
  package. No full Darwin/Home Manager switch, daemon restart, or backend change.
- Retained the package GC root at `~/scratch/agentmemory-cachefix-result`.
- Added `scripts/opencode-cache-validate.py` and its Nix wrapper; wired the wrapper
  into Home Manager and installed it immediately at `~/.local/bin/opencode-cache-validate`.

## Stats Validation

The validator reads OpenCode SQLite in read-only/query-only mode and reports
overall, warmed file-associated, and warmed no-recent-file cohorts. It preserves
actual assistant ordering and excludes initial requests, unmeasured rows, model/
agent switches, compaction, and long inter-call gaps from warmed cohorts.

It reports both zero-cache-read request rate and token-weighted non-cache-read
fraction: `sum(input + cache.write) / sum(input + cache.read + cache.write)`.
Results below the sample threshold are `insufficient_data`, never a success claim.
The default threshold is 100 samples per warm cohort and the informational target
is 5%; neither is a deployment gate. No synthetic provider workload is generated.

Post-install comparison boundary: `2026-09-10T18:03:08-04:00`.

```sh
~/.local/bin/opencode-cache-validate --hours 1 --split-at 2026-09-10T18:03:08-04:00
~/.local/bin/opencode-cache-validate --since 2026-09-10T18:03:08-04:00 --session SESSION_ID --json
```

Restart existing OpenCode processes before evaluating the fix. They retain loaded
plugin code; sessions in an old process can keep producing misses after the
installation timestamp. Use repeatable `--session` filters to select sessions
running in restarted processes. The initial stats run includes old processes and
is not evidence of post-fix improvement.

No regression tests, feature matrix, or canary were run, as explicitly requested.
Only package build/load and validator syntax/help/read-only execution were checked.

## Activation And Rollback

The emergency leaf symlink bypasses the old Home Manager link chain to avoid
activating unrelated in-flight configuration. The declarative overlay has the
same fix. A future Home Manager activation restores its normal link when content
matches; a differing target can require restoring the old managed leaf first.

Original leaf target:
`/nix/store/xyqrd416ns3kpjjiwz8r73l4qwb3jazm-home-manager-files/.config/opencode/plugins/agentmemory-capture.ts`.

Roll back the plugin link/package only if needed, then restart OpenCode. Do not
delete or migrate the memory store or rewrite session histories.

## Alternatives Not Selected

- Disable file enrichment: smaller mitigation, but removes automatic functionality.
  Do not make this the default fix or rely on the ineffective
  `AGENTMEMORY_INJECT_CONTEXT=false` setting for OpenCode.
- Memoize enrichment but leave it in the system prompt: file changes and the
  presence/absence transition still invalidate the prefix.
- Add a persistent snapshot database or custom compaction/history layer: unnecessary
  for the demonstrated within-runtime regression and outside the existing boundary.

## Verified Integration Seams

- Installed `agentmemory-capture.ts:747-825`: affected injection hooks.
- Installed `agentmemory-capture.ts:520-539`: completed-output capture feedback path.
- OpenCode 1.18.26 `session/tools.ts:111-129`: after-hook output returned to persistence.
- OpenCode 1.18.26 `session/processor.ts:390-412`: native diagnostics can follow injection.
- OpenCode 1.18.26 `session/prompt.ts:995-1047`: incoming message hook precedes persistence.
- Existing migration requirements 2.4, 2.6-2.8 and design `ExistingPluginPatch`.
