# Requirements Document

## Introduction
Total Recall becomes the sole active memory system for OpenCode and Pi on the personal `Brandons-MacBook-Pro`. [brief.md](brief.md) records the original request, confirmed approach and scope.

## Boundary Context
Upstream must supply compatible capture, startup context, conventional MCP and dedicated OAuth capabilities before deployment. This spec owns native deployment and cutover acceptance; [research.md](research.md#upstream-gates-and-required-evidence) records external gate ownership and evidence.

Technology-specific implementation contracts belong in research and later design. Named harnesses, providers and routing below are confirmed operator-facing constraints.

U1 preimplementation evidence ends at conventional worker-to-managed-mcpproxy protocol/results fidelity, including preserved structured payloads and discover/save/recall/errors. Upstream adapter contracts remain U2. Requirement 4's model-facing end-to-end rendering is verified after local implementation in tasks 9/14/15, not a U1 precondition.

Requirement 2's same-generation cutover uses the design's memory admission/completion barrier and failure containment; it does not assert atomic OS activation or simultaneous file replacement. Incomplete activation withholds memory while ordinary harness turns remain usable under Requirement 8.

Operator-owned provisioning is recorded in [design.md](design.md#operator-provisioning). It gates cutover authorization, not secret-independent packaging, wiring and fixture work. Missing secret material is recorded as an environment-blocked verification and never produces a blocked task.

## Requirements

### Requirement 1: Prerequisite-gated cutover
**Objective:** As the operator, I want compatibility proven before switching memory systems, so both harnesses retain the required capabilities.

#### Acceptance Criteria
1. The Cutover Review SHALL require upstream full capture, ambient startup context for both harnesses, mcpproxy-compatible MCP and dedicated OpenAI OAuth postprocessing before authorizing cutover.
2. The Cutover Review SHALL record immutable source revisions, artifact hashes, supported managed runtime versions and compatibility results for the deployment candidate.
3. The Spec Metadata SHALL record `ready_for_implementation: true` only after normal phase approvals, and SHALL record every unresolved upstream gate, operator decision or provisioning item in the design's Operator Provisioning section without blocking secret-independent tasks.
4. The Cutover Review SHALL reject the research baseline as a deployment candidate without evidence that all gates are satisfied.
5. The Cutover Deployment SHALL NOT implement local protocol, capture, context or OAuth facades to bypass an upstream gate.

### Requirement 2: Fresh sole-backend activation
**Objective:** As the operator, I want a clean cutover, so new memory has one authoritative backend.

#### Acceptance Criteria
1. When the first cutover activation completes, the Total Recall Store SHALL contain no imported historical sessions, observations or memories.
2. The Cutover Deployment SHALL NOT import or backfill AgentMemory, Cavemem, Obsidian or historical harness data.
3. When cutover completes, the Managed Harnesses SHALL use Total Recall as their only active memory backend.
4. The Cutover Deployment SHALL NOT dual-write or enable an AgentMemory, Cavemem or Obsidian memory fallback.
5. When activation is repeated, the Cutover Deployment SHALL preserve Total Recall data already created after cutover.

### Requirement 3: Complete new-session capture
**Objective:** As a harness user, I want my new work captured automatically, so later recall can use it.

#### Acceptance Criteria
1. While the backend is available, when a new OpenCode or Pi session starts, emits a user prompt, assistant response, reasoning event or tool activity, or ends, the Total Recall Integration SHALL persist each event exposed by the supported harness contract with session and harness identity.
2. When a captured session becomes eligible for postprocessing, the Total Recall Runtime SHALL process its captured material into canonical memory through the selected upstream processing contract.
3. The Compatibility Evidence SHALL document and test the upstream capture and processing delivery semantics, including retry behavior, possible duplicate observations or canonical commits, acknowledgement/crash-loss windows and recovery limits.
4. The Managed Harnesses SHALL use upstream adapters for automatic lifecycle capture without requiring model-authored capture calls.
5. If an event is unavailable from a harness, the Compatibility Evidence SHALL identify that limitation rather than claim that event was captured.

### Requirement 4: Explicit memory tools and result fidelity
**Objective:** As an agent, I want usable explicit memory results, so I can save and recall durable information.

#### Acceptance Criteria
1. When either harness discovers and invokes Total Recall memory tools, the Managed Integration SHALL route discovery and calls through mcpproxy's discover-then-invoke surface.
2. When an agent saves a memory and subsequently recalls it, the Managed Integration SHALL expose the saved content and identity in the returned result.
3. When a memory operation returns meaningful structured data alongside a text completion label, the Managed Integration SHALL expose the meaningful data to the model in both harnesses.
4. If a memory operation fails, the Managed Integration SHALL surface the operation error without presenting it as a successful memory result.
5. The Cutover Deployment SHALL preserve mcpproxy quarantine and tool approval behavior.

### Requirement 5: Ambient startup context
**Objective:** As a harness user, I want relevant memory available at startup, so I need not request recall manually.

#### Acceptance Criteria
1. When a new session starts in either harness and relevant memory is available, the Upstream Integration SHALL automatically supply that memory to the model before its first response.
2. When the memory store is empty, the Upstream Integration SHALL start the session without fabricated remembered content.
3. The Compatibility Evidence SHALL identify the upstream startup context selection, injection timing and per-session behavior for both harnesses.
4. The Managed Integration SHALL NOT require explicit memory tool calls to obtain ambient startup context.

### Requirement 6: Inference and dedicated credentials
**Objective:** As the operator, I want the selected inference services and independent authentication, so memory processing has its own credential lifecycle.

#### Acceptance Criteria
1. The Total Recall Runtime SHALL generate embeddings through the existing oMLX `Qwen3-Embedding-0.6B-4bit-DWQ` model using its managed runtime secret.
2. The Total Recall Runtime SHALL use OpenAI ChatGPT/Codex OAuth for session postprocessing with a dedicated Total Recall login and credential owner.
3. The Total Recall Runtime SHALL NOT substitute an API key or read, copy or mutate OpenCode/Pi authentication stores for postprocessing.
4. When processing credentials expire, the Upstream OAuth Runtime SHALL refresh them with account identity preserved and concurrency-safe credential updates.
5. If refresh cannot recover authorization, the Total Recall Runtime SHALL report a redacted authentication failure and a dedicated re-login action without marking the processing job successful.
6. The Cutover Review SHALL record the exact processing model and demonstrate supported OAuth Responses transport and usable structured postprocessing output for that model.
7. The Cutover Deployment SHALL keep credentials outside the Nix store, generated public configuration, logs and status output, with private runtime storage accessible only to the owning user.

### Requirement 7: Native managed lifecycle and indexing
**Objective:** As the operator, I want a reproducible native service, so memory persists across managed restarts.

#### Acceptance Criteria
1. The Cutover Deployment SHALL install native Nix-managed runtime artifacts on the currently exported personal host without container services, runtime package downloads or mutable latest-version resolution.
2. When the user session starts or a managed service exits, the Managed Runtime SHALL start or restart its database, engine and background workers under launchd supervision.
3. The Managed Runtime SHALL expose its memory MCP process as an mcpproxy-owned stdio upstream.
4. When database initialization or schema migration is repeated, the Managed Runtime SHALL preserve existing canonical memory and capture data and report migration failures before dependent workers use an incompatible schema.
5. While embedding dependencies are available, when a reconciliation cycle succeeds, the Managed Runtime SHALL index committed current memory versions missing an up-to-date embedding, including when no committed-memory event producer is available.
6. When the managed services are restarted cleanly, the Managed Runtime SHALL retain persisted capture, canonical memory, processing state and queued work.
7. The Runtime Documentation SHALL state actual queue persistence and crash-loss limits without promising fsync-backed acknowledgement where unavailable.
8. The Managed Runtime SHALL bind network listeners to `127.0.0.1` and document its trusted-local-user boundary.

### Requirement 8: Fail-open harness behavior
**Objective:** As a harness user, I want memory outages to leave my session usable, so inference availability does not block ordinary work.

#### Acceptance Criteria
1. If capture, context retrieval or an inference dependency is unavailable, the Upstream Integration SHALL allow the harness to start and continue normal turns without an old-backend fallback.
2. If a memory service request stalls, the Upstream Integration SHALL bound that request and allow normal harness interaction to continue.
3. If capture or processing fails, the Managed Runtime SHALL expose a redacted diagnostic identifying the failed capability without claiming durable capture or successful processing.
4. The Managed Launchers SHALL validate required managed configuration without making service or inference liveness a hard launch prerequisite.
5. When a recoverable outage ends, the Managed Runtime SHALL resume processing retained work according to the documented upstream retry contract.

### Requirement 9: Retirement and adjacent behavior preservation
**Objective:** As the operator, I want obsolete integrations retired while keeping historical data, so cutover has no active old dependencies.

#### Acceptance Criteria
1. When cutover completes, the Cutover Deployment SHALL stop live AgentMemory daemon and reaper jobs and remove their managed registrations.
2. The Cutover Deployment SHALL retire active AgentMemory packages, flake/overlay dependencies, capture plugins/extensions, MCP registration, secret consumers, launcher/environment/sandbox dependencies and AgentMemory-only operational commands/checks.
3. The Cutover Deployment SHALL retire the AgentMemory Obsidian importer, its exclusive dependencies and active import guidance.
4. When retiring managed credentials, the Cutover Deployment SHALL remove the stale managed Pi bearer artifact while preserving historical memory stores, vaults and external Keychain entries.
5. The Managed Instructions SHALL direct both harnesses and affected agent/compaction-context consumers to Total Recall and remove active old memory guidance, including mirrored instruction/plugin sources.
6. The Cutover Deployment SHALL preserve historical specs, Obsidian desktop, generic secrets plumbing, unrelated MCPs/plugins/ports, nono audit mode, disabled OpenCode title/summary agents and native session compaction.

### Requirement 10: Acceptance evidence
**Objective:** As the operator, I want a traceable acceptance record, so cutover success is demonstrated on the managed host.

#### Acceptance Criteria
1. When cutover acceptance is requested, the Acceptance Review SHALL require recorded results from both harnesses completing fresh-session capture, postprocessing, explicit save/recall and automatic first-response startup context on the candidate artifacts.
2. When cutover acceptance is requested, the Acceptance Review SHALL require recorded empty-store first activation, repeated activation/data preservation, clean restart/queue recovery, embedding reconciliation, OAuth expiry/concurrent refresh and outage fail-open results.
3. When cutover acceptance is requested, the Acceptance Review SHALL require recorded absence of active old jobs/integrations/secret consumers, retention of historical stores/vaults and preservation of adjacent behavior from Requirement 9.
4. The Acceptance Review SHALL distinguish source inspection, automated compatibility checks and live deployment evidence; source findings alone SHALL NOT count as deployment acceptance.
