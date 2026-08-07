import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROBE_NAMES,
  assertNoFailedGates,
  createValidationReport,
  runProbe,
  runSmokeFixture,
  withFixtureWorkspace,
} from "./harness.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");

const expectedProbeResponses = {
  pi: {
    sessionId: "fixture-pi-session",
    state: "ready",
  },
  provider: {
    content: "fixture-provider-response",
    model: "fixture-model",
  },
  mcpproxy: {
    tools: [
      "retrieve_tools",
      "describe_tool",
      "call_tool_read",
      "call_tool_write",
      "call_tool_destructive",
      "read_cache",
    ],
  },
  cavemem: {
    observationId: "fixture-observation-1",
    stored: true,
  },
  nono: {
    profile: "pi-managed",
    state: "enforced",
  },
  "language-server": {
    diagnostics: [],
    locations: [
      {
        line: 1,
        path: "src/fixture.mjs",
      },
    ],
    state: "ready",
  },
  subprocess: {
    exitCode: 0,
    stdout: "fixture-subprocess-output",
  },
};

test("fixture workspaces are writable, isolated copies", async () => {
  let firstWorkspace;
  await withFixtureWorkspace("smoke-workspace", async (workspace) => {
    firstWorkspace = workspace;
    const seed = path.join(workspace, "seed.txt");

    assert.equal(fs.readFileSync(seed, "utf8"), "fixture-seed\n");
    fs.writeFileSync(seed, "mutated\n");
    fs.writeFileSync(path.join(workspace, "created.txt"), "created\n");
  });

  assert.equal(fs.existsSync(firstWorkspace), false);

  await withFixtureWorkspace("smoke-workspace", async (workspace) => {
    assert.equal(fs.readFileSync(path.join(workspace, "seed.txt"), "utf8"), "fixture-seed\n");
    assert.equal(fs.existsSync(path.join(workspace, "created.txt")), false);
  });
});

test("all boundary probes return deterministic invocation evidence", () => {
  assert.deepEqual(PROBE_NAMES, Object.keys(expectedProbeResponses));

  for (const probe of PROBE_NAMES) {
    assert.notEqual(
      fs.statSync(path.join(testsDir, "fixtures", "probes", `${probe}.mjs`)).mode & 0o111,
      0,
      `${probe} probe is not executable`,
    );

    const request = {
      operation: "smoke",
      payload: probe,
    };
    const result = runProbe(probe, {
      argv: ["--fixture", probe],
      environment: {
        PI_AGENT_FIXTURE_A: "fixture-a",
        PI_AGENT_FIXTURE_Z: "fixture-z",
      },
      request,
    });

    assert.deepEqual(result, {
      schemaVersion: 1,
      probe,
      invocation: {
        argv: ["--fixture", probe],
        environment: {
          PI_AGENT_FIXTURE_A: "fixture-a",
          PI_AGENT_FIXTURE_Z: "fixture-z",
        },
      },
      request,
      response: expectedProbeResponses[probe],
    });
  }

  assert.throws(
    () =>
      runProbe("subprocess", {
        environment: { PI_AGENT_PROBE_EXIT_CODE: "7" },
        request: { operation: "expected-failure" },
      }),
    /subprocess probe exited 7/,
  );
});

test("validation reports enforce the acceptance gate vocabulary", () => {
  const report = createValidationReport("fixture-generation", [
    {
      name: "pure-smoke",
      status: "pass",
      evidence: ["deterministic fixture"],
    },
    {
      name: "shopify-live",
      status: "manual-required",
      evidence: ["switched-host-only"],
    },
  ]);

  assert.deepEqual(report, {
    generation: "fixture-generation",
    gates: [
      {
        name: "pure-smoke",
        status: "pass",
        evidence: ["deterministic fixture"],
      },
      {
        name: "shopify-live",
        status: "manual-required",
        evidence: ["switched-host-only"],
      },
    ],
  });
  assert.doesNotThrow(() => assertNoFailedGates(report));
  assert.throws(
    () =>
      createValidationReport("fixture-generation", [
        {
          name: "invalid",
          status: "skipped",
          evidence: ["unsupported status"],
        },
      ]),
    /invalid gate status: skipped/,
  );
  assert.throws(
    () =>
      assertNoFailedGates(
        createValidationReport("fixture-generation", [
          {
            name: "broken",
            status: "fail",
            evidence: ["expected failure"],
          },
        ]),
      ),
    /failed gates: broken/,
  );
});

test("the smoke fixture and standalone runner emit stable pure-check evidence", async () => {
  const first = await runSmokeFixture();
  const second = await runSmokeFixture();

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    generation: "pi-agent-harness-v1",
    gates: [
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
      {
        name: "shopify-live",
        status: "manual-required",
        evidence: ["credential-bearing", "switched-host-only"],
      },
    ],
  });

  const runner = childProcess.spawnSync(process.execPath, [path.join(testsDir, "run.js"), "--smoke"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(runner.status, 0, runner.stderr);
  assert.deepEqual(JSON.parse(runner.stdout), first);
  assert.equal(runner.stderr, "");
});

test("the flake registers the smoke runner only on aarch64-darwin", () => {
  const flake = fs.readFileSync(path.join(repoRoot, "flake.nix"), "utf8");

  assert.match(
    flake,
    /piAgentChecks = pkgs\.lib\.optionalAttrs \(system == "aarch64-darwin"\)/,
  );
  assert.match(flake, /pi-agent-harness =/);
  assert.match(flake, /node tests\/pi-agent\/run\.js --smoke > \$out/);
});
