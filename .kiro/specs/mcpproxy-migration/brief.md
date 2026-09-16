# Brief: mcpproxy-migration

## Problem

`ravitemer/mcp-hub` orchestrates obsidian, github, mcp-nixos, and cavemem
behind a single SSE endpoint that opencode (and historically nvim's
codecompanion) consumes. It costs us on three axes:

1. **Token bloat at the agent surface.** ~140 upstream tool schemas land
   in opencode's uncached prefix on every request. Roadmap's
   `mcp-server-allowlist` deferred spec targets this; classifier
   degradation prevented direct quantification.
2. **Operational instability.** v4.2.1 dumps the entire bundled `cli.js`
   as a stack trace on transient "Maximum call stack size exceeded"
   warnings; logs reached ~18 GB in five hours of normal use
   (`memories/2026-05-14-mcp-hub-api-surface-and-wrapper-quoting.md`).
   Upstream bug, unfixable in our HM module.
3. **Coupling that resists evolution.** `${cmd:...}` keychain
   interpolation, the `:37373` HTTP API, the `com.ravitemer.mcp-hub`
   launchd label, and the cavemem split-brain
   (`cavemem.nix:466-487`) are baked into 20+ files.

## Current State

mcp-hub fronts four MCP servers behind `:37373/mcp/`. Opencode connects
as a remote MCP provider; cavemem also registers as a direct opencode
local-MCP entry (the split-brain). Secrets flow SOPS → `security
add-generic-password -s <secret-name> -a mcp-hub` → mcp-hub's
`${cmd:...}` placeholder expansion at server-spawn time. Sub-agent
inventory enumerated touchpoints across packaging
(`flake.nix:73-79`, `overlays/mcp-servers.nix:36`), the orchestrator
module (`home-manager/mcp/default.nix`), the secret bridge
(`scripts/mcp-secrets-activate.nix` + `mcp-verify-secrets.nix`,
13 secrets across both hosts), wrapper probes hitting `:37373`
(`opencode.nix`, `cavemem.nix`, `memory-sync.nix`), the
`hub_*`-prefixed tool-name contract across agents.md, common subagent
prompts, and Shopify agents, nvim integration (3 plugin files + 2 flake
inputs), and sqlite-backup's opportunistic piggyback on the
`mcp-hub` keychain account.

## Desired Outcome

`mcp-hub` and `mcphub-nvim` are gone. `mcpproxy-go` runs under launchd
as the sole MCP entrypoint; opencode consumes its `/mcp/` endpoint.
The cavemem split-brain is closed — cavemem reaches opencode only via
mcpproxy. The SOPS → Keychain bridge writes the layout mcpproxy
expects (`service=mcpproxy, account=<secret-name>`); rendered
`mcp_config.json` references `${keyring:<secret-name>}`. Sqlite-backup
secrets live under a separate neutral account name so the
storage-backend doesn't leak into unrelated secret families. The
agent tool surface is mcpproxy's four-tool retrieve_tools mode
(`retrieve_tools`, `call_tool_read`, `call_tool_write`,
`call_tool_destructive`); AGENTS.md startup gate, memory recall,
and every subagent prompt are rewritten around it. Nvim is no
longer an MCP consumer.

## Approach

**Approach 2 — Clean-cut migration** (confirmed in discovery):

- mcpproxy-go packaged via `buildGoModule` from a **pinned commit**
  (not a release tag, not `main` — config schema evolves quickly per
  viability check).
- `home-manager/mcp/default.nix` rewritten to emit `mcp_config.json`
  (mcpproxy's array shape with `protocol`, `enabled`,
  `skip_quarantine: true`) instead of `servers.json`. Launchd label
  flips to `com.smart-mcp-proxy.mcpproxy`; default port `8080`
  exposed as a module option.
- Secret bridge axes swap: `mcp-secrets-activate.nix` writes
  `-s mcpproxy -a <secret-name>` (was `-s <secret-name> -a mcp-hub`).
  One-shot cleanup of old entries in the same activation pass.
- Cavemem moves into mcpproxy as a stdio upstream; the direct
  `programs.opencode.settings.mcp.cavemem` entry is removed.
- All `:37373` wrapper probes (opencode.nix, cavemem.nix,
  memory-sync.nix) rewritten against mcpproxy's HTTP API; recovery
  hints repoint at the new launchd label.
- AGENTS.md + all subagent prompts + Shopify agents/skills rewritten
  for the four-tool retrieve_tools surface (2-step retrieve+invoke
  ritual where `hub_*` calls were direct). Copy referencing
  "mcphub" in agents.md, agents-cc-sdd.md, secrets/README.md, and
  `agents/nix-pkg.md` updates simultaneously.
- Nvim integration removed: `nixvim/plugins/{mcphub,codecompanion,
  lualine}.nix` entries, the `imports` line, and both flake inputs.
- Sqlite-backup keychain account migrates from `mcp-hub` to a
  neutral name (e.g. `nix-config-secrets` — final name settled in
  design); activation handles the rename in one shot.

## Scope

- **In**: mcpproxy-go Nix package + flake input; rewrite of
  `home-manager/mcp/default.nix`; SOPS→Keychain bridge axes swap +
  cleanup; cavemem split-brain closure; all wrapper probes;
  AGENTS.md / subagents / Shopify agents+skills rewrite for the
  four-tool retrieve_tools surface; removal of `mcphub.nvim` +
  codecompanion MCP extension + lualine status component + 2 flake
  inputs; sqlite-backup keychain account rename; `restart-mcp-hub`
  helper repointed at the new launchd label.

- **Out**: new MCP server integrations; mcpproxy BM25 / `top_k` /
  `tools_limit` tuning beyond defaults; replacing SOPS as source of
  truth; migrating sqlite-backup off macOS Keychain; nvim-side
  replacement plugin for mcphub.nvim; opencode plugin / hook
  architecture changes; cavemem internals (schema, embedding,
  patches); mcpproxy quarantine workflow customisation beyond
  `skip_quarantine: true`. Formal closure of the
  `mcp-server-allowlist` deferred spec — superseded but not closed
  in this spec body; roadmap updated to record the supersession.

## Boundary Candidates

Natural seams inside this spec (tightly coupled; all ship together):

- **Packaging** — overlay entry + flake-input cleanup.
- **Orchestrator** — `mcp/default.nix` rewrite + launchd label +
  port option + quarantine pre-approval.
- **Secret bridge** — activate + verify script axes swap with
  one-shot cleanup.
- **Cavemem integration** — drop direct opencode entry + repoint
  wrapper probe.
- **Opencode integration** — endpoint URL flip + wrapper probe
  rewrite.
- **Agent retrieve_tools migration** (largest sub-seam) — AGENTS.md
  + common subagents + Shopify agents/skills.
- **Nvim removal** — 3 plugin files + imports + 2 flake inputs +
  codecompanion extension block.
- **Sqlite-backup keychain rename** — sqlite-backup-cli.nix +
  sqlite-backup.nix + sqlite-backup-verify.nix + activation
  registry.

## Out of Boundary

Explicit non-goals already listed under **Scope / Out** above.

## Upstream / Downstream

- **Upstream (this spec mutates)**: `mcp-secrets-sops-nix` (axes
  swap + activation cleanup); `cavemem-integration` (Tasks 5.1-5.3
  outputs replaced; the spec's locked `hub_cavemem__*` contract is
  intentionally broken and the cavemem-integration requirements
  should reference this migration as the resolution); `sqlite-backup`
  (account rename; docs reference `mcp-hub` opportunistically).
  Roadmap updated: `mcp-server-allowlist` superseded.
- **Downstream (stable contracts produced)**: future MCP server
  additions land via mcpproxy's array schema; future agent prompts
  follow the retrieve_tools 2-step pattern; future cost-diagnosis
  runs measure the post-migration token reduction as acceptance;
  the deferred `agents-md-modularization` may build on the
  retrieve_tools surface if it ships later.

## Existing Spec Touchpoints

- **Extends / mutates**: `mcp-secrets-sops-nix`,
  `cavemem-integration`, `sqlite-backup`. Implementations modified;
  specs not re-opened for rework.
- **Adjacent (referenced only)**: `opencode-cost-diagnosis`
  (acceptance metric); `session-compaction` (benefits from a
  thinner MCP surface, doesn't block).

## Constraints

- **macOS only** (nix-darwin).
- **Declarative** — no `mcpproxy secrets set`; mcpproxy refuses
  keyring writes on macOS anyway. Activation uses
  `/usr/bin/security` from the existing SOPS-bridge script.
- **Pin mcpproxy to a commit**, not a tag, not `main`. Config
  schema deprecations already visible at v0.33.1.
- **Upstream-beta MCP SDK** (`mark3labs/mcp-go v0.44.0-beta.2`).
  SDK bump = revalidation trigger.
- **`${keyring:foo}` placeholders work in `env` and `args` only** —
  not in `command` or `url`. Secrets reach servers via env vars
  (already the pattern for github-mcp-server).
- **One-shot keychain migration per host**. Activation cleans up
  the old `-a mcp-hub` entries in the same run.
- **Acceptance via memory startup gate**. The rewritten
  retrieve_tools-based startup gate must function end-to-end
  before the spec is accepted; the gate is the existence proof
  that the migration didn't strand the agent.
