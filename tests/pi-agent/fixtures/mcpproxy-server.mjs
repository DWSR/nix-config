import http from "node:http";
import { pathToFileURL } from "node:url";

const serverModulePath = process.env.PI_AGENT_MCP_SERVER_MODULE;
const variant = process.env.PI_AGENT_MCP_FIXTURE_VARIANT ?? "exact";
const toolsListDelayMs = Number(process.env.PI_AGENT_MCP_TOOLS_LIST_DELAY_MS ?? 0);
if (!serverModulePath) throw new Error("PI_AGENT_MCP_SERVER_MODULE is required");
if (!Number.isFinite(toolsListDelayMs) || toolsListDelayMs < 0) {
  throw new Error("PI_AGENT_MCP_TOOLS_LIST_DELAY_MS must be a non-negative number");
}

const {
  Server,
  WebStandardStreamableHTTPServerTransport,
} = await import(pathToFileURL(serverModulePath).href);

const directToolNames = [
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
];
const fixtureToolName = "fixture:get_record";
const fixtureWriteToolName = "fixture:update_record";
const fixtureDestructiveToolName = "fixture:delete_record";
const fixtureUnannotatedToolName = "fixture:unannotated_mutation";
const fixtureAdminApiKey = "task-3-9-admin-key";
const fixtureSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
};
const activities = [];

const describedTools = {
  [fixtureToolName]: {
    name: fixtureToolName,
    server: "fixture",
    description: "Return the deterministic Task 3.8 fixture",
    inputSchema: fixtureSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    call_with: "call_tool_read",
  },
  [fixtureWriteToolName]: {
    name: fixtureWriteToolName,
    server: "fixture",
    description: "Update the deterministic Task 3.9 fixture",
    inputSchema: fixtureSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    call_with: "call_tool_write",
  },
  [fixtureDestructiveToolName]: {
    name: fixtureDestructiveToolName,
    server: "fixture",
    description: "Delete the deterministic Task 3.9 fixture",
    inputSchema: fixtureSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    call_with: "call_tool_destructive",
  },
  [fixtureUnannotatedToolName]: {
    name: fixtureUnannotatedToolName,
    server: "fixture",
    description: "Mutate the deterministic Task 3.9 fixture without annotations",
    inputSchema: fixtureSchema,
    call_with: "call_tool_read",
  },
};

function activeVariant(name, listCall) {
  return variant === name || (variant === `warm-${name}` && listCall > 1);
}

function nestedArray(depth) {
  let value = true;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function record(activity) {
  activities.push(activity);
  if (process.connected) process.send?.({ type: "activity", activity });
}

function inputSchemaFor(name, listCall) {
  if (
    name === "retrieve_tools"
    && activeVariant("invalid-schema", listCall)
  ) {
    return {
      type: "object",
      properties: {
        "sensitive-key-sentinel": 7,
      },
    };
  }
  if (name === "retrieve_tools" && activeVariant("unsupported-dialect", listCall)) {
    return {
      $schema: "sensitive-dialect-sentinel",
      type: "object",
    };
  }
  if (name === "retrieve_tools" && variant === "invalid-root-schema") {
    return { type: "string" };
  }

  let schema;
  switch (name) {
    case "retrieve_tools":
      schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["query"],
      };
      break;
    case "describe_tool":
      schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          tool_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["tool_ids"],
      };
      break;
    case "call_tool_read":
    case "call_tool_write":
    case "call_tool_destructive":
      schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          args: { type: "object", additionalProperties: true },
          intent_reason: { type: "string" },
          intent_data_sensitivity: { type: "string" },
        },
        required: ["name", "args"],
      };
      break;
    case "read_cache":
      schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["key"],
      };
      break;
    default:
      schema = { type: "object", additionalProperties: false };
  }

  if (variant === "warm-schema-drift" && listCall > 1 && name === "retrieve_tools") {
    schema.properties.live_schema_version = { type: "string", const: "live-v2" };
    schema.required.push("live_schema_version");
  }
  if (name === "read_cache" && activeVariant("oversized-depth", listCall)) {
    schema["x-depth"] = nestedArray(40);
  }
  if (name === "read_cache" && activeVariant("oversized-string", listCall)) {
    schema["x-annotation"] = "sensitive-annotation-sentinel".padEnd(65_537, "x");
  }
  if (name === "read_cache" && activeVariant("oversized-container", listCall)) {
    schema["x-container"] = Array.from({ length: 1_025 }, () => null);
  }
  if (activeVariant("oversized-shared-nodes", listCall)) {
    schema["x-shared-nodes"] = Array.from({ length: 700 }, () => null);
  }
  if (activeVariant("oversized-shared-text", listCall)) {
    schema["x-shared-text"] = "sensitive-shared-text-sentinel".padEnd(44 * 1_024, "x");
  }
  return schema;
}

function listedTools(listCall) {
  let names = [...directToolNames];
  if (variant === "unrelated" || variant === "preflight-tools-extra") {
    names.push("unrelated_server_tool");
  }
  if (
    variant === "missing"
    || variant === "preflight-tools-missing"
    || (variant === "warm-missing" && listCall > 1)
  ) {
    names = names.filter((name) => name !== "read_cache");
  }
  if (variant === "prefixed") {
    names = names.map((name) => name === "retrieve_tools" ? "mcpproxy_retrieve_tools" : name);
  }

  const tools = names.map((name) => ({
    name,
    ...(variant === "missing-description" && name === "retrieve_tools"
      ? {}
      : { description: `Deterministic ${name} fixture` }),
    inputSchema: inputSchemaFor(name, listCall),
  }));
  if (variant === "duplicate" || variant === "preflight-tools-duplicate") {
    tools.splice(1, 0, { ...tools[0] });
  }
  return tools;
}

let sessionSequence = 0;
let toolsListSequence = 0;
const sessions = new Map();

async function createMcpSession() {
  const sessionId = `pi-agent-task-3-8-session-${++sessionSequence}`;
  const mcpServer = new Server(
    { name: "pi-agent-task-3-8-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler("tools/list", async () => {
    const listCall = ++toolsListSequence;
    record({ kind: "protocol", method: "tools/list", listCall });
    if (variant === "failure") throw new Error("deterministic tools/list failure");
    if (toolsListDelayMs > 0 && (variant !== "warm-missing" || listCall > 1)) {
      await new Promise((resolve) => setTimeout(resolve, toolsListDelayMs));
    }
    return { tools: listedTools(listCall) };
  });

  mcpServer.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    record({ kind: "tool-call", name, args });

    let payload;
    switch (name) {
      case "retrieve_tools":
        payload = {
          query: args.query,
          tools: [{
            name: fixtureToolName,
            call_with: "call_tool_read",
            description: "Return the deterministic Task 3.8 fixture",
          }],
          total: 1,
        };
        break;
      case "describe_tool":
        {
          const definitions = (args.tool_ids ?? [])
            .map((toolId) => describedTools[toolId])
            .filter(Boolean);
        payload = {
          definitions,
          errors: [],
          tools: definitions,
        };
        break;
        }
      case "call_tool_read":
        if ([fixtureWriteToolName, fixtureDestructiveToolName, fixtureUnannotatedToolName]
          .includes(args.name)) {
          record({ kind: "upstream-call", name: args.name, variant: name });
          payload = { name: args.name, forwarded: true };
          break;
        }
        payload = {
          name: args.name,
          result: {
            fixture: "task-3.8-read-result",
            id: args.args?.id,
          },
        };
        break;
      case "call_tool_write": {
        const forwarded = args.name === fixtureWriteToolName;
        if (forwarded) record({ kind: "upstream-call", name: args.name, variant: name });
        payload = { name: args.name, forwarded };
        break;
      }
      case "call_tool_destructive": {
        const forwarded = args.name === fixtureDestructiveToolName;
        if (forwarded) record({ kind: "upstream-call", name: args.name, variant: name });
        payload = { name: args.name, forwarded };
        break;
      }
      case "read_cache":
        payload = { key: args.key, records: [] };
        break;
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `unknown fixture tool: ${name}` }],
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
    keepAliveMs: 0,
    onsessionclosed: () => sessions.delete(sessionId),
  });
  await mcpServer.connect(transport);
  const session = { mcpServer, transport };
  sessions.set(sessionId, session);
  return session;
}

function webHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const httpServer = http.createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    let parsedBody;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf8"));
      } catch {
        parsedBody = undefined;
      }
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1:8080");
    record({
      kind: "http",
      method: request.method,
      path: requestUrl.pathname,
      rpcMethod: parsedBody?.method,
      clientCapabilities: parsedBody?.method === "initialize"
        ? parsedBody.params?.capabilities
        : undefined,
      hasAuthorization: request.headers.authorization !== undefined,
      hasApiKey: request.headers["x-api-key"] !== undefined,
    });

    if (requestUrl.pathname === "/healthz") {
      if (variant === "preflight-health-failure") {
        sendJson(response, 503, { status: "fixture-sensitive-health-failure" });
      } else {
        sendJson(response, 200, { status: "ok" });
      }
      return;
    }

    if (requestUrl.pathname === "/readyz") {
      if (variant === "preflight-not-ready") {
        sendJson(response, 503, { ready: false, detail: "fixture-sensitive-not-ready" });
      } else {
        sendJson(response, 200, { ready: true });
      }
      return;
    }

    if (requestUrl.pathname === "/api/v1/servers") {
      if (request.headers["x-api-key"] !== fixtureAdminApiKey) {
        sendJson(response, 401, { error: "fixture-sensitive-admin-key-failure" });
        return;
      }
      let servers = [
        { name: "agentmemory", enabled: true, connected: true, quarantined: false },
      ];
      if (variant === "preflight-upstream-missing") {
        servers = [];
      }
      if (variant === "preflight-upstream-disconnected") {
        servers = servers.map((server) => (
          server.name === "agentmemory" ? { ...server, connected: false } : server
        ));
      }
      record({ kind: "upstream-inventory", names: servers.map(({ name }) => name) });
      sendJson(response, 200, { success: true, data: { servers } });
      return;
    }

    if (requestUrl.pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    if (variant === "preflight-initialize-failure" && parsedBody?.method === "initialize") {
      sendJson(response, 500, { error: "fixture-sensitive-initialize-failure" });
      return;
    }

    const init = {
      method: request.method,
      headers: webHeaders(request.headers),
      ...(body.length > 0 ? { body, duplex: "half" } : {}),
    };
    const webRequest = new Request(requestUrl, init);
    const requestedSessionId = request.headers["mcp-session-id"];
    const session = parsedBody?.method === "initialize" && requestedSessionId === undefined
      ? await createMcpSession()
      : typeof requestedSessionId === "string"
        ? sessions.get(requestedSessionId)
        : undefined;
    if (!session) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("unknown MCP fixture session");
      return;
    }
    const webResponse = await session.transport.handleRequest(webRequest, { parsedBody });
    response.statusCode = webResponse.status;
    for (const [name, value] of webResponse.headers) response.setHeader(name, value);
    if (!webResponse.body) {
      response.end();
      return;
    }
    const reader = webResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
  })().catch((error) => {
    record({ kind: "server-error", message: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
    response.end("fixture server error");
  });
});

let shutdownPromise;
function shutdown() {
  shutdownPromise ??= (async () => {
    await Promise.all(
      [...sessions.values()].map(({ mcpServer }) => mcpServer.close().catch(() => undefined)),
    );
    sessions.clear();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  })();
  return shutdownPromise;
}

process.on("message", (message) => {
  if (message?.type === "snapshot") {
    process.send?.({ type: "snapshot", activities: [...activities] });
  }
  if (message?.type === "shutdown") {
    void shutdown().then(() => {
      process.send?.({ type: "stopped" }, () => process.disconnect?.());
    });
  }
});
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

httpServer.once("error", (error) => {
  process.send?.({ type: "fatal", message: error.message });
});
httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  process.send?.({
    type: "ready",
    variant,
    port: typeof address === "object" && address !== null ? address.port : undefined,
  });
});
