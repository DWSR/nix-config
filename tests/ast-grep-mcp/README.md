# ast-grep MCP validation

This suite verifies the packaged `ast-grep-mcp` server and rendered
mcpproxy host entries without running structural searches over the working
tree.

Run the checks with:

```sh
nix build .#checks.aarch64-darwin.ast-grep-mcp
nix flake check --show-trace
```

## Post-switch mcpproxy smoke check

After `darwin-rebuild switch` restarts mcpproxy, verify that the upstream is
discoverable through the mcpproxy tool-discovery wrapper:

```text
retrieve_tools(query: "ast grep structural search")
```

The expected result shape is one or more ast-grep tool rows, for example a
`ast-grep:<tool>` name or `server: "ast-grep"`, plus a `call_with` value.
Invoke each tool only through the matching mcpproxy wrapper named by
`call_with`; read-only/search tools should go through `call_tool_read` when
returned that way.

File-search tools require an explicit absolute `project_folder` chosen by the
operator for that invocation. Do not add ast-grep to the mandatory opencode
startup gate / startup-gate checks, and do not automate repository searches as
part of activation or validation.

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
