# MANDATORY: AgentMemory + Obsidian

## AgentMemory Ambient Memory

OpenCode uses stock AgentMemory as its ambient memory backend. Its existing
OpenCode plugin starts and ends stock sessions, observes prompts, completed
assistant content, reasoning, and tool activity through standard authenticated
REST routes, and provides automatic context injection. Agents do not manually
reproduce those capture calls or use the REST endpoint directly.

OpenCode reaches AgentMemory's MCP tools only through mcpproxy. Mcpproxy is the
only MCP endpoint configured in OpenCode; do not add a direct AgentMemory MCP
entry, custom facade, capture relay, or context relay.

Automatic AgentMemory-to-Obsidian promotion is not provided.

### Discover stock tools

Use mcpproxy's discover-then-invoke surface for every AgentMemory MCP operation:

1. `retrieve_tools(query: "agentmemory core recall")`
   → expect a result whose `name` field has the form `agentmemory:<tool>`.
2. Use the exact returned `name`, the returned `call_with` recommendation, and
   an `args` JSON object. Do not invent a tool name or use raw MCP `arguments`.

The enabled `AGENTMEMORY_TOOLS=core` set is the stock eight-tool set:

- `memory_recall` searches past session observations for relevant context.
- `memory_smart_search` performs hybrid semantic and keyword recall.
- `memory_sessions` lists recent sessions and their observation counts.
- `memory_save` explicitly saves an insight, decision, or pattern.
- `memory_lesson_save` saves a lesson with a confidence score.
- `memory_consolidate` runs stock memory consolidation.
- `memory_diagnose` checks the stock memory subsystems.
- `memory_reflect` synthesizes higher-order insights from the stock graph.

Use `call_tool_read` for read operations and `call_tool_write` for save or
other write operations. Mcpproxy applies its normal policy to core write tools.

Session start, session end, and observation capture are automatic plugin
behavior, not manual agent steps. The plugin sends standard `session/start`,
`session/end`, and `observe` requests as OpenCode lifecycle events. Use
`memory_sessions` to recall session listings and `memory_save` when an explicit
agent-authored save is needed.

Keep the stock automatic context injection enabled. The plugin supplies
AgentMemory context on the first eligible model request and uses stock file
enrichment where applicable. Its compression, truncation, indexing,
consolidation, project attribution, and session behavior remain upstream
behavior; do not promise stable context or exact project/worktree isolation.
AgentMemory recall has no project selector; stock project attribution and
basename collisions remain accepted behavior.

The OpenCode `title` and `summary` agents are disabled by configuration. Do not
re-enable them or add another summary path to compensate for AgentMemory.

The full daemon is checked before OpenCode starts. If the daemon becomes
unavailable after startup, the stock MCP shim may use its local fallback tools
and standalone store, with reduced graph, vector, compression, and
consolidation behavior. This fallback is accepted upstream behavior. Do not add
a custom fallback guard, retry queue, or relay.

The standard bearer is available to the in-process plugin through the OpenCode
environment. Model-invoked subprocesses may inherit that bearer and reach the
loopback REST endpoint; this is an accepted process-boundary consequence, not
a hardened isolation guarantee.
