import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/credential-resolver.nix";
const resolverModuleRelativePath = "lib/pi-agent/credential-resolver.mjs";
const policyModuleRelativePath = "lib/pi-agent/credential-policy.mjs";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const tokenSentinel = "task-5-2-token-sentinel-7e8391";
const baseSentinel = "opaque-base-candidate://task-5-2?not-yet-validated=1";
const stderrSentinel = "task-5-2-child-stderr-sentinel-913e5a";
const injectedSentinel = "task-5-2-injected-contract-sentinel-70a8bd";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fixtureRoot;
let shopify;
let personal;
let spawnFailure;
let tamperedArtifact;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-credential-resolver-tests";
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

async function loadPackage(name) {
  const root = path.join(fixtureRoot, name);
  const resolverPath = path.join(root, resolverModuleRelativePath);
  const policyPath = path.join(root, policyModuleRelativePath);
  assert.ok(
    fs.existsSync(resolverPath),
    `missing packaged resolver module ${resolverPath}`,
  );
  assert.ok(
    fs.existsSync(policyPath),
    `missing generated Task 2.5 module ${policyPath}`,
  );
  return {
    root,
    resolverPath,
    resolverSource: fs.readFileSync(resolverPath, "utf8"),
    resolver: await import(pathToFileURL(resolverPath)),
    policy: await import(pathToFileURL(policyPath)),
  };
}

before(
  async () => {
    fixtureRoot = buildFixture("executor-packages");
    [shopify, personal, spawnFailure, tamperedArtifact] = await Promise.all([
      loadPackage("shopify"),
      loadPackage("personal"),
      loadPackage("spawn-failure"),
      loadPackage("tampered-artifact"),
    ]);
  },
  { timeout: 600_000 },
);

function createProcessFixture(t, mode = "success", overrides = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-credential-resolver-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    traceFile: path.join(root, "trace.tsv"),
    pidFile: path.join(root, "processes.txt"),
    environment: {
      PI_AGENT_TASK52_MODE: mode,
      PI_AGENT_TASK52_TRACE_FILE: path.join(root, "trace.tsv"),
      PI_AGENT_TASK52_PID_FILE: path.join(root, "processes.txt"),
      PI_AGENT_TASK52_TOKEN_OUTPUT: tokenSentinel,
      PI_AGENT_TASK52_BASE_OUTPUT: baseSentinel,
      PI_AGENT_TASK52_STDERR_OUTPUT: stderrSentinel,
      ...overrides,
    },
  };
}

async function withEnvironment(environment, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(
      name,
      Object.hasOwn(process.env, name) ? process.env[name] : undefined,
    );
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function runResolver(packageValue, processFixture) {
  return withEnvironment(processFixture.environment, () =>
    packageValue.resolver.resolveProviderRuntimeSecrets(),
  );
}

function readTrace(processFixture) {
  if (!fs.existsSync(processFixture.traceFile)) return [];
  const text = fs.readFileSync(processFixture.traceFile, "utf8").trim();
  if (text === "") return [];
  return text.split("\n").map((line) => line.split("\t"));
}

function assertTrace(processFixture, expectedArgv) {
  const trace = readTrace(processFixture);
  assert.equal(trace.length, expectedArgv.length, JSON.stringify(trace));
  assert.deepEqual(
    trace.map((entry) => entry.slice(1)),
    expectedArgv.map((argv) => [String(argv.length), ...argv]),
  );
  for (const entry of trace) {
    assert.match(entry[0], /^\d+$/);
  }
}

function readRecordedPids(processFixture) {
  if (!fs.existsSync(processFixture.pidFile)) return [];
  return fs
    .readFileSync(processFixture.pidFile, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function assertProcessesGone(pids) {
  assert.ok(
    pids.length >= 2,
    `fixture did not record a process group: ${pids}`,
  );
  const deadline = Date.now() + 2_000;
  while (pids.some(processExists) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(
    pids.filter(processExists),
    [],
    `credential resolver left child processes: ${pids}`,
  );
}

function readTree(root) {
  const chunks = [];
  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      chunks.push(fs.readlinkSync(target));
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort())
        visit(path.join(target, entry));
    } else {
      chunks.push(fs.readFileSync(target, "utf8"));
    }
  }
  visit(root);
  return chunks.join("\n");
}

function assertNoSentinels(value, sentinels) {
  for (const sentinel of sentinels) {
    assert.equal(
      value.includes(sentinel),
      false,
      `credential value persisted or leaked: ${sentinel}`,
    );
  }
}

function assertConstructorOutcome(
  outcome,
  policy,
  expectedBase = baseSentinel,
) {
  assert.deepEqual(Object.keys(outcome).sort(), [
    "baseCandidate",
    "runtimeSecrets",
  ]);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(outcome.baseCandidate, expectedBase);
  assert.match(outcome.runtimeSecrets.launchId, uuidPattern);
  const expected = policy.createProviderRuntimeSecrets({
    resolverResults: {
      "shopify-gateway-token": tokenSentinel,
      "shopify-gateway-base": expectedBase,
    },
    launchId: outcome.runtimeSecrets.launchId,
  });
  assert.deepEqual(outcome.runtimeSecrets, expected);
  assert.equal(outcome.runtimeSecrets.token, tokenSentinel);
  assert.deepEqual(outcome.runtimeSecrets.rootPiEnvironment, {
    SHOPIFY_PI_TOKEN: tokenSentinel,
    PI_AGENT_LAUNCH_ID: outcome.runtimeSecrets.launchId,
  });
  assert.deepEqual(
    outcome.runtimeSecrets.childPiEnvironment,
    outcome.runtimeSecrets.rootPiEnvironment,
  );
  assert.notEqual(
    outcome.runtimeSecrets.childPiEnvironment,
    outcome.runtimeSecrets.rootPiEnvironment,
  );
  assert.deepEqual(
    [...outcome.runtimeSecrets.exactRedactionValues],
    [tokenSentinel, outcome.runtimeSecrets.launchId],
  );
  assert.throws(() => JSON.stringify(outcome), /not serializable/);
}

function expectedFailureMessage(kind, operation, failure) {
  return `credential resolver ${kind} operation ${operation} failed: ${failure}`;
}

async function captureFailure(packageValue, processFixture) {
  try {
    await runResolver(packageValue, processFixture);
  } catch (error) {
    return error;
  }
  assert.fail("credential resolver unexpectedly succeeded");
}

function assertSafeFailure(error, kind, operation, failure) {
  assert.equal(error.message, expectedFailureMessage(kind, operation, failure));
  assert.deepEqual(Object.keys(error), []);
  assertNoSentinels(error.message, [
    tokenSentinel,
    baseSentinel,
    stderrSentinel,
    injectedSentinel,
  ]);
}

const tokenArgv = ["llm-gateway", "print-token", "--key"];
const baseArgv = ["llm-gateway", "print-token", "--base"];

test("packaged Shopify executor uses fixed argv and returns the exact Task 2.5 constructor result", async (t) => {
  const processFixture = createProcessFixture(t);
  const outcome = await runResolver(shopify, processFixture);

  assertConstructorOutcome(outcome, shopify.policy);
  assertTrace(processFixture, [tokenArgv, baseArgv]);
  assertNoSentinels(readTree(processFixture.root), [
    tokenSentinel,
    baseSentinel,
    outcome.runtimeSecrets.launchId,
    stderrSentinel,
  ]);
  assertNoSentinels(shopify.resolverSource, [
    tokenSentinel,
    baseSentinel,
    stderrSentinel,
  ]);
});

test("two Shopify executions create distinct runtime objects and UUIDs with a stable base", async (t) => {
  const processFixture = createProcessFixture(t);
  const first = await runResolver(shopify, processFixture);
  const second = await runResolver(shopify, processFixture);

  assertConstructorOutcome(first, shopify.policy);
  assertConstructorOutcome(second, shopify.policy);
  assert.notEqual(first.runtimeSecrets, second.runtimeSecrets);
  assert.notEqual(
    first.runtimeSecrets.launchId,
    second.runtimeSecrets.launchId,
  );
  assert.equal(first.baseCandidate, second.baseCandidate);
  assertTrace(processFixture, [tokenArgv, baseArgv, tokenArgv, baseArgv]);
  assertNoSentinels(readTree(processFixture.root), [
    tokenSentinel,
    baseSentinel,
    first.runtimeSecrets.launchId,
    second.runtimeSecrets.launchId,
  ]);
});

test("personal execution dispatches no process and returns the exact empty constructor result", async (t) => {
  const processFixture = createProcessFixture(t, "command-token", {
    PATH: `${path.join(personal.root, "bin")}:${process.env.PATH}`,
  });
  const outcome = await runResolver(personal, processFixture);
  const expected = personal.policy.createProviderRuntimeSecrets({
    resolverResults: {},
    launchId: null,
  });

  assert.deepEqual(outcome, { runtimeSecrets: expected, baseCandidate: null });
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(outcome.runtimeSecrets.mode, "personal");
  assert.deepEqual(outcome.runtimeSecrets.rootPiEnvironment, {});
  assert.deepEqual(outcome.runtimeSecrets.childPiEnvironment, {});
  assert.deepEqual([...outcome.runtimeSecrets.exactRedactionValues], []);
  assert.equal(outcome.baseCandidate, null);
  assertTrace(processFixture, []);
  assert.equal(fs.existsSync(processFixture.pidFile), false);
});

test("token and base command failures are fixed, value-free, and operation-specific", async (t) => {
  const cases = [
    {
      mode: "command-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
    {
      mode: "command-base",
      kind: "shopify-gateway-base",
      operation: "base",
      trace: [tokenArgv, baseArgv],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.mode, async (subtest) => {
      const processFixture = createProcessFixture(subtest, fixtureCase.mode);
      const error = await captureFailure(shopify, processFixture);
      assertSafeFailure(
        error,
        fixtureCase.kind,
        fixtureCase.operation,
        "command",
      );
      assertTrace(processFixture, fixtureCase.trace);
      assertNoSentinels(readTree(processFixture.root), [
        tokenSentinel,
        baseSentinel,
        stderrSentinel,
      ]);
    });
  }
});

test("token and base timeouts kill and await each resolver process group", async (t) => {
  const cases = [
    {
      mode: "timeout-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
    {
      mode: "timeout-base",
      kind: "shopify-gateway-base",
      operation: "base",
      trace: [tokenArgv, baseArgv],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.mode, async (subtest) => {
      const processFixture = createProcessFixture(subtest, fixtureCase.mode);
      const error = await captureFailure(shopify, processFixture);
      assertSafeFailure(
        error,
        fixtureCase.kind,
        fixtureCase.operation,
        "timeout",
      );
      assertTrace(processFixture, fixtureCase.trace);
      await assertProcessesGone(readRecordedPids(processFixture));
      assertNoSentinels(readTree(processFixture.root), [
        tokenSentinel,
        baseSentinel,
      ]);
    });
  }
});

test("stdout and stderr bounds terminate overflowing process groups while reading", async (t) => {
  const cases = [
    {
      mode: "overflow-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
    {
      mode: "overflow-base",
      kind: "shopify-gateway-base",
      operation: "base",
      trace: [tokenArgv, baseArgv],
    },
    {
      mode: "stderr-overflow-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.mode, async (subtest) => {
      const processFixture = createProcessFixture(subtest, fixtureCase.mode);
      const error = await captureFailure(shopify, processFixture);
      assertSafeFailure(
        error,
        fixtureCase.kind,
        fixtureCase.operation,
        "output-limit",
      );
      assertTrace(processFixture, fixtureCase.trace);
      await assertProcessesGone(readRecordedPids(processFixture));
      assertNoSentinels(readTree(processFixture.root), [
        tokenSentinel,
        baseSentinel,
      ]);
    });
  }
});

test("empty and multiline resolver values fail without leaking output", async (t) => {
  const cases = [
    {
      mode: "empty-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
    {
      mode: "empty-base",
      kind: "shopify-gateway-base",
      operation: "base",
      trace: [tokenArgv, baseArgv],
    },
    {
      mode: "multiline-token",
      kind: "shopify-gateway-token",
      operation: "token",
      trace: [tokenArgv],
    },
    {
      mode: "multiline-base",
      kind: "shopify-gateway-base",
      operation: "base",
      trace: [tokenArgv, baseArgv],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.mode, async (subtest) => {
      const processFixture = createProcessFixture(subtest, fixtureCase.mode);
      const error = await captureFailure(shopify, processFixture);
      assertSafeFailure(
        error,
        fixtureCase.kind,
        fixtureCase.operation,
        "invalid-output",
      );
      assertTrace(processFixture, fixtureCase.trace);
      assertNoSentinels(readTree(processFixture.root), [
        tokenSentinel,
        baseSentinel,
      ]);
    });
  }
});

test("a missing package executable reports spawn failure without exposing its path", async (t) => {
  const processFixture = createProcessFixture(t);
  const error = await captureFailure(spawnFailure, processFixture);

  assertSafeFailure(error, "shopify-gateway-token", "token", "spawn");
  assertTrace(processFixture, []);
  assert.equal(error.message.includes(spawnFailure.root), false);
});

test("closed packaged artifacts and the zero-input API reject arbitrary execution policy", async (t) => {
  assert.deepEqual(Object.keys(shopify.resolver), [
    "resolveProviderRuntimeSecrets",
  ]);
  assert.equal(Object.isFrozen(shopify.policy.resolverPlans), true);
  assert.equal(Object.isFrozen(shopify.policy.resolverPlans[0]), true);
  assert.throws(() => {
    shopify.policy.resolverPlans[0].kind = injectedSentinel;
  }, TypeError);

  const injections = [
    { resolverPlans: [{ kind: injectedSentinel }] },
    { executable: `/tmp/${injectedSentinel}`, argv: [injectedSentinel] },
    { timeoutMs: 999_999, outputLimit: 999_999 },
  ];
  for (const injection of injections) {
    await t.test(Object.keys(injection).join("-"), async (subtest) => {
      const processFixture = createProcessFixture(subtest);
      const error = await withEnvironment(
        processFixture.environment,
        async () => {
          try {
            await shopify.resolver.resolveProviderRuntimeSecrets(injection);
          } catch (caught) {
            return caught;
          }
          assert.fail("injected resolver policy unexpectedly succeeded");
        },
      );
      assert.equal(error.message, "credential resolver invocation rejected");
      assertNoSentinels(error.message, [
        injectedSentinel,
        tokenSentinel,
        baseSentinel,
      ]);
      assertTrace(processFixture, []);
    });
  }

  const processFixture = createProcessFixture(t);
  const error = await captureFailure(tamperedArtifact, processFixture);
  assert.equal(error.message, "credential resolver contract validation failed");
  assertNoSentinels(error.message, [
    injectedSentinel,
    tokenSentinel,
    baseSentinel,
  ]);
  assertTrace(processFixture, []);
});

test("packaged executor owns finite immutable limits and uses direct spawn without shell interpolation", () => {
  assert.match(shopify.resolverSource, /const RESOLVER_TIMEOUT_MS = 5_000;/);
  assert.match(
    shopify.resolverSource,
    /const RESOLVER_OUTPUT_LIMIT_BYTES = 16 \* 1024;/,
  );
  assert.match(
    shopify.resolverSource,
    /spawn\(invocation\.executable, invocation\.argv,/,
  );
  assert.match(shopify.resolverSource, /shell: false/);
  assert.match(shopify.resolverSource, /detached: true/);
  assert.match(shopify.resolverSource, /createProviderRuntimeSecrets\(/);
  assert.match(
    shopify.resolverSource,
    /const EXECUTION_PLAN_DIGEST = "[0-9a-f]{64}";/,
  );
  assert.doesNotMatch(
    shopify.resolverSource,
    /PI_AGENT_EXECUTION_PLAN_VALUES_PLACEHOLDER|__PI_AGENT_/,
  );
  assert.doesNotMatch(
    shopify.resolverSource,
    /execFile|execSync|shell:\s*true/,
  );
  assert.doesNotMatch(
    shopify.resolverSource,
    /new URL|URL\.parse|vendors\/|apis\//,
  );
  assert.equal(fs.statSync(shopify.resolverPath).mode & 0o222, 0);
});
