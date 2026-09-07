import childProcess from "node:child_process";
import fs from "node:fs";

const [mode, readyPath, signalPath] = process.argv.slice(2);
if (!mode || !readyPath || !signalPath) throw new Error("invalid process tree worker arguments");

function appendSignal(signal) {
  fs.appendFileSync(signalPath, `${process.pid}:${signal}\n`);
}

if (mode === "descendant") {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      appendSignal(signal);
      process.exit(0);
    });
  }
  setInterval(() => {}, 1_000);
} else {
  const descendant = childProcess.spawn(process.execPath, [
    process.argv[1],
    "descendant",
    readyPath,
    signalPath,
  ], { detached: false, stdio: "ignore" });
  descendant.unref();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      appendSignal(signal);
      if (mode !== "stubborn") process.exit(0);
    });
  }
  fs.writeFileSync(readyPath, `${JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid })}\n`);
  setInterval(() => {}, 1_000);
}
