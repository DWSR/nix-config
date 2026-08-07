import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testsDir, "fixtures");
const gateStatuses = new Set(["pass", "fail", "manual-required"]);

export const PROBE_NAMES = Object.freeze([
  "pi",
  "provider",
  "mcpproxy",
  "cavemem",
  "nono",
  "language-server",
  "subprocess",
]);

function requireFixtureName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid fixture name: ${name}`);
  }
}

function makeWritable(target) {
  const stat = fs.lstatSync(target);

  if (stat.isSymbolicLink()) {
    return;
  }

  fs.chmodSync(target, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      makeWritable(path.join(target, entry));
    }
  }
}

export async function withFixtureWorkspace(name, operation) {
  requireFixtureName(name);
  if (typeof operation !== "function") {
    throw new TypeError("fixture operation must be a function");
  }

  const source = path.join(fixturesDir, "workspaces", name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-fixture-"));
  const workspace = path.join(root, name);

  try {
    fs.cpSync(source, workspace, {
      recursive: true,
      errorOnExist: true,
    });
    makeWritable(workspace);
    return await operation(workspace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function runProbe(name, options = {}) {
  if (!PROBE_NAMES.includes(name)) {
    throw new Error(`unknown fixture probe: ${name}`);
  }

  const argv = options.argv ?? [];
  const environment = options.environment ?? {};
  if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === "string")) {
    throw new TypeError("probe argv must contain only strings");
  }
  if (
    environment === null ||
    Array.isArray(environment) ||
    typeof environment !== "object" ||
    !Object.values(environment).every((value) => typeof value === "string")
  ) {
    throw new TypeError("probe environment values must be strings");
  }

  const capturedNames = Object.keys(environment).sort();
  const probe = path.join(fixturesDir, "probes", `${name}.mjs`);
  const result = childProcess.spawnSync(process.execPath, [probe, ...argv], {
    cwd: testsDir,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? os.tmpdir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      ...environment,
      PI_AGENT_PROBE_ENV_NAMES: capturedNames.join(","),
    },
    input: `${JSON.stringify(options.request ?? null)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} probe exited ${result.status}: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${name} probe emitted invalid JSON: ${error.message}`);
  }
}

export function createValidationReport(generation, gates) {
  if (typeof generation !== "string" || generation.length === 0) {
    throw new Error("validation generation must be a non-empty string");
  }
  if (!Array.isArray(gates)) {
    throw new TypeError("validation gates must be an array");
  }

  const names = new Set();
  const normalizedGates = gates.map((gate) => {
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      throw new TypeError("validation gate must be an object");
    }
    if (typeof gate.name !== "string" || gate.name.length === 0) {
      throw new Error("validation gate name must be a non-empty string");
    }
    if (names.has(gate.name)) {
      throw new Error(`duplicate validation gate: ${gate.name}`);
    }
    names.add(gate.name);

    if (!gateStatuses.has(gate.status)) {
      throw new Error(`invalid gate status: ${gate.status}`);
    }
    if (
      !Array.isArray(gate.evidence) ||
      gate.evidence.length === 0 ||
      !gate.evidence.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(`gate evidence must be non-empty strings: ${gate.name}`);
    }

    return {
      name: gate.name,
      status: gate.status,
      evidence: [...gate.evidence],
    };
  });

  return {
    generation,
    gates: normalizedGates,
  };
}

export function assertNoFailedGates(report) {
  const failed = report.gates.filter((gate) => gate.status === "fail").map((gate) => gate.name);

  if (failed.length > 0) {
    throw new Error(`failed gates: ${failed.join(", ")}`);
  }
}

export async function runSmokeFixture() {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, "smoke.json"), "utf8"));
  const sourceSeed = path.join(fixturesDir, "workspaces", fixture.workspace, "seed.txt");
  const originalSeed = fs.readFileSync(sourceSeed, "utf8");
  let workspacePath;

  await withFixtureWorkspace(fixture.workspace, async (workspace) => {
    workspacePath = workspace;
    const copiedSeed = path.join(workspace, "seed.txt");

    fs.writeFileSync(copiedSeed, fixture.writableValue);
    if (fs.readFileSync(copiedSeed, "utf8") !== fixture.writableValue) {
      throw new Error("fixture copy is not writable");
    }

    for (const name of PROBE_NAMES) {
      const result = runProbe(name, {
        argv: ["--smoke"],
        request: {
          operation: "smoke",
          payload: name,
        },
      });

      if (result.probe !== name || result.schemaVersion !== 1 || result.response === null) {
        throw new Error(`invalid smoke response from ${name} probe`);
      }
    }
  });

  if (fs.existsSync(workspacePath) || fs.readFileSync(sourceSeed, "utf8") !== originalSeed) {
    throw new Error("fixture workspace was not isolated");
  }

  const report = createValidationReport(fixture.generation, [
    {
      name: "fixture-workspace",
      status: "pass",
      evidence: ["copy-isolated", "copy-writable"],
    },
    {
      name: "fixture-probes",
      status: "pass",
      evidence: PROBE_NAMES,
    },
    fixture.manualGate,
  ]);
  assertNoFailedGates(report);
  return report;
}
