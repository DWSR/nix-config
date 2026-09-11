# Research and Gap Analysis

## Summary

- **Feature**: `agentmemory-opencode-migration`
- **Discovery scope**: Complex brownfield integration.
- **Key findings**: AgentMemory supplies a usable OpenCode integration but has
  known capture, project, persistence, fallback, credential, and large-corpus
  limitations. The amended design adds bounded operational exceptions and keeps
  Pi outside this feature.

## External Findings

Research date: 2026-09-05.

### Release and Runtime

- Latest published agentmemory release is `v0.9.29` from 2026-08-16. The
  required cwd-stable persistence repair is unreleased commit `e04ba888` from
  2026-08-23.
  [release](https://github.com/rohitg00/agentmemory/releases/tag/v0.9.29)
  [commit](https://github.com/rohitg00/agentmemory/commit/e04ba88819c365c9acf9d6661ea802143e728bd6)
- Agentmemory requires Node 20 or newer and pins `iii-engine v0.11.2`. Its local
  runtime exposes REST, stream, viewer, and engine ports. Durable state is a
  directory of rkyv-wrapped `.bin` values, not SQLite.
  [architecture](https://agent-memory.dev/docs/how-it-works.md)
  [iii storage](https://github.com/iii-hq/iii/blob/iii/v0.11.2/engine/src/builtins/kv.rs)
- Agentmemory issue #1312 reports unbounded memory growth, orphaned iii-engine
  processes, and shutdown hangs on Linux and macOS. Newer iii releases are not
  protocol/config compatible with the pinned agentmemory SDK.
  [issue #1312](https://github.com/rohitg00/agentmemory/issues/1312)
- Agentmemory and its MCP package are Apache-2.0. iii-engine is Elastic License
  2.0; local use is compatible, while remote/shared service use requires a
  separate policy decision.
  [agentmemory license](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/LICENSE)
  [iii license](https://github.com/iii-hq/iii/blob/iii/v0.11.2/engine/LICENSE)

### OpenCode Integration

- OpenCode is directly supported through a REST capture plugin and an MCP shim.
  `connect opencode` writes an MCP entry and guidelines but does not reliably
  install the capture plugin; it is unsuitable for declarative Home Manager.
  [guide](https://agent-memory.dev/docs/integrations/opencode.md)
  [connector](https://github.com/rohitg00/agentmemory/blob/main/src/cli/connect/opencode.ts)
- The existing plugin is
  `plugin/opencode/agentmemory-capture.ts` with named export
  `AgentmemoryCapturePlugin`. The npm package publishes the source, metadata,
  commands, and full `plugin/` tree, but does not expose an import subpath.
  Declarative installation must materialize the patched upstream file under
  OpenCode's plugin directory; `connect opencode` remains unused.
  [plugin](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/plugin/opencode/agentmemory-capture.ts)
- The plugin captures prompts, tool activity, reasoning, patches, permissions,
  todos, commands, model parameters, configuration, compaction, and session
  metadata. It records assistant metadata but not assistant response text.
- Keyless synthetic compression overwrites raw observations with a combined
  narrative truncated to 400 characters. This cannot replace cavemem's full
  observations for migration, replay, or vault synthesis.
  [issue #1196](https://github.com/rohitg00/agentmemory/issues/1196)
- The plugin closes sessions only on `session.deleted`; normal idle or process
  exit can leave sessions active and skip final consolidation.
- Capture REST requests are awaited for up to five seconds. Context and per-file
  enrichment are injected even when the documented injection switch is off.
  Injection can destabilize prompt caching and be consumed by an auto-title
  request before the real conversation.
  [issue #720](https://github.com/rohitg00/agentmemory/issues/720)
  [issue #1184](https://github.com/rohitg00/agentmemory/issues/1184)

### Post-Import Operational Findings

Validation date: 2026-09-09.

- Importing 7,515 sessions and roughly 650,000 observations exhausted the 4 GiB
  Node heap because AgentMemory keeps BM25 term maps and posting sets in memory,
  then duplicates them during persistence serialization. Upstream issue #309
  identifies the unresolved in-memory architecture.
- The selected local policy retains every observation in KV, keeps the newest
  100,000 BM25 entries, and refuses persistence serialization above 50,000.
- Node 24.19.0 aborts `better-sqlite3` statement cleanup. The importer and its
  native dependency closure use Node 22 with one ABI-aligned `importNpmLock`
  hook.
- Aggregate dry-run JSON exceeded V8's string limit, and candidate batch sizing
  was quadratic. Streaming output, SQLite iterators, linear preparation, and
  conservative incremental byte accounting are required.
- AgentMemory health uses authenticated `healthy`, `degraded`, and `critical`
  states. HTTP-200 degraded is usable; fallback, critical, unauthenticated, and
  unavailable states are not.
- The user-facing CLI and managed status command require Keychain-backed bearer
  wrappers. The personal encrypted bearer is deferred until personal activation.
- Stopping the runtime for a backup is not an acceptable operator workflow, so
  this feature does not provide a backup command or destination.
- This feature does not add an OpenCode rollback specialization or validate
  migration reversal.

### Retrieval, Isolation, and Privacy

- The full daemon exposes 54 MCP tools by default; `core` still includes writes.
  The surface includes deletion, files, snapshots, healing, actions, and
  coordination beyond harness recall.
  [MCP tools](https://agent-memory.dev/docs/mcp-tools.md)
- If the daemon is unavailable, the MCP shim silently falls back to seven local
  tools and `~/.agentmemory/standalone.json`. Fallback search lacks the daemon's
  graph, vector, compression, and consolidation behavior.
- MCP recall does not accept a project selector. Project detection uses an
  explicit variable, Git root basename, then cwd basename; basename collisions
  and linked worktrees remain an accepted isolation limitation in the
  simplified design.
  [provenance](https://agent-memory.dev/docs/provenance.md)
- Live capture redacts private markers and fixed credential patterns. Manual
  saves and imports bypass that path; configurable live-capture exclusions and
  PEM-block coverage are missing.
  [privacy source](https://github.com/rohitg00/agentmemory/blob/main/src/functions/privacy.ts)
- REST and viewer endpoints are unauthenticated on loopback unless
  `AGENTMEMORY_SECRET` is configured. The stock plugin needs that bearer secret
  and direct REST access, creating a privilege seam outside mcpproxy.

### Export and Migration

- JSON export and REST import exist, but only session collections paginate.
  Complete exports can exceed iii's 16 MiB frame. There is no OpenCode or
  cavemem importer.
  [exports](https://agent-memory.dev/docs/exports.md)
- Agentmemory lacks cavemem's exact `list_sessions` + time-bounded `timeline` +
  batched full-observation MCP contract. Current consumers need an adapter over
  the daemon's lower-level data.

## Current OpenCode Assets

- `home-manager/common/cavemem.nix` owns the existing adjacent cavemem package,
  settings, mcpproxy upstream, environment, and preflight.
- `home-manager/common/opencode-plugins/cavemem.js` captures session lifecycle
  and tools through detached child commands. It does not capture prompts,
  assistant text, or hook failures.
- `home-manager/common/opencode.nix` and
  `scripts/opencode-nono-launcher.nix` compose the OpenCode launch, global
  instructions, preflight, and agent inventory.
- `home-manager/common/opencode-nono.nix` grants AgentMemory ports/env only for
  the AgentMemory backend; existing cavemem access remains adjacent state.
- `home-manager/common/session-compaction.nix` and
  `home-manager/common/session-compaction-internal/session-compaction-impl.ts`
  invoke `cavemem search` for compaction context.
- `home-manager/common/agents/vault-synthesizer.md` and
  `scripts/memory-sync.nix` depend on cavemem sessions, timeline, observations,
  health, and `cavemem-session-*` provenance.
- `configurations/shopify/home-manager/sqlite-backup.nix` protects SQLite files;
  it cannot snapshot agentmemory's directory store consistently.
- Pi-owned overlays and harness files are adjacent and excluded from this
  feature's gap analysis.
- Existing AgentMemory tests cover package, plugin, importer, health, and
  consumer behavior but are not all registered under the flake check.

## Requirement-to-Asset Gap Map

| Requirements | Existing assets | Gap |
|---|---|---|
| 1 | Pinned package, lock, module, plugin install | **Implemented** |
| 2 | Patched OpenCode plugin and bounded BM25 | **Implemented** |
| 3 | Core MCP registration and authenticated preflight | **Implemented** |
| 4 | Bounded/scalable importer | **Remaining** configured endpoint wiring |
| 5 | Compaction, synthesizer, memory-sync, instructions | **Remaining** force compaction augmentation off |
| 6 | Nono, Keychain, wrappers, health | **Implemented** |

## Implementation Options

### Option A: Thin Upstream AgentMemory Integration

Package the standard runtime, patch the existing OpenCode plugin, use stock core
MCP tools, and disable unported cavemem consumers.

- Pros: thin integration with explicit, measured operational bounds.
- Cons: accepts stock credential, compression, fallback, project, and durability
  limitations. **Selected.**

### Option B: Hardened Adapter Architecture

Add a capture relay, custom read facade, raw storage, durable import journal, and
patched iii flush semantics.

- Pros: stronger isolation and recovery.
- Cons: produced 54 tasks and duplicated upstream behavior. Rejected after scope
  reduction.

### Option C: Wait for Upstream Fixes

Delay the migration until persistence, lifecycle, and OpenCode issues land.

- Pros: fewer local deviations.
- Cons: indefinite schedule and no current cutover. Rejected by the operator.

## Complexity and Risk

- Effort: **M**. Remaining work is endpoint wiring, forced compaction cutover,
  and complete validation registration.
- Risk: **High**. The implementation retains upstream fallback, project, and
  data-fidelity limitations while carrying a local BM25 policy.

## Simplification Decision

The original design translated every upstream limitation into custom
infrastructure and produced 54 implementation tasks. The operator selected a
balanced reduction to stock AgentMemory behavior and roughly half as many tasks.

### Retained

- Pin AgentMemory at `e04ba888` with a reproducible npm closure and managed
  iii-engine v0.11.2 runtime.
- Patch and install the existing
  `plugin/opencode/agentmemory-capture.ts` entrypoint rather than replacing it.
- Correct high-value OpenCode capture gaps: assistant text, tool lifecycle,
  current event names, and normal disposal.
- Use stock automatic context and the stock MCP shim in core-tool mode through
  mcpproxy.
- Import cavemem history with deterministic IDs and bounded batches.
- Bound large-history indexing and persistence without pruning stored records.
- Keep Pi outside the implementation and validation boundary.

### Removed

- Capture relay, inherited capability descriptor, and nono/OpenCode-core patches.
- Immutable raw-event scope, producer-qualified custom keys, materialization
  ledger, repair route, and custom read-only MCP facade.
- Exact worktree/same-basename isolation and session-stable custom injection.
- Durable migration journal, transactional reconciliation, and crash recovery.
- Patched iii flush barrier and automated restore.
- AgentMemory adapters for session-compaction augmentation, vault synthesis, and
  memory-sync. Those cavemem-dependent features are disabled at cutover.

### Accepted Consequences

- The OpenCode process receives the standard AgentMemory bearer; subprocess
  isolation is not guaranteed.
- Stock observation compression, truncation, consolidation, project naming, and
  fallback apply. BM25 capacity and persistence are explicit local exceptions.
- Import recovery is rerun-with-skip, not transactional resume.
- Obsidian remains manually curated; automatic cavemem-to-Obsidian promotion is
  removed.

## Residual Validation Items

- Wire the configured importer endpoint and enforce compaction cutover.
- Validate both host AgentMemory renderings.
- Register the complete feature suite and remove linked-worktree assumptions.
