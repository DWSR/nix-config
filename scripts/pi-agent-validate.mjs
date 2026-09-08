import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, types } from "node:util";

const STATUS_EXECUTABLE = "__PI_AGENT_VALIDATOR_STATUS_EXECUTABLE__";
const MANAGED_CONFIG_PATH = "__PI_AGENT_VALIDATOR_MANAGED_CONFIG__";
const CREDENTIAL_POLICY_MODULE = "__PI_AGENT_VALIDATOR_CREDENTIAL_POLICY__";
const PI_PACKAGE_ROOT = "__PI_AGENT_VALIDATOR_PI_PACKAGE_ROOT__";
const CONTEXT_RECOVERY_MANIFEST =
  "__PI_AGENT_VALIDATOR_CONTEXT_RECOVERY_MANIFEST__";
const EXTENSION_PACKAGE_ROOT = "__PI_AGENT_VALIDATOR_EXTENSION_PACKAGE_ROOT__";
const PROFILE_PACKAGE_ROOT = "__PI_AGENT_VALIDATOR_PROFILE_PACKAGE_ROOT__";
const PROBE_CWD = "__PI_AGENT_VALIDATOR_PROBE_CWD__";
const PACKAGE_CONTRACT = PI_AGENT_VALIDATOR_PACKAGE_CONTRACT_PLACEHOLDER;
const PROFILE_CONTRACT = PI_AGENT_VALIDATOR_PROFILE_CONTRACT_PLACEHOLDER;
const EXTENSION_CONTRACT = PI_AGENT_VALIDATOR_EXTENSION_CONTRACT_PLACEHOLDER;

const INPUT_LIMIT_BYTES = 64 * 1024;
const FILE_LIMIT_BYTES = 16 * 1024 * 1024;
const STATUS_OUTPUT_LIMIT_BYTES = 128 * 1024;
const STATUS_TIMEOUT_MS = 30_000;
const ENVIRONMENT_PROTOTYPE_LIMIT = 32;
const VALIDATOR_REJECTION = Symbol();
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SELECTION_NAMES = Object.freeze([
  "PI_NONO",
  "PI_NONO_PROFILE",
  "PI_NONO_LISTEN_PORTS",
]);
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
const MANAGED_SETTING_KEYS = Object.freeze([
  "defaultModel",
  "defaultThinkingLevel",
  "shellPath",
  "installTelemetry",
  "selfUpdate",
  "unmanagedPackages",
]);
const PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "groq",
  "xai",
]);
const RECOVERY = Object.freeze({
  package:
    "rebuild the managed generation or reactivate the previous generation",
  json: "repair settings.json and models.json, then rerun reconciliation",
  ownership:
    "repair or remove invalid ownership state, then rerun reconciliation",
  profiles:
    "use PI_NONO=disabled, audit, or enforced; select pi-audit, pi-managed, or pi-review; use canonical comma-separated listen ports; use PI_NONO=disabled pi for one-launch rollback",
  extensions:
    "update the pinned extension set, rebuild pi-agent-extensions, and reactivate the generation",
  mcp: "restart mcpproxy or repair the declared upstream",
  agentmemory: "restart the AgentMemory daemon and verify its authenticated health route",
  pty: "rebuild pi-agent-extensions with the Darwin ARM node-pty prebuild",
  lsp: "rebuild the configured language server and activate the managed generation",
  drift: "repair managed Pi state and rerun reconciliation",
  seatbelt:
    "run validation on an unsandboxed macOS host; select a valid profile or use PI_NONO=disabled pi for rollback",
  provider:
    "configure Pi authentication or the Shopify gateway provider, then rerun validation",
});
const CREDENTIAL_POLICY = await import(
  pathToFileURL(CREDENTIAL_POLICY_MODULE).href
);
const SENSITIVE_NAMES = snapshotStringArray(CREDENTIAL_POLICY.sensitiveNames);

function reject() {
  throw VALIDATOR_REJECTION;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value, expected) {
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

function snapshotDataArray(value, maximum = 256) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    reject();
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) reject();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    reject();
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      reject();
    }
    result.push(descriptor.value);
  }
  return result;
}

function snapshotStringArray(value) {
  const result = snapshotDataArray(value);
  if (
    result.length === 0 ||
    result.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 256 ||
        CONTROL.test(entry),
    ) ||
    new Set(result).size !== result.length
  ) {
    reject();
  }
  return Object.freeze(result);
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > FILE_LIMIT_BYTES) {
      return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function environmentSnapshot(environment, names) {
  try {
    if (
      environment === null ||
      typeof environment !== "object" ||
      types.isProxy(environment)
    ) {
      reject();
    }
    const requested = [...new Set(names)];
    const found = new Set();
    const result = Object.create(null);
    let current = environment;
    let depth = 0;
    while (current !== null) {
      if (
        depth >= ENVIRONMENT_PROTOTYPE_LIMIT ||
        typeof current !== "object" ||
        types.isProxy(current)
      ) {
        reject();
      }
      for (const name of requested) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor === undefined) continue;
        if (
          depth > 0 ||
          found.has(name) ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string"
        ) {
          reject();
        }
        found.add(name);
        Object.defineProperty(result, name, {
          enumerable: true,
          value: descriptor.value,
        });
      }
      current = Object.getPrototypeOf(current);
      depth += 1;
    }
    return Object.freeze(result);
  } catch {
    reject();
  }
}

function snapshotInput(input) {
  if (
    !hasExactDataKeys(input, ["schemaVersion", "agentDir", "agentMemoryUrl", "agentMemorySecretReference"]) ||
    input.schemaVersion !== 1
  ) {
    reject();
  }
  const result = { schemaVersion: 1 };
  for (const key of ["agentDir", "agentMemoryUrl", "agentMemorySecretReference"]) {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4096 ||
       (key === "agentDir" &&
         (!path.isAbsolute(value) || path.normalize(value) !== value)) ||
      CONTROL.test(value)
    ) {
      reject();
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function validateManagedConfig(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    value.generation.length > 256 ||
    !SAFE_IDENTIFIER.test(value.generation) ||
    !isPlainObject(value.providerSelection) ||
    !["personal", "shopify-gateway"].includes(value.providerSelection.mode) ||
    !Array.isArray(value.extensionOrder) ||
    !isDeepStrictEqual(
      value.extensionOrder,
      EXTENSION_CONTRACT.extensionOrder,
    ) ||
    value.extensionManifest !==
      path.join(EXTENSION_PACKAGE_ROOT, "share/pi-agent/extensions.json") ||
    !["disabled", "audit", "enforced"].includes(value.sandboxDefault) ||
    value.mcpEndpoint !== "http://127.0.0.1:8080/mcp" ||
    !isPlainObject(value.agentMemory) ||
    value.agentMemory.url !== "http://127.0.0.1:3111" ||
    typeof value.agentMemory.secretReference !== "string" ||
    value.agentMemory.secretReference.length === 0 ||
    !isPlainObject(value.lspExecutables)
  ) {
    reject();
  }
  const lspNames = Object.keys(value.lspExecutables).sort(compareText);
  if (
    lspNames.length > 128 ||
    lspNames.some(
      (name) =>
        !SAFE_NAME.test(name) ||
        typeof value.lspExecutables[name] !== "string" ||
        !path.isAbsolute(value.lspExecutables[name]),
    )
  ) {
    reject();
  }
  return Object.freeze({
    generation: value.generation,
    providerMode: value.providerSelection.mode,
    sandboxDefault: value.sandboxDefault,
    lspNames: Object.freeze(lspNames),
  });
}

function validateContextRecoveryManifest(value) {
  const expected = PACKAGE_CONTRACT.contextRecovery;
  if (
    !hasExactDataKeys(value, [
      "schemaVersion",
      "piVersion",
      "upstreamCommit",
      "upstreamParent",
      "upstreamTests",
      "terminalBaselineTests",
      "summary",
      "tests",
    ]) ||
    value.schemaVersion !== expected.schemaVersion ||
    value.piVersion !== PACKAGE_CONTRACT.piVersion ||
    value.upstreamCommit !== expected.upstreamCommit ||
    value.upstreamParent !== expected.upstreamParent ||
    !isDeepStrictEqual(value.upstreamTests, expected.upstreamTests) ||
    !isDeepStrictEqual(
      value.terminalBaselineTests,
      expected.terminalBaselineTests,
    ) ||
    !hasExactDataKeys(value.summary, ["failed", "files", "passed", "total"]) ||
    value.summary.failed !== 0 ||
    !Number.isSafeInteger(value.summary.files) ||
    value.summary.files !==
      expected.upstreamTests.length + expected.terminalBaselineTests.length ||
    !Number.isSafeInteger(value.summary.passed) ||
    value.summary.passed <= 0 ||
    value.summary.passed !== value.summary.total
  ) {
    return false;
  }
  let tests;
  try {
    tests = snapshotDataArray(value.tests, 10_000);
  } catch {
    return false;
  }
  if (tests.length !== value.summary.total) return false;
  const expectedFiles = [
    ...expected.upstreamTests,
    ...expected.terminalBaselineTests,
  ];
  const identifiers = [];
  const covered = new Set();
  for (const result of tests) {
    if (
      !hasExactDataKeys(result, ["id", "status"]) ||
      typeof result.id !== "string" ||
      result.id.length === 0 ||
      result.id.length > 4096 ||
      CONTROL.test(result.id) ||
      result.status !== "pass"
    ) {
      return false;
    }
    const file = expectedFiles.find((candidate) =>
      result.id.startsWith(`${candidate} > `),
    );
    if (file === undefined) return false;
    covered.add(file);
    identifiers.push(result.id);
  }
  return (
    covered.size === expectedFiles.length &&
    new Set(identifiers).size === identifiers.length &&
    isDeepStrictEqual(identifiers, [...identifiers].sort(compareText))
  );
}

function packageArtifactsReady() {
  try {
    if (
      !hasExactDataKeys(PACKAGE_CONTRACT, [
        "schemaVersion",
        "piVersion",
        "undiciVersion",
        "gondolinUndiciVersion",
        "requiredPatches",
        "contextRecovery",
      ]) ||
      PACKAGE_CONTRACT.schemaVersion !== 1 ||
      PACKAGE_CONTRACT.piVersion !== "0.83.0" ||
      PACKAGE_CONTRACT.undiciVersion !== "8.9.0" ||
      PACKAGE_CONTRACT.gondolinUndiciVersion !== "6.28.0" ||
      !isDeepStrictEqual(PACKAGE_CONTRACT.requiredPatches, [
        "pi-context-recovery.patch",
        "pi-launch-redaction-bootstrap.patch",
        "pi-undici-8.9.0.patch",
      ])
    ) {
      return false;
    }
    const pi = readJson(
      path.join(
        PI_PACKAGE_ROOT,
        "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      ),
    );
    const undici = readJson(
      path.join(PI_PACKAGE_ROOT, "lib/node_modules/undici/package.json"),
    );
    const gondolinUndici = readJson(
      path.join(
        PI_PACKAGE_ROOT,
        "lib/node_modules/@earendil-works/gondolin/node_modules/undici/package.json",
      ),
    );
    return (
      isPlainObject(pi) &&
      pi.name === "@earendil-works/pi-coding-agent" &&
      pi.version === PACKAGE_CONTRACT.piVersion &&
      isPlainObject(undici) &&
      undici.name === "undici" &&
      undici.version === PACKAGE_CONTRACT.undiciVersion &&
      isPlainObject(gondolinUndici) &&
      gondolinUndici.name === "undici" &&
      gondolinUndici.version === PACKAGE_CONTRACT.gondolinUndiciVersion &&
      validateContextRecoveryManifest(readJson(CONTEXT_RECOVERY_MANIFEST))
    );
  } catch {
    return false;
  }
}

function profileArtifactsReady() {
  try {
    if (
      !hasExactDataKeys(PROFILE_CONTRACT, [
        "schemaVersion",
        "nonoVersion",
        "profileNames",
        "catalog",
        "profiles",
      ]) ||
      PROFILE_CONTRACT.schemaVersion !== 1 ||
      PROFILE_CONTRACT.nonoVersion !== "0.69.0" ||
      !isDeepStrictEqual(PROFILE_CONTRACT.profileNames, [
        "pi-audit",
        "pi-managed",
        "pi-review",
      ]) ||
      !isDeepStrictEqual(
        readJson(
          path.join(PROFILE_PACKAGE_ROOT, "share/pi-agent/nono/catalog.json"),
        ),
        PROFILE_CONTRACT.catalog,
      )
    ) {
      return false;
    }
    for (const name of PROFILE_CONTRACT.profileNames) {
      const entry = PROFILE_CONTRACT.catalog.profiles?.[name];
      const expectedSourcePath = `share/pi-agent/nono/profiles/${name}.json`;
      const expectedResolvedPath = `share/pi-agent/nono/resolved/${name}.json`;
      if (
        !isPlainObject(entry) ||
        entry.sourcePath !== expectedSourcePath ||
        entry.resolvedPath !== expectedResolvedPath ||
        !isDeepStrictEqual(
          readJson(path.join(PROFILE_PACKAGE_ROOT, expectedSourcePath)),
          PROFILE_CONTRACT.profiles[name],
        )
      ) {
        return false;
      }
      const resolved = readJson(
        path.join(PROFILE_PACKAGE_ROOT, expectedResolvedPath),
      );
      if (
        !isPlainObject(resolved) ||
        resolved.name !== name ||
        !isDeepStrictEqual(resolved.extends, ["default"])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function extensionManifestReady() {
  try {
    return isDeepStrictEqual(
      readJson(
        path.join(EXTENSION_PACKAGE_ROOT, "share/pi-agent/extensions.json"),
      ),
      EXTENSION_CONTRACT.manifest,
    );
  } catch {
    return false;
  }
}

function ptyArtifactsReady() {
  try {
    const root = path.join(EXTENSION_PACKAGE_ROOT, "lib/node_modules/node-pty");
    const manifest = readJson(path.join(root, "package.json"));
    const nativeModule = fs.lstatSync(
      path.join(root, "prebuilds/darwin-arm64/pty.node"),
    );
    const helper = fs.lstatSync(
      path.join(root, "prebuilds/darwin-arm64/spawn-helper"),
    );
    return (
      isPlainObject(manifest) &&
      manifest.name === "node-pty" &&
      manifest.version === EXTENSION_CONTRACT.nodePtyVersion &&
      nativeModule.isFile() &&
      helper.isFile() &&
      (helper.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

function validDriftLabel(label) {
  if (
    [
      "models.invalid",
      "models.missing",
      "models.providers.invalid",
      "ownership.generation",
      "ownership.invalid",
      "ownership.missing",
      "ownership.transaction",
      "settings.invalid",
      "settings.missing",
    ].includes(label)
  ) {
    return true;
  }
  if (
    MANAGED_SETTING_KEYS.some((key) =>
      [
        `settings.${key}.desired`,
        `settings.${key}.missing`,
        `settings.${key}.ownership-missing`,
        `settings.${key}.value`,
      ].includes(label),
    )
  ) {
    return true;
  }
  return PROVIDER_IDS.some((providerId) =>
    [
      `models.provider.${providerId}.missing`,
      `models.provider.${providerId}.ownership-missing`,
      `models.provider.${providerId}.stale-ownership`,
      `models.provider.${providerId}.value`,
    ].includes(label),
  );
}

function snapshotStatus(value, config) {
  try {
    if (
      !hasExactDataKeys(value, STATUS_KEYS) ||
      value.generation !== config.generation ||
      value.piVersion !== PACKAGE_CONTRACT.piVersion ||
      value.providerMode !== config.providerMode ||
      !["disabled", "audit", "enforced"].includes(value.sandboxState) ||
      (value.sandboxState === "disabled"
        ? value.profile !== null
        : !PROFILE_CONTRACT.profileNames.includes(value.profile)) ||
      value.mcpEndpoint !== "http://127.0.0.1:8080/mcp" ||
      typeof value.mcpReady !== "boolean" ||
      typeof value.agentMemoryUrl !== "string" ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.agentMemoryUrl) ||
      CONTROL.test(value.agentMemoryUrl) ||
      typeof value.agentMemoryReady !== "boolean" ||
      !isPlainObject(value.extensions) ||
      !isPlainObject(value.lsp) ||
      !["complete", "degraded", "drifted"].includes(value.status) ||
      !Array.isArray(value.issues)
    ) {
      return null;
    }
    const extensionNames = Object.keys(value.extensions).sort(compareText);
    if (
      !isDeepStrictEqual(extensionNames, EXTENSION_CONTRACT.extensionNames) ||
      extensionNames.some((name) => {
        const version = value.extensions[name];
        return (
          version !== "unavailable" &&
          version !== EXTENSION_CONTRACT.versions[name]
        );
      })
    ) {
      return null;
    }
    const lspNames = Object.keys(value.lsp).sort(compareText);
    if (
      !isDeepStrictEqual(lspNames, config.lspNames) ||
      lspNames.some((name) => !["ready", "missing"].includes(value.lsp[name]))
    ) {
      return null;
    }
    const drift = snapshotDataArray(value.drift, 256);
    if (
      drift.some(
        (label) => typeof label !== "string" || !validDriftLabel(label),
      ) ||
      new Set(drift).size !== drift.length
    ) {
      return null;
    }
    return Object.freeze({
      providerMode: value.providerMode,
      sandboxState: value.sandboxState,
      mcpReady: value.mcpReady,
      agentMemoryReady: value.agentMemoryReady,
      extensions: Object.freeze({ ...value.extensions }),
      drift: Object.freeze([...drift]),
      lsp: Object.freeze({ ...value.lsp }),
    });
  } catch {
    return null;
  }
}

function runStatus(input, config, environment) {
  let result;
  try {
    result = spawnSync(STATUS_EXECUTABLE, ["--json"], {
      cwd: PROBE_CWD,
      encoding: "utf8",
      env: environment,
      input: `${JSON.stringify(input)}\n`,
      maxBuffer: STATUS_OUTPUT_LIMIT_BYTES,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: STATUS_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr !== "" ||
    typeof result.stdout !== "string" ||
    result.stdout.length === 0
  ) {
    return null;
  }
  try {
    return snapshotStatus(JSON.parse(result.stdout), config);
  } catch {
    return null;
  }
}

function createGate(name, status, evidence, recovery) {
  if (
    !/[a-z0-9-]+/.test(name) ||
    !["pass", "fail", "manual-required"].includes(status)
  ) {
    reject();
  }
  return Object.freeze({
    name,
    status,
    evidence: Object.freeze([...evidence]),
    recovery: status === "pass" ? "none" : recovery,
  });
}

function extensionEvidence() {
  const versions = EXTENSION_CONTRACT.extensionNames
    .map((name) => `${name}@${EXTENSION_CONTRACT.versions[name]}`)
    .join(",");
  return [
    "extension-provenance:v2",
    "extension-order:v1",
    `extensions:${versions}`,
  ];
}

function createReport(config, status) {
  const packageReady = packageArtifactsReady();
  const profileReady = profileArtifactsReady();
  const manifestReady = extensionManifestReady();
  const ptyReady = ptyArtifactsReady();
  const statusReady = status !== null;
  const jsonReady =
    statusReady &&
    !status.drift.some(
      (label) => label.startsWith("settings.") || label.startsWith("models."),
    );
  const ownershipReady =
    statusReady &&
    !status.drift.some((label) => label.startsWith("ownership."));
  const extensionsReady =
    statusReady &&
    manifestReady &&
    EXTENSION_CONTRACT.extensionNames.every(
      (name) => status.extensions[name] === EXTENSION_CONTRACT.versions[name],
    );
  const lspReady =
    statusReady &&
    Object.values(status.lsp).every((state) => state === "ready");
  const noDrift = statusReady && status.drift.length === 0;
  const seatbeltStatus = !statusReady
    ? "fail"
    : status.sandboxState === "disabled"
      ? "pass"
      : "manual-required";
  const providerStatus = !statusReady
    ? "fail"
    : status.providerMode === "shopify-gateway"
      ? "manual-required"
      : "pass";
  const providerMode = statusReady ? status.providerMode : config.providerMode;
  const gates = [
    createGate(
      "package-patches",
      packageReady ? "pass" : "fail",
      [
        "package-contract:v1",
        `pi:${PACKAGE_CONTRACT.piVersion}`,
        `undici:${PACKAGE_CONTRACT.undiciVersion}`,
        "context-recovery:v1",
      ],
      RECOVERY.package,
    ),
    createGate(
      "managed-json",
      jsonReady ? "pass" : "fail",
      ["status-command:v1", "managed-json:v1"],
      RECOVERY.json,
    ),
    createGate(
      "ownership",
      ownershipReady ? "pass" : "fail",
      ["status-command:v1", "ownership-state:v1"],
      RECOVERY.ownership,
    ),
    createGate(
      "sandbox-profiles",
      profileReady && statusReady ? "pass" : "fail",
      [
        "profile-catalog:v1",
        `nono:${PROFILE_CONTRACT.nonoVersion}`,
        `profiles:${PROFILE_CONTRACT.profileNames.join(",")}`,
      ],
      RECOVERY.profiles,
    ),
    createGate(
      "extension-inventory",
      extensionsReady ? "pass" : "fail",
      extensionEvidence(),
      RECOVERY.extensions,
    ),
    createGate(
      "mcp-surface",
      statusReady && status.mcpReady ? "pass" : "fail",
      ["mcp-preflight:v1", "transport:/mcp", "direct-tools:v1"],
      RECOVERY.mcp,
    ),
    createGate(
      "agentmemory",
      statusReady && status.agentMemoryReady ? "pass" : "fail",
      ["agentmemory-health:v1"],
      RECOVERY.agentmemory,
    ),
    createGate(
      "pty",
      ptyReady ? "pass" : "fail",
      [
        `node-pty:${EXTENSION_CONTRACT.nodePtyVersion}`,
        "darwin-arm64-prebuild:v1",
      ],
      RECOVERY.pty,
    ),
    createGate(
      "lsp",
      lspReady ? "pass" : "fail",
      ["lsp-inventory:v1"],
      RECOVERY.lsp,
    ),
    createGate(
      "reconciliation-drift",
      noDrift ? "pass" : "fail",
      ["reconciliation-drift:v1"],
      RECOVERY.drift,
    ),
    createGate(
      "sandbox-seatbelt-host",
      seatbeltStatus,
      ["sandbox-host-probe:v1", `nono:${PROFILE_CONTRACT.nonoVersion}`],
      RECOVERY.seatbelt,
    ),
    createGate(
      "provider-setup",
      providerStatus,
      ["provider-contract:v1", `mode:${providerMode}`],
      RECOVERY.provider,
    ),
  ];
  return Object.freeze({
    generation: config.generation,
    gates: Object.freeze(gates),
  });
}

function containsExactValue(value, values) {
  return values.some((secret) => value.includes(secret));
}

function collisionSafeDiagnostic(redactionValues) {
  const diagnostic = "pi-agent-validate: invocation rejected\n";
  return Array.isArray(redactionValues) &&
    !containsExactValue(diagnostic, redactionValues)
    ? diagnostic
    : "";
}

export async function runRuntimeCompatibilityValidatorCli() {
  let redactionValues;
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 1 ||
      (args[0] !== "--check" && args[0] !== "--dry-run")
    ) {
      reject();
    }
    const environment = environmentSnapshot(process.env, [
      ...SENSITIVE_NAMES,
      ...SELECTION_NAMES,
    ]);
    redactionValues = SENSITIVE_NAMES.map((name) => environment[name]).filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    const bytes = fs.readFileSync(0);
    if (bytes.length === 0 || bytes.length > INPUT_LIMIT_BYTES) reject();
    const input = snapshotInput(JSON.parse(bytes.toString("utf8")));
    const config = validateManagedConfig(readJson(MANAGED_CONFIG_PATH));
    if (
      typeof CREDENTIAL_POLICY.scrubEnvironment !== "function" ||
      !isPlainObject(CREDENTIAL_POLICY.spawnEnvironmentPartitions) ||
      CREDENTIAL_POLICY.spawnEnvironmentPartitions.validatorProbe !==
        "scrubbedEnvironment"
    ) {
      reject();
    }
    const scrubbedEnvironment = CREDENTIAL_POLICY.scrubEnvironment({});
    if (!hasExactDataKeys(scrubbedEnvironment, [])) reject();
    const probeEnvironment = { ...scrubbedEnvironment };
    for (const name of SELECTION_NAMES) {
      const value = environment[name];
      if (value === undefined || value === "") continue;
      if (
        value.length > 4096 ||
        CONTROL.test(value) ||
        containsExactValue(value, redactionValues)
      ) {
        reject();
      }
      probeEnvironment[name] = value;
    }
    const status = runStatus(input, config, Object.freeze(probeEnvironment));
    const report = createReport(config, status);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (containsExactValue(output, redactionValues)) reject();
    process.stdout.write(output);
    return report.gates.some((gate) => gate.status === "fail") ? 1 : 0;
  } catch {
    if (redactionValues === undefined) {
      try {
        const environment = environmentSnapshot(process.env, SENSITIVE_NAMES);
        redactionValues = SENSITIVE_NAMES.map(
          (name) => environment[name],
        ).filter((value) => typeof value === "string" && value.length > 0);
      } catch {
        redactionValues = null;
      }
    }
    const diagnostic = collisionSafeDiagnostic(redactionValues);
    if (diagnostic !== "") {
      try {
        process.stderr.write(diagnostic);
      } catch {}
    }
    return 2;
  }
}
