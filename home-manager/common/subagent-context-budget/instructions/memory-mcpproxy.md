# Mandatory AgentMemory and mcpproxy safety

AgentMemory is the only active memory system. Route every memory operation through mcpproxy's discover-then-invoke surface.

- Discover recall with `retrieve_tools(query: "agentmemory core recall")` and durable writes with `retrieve_tools(query: "agentmemory memory save lesson")`.
- Use the exact discovered `name`, `call_with` operation class, and `args` JSON object. Never invent tool names or use raw MCP `arguments`.
- Use `agentmemory:memory_recall` or `agentmemory:memory_smart_search` through `call_tool_read` for prior context.
- Use `agentmemory:memory_save` or `agentmemory:memory_lesson_save` through `call_tool_write` for durable knowledge and reusable lessons.
- Use `call_tool_destructive` only for an explicitly discovered destructive operation, following its specific workflow and permission rules. Never call an AgentMemory REST endpoint directly or bypass mcpproxy.
