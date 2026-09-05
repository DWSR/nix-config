import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CREDENTIAL_RESOLVER_MODULE = "__PI_AGENT_LAUNCHER_CREDENTIAL_RESOLVER__";
const CREDENTIAL_POLICY_MODULE = "__PI_AGENT_LAUNCHER_CREDENTIAL_POLICY__";
const RECONCILER_MODULE = "__PI_AGENT_LAUNCHER_RECONCILER__";
const PROVIDER_HANDOFF_MODULE = "__PI_AGENT_LAUNCHER_PROVIDER_HANDOFF__";
const PROJECTION_FACTORY_EXECUTABLE =
  "__PI_AGENT_LAUNCHER_PROJECTION_FACTORY__";
const SANDBOX_RESOLVER_MODULE = "__PI_AGENT_LAUNCHER_SANDBOX_RESOLVER__";
const MANAGED_CONFIG_PATH = "__PI_AGENT_LAUNCHER_MANAGED_CONFIG__";
const MANAGED_CONFIG_DIGEST = "__PI_AGENT_LAUNCHER_MANAGED_CONFIG_DIGEST__";
const STATUS_MANAGED_CONFIG_PATH = "__PI_AGENT_LAUNCHER_STATUS_CONFIG__";
const STATUS_EXECUTABLE = "__PI_AGENT_LAUNCHER_STATUS__";
const MCP_PROBE_MODULE = "__PI_AGENT_LAUNCHER_MCP_PROBE__";
const VALIDATOR_EXECUTABLE = "__PI_AGENT_LAUNCHER_VALIDATOR__";
const CAVEMEM_EXECUTABLE = "__PI_AGENT_LAUNCHER_CAVEMEM__";
const SANDBOX_VALIDATOR_MODULE = "__PI_AGENT_LAUNCHER_SANDBOX_VALIDATOR__";
const KEYCHAIN_EXECUTABLE = "__PI_AGENT_LAUNCHER_KEYCHAIN__";
const NODE_EXECUTABLE = "__PI_AGENT_LAUNCHER_NODE__";
const PI_PACKAGE_ROOT = "__PI_AGENT_LAUNCHER_PI_PACKAGE__";
const PROBE_CWD = "__PI_AGENT_LAUNCHER_PROBE_CWD__";
const EXPECTED_PROVIDER_MODE = "__PI_AGENT_LAUNCHER_PROVIDER_MODE__";
const EXPECTED_PI_VERSION = "0.83.0";

const INPUT_LIMIT_BYTES = 64 * 1024;
const PROBE_OUTPUT_LIMIT_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 15_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "groq",
  "xai",
]);
const SANDBOX_CONTROL_NAMES = Object.freeze([
  "PI_NONO",
  "PI_NONO_PROFILE",
  "PI_NONO_LISTEN_PORTS",
]);
const VALIDATED_STAGES = Object.freeze([
  "resolver",
  "provider-projection",
  "reconciliation",
  "package",
  "profile",
  "mcpproxy",
  "cavemem",
  "extensions",
  "validator",
]);
const VALIDATOR_GATE_NAMES = Object.freeze([
  "package-patches",
  "managed-json",
  "ownership",
  "sandbox-profiles",
  "extension-inventory",
  "mcp-surface",
  "cavemem",
  "pty",
  "lsp",
  "reconciliation-drift",
  "sandbox-seatbelt-host",
  "provider-setup",
]);
const RECOVERY = Object.freeze({
  invocation:
    "use the package-owned managed launcher with absolute state directories",
  resolver: "restore the managed gateway package and retry the launch",
  projection:
    "restore the managed provider projection package and retry the launch",
  auth: "remove the conflicting Pi authentication entry and retry the launch",
  state: "repair managed Pi state and rerun reconciliation",
  package:
    "rebuild the managed generation or reactivate the previous generation",
  profile: "select a valid managed profile or use the documented rollback",
  mcpproxy: "restart mcpproxy or repair the declared upstream",
  cavemem: "restart the Cavemem worker and verify the managed data directory",
  extensions: "rebuild pi-agent-extensions and activate the managed generation",
  validator:
    "repair the failed runtime compatibility gate and retry the launch",
});
const SANDBOX_DIAGNOSTICS = new Set([
  "sandbox override PI_NONO is invalid; accepted values: disabled, audit, enforced",
  "sandbox override PI_NONO_PROFILE is invalid; accepted values: pi-audit, pi-managed, pi-review",
  "sandbox override PI_NONO_LISTEN_PORTS is invalid; accepted format: comma-separated canonical decimal ports from 1 through 65535",
  "sandbox disabled state conflicts with enabled-only overrides; accepted recovery: unset PI_NONO_PROFILE and PI_NONO_LISTEN_PORTS, or set PI_NONO to audit or enforced",
]);
const GATE_RECOVERY = Object.freeze({
  "package-patches": RECOVERY.package,
  "managed-json": RECOVERY.state,
  ownership: RECOVERY.state,
  "sandbox-profiles": RECOVERY.profile,
  "extension-inventory": RECOVERY.extensions,
  "mcp-surface": RECOVERY.mcpproxy,
  cavemem: RECOVERY.cavemem,
  pty: RECOVERY.extensions,
  lsp: RECOVERY.extensions,
  "reconciliation-drift": RECOVERY.state,
  "sandbox-seatbelt-host": RECOVERY.profile,
  "provider-setup": RECOVERY.resolver,
});
const PRIVATE_REJECTION = Symbol();

class ManagedLaunchError extends Error {
  constructor(component, recovery, details = {}) {
    const suffix =
      details.providerId === undefined
        ? details.operation === undefined
          ? details.extensionName === undefined
            ? ""
            : ` extension ${details.extensionName}`
          : ` operation ${details.operation}`
        : ` provider ${details.providerId}`;
    const diagnostic =
      details.diagnostic === undefined ? "" : ` ${details.diagnostic}`;
    super(
      `Managed launch failed: ${component}${suffix}.${diagnostic} Recovery: ${recovery}.`,
    );
    Object.defineProperty(this, "name", { value: "ManagedLaunchError" });
    Object.defineProperty(this, "component", {
      enumerable: true,
      value: component,
    });
    if (details.operation !== undefined) {
      Object.defineProperty(this, "operation", {
        enumerable: true,
        value: details.operation,
      });
    }
    if (details.providerId !== undefined) {
      Object.defineProperty(this, "providerId", {
        enumerable: true,
        value: details.providerId,
      });
    }
    if (details.extensionName !== undefined) {
      Object.defineProperty(this, "extensionName", {
        enumerable: true,
        value: details.extensionName,
      });
    }
    if (details.diagnostic !== undefined) {
      Object.defineProperty(this, "diagnostic", {
        enumerable: true,
        value: details.diagnostic,
      });
    }
    Object.defineProperty(this, "recovery", {
      enumerable: true,
      value: recovery,
    });
    Object.freeze(this);
  }
}

class ProjectionCallbackFailure extends Error {
  constructor(component, details = {}) {
    super(component);
    this.component = component;
    this.details = details;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort(compareText);
  return (
    keys.length === wanted.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys].sort(compareText).every((key, index) => key === wanted[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function exactEnumerableDataKeys(value, expected) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const keys = Object.keys(value);
  const wanted = [...expected].sort(compareText);
  if (
    keys.length !== wanted.length ||
    [...keys].sort(compareText).some((key, index) => key !== wanted[index]) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable !== true || !("value" in descriptor);
    })
  ) {
    return false;
  }
  return Object.getOwnPropertyNames(value).every((key) => {
    if (wanted.includes(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      key === "toJSON" &&
      descriptor?.enumerable === false &&
      typeof descriptor.value === "function"
    );
  });
}

function snapshotInvocation(input) {
  try {
    if (!exactDataKeys(input, ["agentDir", "cavememDataDir"])) {
      throw PRIVATE_REJECTION;
    }
    const result = {};
    for (const key of ["agentDir", "cavememDataDir"]) {
      const value = input[key];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096 ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        CONTROL.test(value)
      ) {
        throw PRIVATE_REJECTION;
      }
      result[key] = value;
    }
    return Object.freeze(result);
  } catch {
    throwFailure("invocation", RECOVERY.invocation);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function containsExactValue(text, values) {
  return values.some((value) => text.includes(value));
}

function throwFailure(component, recovery, details = {}, redactionValues = []) {
  const redact = (value) =>
    redactionValues.reduce(
      (result, secret) => result.replaceAll(secret, "[REDACTED]"),
      value,
    );
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" &&
          !["diagnostic", "extensionName", "operation", "providerId"].includes(
            key,
          )
        ? redact(value)
        : value,
    ]),
  );
  throw new ManagedLaunchError(
    component,
    recovery,
    safeDetails,
  );
}

function readBounded(file, limit = INPUT_LIMIT_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
    throw PRIVATE_REJECTION;
  }
  return fs.readFileSync(file);
}

function loadManagedConfig() {
  try {
    const bytes = readBounded(MANAGED_CONFIG_PATH);
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== 1 ||
      typeof value.generation !== "string" ||
      value.generation.length === 0 ||
      !isPlainObject(value.providerSelection) ||
      value.providerSelection.mode !== EXPECTED_PROVIDER_MODE ||
      !Array.isArray(value.extensionOrder) ||
      value.mcpEndpoint !== "http://127.0.0.1:8080/mcp"
    ) {
      throw PRIVATE_REJECTION;
    }
    return { bytes, value: deepFreeze(value) };
  } catch {
    throwFailure("package", RECOVERY.package);
  }
}

function snapshotSensitiveValues(runtimeSecrets) {
  try {
    const values = [...runtimeSecrets.exactRedactionValues];
    if (
      values.some((value) => typeof value !== "string" || value.length === 0) ||
      new Set(values).size !== values.length
    ) {
      throw PRIVATE_REJECTION;
    }
    return Object.freeze(
      [...values].sort(
        (left, right) => right.length - left.length || compareText(left, right),
      ),
    );
  } catch {
    throwFailure("provider-resolver", RECOVERY.resolver);
  }
}

function snapshotAmbientSensitiveValues(credentialPolicy, redactionValues) {
  try {
    if (!Array.isArray(credentialPolicy.sensitiveNames)) {
      throw PRIVATE_REJECTION;
    }
    const values = [];
    for (const name of credentialPolicy.sensitiveNames) {
      if (typeof name !== "string" || name.length === 0) {
        throw PRIVATE_REJECTION;
      }
      const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "string") {
        throw PRIVATE_REJECTION;
      }
      if (descriptor.value.length > 0) values.push(descriptor.value);
    }
    return values;
  } catch {
    throwFailure("package", RECOVERY.package, {}, redactionValues);
  }
}

function mergeExactValues(...groups) {
  return Object.freeze(
    [...new Set(groups.flat())].sort(
      (left, right) => right.length - left.length || compareText(left, right),
    ),
  );
}

function validateResolverOutcome(outcome) {
  try {
    if (!exactDataKeys(outcome, ["baseCandidate", "runtimeSecrets"])) {
      throw PRIVATE_REJECTION;
    }
    const runtime = outcome.runtimeSecrets;
    const expected =
      EXPECTED_PROVIDER_MODE === "personal"
        ? [
            "childPiEnvironment",
            "exactRedactionValues",
            "mode",
            "rootPiEnvironment",
          ]
        : [
            "childPiEnvironment",
            "exactRedactionValues",
            "launchId",
            "mode",
            "rootPiEnvironment",
            "token",
          ];
    if (
      !exactEnumerableDataKeys(runtime, expected) ||
      runtime.mode !== EXPECTED_PROVIDER_MODE ||
      !isPlainObject(runtime.rootPiEnvironment) ||
      !isPlainObject(runtime.childPiEnvironment)
    ) {
      throw PRIVATE_REJECTION;
    }
    if (EXPECTED_PROVIDER_MODE === "personal") {
      if (
        outcome.baseCandidate !== null ||
        !exactEnumerableDataKeys(runtime.rootPiEnvironment, []) ||
        !exactEnumerableDataKeys(runtime.childPiEnvironment, [])
      ) {
        throw PRIVATE_REJECTION;
      }
    } else if (
      typeof outcome.baseCandidate !== "string" ||
      typeof runtime.token !== "string" ||
      runtime.token.length === 0 ||
      typeof runtime.launchId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        runtime.launchId,
      ) ||
      !exactEnumerableDataKeys(runtime.rootPiEnvironment, [
        "SHOPIFY_PI_TOKEN",
        "PI_AGENT_LAUNCH_ID",
      ]) ||
      !exactEnumerableDataKeys(runtime.childPiEnvironment, [
        "SHOPIFY_PI_TOKEN",
        "PI_AGENT_LAUNCH_ID",
      ]) ||
      runtime.rootPiEnvironment.SHOPIFY_PI_TOKEN !== runtime.token ||
      runtime.childPiEnvironment.SHOPIFY_PI_TOKEN !== runtime.token ||
      runtime.rootPiEnvironment.PI_AGENT_LAUNCH_ID !== runtime.launchId ||
      runtime.childPiEnvironment.PI_AGENT_LAUNCH_ID !== runtime.launchId
    ) {
      throw PRIVATE_REJECTION;
    }
    const sensitiveValues = snapshotSensitiveValues(runtime);
    if (
      (EXPECTED_PROVIDER_MODE === "personal" && sensitiveValues.length !== 0) ||
      (EXPECTED_PROVIDER_MODE === "shopify-gateway" &&
        (sensitiveValues.length !== 2 ||
          !sensitiveValues.includes(runtime.token) ||
          !sensitiveValues.includes(runtime.launchId)))
    ) {
      throw PRIVATE_REJECTION;
    }
    return outcome;
  } catch (error) {
    if (error instanceof ManagedLaunchError) throw error;
    throwFailure("provider-resolver", RECOVERY.resolver);
  }
}

function resolverOperation(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    const match = descriptor.value.match(
      /^credential resolver shopify-gateway-(?:token|base) operation (token|base) failed: (?:spawn|timeout|output-limit|command|invalid-output)$/,
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

function runProbe(
  executable,
  args,
  environment,
  input,
  timeout = PROBE_TIMEOUT_MS,
) {
  try {
    const result = spawnSync(executable, args, {
      cwd: PROBE_CWD,
      encoding: "utf8",
      env: environment,
      ...(input === undefined ? {} : { input }),
      maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout,
    });
    return result;
  } catch {
    return null;
  }
}

function probeSucceeded(result) {
  return (
    result !== null &&
    result.error === undefined &&
    result.signal === null &&
    result.status === 0 &&
    result.stderr === "" &&
    typeof result.stdout === "string"
  );
}

function probeOutputIsSafe(result, redactionValues) {
  return !(
    result !== null &&
    containsExactValue(
      `${typeof result.stdout === "string" ? result.stdout : ""}\n${
        typeof result.stderr === "string" ? result.stderr : ""
      }`,
      redactionValues,
    )
  );
}

function createProbeEnvironment(credentialPolicy, redactionValues) {
  try {
    if (
      typeof credentialPolicy.scrubEnvironment !== "function" ||
      !Array.isArray(credentialPolicy.sensitiveNames) ||
      !isPlainObject(credentialPolicy.spawnEnvironmentPartitions) ||
      !isPlainObject(credentialPolicy.scrubbedShellContract) ||
      !Array.isArray(credentialPolicy.scrubbedShellContract.allow) ||
      credentialPolicy.spawnEnvironmentPartitions.statusProbe !==
        "scrubbedEnvironment" ||
      credentialPolicy.spawnEnvironmentPartitions.validatorProbe !==
        "scrubbedEnvironment"
    ) {
      throw PRIVATE_REJECTION;
    }
    const ambient = {};
    for (const name of credentialPolicy.scrubbedShellContract.allow) {
      const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "string") {
        throw PRIVATE_REJECTION;
      }
      ambient[name] = descriptor.value;
    }
    const scrubbed = credentialPolicy.scrubEnvironment(ambient);
    const environment = Object.create(null);
    for (const [name, value] of Object.entries(scrubbed)) {
      if (
        credentialPolicy.sensitiveNames.includes(name) ||
        typeof value !== "string"
      ) {
        throw PRIVATE_REJECTION;
      }
      if (containsExactValue(value, redactionValues)) continue;
      environment[name] = value;
    }
    return Object.freeze(environment);
  } catch {
    throwFailure("package", RECOVERY.package, {}, redactionValues);
  }
}

function sandboxEnvironment(redactionValues) {
  const result = {};
  try {
    for (const name of SANDBOX_CONTROL_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
      if (descriptor === undefined || descriptor.value === "") {
        result[name] = undefined;
      } else if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length > 4096 ||
        CONTROL.test(descriptor.value) ||
        containsExactValue(descriptor.value, redactionValues)
      ) {
        throw PRIVATE_REJECTION;
      } else {
        result[name] = descriptor.value;
      }
    }
    return Object.freeze(result);
  } catch {
    throwFailure("profile", RECOVERY.profile, {}, redactionValues);
  }
}

function validatorEnvironment(probeEnvironment, selectionEnvironment) {
  const result = Object.assign(Object.create(null), probeEnvironment);
  for (const name of SANDBOX_CONTROL_NAMES) {
    if (selectionEnvironment[name] !== undefined) {
      result[name] = selectionEnvironment[name];
    }
  }
  return Object.freeze(result);
}

function createPersonalProjection(config, redactionValues) {
  const input = {
    schemaVersion: config.schemaVersion,
    generation: config.generation,
    providerSelection: config.providerSelection,
    joinedUrls: {},
  };
  const result = runProbe(
    PROJECTION_FACTORY_EXECUTABLE,
    [],
    Object.freeze({}),
    `${JSON.stringify(input)}\n`,
    5_000,
  );
  if (
    !probeOutputIsSafe(result, redactionValues) ||
    !probeSucceeded(result) ||
    result.stdout.length === 0
  ) {
    throw new ProjectionCallbackFailure("provider-projection");
  }
  try {
    return deepFreeze(JSON.parse(result.stdout));
  } catch {
    throw new ProjectionCallbackFailure("provider-projection");
  }
}

function selectedProviderIds(projection) {
  try {
    if (
      !isPlainObject(projection) ||
      projection.mode !== "shopify-gateway" ||
      !Array.isArray(projection.providers)
    ) {
      throw PRIVATE_REJECTION;
    }
    const result = projection.providers.map((provider) => provider.providerId);
    if (
      result.length === 0 ||
      result.some((providerId) => !PROVIDER_IDS.includes(providerId)) ||
      new Set(result).size !== result.length
    ) {
      throw PRIVATE_REJECTION;
    }
    return result;
  } catch {
    throw new ProjectionCallbackFailure("provider-projection");
  }
}

function createProjectionCallback(baseCandidate, config, providerHandoff) {
  return (snapshot) => {
    let providerProjection;
    if (EXPECTED_PROVIDER_MODE === "personal") {
      providerProjection = createPersonalProjection(config, []);
    } else {
      let result;
      try {
        result = providerHandoff.composeShopifyProviderHandoff({
          baseCandidate,
          currentSettings: snapshot.currentSettings,
          currentModels: snapshot.currentModels,
          ...(Object.hasOwn(snapshot, "ownershipState")
            ? { ownershipState: snapshot.ownershipState }
            : {}),
        });
      } catch {
        throw new ProjectionCallbackFailure("provider-projection");
      }
      try {
        if (
          !isPlainObject(result) ||
          !Object.hasOwn(result, "providerProjection")
        ) {
          throw PRIVATE_REJECTION;
        }
        providerProjection = result.providerProjection;
      } catch {
        throw new ProjectionCallbackFailure("provider-projection");
      }
      for (const providerId of selectedProviderIds(providerProjection)) {
        if (snapshot.currentAuthProviderIds.includes(providerId)) {
          throw new ProjectionCallbackFailure("provider-auth", { providerId });
        }
      }
    }
    return { providerProjection };
  };
}

function classifyReconciliationFailure(error, redactionValues) {
  if (error.kind === "provider-projection-conflict") {
    throwFailure(
      "provider-projection",
      RECOVERY.projection,
      PROVIDER_IDS.includes(error.providerId)
        ? { providerId: error.providerId }
        : {},
      redactionValues,
    );
  }
  throwFailure("state", RECOVERY.state, {}, redactionValues);
}

function packagePreflight(configArtifact, config, redactionValues) {
  try {
    const digest = createHash("sha256")
      .update(configArtifact.bytes)
      .digest("hex");
    const statusConfig = readBounded(STATUS_MANAGED_CONFIG_PATH);
    const manifest = JSON.parse(
      readBounded(
        path.join(
          PI_PACKAGE_ROOT,
          "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
        ),
      ).toString("utf8"),
    );
    const executable = fs.statSync(path.join(PI_PACKAGE_ROOT, "bin/pi"));
    if (
      digest !== MANAGED_CONFIG_DIGEST ||
      !statusConfig.equals(configArtifact.bytes) ||
      !isPlainObject(manifest) ||
      manifest.name !== "@earendil-works/pi-coding-agent" ||
      manifest.version !== EXPECTED_PI_VERSION ||
      !executable.isFile() ||
      (executable.mode & 0o111) === 0 ||
      !fs.statSync(MCP_PROBE_MODULE).isFile() ||
      (fs.statSync(STATUS_EXECUTABLE).mode & 0o111) === 0 ||
      config.providerSelection.mode !== EXPECTED_PROVIDER_MODE
    ) {
      throw PRIVATE_REJECTION;
    }
  } catch {
    throwFailure("package", RECOVERY.package, {}, redactionValues);
  }
}

function validateSandboxSelectionShape(selection, redactionValues) {
  try {
    if (
      !exactDataKeys(selection, [
        "schemaVersion",
        "state",
        "profile",
        "listenPorts",
        "piTools",
        "source",
        "rollback",
        "disableReason",
        "accepted",
      ]) ||
      selection.schemaVersion !== 1 ||
      !["disabled", "audit", "enforced"].includes(selection.state) ||
      (selection.state === "disabled"
        ? selection.profile !== null
        : !["pi-audit", "pi-managed", "pi-review"].includes(
            selection.profile,
          )) ||
      !Array.isArray(selection.listenPorts) ||
      !isPlainObject(selection.source) ||
      !isPlainObject(selection.accepted)
    ) {
      throw PRIVATE_REJECTION;
    }
    return deepFreeze(selection);
  } catch {
    throwFailure("profile", RECOVERY.profile, {}, redactionValues);
  }
}

function sandboxDiagnostic(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      SANDBOX_DIAGNOSTICS.has(descriptor.value)
    ) {
      return descriptor.value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function throwSandboxFailure(error, redactionValues) {
  const diagnostic = sandboxDiagnostic(error);
  if (diagnostic !== undefined) {
    throwFailure("profile", RECOVERY.profile, { diagnostic }, redactionValues);
  }
  throwFailure("profile", RECOVERY.profile, {}, redactionValues);
}

function readAdminKey(probeEnvironment, redactionValues) {
  const result = runProbe(
    KEYCHAIN_EXECUTABLE,
    ["find-generic-password", "-s", "mcpproxy", "-a", "mcpproxy-api-key", "-w"],
    probeEnvironment,
    undefined,
    5_000,
  );
  if (
    !probeSucceeded(result) ||
    !/^[^\0\r\n]+(?:\r?\n)?$/.test(result.stdout)
  ) {
    throwFailure("mcpproxy", RECOVERY.mcpproxy, {}, redactionValues);
  }
  return result.stdout.replace(/\r?\n$/, "");
}

function mcpPreflight(config, probeEnvironment, redactionValues) {
  const adminKey = readAdminKey(probeEnvironment, redactionValues);
  const exactValues = Object.freeze([...redactionValues, adminKey]);
  const result = runProbe(
    NODE_EXECUTABLE,
    [MCP_PROBE_MODULE],
    probeEnvironment,
    `${JSON.stringify({
      adminApiKey: adminKey,
      endpoint: config.mcpEndpoint,
    })}\n`,
  );
  if (!probeOutputIsSafe(result, exactValues) || !probeSucceeded(result)) {
    throwFailure("mcpproxy", RECOVERY.mcpproxy, {}, exactValues);
  }
  try {
    const response = JSON.parse(result.stdout);
    if (!exactDataKeys(response, ["ready"]) || response.ready !== true) {
      throw PRIVATE_REJECTION;
    }
  } catch {
    throwFailure("mcpproxy", RECOVERY.mcpproxy, {}, exactValues);
  }
  return adminKey;
}

function cavememPreflight(request, probeEnvironment, redactionValues) {
  try {
    if (!fs.statSync(request.cavememDataDir).isDirectory()) {
      throw PRIVATE_REJECTION;
    }
  } catch {
    throwFailure("cavemem", RECOVERY.cavemem, {}, redactionValues);
  }
  const environment = Object.freeze({
    ...probeEnvironment,
    CAVEMEM_DATA_DIR: request.cavememDataDir,
    ...(containsExactValue("1", redactionValues) ? {} : { NO_COLOR: "1" }),
  });
  const result = runProbe(
    CAVEMEM_EXECUTABLE,
    ["worker", "status"],
    environment,
  );
  if (
    !probeOutputIsSafe(result, redactionValues) ||
    !probeSucceeded(result) ||
    !/^running \(pid [1-9][0-9]*\)\n$/.test(result.stdout)
  ) {
    throwFailure("cavemem", RECOVERY.cavemem, {}, redactionValues);
  }
}

function extensionPreflight(
  request,
  config,
  sandboxSelection,
  probeEnvironment,
  selectionEnvironment,
  redactionValues,
) {
  const result = runProbe(
    STATUS_EXECUTABLE,
    ["--json"],
    validatorEnvironment(probeEnvironment, selectionEnvironment),
    `${JSON.stringify({
      schemaVersion: 1,
      agentDir: request.agentDir,
      cavememDataDir: request.cavememDataDir,
    })}\n`,
    45_000,
  );
  if (!probeOutputIsSafe(result, redactionValues) || !probeSucceeded(result)) {
    throwFailure("extensions", RECOVERY.extensions, {}, redactionValues);
  }
  try {
    const response = JSON.parse(result.stdout);
    if (
      !exactDataKeys(response, [
        "generation",
        "piVersion",
        "providerMode",
        "sandboxState",
        "profile",
        "mcpEndpoint",
        "mcpReady",
        "cavememDataDir",
        "cavememReady",
        "extensions",
        "drift",
        "lsp",
        "status",
        "issues",
      ]) ||
      response.generation !== config.generation ||
      response.piVersion !== EXPECTED_PI_VERSION ||
      response.providerMode !== EXPECTED_PROVIDER_MODE ||
      response.sandboxState !== sandboxSelection.state ||
      response.profile !== sandboxSelection.profile ||
      response.mcpEndpoint !== config.mcpEndpoint ||
      response.cavememDataDir !== request.cavememDataDir ||
      !Array.isArray(response.drift) ||
      !isPlainObject(response.lsp) ||
      !Array.isArray(response.issues) ||
      !isPlainObject(response.extensions) ||
      Object.keys(response.extensions).length !==
        config.extensionOrder.length
    ) {
      throw PRIVATE_REJECTION;
    }
    const unavailableExtension = config.extensionOrder.find(
      (name) => !VERSION.test(response.extensions[name]),
    );
    if (unavailableExtension !== undefined) {
      const status = response.extensions[unavailableExtension];
      throwFailure(
        "extensions",
        RECOVERY.extensions,
        {
          diagnostic:
            status === "unavailable"
              ? `required extension ${unavailableExtension} is unavailable`
              : `required extension ${unavailableExtension} is incompatible`,
          extensionName: unavailableExtension,
        },
        redactionValues,
      );
    }
    if (response.mcpReady !== true) {
      throwFailure("mcpproxy", RECOVERY.mcpproxy, {}, redactionValues);
    }
    if (response.cavememReady !== true) {
      throwFailure("cavemem", RECOVERY.cavemem, {}, redactionValues);
    }
  } catch (error) {
    if (error instanceof ManagedLaunchError) throw error;
    throwFailure("extensions", RECOVERY.extensions, {}, redactionValues);
  }
}

function validateValidatorReport(value, generation) {
  if (
    !exactDataKeys(value, ["generation", "gates"]) ||
    value.generation !== generation ||
    !Array.isArray(value.gates) ||
    value.gates.length !== VALIDATOR_GATE_NAMES.length
  ) {
    throw PRIVATE_REJECTION;
  }
  for (let index = 0; index < VALIDATOR_GATE_NAMES.length; index += 1) {
    const gate = value.gates[index];
    if (
      !exactDataKeys(gate, ["name", "status", "evidence", "recovery"]) ||
      gate.name !== VALIDATOR_GATE_NAMES[index] ||
      !["pass", "fail", "manual-required"].includes(gate.status) ||
      !Array.isArray(gate.evidence) ||
      gate.evidence.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length > 4096 ||
          CONTROL.test(entry),
      ) ||
      typeof gate.recovery !== "string" ||
      gate.recovery.length > 4096 ||
      CONTROL.test(gate.recovery)
    ) {
      throw PRIVATE_REJECTION;
    }
  }
  return value;
}

function validatorPreflight(
  request,
  config,
  probeEnvironment,
  selectionEnvironment,
  redactionValues,
) {
  const result = runProbe(
    VALIDATOR_EXECUTABLE,
    ["--check"],
    validatorEnvironment(probeEnvironment, selectionEnvironment),
    `${JSON.stringify({
      schemaVersion: 1,
      agentDir: request.agentDir,
      cavememDataDir: request.cavememDataDir,
    })}\n`,
    45_000,
  );
  if (
    !probeOutputIsSafe(result, redactionValues) ||
    result === null ||
    result.error !== undefined ||
    result.signal !== null ||
    ![0, 1].includes(result.status) ||
    result.stderr !== "" ||
    typeof result.stdout !== "string" ||
    result.stdout.length === 0
  ) {
    throwFailure("validator", RECOVERY.validator, {}, redactionValues);
  }
  let report;
  try {
    report = validateValidatorReport(
      JSON.parse(result.stdout),
      config.generation,
    );
  } catch {
    throwFailure("validator", RECOVERY.validator, {}, redactionValues);
  }
  const failed = report.gates.find((gate) => gate.status === "fail");
  if (failed !== undefined) {
    const recovery = GATE_RECOVERY[failed.name] ?? RECOVERY.validator;
    throwFailure("validator", recovery, {}, redactionValues);
  }
  if (result.status !== 0) {
    throwFailure("validator", RECOVERY.validator, {}, redactionValues);
  }
}

function closedHandoff(
  request,
  runtimeSecrets,
  reconciliation,
  sandboxSelection,
) {
  const result = {
    schemaVersion: 1,
    agentDir: request.agentDir,
    cavememDataDir: request.cavememDataDir,
    generation: reconciliation.generation,
    providerMode: EXPECTED_PROVIDER_MODE,
    reconciliation,
    sandboxSelection,
    validatedStages: VALIDATED_STAGES,
  };
  Object.defineProperty(result, "runtimeSecrets", {
    enumerable: true,
    get: () => runtimeSecrets,
  });
  Object.defineProperty(result, "toJSON", {
    value() {
      throw new Error("managed launch handoff is not serializable");
    },
  });
  return deepFreeze(result);
}

export async function prepareManagedLaunch(input) {
  const request = snapshotInvocation(input);
  const configArtifact = loadManagedConfig();
  let credentialResolver;
  let credentialPolicy;
  let reconciler;
  let providerHandoff;
  let sandboxResolver;
  let sandboxValidator;
  try {
    [
      credentialResolver,
      credentialPolicy,
      reconciler,
      sandboxResolver,
      sandboxValidator,
    ] =
      await Promise.all([
        import(pathToFileURL(CREDENTIAL_RESOLVER_MODULE).href),
        import(pathToFileURL(CREDENTIAL_POLICY_MODULE).href),
        import(pathToFileURL(RECONCILER_MODULE).href),
        import(pathToFileURL(SANDBOX_RESOLVER_MODULE).href),
        import(pathToFileURL(SANDBOX_VALIDATOR_MODULE).href),
      ]);
    if (
      typeof credentialResolver.resolveProviderRuntimeSecrets !== "function" ||
      credentialResolver.resolveProviderRuntimeSecrets.length !== 0 ||
      typeof reconciler.reconcileManagedStateWithProviderProjection !==
        "function" ||
      reconciler.reconcileManagedStateWithProviderProjection.length !== 1 ||
      typeof sandboxResolver.resolveSandboxSelectionFromEnvironment !==
        "function" ||
      sandboxResolver.resolveSandboxSelectionFromEnvironment.length !== 0 ||
      typeof sandboxValidator.validateSandboxSelection !== "function" ||
      sandboxValidator.validateSandboxSelection.length !== 0
    ) {
      throw PRIVATE_REJECTION;
    }
    if (EXPECTED_PROVIDER_MODE === "shopify-gateway") {
      providerHandoff = await import(
        pathToFileURL(PROVIDER_HANDOFF_MODULE).href
      );
      if (
        typeof providerHandoff.composeShopifyProviderHandoff !== "function" ||
        providerHandoff.composeShopifyProviderHandoff.length !== 0
      ) {
        throw PRIVATE_REJECTION;
      }
    } else if (PROVIDER_HANDOFF_MODULE !== "") {
      throw PRIVATE_REJECTION;
    }
  } catch {
    throwFailure("package", RECOVERY.package);
  }

  let resolverOutcome;
  try {
    resolverOutcome = validateResolverOutcome(
      await credentialResolver.resolveProviderRuntimeSecrets(),
    );
  } catch (error) {
    if (error instanceof ManagedLaunchError) throw error;
    const operation = resolverOperation(error);
    throwFailure(
      "provider-resolver",
      RECOVERY.resolver,
      operation === undefined ? {} : { operation },
    );
  }
  const runtimeSecrets = resolverOutcome.runtimeSecrets;
  const runtimeRedactionValues = snapshotSensitiveValues(runtimeSecrets);
  const redactionValues = mergeExactValues(
    runtimeRedactionValues,
    snapshotAmbientSensitiveValues(credentialPolicy, runtimeRedactionValues),
  );
  if (
    containsExactValue(request.agentDir, redactionValues) ||
    containsExactValue(request.cavememDataDir, redactionValues)
  ) {
    throw PRIVATE_REJECTION;
  }

  let reconciliation;
  try {
    reconciliation =
      await reconciler.reconcileManagedStateWithProviderProjection({
        agentDir: request.agentDir,
        managedConfig: configArtifact.value,
        lockTimeoutMs: LOCK_TIMEOUT_MS,
        projectionCallback: createProjectionCallback(
          resolverOutcome.baseCandidate,
          configArtifact.value,
          providerHandoff,
        ),
      });
  } catch (error) {
    if (error instanceof ProjectionCallbackFailure) {
      const recovery =
        error.component === "provider-auth"
          ? RECOVERY.auth
          : RECOVERY.projection;
      throwFailure(error.component, recovery, error.details, redactionValues);
    }
    throwFailure("state", RECOVERY.state, {}, redactionValues);
  }
  if (!isPlainObject(reconciliation) || reconciliation.ok !== true) {
    if (
      isPlainObject(reconciliation) &&
      reconciliation.ok === false &&
      isPlainObject(reconciliation.error) &&
      typeof reconciliation.error.kind === "string"
    ) {
      classifyReconciliationFailure(reconciliation.error, redactionValues);
    }
    throwFailure("state", RECOVERY.state, {}, redactionValues);
  }
  deepFreeze(reconciliation);

  packagePreflight(configArtifact, configArtifact.value, redactionValues);
  const selectionEnvironment = sandboxEnvironment(redactionValues);
  let sandboxSelection;
  let rawSandboxSelection;
  try {
    rawSandboxSelection =
      sandboxResolver.resolveSandboxSelectionFromEnvironment(
        selectionEnvironment,
      );
  } catch (error) {
    throwSandboxFailure(error, redactionValues);
  }
  try {
    sandboxSelection = validateSandboxSelectionShape(
      rawSandboxSelection,
      redactionValues,
    );
    try {
      sandboxValidator.validateSandboxSelection(sandboxSelection);
    } catch {
      throwFailure("profile", RECOVERY.profile, {}, redactionValues);
    }
  } catch (error) {
    if (error instanceof ManagedLaunchError) throw error;
    throwFailure("profile", RECOVERY.profile, {}, redactionValues);
  }
  const probeEnvironment = createProbeEnvironment(
    credentialPolicy,
    redactionValues,
  );
  const adminKey = mcpPreflight(
    configArtifact.value,
    probeEnvironment,
    redactionValues,
  );
  const probeRedactionValues = Object.freeze([...redactionValues, adminKey]);
  cavememPreflight(request, probeEnvironment, probeRedactionValues);
  extensionPreflight(
    request,
    configArtifact.value,
    sandboxSelection,
    probeEnvironment,
    selectionEnvironment,
    probeRedactionValues,
  );
  validatorPreflight(
    request,
    configArtifact.value,
    probeEnvironment,
    selectionEnvironment,
    probeRedactionValues,
  );
  return closedHandoff(
    request,
    runtimeSecrets,
    reconciliation,
    sandboxSelection,
  );
}
