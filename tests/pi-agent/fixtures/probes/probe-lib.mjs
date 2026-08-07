import fs from "node:fs";

const directTools = [
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
];

function responseFor(probe, request) {
  switch (probe) {
    case "pi":
      return {
        sessionId: request?.sessionId ?? "fixture-pi-session",
        state: "ready",
      };
    case "provider":
      return {
        content: request?.response ?? "fixture-provider-response",
        model: request?.model ?? "fixture-model",
      };
    case "mcpproxy":
      return { tools: directTools };
    case "cavemem":
      return {
        observationId: request?.observationId ?? "fixture-observation-1",
        stored: true,
      };
    case "nono":
      return {
        profile: request?.profile ?? "pi-managed",
        state: request?.state ?? "enforced",
      };
    case "language-server":
      return {
        diagnostics: request?.diagnostics ?? [],
        locations: request?.locations ?? [
          {
            line: 1,
            path: "src/fixture.mjs",
          },
        ],
        state: "ready",
      };
    case "subprocess":
      return {
        exitCode: request?.exitCode ?? 0,
        stdout: request?.stdout ?? "fixture-subprocess-output",
      };
    default:
      throw new Error(`unknown probe: ${probe}`);
  }
}

function readRequest() {
  const input = fs.readFileSync(0, "utf8").trim();
  return input.length === 0 ? null : JSON.parse(input);
}

function capturedEnvironment() {
  const names = (process.env.PI_AGENT_PROBE_ENV_NAMES ?? "")
    .split(",")
    .filter(Boolean)
    .sort();

  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
}

function requestedExitCode() {
  const value = process.env.PI_AGENT_PROBE_EXIT_CODE ?? "0";
  const exitCode = Number(value);

  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error(`invalid PI_AGENT_PROBE_EXIT_CODE: ${value}`);
  }
  return exitCode;
}

export function runProbeMain(probe) {
  try {
    const request = readRequest();
    const result = {
      schemaVersion: 1,
      probe,
      invocation: {
        argv: process.argv.slice(2),
        environment: capturedEnvironment(),
      },
      request,
      response: responseFor(probe, request),
    };
    const output = `${JSON.stringify(result)}\n`;

    if (process.env.PI_AGENT_PROBE_TRACE) {
      fs.appendFileSync(process.env.PI_AGENT_PROBE_TRACE, output);
    }
    process.stdout.write(output);
    if (process.env.PI_AGENT_PROBE_STDERR) {
      process.stderr.write(`${process.env.PI_AGENT_PROBE_STDERR}\n`);
    }
    process.exitCode = requestedExitCode();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
  }
}
