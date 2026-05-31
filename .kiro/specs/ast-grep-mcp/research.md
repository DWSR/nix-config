# Research: ast-grep-mcp

## Summary

- The existing integration point is `home.mcp.extraServers`; opencode already talks only to mcpproxy on both hosts.
- `ast-grep/ast-grep-mcp` is a Python 3.13 FastMCP server with stdio default and optional SSE transport.
- The server depends on the external `ast-grep` CLI at runtime and does not document secrets.
- Search tools require an explicit absolute `project_folder`; automated checks should avoid invoking them against the user's repo.

## External Dependency Findings

### Upstream repository

- Source: <https://github.com/ast-grep/ast-grep-mcp>
- Current `main` ref during research: `732c339c3812a44e9111e6c3aefec64894acd58f`.
- No release tags were returned by `git ls-remote`.
- License: MIT.
- Package metadata from `pyproject.toml`: project name `sg-mcp`, version `0.1.0`, Python `>=3.13`.
- Python dependencies: `pydantic>=2.11.0`, `mcp[cli]>=1.6.0`, and `pyyaml>=6.0.2`.
- The upstream console script is `ast-grep-server = "main:run_mcp_server"`.

### Runtime behavior

- README documents `uvx --from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server`.
- README documents stdio client config through `uv --directory /absolute/path/to/ast-grep-mcp run main.py`.
- `main.py` defaults `--transport stdio`; it also supports `--transport sse --port <port>`.
- `main.py --help` is handled by argparse before starting the MCP server.
- Custom ast-grep config is optional via `--config /path/to/sgconfig.yaml` or `AST_GREP_CONFIG`.
- No default project path is needed at server startup. `find_code` and `find_code_by_rule` require an absolute `project_folder` argument per tool schema.
- The server shells out to `ast-grep run` and `ast-grep scan`; the packaged launcher must put `pkgs.ast-grep` on `PATH`.
- No file logging or startup CWD write was visible in `main.py`.

### Tools

- `dump_syntax_tree` calls `ast-grep run --pattern <code> --lang <language> --debug-query=<format>`.
- `test_match_code_rule` calls `ast-grep scan --inline-rules <yaml> --json --stdin`.
- `find_code` calls `ast-grep run --pattern <pattern> --json=stream <project_folder>`.
- `find_code_by_rule` calls `ast-grep scan --inline-rules <yaml> --json=stream <project_folder>`.
- The tools are local read/analysis operations from the host configuration perspective.

## Existing Codebase Gap Analysis

### Existing capabilities

- `overlays/mcp-servers.nix` already packages MCP servers and includes the completed `grep-app-mcp` pattern.
- `home-manager/mcp/default.nix` translates `home.mcp.extraServers` into mcpproxy's `mcpServers` array and keeps `routing_mode = "retrieve_tools"`.
- Personal and Shopify host configs already declare host-specific upstreams through `home.mcp.extraServers`.
- Both host configs already include `grep-app`; ast-grep should preserve it.
- Nixpkgs in this flake exposes `pkgs.ast-grep`, `pkgs.python313`, `pkgs.python313Packages.mcp`, `pydantic`, and `pyyaml`.

### Missing capabilities

- No `pkgs.ast-grep-mcp` package exists.
- No host config declares an `ast-grep` upstream.
- No flake check verifies this package or the rendered upstream entry.
- No operator README explains post-switch mcpproxy discovery or the explicit `project_folder` requirement.

### Options considered

1. **Stdio upstream via mcpproxy** — package the Python server and register `command = "${pkgs.ast-grep-mcp}/bin/ast-grep-mcp"`. This matches existing stdio upstreams and keeps mcpproxy as the only daemon.
2. **SSE upstream with launchd** — run the server with `--transport sse --port 3101` and point mcpproxy at it. This adds port ownership and another service without a requirement-level benefit.
3. **Direct opencode local MCP entry** — bypass mcpproxy. Rejected because it violates the mcpproxy-migration boundary and re-expands MCP schema exposure.

## Design Decision Inputs

- Use stdio for first implementation.
- Package a stable `ast-grep-mcp` launcher that runs the upstream Python entrypoint with Python dependencies and `ast-grep` on `PATH`.
- Add the upstream to both host configs unless implementation discovers a host-specific runtime blocker.
- Keep live structural searches manual and caller-directed; do not add them to flake checks or startup gates.
