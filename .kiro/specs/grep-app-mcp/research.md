# Research: grep-app-mcp

## Summary

- The existing integration point is `home.mcp.extraServers`; opencode
  already talks only to mcpproxy on both hosts.
- `ai-tools-all/grep_app_mcp` is a TypeScript/FastMCP server with stdio
  and HTTP transports. Stdio is the smaller integration boundary.
- No API key is documented. Tests should avoid live grep.app and GitHub
  calls because the upstream tools depend on public network services.

## External Dependency Findings

### Upstream repository

- Source: <https://github.com/ai-tools-all/grep_app_mcp>
- Runtime: Node.js 18+, TypeScript, FastMCP.
- Package metadata from `package.json`: name `grep_app_mcp`, version
  `1.0.0`, license `ISC`, ESM module type.
- Runtime dependencies include `fastmcp`, `axios`, `@octokit/rest`,
  `octokit`, `cheerio`, `winston`, `winston-daily-rotate-file`, and
  `zod`.
- Available scripts include `npm run build`, `npm run start`, and
  `npm run start-stdio`.

### Transports and tools

- README documents stdio invocation as `node dist/server-stdio.js`.
- README documents HTTP endpoints at `http://localhost:8603/mcp` and
  `/sse`, but HTTP mode would require another long-lived server and port.
- README lists four tools: `searchCode`, `github_file`,
  `github_batch_files`, and `batch_retrieve_files`.
- Tool semantics are read-only from the local configuration perspective,
  but they call external public services.

### Compatibility and risks

- The upstream `vite.config.ts` contains duplicate `rollupOptions` keys;
  implementation should prefer `npm run build` via `tsc` unless a bundled
  single-file launcher is required.
- Upstream logging writes to `logs/` by default. The package or runtime
  wrapper may need `HOME`/working-directory hygiene if stdio startup writes
  under the Nix store or caller CWD.
- The repository appears small and has no release tags visible from the
  README page. Pinning a commit hash is safer than tracking a branch.

## Existing Codebase Gap Analysis

### Existing capabilities

- `overlays/mcp-servers.nix` already packages npm, Go, Python, and tarball
  MCP servers.
- `home-manager/mcp/default.nix` translates `home.mcp.extraServers` into
  mcpproxy's `mcpServers` array and sets `routing_mode = "retrieve_tools"`.
- Personal and Shopify host configs already declare host-specific upstreams
  through `home.mcp.extraServers`.
- Both opencode host configs already route to `http://127.0.0.1:8080/mcp`.

### Missing capabilities

- No `pkgs.grep-app-mcp` package exists.
- No host config declares a grep.app upstream.
- No flake check verifies this package or the rendered upstream entry.

### Options considered

1. **Stdio upstream via mcpproxy** — package the server and register
   `command = "${pkgs.grep-app-mcp}/bin/grep-app-mcp"`. This matches
   existing stdio upstreams and keeps mcpproxy as the only daemon.
2. **HTTP upstream with launchd** — run the server on port 8603 and point
   mcpproxy at it. This adds port ownership and another service without a
   requirement-level benefit.
3. **Direct opencode local MCP entry** — bypass mcpproxy. Rejected because
   it violates the mcpproxy-migration boundary and re-expands MCP schema
   exposure.

## Design Decision Inputs

- Use stdio for first implementation.
- Add the upstream to both host configs unless implementation discovers a
  host-specific runtime blocker.
- Keep any grep.app availability checks manual or post-activation; do not
  add grep.app to mandatory startup gates.
- Use deterministic Nix checks for package build and config rendering only.
