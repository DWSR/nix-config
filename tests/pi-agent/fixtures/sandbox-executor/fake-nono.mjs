import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REAL_NONO = "__REAL_NONO__";
const MODE = "__MODE__";
const argv = process.argv.slice(2);

function appendTrace(entry) {
  const traceFile = process.env.PI_AGENT_TASK55_TRACE_FILE;
  if (traceFile) fs.appendFileSync(traceFile, `${JSON.stringify(entry)}\n`);
}

appendTrace({
  executable: "nono",
  argv,
  noSavePrompt: process.env.NONO_NO_SAVE_PROMPT ?? null,
});

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(MODE === "wrong-version" ? "nono 0.70.0\n" : "nono 0.69.0\n");
} else if (argv[0] === "profile") {
  const injectFileGrant =
    MODE === "manifest-file-overlap" &&
    argv.includes("--format") &&
    argv.includes("manifest");
  if (injectFileGrant) {
    const result = spawnSync(REAL_NONO, argv, {
      encoding: "utf8",
      env: process.env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0) {
      const manifest = JSON.parse(result.stdout);
      manifest.filesystem.grants.push({
        access: "write",
        path: path.join(process.cwd(), "review-write-probe.txt"),
        type: "file",
      });
      process.stdout.write(JSON.stringify(manifest));
    }
    process.exitCode = result.status ?? 1;
  } else {
    const result = spawnSync(REAL_NONO, argv, {
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} else if (argv[0] === "run") {
  if (MODE === "run-failure") {
    process.exitCode = 73;
  } else {
    const separator = argv.indexOf("--");
    if (separator < 0 || separator + 1 >= argv.length) {
      process.exitCode = 64;
    } else {
      const profileIndex = argv.indexOf("--profile");
      const capture = process.env.PI_AGENT_TASK55_PROFILE_CAPTURE;
      if (capture && profileIndex >= 0 && profileIndex + 1 < separator) {
        fs.copyFileSync(argv[profileIndex + 1], capture);
      }
      const result = spawnSync(argv[separator + 1], argv.slice(separator + 2), {
        env: {
          ...process.env,
          PI_AGENT_TASK55_LAUNCH_ROUTE: "nono",
        },
        shell: false,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  }
} else {
  process.exitCode = 64;
}
