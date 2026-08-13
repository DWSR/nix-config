import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const fixtureRelativePath = "tests/pi-agent/fixtures/credential-policy.nix";
const runtimeModuleRelativePath = "lib/pi-agent/credential-policy.mjs";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const tokenSentinel = "task-2-5-token-sentinel";
const baseSentinel = "https://task-2-5-base-sentinel.example.test";
const firstLaunchId = "45df5e03-b165-4e14-b1b7-775cd9c038af";
const secondLaunchId = "99319aad-1c25-4bd5-b3aa-af8fddc676f1";
const ambientCredentialSentinel = "task-2-5-ambient-provider-sentinel";
const exactRedactionSerializationError = "exact redaction values are not serializable";
const shellAllowlist = [
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];
const spawnEnvironmentPartitions = {
  rootPi: "rootPiEnvironment",
  foregroundChildPi: "childPiEnvironment",
  builtInBash: "scrubbedEnvironment",
  backgroundPipe: "scrubbedEnvironment",
  backgroundPty: "scrubbedEnvironment",
  languageServer: "scrubbedEnvironment",
  cavememHook: "scrubbedEnvironment",
  cavememWorker: "scrubbedEnvironment",
  statusProbe: "scrubbedEnvironment",
  validatorProbe: "scrubbedEnvironment",
};
const requiredSensitiveNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "PI_AGENT_LAUNCH_ID",
  "SHOPIFY_PI_TOKEN",
  "XAI_API_KEY",
];

let resolverContract;
let personalRuntimeModule;
let shopifyRuntimeModule;

function fixtureExpression(fixture) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-credential-policy-tests";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      fixturePath = source + "/${fixtureRelativePath}";
    in
      import fixturePath {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = source;
      }
  `;
}

function evaluateFixture(fixture) {
  return childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixture)],
    commandOptions,
  );
}

function validFixture(fixture) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejectedFixture(fixture, diagnostics) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated: ${result.stdout}`);
  const output = `${result.stderr}\n${result.stdout}`;

  for (const diagnostic of diagnostics) {
    assert.match(output, diagnostic, `${fixture} did not emit ${diagnostic}:\n${output}`);
  }
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
  assert.equal(outputs.length, 1);
  return outputs[0];
}

async function loadRuntimeModule(fixture) {
  const output = buildFixture(fixture);
  const modulePath = path.join(output, runtimeModuleRelativePath);
  assert.ok(fs.existsSync(modulePath), `missing runtime policy module ${modulePath}`);
  return {
    output,
    source: fs.readFileSync(modulePath, "utf8"),
    exports: await import(pathToFileURL(modulePath)),
  };
}

function getResolverContract() {
  resolverContract ??= validFixture("resolver-contract");
  return resolverContract;
}

async function getPersonalRuntimeModule() {
  personalRuntimeModule ??= loadRuntimeModule("personal-runtime-module");
  return personalRuntimeModule;
}

async function getShopifyRuntimeModule() {
  shopifyRuntimeModule ??= loadRuntimeModule("shopify-runtime-module");
  return shopifyRuntimeModule;
}

function inheritedEnvironment(sensitiveNames) {
  return {
    HOME: "/Users/fixture",
    LANG: "en_CA.UTF-8",
    PATH: "/managed/bin:/usr/bin",
    TERM: "xterm-256color",
    TMPDIR: "/private/tmp/fixture",
    USER: "fixture",
    UNDECLARED_HOST_VALUE: "must-not-cross-the-shell-boundary",
    ...Object.fromEntries(sensitiveNames.map((name) => [name, ambientCredentialSentinel])),
  };
}

function expectedSafeEnvironment() {
  return {
    HOME: "/Users/fixture",
    LANG: "en_CA.UTF-8",
    PATH: "/managed/bin:/usr/bin",
    TERM: "xterm-256color",
    TMPDIR: "/private/tmp/fixture",
    USER: "fixture",
  };
}

function assertClosedRuntimeExports(runtimeModule) {
  assert.deepEqual(Object.keys(runtimeModule).sort(), [
    "bashTimeoutBinding",
    "createBashRuntimeInputs",
    "createCredentialBoundary",
    "createProviderRuntimeSecrets",
    "resolverPlans",
    "scrubEnvironment",
    "scrubbedShellContract",
    "sensitiveNames",
    "spawnEnvironmentPartitions",
  ]);
}

function assertClosedSerialization(value, sentinels) {
  assert.throws(
    () => JSON.stringify(value),
    (error) => {
      assert.match(error.message, /not serializable/);
      for (const sentinel of sentinels) {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
      }
      return true;
    },
  );
  const stringValue = String(value);
  for (const sentinel of sentinels) {
    assert.doesNotMatch(stringValue, new RegExp(sentinel));
  }
}

function assertReadonlySecretMembership(view, expectedValues, sentinels) {
  for (const [description, serialize] of [
    ["direct exact-redaction view", () => JSON.stringify(view)],
    ["nested exact-redaction view", () => JSON.stringify({ exactRedactionValues: view })],
  ]) {
    let serialized;
    let serializationError;
    try {
      serialized = serialize();
    } catch (error) {
      serializationError = error;
    }

    assert.ok(
      serializationError instanceof Error,
      `${description} unexpectedly serialized as ${serialized}`,
    );
    assert.equal(serializationError.message, exactRedactionSerializationError);
    for (const sentinel of sentinels) {
      assert.doesNotMatch(serializationError.message, new RegExp(sentinel));
    }
  }

  assert.equal(view instanceof Set, false);
  assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(Object.keys(view), []);
  assert.deepEqual(Object.getOwnPropertyNames(view).sort(), ["has", "size", "toJSON", "values"]);
  assert.deepEqual(Reflect.ownKeys(view), ["size", "has", "values", "toJSON", Symbol.iterator]);
  assert.equal(view.size, expectedValues.length);
  assert.equal(typeof view.has, "function");
  assert.equal(typeof view.values, "function");
  assert.deepEqual([...view.values()], expectedValues);
  assert.deepEqual([...view], expectedValues);
  for (const expectedValue of expectedValues) {
    assert.equal(view.has(expectedValue), true);
  }
  assert.equal(view.add, undefined);
  assert.equal(view.delete, undefined);
  assert.equal(view.clear, undefined);

  const descriptors = Object.getOwnPropertyDescriptors(view);
  assert.deepEqual(
    {
      configurable: descriptors.size.configurable,
      enumerable: descriptors.size.enumerable,
      hasSetter: descriptors.size.set !== undefined,
    },
    { configurable: false, enumerable: false, hasSetter: false },
  );
  for (const name of ["has", "values", "toJSON"]) {
    assert.deepEqual(
      {
        configurable: descriptors[name].configurable,
        enumerable: descriptors[name].enumerable,
        writable: descriptors[name].writable,
      },
      { configurable: false, enumerable: false, writable: false },
    );
  }
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(view, Symbol.iterator);
  assert.deepEqual(
    {
      configurable: iteratorDescriptor.configurable,
      enumerable: iteratorDescriptor.enumerable,
      writable: iteratorDescriptor.writable,
    },
    { configurable: false, enumerable: false, writable: false },
  );
}

function assertNoSerializationApi(runtimeModule) {
  assert.ok(
    Object.keys(runtimeModule).every(
      (name) => !/(?:json|encode|ownership|status|rollback)/i.test(name),
    ),
  );
}

test("closed resolver plans use the package-rendered devx executable and fixed launcher argv", () => {
  const contract = getResolverContract();

  assert.deepEqual(contract.resolverKinds, [
    "pi-auth",
    "shopify-gateway-token",
    "shopify-gateway-base",
  ]);
  assert.deepEqual(contract.personalPlans, [{ kind: "pi-auth" }]);
  assert.deepEqual(contract.personalInvocations, [null]);
  assert.deepEqual(contract.shopifyPlans, [
    { kind: "shopify-gateway-token", executable: contract.devx.executable },
    { kind: "shopify-gateway-base", executable: contract.devx.executable },
  ]);
  assert.deepEqual(contract.shopifyInvocations, [
    {
      executable: contract.devx.executable,
      argv: ["llm-gateway", "print-token", "--key"],
    },
    {
      executable: contract.devx.executable,
      argv: ["llm-gateway", "print-token", "--base"],
    },
  ]);
  assert.deepEqual(contract.devx, {
    executable: contract.devx.executable,
    packageHasOutputContext: true,
    packageIsDerivation: true,
    relativePath: "bin/devx",
  });
  assert.match(contract.devx.executable, /^\/nix\/store\/[^/]+-devx\/bin\/devx$/);
  assert.equal(contract.hostileToStringExecutable, contract.devx.executable);
  assert.deepEqual(contract.selectedMultiOutput, {
    executable: contract.selectedMultiOutput.expectedExecutable,
    expectedExecutable: contract.selectedMultiOutput.expectedExecutable,
    packageIsDerivation: true,
    outputName: "tools",
  });
  assert.match(
    contract.selectedMultiOutput.executable,
    /^\/nix\/store\/[^/]+-pi-agent-credential-policy-multi-output-tools\/bin\/devx$/,
  );
  assert.equal(contract.strongerProviderOverride.executable, contract.devx.executable);
  assert.equal(contract.strongerProviderOverride.hostExecutable, "/tmp/host-supplied-devx/bin/devx");
  assert.deepEqual(contract.strongerProviderOverride.hostArgv, ["host-supplied-argv"]);
  assert.equal(contract.strongerProviderOverride.hostEnvironmentName, "HOST_SUPPLIED_TOKEN");
  assert.equal(
    contract.strongerProviderOverride.hostIgnoredNullIfdOutPath,
    contract.devx.executable.slice(0, -"/bin/devx".length),
  );
  assert.equal(
    contract.strongerProviderOverride.hostRecursiveMetadataOutPath,
    contract.devx.executable.slice(0, -"/bin/devx".length),
  );
  assert.match(contract.strongerProviderOverride.hostContextSwappedOutPath, /-alternate-devx$/);
  assert.equal(contract.strongerProviderOverride.hostHostileToString, "/tmp/coerced-host-devx");
  assert.equal(contract.personalRuntimeModuleIsDerivation, true);
  assert.equal(contract.shopifyRuntimeModuleIsDerivation, true);

  for (const plan of [...contract.personalPlans, ...contract.shopifyPlans]) {
    assert.deepEqual(
      Object.keys(plan).sort(),
      plan.kind === "pi-auth" ? ["kind"] : ["executable", "kind"],
    );
    assert.equal("argv" in plan, false);
  }
});

test("trusted devx binding never forces ignored-null IFD metadata", () => {
  const ignoredNull = evaluateFixture("ignored-null-ifd-contract");
  assert.ifError(ignoredNull.error);
  assert.equal(ignoredNull.status, 0, ignoredNull.stderr);
  assert.doesNotMatch(ignoredNull.stderr, /TASK_2_5_IFD_THUNK_FORCED/);
  const ignoredNullContract = JSON.parse(ignoredNull.stdout);
  assert.equal(ignoredNullContract.executable, ignoredNullContract.expectedExecutable);
});

test("trusted devx binding never forces recursive derivation metadata", () => {
  const recursiveMetadata = validFixture("recursive-metadata-contract");
  assert.equal(recursiveMetadata.executable, recursiveMetadata.expectedExecutable);
});

test("host override metadata is ignored without forcing its thunks", () => {
  const result = evaluateFixture("host-override-metadata-contract");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /TASK_2_5_IFD_THUNK_FORCED/);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.executable, contract.expectedExecutable);
  assert.equal(contract.ignoredNullIfdOutPath, contract.expectedExecutable.slice(0, -"/bin/devx".length));
  assert.equal(contract.recursiveMetadataOutPath, contract.expectedExecutable.slice(0, -"/bin/devx".length));
});

test("general Home Module package binding and disabled mode remain regression-clean", () => {
  const packages = validFixture("home-module-package-regressions");
  assert.deepEqual(Object.keys(packages).sort(), [
    "selectedMultiOutput",
    "writeShellApplication",
    "writeShellScriptBin",
    "writeText",
  ]);
  for (const [name, packageSummary] of Object.entries(packages)) {
    assert.equal(packageSummary.packageIsDerivation, true, name);
    assert.match(packageSummary.renderedPath, /^\/nix\/store\//, name);
  }
  assert.equal(packages.selectedMultiOutput.outputName, "tools");
  assert.equal(packages.writeText.outputName, "out");
  assert.deepEqual(validFixture("disabled-module"), {
    enable: false,
    resolverKinds: ["pi-auth", "shopify-gateway-token", "shopify-gateway-base"],
  });
});

test("personal policy has no Shopify runtime surface and preserves an empty Pi-auth partition", async () => {
  const { exports: runtimeModule, source } = await getPersonalRuntimeModule();
  assertClosedRuntimeExports(runtimeModule);
  assert.deepEqual(runtimeModule.resolverPlans, [{ kind: "pi-auth" }]);
  assert.doesNotMatch(source, /\/nix\/store\/[^"']+-devx\/bin\/devx/);

  const runtime = runtimeModule.createProviderRuntimeSecrets({
    resolverResults: {},
    launchId: null,
  });
  assert.deepEqual(Object.keys(runtime).sort(), [
    "childPiEnvironment",
    "exactRedactionValues",
    "mode",
    "rootPiEnvironment",
  ]);
  assert.equal(runtime.mode, "personal");
  assert.deepEqual(runtime.rootPiEnvironment, {});
  assert.deepEqual(runtime.childPiEnvironment, {});
  assertReadonlySecretMembership(runtime.exactRedactionValues, [], [tokenSentinel, firstLaunchId]);
  assertNoSerializationApi(runtimeModule);
  assertClosedSerialization(runtime, []);
  assertClosedSerialization(runtime.rootPiEnvironment, []);
  assertClosedSerialization(runtime.childPiEnvironment, []);

  const boundary = runtimeModule.createCredentialBoundary({
    resolverResults: {},
    launchId: null,
    environment: inheritedEnvironment(runtimeModule.sensitiveNames),
  });
  assert.deepEqual(boundary.resolvers, [{ kind: "pi-auth" }]);
  assert.equal(boundary.runtime.mode, "personal");
  assert.deepEqual(boundary.scrubbedEnvironment, expectedSafeEnvironment());
  assertClosedSerialization(boundary, []);
});

test("Shopify constructor retains token and launch UUID only in provider-capable memory", async () => {
  const contract = getResolverContract();
  const { exports: runtimeModule } = await getShopifyRuntimeModule();
  assertClosedRuntimeExports(runtimeModule);
  assert.deepEqual(runtimeModule.resolverPlans, contract.shopifyPlans);
  assert.deepEqual(runtimeModule.spawnEnvironmentPartitions, spawnEnvironmentPartitions);
  assert.deepEqual(runtimeModule.scrubbedShellContract.allow, shellAllowlist);
  assert.deepEqual(
    runtimeModule.scrubbedShellContract.remove,
    [...runtimeModule.sensitiveNames, "PI_AGENT_BASH_TIMEOUT_MS"].sort(),
  );
  assert.deepEqual(runtimeModule.scrubbedShellContract, {
    kind: "allowlist-v1",
    environment: "scrubbedEnvironment",
    allow: shellAllowlist,
    remove: [...runtimeModule.sensitiveNames, "PI_AGENT_BASH_TIMEOUT_MS"].sort(),
  });
  assert.deepEqual(runtimeModule.sensitiveNames, [...new Set(runtimeModule.sensitiveNames)].sort());
  for (const name of requiredSensitiveNames) {
    assert.ok(runtimeModule.sensitiveNames.includes(name), `missing sensitive name ${name}`);
  }

  const resolverResults = {
    "shopify-gateway-token": tokenSentinel,
    "shopify-gateway-base": baseSentinel,
  };
  const runtime = runtimeModule.createProviderRuntimeSecrets({
    resolverResults,
    launchId: firstLaunchId,
  });
  assert.deepEqual(Object.keys(runtime).sort(), [
    "childPiEnvironment",
    "exactRedactionValues",
    "launchId",
    "mode",
    "rootPiEnvironment",
    "token",
  ]);
  assert.equal(runtime.mode, "shopify-gateway");
  assert.equal(runtime.token, tokenSentinel);
  assert.equal(runtime.launchId, firstLaunchId);
  assert.deepEqual(runtime.rootPiEnvironment, {
    SHOPIFY_PI_TOKEN: tokenSentinel,
    PI_AGENT_LAUNCH_ID: firstLaunchId,
  });
  assert.deepEqual(runtime.childPiEnvironment, runtime.rootPiEnvironment);
  assert.notEqual(runtime.childPiEnvironment, runtime.rootPiEnvironment);
  assertReadonlySecretMembership(
    runtime.exactRedactionValues,
    [tokenSentinel, firstLaunchId],
    [tokenSentinel, firstLaunchId],
  );
  assert.throws(() => Set.prototype.delete.call(runtime.exactRedactionValues, tokenSentinel));
  assert.equal(runtime.exactRedactionValues.has(tokenSentinel), true);
  assertNoSerializationApi(runtimeModule);
  for (const value of [runtime, runtime.rootPiEnvironment, runtime.childPiEnvironment]) {
    assertClosedSerialization(value, [tokenSentinel, firstLaunchId]);
  }

  const environment = inheritedEnvironment(runtimeModule.sensitiveNames);
  const boundary = runtimeModule.createCredentialBoundary({
    resolverResults,
    launchId: firstLaunchId,
    environment,
  });
  assert.deepEqual(boundary.scrubbedEnvironment, expectedSafeEnvironment());
  assert.equal(environment.SHOPIFY_PI_TOKEN, ambientCredentialSentinel);
  assert.equal("SHOPIFY_PI_TOKEN" in boundary.scrubbedEnvironment, false);
  assert.equal("PI_AGENT_LAUNCH_ID" in boundary.scrubbedEnvironment, false);
  assert.equal("OPENAI_API_KEY" in boundary.scrubbedEnvironment, false);
  assert.equal("UNDECLARED_HOST_VALUE" in boundary.scrubbedEnvironment, false);
  assertClosedSerialization(boundary, [tokenSentinel, firstLaunchId]);

  const nextRuntime = runtimeModule.createProviderRuntimeSecrets({
    resolverResults,
    launchId: secondLaunchId,
  });
  assert.equal(nextRuntime.rootPiEnvironment.SHOPIFY_PI_TOKEN, tokenSentinel);
  assert.equal(nextRuntime.rootPiEnvironment.PI_AGENT_LAUNCH_ID, secondLaunchId);
  assert.notDeepEqual(nextRuntime.rootPiEnvironment, runtime.rootPiEnvironment);

  const serializableSurfaces = {
    resolvers: boundary.resolvers,
    scrubbedEnvironment: boundary.scrubbedEnvironment,
    scrubbedShellContract: runtimeModule.scrubbedShellContract,
    sensitiveNames: boundary.sensitiveNames,
    spawnEnvironmentPartitions: runtimeModule.spawnEnvironmentPartitions,
  };
  const serialized = JSON.stringify(serializableSurfaces);
  for (const sentinel of [
    tokenSentinel,
    baseSentinel,
    firstLaunchId,
    secondLaunchId,
    ambientCredentialSentinel,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel));
  }
});

test("policy construction is pure and exposes no resolver or Capture Bridge execution", async () => {
  const { source, exports: runtimeModule } = await getShopifyRuntimeModule();
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-credential-policy-"));
  const marker = path.join(markerRoot, "resolver-ran");

  try {
    process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER = marker;
    runtimeModule.createCredentialBoundary({
      resolverResults: {
        "shopify-gateway-token": tokenSentinel,
        "shopify-gateway-base": baseSentinel,
      },
      launchId: firstLaunchId,
      environment: inheritedEnvironment(runtimeModule.sensitiveNames),
    });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    delete process.env.PI_AGENT_CREDENTIAL_POLICY_EXECUTION_MARKER;
    fs.rmSync(markerRoot, { recursive: true, force: true });
  }

  assert.doesNotMatch(source, /node:child_process|\b(?:spawn|execFile|execSync)\s*\(/);
  assert.doesNotMatch(source, /register(?:Secret|Redaction)|captureBridge\s*\./i);
  assert.doesNotMatch(source, /JSON\.stringify/);
  assert.doesNotMatch(source, new RegExp(`${tokenSentinel}|${baseSentinel}|${firstLaunchId}`));
});

test("closed inputs reject host paths, argv, environment names, and value-bearing diagnostics", async (t) => {
  const nixCases = {
    "missing-trusted-devx": [/requires a trusted module-owned devx output/],
    "unknown-provider-mode": [/credential policy host selection/, /personal.*shopify-gateway/],
    "unexpected-render-argv": [/unexpected argument.*argv/],
    "unexpected-render-environment-name": [/unexpected argument.*environmentName/],
  };

  for (const [fixture, diagnostics] of Object.entries(nixCases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, diagnostics);
    });
  }

  const { exports: runtimeModule } = await getShopifyRuntimeModule();
  const invalidInputs = [
    {
      resolverResults: {
        "shopify-gateway-token": tokenSentinel,
        "shopify-gateway-base": baseSentinel,
        hostPlugin: ambientCredentialSentinel,
      },
      launchId: firstLaunchId,
    },
    {
      resolverResults: {
        "shopify-gateway-token": tokenSentinel,
        "shopify-gateway-base": baseSentinel,
      },
      launchId: firstLaunchId,
      environmentName: ambientCredentialSentinel,
    },
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => runtimeModule.createProviderRuntimeSecrets(input),
      (error) => {
        assert.match(error.message, /invalid credential policy input/);
        assert.doesNotMatch(
          error.message,
          new RegExp(`${tokenSentinel}|${baseSentinel}|${firstLaunchId}|${ambientCredentialSentinel}`),
        );
        return true;
      },
    );
  }
});

test("constructor snapshots closed plain data once and rejects accessors without reading them", async () => {
  const { exports: runtimeModule } = await getShopifyRuntimeModule();
  let launchReads = 0;
  const accessorInput = {
    resolverResults: {
      "shopify-gateway-token": tokenSentinel,
      "shopify-gateway-base": baseSentinel,
    },
  };
  Object.defineProperty(accessorInput, "launchId", {
    enumerable: true,
    get() {
      launchReads += 1;
      return launchReads === 1 ? firstLaunchId : secondLaunchId;
    },
  });

  assert.throws(
    () => runtimeModule.createProviderRuntimeSecrets(accessorInput),
    (error) => {
      assert.match(error.message, /invalid credential policy input/);
      assert.match(error.message, /plain data propert/);
      assert.doesNotMatch(error.message, new RegExp(`${firstLaunchId}|${secondLaunchId}`));
      return true;
    },
  );
  assert.equal(launchReads, 0);

  let tokenReads = 0;
  const accessorResults = {
    "shopify-gateway-base": baseSentinel,
  };
  Object.defineProperty(accessorResults, "shopify-gateway-token", {
    enumerable: true,
    get() {
      tokenReads += 1;
      return tokenSentinel;
    },
  });
  assert.throws(
    () =>
      runtimeModule.createProviderRuntimeSecrets({
        resolverResults: accessorResults,
        launchId: firstLaunchId,
      }),
    /plain data propert/,
  );
  assert.equal(tokenReads, 0);
});

test("constructor rejects symbols, exotic prototypes, and noncanonical launch UUIDs value-free", async () => {
  const { exports: runtimeModule } = await getShopifyRuntimeModule();
  const validResults = {
    "shopify-gateway-token": tokenSentinel,
    "shopify-gateway-base": baseSentinel,
  };
  const symbolInput = {
    resolverResults: validResults,
    launchId: firstLaunchId,
    [Symbol("task-2-5-symbol-sentinel")]: tokenSentinel,
  };
  const exoticInput = Object.assign(Object.create({ inherited: tokenSentinel }), {
    resolverResults: validResults,
    launchId: firstLaunchId,
  });

  for (const input of [symbolInput, exoticInput]) {
    assert.throws(
      () => runtimeModule.createProviderRuntimeSecrets(input),
      (error) => {
        assert.match(error.message, /invalid credential policy input/);
        assert.doesNotMatch(error.message, new RegExp(tokenSentinel));
        return true;
      },
    );
  }

  for (const launchId of [
    "not-a-uuid",
    firstLaunchId.toUpperCase(),
    "45df5e03-b165-1e14-b1b7-775cd9c038af",
    "45df5e03-b165-4e14-71b7-775cd9c038af",
  ]) {
    assert.throws(
      () =>
        runtimeModule.createProviderRuntimeSecrets({
          resolverResults: validResults,
          launchId,
        }),
      (error) => {
        assert.match(error.message, /canonical version 4 UUID/);
        assert.doesNotMatch(error.message, new RegExp(launchId));
        return true;
      },
    );
  }
});

test("constructor leaves caller data unchanged and one snapshot feeds every secret view", async () => {
  const { exports: runtimeModule } = await getShopifyRuntimeModule();
  const resolverResults = {
    "shopify-gateway-token": tokenSentinel,
    "shopify-gateway-base": baseSentinel,
  };
  const input = { resolverResults, launchId: firstLaunchId };
  const inputDescriptors = Object.getOwnPropertyDescriptors(input);
  const resultDescriptors = Object.getOwnPropertyDescriptors(resolverResults);
  const runtime = runtimeModule.createProviderRuntimeSecrets(input);

  assert.deepEqual(Object.getOwnPropertyDescriptors(input), inputDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(resolverResults), resultDescriptors);
  assert.equal(runtime.token, tokenSentinel);
  assert.equal(runtime.launchId, firstLaunchId);
  assert.equal(runtime.rootPiEnvironment.SHOPIFY_PI_TOKEN, runtime.token);
  assert.equal(runtime.childPiEnvironment.SHOPIFY_PI_TOKEN, runtime.token);
  assert.equal(runtime.rootPiEnvironment.PI_AGENT_LAUNCH_ID, runtime.launchId);
  assert.equal(runtime.childPiEnvironment.PI_AGENT_LAUNCH_ID, runtime.launchId);
  assert.equal(runtime.exactRedactionValues.has(runtime.token), true);
  assert.equal(runtime.exactRedactionValues.has(runtime.launchId), true);
});
