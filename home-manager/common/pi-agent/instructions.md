# Managed Pi instructions

## Memory startup

Before any work, verify Obsidian through mcpproxy. The bundled AgentMemory Pi
integration performs its authenticated health check and provides memory tools
directly in Pi.

1. Invoke `retrieve_tools` with `{"query":"obsidian list-notes"}`. The returned
   `name` must begin with `obsidian:`. Pass the exact returned name unchanged to
   `call_tool_read`; when it returns `obsidian:list-notes`, invoke with
   `{"name":"obsidian:list-notes","args":{"directory":"memories","limit":1}}`.
2. Use the bundled `memory_health` tool when you need to verify AgentMemory,
   `memory_search` to recall prior Pi memory, and `memory_save` for durable
   facts. These tools use the standard authenticated AgentMemory routes.

Never guess a tool name. A missing expected prefix or any failed discovery or
invocation stops all work.

## mcpproxy

mcpproxy is the sole MCP entrypoint at the managed local `/mcp` transport. Its
live direct tool surface is exactly:

- `retrieve_tools`: discover available upstream tools and their call class.
- `describe_tool`: read the complete schema when discovery reports a lossy one.
- `call_tool_read`: invoke the exact discovered read-only tool name.
- `call_tool_write`: invoke the exact discovered state-changing tool name.
- `call_tool_destructive`: invoke the exact discovered destructive tool name.
- `read_cache`: page through a truncated cached result.

Always use discover-then-invoke: discover the exact tool name and schema first,
then pass that name and its arguments to the matching call tool.
`call_tool_write` and `call_tool_destructive` require explicit approval. Routed
reads rely on mcpproxy without another Pi approval gate.

## Packages and extensions

Required extensions are immutable and version-pinned. Do not use `pi install`,
`/pkg`, mutable package installation or update, self-update, or network package
mutation. Change Nix pins and managed generation together, then build and run
managed validation before activating that generation.

## Plan mode

Plan mode exposes exactly `read`, `grep`, `find`, `ls`, `plan_mode_question`,
and `plan_mode_complete`. While Plan mode is active, the call gate denies every
non-allowlisted tool call before effects. Plan completion requires operator
approval before restoring implementation tools.

## Subprocesses

Provider values belong only to root Pi and foreground child Pi. Bash,
background tasks, and language servers receive a credential-scrubbed
environment. The AgentMemory bearer remains in the root Pi process. Every managed subprocess uses bounded
process-group cleanup for cancellation, timeout, and session shutdown.

## Sandbox rollback

Use `PI_NONO=disabled pi` only for explicit rollback. It is a reported
unsandboxed fallback for one launch, not the default.
