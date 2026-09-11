# Brief: agentmemory-opencode-migration

## Problem

The OpenCode harness used cavemem for ambient memory. AgentMemory supplies an
OpenCode plugin and broader runtime, but its stock large-corpus index, importer,
health, and CLI behavior did not remain operable after real history migration.

## Current State

AgentMemory v0.9.29 plus commit `e04ba888` now provides OpenCode capture, MCP,
launchd, and import paths. A 7,515-session migration exposed unbounded
BM25 memory, unsafe index persistence, Node 24 native-addon failure, silent and
quadratic import phases, and health/CLI authentication gaps. Pi is independently
managed and is not part of this spec.

## Desired Outcome

OpenCode uses a declaratively packaged AgentMemory runtime, patched upstream
plugin, automatic context injection, and core MCP tools through mcpproxy.
Cavemem history remains stored for later processing while BM25 recall is bounded.
Both hosts render the normal AgentMemory generation. This feature does not
render an OpenCode rollback activation or validation path. Pi behavior remains
outside this feature.

## Approach

Keep the thin upstream integration, with explicit operational exceptions proven
necessary by the migrated corpus. Cap live BM25 indexing at 100,000 entries and
refuse persistence serialization above 50,000. Run native SQLite import tooling
on Node 22, stream large output, size batches linearly, and show progress. Resolve
bearers through the managed Keychain wrapper and accept HTTP-200 degraded health
without accepting fallback or critical state.

Disable cavemem-specific OpenCode consumers instead of porting them. Bake the
configured REST endpoint into the importer. Keep manual Obsidian curation and
all Pi behavior outside this boundary.

## Scope

- **In**: Reproducible AgentMemory and iii packages; existing OpenCode plugin
  patch and declarative install; standard daemon and core MCP wiring; startup
  health check; bounded BM25 exception; nono loopback/env changes; one-shot
  history import; host cutover; complete feature validation.
- **Out**: Custom capture transport; raw transcript fidelity beyond stock
  AgentMemory; exact worktree/same-basename project isolation; crash-resumable
  migration; transactional import; proven iii flush semantics; exhaustive
  backup workflows; porting session-compaction memory augmentation, vault
  synthesis, or memory-sync; OpenCode rollback activation and validation; every
  Pi package, integration, credential, health, migration, and validation
  concern.

## Boundary Candidates

- Package and runtime: pinned sources, managed paths, launchd, and health.
- Existing plugin integration: inline patch, automatic context, declarative
  discovery, and standard REST capture.
- MCP and instructions: stock core tools through mcpproxy and updated global
  AgentMemory guidance.
- Migration and cutover: one-shot import, host selection, and removal of
  OpenCode-owned cavemem behavior.
- Operational bounds: BM25 capacity/persistence, importer runtime/complexity,
  authenticated CLI status, and degraded health.

## Out of Boundary

- OpenCode rollback activation and validation.
- Pi configuration, packages, integrations, credentials, runtime behavior,
  migration, and compatibility validation.
- Security isolation between the in-process OpenCode plugin and model-invoked
  OpenCode subprocesses.
- Recovery of an import interrupted after AgentMemory accepts only part of a
  batch; rerunning is the supported recovery.
- Repairing upstream iii-engine memory, orphan-process, shutdown, or flush bugs.

## Upstream / Downstream

- **Upstream**: AgentMemory `e04ba888`, iii-engine v0.11.2, the existing
  AgentMemory OpenCode plugin, pinned OpenCode, mcpproxy, nono, existing cavemem
  assets, and Obsidian.
- **Downstream**: OpenCode startup/recall, manual Obsidian curation, and later
  offline processing of unindexed history.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `cavemem-integration`, `session-compaction`,
  `vault-synthesizer-agent`, `memory-sync-cli`, `sqlite-backup`,
  `mcpproxy-migration`, `opencode-nono-sandbox`, and `pi-agent-integration`.

## Constraints

- Use declarative Nix and Home Manager; do not run `connect opencode`.
- Preserve the upstream OpenCode plugin filename, named export, metadata,
  license, hook inventory, source revision, and patch provenance.
- Keep mcpproxy as OpenCode's only MCP entrypoint; expose AgentMemory's stock
  core tool set rather than a custom facade.
- Bind AgentMemory to loopback and authenticate it. The stock plugin receives
  the bearer in the OpenCode process environment; stronger subprocess isolation
  is intentionally out of scope.
- Accept stock compression, project naming, session consolidation, and MCP
  fallback. BM25 capacity and persistence are the only query/persistence
  exceptions owned here.
- Keep all imported observations in KV; index eviction must not prune source or
  imported records needed for later processing.
- The personal encrypted bearer is deferred until personal host activation.
  Evaluation documents the reference; activation must provision it before use.
