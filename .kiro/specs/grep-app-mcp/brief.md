# Brief: grep-app-mcp

## Problem

The operator wants agent-accessible public GitHub code search through
grep.app without leaving the existing mcpproxy-routed opencode MCP path.
Today the repo has mcpproxy and several host-specific upstreams, but no
declarative grep.app MCP package or upstream registration.

## Current State

MCP upstreams are rendered by `home-manager/mcp/default.nix` and host
configurations extend them through `home.mcp.extraServers`. Both hosts
already route opencode to the local mcpproxy endpoint. Existing MCP
packages live in `overlays/mcp-servers.nix`; npm and GitHub-sourced
servers are already packaged there. The requested upstream repository is
`ai-tools-all/grep_app_mcp`, a TypeScript/FastMCP server with stdio and
HTTP transports and no documented required API key.

## Desired Outcome

`grep_app_mcp` is packaged reproducibly, registered as a mcpproxy
upstream on the personal and Shopify hosts, and verifiable through Nix
checks and rendered mcpproxy config evaluation. Agents discover grep.app
tools only through mcpproxy's existing `retrieve_tools` surface.

## Approach

Add a small, single-scope integration: package the upstream TypeScript
server from a pinned GitHub source, expose a stable stdio launcher, add a
host-neutral `grep-app` upstream under `home.mcp.extraServers` on both
hosts, and add build/render checks. Stdio avoids introducing a separate
long-lived HTTP service or port ownership; mcpproxy remains the only
daemon opencode talks to.

## Scope

- **In**: Nix package; stdio launcher; both-host mcpproxy upstream
  registration; package and config-render checks; minimal operator notes
  if needed.
- **Out**: Direct opencode MCP entries; mcpproxy core changes; new secret
  storage; grep.app API key management; HTTP/SSE service launchd;
  upstream patches unless required for build or stdio correctness;
  changes to AGENTS.md tool-use policy.

## Boundary Candidates

- Package boundary: `pkgs.grep-app-mcp` owns source pinning, npm deps,
  build, and launcher shape.
- Registration boundary: host configs add a mcpproxy upstream using the
  existing `home.mcp.extraServers` option.
- Verification boundary: flake checks prove package launchability and
  rendered mcpproxy config inclusion without calling external grep.app or
  GitHub APIs.

## Out of Boundary

- Making grep.app tools mandatory in the AGENTS.md startup check.
- Reclassifying mcpproxy's read/write/destructive routing semantics.
- Adding per-project tool allowlists or mcpproxy ranking tuning.
- Owning grep.app service availability, upstream API quotas, or public
  GitHub file-fetch rate limits.

## Upstream / Downstream

- **Upstream**: `ai-tools-all/grep_app_mcp`; existing `mcpproxy-migration`
  module and `home.mcp.extraServers`; existing Nix overlay patterns.
- **Downstream**: opencode agents can retrieve the upstream tools through
  mcpproxy; future agent prompts may mention grep.app search examples but
  this spec does not require prompt changes.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `mcpproxy-migration` owns the daemon, routing mode, and
  four-tool surface; this spec only consumes its extension point.

## Constraints

- Keep the integration declarative and reproducible through Nix.
- Preserve mcpproxy's four-tool retrieve_tools mode and existing opencode
  remote MCP wiring.
- Do not write secrets into rendered config or the Nix store.
- Keep tests deterministic and avoid live network calls in flake checks.
