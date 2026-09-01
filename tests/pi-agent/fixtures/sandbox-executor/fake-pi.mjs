import { spawn } from "node:child_process";
import fs from "node:fs";

import { parseArgs } from "__PI_AGENT_PI_PARSER_MODULE__";

const argv = process.argv.slice(2);

function append(file, value) {
  if (file) fs.appendFileSync(file, value);
}

append(
  process.env.PI_AGENT_TASK55_TRACE_FILE,
  `${JSON.stringify({
    executable: "pi",
    argv,
    route: process.env.PI_AGENT_TASK55_LAUNCH_ROUTE ?? "bare",
  })}\n`,
);

if (process.env.PI_AGENT_TASK55_REVIEW_PROBE === "1") {
  const parsed = parseArgs(argv);
  const excluded = new Set(parsed.excludeTools ?? []);
  const builtins = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const tools = parsed.noTools
    ? []
    : (parsed.tools ?? []).filter(
        (name) =>
          !excluded.has(name) &&
          !(parsed.noBuiltinTools && builtins.has(name)),
      );

  if (tools.includes("code_refactor_apply")) {
    fs.writeFileSync(process.env.PI_AGENT_TASK55_REFACTOR_MARKER, "applied\n");
  }
  if (tools.includes("bg_start")) {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    append(process.env.PI_AGENT_TASK55_PROCESS_FILE, `${child.pid}\n`);
  }
  if (tools.includes("bash")) {
    fs.writeFileSync(process.env.PI_AGENT_TASK55_BASH_MARKER, "executed\n");
  }
  if (tools.includes("write")) {
    fs.writeFileSync(process.env.PI_AGENT_TASK55_WRITE_MARKER, "written\n");
  }
  if (process.env.PI_AGENT_TASK55_LAUNCH_ROUTE !== "nono") {
    fs.writeFileSync(process.env.PI_AGENT_TASK55_FALLBACK_MARKER, "bare\n");
  }
}
