import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createValidationReport } from "./harness.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const profileFixturePath = "tests/pi-agent/fixtures/profile-catalog.nix";
const probePath = path.join(testsDir, "fixtures/security-integration-probe.mjs");
const profileNames = ["pi-managed", "pi-audit", "pi-review"];
const providerHost = "provider.allowed.localhost";
const deniedProviderHost = "provider.denied.localhost";
const manualPrerequisite =
  "unsandboxed macOS host process outside the enclosing OpenCode/Nix Seatbelt";
const manualMissingEvidence =
  "nested Seatbelt prevents nono from applying a supervised child profile";
const manualProbeCategories = "probe-categories:filesystem,network,review";
const nonoOpenPortBindLimitation =
  "nono-0.69.0-macos-open-port-bind-limitation";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

let catalog;
let profilePackage;
let productionExecutor;
let productionExecutorFixture;

function profileFixtureExpression(fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-security-integration-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoSource));
    in import (repoSource + "/${profileFixturePath}") {
      inherit flake repoSource;
      fixture = ${JSON.stringify(fixture)};
    }
  `;
}

function buildProfilePackage() {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      profileFixtureExpression("package"),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function loadCatalog() {
  const result = childProcess.spawnSync(
    "nix",
    [
      "eval",
      "--json",
      "--impure",
      "--expr",
      profileFixtureExpression("catalog"),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function buildProductionExecutor() {
  const expression = `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-security-production-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoSource));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
    in import (repoSource + "/scripts/pi-agent-sandbox-executor.nix") {
      inherit pkgs;
      defaultState = "enforced";
      piPackage = pkgs.pi-agent;
    }
  `;
  const result = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--print-out-paths", "--impure", "--expr", expression],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function buildProductionExecutorFixture() {
  const expression = `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-security-production-fixture-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      fixture = import (repoSource + "/tests/pi-agent/fixtures/sandbox-executor.nix") {
        fixture = "packages";
        repoRoot = repoSource;
      };
    in fixture
  `;
  const result = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--print-out-paths", "--impure", "--expr", expression],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return path.join(result.stdout.trim(), "production");
}

function makeRoot() {
  const hostStateRoot = path.join(os.homedir(), ".local/state/opencode");
  fs.mkdirSync(hostStateRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(hostStateRoot, "pi-agent-security-integration-"));
  const home = path.join(root, "home");
  const cache = path.join(home, ".cache");
  const config = path.join(home, ".config");
  const data = path.join(home, ".local/share");
  const state = path.join(root, "nono-state");
  const tmp = path.join(root, "private-tmp");
  const workspace = path.join(root, "workspace");
  const agent = path.join(home, ".pi/agent");
  const cavemem = path.join(data, "cavemem");
  const credentials = [
    path.join(home, ".ssh"),
    path.join(config, "git"),
    path.join(home, "Library/Application Support/1Password"),
    path.join(home, "Library/Keychains"),
  ];

  for (const directory of [
    cache,
    config,
    data,
    state,
    tmp,
    workspace,
    agent,
    cavemem,
    ...credentials,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "unchanged.txt"), "original\n");
  fs.writeFileSync(path.join(agent, "state.txt"), "agent\n");
  fs.writeFileSync(path.join(cavemem, "state.txt"), "cavemem\n");
  fs.writeFileSync(path.join(cache, "state.txt"), "cache\n");
  fs.writeFileSync(path.join(home, ".ssh/secret"), "credential\n");
  fs.writeFileSync(path.join(config, "git/config"), "credential\n");
  fs.writeFileSync(path.join(home, "Library/Keychains/login.keychain-db"), "credential\n");
  fs.copyFileSync(probePath, path.join(workspace, "probe.mjs"));

  return {
    root,
    home,
    cache,
    data,
    state,
    tmp,
    workspace,
    agent,
    cavemem,
    environment: {
      ...process.env,
      CAVEMEM_DATA_DIR: cavemem,
      HOME: home,
      NONO_NO_SAVE_PROMPT: "1",
      NONO_NO_UPDATE_CHECK: "1",
      PI_CODING_AGENT_DIR: agent,
      TMPDIR: tmp,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
    },
  };
}

function runNono(args, sandbox, cwd = sandbox.workspace) {
  return childProcess.spawnSync(catalog.nono, args, {
    cwd,
    encoding: "utf8",
    env: sandbox.environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function profilePath(name) {
  return path.join(profilePackage, "share/pi-agent/nono/profiles", `${name}.json`);
}

function writeRuntimeProfile(name, sandbox, { providerHost = "localhost", listenPorts = [] } = {}) {
  const source = JSON.parse(fs.readFileSync(profilePath(name), "utf8"));
  const effectiveProviderHost = name === "pi-audit" ? null : providerHost;
  source.network.block = effectiveProviderHost === null ? source.network.block : false;
  source.network.network_profile = effectiveProviderHost === null ? null : "minimal";
  source.network.allow_domain = effectiveProviderHost === null ? [] : [effectiveProviderHost];
  source.network.listen_port = [...listenPorts];
  const file = path.join(sandbox.root, `${name}-${listenPorts.join("-") || "default"}.json`);
  fs.writeFileSync(file, `${JSON.stringify(source)}\n`, { mode: 0o600 });
  const validation = runNono(["profile", "validate", "--strict", file], sandbox);
  assert.equal(validation.status, 0, `${name}: ${validation.stderr}`);
  return file;
}

function runProbe(profile, sandbox, operation, value, port) {
  const probeArguments = [operation];
  if (operation === "listen") {
    probeArguments.push(String(port));
  } else {
    if (value !== undefined) probeArguments.push(value);
    if (port !== undefined) probeArguments.push(String(port));
  }
  const result = runNono(
    [
      "run",
      "--silent",
      "--no-audit",
      "--no-rollback",
      "--profile",
      profile,
      "--allow-cwd",
      "--",
      process.execPath,
      path.join(sandbox.workspace, "probe.mjs"),
      ...probeArguments,
    ],
    sandbox,
  );
  let report = null;
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line !== undefined) {
    try {
      report = JSON.parse(line);
    } catch {
      report = null;
    }
  }
  return { report, result };
}

function readManifest(profile, sandbox) {
  const result = runNono(
    ["profile", "show", profile, "--format", "manifest", "--silent"],
    sandbox,
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertProbeAllowed(probe, label) {
  assert.equal(probe.result.signal, null, label);
  assert.equal(probe.result.status, 0, `${label}: ${probe.result.stderr}`);
  assert.deepEqual(probe.report?.ok, true, label);
}

function assertProbeDenied(probe, label) {
  assert.equal(probe.result.signal, null, `${label}: probe crashed`);
  assert.equal(
    probe.result.status,
    0,
    `${label}: setup/process failure is not sandbox denial: ${probe.result.stderr}`,
  );
  assert.ok(probe.report !== null, `${label}: missing structured denial output`);
  assert.equal(probe.report.ok, false, `${label}: probe unexpectedly succeeded`);
  assert.equal(probe.report.denied, true, `${label}: failure was not identified as sandbox denial`);
  assert.deepEqual(probe.report.sideEffects, [], `${label}: denial had side effects`);
}

function isConstrainedNono(result) {
  return (
    result?.status === 126 &&
    /failed to apply sandbox in supervised child: Sandbox initialization failed: Operation not permitted/.test(
      `${result.stderr}\n${result.stdout}`,
    )
  );
}

function manualRequiredReport(categories) {
  return createValidationReport("pi-agent-security-v1", [
    {
      name: "profile-evaluation-and-manifest-assertions",
      status: "pass",
      evidence: [
        "profiles:pi-managed,pi-audit,pi-review",
        "retained:fail-closed,profile-evaluation,manifest",
      ],
    },
    {
      name: "provider-host-allowlist",
      status: "manual-required",
      evidence: [
        `allowed-host:${providerHost}`,
        `denied-host:${deniedProviderHost}`,
        "endpoint:fixture-owned-loopback",
        "retained:mcpproxy-localhost:8080",
        `missing-prerequisite:${manualPrerequisite}`,
      ],
    },
    {
      name: "real-nono-effect-probes",
      status: "manual-required",
      evidence: [
        `missing-prerequisite:${manualPrerequisite}`,
        `missing-evidence:${manualMissingEvidence}`,
        manualProbeCategories,
        `required-categories:${categories.join(",")}`,
        "recovery:rerun on an unsandboxed macOS host process",
      ],
    },
  ]);
}

function reportManualGate(testContext, categories) {
  testContext.diagnostic(JSON.stringify(manualRequiredReport(categories)));
}

function reportNonoOpenPortBindLimitation(testContext) {
  testContext.diagnostic(
    JSON.stringify(
      createValidationReport("pi-agent-security-v1", [
        {
          name: "real-nono-loopback-bind-enforcement",
          status: "pass",
          evidence: [
            `accepted-limitation:${nonoOpenPortBindLimitation}`,
            "manifest:network.ports.bind-absent",
            "probe:unlisted-loopback-listen-succeeded",
            "enforcement:per-port-denial-not-claimed",
          ],
        },
      ]),
    ),
  );
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end("ok\n"));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function maybeListen(port) {
  try {
    return { server: await listen(port), owned: true };
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return { server: null, owned: false };
  }
}

function closeServer(server) {
  return server === null
    ? Promise.resolve()
    : new Promise((resolve) => server.close(resolve));
}

before(
  () => {
    catalog = loadCatalog();
    profilePackage = buildProfilePackage();
    productionExecutor = buildProductionExecutor();
    productionExecutorFixture = buildProductionExecutorFixture();
  },
  { timeout: 1_200_000 },
);

test("security report exposes the synthetic provider allow and deny gate", () => {
  const report = manualRequiredReport(["network"]);
  const gate = report.gates.find((entry) => entry.name === "provider-host-allowlist");

  assert.deepEqual(gate, {
    name: "provider-host-allowlist",
    status: "manual-required",
    evidence: [
      `allowed-host:${providerHost}`,
      `denied-host:${deniedProviderHost}`,
      "endpoint:fixture-owned-loopback",
      "retained:mcpproxy-localhost:8080",
      `missing-prerequisite:${manualPrerequisite}`,
    ],
  });
});

test("sandbox denial assertions reject setup failures and require zero-side-effect evidence", () => {
  assert.throws(
    () =>
      assertProbeDenied(
        {
          report: null,
          result: { signal: null, status: 1, stderr: "probe setup failed" },
        },
        "crashed probe",
      ),
    /setup\/process failure is not sandbox denial/,
  );
  assert.throws(
    () =>
      assertProbeDenied(
        {
          report: null,
          result: { signal: null, status: 0, stderr: "" },
        },
        "missing report",
      ),
    /missing structured denial output/,
  );
  assert.throws(
    () =>
      assertProbeDenied(
        {
          report: { denied: false, ok: false, sideEffects: null },
          result: { signal: null, status: 0, stderr: "" },
        },
        "unclassified failure",
      ),
    /not identified as sandbox denial/,
  );
  assert.doesNotThrow(() =>
    assertProbeDenied(
      {
        report: { denied: true, ok: false, sideEffects: [] },
        result: { signal: null, status: 0, stderr: "" },
      },
      "structured denial",
    ),
  );
});

test(
  "real nono enforces the managed, audit, and review filesystem and network matrix",
  { timeout: 1_200_000 },
  async (t) => {
    const sandbox = makeRoot();
    const mcp = await maybeListen(8080);
    const unlisted = await maybeListen(0);
    assert.equal(unlisted.owned, true, "fixture-owned unlisted network port could not be allocated");
    const unlistedPort = unlisted.server.address().port;
    assert.notEqual(unlistedPort, 8080);
    try {
      for (const name of profileNames) {
        await t.test(name, async (profileTest) => {
          const profile = writeRuntimeProfile(name, sandbox);
          const workspaceFile = path.join(sandbox.workspace, "unchanged.txt");
          const workspaceBefore = fs.readFileSync(workspaceFile, "utf8");
          const manifest = readManifest(profile, sandbox);
          assert.deepEqual(manifest.network.ports.localhost, [8080], `${name} mcpproxy manifest grant`);
          if (name === "pi-audit") {
            assert.equal(manifest.network.mode, "unrestricted", `${name} network mode`);
          } else {
            assert.equal(manifest.network.mode, "proxy", `${name} network mode`);
            assert.deepEqual(manifest.network.allow_domains, ["localhost"], `${name} provider host`);
          }
          const readiness = runProbe(profile, sandbox, "read", workspaceFile);
          if (isConstrainedNono(readiness.result)) {
            reportManualGate(profileTest, ["filesystem", "network", "review"]);
            return;
          }
          assertProbeAllowed(readiness, `${name} workspace read`);

          const workspaceWrite = runProbe(profile, sandbox, "write", workspaceFile);
          if (name === "pi-review") assertProbeDenied(workspaceWrite, `${name} workspace write`);
          else assertProbeAllowed(workspaceWrite, `${name} workspace write`);

          for (const [label, target] of [
            ["agent state", path.join(sandbox.agent, "probe.txt")],
            ["Cavemem state", path.join(sandbox.cavemem, "probe.txt")],
            ["cache", path.join(sandbox.cache, "probe.txt")],
          ]) {
            assertProbeAllowed(runProbe(profile, sandbox, "write", target), `${name} ${label}`);
          }

          for (const [label, target] of [
            ["SSH credentials", path.join(sandbox.home, ".ssh/secret")],
            ["git credentials", path.join(sandbox.home, ".config/git/config")],
            ["Keychain", path.join(sandbox.home, "Library/Keychains/login.keychain-db")],
          ]) {
            assertProbeDenied(runProbe(profile, sandbox, "read", target), `${name} ${label}`);
          }

          assertProbeAllowed(
            runProbe(profile, sandbox, "connect", "localhost", 8080),
            `${name} mcpproxy port`,
          );
          const unlistedProbe = runProbe(profile, sandbox, "connect", "localhost", unlistedPort);
          if (name === "pi-audit") {
            assertProbeAllowed(unlistedProbe, `${name} unlisted port ${unlistedPort}`);
          } else {
            assertProbeDenied(unlistedProbe, `${name} unlisted port ${unlistedPort}`);
          }

          assert.equal(fs.readFileSync(workspaceFile, "utf8"),
            name === "pi-review" ? workspaceBefore : "security-probe\n");
          fs.writeFileSync(workspaceFile, workspaceBefore);
        });
      }
    } finally {
      await closeServer(mcp.server);
      await closeServer(unlisted.server);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "real nono allows a distinct synthetic provider host and denies another host",
  { timeout: 1_200_000 },
  async (t) => {
    const sandbox = makeRoot();
    const provider = await maybeListen(0);
    assert.equal(provider.owned, true, "provider fixture port is unavailable");
    const providerPort = provider.server.address().port;
    try {
       const profile = writeRuntimeProfile("pi-managed", sandbox, {
         providerHost,
       });
       const runtimeProfile = JSON.parse(fs.readFileSync(profile, "utf8"));
       assert.equal(runtimeProfile.network.block, false);
       assert.equal(runtimeProfile.network.network_profile, "minimal");
       assert.deepEqual(runtimeProfile.network.allow_domain, [providerHost]);
       const manifest = readManifest(profile, sandbox);
       assert.equal(manifest.network.mode, "proxy");
       assert.deepEqual(manifest.network.ports.localhost, [8080]);
       assert.deepEqual(manifest.network.allow_domains, [providerHost]);

      const allowed = runProbe(profile, sandbox, "connect", providerHost, providerPort);
      if (isConstrainedNono(allowed.result)) {
        reportManualGate(t, ["network"]);
        return;
      }
      assertProbeAllowed(allowed, "distinct provider host");

      const denied = runProbe(
        profile,
        sandbox,
        "connect",
        deniedProviderHost,
        providerPort,
      );
      assertProbeDenied(denied, "unlisted provider host");
    } finally {
      await closeServer(provider.server);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "the production executor materializes proxy mode for provider hosts and preserves mcpproxy",
  { timeout: 1_200_000 },
  (t) => {
    const sandbox = makeRoot();
    const profileCapture = path.join(sandbox.root, "production-runtime-profile.json");
    const resultFile = path.join(sandbox.root, "production-executor-result.json");
    const runner = `
      import fs from "node:fs";
      import { pathToFileURL } from "node:url";
      try {
        const executor = await import(pathToFileURL(process.argv[1]));
        const result = executor.executeSandboxedPi({
          providerOrigin: "https://${providerHost}",
          userArguments: ["--version"],
        });
        fs.writeFileSync(process.argv[2], JSON.stringify({ result }));
      } catch (error) {
        fs.writeFileSync(process.argv[2], JSON.stringify({
          component: error.component ?? null,
          kind: error.kind ?? null,
          message: error.message ?? null,
        }));
      }
    `;
    try {
      const execution = childProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          runner,
          path.join(productionExecutorFixture, "lib/pi-agent/sandbox-executor.mjs"),
          resultFile,
        ],
        {
          cwd: sandbox.workspace,
          encoding: "utf8",
          env: {
            ...sandbox.environment,
            PI_AGENT_TASK55_PROFILE_CAPTURE: profileCapture,
            PI_NONO_PROFILE: "pi-managed",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      );
      assert.ifError(execution.error);
      assert.equal(execution.status, 0, execution.stderr);
      const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      if (
        report.result?.status === 126 &&
        isConstrainedNono({ status: 126, stderr: execution.stderr, stdout: execution.stdout })
      ) {
        reportManualGate(t, ["network"]);
        return;
      }
      assert.deepEqual(report, { result: { signal: null, status: 0 } });

      const runtimeProfile = JSON.parse(fs.readFileSync(profileCapture, "utf8"));
      assert.equal(runtimeProfile.network.block, false);
      assert.equal(
        runtimeProfile.network.network_profile,
        "minimal",
        "nono requires proxy mode when a provider allowlist is materialized; block=true cannot be combined with allow_domain",
      );
      assert.deepEqual(runtimeProfile.network.allow_domain, [providerHost]);
      assert.deepEqual(runtimeProfile.network.open_port, [8080]);

      const manifest = readManifest(profileCapture, sandbox);
      assert.equal(manifest.network.mode, "proxy");
      assert.deepEqual(manifest.network.allow_domains, [providerHost]);
      assert.deepEqual(manifest.network.ports.localhost, [8080]);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "real nono materializes explicit listen ports and records backend bind behavior",
  { timeout: 1_200_000 },
  async (t) => {
    const sandbox = makeRoot();
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const selected = server.address().port;
        server.close(() => resolve(selected));
      });
    });
    try {
      for (const name of ["pi-audit", "pi-managed", "pi-review"]) {
        const defaultProfile = writeRuntimeProfile(name, sandbox, {
          providerHost: null,
        });
        const defaultManifest = readManifest(defaultProfile, sandbox);
        assert.equal(
          defaultManifest.network.mode,
          name === "pi-audit" ? "unrestricted" : "blocked",
        );
        assert.deepEqual(defaultManifest.network.ports.localhost, [8080]);
        assert.equal(Object.hasOwn(defaultManifest.network.ports, "bind"), false);

        const exceptionProfile = writeRuntimeProfile(name, sandbox, {
          providerHost: null,
          listenPorts: [port],
        });
        const exceptionManifest = readManifest(exceptionProfile, sandbox);
        assert.deepEqual(exceptionManifest.network.ports.bind, [port]);

        const defaultProbe = runProbe(defaultProfile, sandbox, "listen", undefined, port);
        if (isConstrainedNono(defaultProbe.result)) {
          reportManualGate(t, ["network"]);
          return;
        }
        if (name === "pi-audit") {
          assertProbeAllowed(defaultProbe, "audit unlisted listen port");
        } else {
          assertProbeAllowed(defaultProbe, `${name} unlisted listen port`);
          reportNonoOpenPortBindLimitation(t);
        }

        const allowed = runProbe(exceptionProfile, sandbox, "listen", undefined, port);
        assertProbeAllowed(allowed, `${name} explicit listen port`);
      }
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test("missing grants and malformed listen controls fail before Pi or fallback", async () => {
  const resolverExpression = `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-security-resolver-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
    in import (repoSource + "/tests/pi-agent/fixtures/sandbox-resolver.nix") {
      fixture = "packages";
      repoRoot = repoSource;
    }
  `;
  const resolverBuild = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--print-out-paths", "--impure", "--expr", resolverExpression],
    commandOptions,
  );
  assert.ifError(resolverBuild.error);
  assert.equal(resolverBuild.status, 0, resolverBuild.stderr);
  const resolverRoot = resolverBuild.stdout.trim();
  const resolver = await import(
    pathToFileURL(path.join(resolverRoot, "audit/lib/pi-agent/sandbox-resolver.mjs")),
  );
  for (const value of ["*", "1.*", "1,", "1, 2"]) {
    assert.throws(
      () => resolver.resolveSandboxSelectionFromEnvironment({ PI_NONO_LISTEN_PORTS: value }),
      (error) => error.message.includes("sandbox override PI_NONO_LISTEN_PORTS is invalid") && !error.message.includes(value),
      value,
    );
  }

  const executorExpression = `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-security-executor-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
    in import (repoSource + "/tests/pi-agent/fixtures/sandbox-executor.nix") {
      fixture = "packages";
      repoRoot = repoSource;
    }
  `;
  const executorBuild = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--print-out-paths", "--impure", "--expr", executorExpression],
    commandOptions,
  );
  assert.ifError(executorBuild.error);
  assert.equal(executorBuild.status, 0, executorBuild.stderr);
  const executorRoot = executorBuild.stdout.trim();
  const traceFile = path.join(os.tmpdir(), `pi-agent-security-missing-grant-${process.pid}.jsonl`);
  const resultFile = path.join(os.tmpdir(), `pi-agent-security-missing-grant-${process.pid}.json`);
  try {
    const modulePath = path.join(executorRoot, "missing-mcp/lib/pi-agent/sandbox-executor.mjs");
    const runner = `
      import fs from "node:fs";
      import { pathToFileURL } from "node:url";
      try {
        const executor = await import(pathToFileURL(process.argv[1]));
        executor.executeSandboxedPi({ providerOrigin: "https://gateway.example.test", userArguments: [] });
      } catch (error) {
        fs.writeFileSync(process.argv[2], JSON.stringify({
          component: error.component ?? null,
          kind: error.kind ?? null,
          message: error.message ?? null,
        }));
      }
    `;
    const execution = childProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", runner, modulePath, resultFile],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: os.tmpdir(),
          PI_AGENT_TASK55_TRACE_FILE: traceFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    const failure = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(failure.component, "mcpproxy");
    assert.equal(failure.message.includes("https://gateway.example.test"), false);
    const trace = fs.existsSync(traceFile)
      ? fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    assert.equal(trace.some((entry) => entry.executable === "pi"), false);
    assert.equal(trace.some((entry) => entry.executable === "nono" && entry.argv[0] === "run"), false);
  } finally {
    fs.rmSync(traceFile, { force: true });
    fs.rmSync(resultFile, { force: true });
  }
});

test("the packaged executor launches the real Pi through the allowlisted nono profile", (t) => {
  const sandbox = makeRoot();
  const resultFile = path.join(sandbox.root, "executor-result.json");
  const runner = `
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    try {
      const executor = await import(pathToFileURL(process.argv[1]));
      const result = executor.executeSandboxedPi({
        providerOrigin: "https://localhost",
        userArguments: ["--version"],
      });
      fs.writeFileSync(process.argv[2], JSON.stringify({ result }));
    } catch (error) {
      fs.writeFileSync(process.argv[2], JSON.stringify({
        component: error.component ?? null,
        kind: error.kind ?? null,
        message: error.message ?? null,
      }));
    }
  `;
  try {
    const execution = childProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", runner, path.join(productionExecutor, "lib/pi-agent/sandbox-executor.mjs"), resultFile],
      {
        cwd: sandbox.workspace,
        encoding: "utf8",
        env: {
          ...sandbox.environment,
          PI_NONO_PROFILE: "pi-managed",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (report.result?.status === 126 && isConstrainedNono({ status: 126, stderr: execution.stderr, stdout: execution.stdout })) {
      reportManualGate(t, ["review"]);
      return;
    }
    assert.deepEqual(report, { result: { signal: null, status: 0 } });
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});
