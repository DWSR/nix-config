# Research and Gap Analysis

## Summary

- **Feature**: `agentmemory-opencode-migration`
- **Discovery scope**: Complex brownfield integration.
- **Key findings**: AgentMemory supplies usable OpenCode and Pi integrations but
  has known capture, project, persistence, fallback, and credential limitations.
  The selected design accepts stock behavior, patches only high-value OpenCode
  events, and removes cavemem consumers that require bespoke adapters.

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

### Pi Compatibility Surface

- AgentMemory already bundles an official Pi extension at
  `integrations/pi/index.ts` with `security.ts` and a private nested manifest.
  The root npm package publishes the complete relative source layout.
  [entrypoint](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/integrations/pi/index.ts)
  [security helper](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/integrations/pi/security.ts)
- The Pi factory subscribes to session start, pre-agent, tool result, agent end,
  and shutdown hooks. It expects standard authenticated health, session start,
  observe, smart-search, remember, session end, and consolidate REST routes.
- The amended cutover enables the Pi extension, configures its standard bearer
  and REST endpoint, and validates its host wiring. Pi history migration is not
  repeated here because the cavemem-to-AgentMemory import completes before Pi
  activation.

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

- `home-manager/common/cavemem.nix` owns package installation, settings,
  OpenCode rollback plugin, mcpproxy upstream, environment, and rollback
  preflight. Its current single enable flag must no longer imply Pi runtime
  ownership.
- `home-manager/common/opencode-plugins/cavemem.js` captures session lifecycle
  and tools through detached child commands. It does not capture prompts,
  assistant text, or hook failures.
- `home-manager/common/opencode.nix` and
  `scripts/opencode-nono-launcher.nix` compose the OpenCode launch, global
  instructions, preflight, and agent inventory.
- `home-manager/common/opencode-nono.nix` must grant cavemem state only for the
  OpenCode rollback backend and AgentMemory ports/env only for AgentMemory.
- `home-manager/common/session-compaction.nix` and
  `home-manager/common/session-compaction-internal/session-compaction-impl.ts`
  invoke `cavemem search` for compaction context.
- `home-manager/common/agents/vault-synthesizer.md` and
  `scripts/memory-sync.nix` depend on cavemem sessions, timeline, observations,
  health, and `cavemem-session-*` provenance.
- `configurations/shopify/home-manager/sqlite-backup.nix` protects SQLite files;
  it cannot snapshot agentmemory's directory store consistently.
- `overlays/mcp-servers.nix` currently packages cavemem with general and
  Pi-specific patches. The amended design removes Pi-specific patch use and
  retains cavemem assets only for explicit OpenCode rollback.
- Existing tests cover cavemem CLI/MCP patches and selected consumer behavior,
  but not the installed OpenCode plugin's prompt, response, cwd, or failure path.

## Requirement-to-Asset Gap Map

| Requirements | Existing assets | Gap |
|---|---|---|
| 1 | Nix overlay, HM and launchd patterns | **Missing** pinned package, lock, module, and existing-plugin install |
| 2 | Upstream AgentMemory plugin and OpenCode hooks | **Missing** current event names, assistant text, tool states, idle, and dispose patch |
| 3 | Mcpproxy and launcher preflight | **Missing** stock core MCP registration and full-daemon health check |
| 4 | Cavemem snapshot/importer patterns | **Missing** bounded deterministic best-effort importer |
| 5 | Compaction, synthesizer, memory-sync, AGENTS rules | **Change** disable unported consumers and update instructions |
| 6 | Nono, Keychain, and backup patterns | **Change** allow stock REST/bearer and add simple stopped-state copy |
| 7 | AgentMemory package and bundled Pi bridge | **Change** activate AgentMemory for Pi and remove Pi cavemem wiring |

## Implementation Options

### Option A: Thin Upstream AgentMemory Integration

Package the standard runtime, patch the existing OpenCode plugin, use stock core
MCP tools, and disable unported cavemem consumers.

- Pros: 25 tasks, small patch surface, straightforward upgrades.
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

- Effort: **L**. The remaining work is packaging, one plugin patch, standard
  runtime/MCP wiring, best-effort import, consumer disablement, and host tests.
- Risk: **High**. The smaller implementation intentionally accepts documented
  upstream persistence, fallback, credential, and data-fidelity limitations.

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
- Activate AgentMemory's bundled Pi extension with standard REST compatibility
  and host credentials. Remove Pi-specific cavemem functionality after the
  pre-cutover history import.

### Removed

- Capture relay, inherited capability descriptor, and nono/OpenCode-core patches.
- Immutable raw-event scope, producer-qualified custom keys, materialization
  ledger, repair route, and custom read-only MCP facade.
- Exact worktree/same-basename isolation and session-stable custom injection.
- Durable migration journal, transactional reconciliation, and crash recovery.
- Patched iii flush barrier, exhaustive physical backup, and automated restore.
- AgentMemory adapters for session-compaction augmentation, vault synthesis, and
  memory-sync. Those cavemem-dependent features are disabled at cutover.

### Accepted Consequences

- The OpenCode process receives the standard AgentMemory bearer; subprocess
  isolation is not guaranteed.
- Stock observation compression, truncation, indexing, consolidation, project
  naming, fallback, and persistence semantics apply.
- Import recovery is rerun-with-skip, not transactional resume.
- Backup is a best-effort stopped-runtime directory copy.
- Obsidian remains manually curated; automatic cavemem-to-Obsidian promotion is
  removed.

## Residual Validation Items

- Generate and audit the repository-owned npm lock and Darwin engine hashes.
- Verify the existing patched OpenCode plugin loads exactly once.
- Smoke-test full-daemon preflight, core MCP tools, capture, import reruns, and
  both current and future Pi compatibility.
