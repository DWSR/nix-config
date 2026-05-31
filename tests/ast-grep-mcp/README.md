# ast-grep MCP validation

This suite verifies the packaged `ast-grep-mcp` server and rendered
mcpproxy host entries without running structural searches over the working
tree.

Run the checks with:

```sh
nix build .#checks.aarch64-darwin.ast-grep-mcp
nix flake check --show-trace
```

## Operator-facing upstream limitations

- `ast-grep-mcp --help` is the finite smoke path used by automated checks.
  Running `ast-grep-mcp` without arguments starts the stdio server and exits
  when stdin closes.
- The upstream server defaults to stdio. It does not require a project path,
  secret, or writable current working directory at startup.
- `--config PATH` and `AST_GREP_CONFIG=PATH` are optional. If either points to
  a missing path, startup exits with status 1.
- Search tools require explicit absolute `project_folder` arguments chosen by
  the operator. Automated checks avoid `find_code`, `find_code_by_rule`, and
  any repository search invocation.
