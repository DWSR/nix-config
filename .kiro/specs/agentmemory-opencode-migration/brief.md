# Brief: agentmemory-opencode-migration

## Problem

The OpenCode and Pi harnesses use cavemem for ambient memory, while AgentMemory
ships existing OpenCode and Pi integrations plus a broader memory runtime. The
operator wants both harnesses to use AgentMemory, with cavemem retained only as
an explicit OpenCode rollback backend.

## Current State

Both hosts declaratively enable cavemem capture, startup checks, compaction
augmentation, vault synthesis, memory-sync, and backup. Pi separately uses the
same cavemem package and its Pi-specific patches. AgentMemory v0.9.29 plus
commit `e04ba888` provides a daemon, MCP shim,
`plugin/opencode/agentmemory-capture.ts`, and `integrations/pi/`, but its stock
behavior has known capture, persistence, scoping, and lifecycle limitations.

## Desired Outcome

OpenCode and Pi use a declaratively packaged AgentMemory runtime. OpenCode uses
its patched existing plugin, stock automatic context injection, and core MCP
tools through mcpproxy. Existing cavemem history is imported into AgentMemory
before Pi activation. Pi uses AgentMemory's bundled integration and no longer
requires cavemem packages, patches, settings, MCP registration, or backup.

## Approach

Favor upstream behavior over custom guarantees. Pin AgentMemory at `e04ba888`
and iii-engine v0.11.2, install the existing upstream OpenCode plugin with a
small inline patch for current OpenCode event compatibility, and register the
stock AgentMemory MCP shim in core-tool mode through mcpproxy. Run the standard
runtime under Home Manager and launchd. Do not build a custom capture relay,
capability descriptor, read facade, raw-event store, materialization ledger, or
iii persistence patch.

Migrate non-importer cavemem sessions once with deterministic IDs and bounded
batches before activating AgentMemory for Pi. Disable cavemem-specific
compaction augmentation, vault synthesis, and memory-sync instead of porting
them. Keep manual Obsidian memory curation and the vault curator.

## Scope

- **In**: Reproducible AgentMemory and iii packages; existing OpenCode plugin
  patch and declarative install; standard daemon and core MCP wiring; startup
  health check; nono loopback/env changes; one-shot history import; simple
  stopped-runtime backup; host cutover; explicit OpenCode cavemem rollback; Pi
  AgentMemory integration, credentials, and compatibility checks.
- **Out**: Custom capture transport; raw transcript fidelity beyond stock
  AgentMemory; exact worktree/same-basename project isolation; crash-resumable
  migration; transactional import; proven iii flush semantics; exhaustive
  backup restore; porting session-compaction memory augmentation, vault
  synthesis, or memory-sync; Pi cavemem migration or Pi cavemem rollback.

## Boundary Candidates

- Package and runtime: pinned sources, managed paths, launchd, health, and
  simple stopped-state backup.
- Existing plugin integration: inline patch, automatic context, declarative
  discovery, and standard REST capture.
- MCP and instructions: stock core tools through mcpproxy and updated global
  AgentMemory guidance.
- Migration and cutover: one-shot import, host selection, rollback, and removal
  of OpenCode-owned cavemem behavior.
- Pi cutover: bundled AgentMemory Pi sources, standard routes, host wiring, and
  credentials become active; Pi cavemem functionality is removed.

## Out of Boundary

- Re-migration of Pi history; the cavemem-to-AgentMemory import completes before
  Pi activation.
- Cavemem packages, patches, settings, MCP registration, backup, or runtime
  wiring for Pi.
- Security isolation between the in-process OpenCode plugin and model-invoked
  OpenCode subprocesses.
- Recovery of an import interrupted after AgentMemory accepts only part of a
  batch; rerunning is the supported recovery.
- Repairing upstream iii-engine memory, orphan-process, shutdown, or flush bugs.

## Upstream / Downstream

- **Upstream**: AgentMemory `e04ba888`, iii-engine v0.11.2, existing AgentMemory
  OpenCode and Pi plugins, pinned OpenCode, mcpproxy, nono, cavemem rollback
  assets, and Obsidian.
- **Downstream**: OpenCode and Pi startup/recall, manual Obsidian curation,
  simple backup, OpenCode rollback, and AgentMemory Pi operations.

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
- Configure the bundled Pi integration with standard AgentMemory credentials.
- Remove Pi cavemem packages, patches, settings, MCP, backup, and host wiring.
