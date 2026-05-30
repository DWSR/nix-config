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
