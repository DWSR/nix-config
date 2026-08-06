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
through local mcpproxy, and records sessions through Cavemem. Pi has no
equivalent module or wrapper. Shopify's `devx pi` supplies additional managed
behavior, but this feature intentionally targets direct Pi on both hosts.

## Desired Outcome
Both hosts expose a direct, Nix-managed `pi` command. A host-aware wrapper
reconciles managed configuration, resolves runtime-only values, validates
dependencies, and launches Pi under a managed nono profile. Pi uses the local
mcpproxy endpoint, captures sessions in the existing Cavemem database, and
loads a pinned extension set for sub-agents, plan mode, timestamps, Bash
timeouts, user questions, code intelligence, and background tasks.

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
  Bash timeout, user questions, code intelligence, and background tasks. A
  small repository-owned extension maps Pi lifecycle events to Cavemem hooks.

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
  - A repository-owned Pi-to-Cavemem ambient-capture extension and an opt-in
    Cavemem hook patch that preserves complete redacted Pi tool payloads
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
  - Changes to mcpproxy, the Cavemem storage schema or MCP surface, or the
    existing OpenCode nono module

## Boundary Candidates
- Pi package, extension closure, and Home Manager option surface
- Managed configuration ownership and per-host provider composition
- Preflight, rollout resolution, and nono launcher topology
- MCP, sub-agent, plan, Cavemem, LSP, and background-task contracts
- Cross-host evaluation and runtime acceptance evidence

## Out of Boundary
- Generalizing OpenCode's wrapper or nono renderer into a shared framework
- Synchronizing Pi sessions, credentials, or mutable state between hosts
- Supporting non-Darwin systems
- Importing the complete `shop-pi-fy` extension catalog
- Redesigning Pi permissions, mcpproxy routing, or Cavemem storage

## Upstream / Downstream
- **Upstream**: `pi.nix`, upstream Pi, the public nono Pi pack, `pkgs.nono`,
  local mcpproxy, the existing Cavemem installation, and Shopify's
  `devx llm-gateway` commands
- **Downstream**: a future Sieve/output-compression spec and later curated Pi
  extension additions

## Existing Spec Touchpoints
- **Extends**: `cavemem-integration` hook ingestion with an opt-in full-payload
  mode used only by the managed Pi bridge
- **Adjacent**: `opencode-nono-sandbox` owns OpenCode-only launch profiles;
  `mcpproxy-migration` owns the local MCP service; `cavemem-integration` owns
  Cavemem packaging and storage. This feature consumes those live surfaces
  without reopening their specifications.

## Constraints
- Target `aarch64-darwin` on `ShopifyLaptop` and
  `Brandons-MacBook-Pro`.
- Keep secrets and private Shopify source out of derivations, generated static
  files, logs, and the anonymously readable binary cache.
- Pin all external sources and preserve their license notices.
- Do not mutate Pi configuration during Home Manager activation; runtime
  reconciliation must be locked, atomic, provenance-aware, and limited to
  managed keys.
- Plan mode must expose only read-only tools by default.
- Background jobs, LSP servers, sub-agents, and Cavemem hooks must operate
  inside the active nono profile and leave no orphan processes.
- A known high-severity dependency advisory and the required context-limit
  recovery behavior must be resolved before either host enables Pi.
- Full Pi tool payloads remain subject to secret/private-content redaction; the
  patch removes truncation and grammar compression, not privacy controls.

## Source Request
> Write a spec to add Pi to both hosts' configurations. Use a similar approach to Opencode: Wrap Pi in order to be able to inject configuration values for things like the mcp server configurations and nono. There is a nono profile here that can be used. https://github.com/nolabs-ai/nono-packs/tree/main/pi. Also inspect the Shopify Pi configuration (details in this Slack thread) https://shopify.slack.com/archives/C0ASWCJ0Y6M/p1785896169075539 for any Shopify-specific things. There is a Home Manager Pi flake here: https://github.com/lukasl-dev/pi.nix. Include extensions for sub-agents, mcp servers, plan mode, cavemem, sieve. Also inspect shop-pi-fy to see what extensions might be useful: https://github.com/shopify-playground/shop-pi-fy
