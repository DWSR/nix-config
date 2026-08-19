import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function recordSignal(file, signal) {
  if (file) fs.appendFileSync(file, `${process.pid}:${signal}\n`);
}

if (args[0] === "--managed-descendant" || args[0] === "--managed-unrelated") {
  const readyFile = args[1];
  const signalFile = args[2];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => recordSignal(signalFile, signal));
  }
  fs.writeFileSync(readyFile, `${process.pid}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function optionValue(name) {
  return optionValues(name).at(-1);
}

const task = args.findLast((argument) => argument.startsWith("Task: "))?.slice(6) ?? "";
const taskLabel = task.split("\n", 1)[0];
const sessionFile = optionValue("--session");
if (sessionFile) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: process.env.PI_SUBAGENT_CHILD_INDEX })}\n`);
}

const logDir = process.env.PI_SUBAGENT_FIXTURE_LOG_DIR;
if (logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const record = {
    agent: process.env.PI_SUBAGENT_CHILD_AGENT,
    args,
    attribution: {
      child: process.env.PI_SUBAGENT_CHILD,
      childIndex: process.env.PI_SUBAGENT_CHILD_INDEX,
      parentSession: process.env.PI_SUBAGENT_PARENT_SESSION,
      runId: process.env.PI_SUBAGENT_RUN_ID,
    },
    cwd: process.cwd(),
    depth: process.env.PI_SUBAGENT_DEPTH,
    extensions: optionValues("--extension"),
    maxDepth: process.env.PI_SUBAGENT_MAX_DEPTH,
    mcpDirectTools: process.env.MCP_DIRECT_TOOLS,
    noAmbientExtensions: args.includes("--no-extensions"),
    piBinaryOverridePresent: Object.hasOwn(process.env, "PI_SUBAGENT_PI_BINARY"),
    providerResources: {
      launchId: typeof process.env.PI_AGENT_LAUNCH_ID === "string",
      token: typeof process.env.SHOPIFY_PI_TOKEN === "string",
    },
    sessionFile,
    task,
    toolBudget: process.env.PI_SUBAGENT_TOOL_BUDGET,
    tools: optionValue("--tools"),
  };
  const index = process.env.PI_SUBAGENT_CHILD_INDEX ?? "unknown";
  fs.writeFileSync(path.join(logDir, `${index}-${process.pid}.json`), `${JSON.stringify(record)}\n`);
}

if (task.includes("[managed-tree]") || task.includes("[managed-tree-exit]") || process.env.PI_SUBAGENT_FIXTURE_TREE === "1") {
  const index = process.env.PI_SUBAGENT_CHILD_INDEX ?? "unknown";
  const readyFile = path.join(logDir, `${index}-${process.pid}.descendant-ready`);
  const signalFile = path.join(logDir, `${index}-${process.pid}.signals`);
  const exitAfterReady = task.includes("[managed-tree-exit]");
  if (!exitAfterReady) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => recordSignal(signalFile, signal));
    }
  }
  const descendant = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "--managed-descendant",
    readyFile,
    signalFile,
  ], {
    detached: false,
    stdio: "ignore",
  });
  descendant.unref();
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!fs.existsSync(readyFile)) throw new Error("managed descendant did not become ready");
  fs.writeFileSync(path.join(logDir, `${index}-${process.pid}.tree`), JSON.stringify({
    descendantPid: descendant.pid,
    parentPid: process.pid,
    processGroupId: process.pid,
    signalFile,
  }));
  if (!exitAfterReady) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
}

function assistantMessage(text, stopReason = "stop", errorMessage) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "fixture",
      model: "host-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    },
  };
}

if (task.includes("[fail]")) {
  process.stdout.write(`${JSON.stringify(assistantMessage("fixture failure", "error", "fixture failure"))}\n`);
  process.exitCode = 7;
} else if (task.includes("[turn-budget]")) {
  for (let turn = 1; turn <= 20; turn += 1) {
    process.stdout.write(`${JSON.stringify(assistantMessage(`turn-${turn}`, "length"))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
} else {
  process.stdout.write(`${JSON.stringify(assistantMessage(`result:${taskLabel}`))}\n`);
}
