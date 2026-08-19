"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let buffer = Buffer.alloc(0);
const lifecyclePath = path.join(process.cwd(), ".task-4-9-stalling-lifecycle.jsonl");
const descendantObservationPath = path.join(
  process.cwd(),
  ".task-4-9-stalling-descendant-observation.json",
);
const ordinaryDescendant = spawn(
  process.execPath,
  [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(descendantObservationPath)}, JSON.stringify({ environment: process.env, pid: process.pid }) + "\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 0x7fffffff)`,
  ],
  { stdio: "ignore" },
);

process.on("SIGTERM", () => recordLifecycle("SIGTERM"));
fs.writeFileSync(
  path.join(process.cwd(), ".task-4-9-stalling-observation.json"),
  `${JSON.stringify({
    descendantPid: ordinaryDescendant.pid,
    environment: process.env,
    pid: process.pid,
  })}\n`,
);

function recordLifecycle(event) {
  fs.appendFileSync(lifecyclePath, `${JSON.stringify({ event })}\n`);
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handleMessage(message) {
  if (message.method === "initialize") {
    recordLifecycle("initialize");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { capabilities: {} },
    });
    return;
  }
  if (message.method === "shutdown") {
    recordLifecycle("shutdown");
    return;
  }
  if (message.method === "exit") recordLifecycle("exit");
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
