# Requirements Document

## Introduction

`agentmemory-opencode-migration` replaces cavemem for OpenCode and Pi using
AgentMemory's existing integrations and standard runtime behavior. Cavemem is
retained only as an explicit OpenCode rollback backend. See `brief.md` for the
selected balanced simplification and removed guarantees.

## Boundary Context

- **In scope**: Declarative AgentMemory packaging, the patched existing OpenCode
  plugin, stock core MCP tools, automatic context, best-effort history import,
  simple backup, consumer disablement, OpenCode rollback, and AgentMemory Pi
  activation.
- **Out of scope**: Custom capture or retrieval services, raw-event storage,
  hardened credential separation, exact project isolation, resilient migration,
  proven flush/restore semantics, consumer parity, and re-migration of Pi
  history.
- **Adjacent expectations**: Pi uses AgentMemory's bundled integration after
  the cavemem history import; cavemem remains available only for explicit
  OpenCode rollback; Obsidian remains available for manual curated memories.

## Requirements

### Requirement 1: Declarative AgentMemory Installation

**Objective:** As the host operator, I want AgentMemory managed by the active
generation, so that both Macs use one reproducible OpenCode memory setup.

#### Acceptance Criteria

1. When AgentMemory is enabled, the host generation shall provide the pinned
   AgentMemory source and compatible iii-engine runtime without a networked
   installation step.
2. When the host generation activates, it shall render AgentMemory settings,
   managed paths, and launchd services deterministically.
3. The host generation shall not invoke `connect opencode` or another
   AgentMemory imperative installer.
4. When OpenCode loads managed plugins, it shall load the patched existing
   upstream `agentmemory-capture.ts` entrypoint exactly once by directory
   discovery.
5. The managed plugin shall retain its upstream filename, named export,
   metadata, license, source revision, and patch provenance.
6. If AgentMemory is disabled, the host generation shall not start its runtime,
   install its OpenCode plugin, or register its MCP server.
7. The AgentMemory installation shall support the personal and Shopify
   nix-darwin hosts.

### Requirement 2: Existing OpenCode Plugin Capture

**Objective:** As an OpenCode user, I want the existing AgentMemory plugin to
capture useful session history, so that AgentMemory can provide ambient recall
without a new capture implementation.

#### Acceptance Criteria

1. When an OpenCode session starts, the patched upstream plugin shall start one
   standard AgentMemory session with available project and working-directory
   metadata.
2. When the operator submits a prompt, the patched upstream plugin shall send
   the prompt through AgentMemory's standard observation route.
3. When an assistant completes text or reasoning, the patched upstream plugin
   shall send the completed content through the standard observation route.
4. When a tool starts, succeeds, or fails, the patched upstream plugin shall
   send the available tool state, input, output, or error.
5. When OpenCode becomes idle, is deleted, or disposes normally, the patched
   upstream plugin shall invoke the corresponding standard AgentMemory summary
   or session-end behavior.
6. When the first eligible model request runs, the patched upstream plugin shall
   use AgentMemory's standard automatic context injection.
7. If a standard AgentMemory capture request fails or times out, the plugin
   shall record the failure in OpenCode logs without retrying through a custom
   durable queue.
8. The OpenCode integration shall use AgentMemory's stock observation limits,
   compression, indexing, and consolidation semantics.

### Requirement 3: Standard MCP Recall Through Mcpproxy

**Objective:** As an OpenCode user, I want AgentMemory recall available through
the existing MCP gateway, so that memory tools follow the harness's normal tool
routing.

#### Acceptance Criteria

1. When AgentMemory is enabled, mcpproxy shall register the stock AgentMemory
   MCP shim in core-tool mode.
2. OpenCode shall continue to register mcpproxy as its only MCP endpoint.
3. When the stock core tool set includes a write operation, mcpproxy shall apply
   its normal write-operation policy.
4. When OpenCode preflight runs, it shall verify the full AgentMemory daemon is
   healthy rather than accepting standalone fallback as startup readiness.
5. If full-daemon preflight fails, the launcher shall stop before OpenCode and
   print one AgentMemory recovery action.
6. When AgentMemory becomes unavailable after startup, the integration may use
   the stock shim's fallback behavior and shall not add a custom fallback guard.
7. Global OpenCode instructions shall describe the stock AgentMemory discovery,
   recall, session, and save tools through mcpproxy.

### Requirement 4: Best-Effort Cavemem History Import

**Objective:** As the operator, I want existing OpenCode cavemem history copied
into AgentMemory, so that useful prior context remains searchable after cutover.

#### Acceptance Criteria

1. When import runs, the importer shall read a SQLite Online Backup snapshot of
   cavemem without modifying the source database.
2. When the source contains non-importer sessions, the importer shall transform
   them into AgentMemory's standard import shape.
3. When a source session is positively marked as Pi or Obsidian migration, the
   importer shall skip it.
4. When the importer creates target records, it shall derive deterministic IDs
   from source session and row identities.
5. When a batch approaches the configured size ceiling, the importer shall
   start a new bounded batch.
6. When import is rerun, the importer shall use AgentMemory's skip strategy for
   existing deterministic IDs.
7. If a source row is malformed or a batch fails, the importer shall report the
   affected counts and continue with later independent batches where possible.
8. The importer shall not provide a durable journal, transactional rollback, or
   automatic crash resume beyond rerunning the command.

### Requirement 5: Simplified Consumer Cutover

**Objective:** As the operator, I want obsolete cavemem consumers removed from
the OpenCode path, so that the migration does not require compatibility layers
for every prior workflow.

#### Acceptance Criteria

1. When AgentMemory is selected, OpenCode shall not install the cavemem capture
   plugin or require cavemem during startup.
2. While AgentMemory is selected, session compaction shall run without the
   cavemem memory-augmentation source and shall rely on normal conversation
   state plus AgentMemory's automatic context.
3. While AgentMemory is selected, the host generation shall disable the
   cavemem-based vault synthesizer and memory-sync command.
4. While AgentMemory is selected, global and subagent instructions shall not
   direct OpenCode agents to cavemem.
5. The OpenCode harness shall preserve manual Obsidian recall, memory creation,
   deduplication, tag, MOC, and vault-curator behavior.
6. The OpenCode harness shall not provide automatic AgentMemory-to-Obsidian
   promotion in this feature.

### Requirement 6: Basic Runtime Operations and Accepted Limitations

**Objective:** As the operator, I want basic health, security, and backup
behavior, so that the simplified runtime remains operable without custom
durability machinery.

#### Acceptance Criteria

1. The AgentMemory daemon shall bind its service endpoints to loopback and use
   bearer authentication.
2. While the existing plugin is active, the OpenCode process environment shall
   provide the bearer required by AgentMemory's standard REST client.
3. While OpenCode runs under nono, its profile shall permit the standard
   AgentMemory REST endpoint and required environment variable without granting
   direct AgentMemory state-directory access.
4. When OpenCode preflight succeeds, it shall report AgentMemory daemon health
   without revealing the bearer.
5. When simple backup runs, it shall stop AgentMemory through its stock stop
   path, copy the managed data directory, and restart the service.
6. The backup workflow shall not claim transactional consistency, a patched iii
   flush barrier, or automated restore validation.
7. The integration shall not block activation on known iii-engine memory,
   orphan-process, shutdown, or persistence issues accepted by the operator.
8. The integration shall not isolate the AgentMemory bearer from every
   model-invoked subprocess inside the OpenCode process boundary.

### Requirement 7: AgentMemory Pi Cutover and OpenCode Rollback

**Objective:** As the operator, I want Pi to use the same AgentMemory runtime
after history migration, while retaining an explicit cavemem rollback for
OpenCode only.

#### Acceptance Criteria

1. While Pi remains enabled, Pi shall capture and retrieve through AgentMemory's
   bundled Pi integration.
2. When the AgentMemory backend activates, the host generation shall configure
   Pi's AgentMemory integration and shall not retain Pi-specific cavemem runtime
   functionality.
3. The managed AgentMemory package shall retain the bundled
   `integrations/pi/` entrypoint, security helper, metadata, and relative layout.
4. The AgentMemory runtime shall preserve the standard authenticated health,
   session, observe, smart-search, remember, end, and consolidate routes used by
   the bundled Pi plugin.
5. When compatibility validation runs, the bundled Pi plugin shall load against
   the selected Pi extension API and standard AgentMemory routes with its
   declared host credentials.
6. The feature shall not migrate Pi history during activation; cavemem history
   is assumed to have been imported into AgentMemory beforehand.
7. When the cutover generation activates, AgentMemory shall be the ambient
   memory source for OpenCode and Pi without live dual writes to cavemem.
8. When the operator activates the retained rollback generation, OpenCode shall
   restore its prior cavemem capture and instructions while Pi remains on
   AgentMemory and no Pi cavemem functionality is restored.
