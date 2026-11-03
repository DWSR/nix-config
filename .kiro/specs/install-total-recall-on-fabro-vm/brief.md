# Brief: install-total-recall-on-fabro-vm

## Problem

> As an agent operator, I want a central memory system available for agents running on workstations and in Fabro so that session transcriptions and memories are available across all operating environments.
>
> This spec must:
>
> * install total-recall inside the Fabro VM using its Flake
> * install all of total-recall's prerequisites (e.g. postgres, iii) declaratively using Nix
> * Both total-recall and its prerequisites should be declared inside of a repo-local flake to wire together systemd services, etc.
> * expose total-recall using Tailscale Serve
> * make the MCP tools available to workstation hosts (again, using Tailscale for access)
> * configure the total-recall hooks for harnesses to point to the existing installation (rather than assuming local).

The Darwin hosts keep host-local session histories, and the Fabro guest's OpenCode console has no memory capture at all. A session captured in one environment cannot be recalled from another, so the operator loses continuity whenever they change hosts.

## Current State

- `nixosConfigurations.fabro-vm` (`flake.nix:3181`) composes the modules in `configurations/fabro-vm/`: fabro, LiteLLM, OpenCode, API bridge, sandbox, and Tailscale. `lima-vm-deploy` streams the tree into the running Lima instance; the guest runs `nixos-rebuild switch`.
- `configurations/fabro-vm/tailscale.nix` joins the tailnet as a tag-owned node (`tag:fabro`) and advertises `svc:fabro`, `svc:litellm`, and `svc:opencode` through a `tailscale serve --service=...` oneshot. Tailnet-facing traffic is limited to those loopback proxies.
- No PostgreSQL service, total-recall flake input, NixOS module, worker unit, migration, or Serve endpoint exists in the repo. The only total-recall references are LiteLLM comments naming it as a consumer (`home-manager/common/litellm.nix:12`, `:205`) and the failure-triage workflow naming the repository (`.fabro/workflows/failure-triage/workflow.toml:12`, `:30`).
- Memory is currently host-local: AgentMemory pins iii 0.11.5 (`overlays/agentmemory.nix:17`), runs a launchd daemon and OpenCode capture plugin (`home-manager/common/agentmemory.nix`), and loads a Pi extension (`home-manager/common/pi.nix:149`). Workstation MCP servers flow through mcpproxy (`home-manager/mcp/default.nix:451`), which already supports `streamable-http` upstreams.
- The guest deliberately excludes mcpproxy: `flake.nix:2327` asserts that no `mcpproxy` unit or package exists there.
- Upstream total-recall's flake pins iii 0.24.0 in its dev shell and exports per-worker packages, the OpenCode adapter, and the Pi adapter. It exports no NixOS module and no `harness-events` CLI package. The MCP worker is stdio-only. Post-processing calls an OpenAI-compatible or Anthropic API; embeddings require the separate `llm-router` worker and an embedding provider.

## Desired Outcome

- `nixos-rebuild switch` on the guest installs PostgreSQL 17 with `pg_textsearch`, `pgvector`, and `pg_uuidv7`, runs iii 0.24 with the database worker, and starts the total-recall ingestion, persistence, and post-processing workers as systemd services.
- Session events captured by guest harnesses persist to PostgreSQL; post-processing uses the existing loopback LiteLLM gateway to produce session records, summaries, concepts, and memory candidates within one cron tick of session end.
- The guest's iii worker WebSocket is reachable only over the tailnet through Tailscale Serve; PostgreSQL and iii's other listeners stay on loopback.
- Workstations install the `harness-events` CLI, the OpenCode capture plugin, and the Pi capture extension, each pointed at the guest's iii endpoint instead of a local one.
- Workstations expose total-recall's MCP tools through their existing mcpproxy via a locally spawned `mcp-worker`; a memory saved on one host is retrievable from another.
- `nix flake check` asserts the guest units, ports, PostgreSQL extensions and roles, worker environment, Serve endpoint, and the absence of exposed PostgreSQL and iii HTTP listeners.

## Approach

Consume upstream total-recall's flake packages and own the deployment wiring in this repo's flake, because upstream ships a development flake rather than a NixOS module.

- Add a locked `total-recall` flake input and thread it through the fabro-vm `specialArgs`.
- Add `configurations/fabro-vm/total-recall.nix`, imported from `configurations/fabro-vm/default.nix`, with repo-owned systemd units. Package the missing `harness-events` CLI and pin the companion iii workers from their upstream releases.
- Use `services.postgresql` with PostgreSQL 17 and a package set providing `pg_textsearch`, `pgvector`, and `pg_uuidv7`; set `shared_preload_libraries`, create the `memory_migration` and `memory_application` roles, and apply the upstream migrations through a oneshot unit.
- Run iii on loopback with a durable file-backed queue and cron, the `database` worker pointed at the memory database, and the total-recall workers configured with `III_URL`, `TOTAL_RECALL_QUEUE_TOPIC`, and the shared database connection name. Point post-processing at `http://127.0.0.1:4000/v1` with the LiteLLM master key from sops.
- Expose the iii worker WebSocket through a new `svc:total-recall` Serve entry; do not expose PostgreSQL or iii's HTTP API.
- On workstations, add a Home Manager module that installs `harness-events`, the OpenCode plugin, the Pi extension, and `mcp-worker`; set `III_URL` and `HARNESS_EVENTS_BIN`; and add `home.mcp.extraServers.total-recall` as a stdio upstream. Install the same OpenCode plugin in the guest's OpenCode config tree with the loopback URL.
- Leave the guest's OpenCode service, LiteLLM, and existing `svc:*` entries intact.

Defer vector embeddings: the `memory-embedding` worker requires `llm-router` plus a separately packaged embedding provider, and BM25 retrieval covers cross-environment recall without that chain.

Rejected: exposing PostgreSQL to workstations — every MCP read already flows through iii's `database::execute`, so only the worker WebSocket needs cross-host reach. Running mcpproxy on the guest — `flake.nix:2327` forbids it, and a custom stdio-to-HTTP bridge adds a new network service when each workstation can spawn the stdio worker locally. Installing AgentMemory locally on the guest — it would create a second, host-local memory store.

## Scope

- **In**: total-recall flake input and lock pin; repo-owned derivations for iii 0.24, the `database` worker, and the `harness-events` CLI; PostgreSQL with all three extensions, roles, and migrations; iii configuration and total-recall worker units; LiteLLM-backed post-processing; Tailscale Serve exposure of the worker WebSocket; the Home Manager client module for `harness-events`, the OpenCode plugin, the Pi extension, `mcp-worker`, and the mcpproxy entry; the guest OpenCode config-tree plugin; guest eval assertions and render/contract tests.
- **Out**: vector embeddings, the `llm-router` and embedding-provider workers, and semantic search; retiring AgentMemory or cavemem or migrating their data; Tailscale ACL, Service, DNS, or admin-console changes; backups and restore; high availability; upstream total-recall feature work; Fabro sandbox environment images; model choice and cost tuning.

## Boundary Candidates

- Flake dependency, worker binaries, and the pinned iii/CLI packages.
- Guest data plane: PostgreSQL package, extensions, roles, migrations, and persistence.
- Guest control plane: iii configuration, `database` worker, total-recall units, and LiteLLM post-processing settings.
- Exposure: the `svc:total-recall` Serve entry, ports, and firewall posture.
- Clients: `harness-events`, OpenCode and Pi adapters, `mcp-worker`, and the mcpproxy upstream entry.

## Out of Boundary

- Semantic retrieval, embedding storage, and any `router::embed` provider chain.
- AgentMemory/cavemem data migration, history import, or removal.
- Tailnet policy, Service definitions, OAuth credentials, and certificate provisioning.
- Database backup, restore, retention, and disaster recovery.
- Upstream total-recall changes such as OpenCode startup context or an HTTP MCP transport.
- Fabro workflow sandbox images and any harness that does not run on the guest or the Darwin hosts.

## Upstream / Downstream

- **Upstream**: the total-recall flake and its worker/migration contracts, iii 0.24 and its companion workers, PostgreSQL 17 with `pg_textsearch`/`pgvector`/`pg_uuidv7`, the guest's LiteLLM gateway, the tag-owned `tailscaled` node, the nixos-lima guest image, and sops-nix.
- **Downstream**: retiring AgentMemory and cavemem, importing existing history, cross-host startup context, semantic search, database backup, and per-host policy for which projects may write memories.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `agentmemory-opencode-migration` (the current host-local memory runtime), `mcpproxy-migration` (the workstation MCP entrypoint), `install-rex-in-fabro-vm` (guest Tailscale and module patterns), `personal-tailscale-service` (Serve conventions), `sqlite-backup` (data durability), and `cavemem-integration` / `session-compaction` (capture boundaries).

## Constraints

- The guest is `aarch64-linux`; the workstations are the repo's Darwin hosts; all packages must come from the pinned flake inputs rather than ad-hoc fetches.
- Do not rely on iii for authentication or TLS: bind every listener to loopback, terminate TLS in Tailscale Serve, and treat the tailnet ACL as the only access boundary.
- PostgreSQL 17 or 18 is required; `pg_textsearch` must be preloaded, `pgvector` must be 0.8.6 or later, and `pg_uuidv7` supplies `uuid_generate_v7()`. The memory migration hard-codes the `memory_application` role; the upstream fixture uses `memory_migration` as the owning role.
- The total-recall flake exports no NixOS module and no `harness-events` package; the repo owns both the unit wiring and the missing package. The MCP worker is stdio-only.
- `TOTAL_RECALL_MEMORY_DATABASE` names an iii database connection, not a URL; every worker and `mcp-worker` must use the same connection name and `III_URL`.
- Post-processing accepts only `https` URLs or loopback `http`; the LiteLLM master key comes from the guest's sops store and must not enter the Nix store.
- The guest's `users.mutableUsers` stays true, the cidata user stays undeclared, and long-lived state belongs under `/var/lib`.
- The `svc:total-recall` Tailscale Service must exist in the admin console before the Serve oneshot can advertise it; creating that Service is outside this spec.
- Harness adapters fail open: a missing or unreachable iii endpoint must not break OpenCode or Pi sessions.
