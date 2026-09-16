# Managed Pi instructions

## Memory startup

AgentMemory is Pi's sole memory service. Its managed startup checks the
authenticated service; use its core memory tools only through mcpproxy and the
discover-then-invoke flow.

1. Invoke `retrieve_tools` with `{"query":"agentmemory core recall"}`.
2. Use the exact returned `name` and `call_with` class with an `args` JSON object.
   Use `agentmemory:memory_recall` or `agentmemory:memory_smart_search` through
   `call_tool_read` for prior context, `agentmemory:memory_save` through
   `call_tool_write` for durable knowledge, and
   `agentmemory:memory_lesson_save` through `call_tool_write` for lessons.
3. Search by distinctive topic, title, or body terms. Never guess a tool name or
   call an AgentMemory endpoint directly.

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

## Spec-driven implementation

The `kiro-*` skills are authored for OpenCode but are also available in Pi.
Use Pi's interfaces when running them:

- Invoke `/skill:kiro-impl <feature>`; append task IDs for manual mode. A bare
  invocation has no feature context.
- In autonomous mode, use the `subagent` tool from `pi-subagents` with one
  child at a time: `agent: "worker"` for implementation and `agent: "reviewer"`
  for review. Set `async: false` so the parent receives the structured status
  or verdict before continuing; the default background mode cannot drive the
  Kiro iteration loop.
- Pi children do not inherit ambient skills by default. Include the task,
  spec paths, status format, and relevant protocol in each child prompt rather
  than expecting a child to invoke a parent skill.
- Nested Kiro skills use Pi command names: `/skill:kiro-review`,
  `/skill:kiro-debug`, `/skill:kiro-verify-completion`, and
  `/skill:kiro-validate-impl`.
- The built-in reviewer is read-only. The parent runs tests and builds, passes
  fresh evidence to the reviewer, updates `tasks.md`, commits, and performs
  final validation.

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
