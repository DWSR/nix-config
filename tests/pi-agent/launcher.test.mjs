import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { inspect } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/launcher.nix";
const launcherModuleRelativePath = "lib/pi-agent/launcher.mjs";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 600_000,
};
const adminSentinel = "task-5-8-mcpproxy-admin-sentinel";
const ambientSentinels = [
  "task-5-8-ambient-openai-sentinel",
  "task-5-8-ambient-anthropic-sentinel",
  "task-5-8-ambient-mcpproxy-sentinel",
];
const validatedStages = [
  "resolver",
  "provider-projection",
  "reconciliation",
  "package",
  "profile",
  "mcpproxy",
  "cavemem",
  "extensions",
  "validator",
];
const successfulShopifyTrace = [
  "resolver:unlocked",
  "resolver-token:unlocked",
  "resolver-base:unlocked",
  "projection:locked",
  "profile:committed",
  "profile:validated",
  "mcpproxy:committed",
  "cavemem:committed",
  "extensions:committed",
  "validator:committed",
];

let fixtureRoot;
let launchers;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-launcher-tests";
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
    { ...commandOptions, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1, result.stdout);
  return outputs[0];
}

async function loadLauncher(name) {
  const root = path.join(fixtureRoot, name);
  const modulePath = path.join(root, launcherModuleRelativePath);
  assert.equal(fs.existsSync(modulePath), true, modulePath);
  return {
    root,
    modulePath,
    source: fs.readFileSync(modulePath, "utf8"),
    module: await import(pathToFileURL(modulePath)),
  };
}

before(
  async () => {
    fixtureRoot = buildFixture("packages");
    const names = [
      "success",
      "personal",
      "resolver-failure",
      "projection-failure",
      "package-failure",
      "profile-failure",
      "profile-validation-failure",
      "mcpproxy-failure",
      "cavemem-failure",
      "extensions-failure",
      "extensions-one-unavailable",
      "validator-failure",
    ];
    launchers = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, await loadLauncher(name)]),
      ),
    );
  },
  { timeout: 600_000 },
);

function writePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writePrivateJson(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createState(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-launcher-"));
  const agentDir = path.join(root, "agent");
  const cavememDataDir = path.join(root, "cavemem");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cavememDataDir, { recursive: true, mode: 0o700 });
  const settings = {
    theme: "user-theme",
    packages: ["user-package"],
    defaultProjectTrust: "always",
    unrelated: { nested: ["preserve", 58] },
  };
  const models = {
    providers: {
      local: {
        baseUrl: "https://local.example.test/v1",
        api: "openai-completions",
        headers: { "X-User-Header": "preserve" },
      },
    },
    trust: { project: true },
    packages: ["user-model-package"],
    sessions: { retained: true },
  };
  if (options.invalidSettings) {
    writePrivate(path.join(agentDir, "settings.json"), '{"invalid":');
  } else {
    writePrivateJson(path.join(agentDir, "settings.json"), settings);
  }
  writePrivateJson(path.join(agentDir, "models.json"), models);
  writePrivateJson(
    path.join(agentDir, "auth.json"),
    options.auth ?? { custom: { type: "api_key", key: "unrelated-auth" } },
  );
  writePrivate(
    path.join(root, "pi-agent-launcher-base.txt"),
    "https://gateway.example.test/path\n",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    agentDir,
    cavememDataDir,
    settings,
    models,
    traceFile: path.join(root, "pi-agent-launcher-trace.log"),
    piMarker: path.join(root, "pi-was-launched"),
  };
}

async function withLaunchEnvironment(state, operation, overrides = {}) {
  const values = {
    TMPDIR: state.root,
    HOME: path.join(state.root, "home"),
    XDG_CACHE_HOME: path.join(state.root, "home/.cache"),
    XDG_CONFIG_HOME: path.join(state.root, "home/.config"),
    XDG_DATA_HOME: path.join(state.root, "home/.local/share"),
    XDG_STATE_HOME: path.join(state.root, "home/.local/state"),
    OPENAI_API_KEY: ambientSentinels[0],
    ANTHROPIC_API_KEY: ambientSentinels[1],
    MCPPROXY_API_KEY: ambientSentinels[2],
    NO_COLOR: "1",
    ...overrides,
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
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

function launchInput(state, extra = {}) {
  return {
    agentDir: state.agentDir,
    cavememDataDir: state.cavememDataDir,
    ...extra,
  };
}

function readTrace(state) {
  if (!fs.existsSync(state.traceFile)) return [];
  return fs
    .readFileSync(state.traceFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
}

function textTree(root) {
  const chunks = [];
  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name));
      }
    } else if (stat.isSymbolicLink()) {
      chunks.push(fs.readlinkSync(target));
    } else {
      chunks.push(fs.readFileSync(target).toString("utf8"));
    }
  }
  visit(root);
  return chunks.join("\n");
}

function snapshotAgentState(state) {
  return fs
    .readdirSync(state.agentDir)
    .sort()
    .map((name) => ({
      name,
      bytes: fs
        .readFileSync(path.join(state.agentDir, name))
        .toString("base64"),
    }));
}

function assertNoPi(state) {
  assert.equal(fs.existsSync(state.piMarker), false);
}

function assertNoReconcileResidue(state) {
  assert.deepEqual(
    fs
      .readdirSync(state.agentDir)
      .filter(
        (name) =>
          name === ".pi-agent-reconcile.lock" ||
          name === ".pi-agent-reconcile-transaction.json" ||
          name === "settings.json.lock" ||
          name.startsWith(".pi-agent-reconcile-"),
      ),
    [],
  );
}

function assertNoValues(text, values) {
  for (const value of values) {
    assert.equal(
      text.includes(value),
      false,
      `sensitive value crossed launcher boundary: ${value}`,
    );
  }
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

async function captureFailure(launcher, state, overrides = {}) {
  try {
    await withLaunchEnvironment(
      state,
      () => launcher.module.prepareManagedLaunch(launchInput(state)),
      overrides,
    );
  } catch (error) {
    return error;
  }
  assert.fail("managed launch preparation unexpectedly succeeded");
}

function assertSafeFailure(error, expectedComponent, forbidden = []) {
  assert.equal(error?.name, "ManagedLaunchError");
  assert.equal(error?.component, expectedComponent);
  assert.equal(typeof error?.recovery, "string");
  assert.ok(error.recovery.length > 0 && error.recovery.length < 512);
  const visible = `${error.message}\n${JSON.stringify(error)}`;
  assertNoValues(visible, [adminSentinel, ...ambientSentinels, ...forbidden]);
  assert.doesNotMatch(
    visible,
    /task-5-8-runtime-token-|hidden raw (?:content|output)/,
  );
}

test("the launcher package exposes one closed preparation API and no Task 5.9 execution path", () => {
  for (const launcher of Object.values(launchers)) {
    assert.deepEqual(Object.keys(launcher.module), ["prepareManagedLaunch"]);
    assert.equal(launcher.module.prepareManagedLaunch.length, 1);
    assert.doesNotMatch(launcher.source, /__PI_AGENT_LAUNCHER_/);
    assert.doesNotMatch(
      launcher.source,
      /executeSandboxedPi|nono\s+run|managed-final-args|childPiEnvironment\s*:/,
    );
    assert.doesNotMatch(
      launcher.source,
      /spawn(?:Sync)?\(\s*PI_EXECUTABLE|exec(?:File|Sync)?\(\s*PI_EXECUTABLE/,
    );
    assert.doesNotMatch(
      launcher.source,
      /TASK_58|LAUNCHER_ENABLED|feature is disabled|TODO|FIXME/,
    );
  }
});

test("Shopify success follows the exact fail-before-TUI order and returns a closed Task 5.9 handoff", async (t) => {
  const state = createState(t);
  const handoff = await withLaunchEnvironment(state, () =>
    launchers.success.module.prepareManagedLaunch(launchInput(state)),
  );

  assert.deepEqual(readTrace(state), successfulShopifyTrace);
  assert.deepEqual(Object.keys(handoff).sort(), [
    "agentDir",
    "cavememDataDir",
    "generation",
    "providerMode",
    "reconciliation",
    "runtimeSecrets",
    "sandboxSelection",
    "schemaVersion",
    "validatedStages",
  ]);
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.providerMode, "shopify-gateway");
  assert.equal(handoff.agentDir, state.agentDir);
  assert.equal(handoff.cavememDataDir, state.cavememDataDir);
  assert.deepEqual(handoff.validatedStages, validatedStages);
  assert.deepEqual(handoff.reconciliation.changed, [
    "models.json",
    "settings.json",
  ]);
  assert.equal(handoff.runtimeSecrets.mode, "shopify-gateway");
  assert.match(
    handoff.runtimeSecrets.launchId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assertDeepFrozen(handoff);
  assert.throws(() => JSON.stringify(handoff), /not serializable/);
  assert.doesNotMatch(
    inspect(handoff),
    /task-5-8-runtime-token-|PI_AGENT_LAUNCH_ID/,
  );
  const runtimeSecretDescriptor = Object.getOwnPropertyDescriptor(
    handoff,
    "runtimeSecrets",
  );
  assert.equal("value" in runtimeSecretDescriptor, false);
  assert.equal(typeof runtimeSecretDescriptor.get, "function");
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(state.agentDir, "ownership.json"), "utf8"),
    ).transaction,
    "committed",
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(state.agentDir, "settings.json"), "utf8"),
    ).theme,
    state.settings.theme,
  );
  const models = JSON.parse(
    fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8"),
  );
  assert.deepEqual(models.providers.local, state.models.providers.local);
  assert.equal(models.providers.openai.apiKey, "${SHOPIFY_PI_TOKEN}");
  assert.equal(
    models.providers.openai.headers["pi-agent-session-id"],
    "${PI_AGENT_LAUNCH_ID}",
  );
  assertNoValues(textTree(state.agentDir), [
    handoff.runtimeSecrets.token,
    handoff.runtimeSecrets.launchId,
    adminSentinel,
    ...ambientSentinels,
  ]);
  assertNoValues(fs.readFileSync(state.traceFile, "utf8"), [
    handoff.runtimeSecrets.token,
    handoff.runtimeSecrets.launchId,
    adminSentinel,
    ...ambientSentinels,
  ]);
  assertNoReconcileResidue(state);
  assertNoPi(state);
});

test("personal mode permits Pi-owned authentication and invokes no Shopify projection handoff", async (t) => {
  const personalAuth = "task-5-8-personal-pi-auth-sentinel";
  const state = createState(t, {
    auth: { openai: { type: "api_key", key: personalAuth } },
  });
  const beforeAuth = fs.readFileSync(
    path.join(state.agentDir, "auth.json"),
    "utf8",
  );
  const handoff = await withLaunchEnvironment(state, () =>
    launchers.personal.module.prepareManagedLaunch(launchInput(state)),
  );

  assert.deepEqual(readTrace(state), [
    "resolver:unlocked",
    "profile:committed",
    "profile:validated",
    "mcpproxy:committed",
    "cavemem:committed",
    "extensions:committed",
    "validator:committed",
  ]);
  assert.equal(handoff.providerMode, "personal");
  assert.equal(handoff.runtimeSecrets.mode, "personal");
  assert.deepEqual(handoff.runtimeSecrets.rootPiEnvironment, {});
  assert.equal(
    fs.readFileSync(path.join(state.agentDir, "auth.json"), "utf8"),
    beforeAuth,
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(
        fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8"),
      ).providers,
      "openai",
    ),
    false,
  );
  assertNoReconcileResidue(state);
  assertNoPi(state);
});

test("probe environments drop allowed values that duplicate ambient credentials", async (t) => {
  const state = createState(t);
  const handoff = await withLaunchEnvironment(
    state,
    () => launchers.success.module.prepareManagedLaunch(launchInput(state)),
    { HOME: path.join(state.root, ambientSentinels[0], "home") },
  );

  assert.equal(handoff.providerMode, "shopify-gateway");
  assert.deepEqual(readTrace(state), successfulShopifyTrace);
  assertNoValues(fs.readFileSync(state.traceFile, "utf8"), ambientSentinels);
  assertNoPi(state);
});

test("Shopify auth conflicts expose only the selected provider ID and release the lock", async (t) => {
  const authSecret = "task-5-8-conflicting-auth-secret-sentinel";
  const state = createState(t, {
    auth: {
      custom: { type: "api_key", key: "unrelated" },
      openai: { type: "api_key", key: authSecret },
    },
  });
  const before = snapshotAgentState(state);
  const error = await captureFailure(launchers.success, state);

  assertSafeFailure(error, "provider-auth", [authSecret]);
  assert.equal(error.providerId, "openai");
  assert.deepEqual(Object.keys(error).sort(), [
    "component",
    "providerId",
    "recovery",
  ]);
  assert.deepEqual(readTrace(state), successfulShopifyTrace.slice(0, 4));
  assert.deepEqual(snapshotAgentState(state), before);
  assertNoReconcileResidue(state);
  assertNoPi(state);
});

test("every stage failure suppresses all later probes, the handoff, and Pi", async (t) => {
  const cases = [
    {
      name: "resolver",
      launcher: "resolver-failure",
      component: "provider-resolver",
      trace: successfulShopifyTrace.slice(0, 2),
      unchanged: true,
    },
    {
      name: "projection",
      launcher: "projection-failure",
      component: "provider-projection",
      trace: successfulShopifyTrace.slice(0, 4),
      unchanged: true,
    },
    {
      name: "state",
      launcher: "success",
      component: "state",
      trace: successfulShopifyTrace.slice(0, 3),
      invalidSettings: true,
      unchanged: true,
    },
    {
      name: "package",
      launcher: "package-failure",
      component: "package",
      trace: successfulShopifyTrace.slice(0, 4),
    },
    {
      name: "profile",
      launcher: "profile-failure",
      component: "profile",
      trace: successfulShopifyTrace.slice(0, 5),
    },
    {
      name: "profile-validation",
      launcher: "profile-validation-failure",
      component: "profile",
      trace: successfulShopifyTrace.slice(0, 5).concat("profile:validated"),
    },
    {
      name: "mcpproxy",
      launcher: "mcpproxy-failure",
      component: "mcpproxy",
      trace: successfulShopifyTrace.slice(0, 7),
    },
    {
      name: "cavemem",
      launcher: "cavemem-failure",
      component: "cavemem",
      trace: successfulShopifyTrace.slice(0, 8),
    },
    {
      name: "extensions",
      launcher: "extensions-failure",
      component: "extensions",
      trace: successfulShopifyTrace.slice(0, 9),
    },
    {
      name: "validator",
      launcher: "validator-failure",
      component: "validator",
      trace: successfulShopifyTrace.slice(0, 10),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (subtest) => {
      const state = createState(subtest, {
        invalidSettings: fixtureCase.invalidSettings,
      });
      const before = snapshotAgentState(state);
      const error = await captureFailure(
        launchers[fixtureCase.launcher],
        state,
      );

      assertSafeFailure(error, fixtureCase.component);
      if (fixtureCase.name === "resolver") {
        assert.equal(error.operation, "token");
      }
      assert.deepEqual(readTrace(state), fixtureCase.trace);
      if (fixtureCase.unchanged) {
        assert.deepEqual(snapshotAgentState(state), before);
      } else {
        assert.equal(
          JSON.parse(
            fs.readFileSync(
              path.join(state.agentDir, "ownership.json"),
              "utf8",
            ),
          ).transaction,
          "committed",
        );
      }
      assertNoReconcileResidue(state);
      assertNoPi(state);
    });
  }
});

test("fixed diagnostic labels survive a credential collision", async (t) => {
  const state = createState(t);
  let error;
  try {
    await withLaunchEnvironment(
      state,
      () =>
        launchers["profile-validation-failure"].module.prepareManagedLaunch(
          launchInput(state),
        ),
      { OPENAI_API_KEY: "profile" },
    );
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.name, "ManagedLaunchError");
  assert.equal(error.component, "profile");
  assert.equal(
    error.recovery,
    "select a valid managed profile or use the documented rollback",
  );
  assert.match(error.message, /Managed launch failed: profile\./);
  assert.doesNotMatch(error.message, /\[REDACTED\]/);
  assertNoValues(`${error.message}\n${JSON.stringify(error)}`, [
    ...ambientSentinels.slice(1),
    adminSentinel,
  ]);
  assertNoPi(state);
});

test("invalid sandbox overrides preserve accepted-values diagnostics before Pi", async (t) => {
  const cases = [
    {
      name: "state",
      override: {
        PI_NONO: "hostile-state-sentinel",
        PI_NONO_PROFILE: "",
        PI_NONO_LISTEN_PORTS: "",
      },
      diagnostic:
        "sandbox override PI_NONO is invalid; accepted values: disabled, audit, enforced",
    },
    {
      name: "profile",
      override: {
        PI_NONO: "audit",
        PI_NONO_PROFILE: "hostile-profile-sentinel",
        PI_NONO_LISTEN_PORTS: "",
      },
      diagnostic:
        "sandbox override PI_NONO_PROFILE is invalid; accepted values: pi-audit, pi-managed, pi-review",
    },
    {
      name: "listen ports",
      override: {
        PI_NONO: "audit",
        PI_NONO_PROFILE: "",
        PI_NONO_LISTEN_PORTS: "hostile-port-sentinel",
      },
      diagnostic:
        "sandbox override PI_NONO_LISTEN_PORTS is invalid; accepted format: comma-separated canonical decimal ports from 1 through 65535",
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (subtest) => {
      const state = createState(subtest);
      const error = await captureFailure(
        launchers.success,
        state,
        fixtureCase.override,
      );

      assertSafeFailure(error, "profile", [
        ...Object.values(fixtureCase.override).filter((value) =>
          value.startsWith("hostile-"),
        ),
      ]);
      assert.equal(error.diagnostic, fixtureCase.diagnostic);
      assert.match(error.message, new RegExp(fixtureCase.diagnostic));
      assert.doesNotMatch(error.message, /hostile-(?:state|profile|port)-sentinel/);
      assert.doesNotMatch(readTrace(state).join("\n"), /profile:validated/);
      assertNoPi(state);
    });
  }
});

test("an unavailable extension is identified by the fixed manifest name", async (t) => {
  const state = createState(t);
  const error = await captureFailure(
    launchers["extensions-one-unavailable"],
    state,
  );

  assertSafeFailure(error, "extensions");
  assert.equal(error.extensionName, "backgroundTasks");
  assert.equal(error.diagnostic, "required extension backgroundTasks is unavailable");
  assert.match(error.message, /backgroundTasks/);
  assertNoPi(state);
});

test("closed invocation rejects caller-selected modules and runtime objects before inspection", async (t) => {
  const state = createState(t);
  let trapCalls = 0;
  const injected = new Proxy(Object.freeze({}), {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("caller-controlled module sentinel");
    },
  });
  const before = snapshotAgentState(state);

  await assert.rejects(
    withLaunchEnvironment(state, () =>
      launchers.success.module.prepareManagedLaunch(
        launchInput(state, {
          resolverModule: injected,
          runtimeSecrets: injected,
          trust: injected,
        }),
      ),
    ),
    (error) => {
      assertSafeFailure(error, "invocation", [
        "caller-controlled module sentinel",
      ]);
      return true;
    },
  );
  assert.equal(trapCalls, 0);
  assert.deepEqual(readTrace(state), []);
  assert.deepEqual(snapshotAgentState(state), before);
  assertNoPi(state);
});

test("equal complete concurrent launches use distinct secrets but one commit and one no-op", async (t) => {
  const state = createState(t);
  const [first, second] = await withLaunchEnvironment(state, () =>
    Promise.all([
      launchers.success.module.prepareManagedLaunch(launchInput(state)),
      launchers.success.module.prepareManagedLaunch(launchInput(state)),
    ]),
  );

  assert.notEqual(first.runtimeSecrets.token, second.runtimeSecrets.token);
  assert.notEqual(
    first.runtimeSecrets.launchId,
    second.runtimeSecrets.launchId,
  );
  assert.deepEqual(
    [first.reconciliation.changed, second.reconciliation.changed].sort(
      (left, right) => right.length - left.length,
    ),
    [["models.json", "settings.json"], []],
  );
  const persisted = textTree(state.agentDir);
  assertNoValues(persisted, [
    first.runtimeSecrets.token,
    first.runtimeSecrets.launchId,
    second.runtimeSecrets.token,
    second.runtimeSecrets.launchId,
    adminSentinel,
    ...ambientSentinels,
  ]);
  assertNoValues(fs.readFileSync(state.traceFile, "utf8"), [
    first.runtimeSecrets.token,
    first.runtimeSecrets.launchId,
    second.runtimeSecrets.token,
    second.runtimeSecrets.launchId,
    adminSentinel,
    ...ambientSentinels,
  ]);
  const modelsBytes = fs.readFileSync(
    path.join(state.agentDir, "models.json"),
    "utf8",
  );
  assert.equal(modelsBytes.includes("${SHOPIFY_PI_TOKEN}"), true);
  assert.equal(modelsBytes.includes("${PI_AGENT_LAUNCH_ID}"), true);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(state.agentDir, "ownership.json"), "utf8"),
    ).transaction,
    "committed",
  );
  assertNoReconcileResidue(state);
  assertNoPi(state);
});

test("same-generation launches with a different base fail as provider projection conflict", async (t) => {
  const state = createState(t);
  await withLaunchEnvironment(state, () =>
    launchers.success.module.prepareManagedLaunch(launchInput(state)),
  );
  fs.writeFileSync(state.traceFile, "", { mode: 0o600 });
  writePrivate(
    path.join(state.root, "pi-agent-launcher-base.txt"),
    "https://different-gateway.example.test/path\n",
  );
  const beforeModels = fs.readFileSync(
    path.join(state.agentDir, "models.json"),
    "utf8",
  );

  const error = await captureFailure(launchers.success, state);

  assertSafeFailure(error, "provider-projection");
  assert.equal(error.providerId, "anthropic");
  assert.deepEqual(readTrace(state), successfulShopifyTrace.slice(0, 4));
  assert.equal(
    fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8"),
    beforeModels,
  );
  assertNoReconcileResidue(state);
  assertNoPi(state);
});
