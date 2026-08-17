import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import type { McpConfig, McpDirectToolSelection } from "pi-mcp-adapter/types";

export const MCPPROXY_DIRECT_TOOL_NAMES = Object.freeze([
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
] as const);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const MCPPROXY_ADAPTER_CONFIG = deepFreeze({
  mcpServers: {
    mcpproxy: {
      url: "http://127.0.0.1:8080/mcp",
      auth: false,
      oauth: false,
      lifecycle: "eager",
      idleTimeout: 0,
      exposeResources: false,
      directTools: [...MCPPROXY_DIRECT_TOOL_NAMES],
      toolPrefix: "none",
      includeTools: [...MCPPROXY_DIRECT_TOOL_NAMES],
    },
  },
  settings: {
    toolPrefix: "none",
    hostConfigDiscovery: "off",
    idleTimeout: 0,
    directTools: false,
    scriptMode: false,
    disableProxyTool: true,
    freezeDirectTools: true,
    autoAuth: false,
    sampling: false,
    samplingAutoApprove: false,
    elicitation: false,
  },
} satisfies McpConfig);

export const MCPPROXY_ADAPTER_DIRECT_TOOLS = deepFreeze([
  {
    server: "mcpproxy",
    tools: [...MCPPROXY_DIRECT_TOOL_NAMES],
  },
] satisfies readonly McpDirectToolSelection[]);

const installMcpproxyAdapter = createMcpAdapter({
  config: MCPPROXY_ADAPTER_CONFIG,
  directTools: MCPPROXY_ADAPTER_DIRECT_TOOLS,
});
const directToolNameSet = new Set<string>(MCPPROXY_DIRECT_TOOL_NAMES);

export const MANAGED_MCP_SURFACE_CONTRACT = deepFreeze({
  selectedToolNames: [...MCPPROXY_DIRECT_TOOL_NAMES],
  forbiddenToolNames: [
    "mcp",
    "mcpScript",
    "code_execution",
    "mcpproxy_code_execution",
  ],
  forbiddenToolPrefixes: ["mcp__mcpproxy_", "mcpproxy_"],
});

function isForbiddenToolName(name: string): boolean {
  return MANAGED_MCP_SURFACE_CONTRACT.forbiddenToolNames.includes(name)
    || MANAGED_MCP_SURFACE_CONTRACT.forbiddenToolPrefixes.some((prefix) => name.startsWith(prefix));
}

export function validateManagedMcpSurface(
  toolNames: readonly string[],
  allowedUnrelatedToolNames: readonly string[],
): readonly string[] {
  const allowed = new Set<string>();
  for (const name of allowedUnrelatedToolNames) {
    if (allowed.has(name) || directToolNameSet.has(name) || isForbiddenToolName(name)) {
      throw new Error(`Managed MCP allowed inventory is invalid: ${name}`);
    }
    allowed.add(name);
  }

  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const missing = MCPPROXY_DIRECT_TOOL_NAMES.filter((name) => !counts.has(name));
  const duplicate = [...counts]
    .filter(([, count]) => count !== 1)
    .map(([name]) => name);
  const forbidden = [...counts.keys()].filter(isForbiddenToolName);
  const unexpected = [...counts.keys()].filter((name) => (
    !directToolNameSet.has(name) && !allowed.has(name) && !isForbiddenToolName(name)
  ));
  if (missing.length || duplicate.length || forbidden.length || unexpected.length) {
    throw new Error(
      `Managed MCP surface mismatch: missing=[${missing.join(",")}], `
      + `duplicate=[${duplicate.join(",")}], forbidden=[${forbidden.join(",")}], `
      + `unexpected=[${unexpected.join(",")}]`,
    );
  }
  return Object.freeze([...toolNames]);
}

export default async function mcpproxyAdapter(pi: ExtensionAPI): Promise<void> {
  await installMcpproxyAdapter(pi);
}
