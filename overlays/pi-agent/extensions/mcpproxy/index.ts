import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpAdapter } from "pi-mcp-adapter";
import type {
  McpConfig,
  McpDirectToolSelection,
} from "pi-mcp-adapter/types";

export const MCPPROXY_DIRECT_TOOL_NAMES = Object.freeze([
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
] as const);

export const MCPPROXY_APPROVAL_TOOL_NAMES = Object.freeze([
  "call_tool_write",
  "call_tool_destructive",
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

const MCPPROXY_PREFLIGHT_RECOVERY = "restart mcpproxy or repair the declared upstream";

export const MCPPROXY_PREFLIGHT_CONTRACT = deepFreeze({
  healthUrl: "http://127.0.0.1:8080/healthz",
  readinessUrl: "http://127.0.0.1:8080/readyz",
  upstreamStatusUrl: "http://127.0.0.1:8080/api/v1/servers",
  mcpUrl: "http://127.0.0.1:8080/mcp",
  toolNames: [...MCPPROXY_DIRECT_TOOL_NAMES],
  recovery: MCPPROXY_PREFLIGHT_RECOVERY,
});

type McpproxyPreflightComponent =
  | "mcpproxy health"
  | "mcpproxy readiness"
  | "mcpproxy admin status"
  | "mandatory upstream"
  | "MCP initialize"
  | "MCP tools";

export class McpproxyPreflightError extends Error {
  readonly component: McpproxyPreflightComponent;
  readonly recovery = MCPPROXY_PREFLIGHT_RECOVERY;
  readonly service?: string;

  constructor(component: McpproxyPreflightComponent, service?: string) {
    super(
      `MCP preflight failed: ${component}${service === undefined ? "" : ` ${service}`}. `
      + `Recovery: ${MCPPROXY_PREFLIGHT_RECOVERY}.`,
    );
    this.name = "McpproxyPreflightError";
    this.component = component;
    if (service !== undefined) this.service = service;
  }
}

export interface McpproxyPreflightOptions {
  readonly adminApiKey: string;
  readonly mandatoryUpstreams: readonly string[];
  readonly timeoutMs?: number;
}

export interface McpproxyPreflightResult {
  readonly toolNames: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function probeHttp(
  url: string,
  component: McpproxyPreflightComponent,
  timeoutMs: number,
  headers?: HeadersInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...(headers === undefined ? {} : { headers }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new McpproxyPreflightError(component);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpproxyPreflightError(component);
  }
  return response;
}

function validateMandatoryUpstreams(value: unknown, mandatoryUpstreams: readonly string[]): void {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    throw new McpproxyPreflightError("mcpproxy admin status");
  }
  const servers = value.data.servers;
  if (!Array.isArray(servers)) {
    throw new McpproxyPreflightError("mcpproxy admin status");
  }
  for (const name of mandatoryUpstreams) {
    const matches = servers.filter((server) => isRecord(server) && server.name === name);
    if (matches.length !== 1) throw new McpproxyPreflightError("mandatory upstream", name);
    const server = matches[0];
    if (server.enabled !== true || server.connected !== true || server.quarantined !== false) {
      throw new McpproxyPreflightError("mandatory upstream", name);
    }
  }
}

function validateRequiredMcpTools(tools: unknown): void {
  if (
    !Array.isArray(tools)
    || tools.some((tool) => !isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0)
  ) {
    throw new McpproxyPreflightError("MCP tools");
  }
  const names = tools.map((tool) => tool.name as string);
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  if (MCPPROXY_DIRECT_TOOL_NAMES.some((name) => counts.get(name) !== 1)) {
    throw new McpproxyPreflightError("MCP tools");
  }
}

export async function preflightMcpproxy(
  options: McpproxyPreflightOptions,
): Promise<McpproxyPreflightResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new McpproxyPreflightError("mcpproxy admin status");
  }
  if (typeof options.adminApiKey !== "string" || options.adminApiKey.length === 0) {
    throw new McpproxyPreflightError("mcpproxy admin status");
  }
  if (
    !Array.isArray(options.mandatoryUpstreams)
    || options.mandatoryUpstreams.length === 0
    || options.mandatoryUpstreams.some((name) => typeof name !== "string" || name.length === 0)
    || new Set(options.mandatoryUpstreams).size !== options.mandatoryUpstreams.length
  ) {
    throw new McpproxyPreflightError("mandatory upstream");
  }

  const healthResponse = await probeHttp(
    MCPPROXY_PREFLIGHT_CONTRACT.healthUrl,
    "mcpproxy health",
    timeoutMs,
  );
  await healthResponse.body?.cancel().catch(() => undefined);
  const readinessResponse = await probeHttp(
    MCPPROXY_PREFLIGHT_CONTRACT.readinessUrl,
    "mcpproxy readiness",
    timeoutMs,
  );
  await readinessResponse.body?.cancel().catch(() => undefined);
  const upstreamResponse = await probeHttp(
    MCPPROXY_PREFLIGHT_CONTRACT.upstreamStatusUrl,
    "mcpproxy admin status",
    timeoutMs,
    { "X-API-Key": options.adminApiKey },
  );
  let upstreamStatus: unknown;
  try {
    upstreamStatus = await upstreamResponse.json();
  } catch {
    throw new McpproxyPreflightError("mcpproxy admin status");
  }
  validateMandatoryUpstreams(upstreamStatus, options.mandatoryUpstreams);

  const client = new Client(
    { name: "pi-agent-mcpproxy-preflight", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(MCPPROXY_PREFLIGHT_CONTRACT.mcpUrl),
  );
  try {
    try {
      await client.connect(transport, {
        maxTotalTimeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        timeout: timeoutMs,
      });
    } catch {
      throw new McpproxyPreflightError("MCP initialize");
    }

    let listed: unknown;
    try {
      listed = await client.listTools(undefined, {
        cacheMode: "bypass",
        maxTotalTimeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        timeout: timeoutMs,
      });
    } catch {
      throw new McpproxyPreflightError("MCP tools");
    }
    if (!isRecord(listed)) throw new McpproxyPreflightError("MCP tools");
    validateRequiredMcpTools(listed.tools);
  } finally {
    await client.close().catch(() => undefined);
  }

  return deepFreeze({ toolNames: [...MCPPROXY_DIRECT_TOOL_NAMES] });
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
      approveTools: [...MCPPROXY_APPROVAL_TOOL_NAMES],
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
