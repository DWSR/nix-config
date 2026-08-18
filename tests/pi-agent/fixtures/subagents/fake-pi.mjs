import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

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
