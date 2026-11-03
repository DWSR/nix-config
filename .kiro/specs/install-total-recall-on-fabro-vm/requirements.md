# Requirements Document

## Introduction

This feature installs total-recall as the repo's central memory system on the Fabro guest and wires the Darwin hosts' harnesses to it. The problem statement, approach, and scope constraints live in `brief.md`.

## Boundary Context

- **In scope**: the pinned total-recall flake input and repo-owned packages for the missing CLI and the iii companion workers; the guest's PostgreSQL-backed memory data plane (extensions, roles, migrations, persistence); the guest's iii runtime, ingestion, persistence, and post-processing workers; the `svc:total-recall` Tailscale Serve publication of the worker endpoint; the shared Home Manager client module that installs the harness CLI, the OpenCode plugin, the Pi extension, `mcp-worker`, and the MCP proxy entry on the Darwin hosts; the guest OpenCode capture plugin; the guest and workstation configuration checks.
- **Out of scope** (delta from `brief.md`): retention, pruning, and archival of captured sessions and memories; per-project or per-operator write policy for which sessions may create memories; replacing or reconfiguring the workstations' existing AgentMemory capture; MCP tool-level authorization or per-tool allowlisting; database replication, high availability, and capacity tuning; rebuilding the Fabro guest image, and any change to Fabro workflow sandbox images.
- **Adjacent expectations**: the `svc:total-recall` Tailscale Service already exists in the admin console and is granted to `tag:fabro`; the guest already registers as a tag-owned node and advertises its existing `svc:*` entries; the guest's loopback LiteLLM gateway already serves the models used by post-processing and its master key already lives in the guest's sops store; the pinned nixpkgs already provides PostgreSQL 17 with the three required extensions; the total-recall flake already exports the worker, adapter, and migration sources; each Darwin host already runs mcpproxy as its MCP entrypoint; the guest's OpenCode service already reinstalls its declarative config tree on every start.

## Requirements

### Requirement 1: Pinned total-recall installation

**Objective:** As the repo maintainer, I want every total-recall component obtained from pinned inputs and repo-owned derivations, so that the guest deployment is reproducible and upgrades are explicit.

#### Acceptance Criteria

1. The repository shall declare total-recall as a flake input whose exact revision is recorded in the flake lock file.
2. When the fabro-vm configuration is evaluated, the total-recall worker packages and harness adapters shall resolve from that pinned input.
3. The deployment shall provide the `harness-events` CLI from a repo-owned derivation built from the same pinned total-recall revision.
4. The deployment shall provide the iii runtime, the iii database worker, and each companion worker from sources whose versions are recorded in the repository.
5. While the pinned revisions are unchanged, the deployment shall fetch no total-recall worker, adapter, CLI, or migration from an unpinned URL, release archive, or hand-placed file.
6. The repository shall not vendor a modified copy of the total-recall worker, adapter, or migration source.

### Requirement 2: Guest memory database

**Objective:** As an agent operator, I want the guest to run its memory database declaratively, so that captured sessions persist across reboots and configuration switches.

#### Acceptance Criteria

1. When the guest switches configuration, the guest shall run PostgreSQL 17 as a system service that starts at boot.
2. When the guest applies the memory migrations, the database shall create the full-text index, vector column, and time-ordered identifier defaults without error.
3. When the guest activates the memory configuration for the first time, the guest shall create the migration and application database roles and apply every total-recall migration without a manual step.
4. When the guest applies the memory migrations, the migration role shall own the memory schema and the application role shall hold the grants the workers require.
5. When the guest switches configuration again, the migration step shall be idempotent and shall leave existing memory data intact.
6. The guest's PostgreSQL listener shall accept connections on the loopback interface only.
7. When the guest reboots or rebuilds, previously captured sessions, session records, and memories shall remain available.
8. If the database service, an extension, a role, or a migration fails, then the guest shall mark the responsible unit failed and name the failure in its journal.

### Requirement 3: Guest memory runtime

**Objective:** As an agent operator, I want the guest's memory runtime and workers supervised, so that capture and storage continue without manual service management.

#### Acceptance Criteria

1. When the guest boots, the guest shall start the iii runtime with the database worker, the harness ingestion worker, the harness event persistence worker, and the session post-processing worker, and keep them enabled across reboots.
2. When any memory service exits unexpectedly, the guest shall restart it.
3. When the ingestion worker accepts a harness event, the guest shall publish it to a durable queue instead of holding it only in worker memory.
4. When the iii runtime restarts, events queued but not yet persisted shall remain queued for persistence after the restart.
5. Every total-recall worker on the guest shall use the same iii endpoint and the same memory database connection name.
6. If a worker receives an event that violates the event contract, then the worker shall reject that event and continue serving subsequent events.
7. If the memory database is unavailable when a worker starts, then the worker shall retry its connection instead of exiting successfully.
8. The guest's memory runtime, queue, and database state shall live under `/var/lib` and shall survive configuration switches.

### Requirement 4: Guest session capture

**Objective:** As an agent operator, I want sessions from the guest's OpenCode console captured into the central memory, so that Fabro work is recallable from any workstation.

#### Acceptance Criteria

1. When an OpenCode session starts, ends, or produces an observation on the guest, the guest's OpenCode harness shall submit the corresponding event to the guest's iii endpoint.
2. The guest's declarative OpenCode configuration tree shall include the total-recall OpenCode capture plugin.
3. The guest's OpenCode capture plugin shall run against the guest's loopback iii endpoint rather than a workstation endpoint.
4. If the guest's iii endpoint is unreachable or returns an error, then the OpenCode session shall continue without capture and without aborting the session.
5. The guest's OpenCode model provider, workspace, authentication, and config-tree behavior shall remain unchanged apart from the added capture plugin.
6. While the guest's OpenCode service restarts, previously captured guest sessions shall remain in the memory database.

### Requirement 5: Session post-processing

**Objective:** As an agent operator, I want ended sessions turned into session records, summaries, concepts, and memory candidates, so that recall returns curated memories rather than raw transcripts alone.

#### Acceptance Criteria

1. When a captured session has ended or has been inactive for the eligibility window, the guest's post-processing worker shall produce a session record, a summary, concepts, and memory candidates within one scheduled tick.
2. The post-processing worker shall send its model requests to the guest's loopback LiteLLM gateway.
3. The post-processing worker shall authenticate to the gateway with the credential from the guest's encrypted secret store.
4. The repository, the Nix store, the rendered configuration, and the service journals shall contain no plaintext model gateway credential.
5. If the model gateway is unavailable or returns an error, then the session shall remain eligible and post-processing shall retry it on a later tick.
6. Post-processing shall not modify or delete the raw session events and observations persisted before interpretation.
7. While no embedding provider is configured, post-processing and memory retrieval shall operate without an embedding step.

### Requirement 6: Tailnet exposure

**Objective:** As an agent operator, I want the guest's memory runtime published over Tailscale Serve, so that workstations can reach it without exposing the database.

#### Acceptance Criteria

1. When the guest is up and registered on the tailnet, the guest shall publish the iii worker endpoint through Tailscale Serve under the `svc:total-recall` service.
2. The published endpoint shall be reachable over the tailnet at the service's tailnet DNS name with TLS terminated by Tailscale Serve.
3. The Serve advertisement shall be re-applied on every boot and shall converge to the same handler when it is already applied.
4. The guest shall advertise no memory listener other than the Serve endpoint; the PostgreSQL listener and every iii HTTP listener shall remain loopback-only.
5. The guest shall leave the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` advertisements unchanged.
6. If the `svc:total-recall` advertisement fails, then the guest shall mark the Serve unit failed and record the error in the journal while leaving the existing advertisements applied.
7. While the `svc:total-recall` Service is absent or not granted to the guest's tag, the guest shall not expose the memory endpoint on any other interface or port.
8. While the guest has not yet joined the tailnet, the guest shall keep the memory services running on loopback and apply the Serve advertisement once registration completes.
9. When the guest boots, the guest shall start the database and apply its migrations before the workers, and the workers before the Serve advertisement.

### Requirement 7: Workstation capture wiring

**Objective:** As a workstation user, I want the Darwin hosts' harnesses to write to the guest's memory system, so that sessions from any host land in one store.

#### Acceptance Criteria

1. When a Darwin host's Home Manager configuration activates, the host shall install the `harness-events` CLI, the total-recall OpenCode capture plugin, and the total-recall Pi capture extension.
2. The workstation capture wiring shall point both harness adapters at the guest's `svc:total-recall` endpoint over the tailnet rather than at a host-local iii endpoint.
3. The workstation capture wiring shall set the capture executable path and the iii endpoint for both adapters from one shared declaration.
4. If the guest endpoint is unreachable, then the workstation's OpenCode and Pi sessions shall continue normally, with no capture and no session failure.
5. The workstation capture wiring shall not start or install a local iii runtime, a local PostgreSQL instance, or a local memory store.
6. The workstation capture wiring shall leave the workstations' existing AgentMemory runtime, capture plugin, and Pi extension enabled and unchanged.
7. Where a Darwin host enables the workstation memory wiring, the host shall receive the capture wiring through the shared Home Manager module without per-host duplication.

### Requirement 8: Workstation MCP retrieval

**Objective:** As an OpenCode user on any workstation, I want total-recall's memory tools available through the existing MCP proxy, so that I can save and recall memories from whichever host I am on.

#### Acceptance Criteria

1. When a Darwin host's Home Manager configuration activates, the host's MCP proxy configuration shall include a total-recall stdio upstream that spawns the `mcp-worker` locally.
2. The locally spawned `mcp-worker` shall connect to the guest's `svc:total-recall` endpoint over the tailnet.
3. The locally spawned `mcp-worker` shall use the same memory database connection name as the guest's workers.
4. When an MCP client requests the total-recall upstream's tools, the host's MCP proxy shall expose the memory save, search, get, and version-list tools.
5. When a memory is saved from one workstation, a memory search from another workstation shall return that memory.
6. The workstation shall not host a total-recall HTTP MCP listener, and the guest shall not run the MCP proxy.
7. If the guest endpoint is unreachable, then total-recall tool calls shall return an error to the MCP client while every other configured MCP upstream remains available.

### Requirement 9: Evaluated verification

**Objective:** As the repo maintainer, I want evaluated checks over the guest and workstation wiring, so that a regression in units, exposure, schema prerequisites, or clients fails the build instead of the deployment.

#### Acceptance Criteria

1. When `nix flake check` evaluates the repository, the checks shall verify that the guest's database, iii runtime, database worker, ingestion worker, persistence worker, post-processing worker, and migration step are enabled at boot.
2. When `nix flake check` evaluates the repository, the checks shall verify that PostgreSQL and every iii listener bind to loopback and that the only memory listener reachable over the tailnet is the `svc:total-recall` Serve handler.
3. When `nix flake check` evaluates the repository, the checks shall verify that the guest's database package provides the three required extensions, that the migration and application roles are declared, and that the migration sources are applied.
4. When `nix flake check` evaluates the repository, the checks shall verify that every guest total-recall worker uses the same iii endpoint and memory database connection name, the loopback LiteLLM base URL, and the sops-provided gateway credential.
5. When `nix flake check` evaluates the repository, the checks shall verify that the guest's Serve unit publishes `svc:total-recall` and leaves the existing `svc:*` advertisements unchanged.
6. When `nix flake check` evaluates the repository, the checks shall verify that the guest's OpenCode config tree contains the capture plugin pointed at the loopback endpoint.
7. When `nix flake check` evaluates the repository, the checks shall verify that each wired Darwin host renders the `harness-events` CLI, the OpenCode capture plugin, the Pi capture extension, and a stdio `mcp-worker` upstream with the guest endpoint.
8. When `nix flake check` evaluates the repository, the checks shall verify that the guest declares no MCP proxy and that no workstation declares a local iii runtime or PostgreSQL service.
9. When `nix flake check` evaluates the repository, the checks shall verify that no plaintext gateway credential appears in the rendered guest or workstation configuration.
10. While the checks run on a host without a Linux builder, the guest checks shall complete through pure evaluation of the guest configuration.
11. If a check fails, then the check message shall name the missing or misconfigured element.
