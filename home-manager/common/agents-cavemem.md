# MANDATORY: Cavemem Ambient Memory

## Ambient capture (cavemem)

OpenCode uses cavemem as its ambient memory backend. Cavemem captures prompts,
responses, reasoning, and tool activity through OpenCode hooks into its managed
SQLite data directory. Session lifecycle and summarization are automatic.

OpenCode reaches cavemem only through mcpproxy. Mcpproxy is the only MCP
endpoint configured in OpenCode; do not add a direct cavemem MCP entry or a
custom capture or retrieval relay.

### Discover cavemem tools

Use mcpproxy's discover-then-invoke surface for cavemem operations:

1. `retrieve_tools(query: "cavemem search")`
   → expect a result whose `name` field has the form `cavemem:<tool>`.
2. Use the exact returned `name`, the returned `call_with` recommendation, and
   an `args` JSON object. Do not invent a tool name or use raw MCP `arguments`.

Use `call_tool_read` for cavemem operations such as `list_sessions`,
`timeline`, `get_observations`, and `search`.

The cavemem hook and MCP paths use the same managed data directory. Do not
manually reproduce capture calls, search the SQLite database directly, or add
another ambient memory source.
