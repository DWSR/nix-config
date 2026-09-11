# Requirements Document

## Introduction

`agentmemory-opencode-migration` replaces cavemem for OpenCode using
AgentMemory's existing integration plus bounded operational exceptions proven
necessary by the migrated corpus. See `brief.md` for scope and rationale.

## Boundary Context

- **In scope**: Declarative AgentMemory packaging, the patched existing OpenCode
  plugin, stock core MCP tools, automatic context, best-effort history import,
  bounded BM25 indexing, consumer disablement, and both-host configuration.
- **Out of scope**: Custom capture or retrieval services, raw-event storage,
  hardened credential separation, exact project isolation, resilient migration,
  proven flush/restore semantics, consumer parity, runtime backup and restore
  workflows, OpenCode rollback activation and validation, and every Pi concern.
- **Adjacent expectations**: Pi is independently managed and excluded from this
  feature's requirements and validation. Obsidian remains available for manual
  curated memories.

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
   compression, and consolidation semantics.
9. When the BM25 index reaches its configured 100,000-entry capacity, the
   integration shall evict the oldest indexed entry without deleting its KV
   observation.
10. When the BM25 index exceeds the configured 50,000-entry persistence limit,
    the integration shall reject index serialization before allocating the
    serialization copy.

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
4. When OpenCode preflight runs, it shall accept a full AgentMemory daemon whose
   authenticated health status is `healthy`, `degraded`, or legacy `ok`.
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
3. When a source session is positively marked as non-OpenCode or
   importer-generated provenance, the importer shall skip it.
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
9. The packaged importer shall run its native SQLite dependency and JavaScript
   runtime on Node 22.
10. When processing records, the importer shall serialize each record at most
    once for sizing, serialize each completed batch once, and emit dry-run JSON
    without serializing the aggregate report.
11. The packaged importer shall use the configured AgentMemory REST endpoint and
    resolve its bearer through the managed Keychain reference for non-dry runs.
12. The importer shall preserve all accepted records in AgentMemory KV even when
    older records are outside the bounded BM25 index.

### Requirement 5: Simplified Consumer Cutover

**Objective:** As the operator, I want obsolete cavemem consumers removed from
the OpenCode path, so that the migration does not require compatibility layers
for every prior workflow.

#### Acceptance Criteria

1. When AgentMemory is selected, OpenCode shall not install the cavemem capture
   plugin or require cavemem during startup.
2. While AgentMemory is selected, the host generation shall force session
   compaction's cavemem augmentation off.
3. While AgentMemory is selected, the host generation shall disable the
   cavemem-based vault synthesizer and memory-sync command.
4. While AgentMemory is selected, global and subagent instructions shall not
   direct OpenCode agents to cavemem.
5. The OpenCode harness shall preserve manual Obsidian recall, memory creation,
   deduplication, tag, MOC, and vault-curator behavior.
6. The OpenCode harness shall not provide automatic AgentMemory-to-Obsidian
   promotion in this feature.

### Requirement 6: Basic Runtime Operations and Accepted Limitations

**Objective:** As the operator, I want basic health and security behavior, so
that the simplified runtime remains operable without custom durability
machinery.

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
5. The integration shall not block activation on known iii-engine memory,
   orphan-process, shutdown, or persistence issues accepted by the operator.
6. The integration shall not isolate the AgentMemory bearer from every
   model-invoked subprocess inside the OpenCode process boundary.
7. When the user invokes the managed `agentmemory` or `agentmemory-status`
   command, the wrapper shall resolve the configured Keychain bearer without
   printing it.
8. Before personal host activation, evaluation and pre-activation validation
   shall not fail solely because encrypted `agentmemory-bearer` material is
   absent; personal activation shall require that key to be provisioned.
