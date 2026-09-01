import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/sandbox-executor.nix";
const executorRelativePath = "lib/pi-agent/sandbox-executor.mjs";
const extractedParserRelativePath = "lib/pi-agent/pi-args-parser.mjs";
const parserHelperRelativePath = "lib/pi-agent/pi-args-parser-helper.mjs";
const piPackageRelativePath = "lib/node_modules/@earendil-works/pi-coding-agent";
const piParserRelativePath = `${piPackageRelativePath}/dist/cli/args.js`;
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const reviewTools = ["read", "grep", "find", "ls"];
const expectedPiPackageName = "@earendil-works/pi-coding-agent";
const expectedPiVersion = "0.83.0";
const expectedPiManifestDigest =
  "3253f5d0c59c6661d9975cb813e6b9ced77122a09279bd871d63e14247393ed8";
const expectedPiParserDigest =
  "4918c54a35a1190f4a1a8d6829d9b7de707a97b30a74640838345e54011147e5";
const piArgFields = [
  "provider",
  "model",
  "apiKey",
  "systemPrompt",
  "appendSystemPrompt",
  "thinking",
  "continue",
  "resume",
  "help",
  "version",
  "mode",
  "name",
  "noSession",
  "session",
  "sessionId",
  "fork",
  "sessionDir",
  "models",
  "tools",
  "excludeTools",
  "noTools",
  "noBuiltinTools",
  "extensions",
  "noExtensions",
  "print",
  "export",
  "noSkills",
  "skills",
  "promptTemplates",
  "noPromptTemplates",
  "themes",
  "noThemes",
  "noContextFiles",
  "listModels",
  "offline",
  "verbose",
  "projectTrustOverride",
  "messages",
  "fileArgs",
  "unknownFlags",
  "diagnostics",
];
const secretSentinel = "task-5-5-provider-secret-sentinel-75c4";

let fixtureRoot;
let packages;
let parsePinnedPiArguments;
let pinnedPiParserSource;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-sandbox-executor-tests";
        filter = sourcePath: type:
          let base = builtins.baseNameOf sourcePath;
          in base != ".git" && base != "result";
      };
    in
      import (source + "/${fixtureRelativePath}") {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = source;
      }
  `;
}

function buildFixture(fixture) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression(fixture),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1, result.stdout);
  return outputs[0];
}

function buildRejectedFixture(fixture) {
  const result = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--impure", "--expr", fixtureExpression(fixture)],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  return result.stderr;
}

async function loadPackage(name) {
  const root = path.join(fixtureRoot, name);
  const modulePath = path.join(root, executorRelativePath);
  assert.equal(fs.existsSync(modulePath), true, modulePath);
  return {
    root,
    modulePath,
    source: fs.readFileSync(modulePath, "utf8"),
    executor: await import(pathToFileURL(modulePath)),
  };
}

before(
  async () => {
    fixtureRoot = buildFixture("packages");
    const names = [
      "production",
      "enforced",
      "audit",
      "disabled",
      "missing-mcp",
      "missing-package",
      "missing-agent",
      "missing-cavemem",
      "missing-temp",
      "wrong-workspace",
      "denied-workspace",
      "missing-environment",
      "wrong-process",
      "review-write-ancestor",
      "review-write-descendant",
      "review-write-prefix-sibling",
      "review-deny-ancestor",
      "review-file-overlap",
      "unavailable-nono",
      "wrong-version-nono",
      "run-failure",
      "missing-pi",
      "missing-profile",
      "tampered-catalog",
      "tampered-profile",
      "tampered-resolved",
      "missing-parser",
      "tampered-parser",
      "malformed-parser",
      "missing-pi-manifest",
      "tampered-pi-manifest",
      "missing-parser-helper",
      "tampered-parser-helper",
      "tampered-parser-node-digest",
      "malformed-parser-helper",
    ];
    const loaded = await Promise.all(names.map(loadPackage));
    packages = Object.fromEntries(names.map((name, index) => [name, loaded[index]]));
    const parserPackage = path.join(fixtureRoot, "parser-pi", piPackageRelativePath);
    const parserManifest = JSON.parse(
      fs.readFileSync(path.join(parserPackage, "package.json"), "utf8"),
    );
    assert.equal(parserManifest.version, "0.83.0");
    const parserPath = path.join(fixtureRoot, "parser-pi", piParserRelativePath);
    pinnedPiParserSource = fs.readFileSync(parserPath, "utf8");
    ({ parseArgs: parsePinnedPiArguments } = await import(pathToFileURL(parserPath)));
  },
  { timeout: 600_000 },
);

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readPids(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function terminateFixtureProcesses(file) {
  for (const pid of readPids(file)) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function withEnvironment(environment, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function capture(packageName, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sandbox-executor-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "private-tmp");
  const traceFile = path.join(root, "trace.jsonl");
  const profileCapture = path.join(root, "runtime-profile.json");
  const refactorMarker = path.join(root, "refactor-applied");
  const processFile = path.join(root, "processes.txt");
  const fallbackMarker = path.join(root, "fallback-ran");
  const bashMarker = path.join(root, "bash-ran");
  const writeMarker = path.join(root, "write-ran");
  const xdgData = path.join(home, ".local/share");
  const agentDir = path.join(home, ".pi/agent");
  const cavememDir = path.join(xdgData, "cavemem");
  const workspace =
    options.workspace === "pi-state"
      ? path.join(agentDir, "workspace")
      : options.workspace === "repo-fixture"
        ? path.join(repoRoot, "tests/pi-agent/fixtures/workspaces/smoke-workspace")
          : repoRoot;
  for (const directory of [
    home,
    tmp,
    path.join(home, ".cache"),
    path.join(home, ".config"),
    xdgData,
    path.join(home, ".local/state"),
    agentDir,
    cavememDir,
    workspace,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const environment = {
    HOME: home,
    TMPDIR: tmp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: path.join(home, ".local/state"),
    CAVEMEM_DATA_DIR: cavememDir,
    PI_CODING_AGENT_DIR: agentDir,
    SHOPIFY_PI_TOKEN: secretSentinel,
    PI_AGENT_LAUNCH_ID: "11111111-1111-4111-8111-111111111111",
    PI_AGENT_TASK55_TRACE_FILE: traceFile,
    PI_AGENT_TASK55_PROFILE_CAPTURE: profileCapture,
    PI_AGENT_TASK55_REVIEW_PROBE: options.reviewProbe ? "1" : undefined,
    PI_AGENT_TASK55_REFACTOR_MARKER: refactorMarker,
    PI_AGENT_TASK55_PROCESS_FILE: processFile,
    PI_AGENT_TASK55_FALLBACK_MARKER: fallbackMarker,
    PI_AGENT_TASK55_BASH_MARKER: bashMarker,
    PI_AGENT_TASK55_WRITE_MARKER: writeMarker,
    PI_NONO: undefined,
    PI_NONO_PROFILE: undefined,
    PI_NONO_LISTEN_PORTS: undefined,
    ...options.environment,
  };

  let result;
  let error;
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    withEnvironment(environment, () => {
      try {
        const defaultInput = {
          providerOrigin:
            options.providerOrigin === undefined
              ? "https://gateway.example.test"
              : options.providerOrigin,
          userArguments: options.userArguments ?? ["--fixture", "value with spaces", ""],
        };
        const input = options.inputFactory
          ? options.inputFactory(defaultInput)
          : defaultInput;
        result = packages[packageName].executor.executeSandboxedPi(input);
      } catch (caught) {
        error = caught;
      }
    });

    return {
      error,
      result,
      trace: readJsonLines(traceFile),
      profile: fs.existsSync(profileCapture)
        ? JSON.parse(fs.readFileSync(profileCapture, "utf8"))
        : null,
      refactorApplied: fs.existsSync(refactorMarker),
      fallbackRan: fs.existsSync(fallbackMarker),
      bashRan: fs.existsSync(bashMarker),
      writeRan: fs.existsSync(writeMarker),
      pids: readPids(processFile),
      tempEntries: fs.existsSync(path.join(tmp, "pi-agent"))
        ? fs.readdirSync(path.join(tmp, "pi-agent"))
        : [],
    };
  } finally {
    process.chdir(previousCwd);
    terminateFixtureProcesses(processFile);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function captureFresh(packageName, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sandbox-executor-fresh-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "private-tmp");
  const traceFile = path.join(root, "trace.jsonl");
  const profileCapture = path.join(root, "runtime-profile.json");
  const refactorMarker = path.join(root, "refactor-applied");
  const processFile = path.join(root, "processes.txt");
  const fallbackMarker = path.join(root, "fallback-ran");
  const bashMarker = path.join(root, "bash-ran");
  const writeMarker = path.join(root, "write-ran");
  const resultFile = path.join(root, "result.json");
  const poisonPackageDir = path.join(root, "poison-package");
  const extensionMarker = path.join(root, "extension-ran");
  const extensionTripwire = path.join(root, "extension-tripwire.mjs");
  const nodeOptionsTripwire = path.join(root, "node-options-tripwire.mjs");
  const xdgData = path.join(home, ".local/share");
  const agentDir = path.join(home, ".pi/agent");
  const cavememDir = path.join(xdgData, "cavemem");
  const workspace =
    options.workspace === "pi-state"
      ? path.join(agentDir, "workspace")
      : options.workspace === "repo-fixture"
        ? path.join(repoRoot, "tests/pi-agent/fixtures/workspaces/smoke-workspace")
        : repoRoot;
  for (const directory of [
    home,
    tmp,
    path.join(home, ".cache"),
    path.join(home, ".config"),
    xdgData,
    path.join(home, ".local/state"),
    agentDir,
    cavememDir,
    workspace,
    poisonPackageDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(poisonPackageDir, "package.json"), "{not-json\n");
  for (const tripwire of [extensionTripwire, nodeOptionsTripwire]) {
    fs.writeFileSync(
      tripwire,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(extensionMarker)}, "ran\\n");\n`,
    );
  }

  const environment = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: path.join(home, ".local/state"),
    CAVEMEM_DATA_DIR: cavememDir,
    PI_CODING_AGENT_DIR: agentDir,
    SHOPIFY_PI_TOKEN: secretSentinel,
    PI_AGENT_LAUNCH_ID: "11111111-1111-4111-8111-111111111111",
    PI_AGENT_TASK55_TRACE_FILE: traceFile,
    PI_AGENT_TASK55_PROFILE_CAPTURE: profileCapture,
    PI_AGENT_TASK55_REVIEW_PROBE: options.reviewProbe ? "1" : undefined,
    PI_AGENT_TASK55_REFACTOR_MARKER: refactorMarker,
    PI_AGENT_TASK55_PROCESS_FILE: processFile,
    PI_AGENT_TASK55_FALLBACK_MARKER: fallbackMarker,
    PI_AGENT_TASK55_BASH_MARKER: bashMarker,
    PI_AGENT_TASK55_WRITE_MARKER: writeMarker,
    PI_AGENT_TASK55_POISON_NODE_OPTIONS: options.poisonNodeOptions
      ? pathToFileURL(nodeOptionsTripwire).href
      : undefined,
    PI_NONO: undefined,
    PI_NONO_PROFILE: undefined,
    PI_NONO_LISTEN_PORTS: undefined,
    ...options.environment,
  };
  if (environment.PI_PACKAGE_DIR === "__POISON_PACKAGE_DIR__") {
    environment.PI_PACKAGE_DIR = poisonPackageDir;
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }

  const userArguments = (
    options.userArguments ?? ["--fixture", "value with spaces", ""]
  ).map((argument) =>
    argument === "__EXTENSION_TRIPWIRE__" ? extensionTripwire : argument,
  );
  const input = {
    providerOrigin:
      options.providerOrigin === undefined
        ? "https://gateway.example.test"
        : options.providerOrigin,
    userArguments,
  };
  const runner = String.raw`
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";

    const [modulePath, resultPath, inputJson] = process.argv.slice(1);
    if (process.env.PI_AGENT_TASK55_POISON_NODE_OPTIONS) {
      process.env.NODE_OPTIONS = "--import=" + process.env.PI_AGENT_TASK55_POISON_NODE_OPTIONS;
    }
    let report;
    try {
      const executor = await import(pathToFileURL(modulePath));
      report = { result: executor.executeSandboxedPi(JSON.parse(inputJson)) };
    } catch (error) {
      report = {
        error: {
          name: error?.name ?? null,
          message: error?.message ?? null,
          component: error?.component ?? null,
          kind: error?.kind ?? null,
          recovery: error?.recovery ?? null,
        },
      };
    }
    fs.writeFileSync(resultPath, JSON.stringify(report));
  `;

  let processResult;
  try {
    processResult = childProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        runner,
        packages[packageName].modulePath,
        resultFile,
        JSON.stringify(input),
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    const report = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : {};
    return {
      error: report.error,
      result: report.result,
      processResult,
      trace: readJsonLines(traceFile),
      profile: fs.existsSync(profileCapture)
        ? JSON.parse(fs.readFileSync(profileCapture, "utf8"))
        : null,
      refactorApplied: fs.existsSync(refactorMarker),
      fallbackRan: fs.existsSync(fallbackMarker),
      bashRan: fs.existsSync(bashMarker),
      writeRan: fs.existsSync(writeMarker),
      extensionRan: fs.existsSync(extensionMarker),
      extensionTripwire,
      pids: readPids(processFile),
      tempEntries: fs.existsSync(path.join(tmp, "pi-agent"))
        ? fs.readdirSync(path.join(tmp, "pi-agent"))
        : [],
    };
  } finally {
    terminateFixtureProcesses(processFile);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function nonoRun(trace) {
  return trace.find((entry) => entry.executable === "nono" && entry.argv[0] === "run");
}

function piRuns(trace) {
  return trace.filter((entry) => entry.executable === "pi");
}

function assertNoPiOrRun(evidence) {
  assert.deepEqual(piRuns(evidence.trace), []);
  assert.equal(nonoRun(evidence.trace), undefined);
}

function assertSafeFailure(evidence, component, label = component) {
  assert.ok(evidence.error, label);
  assert.equal(evidence.error.component, component, evidence.error.message);
  assert.equal(typeof evidence.error.recovery, "string");
  assert.notEqual(evidence.error.recovery, "");
  assert.equal(
    evidence.error.message,
    `Pi sandbox ${component} failed (${evidence.error.kind}). Recovery: ${evidence.error.recovery}.`,
  );
  assert.equal(evidence.error.message.includes(secretSentinel), false);
  assertNoPiOrRun(evidence);
}

function assertFreshClosedFailure(evidence, component, label) {
  assertSafeFailure(evidence, component, label);
  assert.equal(evidence.trace.length, 0, label);
  assert.equal(evidence.processResult.status, 0, evidence.processResult.stderr);
  assert.equal(evidence.processResult.signal, null, label);
  assert.equal(evidence.processResult.stdout, "", label);
  assert.equal(evidence.processResult.stderr, "", label);
  assert.equal(evidence.extensionRan, false, label);
  assert.deepEqual(evidence.pids, [], label);
  assert.equal(evidence.refactorApplied, false, label);
  assert.equal(evidence.bashRan, false, label);
  assert.equal(evidence.writeRan, false, label);
  assert.equal(evidence.fallbackRan, false, label);
}

function assertFreshParserFailure(evidence, label) {
  assertFreshClosedFailure(evidence, "invocation", label);
}

function parsedReviewCeilingIsExact(parsed) {
  const excluded = parsed.excludeTools ?? [];
  return (
    parsed.noTools !== true &&
    parsed.noBuiltinTools !== true &&
    excluded.every((tool) => !reviewTools.includes(tool)) &&
    isDeepStrictEqual(parsed.tools, reviewTools)
  );
}

function pinnedPiOptionTokens() {
  return [
    ...new Set(
      [...pinnedPiParserSource.matchAll(/\barg === "(-{1,2}[^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

function normalizePinnedPiArguments(parsed) {
  return Object.fromEntries(
    piArgFields.map((field) => {
      if (field === "unknownFlags") return [field, [...parsed.unknownFlags.entries()]];
      if (field === "diagnostics") {
        return [
          field,
          parsed.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        ];
      }
      return [
        field,
        Object.hasOwn(parsed, field)
          ? JSON.parse(JSON.stringify(parsed[field]))
          : null,
      ];
    }),
  );
}

function invokePackagedHelper(request, packageName = "enforced") {
  const helperPath = path.join(packages[packageName].root, parserHelperRelativePath);
  const input = JSON.stringify(request);
  const result = childProcess.spawnSync(process.execPath, [helperPath], {
    cwd: "/",
    encoding: "utf8",
    env: {},
    input,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function parseWithPackagedHelper(userArguments) {
  return invokePackagedHelper({ schemaVersion: 1, argv: userArguments });
}

test("enforced execution validates grants and captures the exact nono command", () => {
  const userArguments = ["--model", "fixture/model", "value with spaces", ""];
  const evidence = capture("enforced", {
    environment: { PI_NONO_LISTEN_PORTS: "3000,443" },
    userArguments,
  });

  assert.ifError(evidence.error);
  assert.deepEqual(evidence.result, { status: 0, signal: null });
  const run = nonoRun(evidence.trace);
  assert.ok(run);
  const runtimeProfile = run.argv[2];
  const nonoInvocations = evidence.trace
    .filter((entry) => entry.executable === "nono")
    .map((entry) => entry.argv);
  const sourceProfile = nonoInvocations[1][3];
  assert.match(sourceProfile, /\/profiles\/pi-managed\.json$/);
  assert.deepEqual(nonoInvocations, [
    ["--version"],
    ["profile", "validate", "--strict", sourceProfile],
    ["profile", "show", sourceProfile, "--json", "--silent"],
    ["profile", "validate", "--strict", runtimeProfile],
    ["profile", "show", runtimeProfile, "--json", "--silent"],
    [
      "profile",
      "show",
      runtimeProfile,
      "--format",
      "manifest",
      "--silent",
    ],
    run.argv,
  ]);
  assert.deepEqual(run.argv, [
    "run",
    "--profile",
    runtimeProfile,
    "--allow-cwd",
    "--",
    fs.realpathSync(path.join(fixtureRoot, "probe-pi/bin/pi")),
    ...userArguments,
  ]);
  assert.equal(run.noSavePrompt, "1");
  assert.deepEqual(piRuns(evidence.trace), [
    { executable: "pi", argv: userArguments, route: "nono" },
  ]);
  assert.deepEqual(evidence.profile.network.allow_domain, ["gateway.example.test"]);
  assert.deepEqual(evidence.profile.network.listen_port, [3000, 443]);
  assert.equal(JSON.stringify(evidence.profile).includes(secretSentinel), false);
  assert.equal(JSON.stringify(evidence.trace).includes(secretSentinel), false);
  assert.deepEqual(evidence.tempEntries, []);
});

test("audit accepts unrestricted provider egress without a materialized host", () => {
  const evidence = capture("audit", { providerOrigin: null });
  assert.ifError(evidence.error);
  assert.equal(evidence.result.status, 0);
  assert.equal(evidence.profile.network.block, false);
  assert.deepEqual(evidence.profile.network.allow_domain, []);
  assert.equal(nonoRun(evidence.trace).argv[0], "run");
  assert.equal(piRuns(evidence.trace).length, 1);
});

test("review appends the authoritative tool ceiling and leaves every effect probe at zero", () => {
  const hostileTools = "code_refactor_apply,bg_start,bash,write";
  const userArguments = ["--tools", hostileTools, "--fixture", "review"];
  const evidence = capture("enforced", {
    environment: { PI_NONO_PROFILE: "pi-review" },
    reviewProbe: true,
    userArguments,
  });

  assert.ifError(evidence.error);
  const run = nonoRun(evidence.trace);
  assert.deepEqual(run.argv.slice(-2), ["--tools", reviewTools.join(",")]);
  assert.deepEqual(run.argv.slice(6, 6 + userArguments.length), userArguments);
  assert.deepEqual(piRuns(evidence.trace)[0].argv, [
    ...userArguments,
    "--tools",
    reviewTools.join(","),
  ]);
  assert.equal(evidence.profile.workdir.access, "read");
  assert.equal(evidence.profile.security.signal_mode, "isolated");
  assert.equal(evidence.refactorApplied, false);
  assert.deepEqual(evidence.pids, []);
  assert.equal(evidence.bashRan, false);
  assert.equal(evidence.writeRan, false);
  assert.equal(evidence.fallbackRan, false);
});

test("pinned Pi parser exposes the complete dangerous trailing-option set", () => {
  const managedFinalArguments = ["--tools", reviewTools.join(",")];
  const dangerous = pinnedPiOptionTokens().filter((option) => {
    const parsed = parsePinnedPiArguments([option, ...managedFinalArguments]);
    return !parsedReviewCeilingIsExact(parsed);
  });
  assert.deepEqual(dangerous, [
    "--api-key",
    "--append-system-prompt",
    "--exclude-tools",
    "--export",
    "--extension",
    "--fork",
    "--mode",
    "--model",
    "--models",
    "--name",
    "--no-builtin-tools",
    "--no-tools",
    "--prompt-template",
    "--provider",
    "--session",
    "--session-dir",
    "--session-id",
    "--skill",
    "--system-prompt",
    "--theme",
    "--thinking",
    "--tools",
    "-e",
    "-n",
    "-nbt",
    "-nt",
    "-t",
    "-xt",
  ]);
  for (const option of pinnedPiOptionTokens()) {
    const parsed = parsePinnedPiArguments([
      `${option}=fixture-value`,
      ...managedFinalArguments,
    ]);
    assert.equal(parsedReviewCeilingIsExact(parsed), true, `${option}=...`);
    assert.equal(parsed.messages.includes(reviewTools.join(",")), false, option);
  }
});

test("the packaged helper normalizes all 41 Pi Args fields exactly", () => {
  const cases = [
    [],
    [
      "--provider",
      "provider",
      "--model",
      "model",
      "--api-key",
      "api-key",
      "--system-prompt",
      "system",
      "--append-system-prompt",
      "append-one",
      "--append-system-prompt",
      "append-two",
      "--thinking",
      "high",
      "--continue",
      "--resume",
      "--help",
      "--version",
      "--mode",
      "rpc",
      "--name",
      "name",
      "--no-session",
      "--session",
      "session",
      "--session-id",
      "session-id",
      "--fork",
      "fork",
      "--session-dir",
      "session-dir",
      "--models",
      "one,two",
      "--tools",
      "read,bash",
      "--exclude-tools",
      "write",
      "--no-tools",
      "--no-builtin-tools",
      "--extension",
      "one.mjs",
      "-e",
      "two.mjs",
      "--no-extensions",
      "--print",
      "--export",
      "session.html",
      "--no-skills",
      "--skill",
      "skill-one",
      "--prompt-template",
      "prompt-one",
      "--no-prompt-templates",
      "--theme",
      "theme-one",
      "--no-themes",
      "--no-context-files",
      "--list-models",
      "search",
      "--offline",
      "--verbose",
      "--approve",
      "--no-approve",
      "@context.md",
      "ordinary prompt",
      "--future=value",
      "-z",
    ],
    ["--list-models"],
    ["--", "separator-value"],
    ["--thinking", "invalid-warning"],
  ];
  for (const userArguments of cases) {
    const response = parseWithPackagedHelper(userArguments);
    assert.equal(response.ok, true, `${JSON.stringify(userArguments)}: ${JSON.stringify(response)}`);
    assert.deepEqual(Object.keys(response), ["schemaVersion", "ok", "parsed"]);
    assert.equal(response.schemaVersion, 1);
    assert.deepEqual(Object.keys(response.parsed), piArgFields);
    assert.deepEqual(
      response.parsed,
      normalizePinnedPiArguments(parsePinnedPiArguments(userArguments)),
      JSON.stringify(userArguments),
    );
  }
});

test("the fixed helper is provenance-bound to the selected Pi runtime and accepts argv only", () => {
  for (const packageValue of [
    packages.production,
    packages.enforced,
    packages.audit,
    packages.disabled,
  ]) {
    const helperPath = path.join(packageValue.root, parserHelperRelativePath);
    const extractedParserPath = path.join(
      packageValue.root,
      extractedParserRelativePath,
    );
    const helperSource = fs.readFileSync(helperPath, "utf8");
    const parserImport = helperSource.match(
      /import \{ parseArgs \} from "(\/nix\/store\/[^"]+\/lib\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/cli\/args\.js)";/,
    );
    const executable = packageValue.source.match(
      /const PI_EXECUTABLE = "(\/nix\/store\/[^"]+\/bin\/pi)";/,
    );
    const manifestPath = parserImport?.[1].replace(
      /\/dist\/cli\/args\.js$/,
      "/package.json",
    );
    const helperDigest = packageValue.source.match(
      /const PI_PARSER_HELPER_DIGEST = "([0-9a-f]{64})";/,
    )?.[1];

    assert.equal(fs.existsSync(extractedParserPath), false, extractedParserPath);
    assert.ok(parserImport, helperSource);
    assert.ok(executable, packageValue.source);
    assert.equal(
      parserImport[1].slice(0, -`/${piParserRelativePath}`.length),
      executable[1].slice(0, -"/bin/pi".length),
    );
    assert.doesNotMatch(helperSource, /\bdata:|base64|request\.parser/);
    assert.doesNotMatch(packageValue.source, /piParserPackage|parserExtractor/);
    assert.match(
      packageValue.source,
      /spawnSync\(PARSER_NODE_EXECUTABLE, \[PI_PARSER_HELPER\]/,
    );
    assert.match(packageValue.source, /cwd: "\/"/);
    assert.match(packageValue.source, /env: \{\}/);
    assert.match(packageValue.source, /shell: false/);
    assert.match(packageValue.source, /timeout: PARSER_TIMEOUT_MS/);
    assert.match(
      packageValue.source,
      new RegExp(`const EXPECTED_PI_PACKAGE_NAME = "${expectedPiPackageName}";`),
    );
    assert.match(
      packageValue.source,
      new RegExp(`const EXPECTED_PI_VERSION = "${expectedPiVersion}";`),
    );
    assert.match(packageValue.source, new RegExp(expectedPiManifestDigest));
    assert.match(packageValue.source, new RegExp(expectedPiParserDigest));
    assert.equal(
      createHash("sha256").update(fs.readFileSync(parserImport[1])).digest("hex"),
      expectedPiParserDigest,
    );
    assert.equal(
      createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
      expectedPiManifestDigest,
    );
    assert.equal(
      createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex"),
      helperDigest,
    );
  }

  for (const packageName of ["production", "enforced"]) {
    const response = invokePackagedHelper(
      { schemaVersion: 1, argv: ["--provider", "openai", "prompt"] },
      packageName,
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.parsed.provider, "openai");
    assert.deepEqual(response.parsed.messages, ["prompt"]);
  }
});

test("the fixed helper rejects caller-supplied parser code and paths", () => {
  for (const [field, value] of [
    ["parser", "export function parseArgs() {}"],
    ["source", "data:text/javascript,export default 1"],
    ["path", "/tmp/caller-parser.mjs"],
  ]) {
    assert.deepEqual(
      invokePackagedHelper({ schemaVersion: 1, argv: [], [field]: value }),
      { schemaVersion: 1, ok: false, error: "input" },
      field,
    );
  }
});

test("review rejects the exact trailing append-system-prompt ceiling bypass before effects", () => {
  const userArguments = [
    "--tools",
    "code_refactor_apply,bg_start,bash,write",
    "--append-system-prompt",
  ];
  const parsed = parsePinnedPiArguments([
    ...userArguments,
    "--tools",
    reviewTools.join(","),
  ]);
  assert.deepEqual(parsed.tools, [
    "code_refactor_apply",
    "bg_start",
    "bash",
    "write",
  ]);
  assert.deepEqual(parsed.appendSystemPrompt, ["--tools"]);
  assert.deepEqual(parsed.messages, [reviewTools.join(",")]);

  const evidence = capture("enforced", {
    environment: { PI_NONO_PROFILE: "pi-review" },
    reviewProbe: true,
    userArguments,
  });
  assertSafeFailure(evidence, "invocation");
  assert.equal(evidence.trace.some((entry) => entry.executable === "nono"), false);
  assert.equal(evidence.refactorApplied, false);
  assert.deepEqual(evidence.pids, []);
  assert.equal(evidence.bashRan, false);
  assert.equal(evidence.writeRan, false);
});

test("review rejects every pinned parser form that can consume or alter the final ceiling", () => {
  const hostileTools = "code_refactor_apply,bg_start,bash,write";
  const managedFinalArguments = ["--tools", reviewTools.join(",")];
  const dangerous = pinnedPiOptionTokens().filter((option) => {
    const parsed = parsePinnedPiArguments([option, ...managedFinalArguments]);
    return !parsedReviewCeilingIsExact(parsed);
  });

  const priorAllowlists = [
    ["absent", []],
    ["hostile", ["--tools", hostileTools]],
    ["exact", ["--tools", reviewTools.join(",")]],
  ];
  for (const option of dangerous) {
    for (const [prior, prefix] of priorAllowlists) {
      const label = `${option} after ${prior} allowlist`;
      const evidence = captureFresh("enforced", {
        environment: { PI_NONO_PROFILE: "pi-review" },
        reviewProbe: true,
        userArguments: [...prefix, option],
      });
      assertFreshParserFailure(evidence, label);
      assert.equal(evidence.error.message.includes(option), false, label);
    }
  }
});

test("pinned Pi parser keeps complete options, equals forms, aliases, bare separators, and prompts below the review ceiling", () => {
  const safeCases = [
    ["--tools", "code_refactor_apply,bg_start,bash,write"],
    ["-t", "code_refactor_apply,bg_start,bash,write"],
    ["--append-system-prompt", "review context", "ordinary prompt"],
    ["--model", "openai/gpt-5.6-sol", "ordinary prompt"],
    ["--provider", "openai", "--model", "gpt-5.6-sol"],
    ["--thinking", "medium"],
    ["--thinking", "invalid-warning"],
    ["--list-models"],
    ["--list-models", "gpt"],
    ["-p", "ordinary prompt"],
    ["-p", "---\ntitle: review\n---\nordinary prompt"],
    ["--"],
    ["--", "ordinary prompt"],
    ["first prompt", "second prompt", "@context.md"],
    ["--extension", "first.mjs", "-e", "second.mjs"],
    ["--append-system-prompt", "first", "--append-system-prompt", "second"],
    ["--tools", "bash", "-t", "write"],
    ["--exclude-tools", "bash,write"],
    ["--tools=code_refactor_apply,bg_start,bash,write"],
    ["--append-system-prompt=review context"],
    ["--name=review-session"],
    ["--exclude-tools=bash,write"],
    ["--print"],
    ["--list-models"],
    ["--future-extension-flag"],
  ];
  for (const userArguments of safeCases) {
    const combined = [...userArguments, "--tools", reviewTools.join(",")];
    const parsed = parsePinnedPiArguments(combined);
    assert.equal(parsedReviewCeilingIsExact(parsed), true, JSON.stringify(userArguments));
    assert.equal(parsed.messages.includes(reviewTools.join(",")), false);
    const evidence = captureFresh("enforced", {
      environment: { PI_NONO_PROFILE: "pi-review" },
      reviewProbe: true,
      userArguments,
    });
    assert.ifError(evidence.error);
    assert.equal(evidence.processResult.status, 0, evidence.processResult.stderr);
    assert.equal(evidence.processResult.stdout, "");
    assert.equal(evidence.processResult.stderr, "");
    assert.deepEqual(piRuns(evidence.trace)[0].argv, combined);
    assert.equal(parsedReviewCeilingIsExact(parsePinnedPiArguments(combined)), true);
    assert.equal(evidence.refactorApplied, false);
    assert.deepEqual(evidence.pids, []);
    assert.equal(evidence.bashRan, false);
    assert.equal(evidence.writeRan, false);
  }
});

test("review rejects every Pi parser error diagnostic before any effect", () => {
  for (const userArguments of [
    ["-z"],
    ["-t=read"],
    ["-n=review-session"],
    ["-e=review-extension"],
    ["-xt=bash"],
    ["--name"],
  ]) {
    const parsed = parsePinnedPiArguments(userArguments);
    assert.equal(
      parsed.diagnostics.some((diagnostic) => diagnostic.type === "error"),
      true,
      JSON.stringify(userArguments),
    );
    const evidence = captureFresh("enforced", {
      environment: { PI_NONO_PROFILE: "pi-review" },
      reviewProbe: true,
      userArguments,
    });
    assertFreshParserFailure(evidence, JSON.stringify(userArguments));
  }
});

test("review rejects exclusions that remove a managed review tool", () => {
  for (const tool of reviewTools) {
    const evidence = captureFresh("enforced", {
      environment: { PI_NONO_PROFILE: "pi-review" },
      reviewProbe: true,
      userArguments: ["--exclude-tools", tool],
    });
    assertFreshParserFailure(evidence, `excluded ${tool}`);
  }
});

test("review parsing ignores poisoned Pi package state and never evaluates extension input", () => {
  const evidence = captureFresh("enforced", {
    environment: {
      PI_NONO_PROFILE: "pi-review",
      PI_PACKAGE_DIR: "__POISON_PACKAGE_DIR__",
    },
    poisonNodeOptions: true,
    reviewProbe: true,
    userArguments: ["--extension", "__EXTENSION_TRIPWIRE__", "-z"],
  });
  assertFreshParserFailure(evidence, "poisoned parser environment");
});

test("Nix evaluation rejects an unreviewed Pi identity before packaging", () => {
  for (const fixture of [
    "wrong-pi-version",
    "metadata-free-pi",
    "unselected-pi",
  ]) {
    const stderr = buildRejectedFixture(fixture);
    assert.match(
      stderr,
      /selected Pi package is not the reviewed pi-coding-agent 0\.83\.0 runtime/,
    );
    assert.equal(stderr.includes(secretSentinel), false);
  }
});

test("missing, tampered, and malformed Pi provenance or helper bytes fail closed", () => {
  const fixtures = [
    ["missing-parser", "pi"],
    ["tampered-parser", "pi"],
    ["malformed-parser", "pi"],
    ["missing-pi-manifest", "pi"],
    ["tampered-pi-manifest", "pi"],
    ["missing-parser-helper", "pi"],
    ["tampered-parser-helper", "pi"],
    ["tampered-parser-node-digest", "pi"],
    ["malformed-parser-helper", "invocation"],
  ];
  for (const [name, component] of fixtures) {
    const evidence = captureFresh(name, {
      environment: { PI_NONO_PROFILE: "pi-review" },
      reviewProbe: true,
      userArguments: [`value-${secretSentinel}`],
    });
    assertFreshClosedFailure(evidence, component, name);
    assert.equal(evidence.error.message.includes(secretSentinel), false, name);
  }
});

test("review probes detect unsafe argument ordering and bare fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-review-probe-control-"));
  const refactorMarker = path.join(root, "refactor");
  const processFile = path.join(root, "processes");
  const fallbackMarker = path.join(root, "fallback");
  try {
    const result = childProcess.spawnSync(
      fs.realpathSync(path.join(fixtureRoot, "probe-pi/bin/pi")),
      [
        "--tools",
        reviewTools.join(","),
        "--tools",
        "code_refactor_apply,bg_start",
      ],
      {
        ...commandOptions,
        env: {
          ...process.env,
          PI_AGENT_TASK55_REVIEW_PROBE: "1",
          PI_AGENT_TASK55_REFACTOR_MARKER: refactorMarker,
          PI_AGENT_TASK55_PROCESS_FILE: processFile,
          PI_AGENT_TASK55_FALLBACK_MARKER: fallbackMarker,
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(refactorMarker), true);
    assert.equal(fs.existsSync(fallbackMarker), true);
    const pids = fs.readFileSync(processFile, "utf8").trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 1);
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review rejects writable effective scope across workspace ancestors and descendants", () => {
  const cases = [
    ["enforced", "pi-state", "topology"],
    ["review-write-ancestor", "repo-fixture", "write-overlap"],
    ["review-write-descendant", "repo-fixture", "write-overlap"],
    ["review-file-overlap", "repo-fixture", "write-overlap"],
  ];
  for (const [packageName, workspace, kind] of cases) {
    const evidence = capture(packageName, {
      environment: { PI_NONO_PROFILE: "pi-review" },
      workspace,
    });
    assertSafeFailure(evidence, "workspace");
    assert.equal(evidence.error.kind, kind);
  }
});

test("review path overlap is segment-aware rather than a string-prefix check", () => {
  const evidence = capture("review-write-prefix-sibling", {
    environment: { PI_NONO_PROFILE: "pi-review" },
    workspace: "repo-fixture",
  });
  assert.ifError(evidence.error);
  assert.equal(evidence.result.status, 0);
  assert.equal(piRuns(evidence.trace).length, 1);
});

test("a deny ancestor defeats an apparent exact Pi-state grant", () => {
  const evidence = capture("review-deny-ancestor", {
    environment: { PI_NONO_PROFILE: "pi-review" },
  });
  assertSafeFailure(evidence, "pi-state");
});

test("explicit rollback and host-default disabled execute bare Pi without probing nono", () => {
  const rollback = capture("enforced", {
    environment: { PI_NONO: "disabled" },
    providerOrigin: null,
    userArguments: ["--rollback-fixture"],
  });
  const hostDefault = capture("disabled", {
    providerOrigin: null,
    userArguments: ["--host-default-fixture"],
  });

  for (const [evidence, argv] of [
    [rollback, ["--rollback-fixture"]],
    [hostDefault, ["--host-default-fixture"]],
  ]) {
    assert.ifError(evidence.error);
    assert.deepEqual(evidence.result, { status: 0, signal: null });
    assert.equal(evidence.trace.some((entry) => entry.executable === "nono"), false);
    assert.deepEqual(piRuns(evidence.trace), [
      { executable: "pi", argv, route: "bare" },
    ]);
  }
});

test("an invalid disabled selection cannot become a bare-Pi fallback", () => {
  const evidence = capture("enforced", {
    environment: {
      PI_NONO: "disabled",
      PI_NONO_PROFILE: "pi-review",
    },
    providerOrigin: null,
  });
  assertSafeFailure(evidence, "selection");
  assert.equal(evidence.trace.some((entry) => entry.executable === "nono"), false);
});

test("every required resolved grant fails closed before Pi", () => {
  const fixtures = {
    "missing-mcp": "mcpproxy",
    "missing-package": "package-read",
    "missing-agent": "pi-state",
    "missing-cavemem": "cavemem-state",
    "missing-temp": "temp-state",
    "wrong-workspace": "workspace",
    "denied-workspace": "workspace",
    "missing-environment": "environment",
    "wrong-process": "process-control",
  };
  for (const [name, component] of Object.entries(fixtures)) {
    assertSafeFailure(capture(name), component, name);
  }
});

test("managed and review profiles require one strictly validated HTTPS provider origin", () => {
  for (const providerOrigin of [
    null,
    "http://gateway.example.test",
    "https://user@gateway.example.test",
    "https://gateway.example.test/path",
    "https://gateway.example.test?query=1",
    "https://gateway.example.test/#fragment",
  ]) {
    assertSafeFailure(capture("enforced", { providerOrigin }), "provider-network");
  }
});

test("missing and tampered binaries, catalog, and profiles fail closed", () => {
  const fixtures = {
    "unavailable-nono": "nono",
    "wrong-version-nono": "nono",
    "missing-pi": "pi",
    "missing-profile": "profile",
    "tampered-catalog": "catalog",
    "tampered-profile": "profile",
    "tampered-resolved": "profile",
  };
  for (const [name, component] of Object.entries(fixtures)) {
    assertSafeFailure(capture(name), component);
  }
});

test("enabled nono failure never falls back to bare Pi", () => {
  const evidence = capture("run-failure");
  assert.ifError(evidence.error);
  assert.deepEqual(evidence.result, { status: 73, signal: null });
  assert.ok(nonoRun(evidence.trace));
  assert.deepEqual(piRuns(evidence.trace), []);
});

test("the executor rejects non-closed input and preserves hostile values out of diagnostics", () => {
  const evidence = capture("enforced", {
    userArguments: ["valid", `hostile-${secretSentinel}\0argument`],
  });
  assertSafeFailure(evidence, "invocation");
});

test("transparent and revoked Proxy inputs are rejected before any proxy trap", () => {
  const trapCalls = {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  };
  const transparent = capture("enforced", {
    inputFactory(defaultInput) {
      return new Proxy(defaultInput, {
        get(target, property, receiver) {
          trapCalls.get += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          trapCalls.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          trapCalls.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
      });
    },
  });
  assertSafeFailure(transparent, "invocation");
  assert.deepEqual(trapCalls, {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  });

  const revoked = capture("enforced", {
    inputFactory(defaultInput) {
      const revocable = Proxy.revocable(defaultInput, {});
      revocable.revoke();
      return revocable.proxy;
    },
  });
  assertSafeFailure(revoked, "invocation");
});

test("Proxy argument arrays and accessor elements are rejected without reading values", () => {
  const arrayTrapCalls = {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  };
  const proxyArray = capture("enforced", {
    inputFactory(defaultInput) {
      return {
        ...defaultInput,
        userArguments: new Proxy(defaultInput.userArguments, {
          get(target, property, receiver) {
            arrayTrapCalls.get += 1;
            return Reflect.get(target, property, receiver);
          },
          getOwnPropertyDescriptor(target, property) {
            arrayTrapCalls.getOwnPropertyDescriptor += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
          getPrototypeOf(target) {
            arrayTrapCalls.getPrototypeOf += 1;
            return Reflect.getPrototypeOf(target);
          },
          ownKeys(target) {
            arrayTrapCalls.ownKeys += 1;
            return Reflect.ownKeys(target);
          },
        }),
      };
    },
  });
  assertSafeFailure(proxyArray, "invocation");
  assert.deepEqual(arrayTrapCalls, {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  });

  const revokedArray = capture("enforced", {
    inputFactory(defaultInput) {
      const revocable = Proxy.revocable(defaultInput.userArguments, {});
      revocable.revoke();
      return { ...defaultInput, userArguments: revocable.proxy };
    },
  });
  assertSafeFailure(revokedArray, "invocation");

  let accessorCalls = 0;
  const accessorArray = capture("enforced", {
    inputFactory(defaultInput) {
      const userArguments = [];
      Object.defineProperty(userArguments, "0", {
        configurable: true,
        enumerable: true,
        get() {
          accessorCalls += 1;
          return "--hostile-accessor";
        },
      });
      userArguments.length = 1;
      return { ...defaultInput, userArguments };
    },
  });
  assertSafeFailure(accessorArray, "invocation");
  assert.equal(accessorCalls, 0);
});

test("the final executor package contains no Task 5.5 feature seam", () => {
  for (const packageValue of Object.values(packages)) {
    assert.doesNotMatch(
      packageValue.source,
      /TASK_55_ENABLED|task55Enabled|sandbox executor feature disabled/,
    );
    assert.doesNotMatch(
      packageValue.source,
      /__PI_AGENT_[A-Z0-9_]+__|PI_AGENT_EXPECTED_CATALOG_PLACEHOLDER/,
    );
    assert.deepEqual(Object.keys(packageValue.executor).sort(), [
      "SandboxExecutionError",
      "executeSandboxedPi",
    ]);
  }
});
