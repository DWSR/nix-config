import http from "node:http";
import { pathToFileURL } from "node:url";

const serverModulePath = process.env.PI_AGENT_MCP_SERVER_MODULE;
if (!serverModulePath) throw new Error("PI_AGENT_MCP_SERVER_MODULE is required");

const {
  Server,
  WebStandardStreamableHTTPServerTransport,
} = await import(pathToFileURL(serverModulePath).href);

const tools = [
  {
    name: "get_record",
    description: "Read one deterministic record",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "unannotated_read",
    description: "Read one deterministic record without behavior annotations",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "update_record",
    description: "Update one deterministic record",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "delete_record",
    description: "Delete one deterministic record",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "unannotated_mutation",
    description: "Mutate one deterministic record without behavior annotations",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

const activities = [];
const sessions = new Map();
let sessionSequence = 0;

function record(activity) {
  activities.push(activity);
  process.send?.({ type: "activity", activity });
}

async function createSession() {
  const sessionId = `pi-agent-task-3-9-upstream-${++sessionSequence}`;
  const server = new Server(
    { name: "pi-agent-task-3-9-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => {
    record({ kind: "protocol", method: "tools/list" });
    return { tools };
  });
  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    record({ kind: "upstream-call", name, args });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ name, id: args.id, forwarded: true }),
      }],
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
    keepAliveMs: 0,
    onsessionclosed: () => sessions.delete(sessionId),
  });
  await server.connect(transport);
  const session = { server, transport };
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

const httpServer = http.createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    let parsedBody;
    if (body.length > 0) parsedBody = JSON.parse(body.toString("utf8"));

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    const webRequest = new Request(requestUrl, {
      method: request.method,
      headers: webHeaders(request.headers),
      ...(body.length > 0 ? { body, duplex: "half" } : {}),
    });
    const requestedSessionId = request.headers["mcp-session-id"];
    const session = parsedBody?.method === "initialize" && requestedSessionId === undefined
      ? await createSession()
      : typeof requestedSessionId === "string"
        ? sessions.get(requestedSessionId)
        : undefined;
    if (!session) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("unknown upstream session");
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
    response.end("upstream fixture error");
  });
});

let shutdownPromise;
function shutdown() {
  shutdownPromise ??= (async () => {
    await Promise.all([...sessions.values()].map(({ server }) => server.close().catch(() => undefined)));
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

httpServer.once("error", (error) => process.send?.({ type: "fatal", message: error.message }));
httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  process.send?.({
    type: "ready",
    port: typeof address === "object" && address !== null ? address.port : undefined,
  });
});
