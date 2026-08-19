"use strict";

const fs = require("node:fs");
const path = require("node:path");

let buffer = Buffer.alloc(0);
let readyRequestId = 2000;

fs.writeFileSync(
  path.join(process.cwd(), ".task-4-9-crashing-observation.json"),
  `${JSON.stringify({ environment: process.env, pid: process.pid })}\n`,
);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handleRequest(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          workspaceSymbolProvider: true,
        },
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: null });
}

function handleMessage(message) {
  if (Object.hasOwn(message, "id") && typeof message.method === "string") {
    handleRequest(message);
    return;
  }
  if (message.method === "initialized") {
    const token = "managed-crashing-fixture-ready";
    send({
      jsonrpc: "2.0",
      id: readyRequestId++,
      method: "window/workDoneProgress/create",
      params: { token },
    });
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token, value: { kind: "begin", title: "fixture index" } },
    });
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token, value: { kind: "end" } },
    });
    setTimeout(() => {
      fs.writeFileSync(path.join(process.cwd(), ".task-4-8-crashed"), "closed\n");
      process.stderr.write("TASK_4_8_RUNTIME_CRASH_SENTINEL\n");
      process.exit(87);
    }, 100);
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));
