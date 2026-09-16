# Requirements Document

## Introduction

This spec replaces `ravitemer/mcp-hub` with `smart-mcp-proxy/mcpproxy-go`
as the single MCP entrypoint for this nix-darwin home-manager config.
Full background, the touchpoint inventory from discovery, the viability
findings, the upstream / downstream relationships, and the four locked
architectural choices (big-bang cutover, cavemem-via-mcpproxy only,
keychain layout swap with the existing SOPS bridge preserved, full
retrieve_tools mode with a four-tool agent surface, complete nvim MCP
removal except for non-MCP codecompanion) are captured in
`.kiro/specs/mcpproxy-migration/brief.md`. The migration is a single
coordinated cutover: every consumer that talks to mcp-hub today either
moves onto mcpproxy or loses its MCP surface in the case of nvim's
codecompanion MCP extension. The acceptance gate is the AGENTS.md
mandatory startup check operating end-to-end on a fresh opencode
session against the migrated stack. This revision also covers the
post-cutover requirement that mcpproxy must not replace or rewrite the
Home Manager-owned rendered config when it performs startup cleanup or
runtime persistence.

## Boundary Context

- **In scope**: mcpproxy-go Nix packaging; the orchestrator module
  rewrite covering config rendering, launchd agent, and the restart
  helper; protection of the Home Manager-owned rendered mcpproxy
  configuration from mcpproxy's own runtime writes; the secret-bridge
  layout swap with one-shot cleanup of legacy entries; the cavemem
  split-brain closure; the opencode
  integration changes (per-host remote-MCP wiring + wrapper preflight);
  the memory-sync CLI's MCP-availability probe; the agent-contract
  rewrite (AGENTS.md startup gate + memory-recall rules + every
  common subagent + every Shopify-host subagent / agents reference
  + the Shopify-host agents reference); nvim MCP teardown (drop
  `mcphub.nix`, strip the MCP extension wiring from `codecompanion.nix`
  while preserving codecompanion as a non-MCP chat plugin, drop the
  lualine `mcphub` status component, drop both legacy flake inputs);
  the sqlite-backup keychain account rename to a neutral name; and
  the operator-facing documentation alignment.

- **Out of scope**: introducing new MCP servers; tuning mcpproxy
  parameters (`top_k`, `tools_limit`, BM25 weights) beyond defaults;
  replacing SOPS as the source of truth for secrets; migrating
  sqlite-backup off the macOS Keychain; introducing a nvim-side
  replacement plugin for `mcphub.nvim`; opencode plugin or hook
  architecture changes; modifying cavemem internals (Zod schema,
  embedding behaviour, upstream patches); customising mcpproxy's
  quarantine workflow beyond per-server approval; relying on manual
  filesystem immutability flags to protect the rendered config;
  preventing mcpproxy from writing its own runtime state outside the
  Home Manager-owned config path. The deferred `mcp-server-allowlist`
  spec is superseded but not formally closed in this spec body.

- **Adjacent expectations**:
  - `mcp-secrets-sops-nix`'s SOPS-as-source-of-truth model continues
    to hold; this spec mutates the activation and verification
    scripts' output layout without replacing the SOPS layer.
  - `cavemem-integration`'s locked downstream contract on the
    `hub_cavemem__*` tool name shape is intentionally broken by this
    spec; cavemem's runtime behaviour (data directory, embedding
    settings, observation capture) is preserved.
  - `sqlite-backup`'s runtime behaviour is preserved; only the
    keychain account name changes. Existing backup, restore,
    replication, and credential-verification operations must
    continue to find their secrets after the rename.
  - `opencode-cost-diagnosis` is the measurement vehicle for
    verifying this spec's cost-reduction claim; nothing here
    changes the diagnostic itself.
  - mcpproxy may continue to maintain runtime state that belongs to
    mcpproxy itself; this spec's config-protection requirement only
    preserves the Home Manager-owned rendered configuration as the
    declarative source of truth.

## Requirements

### Requirement 1: mcpproxy daemon deployment

**Objective:** As the host operator, I want mcpproxy to run automatically under launchd as the only MCP orchestrator on every nix-darwin host, so that opencode and other consumers have a single, always-available MCP entrypoint.

#### Acceptance Criteria

1. When the home-manager generation activates on a nix-darwin host, the mcpproxy orchestrator module shall produce a running launchd agent that hosts the mcpproxy daemon on a local TCP port.
2. The mcpproxy orchestrator module shall expose the listen port as a Nix option with a documented default value.
3. If the mcpproxy daemon exits unexpectedly, the launchd agent shall restart it automatically.
4. The mcpproxy orchestrator module shall write the daemon's stdout and stderr to per-host log paths under the operator's home directory.
5. The mcpproxy orchestrator module shall provide a single user-invokable command that restarts mcpproxy's launchd agent.
6. When home-manager activation completes on a host, the mcpproxy orchestrator module shall guarantee that no launchd agent labelled `com.ravitemer.mcp-hub` is loaded and that no `mcp-hub` binary appears on the operator's PATH.

### Requirement 2: Upstream MCP server inventory

**Objective:** As the operator, I want every MCP server I rely on today (obsidian, github, mcp-nixos, cavemem) to be reachable through mcpproxy after migration, so that my agent workflows have continuous access to the same capabilities.

#### Acceptance Criteria

1. When mcpproxy starts, the mcpproxy orchestrator module shall have configured it to spawn the obsidian, github, mcp-nixos, and cavemem upstream servers.
2. The mcpproxy orchestrator module shall configure every upstream server to bypass mcpproxy's quarantine workflow.
3. The mcpproxy orchestrator module shall expose a Nix option that allows host-specific configurations to register additional upstream MCP servers without modifying the common module.
4. While mcpproxy is running and a configured upstream server is reachable, mcpproxy's runtime status surface shall report that server's connection state as `connected`.
5. When an upstream server requires a secret-bearing environment variable, the mcpproxy orchestrator module shall propagate that variable to the spawned upstream process.

### Requirement 3: Four-tool agent surface

**Objective:** As an opencode user, I want the agent to see only the four-tool mcpproxy surface so that the system prompt no longer carries every upstream tool's schema and the cost-diagnosis tool can measure the resulting token reduction.

#### Acceptance Criteria

1. While mcpproxy is running with its default configuration against the current upstream inventory, the mcpproxy daemon shall expose exactly four MCP tools to connected clients: `retrieve_tools`, `call_tool_read`, `call_tool_write`, and `call_tool_destructive`.
2. The mcpproxy orchestrator module shall not override mcpproxy's `tools_limit` setting in a way that disables the four-tool surface for the current upstream tool inventory.
3. When an MCP client connects to mcpproxy, the mcpproxy daemon shall not expose any tool whose name is prefixed with `hub_`.
4. When `retrieve_tools` is invoked with a natural-language query, the mcpproxy daemon shall return a ranked list of upstream tools relevant to the query, including each tool's full schema and the identifier used to invoke it through the `call_tool_*` primitives.
5. When `call_tool_read`, `call_tool_write`, or `call_tool_destructive` is invoked with an upstream tool identifier and arguments, the mcpproxy daemon shall route the call to the named upstream server and return its response to the caller.

### Requirement 4: Agent prompt contract

**Objective:** As an opencode user, I want the AGENTS.md startup gate, memory-recall rules, and every subagent prompt to invoke MCP tools through the four-tool surface so that the agent's instructions match the live tool surface and the migration doesn't strand the agent on day one.

#### Acceptance Criteria

1. The agent contracts in scope (AGENTS.md, every common subagent under `home-manager/common/agents/`, and every Shopify-host subagent and agents reference) shall not reference any `hub_*`-prefixed tool name.
2. The AGENTS.md startup gate shall verify obsidian and cavemem reachability by invoking the four-tool surface (a `retrieve_tools` query plus the appropriate `call_tool_*` invocation), preserving its current refuse-to-proceed semantics on failure.
3. The AGENTS.md memory-recall rules shall describe tool invocations in terms of the four-tool surface while preserving the original semantic intent: when to search memories, deduplication-before-creation, and the memory note format.
4. The AGENTS.md startup-gate failure message shall name mcpproxy and shall provide a recovery hint that names mcpproxy's launchd label.
5. When opencode starts a fresh session against the migrated stack, the AGENTS.md startup gate shall complete successfully.

### Requirement 5: Secret material flow to mcpproxy

**Objective:** As the operator, I want SOPS-stored secrets to continue reaching upstream MCP servers through mcpproxy after the migration so that github authentication and any other secret-bearing servers work without operator intervention.

#### Acceptance Criteria

1. The mcpproxy orchestrator module shall reference secret values in its rendered configuration without writing any secret value to the rendered configuration file.
2. When mcpproxy starts under the managed launchd agent, the managed launch pathway shall provide the daemon's required API key without requiring the operator to run a manual secret-initialization command.
3. When mcpproxy spawns an upstream server that requires a secret, the managed launch pathway shall provide the secret value to the spawned process without persisting that secret value in the Home Manager-owned rendered configuration.
4. The mcpproxy orchestrator module shall not depend on mcpproxy's own keyring-write path; secret material reaches the macOS Keychain via the existing SOPS-bridge activation script only.
5. While the home-manager activation runs, the secret bridge shall write every operator-declared MCP secret to the macOS Keychain in the layout that mcpproxy expects.
6. When an operator-declared MCP secret's source value changes in SOPS, the secret bridge shall update the corresponding macOS Keychain entry in place during the next activation.

### Requirement 6: One-shot keychain layout migration

**Objective:** As the operator, I want a single `darwin-rebuild switch` to migrate keychain entries from the legacy mcp-hub layout to the new mcpproxy layout so that no manual cleanup is required after activation.

#### Acceptance Criteria

1. When home-manager activation runs, the secret bridge shall write new-layout entries for every operator-declared MCP secret in the same activation pass.
2. When home-manager activation runs on a host that contains macOS Keychain entries under the legacy `mcp-hub` account, the secret bridge shall delete every such entry that corresponds to an operator-declared MCP secret, regardless of whether the new-layout entry already exists.
3. When home-manager activation runs on a host that has no legacy entries (clean install or already-migrated host), the secret bridge shall complete activation successfully and shall write only the new-layout entries.
4. When a successful activation pass finishes, no macOS Keychain entry related to MCP secrets shall remain under the legacy `mcp-hub` account.
5. When the secret-bridge verification command runs, it shall confirm that every operator-declared MCP secret exists in the new layout and shall report missing or layout-mismatched entries explicitly.

### Requirement 7: Cavemem split-brain closure

**Objective:** As the operator, I want cavemem to reach opencode through exactly one routing path (via mcpproxy) so that the documented split-brain risk is eliminated and observation capture is unambiguous.

#### Acceptance Criteria

1. The opencode rendered configuration on every host shall not contain any direct local-MCP entry for cavemem.
2. While mcpproxy is running, cavemem shall be reachable to opencode only through mcpproxy's four-tool surface.
3. The mcpproxy orchestrator module shall set the cavemem upstream's environment so that its `CAVEMEM_DATA_DIR` matches the value the cavemem module's `dataDir` option resolves to, preserving the existing observation history across the cutover.
4. The cavemem module's option surface (`dataDir`, `embedding.*`, `compression.intensity`) and its existing settings.json rendering behaviour shall remain unchanged by this spec.
5. When opencode starts a fresh session, the AGENTS.md startup gate's cavemem reachability check shall succeed against the mcpproxy-routed path.

### Requirement 8: Opencode wrapper preflight checks

**Objective:** As the operator, I want opencode to refuse to launch when mcpproxy or any MCP server I depend on is unreachable so that I never start a session with degraded MCP capability and silently lose memory tools.

#### Acceptance Criteria

1. When the opencode wrapper runs its preflight sequence, the opencode wrapper shall probe mcpproxy's runtime health endpoint and exit with a non-zero status if mcpproxy is not reachable.
2. When the opencode wrapper runs its preflight sequence, the opencode wrapper shall verify the obsidian upstream server's connected status via mcpproxy's runtime status surface and exit with a non-zero status if obsidian is not connected.
3. When the opencode wrapper runs its preflight sequence, the opencode wrapper shall verify the cavemem upstream server's connected status via mcpproxy's runtime status surface and exit with a non-zero status if cavemem is not connected.
4. If any preflight probe fails, the opencode wrapper shall write a stderr message naming the failing component (mcpproxy itself, obsidian, or cavemem) and shall include a recovery hint that references mcpproxy's launchd label.
5. While the home-manager-managed `opencode-prewarm` launchd agent runs at login, that agent shall continue to invoke the unwrapped opencode binary, bypassing the MCP preflight checks.

### Requirement 9: Memory-sync CLI alignment

**Objective:** As the operator, I want the memory-sync CLI's MCP-availability probe to target mcpproxy so that its preconditions reflect the migrated stack and its recovery hints remain actionable.

#### Acceptance Criteria

1. When the memory-sync CLI runs its preflight probes, the memory-sync CLI shall verify the obsidian and cavemem upstream servers' connected status through mcpproxy's runtime status surface.
2. If a memory-sync precondition probe fails, the memory-sync CLI shall exit with a distinct non-zero status code per failing precondition and shall write a recovery hint to stderr that names mcpproxy's launchd label.
3. The memory-sync CLI's per-precondition exit-status contract shall be preserved end-to-end: the exit codes that currently distinguish "cavemem unreachable" and "obsidian unreachable" remain unchanged in semantics and value.

### Requirement 10: Per-host opencode MCP wiring

**Objective:** As the operator on either nix-darwin host, I want opencode to consume mcpproxy as a remote MCP provider on both hosts so that the four upstream MCP servers are reachable from opencode regardless of which host I'm on.

#### Acceptance Criteria

1. When home-manager activation completes on the Shopify host, opencode's rendered configuration shall contain exactly one remote MCP entry pointing at the local mcpproxy daemon's endpoint.
2. When home-manager activation completes on the personal host, opencode's rendered configuration shall contain exactly one remote MCP entry pointing at the local mcpproxy daemon's endpoint.
3. When home-manager activation completes on either host, opencode's rendered configuration shall not contain any remote MCP entry referencing the legacy `:37373` endpoint.
4. When opencode invokes a tool through the mcpproxy remote MCP entry on either host, mcpproxy shall successfully route the invocation to the configured upstream server whenever that server is reported as connected.

### Requirement 11: Nvim MCP teardown

**Objective:** As the operator, I want nvim to stop being an MCP consumer so that the nvim-side MCP surface is removed and the codecompanion chat interface continues to work as a non-MCP tool.

#### Acceptance Criteria

1. The rendered nixvim configuration shall not include the `mcphub.nvim` plugin or any code path that loads it.
2. The rendered nixvim configuration shall include `codecompanion-nvim` with its MCP extension wiring removed (no `extensions.mcphub` block, no `mcphub.nvim`-triggering `before` hook), so that `:CodeCompanion` opens the chat interface without attempting to load MCP tools.
3. The rendered nixvim lualine status line shall not include the `mcphub` status component.
4. The flake's input set shall not contain the `mcphub` or `mcphub-nvim` inputs.
5. When the operator launches `nvim` after activation, nvim shall start without any error or warning message that references mcphub, mcp-hub, or any removed plugin.

### Requirement 12: Sqlite-backup keychain account rename

**Objective:** As the operator, I want sqlite-backup secrets to live under a neutral keychain account name so that the storage backend (mcpproxy) does not leak into unrelated secret families.

#### Acceptance Criteria

1. The sqlite-backup module's secret-resolution pathway shall read its restic and rclone passphrases from the macOS Keychain under an account name that references neither `mcp-hub` nor `mcpproxy`.
2. When home-manager activation runs on a host that contains sqlite-backup-related keychain entries under the legacy `mcp-hub` account, the activation pathway shall migrate those entries to the new neutral account and delete the legacy entries.
3. When sqlite-backup performs an on-demand backup, restore, replication start/stop, list, status, or verify-credentials operation against a migrated host, that operation shall complete successfully using the new account name.
4. The sqlite-backup module's option descriptions, manifest, and operator-facing documentation shall reference the new account name and shall not reference `mcp-hub`.
5. If sqlite-backup's secrets are not present at the new account name during activation verification, the verification step shall fail with a message naming the missing account and secret.

### Requirement 13: Operator-facing documentation alignment

**Objective:** As the operator reading project documentation, I want every reference to the legacy MCP orchestrator updated so that troubleshooting docs, runbooks, and agent failure messages point at the live system.

#### Acceptance Criteria

1. The AGENTS.md memory-system documentation shall reference mcpproxy in every narrative passage that mentions the MCP orchestrator.
2. The `home-manager/common/agents-cc-sdd.md` document shall not contain any references to mcphub or mcp-hub by name.
3. The `secrets/README.md` rotation documentation shall reference the new keychain account names used by both the MCP-secret pathway and the sqlite-backup pathway.
4. The `home-manager/common/agents/nix-pkg.md` subagent's troubleshooting table shall reference mcpproxy's preflight check rather than the legacy mcphub one.
5. Where existing module comments document the live integration with the MCP orchestrator (notably in `home-manager/common/cavemem.nix`), those comments shall reference mcpproxy; pre-migration historical context may remain provided it is framed as historical rather than current.

### Requirement 14: Migration acceptance evidence

**Objective:** As the operator, I want a concrete, repeatable end-to-end check that proves the migration succeeded so that I do not declare done on the basis of incremental smoke tests.

#### Acceptance Criteria

1. When the operator starts a fresh opencode session on a host that has completed a clean activation, the AGENTS.md mandatory startup gate shall complete successfully.
2. When the operator runs the memory-sync CLI on a host that has completed a clean activation, the CLI's preflight probes shall complete without error.
3. When the operator launches opencode on a host that has completed a clean activation, the opencode wrapper preflight checks shall succeed for mcpproxy itself, obsidian, and cavemem.
4. When home-manager activation runs once on a host that started with legacy `mcp-hub` keychain entries, no `mcp-hub`-accounted keychain entries shall remain after the activation completes.
5. When the operator runs `darwin-rebuild check` (or an equivalent eval-time verification command) against the post-migration config, that command shall succeed with no warnings or errors that name `mcp-hub` or `mcphub`.

### Requirement 15: Home Manager config ownership protection

**Objective:** As the operator, I want mcpproxy runtime cleanup and persistence to leave the Home Manager-owned config untouched, so that declarative activation remains the source of truth and mcpproxy startup cannot detach the managed symlink.

#### Acceptance Criteria

1. When mcpproxy starts or restarts under the managed launchd agent, the mcpproxy orchestrator module shall keep the Home Manager-owned rendered configuration path intact as a Home Manager-managed file or symlink.
2. If mcpproxy performs startup cleanup or runtime configuration persistence, the mcpproxy configuration protection shall prevent those writes from replacing, rewriting, or backing up the Home Manager-owned rendered configuration path.
3. When Home Manager renders a new mcpproxy configuration generation, the next managed mcpproxy start shall use that rendered generation as the source for the effective runtime configuration.
4. If the effective runtime configuration cannot be prepared, the managed mcpproxy launch shall fail before starting mcpproxy and shall write a stderr message naming the preparation failure.
5. While config protection is active, the managed mcpproxy launch shall preserve the behaviours required by Requirements 1 through 10 and Requirement 14.
6. The mcpproxy configuration protection shall require no manual filesystem immutability flag, root-owned config edit, or operator-maintained local patch to survive mcpproxy startup cleanup.
