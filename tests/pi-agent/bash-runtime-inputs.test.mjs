import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const moduleFixture = path.join(testsDir, "fixtures/module-contract.nix");
const managedFixture = path.join(testsDir, "fixtures/managed-config.nix");
const credentialFixture = path.join(testsDir, "fixtures/credential-policy.nix");
const runtimeModuleRelativePath = "lib/pi-agent/credential-policy.mjs";
const timeoutEnvironmentName = "PI_AGENT_BASH_TIMEOUT_MS";
const shellCodeIdentifier = "com.dwsr.pi-agent-shell";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

function fixtureExpression(fixturePath, fixture) {
  const fixtureRelativePath = path.relative(repoRoot, fixturePath);
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-bash-runtime-inputs-source";
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
    in
      import (repoSource + "/${fixtureRelativePath}") {
        fixture = ${JSON.stringify(fixture)};
        repoRoot = repoSource;
      }
  `;
}

function evaluateFixture(fixturePath, fixture) {
  return childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixturePath, fixture)],
    commandOptions,
  );
}

function validFixture(fixturePath, fixture) {
  const result = evaluateFixture(fixturePath, fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejectedFixture(fixturePath, fixture, diagnostics) {
  const result = evaluateFixture(fixturePath, fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated: ${result.stdout}`);
  const output = `${result.stderr}\n${result.stdout}`;
  for (const diagnostic of diagnostics) {
    assert.match(output, diagnostic, `${fixture} did not emit ${diagnostic}:\n${output}`);
  }
}

function buildFixture(fixturePath, fixture) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression(fixturePath, fixture),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n");
  assert.equal(outputs.length, 1);
  return outputs[0];
}

async function loadRuntimeModule() {
  const output = buildFixture(credentialFixture, "shopify-runtime-module");
  return import(`${pathToFileURL(path.join(output, runtimeModuleRelativePath)).href}?task45`);
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test("bashDefaultMs admits only integer milliseconds from 1 through 2147483647", async (t) => {
  assert.equal(validFixture(moduleFixture, "bash-timeout-min").bashDefaultMs, 1);
  assert.equal(validFixture(moduleFixture, "bash-timeout-max").bashDefaultMs, 2147483647);
  assert.equal(validFixture(moduleFixture, "bash-timeout-non-default").bashDefaultMs, 543210);

  const rejected = [
    ["zero", "bash-timeout-zero"],
    ["negative", "bash-timeout-negative"],
    ["non-integer", "bash-timeout-non-integer"],
    ["overflow", "bash-timeout-overflow"],
  ];
  for (const [name, fixture] of rejected) {
    await t.test(name, () => {
      rejectedFixture(moduleFixture, fixture, [
        /programs\.pi-agent\.timeouts\.bashDefaultMs/,
        /integer between 1 and 2147483647/,
      ]);
    });
  }
});

test("managed state deterministically carries exact milliseconds and the module-owned shell", () => {
  const firstConfigPath = buildFixture(managedFixture, "shopify-managed-config");
  const secondConfigPath = buildFixture(managedFixture, "shopify-managed-config");
  const personalConfigPath = buildFixture(managedFixture, "personal-managed-config");
  const shellPackage = buildFixture(credentialFixture, "managed-shell");
  const expectedShellPath = path.join(shellPackage, "bin/pi-agent-shell");
  const firstBytes = fs.readFileSync(firstConfigPath, "utf8");
  const config = JSON.parse(firstBytes);
  const personalConfig = JSON.parse(fs.readFileSync(personalConfigPath, "utf8"));

  assert.equal(firstConfigPath, secondConfigPath);
  assert.equal(firstBytes, fs.readFileSync(secondConfigPath, "utf8"));
  assert.deepEqual(config.timeouts, { bashDefaultMs: 543210 });
  assert.equal(config.settings.shellPath, expectedShellPath);
  assert.deepEqual(personalConfig.timeouts, config.timeouts);
  assert.equal(personalConfig.settings.shellPath, config.settings.shellPath);
  assert.match(config.settings.shellPath, /^\/nix\/store\/[^/]+\/bin\/pi-agent-shell$/);
  fs.accessSync(config.settings.shellPath, fs.constants.X_OK);
  assert.doesNotMatch(
    `${firstBytes}\n${fs.readFileSync(expectedShellPath, "utf8")}`,
    /task-4\.5-(?:provider|timeout)-sentinel/,
  );
});

test("the fixed public timeout binding targets root and foreground child Pi outside provider secrets", async () => {
  const runtimeModule = await loadRuntimeModule();
  assert.deepEqual(runtimeModule.bashTimeoutBinding, {
    environmentName: timeoutEnvironmentName,
    targets: ["rootPi", "foregroundChildPi"],
  });
  assert.equal(runtimeModule.sensitiveNames.includes(timeoutEnvironmentName), false);

  for (const bashDefaultMs of [1, 543210, 2147483647]) {
    const inputs = runtimeModule.createBashRuntimeInputs({ bashDefaultMs });
    const expectedEnvironment = { [timeoutEnvironmentName]: String(bashDefaultMs) };
    assert.deepEqual(inputs, {
      rootPiEnvironment: expectedEnvironment,
      childPiEnvironment: expectedEnvironment,
    });
    assert.notEqual(inputs.rootPiEnvironment, inputs.childPiEnvironment);
    assert.ok(Object.isFrozen(inputs));
    assert.ok(Object.isFrozen(inputs.rootPiEnvironment));
    assert.ok(Object.isFrozen(inputs.childPiEnvironment));
  }

  for (const bashDefaultMs of [0, -1, 1.5, 2147483648]) {
    assert.throws(
      () => runtimeModule.createBashRuntimeInputs({ bashDefaultMs }),
      /invalid credential policy input at bashDefaultMs/,
    );
  }
  assert.throws(
    () =>
      runtimeModule.createBashRuntimeInputs({
        bashDefaultMs: 543210,
        environmentName: "HOST_BASH_TIMEOUT",
      }),
    /invalid credential policy input at \$bashRuntime: fields must match the closed schema/,
  );

  const providerRuntime = runtimeModule.createProviderRuntimeSecrets({
    resolverResults: {
      "shopify-gateway-token": "task-4.5-provider-sentinel",
      "shopify-gateway-base": "https://gateway.example.test",
    },
    launchId: "f07fbd1a-12c8-4bf5-8b1e-f8bd054d786f",
  });
  assert.equal(timeoutEnvironmentName in providerRuntime, false);
  assert.equal(timeoutEnvironmentName in providerRuntime.rootPiEnvironment, false);
  assert.equal(timeoutEnvironmentName in providerRuntime.childPiEnvironment, false);
});

test("the compiled managed shell scrubs before Bash startup and preserves arguments", async (t) => {
  const runtimeModule = await loadRuntimeModule();
  const shellPackage = buildFixture(credentialFixture, "managed-shell");
  const shell = path.join(shellPackage, "bin/pi-agent-shell");
  const providerSentinel = "task-4.5-provider-sentinel";
  const timeoutSentinel = "task-4.5-timeout-sentinel";
  const undeclaredSentinel = "task-4.5-undeclared-sentinel";
  const coreFoundationSentinel = "task-4.5-core-foundation-sentinel";
  const startupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-shell-startup-"));
  const bashEnvironment = path.join(startupRoot, "hostile-bash-env.sh");
  t.after(() => fs.rmSync(startupRoot, { force: true, recursive: true }));
  fs.writeFileSync(
    bashEnvironment,
    "printf 'pre-scrub:%s|%s\\n' \"${SHOPIFY_PI_TOKEN-}\" \"${PI_AGENT_BASH_TIMEOUT_MS-}\" >&2\n",
    { mode: 0o600 },
  );
  const allowlistedEnvironment = {
    COLORTERM: "truecolor",
    HOME: "/Users/task-4-5",
    LANG: "en_CA.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "C",
    LOGNAME: "task-4-5",
    NO_COLOR: "1",
    PATH: "/managed/bin:/usr/bin",
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
    TERM_PROGRAM: "task-4-5-terminal",
    TMPDIR: "/private/tmp/task-4-5",
    USER: "task-4-5",
    XDG_CACHE_HOME: "/Users/task-4-5/.cache",
    XDG_CONFIG_HOME: "/Users/task-4-5/.config",
    XDG_DATA_HOME: "/Users/task-4-5/.local/share",
    XDG_STATE_HOME: "/Users/task-4-5/.local/state",
  };
  assert.deepEqual(Object.keys(allowlistedEnvironment), runtimeModule.scrubbedShellContract.allow);
  const positionalArguments = [
    "task-4.5-argv-zero",
    "space value",
    "",
    "-leading-option",
    "single'quote",
    "dollar$and\\backslash",
    "line\nbreak",
  ];
  const environment = {
    ...allowlistedEnvironment,
    ...Object.fromEntries(runtimeModule.sensitiveNames.map((name) => [name, providerSentinel])),
    [timeoutEnvironmentName]: timeoutSentinel,
    UNDECLARED_HOST_VALUE: undeclaredSentinel,
    BASH_ENV: bashEnvironment,
    BASHOPTS: "extglob:sourcepath",
    PS4: `pre-trace:${providerSentinel}|${timeoutSentinel}:`,
    SHELLOPTS: "braceexpand:hashall:interactive-comments:nounset:xtrace",
    __CF_USER_TEXT_ENCODING: coreFoundationSentinel,
  };
  const probe = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), environment: process.env }))`;
  const forwardedArguments = positionalArguments.map((_, index) => `"$${index}"`).join(" ");
  const command = `${quoteShell(process.execPath)} -e ${quoteShell(probe)} -- ${forwardedArguments}`;
  const hostileDyldEnvironments = [
    ["environment logging", { DYLD_PRINT_ENV: "1" }],
    [
      "loader diagnostics",
      {
        DYLD_PRINT_APIS: "1",
        DYLD_PRINT_BINDINGS: "1",
        DYLD_PRINT_INITIALIZERS: "1",
        DYLD_PRINT_LIBRARIES: "1",
        DYLD_PRINT_LOADERS: "1",
        DYLD_PRINT_SEARCHING: "1",
        DYLD_PRINT_SEGMENTS: "1",
      },
    ],
    [
      "insertion and path controls",
      {
        DYLD_INSERT_LIBRARIES: `/nonexistent/${providerSentinel}.dylib`,
        DYLD_LIBRARY_PATH: `/nonexistent/${timeoutSentinel}`,
      },
    ],
  ];

  for (const [caseName, hostileDyldEnvironment] of hostileDyldEnvironments) {
    const result = childProcess.spawnSync(shell, ["-c", command, ...positionalArguments], {
      ...commandOptions,
      env: { ...environment, ...hostileDyldEnvironment },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, `${caseName}:\n${result.stderr}`);
    assert.equal(result.stderr, "", `${caseName} produced pre-scrub output:\n${result.stderr}`);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(
      combinedOutput,
      new RegExp(
        `pre-(?:scrub|trace)|${providerSentinel}|${timeoutSentinel}|${undeclaredSentinel}|${coreFoundationSentinel}`,
      ),
      caseName,
    );
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.argv, positionalArguments, caseName);
    assert.equal(observed.argv[2], "", caseName);
    for (const name of Object.keys(allowlistedEnvironment)) {
      assert.equal(observed.environment[name], environment[name], `${caseName}: ${name}`);
    }
    for (const name of [
      ...runtimeModule.sensitiveNames,
      timeoutEnvironmentName,
      "UNDECLARED_HOST_VALUE",
      "BASH_ENV",
      "BASHOPTS",
      "PS4",
      "SHELLOPTS",
      ...Object.keys(hostileDyldEnvironment),
    ]) {
      assert.equal(name in observed.environment, false, `${caseName}: ${name}`);
    }
    const finalEnvironment = { ...observed.environment };
    assert.notEqual(observed.environment.__CF_USER_TEXT_ENCODING, coreFoundationSentinel);
    for (const shellGeneratedName of ["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]) {
      delete finalEnvironment[shellGeneratedName];
    }
    assert.deepEqual(finalEnvironment, allowlistedEnvironment, caseName);
  }

  const signature = childProcess.spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", shell],
    commandOptions,
  );
  assert.ifError(signature.error);
  assert.equal(signature.status, 0, signature.stderr);
  assert.match(signature.stderr, new RegExp(`^Identifier=${shellCodeIdentifier}$`, "m"));
  assert.match(signature.stderr, /^CodeDirectory .* flags=0x10002\(adhoc,runtime\)/m);
  assert.doesNotMatch(signature.stderr, /linker-signed/);

  const strictVerification = childProcess.spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=4", shell],
    commandOptions,
  );
  assert.ifError(strictVerification.error);
  assert.equal(strictVerification.status, 0, strictVerification.stderr);
  assert.match(strictVerification.stderr, /valid on disk/);
  assert.match(strictVerification.stderr, /satisfies its Designated Requirement/);

  const entitlements = childProcess.spawnSync(
    "/usr/bin/codesign",
    ["--display", "--entitlements", "-", "--xml", shell],
    commandOptions,
  );
  assert.ifError(entitlements.error);
  assert.equal(entitlements.status, 0, entitlements.stderr);
  assert.equal(entitlements.stdout, "");
  assert.doesNotMatch(
    `${entitlements.stdout}\n${entitlements.stderr}`,
    /com\.apple\.security\.cs\.allow-dyld-environment-variables/,
  );

  const linkedLibraries = childProcess.spawnSync("/usr/bin/otool", ["-L", shell], commandOptions);
  assert.ifError(linkedLibraries.error);
  assert.equal(linkedLibraries.status, 0, linkedLibraries.stderr);
  assert.match(linkedLibraries.stdout, /\/usr\/lib\/libSystem\.B\.dylib/);
  assert.equal(fs.readFileSync(shell).subarray(0, 4).toString("hex"), "cffaedfe");
});

test("hosts cannot provide shell path, shell text, shell argv, or binding names", async (t) => {
  const cases = [
    ["path", "bash-public-shell-path", /programs\.pi-agent\.shellPath/],
    ["text", "bash-public-shell-text", /programs\.pi-agent\.shell/],
    ["argv", "bash-public-shell-argv", /programs\.pi-agent\.shell/],
    ["binding", "bash-public-binding-name", /programs\.pi-agent\.timeouts\.bindingName/],
  ];
  for (const [name, fixture, optionPath] of cases) {
    await t.test(name, () => rejectedFixture(moduleFixture, fixture, [optionPath, /does not exist/]));
  }
});

test("rendering the managed shell adds no activation mutation", () => {
  assert.deepEqual(validFixture(moduleFixture, "bash-activation-purity"), []);
});
