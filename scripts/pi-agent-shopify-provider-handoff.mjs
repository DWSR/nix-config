import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { planManagedReconciliation } from "__PI_AGENT_RECONCILER_MODULE__";

const MANAGED_CONFIG_PATH = "__PI_AGENT_MANAGED_CONFIG__";
const MANAGED_CONFIG_DIGEST = "__PI_AGENT_MANAGED_CONFIG_DIGEST__";
const PROJECTION_FACTORY_PATH = "__PI_AGENT_PROJECTION_FACTORY__";
const PROJECTION_FACTORY_DIGEST = "__PI_AGENT_PROJECTION_FACTORY_DIGEST__";
const FACTORY_TIMEOUT_MS = 5_000;
const FACTORY_OUTPUT_LIMIT_BYTES = 64 * 1024;
const EMPTY_ENVIRONMENT = Object.freeze({});

function handoffInputRejected() {
  throw new Error("Shopify provider handoff input rejected");
}

function baseValidationFailed() {
  throw new Error("Shopify provider base validation failed");
}

function artifactValidationFailed() {
  throw new Error("Shopify provider artifact validation failed");
}

function factoryFailed() {
  throw new Error("Shopify provider projection factory failed");
}

function projectionValidationFailed() {
  throw new Error("Shopify provider projection validation failed");
}

function reconciliationValidationFailed() {
  throw new Error("Shopify provider reconciliation validation failed");
}

function snapshotClosedDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      handoffInputRejected();
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      handoffInputRejected();
    }
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    if (
      requiredKeys.some((key) => !ownKeys.includes(key)) ||
      ownKeys.some((key) => !allowedKeys.has(key))
    ) {
      handoffInputRejected();
    }

    const snapshot = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        handoffInputRejected();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    handoffInputRejected();
  }
}

function validateRawBaseCandidate(candidate) {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("https://") ||
    candidate.includes("\t") ||
    candidate.includes("\r") ||
    candidate.includes("\n") ||
    candidate.includes("\0") ||
    candidate.includes("?") ||
    candidate.includes("#")
  ) {
    baseValidationFailed();
  }

  const authorityStart = "https://".length;
  let authorityEnd = candidate.length;
  for (const delimiter of ["/", "\\", "?", "#"]) {
    const index = candidate.indexOf(delimiter, authorityStart);
    if (index !== -1 && index < authorityEnd) authorityEnd = index;
  }
  const authority = candidate.slice(authorityStart, authorityEnd);
  if (authority === "" || authority.includes("@")) {
    baseValidationFailed();
  }
}

function validateBaseCandidate(candidate) {
  validateRawBaseCandidate(candidate);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    baseValidationFailed();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin === "null" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    baseValidationFailed();
  }
  return parsed.origin;
}

function readVerifiedArtifact(filePath, expectedDigest) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    artifactValidationFailed();
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    artifactValidationFailed();
  }
  return bytes.toString("utf8");
}

function validateProjectionFactory() {
  const actualDigest = createHash("sha256")
    .update(PROJECTION_FACTORY_PATH)
    .digest("hex");
  if (actualDigest !== PROJECTION_FACTORY_DIGEST) {
    artifactValidationFailed();
  }
  try {
    fs.accessSync(
      PROJECTION_FACTORY_PATH,
      fs.constants.R_OK | fs.constants.X_OK,
    );
  } catch {
    artifactValidationFailed();
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadManagedArtifacts() {
  const managedConfigBytes = readVerifiedArtifact(
    MANAGED_CONFIG_PATH,
    MANAGED_CONFIG_DIGEST,
  );
  validateProjectionFactory();

  try {
    return deepFreeze(JSON.parse(managedConfigBytes));
  } catch {
    artifactValidationFailed();
  }
}

function createFactoryInput(managedConfig, origin) {
  try {
    const selectedRoles = new Set(
      managedConfig.providerSelection.enabledRoles,
    );
    const joinedUrls = Object.fromEntries(
      managedConfig.providerCatalog.shopify
        .filter(({ role }) => selectedRoles.has(role))
        .map(({ role, route }) => [role, origin + route.suffix]),
    );
    return {
      schemaVersion: managedConfig.schemaVersion,
      generation: managedConfig.generation,
      providerSelection: managedConfig.providerSelection,
      joinedUrls,
    };
  } catch {
    artifactValidationFailed();
  }
}

function executeProjectionFactory(factoryInputBytes) {
  let result;
  try {
    result = spawnSync(PROJECTION_FACTORY_PATH, [], {
      encoding: "utf8",
      env: EMPTY_ENVIRONMENT,
      input: factoryInputBytes,
      maxBuffer: FACTORY_OUTPUT_LIMIT_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: FACTORY_TIMEOUT_MS,
    });
  } catch {
    factoryFailed();
  }
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    typeof result.stdout !== "string" ||
    Buffer.byteLength(result.stdout) > FACTORY_OUTPUT_LIMIT_BYTES
  ) {
    factoryFailed();
  }
  return result.stdout;
}

function parseFactoryProjection(projectionBytes) {
  try {
    return JSON.parse(projectionBytes);
  } catch {
    projectionValidationFailed();
  }
}

export function composeShopifyProviderHandoff(...inputs) {
  if (inputs.length !== 1) {
    handoffInputRejected();
  }
  const input = snapshotClosedDataObject(
    inputs[0],
    ["baseCandidate", "currentSettings", "currentModels"],
    ["ownershipState"],
  );
  const origin = validateBaseCandidate(input.baseCandidate);
  const managedConfig = loadManagedArtifacts();
  const factoryInput = createFactoryInput(managedConfig, origin);
  const factoryInputBytes = `${JSON.stringify(factoryInput)}\n`;
  const projectionBytes = executeProjectionFactory(factoryInputBytes);
  const providerProjection = deepFreeze(parseFactoryProjection(projectionBytes));
  const reconciliationInput = Object.freeze({
    managedConfig,
    providerProjection,
    currentSettings: input.currentSettings,
    currentModels: input.currentModels,
    ...(Object.hasOwn(input, "ownershipState")
      ? { ownershipState: input.ownershipState }
      : {}),
  });
  let reconciliationResult;
  try {
    reconciliationResult = deepFreeze(
      planManagedReconciliation(reconciliationInput),
    );
  } catch {
    reconciliationValidationFailed();
  }

  return Object.freeze({
    factoryInputBytes,
    projectionBytes,
    providerProjection,
    reconciliationResult,
  });
}
