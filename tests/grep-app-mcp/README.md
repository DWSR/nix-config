# grep-app MCP validation notes

This suite verifies the packaged `grep-app-mcp` binary and rendered
mcpproxy host configuration without making live grep.app, GitHub, or raw
file requests.

## Upstream runtime limitations

- Running `grep-app-mcp` starts the stdio MCP server immediately. The
  upstream package does not provide a `--help` or `--version` path for a
  finite startup smoke test.
- The upstream logger creates a `logs/` directory under `process.cwd()` at
  module load. The package wrapper changes the working directory to `$HOME`
  before starting the server so rotating runtime logs are written under
  `$HOME/logs` instead of the Nix store or the caller's current directory.

## Automated checks

Run the targeted check with:

```sh
nix build ".#checks.$(nix eval --impure --raw --expr builtins.currentSystem).grep-app-mcp"
```

Run the full repository check with:

```sh
nix flake check --show-trace
```

## Manual post-switch smoke

After `darwin-rebuild switch` restarts mcpproxy, verify that the upstream is
connected through the wrapper surface by discovering tools, not by calling a
live grep.app search in automated checks:

```text
retrieve_tools(query: "grep app code search")
```

The result should include grep.app tool rows, for example a `grep-app:<tool>`
name or `server: "grep-app"`, with `call_with: "call_tool_read"`. Invoke any
read-only grep.app search or file-retrieval tool only through `call_tool_read`.

Do not add grep.app to the mandatory opencode startup-gate checks. It remains
an operator smoke target after mcpproxy activation, while flake checks avoid
live grep.app, GitHub, and raw file requests.
