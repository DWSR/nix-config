import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";

const MANAGED_CONFIG_PATH = "__PI_AGENT_STATUS_MANAGED_CONFIG__";
const EXTENSION_MANIFEST_PATH = "__PI_AGENT_STATUS_EXTENSION_MANIFEST__";
const CREDENTIAL_POLICY_MODULE = "__PI_AGENT_STATUS_CREDENTIAL_POLICY__";
const SANDBOX_RESOLVER_MODULE = "__PI_AGENT_STATUS_SANDBOX_RESOLVER__";
const RECONCILER_MODULE = "__PI_AGENT_STATUS_RECONCILER__";
const MCP_PROBE_MODULE = fileURLToPath(
  new URL("./mcp-status-probe.mjs", import.meta.url),
);
const EXTENSION_PROBE_MODULE = fileURLToPath(
  new URL("./extension-status-probe.mjs", import.meta.url),
);
const NODE_EXECUTABLE = "__PI_AGENT_STATUS_NODE__";
const EXTENSION_PACKAGE_ROOT = "__PI_AGENT_STATUS_EXTENSION_PACKAGE_ROOT__";
const PROBE_CWD = "__PI_AGENT_STATUS_PROBE_CWD__";
const KEYCHAIN_EXECUTABLE = "__PI_AGENT_STATUS_KEYCHAIN__";
const EXPECTED_PI_VERSION = "__PI_AGENT_STATUS_PI_VERSION__";
const EXPECTED_SANDBOX_DEFAULT = "__PI_AGENT_STATUS_SANDBOX_DEFAULT__";
const MANAGED_SETTING_KEYS = Object.freeze([
  "defaultModel",
  "defaultThinkingLevel",
  "shellPath",
  "installTelemetry",
  "selfUpdate",
  "unmanagedPackages",
]);
const MCP_RECOVERY = "restart mcpproxy or repair the declared upstream";
const AGENTMEMORY_RECOVERY =
  "restart the AgentMemory daemon and verify its authenticated health route";
const EXTENSION_RECOVERY =
  "rebuild pi-agent-extensions and activate the managed generation";
const LSP_RECOVERY =
  "rebuild the configured language server and activate the managed generation";
const RECONCILIATION_RECOVERY =
  "repair managed Pi state and rerun reconciliation";
const INPUT_LIMIT_BYTES = 64 * 1024;
const STATE_FILE_LIMIT_BYTES = 16 * 1024 * 1024;
const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*$/;
const VALUE_HASH = /^sha256:[0-9a-f]{64}$/;
const HUMAN_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const REDACTION_MARKER = "[REDACTED]";
const STATUS_KEYS = Object.freeze([
  "generation",
  "piVersion",
  "providerMode",
  "sandboxState",
  "profile",
  "mcpEndpoint",
  "mcpReady",
  "agentMemoryUrl",
  "agentMemoryReady",
  "extensions",
  "drift",
  "lsp",
  "status",
  "issues",
]);
const ISSUE_KEYS = Object.freeze(["component", "state", "recovery"]);
const PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "groq",
  "xai",
]);
const OWNERSHIP_FILES = Object.freeze(["models.json", "settings.json"]);
const MCP_PROBE_TIMEOUT_MS = 15_000;
const STATUS_MAP_LIMIT = 128;
const STATUS_STRING_LIMIT = 4_096;
const ENVIRONMENT_PROTOTYPE_LIMIT = 32;
const DRIFT_LABELS = new Set([
  "models.invalid",
  "models.missing",
  "models.providers.invalid",
  "ownership.generation",
  "ownership.invalid",
  "ownership.missing",
  "ownership.transaction",
  "settings.invalid",
  "settings.missing",
  ...MANAGED_SETTING_KEYS.flatMap((key) => [
    `settings.${key}.desired`,
    `settings.${key}.missing`,
    `settings.${key}.ownership-missing`,
    `settings.${key}.value`,
  ]),
  ...PROVIDER_IDS.flatMap((providerId) => [
    `models.provider.${providerId}.missing`,
    `models.provider.${providerId}.ownership-missing`,
    `models.provider.${providerId}.stale-ownership`,
    `models.provider.${providerId}.value`,
  ]),
]);

let runtimeModulesPromise;
const STATUS_REJECTION = Symbol();
const TRUSTED_ENVIRONMENT_PROTOTYPES = captureEnvironmentPrototypes(process.env);
const CREDENTIAL_POLICY = await import(
  pathToFileURL(CREDENTIAL_POLICY_MODULE).href
);
const AUTHORITATIVE_SENSITIVE_NAMES = snapshotSensitiveNames(
  CREDENTIAL_POLICY.sensitiveNames,
);

function statusError(message = "status rejection") {
  return STATUS_REJECTION;
}

function captureEnvironmentPrototypes(environment) {
  try {
    const prototypes = new WeakSet();
    let current = Object.getPrototypeOf(environment);
    let depth = 0;
    while (current !== null) {
      if (
        depth >= ENVIRONMENT_PROTOTYPE_LIMIT ||
        typeof current !== "object" ||
        types.isProxy(current)
      ) {
        throw STATUS_REJECTION;
      }
      prototypes.add(current);
      current = Object.getPrototypeOf(current);
      depth += 1;
    }
    return prototypes;
  } catch {
    throw STATUS_REJECTION;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key) => typeof key !== "string") ||
    [...keys].sort().some((key, index) => key !== wanted[index])
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function snapshotClosedDataObject(value, expected, message) {
  if (!hasExactKeys(value, expected)) throw statusError(message);
  const result = {};
  for (const key of expected) {
    result[key] = Object.getOwnPropertyDescriptor(value, key).value;
  }
  return Object.freeze(result);
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function failStatusOutput() {
  throw statusError("managed status output invalid");
}

function snapshotDataArray(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    failStatusOutput();
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    keys.some((key) => typeof key !== "string") ||
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > STATUS_MAP_LIMIT ||
    keys.length !== lengthDescriptor.value + 1
  ) {
    failStatusOutput();
  }
  const snapshot = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      failStatusOutput();
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function snapshotSensitiveNames(value) {
  const names = snapshotDataArray(value);
  if (
    names.length === 0 ||
    names.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw statusError("managed status dependency invalid");
  }
  return Object.freeze(names);
}

function snapshotStatusMap(value, kind, expectedNames) {
  if (!isPlainObject(value)) failStatusOutput();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > STATUS_MAP_LIMIT ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        key === "toJSON" ||
        !SAFE_NAME.test(key) ||
        HUMAN_CONTROL.test(key),
    )
  ) {
    failStatusOutput();
  }
  const names = [...keys].sort(compareText);
  if (
    expectedNames !== undefined &&
    !sameStrings(names, [...expectedNames].sort(compareText))
  ) {
    failStatusOutput();
  }
  const snapshot = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      failStatusOutput();
    }
    const item = descriptor.value;
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 128 ||
      HUMAN_CONTROL.test(item) ||
      (kind === "extension" && item !== "unavailable" && !VERSION.test(item)) ||
      (kind === "lsp" && item !== "ready" && item !== "missing")
    ) {
      failStatusOutput();
    }
    Object.defineProperty(snapshot, name, {
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return snapshot;
}

function snapshotIssue(value) {
  const issue = snapshotClosedDataObject(
    value,
    ISSUE_KEYS,
    "managed status output invalid",
  );
  const { component, state, recovery } = issue;
  if (
    typeof component !== "string" ||
    typeof state !== "string" ||
    typeof recovery !== "string"
  ) {
    failStatusOutput();
  }
  if (component === "extensions") {
    if (state !== "degraded" || recovery !== EXTENSION_RECOVERY)
      failStatusOutput();
  } else if (component === "mcp") {
    if (state !== "degraded" || recovery !== MCP_RECOVERY) failStatusOutput();
  } else if (component === "agentmemory") {
    if (
      !["degraded", "missing"].includes(state) ||
       recovery !== AGENTMEMORY_RECOVERY
    ) {
      failStatusOutput();
    }
  } else if (component === "reconciliation") {
    if (state !== "drifted" || recovery !== RECONCILIATION_RECOVERY)
      failStatusOutput();
  } else if (component.startsWith("lsp:")) {
    const name = component.slice(4);
    if (
      !SAFE_NAME.test(name) ||
      state !== "missing" ||
      recovery !== LSP_RECOVERY
    )
      failStatusOutput();
  } else {
    failStatusOutput();
  }
  return { component, state, recovery };
}

function snapshotStatusV1(value, expected = {}) {
  try {
    const status = snapshotClosedDataObject(
      value,
      STATUS_KEYS,
      "managed status output invalid",
    );
    if (
      typeof status.generation !== "string" ||
      status.generation.length === 0 ||
      status.generation.length > 256 ||
      !SAFE_IDENTIFIER.test(status.generation) ||
      typeof status.piVersion !== "string" ||
      status.piVersion.length > 128 ||
      !VERSION.test(status.piVersion) ||
      !["personal", "shopify-gateway"].includes(status.providerMode) ||
      !["disabled", "audit", "enforced"].includes(status.sandboxState) ||
      (status.sandboxState === "disabled"
        ? status.profile !== null
        : typeof status.profile !== "string" ||
          status.profile.length > 128 ||
          !SAFE_NAME.test(status.profile)) ||
      typeof status.mcpEndpoint !== "string" ||
      !/^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])\/mcp$/.test(
        status.mcpEndpoint,
      ) ||
      typeof status.mcpReady !== "boolean" ||
       typeof status.agentMemoryUrl !== "string" ||
       status.agentMemoryUrl.length === 0 ||
       status.agentMemoryUrl.length > STATUS_STRING_LIMIT ||
       !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(status.agentMemoryUrl) ||
       HUMAN_CONTROL.test(status.agentMemoryUrl) ||
       typeof status.agentMemoryReady !== "boolean" ||
      !["complete", "degraded", "drifted"].includes(status.status)
    ) {
      failStatusOutput();
    }
    if (
      (expected.generation !== undefined &&
        status.generation !== expected.generation) ||
      (expected.piVersion !== undefined &&
        status.piVersion !== expected.piVersion) ||
      (expected.providerMode !== undefined &&
        status.providerMode !== expected.providerMode) ||
      (expected.mcpEndpoint !== undefined &&
        status.mcpEndpoint !== expected.mcpEndpoint)
    ) {
      failStatusOutput();
    }

    const extensions = snapshotStatusMap(
      status.extensions,
      "extension",
      expected.extensionNames,
    );
    if (Object.keys(extensions).length === 0) failStatusOutput();
    const lsp = snapshotStatusMap(status.lsp, "lsp", expected.lspNames);
    const drift = snapshotDataArray(status.drift);
    if (
      drift.some(
        (label) => typeof label !== "string" || !DRIFT_LABELS.has(label),
      ) ||
      new Set(drift).size !== drift.length
    ) {
      failStatusOutput();
    }
    drift.sort(compareText);

    const issues = snapshotDataArray(status.issues)
      .map(snapshotIssue)
      .sort((left, right) => compareText(left.component, right.component));
    const issueComponents = issues.map(({ component }) => component);
    if (new Set(issueComponents).size !== issueComponents.length)
      failStatusOutput();
    const hasIssue = (component) => issueComponents.includes(component);
    const extensionReady = Object.values(extensions).every(
      (version) => version !== "unavailable",
    );
    const missingLsp = Object.entries(lsp)
      .filter(([, state]) => state === "missing")
      .map(([name]) => `lsp:${name}`)
      .sort(compareText);
    const lspIssues = issueComponents
      .filter((component) => component.startsWith("lsp:"))
      .sort(compareText);
    if (
      hasIssue("mcp") === status.mcpReady ||
       hasIssue("agentmemory") === status.agentMemoryReady ||
      hasIssue("extensions") === extensionReady ||
      !sameStrings(lspIssues, missingLsp) ||
      hasIssue("reconciliation") !== (drift.length !== 0)
    ) {
      failStatusOutput();
    }
    const expectedStatus =
      drift.length !== 0
        ? "drifted"
        : issues.length === 0
          ? "complete"
          : "degraded";
    if (status.status !== expectedStatus) failStatusOutput();

    return {
      generation: status.generation,
      piVersion: status.piVersion,
      providerMode: status.providerMode,
      sandboxState: status.sandboxState,
      profile: status.profile,
      mcpEndpoint: status.mcpEndpoint,
      mcpReady: status.mcpReady,
       agentMemoryUrl: status.agentMemoryUrl,
       agentMemoryReady: status.agentMemoryReady,
      extensions,
      drift,
      lsp,
      status: status.status,
      issues,
    };
  } catch {
    failStatusOutput();
  }
}

function readJson(file, maximumBytes = STATE_FILE_LIMIT_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximumBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function validateManagedConfig(config) {
  if (
    !isPlainObject(config) ||
    config.schemaVersion !== 1 ||
    typeof config.generation !== "string" ||
    !SAFE_IDENTIFIER.test(config.generation) ||
    !isPlainObject(config.settings) ||
    !MANAGED_SETTING_KEYS.every((key) => Object.hasOwn(config.settings, key)) ||
    !isPlainObject(config.providerSelection) ||
    !["personal", "shopify-gateway"].includes(config.providerSelection.mode) ||
    !Array.isArray(config.extensionOrder) ||
    config.extensionOrder.length === 0 ||
    config.extensionOrder.some(
      (name) => typeof name !== "string" || !SAFE_NAME.test(name),
    ) ||
    new Set(config.extensionOrder).size !== config.extensionOrder.length ||
    config.extensionManifest !== EXTENSION_MANIFEST_PATH ||
    !isPlainObject(config.lspExecutables) ||
     typeof config.mcpEndpoint !== "string" ||
    !/^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])\/mcp$/.test(
      config.mcpEndpoint,
     ) ||
     !isPlainObject(config.agentMemory) ||
     config.agentMemory.url !== "http://127.0.0.1:3111" ||
     typeof config.agentMemory.secretReference !== "string" ||
     config.agentMemory.secretReference.length === 0 ||
     config.sandboxDefault !== EXPECTED_SANDBOX_DEFAULT
  ) {
    throw statusError("managed status contract invalid");
  }
  if (
    config.providerSelection.mode === "shopify-gateway" &&
    (!Array.isArray(config.providerSelection.enabledRoles) ||
      config.providerSelection.enabledRoles.some(
        (name) =>
          typeof name !== "string" ||
          !SAFE_NAME.test(name) ||
          !PROVIDER_IDS.includes(name),
      ) ||
      new Set(config.providerSelection.enabledRoles).size !==
        config.providerSelection.enabledRoles.length)
  ) {
    throw statusError("managed status contract invalid");
  }
  for (const [name, executable] of Object.entries(config.lspExecutables)) {
    if (
      !SAFE_NAME.test(name) ||
      typeof executable !== "string" ||
      !path.isAbsolute(executable)
    ) {
      throw statusError("managed status contract invalid");
    }
  }
  return config;
}

function snapshotInput(input) {
  const snapshot = snapshotClosedDataObject(
    input,
     ["schemaVersion", "agentDir", "agentMemoryUrl", "agentMemorySecretReference"],
    "managed status input invalid",
  );
  if (snapshot.schemaVersion !== 1) {
    throw statusError("managed status input invalid");
  }
   for (const key of ["agentDir", "agentMemoryUrl", "agentMemorySecretReference"]) {
    const value = snapshot[key];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4_096 ||
       (key === "agentDir" && !path.isAbsolute(value)) ||
      HUMAN_CONTROL.test(value)
    ) {
      throw statusError("managed status input invalid");
    }
  }
  return Object.freeze({
    agentDir: snapshot.agentDir,
     agentMemoryUrl: snapshot.agentMemoryUrl,
     agentMemorySecretReference: snapshot.agentMemorySecretReference,
  });
}

function environmentSnapshot(environment, names) {
  try {
    if (
      environment === null ||
      typeof environment !== "object" ||
      types.isProxy(environment)
    ) {
      throw STATUS_REJECTION;
    }
    const requestedNames = [...new Set(names)];
    const foundNames = new Set();
    const result = Object.create(null);
    let current = environment;
    let depth = 0;
    while (current !== null) {
      if (
        depth >= ENVIRONMENT_PROTOTYPE_LIMIT ||
        typeof current !== "object" ||
        types.isProxy(current)
      ) {
        throw STATUS_REJECTION;
      }
      if (
        depth > 0 &&
        !TRUSTED_ENVIRONMENT_PROTOTYPES.has(current) &&
        Object.getOwnPropertyDescriptor(current, "constructor") !== undefined
      ) {
        throw STATUS_REJECTION;
      }
      for (const name of requestedNames) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor === undefined) continue;
        if (
          foundNames.has(name) ||
          depth > 0 ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string"
        ) {
          throw STATUS_REJECTION;
        }
        foundNames.add(name);
        Object.defineProperty(result, name, {
          enumerable: true,
          value: descriptor.value,
          writable: false,
        });
      }
      current = Object.getPrototypeOf(current);
      depth += 1;
    }
    return Object.freeze(result);
  } catch {
    throw STATUS_REJECTION;
  }
}

function sandboxEnvironment(environment) {
  return Object.freeze({
    PI_NONO:
      typeof environment.PI_NONO === "string" ? environment.PI_NONO : undefined,
    PI_NONO_PROFILE:
      typeof environment.PI_NONO_PROFILE === "string"
        ? environment.PI_NONO_PROFILE
        : undefined,
    PI_NONO_LISTEN_PORTS:
      typeof environment.PI_NONO_LISTEN_PORTS === "string"
        ? environment.PI_NONO_LISTEN_PORTS
        : undefined,
  });
}

async function loadRuntimeModules() {
  runtimeModulesPromise ??= Promise.all([
    Promise.resolve(CREDENTIAL_POLICY),
    import(pathToFileURL(SANDBOX_RESOLVER_MODULE).href),
    import(pathToFileURL(RECONCILER_MODULE).href),
  ]).then(([credentialPolicy, sandboxResolver, reconciler]) => ({
    credentialPolicy,
    sandboxResolver,
    reconciler,
  }));
  return runtimeModulesPromise;
}

function runProbe(executable, args, { environment, input, timeout }) {
  const options = {
    cwd: PROBE_CWD,
    encoding: "utf8",
    env: environment,
    maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
  };
  if (input !== undefined) options.input = input;
  return spawnSync(executable, args, options);
}

function readAdminKey(probeEnvironment) {
  let result;
  try {
    result = runProbe(
      KEYCHAIN_EXECUTABLE,
      [
        "find-generic-password",
        "-s",
        "mcpproxy",
        "-a",
        "mcpproxy-api-key",
        "-w",
      ],
      {
        environment: probeEnvironment,
        timeout: PROBE_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr !== "" ||
    typeof result.stdout !== "string" ||
    !/^[^\0\r\n]+(?:\r?\n)?$/.test(result.stdout)
  ) {
    return null;
  }
  return result.stdout.replace(/\r?\n$/, "");
}

function mcpIsReady(endpoint, adminKey, probeEnvironment) {
  if (adminKey === null) return false;
  let result;
  try {
    result = runProbe(NODE_EXECUTABLE, [MCP_PROBE_MODULE], {
      environment: probeEnvironment,
      input: `${JSON.stringify({ adminApiKey: adminKey, endpoint })}\n`,
      timeout: MCP_PROBE_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr !== ""
  ) {
    return false;
  }
  try {
    const response = JSON.parse(result.stdout);
    return hasExactKeys(response, ["ready"]) && response.ready === true;
  } catch {
    return false;
  }
}

function containsExactValue(value, redactionValues) {
  return redactionValues.some((secret) => value.includes(secret));
}

async function agentMemoryState(url, secret, redactionValues) {
  if (containsExactValue(url, redactionValues) || typeof secret !== "string" || secret.length === 0) {
    return { ready: false, state: "degraded" };
  }
  try {
    const response = await fetch(`${url}/agentmemory/health`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.json();
    const ready = response.ok && isPlainObject(body) && ["ok", "healthy"].includes(body.status);
    return { ready, state: ready ? "ready" : "degraded" };
  } catch {
    return { ready: false, state: "degraded" };
  }
}

function extensionState(config, probeEnvironment) {
  const canonicalManifestPath = path.join(
    EXTENSION_PACKAGE_ROOT,
    "share/pi-agent/extensions.json",
  );
  const unavailable = Object.fromEntries(
    [...config.extensionOrder]
      .sort(compareText)
      .map((name) => [name, "unavailable"]),
  );
  if (EXTENSION_MANIFEST_PATH !== canonicalManifestPath) {
    return { extensions: unavailable, ready: false };
  }
  let result;
  try {
    result = runProbe(NODE_EXECUTABLE, [EXTENSION_PROBE_MODULE], {
      environment: probeEnvironment,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0 ||
      result.stderr !== ""
    ) {
      return { extensions: unavailable, ready: false };
    }
    const response = JSON.parse(result.stdout);
    if (
      !hasExactKeys(response, [
        "extensionOrder",
        "extensions",
        "piVersion",
        "ready",
      ]) ||
      response.ready !== true ||
      response.piVersion !== EXPECTED_PI_VERSION ||
      !sameStrings(response.extensionOrder, config.extensionOrder) ||
      !hasExactKeys(response.extensions, config.extensionOrder)
    ) {
      return { extensions: unavailable, ready: false };
    }
    const extensions = {};
    for (const name of [...config.extensionOrder].sort(compareText)) {
      const version = response.extensions[name];
      if (typeof version !== "string" || !VERSION.test(version)) {
        return { extensions: unavailable, ready: false };
      }
      extensions[name] = version;
    }
    return { extensions, ready: true };
  } catch {
    return { extensions: unavailable, ready: false };
  }
}

function executableIsReady(executable) {
  try {
    const stat = fs.statSync(executable);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function lspState(config) {
  return Object.fromEntries(
    Object.keys(config.lspExecutables)
      .sort()
      .map((name) => [
        name,
        executableIsReady(config.lspExecutables[name]) ? "ready" : "missing",
      ]),
  );
}

function stateJson(agentDir, name) {
  const file = path.join(agentDir, name);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > STATE_FILE_LIMIT_BYTES) {
      return { state: "invalid", value: null };
    }
    return { state: "ready", value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return {
      state:
        error && typeof error === "object" && error.code === "ENOENT"
          ? "missing"
          : "invalid",
      value: null,
    };
  }
}

function valueHash(reconciler, value) {
  const result = reconciler.hashCanonicalJsonInternal(value);
  return result.ok ? result.valueHash : null;
}

function hasOnlyDataKeys(value, allowed, required = []) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === "string" && allowed.includes(key)) &&
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function validOwnershipState(value, expectedProviders) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "generation",
      "transaction",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    !SAFE_IDENTIFIER.test(value.generation) ||
    !["committed", "pending"].includes(value.transaction) ||
    !hasOnlyDataKeys(
      value.files,
      OWNERSHIP_FILES,
      expectedProviders.length === 0
        ? ["settings.json"]
        : ["models.json", "settings.json"],
    )
  ) {
    return false;
  }
  const settingPointers = MANAGED_SETTING_KEYS.map((key) => `/${key}`);
  const providerPointers = PROVIDER_IDS.map(
    (providerId) => `/providers/${providerId}`,
  );
  for (const [file, pointers] of [
    ["settings.json", settingPointers],
    ["models.json", providerPointers],
  ]) {
    if (!Object.hasOwn(value.files, file)) continue;
    const records = value.files[file];
    if (!hasOnlyDataKeys(records, pointers)) return false;
    for (const record of Object.values(records)) {
      if (
        !hasExactKeys(record, ["valueHash"]) ||
        typeof record.valueHash !== "string" ||
        !VALUE_HASH.test(record.valueHash)
      ) {
        return false;
      }
    }
  }
  return true;
}

function reconciliationDrift(config, agentDir, reconciler) {
  const drift = new Set();
  const expectedProviders =
    config.providerSelection.mode === "shopify-gateway"
      ? [...config.providerSelection.enabledRoles]
      : [];
  const settings = stateJson(agentDir, "settings.json");
  const modelsState = stateJson(agentDir, "models.json");
  const models =
    expectedProviders.length === 0 && modelsState.state === "missing"
      ? { state: "ready", value: {} }
      : modelsState;
  const ownership = stateJson(agentDir, "ownership.json");
  for (const [name, result] of [
    ["settings.json", settings],
    ["models.json", models],
    ["ownership.json", ownership],
  ]) {
    if (result.state !== "ready") {
      const component =
        name === "settings.json"
          ? "settings"
          : name === "models.json"
            ? "models"
            : "ownership";
      drift.add(`${component}.${result.state}`);
    }
  }
  if (
    settings.state !== "ready" ||
    models.state !== "ready" ||
    ownership.state !== "ready"
  ) {
    return [...drift].sort();
  }

  const ownershipValue = ownership.value;
  if (!validOwnershipState(ownershipValue, expectedProviders)) {
    drift.add("ownership.invalid");
    return [...drift].sort();
  }
  if (ownershipValue.generation !== config.generation) {
    drift.add("ownership.generation");
  }
  if (ownershipValue.transaction !== "committed") {
    drift.add("ownership.transaction");
  }

  const settingsRecords = isPlainObject(ownershipValue.files["settings.json"])
    ? ownershipValue.files["settings.json"]
    : {};
  if (!isPlainObject(settings.value)) {
    drift.add("settings.invalid");
  } else {
    for (const key of MANAGED_SETTING_KEYS) {
      const pointer = `/${key}`;
      const record = settingsRecords[pointer];
      const desiredHash = valueHash(reconciler, config.settings[key]);
      if (!isPlainObject(record) || !VALUE_HASH.test(record.valueHash)) {
        drift.add(`settings.${key}.ownership-missing`);
        continue;
      }
      if (desiredHash === null || record.valueHash !== desiredHash) {
        drift.add(`settings.${key}.desired`);
      }
      if (!Object.hasOwn(settings.value, key)) {
        drift.add(`settings.${key}.missing`);
      } else if (
        valueHash(reconciler, settings.value[key]) !== record.valueHash
      ) {
        drift.add(`settings.${key}.value`);
      }
    }
  }

  const providerRecords = isPlainObject(ownershipValue.files["models.json"])
    ? ownershipValue.files["models.json"]
    : {};
  const currentProviders = !isPlainObject(models.value)
    ? null
    : !Object.hasOwn(models.value, "providers")
      ? {}
      : isPlainObject(models.value.providers)
        ? models.value.providers
        : null;
  if (currentProviders === null) {
    drift.add("models.providers.invalid");
  } else {
    for (const providerId of expectedProviders) {
      const pointer = `/providers/${providerId}`;
      const record = providerRecords[pointer];
      if (!isPlainObject(record) || !VALUE_HASH.test(record.valueHash)) {
        drift.add(`models.provider.${providerId}.ownership-missing`);
        continue;
      }
      if (!Object.hasOwn(currentProviders, providerId)) {
        drift.add(`models.provider.${providerId}.missing`);
      } else if (
        valueHash(reconciler, currentProviders[providerId]) !== record.valueHash
      ) {
        drift.add(`models.provider.${providerId}.value`);
      }
    }
    for (const providerId of PROVIDER_IDS) {
      const pointer = `/providers/${providerId}`;
      if (
        Object.hasOwn(providerRecords, pointer) &&
        !expectedProviders.includes(providerId)
      ) {
        drift.add(`models.provider.${providerId}.stale-ownership`);
      }
    }
  }
  return [...drift].sort();
}

function exactValues(environment, sensitiveNames, adminKey) {
  const values = new Set();
  for (const name of sensitiveNames) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0) values.add(value);
  }
  if (typeof adminKey === "string" && adminKey.length > 0) values.add(adminKey);
  return [...values].sort(
    (left, right) => right.length - left.length || compareText(left, right),
  );
}

function captureEnvironmentExactValues() {
  try {
    return exactValues(
      environmentSnapshot(process.env, AUTHORITATIVE_SENSITIVE_NAMES),
      AUTHORITATIVE_SENSITIVE_NAMES,
      null,
    );
  } catch {
    return null;
  }
}

function collisionSafeDiagnostic(redactionValues) {
  const diagnostic = "pi-agent-status: invocation rejected\n";
  return Array.isArray(redactionValues) &&
    !containsExactValue(diagnostic, redactionValues)
    ? diagnostic
    : "";
}

function redactExact(value, values) {
  let result = value;
  for (const secret of values) {
    result = result.replaceAll(secret, REDACTION_MARKER);
  }
  if (containsExactValue(result, values)) {
    throw statusError("managed status redaction invalid");
  }
  return result;
}

function redactStatusMap(value, redactionValues) {
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    const redactedName = redactExact(name, redactionValues);
    if (Object.hasOwn(result, redactedName)) {
      throw statusError("managed status redaction invalid");
    }
    Object.defineProperty(result, redactedName, {
      enumerable: true,
      value: redactExact(item, redactionValues),
      writable: true,
    });
  }
  return result;
}

function redactStatusReport(status, redactionValues) {
  if (
    [...STATUS_KEYS, ...ISSUE_KEYS].some(
      (key) => redactExact(key, redactionValues) !== key,
    )
  ) {
    throw statusError("managed status redaction invalid");
  }
  return {
    generation: redactExact(status.generation, redactionValues),
    piVersion: redactExact(status.piVersion, redactionValues),
    providerMode: redactExact(status.providerMode, redactionValues),
    sandboxState: redactExact(status.sandboxState, redactionValues),
    profile:
      status.profile === null
        ? null
        : redactExact(status.profile, redactionValues),
    mcpEndpoint: redactExact(status.mcpEndpoint, redactionValues),
    mcpReady: status.mcpReady,
    agentMemoryUrl: redactExact(status.agentMemoryUrl, redactionValues),
    agentMemoryReady: status.agentMemoryReady,
    extensions: redactStatusMap(status.extensions, redactionValues),
    drift: status.drift.map((label) => redactExact(label, redactionValues)),
    lsp: redactStatusMap(status.lsp, redactionValues),
    status: redactExact(status.status, redactionValues),
    issues: status.issues.map((issue) => ({
      component: redactExact(issue.component, redactionValues),
      state: redactExact(issue.state, redactionValues),
      recovery: redactExact(issue.recovery, redactionValues),
    })),
  };
}

function addIssue(issues, component, state, recovery) {
  if (!issues.some((issue) => issue.component === component)) {
    issues.push({ component, state, recovery });
  }
}

async function createManagedStatusInternal(input, captureRedactionValues) {
  const request = snapshotInput(input);
  const config = validateManagedConfig(readJson(MANAGED_CONFIG_PATH));
  const { credentialPolicy, sandboxResolver, reconciler } =
    await loadRuntimeModules();
  if (
    typeof credentialPolicy.scrubEnvironment !== "function" ||
    !Array.isArray(credentialPolicy.sensitiveNames) ||
    !isPlainObject(credentialPolicy.scrubbedShellContract) ||
    !Array.isArray(credentialPolicy.scrubbedShellContract.allow) ||
    typeof sandboxResolver.resolveSandboxSelectionFromEnvironment !==
      "function" ||
    typeof reconciler.hashCanonicalJsonInternal !== "function"
  ) {
    throw statusError("managed status dependency invalid");
  }

  const environment = environmentSnapshot(process.env, [
      ...credentialPolicy.sensitiveNames,
      "AGENTMEMORY_SECRET",
      "PI_NONO",
    "PI_NONO_PROFILE",
    "PI_NONO_LISTEN_PORTS",
  ]);
  const scrubbedProbeEnvironment = credentialPolicy.scrubEnvironment({});
  if (!hasExactKeys(scrubbedProbeEnvironment, [])) {
    throw statusError("managed status dependency invalid");
  }
  const probeEnvironment = snapshotClosedDataObject(
    scrubbedProbeEnvironment,
    [],
    "managed status dependency invalid",
  );
  const sandbox = sandboxResolver.resolveSandboxSelectionFromEnvironment(
    sandboxEnvironment(environment),
  );
  const adminKey = readAdminKey(probeEnvironment);
  const redactionValues = exactValues(
    environment,
    credentialPolicy.sensitiveNames,
    adminKey,
  );
  captureRedactionValues(Object.freeze([...redactionValues]));
  const mcpReady = mcpIsReady(config.mcpEndpoint, adminKey, probeEnvironment);
  const agentMemory = await agentMemoryState(
    request.agentMemoryUrl,
    environment.AGENTMEMORY_SECRET,
    redactionValues,
  );
  const extension = extensionState(config, probeEnvironment);
  const lsp = lspState(config);
  const drift = reconciliationDrift(config, request.agentDir, reconciler);
  const issues = [];
  if (!extension.ready)
    addIssue(issues, "extensions", "degraded", EXTENSION_RECOVERY);
  if (!mcpReady) addIssue(issues, "mcp", "degraded", MCP_RECOVERY);
  if (!agentMemory.ready)
    addIssue(issues, "agentmemory", agentMemory.state, AGENTMEMORY_RECOVERY);
  for (const [name, state] of Object.entries(lsp)) {
    if (state !== "ready")
      addIssue(issues, `lsp:${name}`, "missing", LSP_RECOVERY);
  }
  if (drift.length !== 0) {
    addIssue(issues, "reconciliation", "drifted", RECONCILIATION_RECOVERY);
  }
  issues.sort((left, right) => compareText(left.component, right.component));
  const status =
    drift.length !== 0
      ? "drifted"
      : issues.length === 0
        ? "complete"
        : "degraded";
  const statusContract = {
    extensionNames: config.extensionOrder,
    generation: config.generation,
    lspNames: Object.keys(config.lspExecutables),
    mcpEndpoint: config.mcpEndpoint,
    piVersion: EXPECTED_PI_VERSION,
    providerMode: config.providerSelection.mode,
  };
  const report = snapshotStatusV1(
    {
      generation: config.generation,
      piVersion: EXPECTED_PI_VERSION,
      providerMode: config.providerSelection.mode,
      sandboxState: sandbox.state,
      profile: sandbox.profile,
      mcpEndpoint: config.mcpEndpoint,
      mcpReady,
      agentMemoryUrl: request.agentMemoryUrl,
      agentMemoryReady: agentMemory.ready,
      extensions: extension.extensions,
      drift,
      lsp,
      status,
      issues,
    },
    statusContract,
  );
  const redacted = redactStatusReport(report, redactionValues);
  const finalized = snapshotStatusV1(redacted, statusContract);
  return deepFreeze(finalized);
}

function renderManagedStatus(report) {
  const sandboxProfile = report.profile === null ? "none" : report.profile;
  const extensions = Object.entries(report.extensions)
    .map(([name, version]) => `${name}=${version}`)
    .join(", ");
  const lsp = Object.entries(report.lsp)
    .map(([name, state]) => `${name}=${state}`)
    .join(", ");
  const recovery =
    report.issues.length === 0
      ? "none"
      : report.issues
          .map((issue) => `${issue.component}: ${issue.recovery}`)
          .join("; ");
  return [
    `Pi managed status: ${report.status}`,
    `Generation: ${report.generation}`,
    `Pi: ${report.piVersion}`,
    `Provider: ${report.providerMode}`,
    `Sandbox: ${report.sandboxState} (${sandboxProfile})`,
    `MCP: ${report.mcpReady ? "ready" : "not ready"} (${report.mcpEndpoint})`,
    `AgentMemory: ${report.agentMemoryReady ? "ready" : "not ready"} (${report.agentMemoryUrl})`,
    `Extensions: ${extensions || "none"}`,
    `LSP: ${lsp || "none"}`,
    `Drift: ${report.drift.length === 0 ? "none" : report.drift.join(", ")}`,
    `Recovery: ${recovery}`,
    "",
  ].join("\n");
}

export async function runManagedStatusCli() {
  let redactionValues;
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
      throw statusError("managed status arguments invalid");
    }
    const inputBytes = fs.readFileSync(0);
    if (inputBytes.length === 0 || inputBytes.length > INPUT_LIMIT_BYTES) {
      throw statusError("managed status input invalid");
    }
    const report = await createManagedStatusInternal(
      JSON.parse(inputBytes.toString("utf8")),
      (captured) => {
        redactionValues = captured;
      },
    );
    const output =
      args[0] === "--json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderManagedStatus(report);
    if (containsExactValue(output, redactionValues)) {
      throw STATUS_REJECTION;
    }
    process.stdout.write(output);
    return 0;
  } catch {
    redactionValues ??= captureEnvironmentExactValues();
    const diagnostic = collisionSafeDiagnostic(redactionValues);
    if (diagnostic !== "") {
      try {
        process.stderr.write(diagnostic);
      } catch {}
    }
    return 2;
  }
}
