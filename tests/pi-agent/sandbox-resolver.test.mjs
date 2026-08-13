import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/sandbox-resolver.nix";
const resolverRelativePath = "lib/pi-agent/sandbox-resolver.mjs";
const catalogRelativePath = "share/pi-agent/nono/catalog.json";
const defaultRelativePath = "share/pi-agent/sandbox/default.json";
const designPath = path.join(
  repoRoot,
  ".kiro/specs/pi-agent-integration/design.md",
);
const states = ["disabled", "audit", "enforced"];
const profiles = ["pi-audit", "pi-managed", "pi-review"];
const reviewTools = ["read", "grep", "find", "ls"];
const listenPortFormat =
  "comma-separated canonical decimal ports from 1 through 65535";
const invocationError = "sandbox resolver invocation rejected";
const contractError = "sandbox resolver contract validation failed";
const environmentError = "sandbox environment input rejected";
const stateError =
  "sandbox override PI_NONO is invalid; accepted values: disabled, audit, enforced";
const profileError =
  "sandbox override PI_NONO_PROFILE is invalid; accepted values: pi-audit, pi-managed, pi-review";
const portError =
  `sandbox override PI_NONO_LISTEN_PORTS is invalid; accepted format: ${listenPortFormat}`;
const disabledConflictError =
  "sandbox disabled state conflicts with enabled-only overrides; accepted recovery: unset PI_NONO_PROFILE and PI_NONO_LISTEN_PORTS, or set PI_NONO to audit or enforced";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let fixtureRoot;
let packages;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-sandbox-resolver-tests";
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
  const resolverPath = path.join(root, resolverRelativePath);
  const catalogPath = path.join(root, catalogRelativePath);
  const defaultPath = path.join(root, defaultRelativePath);
  for (const requiredPath of [resolverPath, catalogPath, defaultPath]) {
    assert.equal(fs.existsSync(requiredPath), true, requiredPath);
  }
  return {
    root,
    resolverPath,
    resolverSource: fs.readFileSync(resolverPath, "utf8"),
    catalogPath,
    defaultPath,
    resolver: await import(pathToFileURL(resolverPath)),
  };
}

before(
  async () => {
    fixtureRoot = buildFixture("packages");
    const loaded = await Promise.all([
      ...states.map(loadPackage),
      loadPackage("tampered-catalog"),
      loadPackage("tampered-default"),
    ]);
    packages = Object.fromEntries(
      [...states, "tampered-catalog", "tampered-default"].map((name, index) => [
        name,
        loaded[index],
      ]),
    );
  },
  { timeout: 600_000 },
);

function environment(overrides = {}) {
  return Object.freeze({ ...overrides });
}

function expectedSelection({
  state,
  profile,
  listenPorts = [],
  stateSource,
  profileSource,
  listenPortsSource = "none",
  rollback = false,
  disableReason = null,
}) {
  return {
    schemaVersion: 1,
    state,
    profile,
    listenPorts,
    piTools: profile === "pi-review" ? reviewTools : null,
    source: {
      state: stateSource,
      profile: profileSource,
      listenPorts: listenPortsSource,
    },
    rollback,
    disableReason,
    accepted: {
      states,
      profiles,
      listenPorts: listenPortFormat,
    },
  };
}

function resolve(packageValue, overrides = {}) {
  return packageValue.resolver.resolveSandboxSelectionFromEnvironment(
    environment(overrides),
  );
}

function captureFailure(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("sandbox resolver unexpectedly succeeded");
}

function assertFailure(operation, message, sentinels = []) {
  const error = captureFailure(operation);
  assert.equal(error.message, message);
  assert.deepEqual(Object.keys(error), []);
  for (const sentinel of sentinels) {
    assert.equal(error.message.includes(sentinel), false, error.message);
  }
  return error;
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, JSON.stringify(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function withProcessEnvironment(overrides, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(
      name,
      Object.hasOwn(process.env, name) ? process.env[name] : undefined,
    );
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

test("packages bake the real Task 2.6 catalog and one immutable host default", () => {
  for (const state of states) {
    const packageValue = packages[state];
    const catalog = JSON.parse(fs.readFileSync(packageValue.catalogPath, "utf8"));
    const defaultArtifact = JSON.parse(
      fs.readFileSync(packageValue.defaultPath, "utf8"),
    );

    assert.equal(catalog.schemaVersion, 1);
    assert.deepEqual(Object.keys(catalog.profiles).sort(), profiles);
    assert.deepEqual(defaultArtifact, { defaultState: state, schemaVersion: 1 });
    assert.deepEqual(Object.keys(packageValue.resolver).sort(), [
      "resolveSandboxSelection",
      "resolveSandboxSelectionFromEnvironment",
    ]);
    assert.match(packageValue.resolverSource, /[0-9a-f]{64}/);
    assert.doesNotMatch(packageValue.resolverSource, /__PI_AGENT_SANDBOX_/);
    assert.doesNotMatch(
      packageValue.resolverSource,
      /SANDBOX_RESOLVER_ENABLED|feature disabled/,
    );
    assert.doesNotMatch(
      packageValue.resolverSource,
      /node:child_process|child_process|spawn|execFile|execSync/,
    );
    assert.equal(fs.statSync(packageValue.resolverPath).mode & 0o222, 0);
    assert.equal(fs.existsSync(path.join(packageValue.root, "bin/nono")), true);
    assert.equal(fs.existsSync(path.join(packageValue.root, "bin/pi")), true);
  }
});

test("baked defaults and every PI_NONO transition select exact default profiles", () => {
  const defaults = {
    disabled: { profile: null, disableReason: "host-default" },
    audit: { profile: "pi-audit", disableReason: null },
    enforced: { profile: "pi-managed", disableReason: null },
  };

  for (const packageState of states) {
    const defaultExpected = defaults[packageState];
    assert.deepEqual(
      resolve(packages[packageState]),
      expectedSelection({
        state: packageState,
        profile: defaultExpected.profile,
        stateSource: "sandbox.defaultState",
        profileSource: packageState === "disabled" ? null : "state-default",
        disableReason: defaultExpected.disableReason,
      }),
    );
    assert.deepEqual(
      resolve(packages[packageState], { PI_NONO: "" }),
      expectedSelection({
        state: packageState,
        profile: defaultExpected.profile,
        stateSource: "sandbox.defaultState",
        profileSource: packageState === "disabled" ? null : "state-default",
        disableReason: defaultExpected.disableReason,
      }),
    );

    for (const overrideState of states) {
      const overrideExpected = defaults[overrideState];
      assert.deepEqual(
        resolve(packages[packageState], { PI_NONO: overrideState }),
        expectedSelection({
          state: overrideState,
          profile: overrideExpected.profile,
          stateSource: "PI_NONO",
          profileSource: overrideState === "disabled" ? null : "state-default",
          rollback: overrideState === "disabled",
          disableReason: overrideState === "disabled" ? "override" : null,
        }),
      );
    }
  }
});

test("enabled states accept only exact catalog profiles and freeze review tools", () => {
  for (const state of ["audit", "enforced"]) {
    for (const profile of profiles) {
      const selection = resolve(packages.disabled, {
        PI_NONO: state,
        PI_NONO_PROFILE: profile,
      });
      assert.deepEqual(
        selection,
        expectedSelection({
          state,
          profile,
          stateSource: "PI_NONO",
          profileSource: "PI_NONO_PROFILE",
        }),
      );
      assert.equal(selection.piTools === null || Object.isFrozen(selection.piTools), true);
    }
  }

  for (const profile of ["review", "PI-REVIEW", "pi-review ", "pi-unknown"]) {
    assertFailure(
      () => resolve(packages.audit, { PI_NONO_PROFILE: profile }),
      profileError,
    );
  }
});

test("disabled distinguishes a host default from explicit rollback", () => {
  const design = fs.readFileSync(designPath, "utf8");
  assert.match(design, /readonly listenPorts: readonly number\[\]/);

  const disabledDefault = resolve(packages.disabled);
  assert.equal(disabledDefault.rollback, false);
  assert.equal(disabledDefault.disableReason, "host-default");
  assert.equal(disabledDefault.source.state, "sandbox.defaultState");
  assert.equal(disabledDefault.profile, null);
  assert.equal(disabledDefault.piTools, null);
  assert.equal(Array.isArray(disabledDefault.listenPorts), true);
  assert.deepEqual(disabledDefault.listenPorts, []);
  assert.equal(Object.isFrozen(disabledDefault.listenPorts), true);
  assert.throws(() => disabledDefault.listenPorts.push(8080), TypeError);

  const explicitRollback = resolve(packages.enforced, { PI_NONO: "disabled" });
  assert.equal(explicitRollback.rollback, true);
  assert.equal(explicitRollback.disableReason, "override");
  assert.equal(explicitRollback.source.state, "PI_NONO");
  assert.equal(Array.isArray(explicitRollback.listenPorts), true);
  assert.deepEqual(explicitRollback.listenPorts, []);
  assert.equal(Object.isFrozen(explicitRollback.listenPorts), true);
});

test("disabled conflicts use one neutral finite diagnostic", () => {
  const cases = [
    [packages.disabled, { PI_NONO_PROFILE: "pi-review" }],
    [packages.disabled, { PI_NONO_LISTEN_PORTS: "8080" }],
    [packages.audit, { PI_NONO: "disabled", PI_NONO_PROFILE: "pi-audit" }],
    [packages.enforced, { PI_NONO: "disabled", PI_NONO_LISTEN_PORTS: "1" }],
    [
      packages.audit,
      {
        PI_NONO: "disabled",
        PI_NONO_PROFILE: "hostile-profile-sentinel",
        PI_NONO_LISTEN_PORTS: "hostile-port-sentinel",
      },
    ],
  ];
  for (const [packageValue, overrides] of cases) {
    assertFailure(
      () => resolve(packageValue, overrides),
      disabledConflictError,
      Object.entries(overrides)
        .filter(([name]) => name !== "PI_NONO")
        .map(([, value]) => value),
    );
  }
});

test("listen ports accept only ordered canonical comma-separated decimals", () => {
  const valid = [
    ["1", [1]],
    ["65535", [65535]],
    ["1,65535", [1, 65535]],
    ["8080,3000,443", [8080, 3000, 443]],
  ];
  for (const [input, expectedPorts] of valid) {
    const selection = resolve(packages.audit, {
      PI_NONO_LISTEN_PORTS: input,
    });
    assert.deepEqual(selection.listenPorts, expectedPorts);
    assert.equal(selection.source.listenPorts, "PI_NONO_LISTEN_PORTS");
    assert.equal(Object.isFrozen(selection.listenPorts), true);
  }

  assert.deepEqual(
    resolve(packages.audit, { PI_NONO_LISTEN_PORTS: "" }).listenPorts,
    [],
  );

  const invalid = [
    "0",
    "00",
    "01",
    "00001",
    "65536",
    "999999",
    "+1",
    "-1",
    "1-2",
    "*",
    "1.*",
    "1.0",
    "0x10",
    " 1",
    "1 ",
    "1, 2",
    "1,2 ",
    "1\t,2",
    "1\n,2",
    "1\r,2",
    "1\0,2",
    "1,",
    ",1",
    "1,,2",
    "1,1",
    "65535,1,65535",
    "１",
    "١",
    "one",
  ];
  for (const input of invalid) {
    assertFailure(
      () => resolve(packages.enforced, { PI_NONO_LISTEN_PORTS: input }),
      portError,
    );
  }
});

test("invalid overrides expose finite accepted values without hostile input", () => {
  const sentinel = "task-5-4-hostile-override-sentinel-97fa";
  assertFailure(
    () => resolve(packages.audit, { PI_NONO: sentinel }),
    stateError,
    [sentinel],
  );
  assertFailure(
    () => resolve(packages.audit, { PI_NONO_PROFILE: sentinel }),
    profileError,
    [sentinel],
  );
  assertFailure(
    () => resolve(packages.audit, { PI_NONO_LISTEN_PORTS: sentinel }),
    portError,
    [sentinel],
  );

  for (const invalidState of ["Disabled", "none", "off", "audit ", " audit"])
    assertFailure(
      () => resolve(packages.audit, { PI_NONO: invalidState }),
      stateError,
    );
});

test("closed environment snapshots reject malicious shapes and traps value-free", () => {
  const sentinel = "task-5-4-environment-trap-sentinel-44e8";
  const getterEnvironment = {};
  let getterCalls = 0;
  Object.defineProperty(getterEnvironment, "PI_NONO", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(sentinel);
    },
  });
  assertFailure(
    () =>
      packages.audit.resolver.resolveSandboxSelectionFromEnvironment(
        getterEnvironment,
      ),
    environmentError,
    [sentinel],
  );
  assert.equal(getterCalls, 0);

  const trappedEnvironment = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor() {
        throw new Error(sentinel);
      },
    },
  );
  assertFailure(
    () =>
      packages.audit.resolver.resolveSandboxSelectionFromEnvironment(
        trappedEnvironment,
      ),
    environmentError,
    [sentinel],
  );

  const revokedEnvironment = Proxy.revocable({}, {});
  revokedEnvironment.revoke();
  assertFailure(
    () =>
      packages.audit.resolver.resolveSandboxSelectionFromEnvironment(
        revokedEnvironment.proxy,
      ),
    environmentError,
    ["revoked", "IsArray", "proxy"],
  );

  for (const invalidEnvironment of [null, [], "", 1, true, () => {}]) {
    assertFailure(
      () =>
        packages.audit.resolver.resolveSandboxSelectionFromEnvironment(
          invalidEnvironment,
        ),
      environmentError,
    );
  }
  for (const invalidValue of [null, 1, true, Symbol(sentinel), {}, []]) {
    assertFailure(
      () =>
        packages.audit.resolver.resolveSandboxSelectionFromEnvironment({
          PI_NONO: invalidValue,
        }),
      stateError,
      [sentinel],
    );
  }

  assertFailure(
    () => packages.audit.resolver.resolveSandboxSelection({}),
    invocationError,
  );
  assertFailure(
    () =>
      packages.audit.resolver.resolveSandboxSelectionFromEnvironment({}, {}),
    invocationError,
  );

  const policyInjection = environment({
    policy: { state: "disabled" },
    profiles: ["hostile-profile"],
    piTools: ["bash"],
    portBounds: [0, 999999],
  });
  assert.deepEqual(
    packages.audit.resolver.resolveSandboxSelectionFromEnvironment(
      policyInjection,
    ),
    expectedSelection({
      state: "audit",
      profile: "pi-audit",
      stateSource: "sandbox.defaultState",
      profileSource: "state-default",
    }),
  );
});

test("resolution reads each actual environment name exactly once without mutation", () => {
  const values = {
    PI_NONO: "enforced",
    PI_NONO_PROFILE: "pi-review",
    PI_NONO_LISTEN_PORTS: "8080,443",
  };
  const descriptorReads = new Map(states.map((state) => [state, 0]));
  for (const name of Object.keys(values)) descriptorReads.set(name, 0);
  let getCalls = 0;
  const target = Object.freeze({ ...values });
  const proxy = new Proxy(target, {
    get() {
      getCalls += 1;
      throw new Error("sandbox resolver used a value getter");
    },
    getOwnPropertyDescriptor(object, name) {
      assert.equal(Object.hasOwn(values, name), true, String(name));
      descriptorReads.set(name, descriptorReads.get(name) + 1);
      return Object.getOwnPropertyDescriptor(object, name);
    },
  });

  const selection =
    packages.audit.resolver.resolveSandboxSelectionFromEnvironment(proxy);
  assert.deepEqual(selection.listenPorts, [8080, 443]);
  assert.equal(selection.profile, "pi-review");
  assert.equal(getCalls, 0);
  assert.deepEqual(
    Object.fromEntries(Object.keys(values).map((name) => [name, descriptorReads.get(name)])),
    {
      PI_NONO: 1,
      PI_NONO_PROFILE: 1,
      PI_NONO_LISTEN_PORTS: 1,
    },
  );
  assert.deepEqual(target, values);
});

test("selection and status are deeply immutable, JSON-safe, and byte-stable", () => {
  const first = resolve(packages.audit, {
    PI_NONO: "enforced",
    PI_NONO_PROFILE: "pi-review",
    PI_NONO_LISTEN_PORTS: "65535,1,8080",
  });
  const second = resolve(packages.audit, {
    PI_NONO: "enforced",
    PI_NONO_PROFILE: "pi-review",
    PI_NONO_LISTEN_PORTS: "65535,1,8080",
  });
  assertDeepFrozen(first);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.throws(() => {
    first.state = "disabled";
  }, TypeError);
  assert.throws(() => first.listenPorts.push(2), TypeError);
  assert.throws(() => first.piTools.push("bash"), TypeError);
  assert.throws(() => first.accepted.states.push("hostile"), TypeError);
  assert.throws(() => {
    first.source.state = "hostile";
  }, TypeError);
});

test("zero-argument production API snapshots only overrides and never launches traps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sandbox-resolver-"));
  const tracePath = path.join(root, "executions.txt");
  const beforeEnvironment = { ...process.env };
  try {
    const selection = withProcessEnvironment(
      {
        PI_NONO: "audit",
        PI_NONO_PROFILE: "pi-review",
        PI_NONO_LISTEN_PORTS: "443,8080",
        PI_AGENT_TASK54_EXEC_TRACE: tracePath,
        PATH: `${path.join(packages.audit.root, "bin")}:${process.env.PATH}`,
      },
      () => packages.audit.resolver.resolveSandboxSelection(),
    );
    assert.equal(selection.state, "audit");
    assert.equal(selection.profile, "pi-review");
    assert.deepEqual(selection.listenPorts, [443, 8080]);
    assert.equal(fs.existsSync(tracePath), false);
    assert.deepEqual({ ...process.env }, beforeEnvironment);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog and default artifact tampering fail with one fixed value-free error", () => {
  for (const name of ["tampered-catalog", "tampered-default"]) {
    assertFailure(
      () => resolve(packages[name]),
      contractError,
      ["pi-reviev", "enforced", packages[name].root],
    );
  }
});
