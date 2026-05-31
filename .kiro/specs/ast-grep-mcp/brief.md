# Brief: ast-grep-mcp

## Problem

The operator wants structural code search available to agents through the existing mcpproxy-routed opencode MCP path. The repo already has mcpproxy, host-specific upstreams, and a completed grep-app MCP pattern, but no declarative ast-grep MCP package or upstream registration.

## Current State

MCP upstreams are rendered by `home-manager/mcp/default.nix` and extended through `home.mcp.extraServers`. Both personal and Shopify hosts route opencode to mcpproxy only. Existing MCP packages live in `overlays/mcp-servers.nix`; grep-app proved the package/register/check pattern for a stdio upstream.

## Desired Outcome

`ast-grep/ast-grep-mcp` is packaged reproducibly, registered as a mcpproxy upstream on the personal and Shopify hosts, and verified through deterministic package and render checks. Agents discover ast-grep tools only through mcpproxy's existing `retrieve_tools` surface.

## Approach

Add a small, single-scope integration: package the upstream Python MCP server from a pinned GitHub source, include the `ast-grep` CLI runtime dependency, expose a stable stdio launcher, add `ast-grep` under `home.mcp.extraServers` on both hosts, and add package/render checks. Stdio avoids a launchd service, TCP port, HTTP/SSE ownership, or direct opencode MCP entry.

## Scope

- **In**: Nix package; stdio launcher; runtime `ast-grep` CLI dependency; both-host mcpproxy upstream registration; deterministic package and config-render checks; operator smoke notes.
- **Out**: Direct opencode MCP entries; mcpproxy core changes; new secrets; new launchd service; TCP/HTTP/SSE service ownership; mandatory startup-gate checks; repository-wide live ast-grep searches in automated checks.

## Boundary Candidates

- Package boundary: `pkgs.ast-grep-mcp` owns source pinning, Python runtime dependencies, `ast-grep` CLI availability, and launcher shape.
- Registration boundary: host configs add a mcpproxy upstream through `home.mcp.extraServers`.
- Verification boundary: flake checks prove package startup/help behavior and rendered mcpproxy config inclusion without running searches over the user's repo.

## Out of Boundary

- Making ast-grep tools mandatory in AGENTS.md startup checks.
- Adding default per-project `sgconfig.yaml` files or language policy.
- Owning ast-grep rule authoring prompts beyond concise smoke guidance.
- Changing mcpproxy routing, ranking, or schema-hiding behavior.

## Upstream / Downstream

- **Upstream**: `ast-grep/ast-grep-mcp`; existing `pkgs.ast-grep`; Python 3.13 packages; existing `mcpproxy-migration` module and `home.mcp.extraServers`.
- **Downstream**: opencode agents can retrieve structural search tools through mcpproxy; future prompts may mention ast-grep examples but this spec does not require prompt changes.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `grep-app-mcp` provides the direct package/register/check template. `mcpproxy-migration` owns the daemon, routing mode, and four-tool surface.

## Constraints

- Preserve mcpproxy's four-tool retrieve/invoke surface.
- Keep tests deterministic and free of live searches over the operator's repo.
- Do not add secrets or write secret-derived values into rendered config.
- Prefer stdio unless upstream research proves it cannot support the required tools.
