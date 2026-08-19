"use strict";

const fs = require("node:fs");
const path = require("node:path");

let buffer = Buffer.alloc(0);
fs.writeFileSync(
  path.join(process.cwd(), ".task-4-9-failing-observation.json"),
  `${JSON.stringify({ environment: process.env, pid: process.pid })}\n`,
);
process.stderr.write("TASK_4_8_FAILED_SERVER_STDERR_SENTINEL\n");

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function drain() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return;
  const header = buffer.subarray(0, headerEnd).toString("ascii");
  const match = /Content-Length: (\d+)/i.exec(header);
  if (!match) process.exit(2);
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return;
  const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32002,
        message: "TASK_4_8_FAILED_SERVER_SENTINEL",
        data: "TASK_4_8_FAILED_SERVER_DATA_SENTINEL",
      },
    });
    setImmediate(() => process.exit(86));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
