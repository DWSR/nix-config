# Brief: pi-agent-integration

## Problem
The operator uses the same nix-darwin repository for a personal Mac and
`ShopifyLaptop`, but Pi is not installed or configured declaratively on either
host. A raw Pi install would leave provider routing, MCP access, sandboxing,
extensions, and mutable configuration outside the repository's existing safety
and reproducibility model.

## Current State
OpenCode already separates static Home Manager configuration from dynamic
wrapper values, launches through managed nono profiles, reaches upstream tools
through local mcpproxy, and uses the managed AgentMemory runtime introduced by
`agentmemory-opencode-migration`. That migration also packages AgentMemory's
bundled Pi integration and standard authenticated REST routes. Pi has no
equivalent managed module or wrapper in this spec's baseline. Shopify's
`devx pi` supplies additional managed behavior, but this feature intentionally
targets direct Pi on both hosts.

## Desired Outcome
Both hosts expose a direct, Nix-managed `pi` command. A host-aware wrapper
reconciles managed configuration, resolves runtime-only values, validates
dependencies, and launches Pi under a managed nono profile. Pi uses the local
mcpproxy endpoint, captures and recalls sessions through the existing
AgentMemory daemon, and loads a pinned extension set for sub-agents, plan mode,
timestamps, Bash timeouts, user questions, code intelligence, and background
tasks. Pi has no Cavemem runtime dependency or live dual-write path.

## Approach
Use the `pi.nix` package surface with a repository-owned Home Manager module and
wrapper modeled on the OpenCode split:

- Home Manager owns package pins, resource paths, managed configuration
  fragments, extension closures, nono profiles, and host defaults.
- The wrapper locks and reconciles only repository-owned JSON keys while
  preserving unrelated mutable Pi state.
- The Shopify wrapper obtains the LLM gateway token and base URL through
  `devx llm-gateway`, creates a per-launch session identifier, and combines
  those values with a static provider catalog. Secret values never enter the
  Nix store.
- The personal host uses declarative personal provider settings without
  Shopify dependencies.
- Both hosts launch bare Pi through Pi-specific profiles adapted from the
  public `nolabs-ai/nono-packs` Pi policy.
- Public, pinned extensions provide MCP, sub-agents, plan mode, timestamps,
  Bash timeout, user questions, code intelligence, and background tasks.
- AgentMemory's packaged `integrations/pi/` extension, with only reviewed
  Pi-API compatibility substitutions, provides stock lifecycle capture,
  automatic pre-agent recall, memory tools, session end, and consolidation
  against the managed authenticated REST endpoint.
- The wrapper resolves the AgentMemory bearer from the existing managed secret
  reference and gives it only to provider-capable root and foreground child Pi
  processes. Model-invoked subprocesses receive scrubbed environments.

## Scope
- **In**:
  - Pi packaging and Home Manager enablement on both nix-darwin hosts
  - A common host-aware wrapper with preflight, managed-config reconciliation,
    runtime provider values, rollout state, and nono launch
  - Static personal and Shopify provider catalogs with host-specific defaults
  - Pi-specific managed, audit, and review nono profiles derived from the
    public Pi pack
  - One remote Pi MCP connection to the existing local mcpproxy service
  - Pinned public extensions for sub-agents, plan mode, timestamps, Bash
    timeout, user questions, code intelligence, and background tasks
  - Pi-harness consumption of the bundled AgentMemory extension, managed REST
    endpoint and bearer, full-daemon preflight, status, sandbox grants, child
    inheritance, and acceptance evidence
  - Dependency security fixes and compatibility patches required by the pinned
    Pi release
  - Evaluation, wrapper, extension, sandbox, provider, and two-host smoke tests
- **Out**:
  - Sieve or another tool-output compressor
  - Exact `devx pi` parity, including its migration, package-policy, update,
    telemetry, and managed-default behavior
  - Private `shop-pi-fy`, Shopify proxy, or Shopify Sieve source in a Nix
    closure
  - A second direct Shopify Tool Gateway connection alongside mcpproxy
  - Pi self-updates or imperative `pi install`, `/pkg`, and `nono pull` flows
  - Changes to mcpproxy, AgentMemory persistence/query contracts, the existing
    OpenCode plugin, or the OpenCode nono module
  - AgentMemory package/runtime, Pi activation, Cavemem removal, backup, import,
    or OpenCode rollback owned by `agentmemory-opencode-migration`
  - Custom AgentMemory capture, retry, queue, raw-event, project-isolation,
    truncation, consolidation, or fallback behavior
  - Re-migration of Pi history from Cavemem

## Boundary Candidates
- Pi package, extension closure, and Home Manager option surface
- Managed configuration ownership and per-host provider composition
- Preflight, rollout resolution, and nono launcher topology
- MCP, AgentMemory, sub-agent, plan, LSP, and background-task contracts
- Cross-host evaluation and runtime acceptance evidence

## Out of Boundary
- Generalizing OpenCode's wrapper or nono renderer into a shared framework
- Synchronizing Pi sessions, credentials, or mutable state between hosts
- Supporting non-Darwin systems
- Importing the complete `shop-pi-fy` extension catalog
- Redesigning Pi permissions or adding a Pi-core reference monitor
- Adversarial isolation among the managed in-process Pi extensions
- Arbitrary subprocesses that create a new session or process group outside a
  registered managed child process group
- Changing mcpproxy routing or AgentMemory storage
- Restoring Pi-specific Cavemem behavior in an OpenCode rollback generation

## Upstream / Downstream
- **Upstream**: `pi.nix`, upstream Pi, the public nono Pi pack, `pkgs.nono`,
  local mcpproxy, `agentmemory-opencode-migration`, the managed AgentMemory
  package/runtime, and Shopify's `devx llm-gateway` commands
- **Downstream**: a future Sieve/output-compression spec and later curated Pi
  extension additions

## Existing Spec Touchpoints
- **Extends**: none; this spec consumes the migration's Pi activation and owns
  only harness composition around the managed runtime and bundled integration
- **Adjacent**: `opencode-nono-sandbox` owns OpenCode-only launch profiles;
  `mcpproxy-migration` owns the local MCP service;
  `agentmemory-opencode-migration` owns AgentMemory packaging, daemon, core MCP
  registration, data, and backup. This feature consumes those surfaces without
  reopening them. Cavemem is an OpenCode-only rollback backend.

## Constraints
- Target `aarch64-darwin` on `ShopifyLaptop` and
  `Brandons-MacBook-Pro`.
- Keep secrets and private Shopify source out of derivations, generated static
  files, logs, and the anonymously readable binary cache.
- Pin all external sources and preserve their license notices.
- Do not mutate Pi configuration during Home Manager activation; runtime
  reconciliation must be locked, atomic, provenance-aware, and limited to
  managed keys.
- Plan mode must select read-only tools by default and block non-allowlisted
  model tool calls before execution.
- Background jobs, LSP servers, sub-agents, and the AgentMemory integration must
  operate inside the active nono profile. Managed child processes must clean up
  their registered process groups plus ordinary descendants that remain in
  those groups.
- A known high-severity dependency advisory and the required context-limit
  recovery behavior must be resolved before either host enables Pi.
- Accept AgentMemory's stock Pi observation limits, fire-and-forget capture,
  project attribution, context injection, consolidation, and failure behavior.
  This feature does not restore Cavemem's full-payload guarantees.
- Keep the AgentMemory bearer out of managed JSON, Nix store literals, logs,
  status output, Bash, background tasks, language servers, and validator probes.

## Source Request
> Write a spec to add Pi to both hosts' configurations. Use a similar approach to Opencode: Wrap Pi in order to be able to inject configuration values for things like the mcp server configurations and nono. There is a nono profile here that can be used. https://github.com/nolabs-ai/nono-packs/tree/main/pi. Also inspect the Shopify Pi configuration (details in this Slack thread) https://shopify.slack.com/archives/C0ASWCJ0Y6M/p1785896169075539 for any Shopify-specific things. There is a Home Manager Pi flake here: https://github.com/lukasl-dev/pi.nix. Include extensions for sub-agents, mcp servers, plan mode, cavemem, sieve. Also inspect shop-pi-fy to see what extensions might be useful: https://github.com/shopify-playground/shop-pi-fy
The source request predates `agentmemory-opencode-migration`; AgentMemory now
supersedes its Cavemem request, while Sieve remains deferred.
