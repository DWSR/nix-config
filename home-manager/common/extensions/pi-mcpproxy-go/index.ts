import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, Tool } from "@modelcontextprotocol/core";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";

const MCPPROXY_URL = "http://127.0.0.1:8080/mcp";

type PiContent = AgentToolResult<unknown>["content"];

function resultText(result: CallToolResult): string {
  return result.content
    .map((block) => {
      if (block.type === "text") return block.text;
      return JSON.stringify(block);
    })
    .join("\n");
}

function resultContent(result: CallToolResult): PiContent {
  const content: PiContent = [];
  for (const block of result.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else {
      content.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  return content.length > 0 ? content : [{ type: "text", text: "(empty MCP result)" }];
}

function registerTool(pi: ExtensionAPI, client: Client, tool: Tool): void {
  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema as never,
    execute: async (_toolCallId, params, signal) => {
      const result = await client.callTool(
        { name: tool.name, arguments: params as Record<string, unknown> },
        { signal },
      );
      if (result.isError) throw new Error(resultText(result));
      return { content: resultContent(result), details: result };
    },
  } as never);
}

export default async function piMcpproxyGo(pi: ExtensionAPI): Promise<void> {
  const client = new Client(
    { name: "pi-mcpproxy-go", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCPPROXY_URL));

  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const tool of tools) registerTool(pi, client, tool);

  pi.on("session_shutdown", async () => {
    await client.close();
  });
}
