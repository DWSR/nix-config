# Brief: agentmemory-opencode-migration

## Problem

The OpenCode harness uses cavemem for ambient memory, while AgentMemory now
ships an existing OpenCode capture plugin and a broader memory runtime. The
operator wants OpenCode to use AgentMemory without changing current Pi behavior
or blocking use of AgentMemory's Pi plugin later.

## Current State

Both hosts declaratively enable cavemem capture, startup checks, compaction
augmentation, vault synthesis, memory-sync, and backup. Pi separately uses the
same cavemem package. AgentMemory v0.9.29 plus commit `e04ba888` provides a
daemon, MCP shim, `plugin/opencode/agentmemory-capture.ts`, and
`integrations/pi/`, but its stock behavior has known capture, persistence,
scoping, and lifecycle limitations.

## Desired Outcome

OpenCode uses a declaratively packaged AgentMemory runtime, its patched existing
OpenCode plugin, stock automatic context injection, and AgentMemory's core MCP
tools through mcpproxy. Existing OpenCode cavemem history receives a one-shot
best-effort import. Pi stays on cavemem, and AgentMemory's bundled Pi integration
remains packaged and compatible for future activation.

## Approach

Favor upstream behavior over custom guarantees. Pin AgentMemory at `e04ba888`
and iii-engine v0.11.2, install the existing upstream OpenCode plugin with a
small inline patch for current OpenCode event compatibility, and register the
stock AgentMemory MCP shim in core-tool mode through mcpproxy. Run the standard
runtime under Home Manager and launchd. Do not build a custom capture relay,
capability descriptor, read facade, raw-event store, materialization ledger, or
iii persistence patch.

Migrate non-importer cavemem sessions once with deterministic IDs and bounded
batches. Disable cavemem-specific compaction augmentation, vault synthesis, and
memory-sync instead of porting them. Keep manual Obsidian memory curation and
the vault curator.

## Scope

- **In**: Reproducible AgentMemory and iii packages; existing OpenCode plugin
  patch and declarative install; standard daemon and core MCP wiring; startup
  health check; nono loopback/env changes; one-shot history import; simple
  stopped-runtime backup; host cutover and rollback; current/future Pi
  compatibility checks.
- **Out**: Custom capture transport; raw transcript fidelity beyond stock
  AgentMemory; exact worktree/same-basename project isolation; crash-resumable
  migration; transactional import; proven iii flush semantics; exhaustive
  backup restore; porting session-compaction memory augmentation, vault
  synthesis, or memory-sync; AgentMemory activation for Pi.

## Boundary Candidates

- Package and runtime: pinned sources, managed paths, launchd, health, and
  simple stopped-state backup.
- Existing plugin integration: inline patch, automatic context, declarative
  discovery, and standard REST capture.
- MCP and instructions: stock core tools through mcpproxy and updated global
  AgentMemory guidance.
- Migration and cutover: one-shot import, host selection, rollback, and removal
  of OpenCode-owned cavemem behavior.
- Pi compatibility: current cavemem remains unchanged; bundled AgentMemory Pi
  sources and standard routes remain available for a future spec.

## Out of Boundary

- Changes under Pi-owned implementation paths except compatibility and
  non-regression tests.
- Migration of Pi cavemem data or AgentMemory credentials/configuration for Pi.
- Security isolation between the in-process OpenCode plugin and model-invoked
  OpenCode subprocesses.
- Recovery of an import interrupted after AgentMemory accepts only part of a
  batch; rerunning is the supported recovery.
- Repairing upstream iii-engine memory, orphan-process, shutdown, or flush bugs.

## Upstream / Downstream

- **Upstream**: AgentMemory `e04ba888`, iii-engine v0.11.2, existing AgentMemory
  OpenCode and Pi plugins, pinned OpenCode, mcpproxy, nono, cavemem, and
  Obsidian.
- **Downstream**: OpenCode startup and recall, manual Obsidian curation, simple
  backup, rollback, and a possible future Pi AgentMemory spec.

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
- Accept stock AgentMemory compression, indexing, project naming, session
  consolidation, MCP fallback, and persistence behavior.
- Preserve AgentMemory's `integrations/pi/` layout and standard Pi REST routes.
- Keep current Pi cavemem data and behavior unchanged.
