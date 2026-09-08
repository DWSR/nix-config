import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { types } from "node:util";
import { pathToFileURL } from "node:url";

const SETTINGS_PATH = "settings.json";
const MODELS_PATH = "models.json";
const AUTH_PATH = "auth.json";
const OWNERSHIP_PATH = "ownership.json";
const TRANSACTION_PATH = ".pi-agent-reconcile-transaction.json";
const INTEGRATION_LOCK_PATH = ".pi-agent-reconcile.lock";
const TEMPORARY_PREFIX = ".pi-agent-reconcile-";
const TARGET_PATHS = new Set([MODELS_PATH, SETTINGS_PATH]);
const FILE_MODE = 0o600;
const PROVIDER_ORDER = ["anthropic", "openai", "google", "groq", "xai"];
const PROVIDER_SET = new Set(PROVIDER_ORDER);
const MANAGED_CONFIG_KEYS = [
  "schemaVersion",
  "generation",
  "agentDir",
  "agentMemory",
  "settings",
  "timeouts",
  "providerCatalog",
  "providerSelection",
  "extensionManifest",
  "extensionOrder",
  "instructionResources",
  "lspExecutables",
  "mcpEndpoint",
  "sandboxDefault",
];
const MANAGED_SETTING_KEYS = [
  "defaultModel",
  "defaultThinkingLevel",
  "shellPath",
  "installTelemetry",
  "selfUpdate",
  "unmanagedPackages",
];
const MANAGED_SETTING_POINTERS = new Set(
  MANAGED_SETTING_KEYS.map((key) => `/${key}`),
);
const SECURITY_SETTING_POINTERS = new Set([
  "/installTelemetry",
  "/selfUpdate",
  "/unmanagedPackages",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*$/;
const SAFE_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*(\/[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*)*$/;
const VALUE_HASH = /^sha256:[0-9a-f]{64}$/;
const RENDERED_STORE_PATH = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[^/]+\/.+$/;
const API_BY_PROVIDER = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  google: "google-generative-ai",
  groq: "openai-completions",
};
const PROVIDER_CATALOG_CONTRACTS = {
  anthropic: {
    routeRole: "anthropic-api-v1",
    suffix: "/apis/anthropic/v1",
    api: "anthropic-messages",
    requestPolicy: "shopify-standard-v1",
  },
  openai: {
    routeRole: "openai-vendor-v1",
    suffix: "/vendors/openai/v1",
    api: "openai-responses",
    requestPolicy: "shopify-standard-v1",
  },
  google: {
    routeRole: "google-vertex-global",
    suffix:
      "/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google",
    api: "google-generative-ai",
    requestPolicy: "shopify-google-bearer-v1",
  },
  groq: {
    routeRole: "groq-openai-v1",
    suffix: "/vendors/groq/openai/v1",
    api: "openai-completions",
    requestPolicy: "shopify-standard-v1",
  },
  xai: {
    routeRole: "xai-vendor-v1",
    suffix: "/vendors/xai/v1",
    api: "pi-per-model",
    requestPolicy: "shopify-standard-v1",
  },
};
const STANDARD_HEADERS = [
  {
    name: "X-Shopify-Session-Affinity-Header",
    value: { kind: "fixed-public-literal", value: "pi-agent-session-id" },
  },
  {
    name: "pi-agent-session-id",
    value: {
      kind: "environment-reference",
      name: "PI_AGENT_LAUNCH_ID",
      template: "${PI_AGENT_LAUNCH_ID}",
    },
  },
  {
    name: "Shopify-Usage-Tag",
    value: { kind: "fixed-public-literal", value: "pi-agent" },
  },
];
const GOOGLE_HEADERS = [
  ...STANDARD_HEADERS,
  {
    name: "Authorization",
    value: {
      kind: "bearer-environment-reference",
      name: "SHOPIFY_PI_TOKEN",
      template: "Bearer ${SHOPIFY_PI_TOKEN}",
    },
  },
];
const require = createRequire(import.meta.url);
let properLockfile;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ReconcileFailure extends Error {
  constructor(error) {
    super(error.kind);
    this.error = error;
  }
}

class LockCompromisedFailure extends ReconcileFailure {}

function fail(error) {
  throw new ReconcileFailure(error);
}

function invalidInput(path) {
  fail({ kind: "invalid-input", path });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    types.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, path) {
  if (!isPlainObject(value)) {
    invalidInput(path);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    invalidInput(path);
  }
}

function validateJsonValue(value, error, ancestors = new Set()) {
  if (value !== null && typeof value === "object" && types.isProxy(value)) {
    fail(error);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      fail(error);
    }
    const keys = Object.keys(value);
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      fail(error);
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        fail(error);
      }
      validateJsonValue(descriptor.value, error, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  if (!isPlainObject(value) || ancestors.has(value)) {
    fail(error);
  }
  const keys = Object.keys(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== keys.length
  ) {
    fail(error);
  }
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(error);
    }
    validateJsonValue(descriptor.value, error, ancestors);
  }
  ancestors.delete(value);
}

function validateTargetRoot(value, path) {
  if (!isPlainObject(value)) {
    fail({ kind: "invalid-json", path });
  }
  validateJsonValue(value, { kind: "invalid-json", path });
}

function validateInputJson(value, path) {
  validateJsonValue(value, { kind: "invalid-input", path });
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function cloneJson(value) {
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, cloneJson(value[key])]),
    );
  }
  return value;
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalHash(value) {
  validateJsonValue(value, { kind: "invalid-input", path: "canonical-json" });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

export function hashCanonicalJsonInternal(value) {
  try {
    return { ok: true, valueHash: canonicalHash(value) };
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      return { ok: false, error: error.error };
    }
    throw error;
  }
}

function validateSafeString(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalidInput(path);
  }
}

function validateModel(model, path) {
  requireExactKeys(model, ["provider", "modelId"], path);
  if (!PROVIDER_SET.has(model.provider)) {
    invalidInput(`${path}.provider`);
  }
  validateSafeString(model.modelId, SAFE_MODEL_ID, `${path}.modelId`);
}

function validateRenderedStorePath(value, path) {
  if (typeof value !== "string" || !RENDERED_STORE_PATH.test(value)) {
    invalidInput(path);
  }
}

function validateProviderCatalog(catalog) {
  requireExactKeys(
    catalog,
    ["schemaVersion", "personal", "shopify", "defaults", "unsupported"],
    "managedConfig.providerCatalog",
  );
  if (catalog.schemaVersion !== 1) {
    invalidInput("managedConfig.providerCatalog.schemaVersion");
  }

  requireExactKeys(
    catalog.personal,
    [
      "role",
      "providerId",
      "api",
      "modelSource",
      "modelOverrides",
      "requestPolicy",
    ],
    "managedConfig.providerCatalog.personal",
  );
  const personal = catalog.personal;
  if (
    personal.role !== "personal-openai" ||
    personal.providerId !== "openai" ||
    personal.api !== "openai-responses" ||
    personal.modelSource !== "pi-0.83.0-built-in:openai" ||
    personal.modelOverrides !== "none" ||
    personal.requestPolicy !== "personal-pi-auth-v1"
  ) {
    invalidInput("managedConfig.providerCatalog.personal");
  }

  if (
    !Array.isArray(catalog.shopify) ||
    catalog.shopify.length !== PROVIDER_ORDER.length
  ) {
    invalidInput("managedConfig.providerCatalog.shopify");
  }
  for (let index = 0; index < PROVIDER_ORDER.length; index += 1) {
    const providerId = PROVIDER_ORDER[index];
    const contract = PROVIDER_CATALOG_CONTRACTS[providerId];
    const entry = catalog.shopify[index];
    const path = `managedConfig.providerCatalog.shopify[${index}]`;
    requireExactKeys(
      entry,
      [
        "role",
        "providerId",
        "route",
        "api",
        "modelSource",
        "modelOverrides",
        "requestPolicy",
      ],
      path,
    );
    requireExactKeys(entry.route, ["owner", "role", "suffix"], `${path}.route`);
    if (
      entry.role !== providerId ||
      entry.providerId !== providerId ||
      entry.route.owner !== "pi-agent-module" ||
      entry.route.role !== contract.routeRole ||
      entry.route.suffix !== contract.suffix ||
      entry.api !== contract.api ||
      entry.modelSource !== `pi-0.83.0-built-in:${providerId}` ||
      entry.modelOverrides !== "none" ||
      entry.requestPolicy !== contract.requestPolicy
    ) {
      invalidInput(path);
    }
  }

  requireExactKeys(
    catalog.defaults,
    ["personal", "shopify"],
    "managedConfig.providerCatalog.defaults",
  );
  for (const mode of ["personal", "shopify"]) {
    const path = `managedConfig.providerCatalog.defaults.${mode}`;
    requireExactKeys(catalog.defaults[mode], ["model", "reasoning"], path);
    if (
      catalog.defaults[mode].model !== "openai/gpt-5.6-sol" ||
      catalog.defaults[mode].reasoning !== "xhigh"
    ) {
      invalidInput(path);
    }
  }

  const unsupported = [
    { providerId: "cohere", policy: "reject", reason: "no-pi-core-api" },
    {
      providerId: "perplexity",
      policy: "reject",
      reason: "no-required-coding-tool-path",
    },
  ];
  if (
    !Array.isArray(catalog.unsupported) ||
    catalog.unsupported.length !== unsupported.length
  ) {
    invalidInput("managedConfig.providerCatalog.unsupported");
  }
  for (let index = 0; index < unsupported.length; index += 1) {
    const path = `managedConfig.providerCatalog.unsupported[${index}]`;
    requireExactKeys(
      catalog.unsupported[index],
      ["providerId", "policy", "reason"],
      path,
    );
    if (!sameClosedValue(catalog.unsupported[index], unsupported[index])) {
      invalidInput(path);
    }
  }
}

function validateProviderSelection(selection) {
  if (!isPlainObject(selection)) {
    invalidInput("managedConfig.providerSelection");
  }
  if (selection.mode === "personal") {
    requireExactKeys(
      selection,
      ["mode", "defaultModel"],
      "managedConfig.providerSelection",
    );
    validateModel(
      selection.defaultModel,
      "managedConfig.providerSelection.defaultModel",
    );
    if (selection.defaultModel.provider !== "openai") {
      invalidInput("managedConfig.providerSelection.defaultModel.provider");
    }
    return;
  }
  if (selection.mode !== "shopify-gateway") {
    invalidInput("managedConfig.providerSelection.mode");
  }
  requireExactKeys(
    selection,
    ["mode", "enabledRoles", "defaultModel"],
    "managedConfig.providerSelection",
  );
  if (
    !Array.isArray(selection.enabledRoles) ||
    selection.enabledRoles.length === 0
  ) {
    invalidInput("managedConfig.providerSelection.enabledRoles");
  }
  const roles = new Set();
  for (const role of selection.enabledRoles) {
    if (!PROVIDER_SET.has(role) || roles.has(role)) {
      invalidInput("managedConfig.providerSelection.enabledRoles");
    }
    roles.add(role);
  }
  validateModel(
    selection.defaultModel,
    "managedConfig.providerSelection.defaultModel",
  );
  if (!roles.has(selection.defaultModel.provider)) {
    invalidInput("managedConfig.providerSelection.defaultModel.provider");
  }
}

function validateManagedConfig(managedConfig) {
  validateInputJson(managedConfig, "managedConfig");
  requireExactKeys(managedConfig, MANAGED_CONFIG_KEYS, "managedConfig");
  if (managedConfig.schemaVersion !== 1) {
    invalidInput("managedConfig.schemaVersion");
  }
  validateSafeString(
    managedConfig.generation,
    SAFE_IDENTIFIER,
    "managedConfig.generation",
  );
  if (managedConfig.agentDir !== "pi-default") {
    invalidInput("managedConfig.agentDir");
  }
  requireExactKeys(managedConfig.agentMemory, ["secretReference", "url"], "managedConfig.agentMemory");
  if (
    managedConfig.agentMemory.url !== "http://127.0.0.1:3111"
    || typeof managedConfig.agentMemory.secretReference !== "string"
    || managedConfig.agentMemory.secretReference.length === 0
  ) {
    invalidInput("managedConfig.agentMemory");
  }
  requireExactKeys(
    managedConfig.settings,
    MANAGED_SETTING_KEYS,
    "managedConfig.settings",
  );
  validateModel(
    managedConfig.settings.defaultModel,
    "managedConfig.settings.defaultModel",
  );
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
      managedConfig.settings.defaultThinkingLevel,
    )
  ) {
    invalidInput("managedConfig.settings.defaultThinkingLevel");
  }
  validateRenderedStorePath(
    managedConfig.settings.shellPath,
    "managedConfig.settings.shellPath",
  );
  for (const key of ["installTelemetry", "selfUpdate", "unmanagedPackages"]) {
    if (managedConfig.settings[key] !== false) {
      invalidInput(`managedConfig.settings.${key}`);
    }
  }
  requireExactKeys(
    managedConfig.timeouts,
    ["bashDefaultMs"],
    "managedConfig.timeouts",
  );
  if (
    !Number.isSafeInteger(managedConfig.timeouts.bashDefaultMs) ||
    managedConfig.timeouts.bashDefaultMs < 1 ||
    managedConfig.timeouts.bashDefaultMs > 2147483647
  ) {
    invalidInput("managedConfig.timeouts.bashDefaultMs");
  }
  validateProviderCatalog(managedConfig.providerCatalog);
  validateProviderSelection(managedConfig.providerSelection);
  if (
    !sameClosedValue(
      managedConfig.settings.defaultModel,
      managedConfig.providerSelection.defaultModel,
    )
  ) {
    invalidInput("managedConfig.providerSelection.defaultModel");
  }

  validateRenderedStorePath(
    managedConfig.extensionManifest,
    "managedConfig.extensionManifest",
  );
  if (!Array.isArray(managedConfig.extensionOrder)) {
    invalidInput("managedConfig.extensionOrder");
  }
  const extensionNames = new Set();
  for (const extension of managedConfig.extensionOrder) {
    if (
      typeof extension !== "string" ||
      !SAFE_IDENTIFIER.test(extension) ||
      extensionNames.has(extension)
    ) {
      invalidInput("managedConfig.extensionOrder");
    }
    extensionNames.add(extension);
  }
  if (!Array.isArray(managedConfig.instructionResources)) {
    invalidInput("managedConfig.instructionResources");
  }
  for (const resource of managedConfig.instructionResources) {
    validateRenderedStorePath(resource, "managedConfig.instructionResources");
  }
  if (!isPlainObject(managedConfig.lspExecutables)) {
    invalidInput("managedConfig.lspExecutables");
  }
  for (const name of Object.keys(managedConfig.lspExecutables)) {
    validateSafeString(name, SAFE_IDENTIFIER, "managedConfig.lspExecutables");
    validateRenderedStorePath(
      managedConfig.lspExecutables[name],
      "managedConfig.lspExecutables",
    );
  }

  if (typeof managedConfig.mcpEndpoint !== "string") {
    invalidInput("managedConfig.mcpEndpoint");
  }
  let mcpEndpoint;
  try {
    mcpEndpoint = new URL(managedConfig.mcpEndpoint);
  } catch (_error) {
    invalidInput("managedConfig.mcpEndpoint");
  }
  if (
    mcpEndpoint.protocol !== "http:" ||
    mcpEndpoint.hostname !== "127.0.0.1" ||
    mcpEndpoint.port === "" ||
    Number(mcpEndpoint.port) < 1 ||
    Number(mcpEndpoint.port) > 65535 ||
    mcpEndpoint.pathname !== "/mcp" ||
    mcpEndpoint.username !== "" ||
    mcpEndpoint.password !== "" ||
    mcpEndpoint.search !== "" ||
    mcpEndpoint.hash !== "" ||
    mcpEndpoint.href !== managedConfig.mcpEndpoint
  ) {
    invalidInput("managedConfig.mcpEndpoint");
  }
  if (
    !new Set(["disabled", "audit", "enforced"]).has(
      managedConfig.sandboxDefault,
    )
  ) {
    invalidInput("managedConfig.sandboxDefault");
  }
}

function sameClosedValue(actual, expected) {
  return canonicalHash(actual) === canonicalHash(expected);
}

function validateHeaderValue(actual, expected, path) {
  requireExactKeys(actual, Object.keys(expected), path);
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      invalidInput(path);
    }
  }
}

function validateHeaders(headers, providerId, path) {
  const expected = providerId === "google" ? GOOGLE_HEADERS : STANDARD_HEADERS;
  if (!Array.isArray(headers) || headers.length !== expected.length) {
    invalidInput(path);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const headerPath = `${path}[${index}]`;
    requireExactKeys(headers[index], ["name", "value"], headerPath);
    if (headers[index].name !== expected[index].name) {
      invalidInput(headerPath);
    }
    validateHeaderValue(
      headers[index].value,
      expected[index].value,
      `${headerPath}.value`,
    );
  }
}

function validateProvider(provider, index) {
  const path = `providerProjection.providers[${index}]`;
  requireExactKeys(
    provider,
    [
      "providerId",
      "catalogRole",
      "baseUrl",
      "api",
      "modelCatalog",
      "credential",
      "headers",
    ],
    path,
  );
  if (
    !PROVIDER_SET.has(provider.providerId) ||
    provider.catalogRole !== provider.providerId
  ) {
    invalidInput(path);
  }

  if (typeof provider.baseUrl !== "string") {
    invalidInput(`${path}.baseUrl`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(provider.baseUrl);
  } catch (_error) {
    invalidInput(`${path}.baseUrl`);
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.origin === "null" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.href !== provider.baseUrl
  ) {
    invalidInput(`${path}.baseUrl`);
  }

  if (provider.providerId === "xai") {
    requireExactKeys(provider.api, ["kind", "providerApiField"], `${path}.api`);
    if (
      provider.api.kind !== "pi-per-model-api" ||
      provider.api.providerApiField !== "omit"
    ) {
      invalidInput(`${path}.api`);
    }
  } else {
    requireExactKeys(provider.api, ["kind", "value"], `${path}.api`);
    if (
      provider.api.kind !== "provider-api" ||
      provider.api.value !== API_BY_PROVIDER[provider.providerId]
    ) {
      invalidInput(`${path}.api`);
    }
  }

  requireExactKeys(
    provider.modelCatalog,
    ["source", "overrides"],
    `${path}.modelCatalog`,
  );
  if (
    provider.modelCatalog.source !==
      `pi-0.83.0-built-in:${provider.providerId}` ||
    !Array.isArray(provider.modelCatalog.overrides) ||
    provider.modelCatalog.overrides.length !== 0
  ) {
    invalidInput(`${path}.modelCatalog`);
  }

  requireExactKeys(
    provider.credential,
    ["field", "value"],
    `${path}.credential`,
  );
  if (provider.credential.field !== "apiKey") {
    invalidInput(`${path}.credential`);
  }
  requireExactKeys(
    provider.credential.value,
    ["kind", "name", "template"],
    `${path}.credential.value`,
  );
  if (
    provider.credential.value.kind !== "environment-reference" ||
    provider.credential.value.name !== "SHOPIFY_PI_TOKEN" ||
    provider.credential.value.template !== "${SHOPIFY_PI_TOKEN}"
  ) {
    invalidInput(`${path}.credential.value`);
  }
  validateHeaders(provider.headers, provider.providerId, `${path}.headers`);
}

function validateProviderProjection(projection) {
  validateInputJson(projection, "providerProjection");
  requireExactKeys(
    projection,
    ["schemaVersion", "generation", "mode", "default", "providers"],
    "providerProjection",
  );
  if (projection.schemaVersion !== 1) {
    invalidInput("providerProjection.schemaVersion");
  }
  validateSafeString(
    projection.generation,
    SAFE_IDENTIFIER,
    "providerProjection.generation",
  );
  if (projection.mode !== "personal" && projection.mode !== "shopify-gateway") {
    invalidInput("providerProjection.mode");
  }
  requireExactKeys(
    projection.default,
    ["model", "reasoning"],
    "providerProjection.default",
  );
  validateModel(projection.default.model, "providerProjection.default.model");
  if (
    projection.default.reasoning !== "xhigh" ||
    !Array.isArray(projection.providers)
  ) {
    invalidInput("providerProjection.default");
  }

  if (projection.mode === "personal") {
    if (
      projection.default.model.provider !== "openai" ||
      projection.providers.length !== 0
    ) {
      invalidInput("providerProjection.providers");
    }
    return;
  }
  if (projection.providers.length === 0) {
    invalidInput("providerProjection.providers");
  }

  const selectedProviders = new Set();
  for (let index = 0; index < projection.providers.length; index += 1) {
    validateProvider(projection.providers[index], index);
    const providerId = projection.providers[index].providerId;
    if (selectedProviders.has(providerId)) {
      invalidInput("providerProjection.providers");
    }
    selectedProviders.add(providerId);
  }
  if (!selectedProviders.has(projection.default.model.provider)) {
    invalidInput("providerProjection.default.model.provider");
  }
}

function providerPointer(providerId) {
  return `/providers/${providerId}`;
}

function providerIdFromPointer(pointer) {
  const prefix = "/providers/";
  return pointer.startsWith(prefix) ? pointer.slice(prefix.length) : null;
}

function validateOwnershipState(ownershipState) {
  validateInputJson(ownershipState, "ownershipState");
  requireExactKeys(
    ownershipState,
    ["schemaVersion", "generation", "transaction", "files"],
    "ownershipState",
  );
  if (ownershipState.schemaVersion !== 1) {
    invalidInput("ownershipState.schemaVersion");
  }
  validateSafeString(
    ownershipState.generation,
    SAFE_IDENTIFIER,
    "ownershipState.generation",
  );
  if (
    ownershipState.transaction !== "pending" &&
    ownershipState.transaction !== "committed"
  ) {
    invalidInput("ownershipState.transaction");
  }
  if (!isPlainObject(ownershipState.files)) {
    invalidInput("ownershipState.files");
  }

  for (const filePath of Object.keys(ownershipState.files)) {
    if (filePath !== SETTINGS_PATH && filePath !== MODELS_PATH) {
      invalidInput("ownershipState.files");
    }
    const records = ownershipState.files[filePath];
    if (!isPlainObject(records)) {
      invalidInput(`ownershipState.files.${filePath}`);
    }
    for (const pointer of Object.keys(records)) {
      if (filePath === SETTINGS_PATH) {
        if (!MANAGED_SETTING_POINTERS.has(pointer)) {
          invalidInput(`ownershipState.files.${filePath}`);
        }
      } else {
        const providerId = providerIdFromPointer(pointer);
        if (providerId === null || !PROVIDER_SET.has(providerId)) {
          invalidInput(`ownershipState.files.${filePath}`);
        }
      }
      requireExactKeys(
        records[pointer],
        ["valueHash"],
        `ownershipState.files.${filePath}`,
      );
      if (
        typeof records[pointer].valueHash !== "string" ||
        !VALUE_HASH.test(records[pointer].valueHash)
      ) {
        invalidInput(`ownershipState.files.${filePath}`);
      }
    }
  }
  return ownershipState;
}

function projectProvider(provider) {
  const headers = Object.fromEntries(
    provider.headers
      .map((header) => [
        header.name,
        header.value.kind === "fixed-public-literal"
          ? header.value.value
          : header.value.template,
      ])
      .sort(([left], [right]) => compareText(left, right)),
  );
  const entries = [];
  if (provider.api.kind === "provider-api") {
    entries.push(["api", provider.api.value]);
  }
  entries.push(["apiKey", provider.credential.value.template]);
  entries.push(["baseUrl", provider.baseUrl]);
  entries.push(["headers", headers]);
  return Object.fromEntries(entries);
}

function recordsFor(ownershipState, path) {
  if (!ownershipState || !hasOwn(ownershipState.files, path)) {
    return Object.create(null);
  }
  return ownershipState.files[path];
}

function managedDrift(path, pointer) {
  fail({ kind: "managed-drift", path, pointer });
}

function checkSameGenerationProviderIdentity(
  priorOwnership,
  priorProviders,
  desiredProviders,
  generation,
) {
  if (!priorOwnership || priorOwnership.generation !== generation) {
    return;
  }
  for (const providerId of PROVIDER_ORDER) {
    const pointer = providerPointer(providerId);
    const priorRecord = priorProviders[pointer];
    const desiredValue = desiredProviders.get(providerId);
    if ((priorRecord === undefined) !== (desiredValue === undefined)) {
      fail({ kind: "provider-projection-conflict", providerId });
    }
    if (
      priorRecord !== undefined &&
      priorRecord.valueHash !== canonicalHash(desiredValue)
    ) {
      fail({ kind: "provider-projection-conflict", providerId });
    }
  }
}

function checkActiveValue({
  path,
  pointer,
  currentContainer,
  currentKey,
  desiredValue,
  priorRecord,
  providerId,
}) {
  const desiredHash = canonicalHash(desiredValue);
  const currentExists = hasOwn(currentContainer, currentKey);
  const currentHash = currentExists
    ? canonicalHash(currentContainer[currentKey])
    : null;
  if (providerId !== undefined && priorRecord === undefined && currentExists) {
    managedDrift(path, pointer);
  }
  if (priorRecord !== undefined) {
    if (!currentExists || currentHash !== priorRecord.valueHash) {
      managedDrift(path, pointer);
    }
  } else if (currentExists && currentHash !== desiredHash) {
    managedDrift(path, pointer);
  }
  return desiredHash;
}

function checkStaleValue({
  path,
  pointer,
  currentContainer,
  currentKey,
  priorRecord,
}) {
  if (!hasOwn(currentContainer, currentKey)) {
    return "drop";
  }
  if (canonicalHash(currentContainer[currentKey]) === priorRecord.valueHash) {
    return "remove";
  }
  if (path === MODELS_PATH || SECURITY_SETTING_POINTERS.has(pointer)) {
    managedDrift(path, pointer);
  }
  return "retain";
}

function buildSettings(
  currentSettings,
  desiredSettings,
  priorSettings,
  retainedPointers,
) {
  const managedKeys = new Set(MANAGED_SETTING_KEYS);
  for (const pointer of Object.keys(priorSettings)) {
    managedKeys.add(pointer.slice(1));
  }

  const entries = [];
  for (const key of Object.keys(currentSettings)) {
    if (!managedKeys.has(key)) {
      entries.push([key, cloneJson(currentSettings[key])]);
    }
  }
  for (const key of MANAGED_SETTING_KEYS) {
    const pointer = `/${key}`;
    if (desiredSettings.has(key)) {
      entries.push([key, cloneJson(desiredSettings.get(key))]);
    } else if (retainedPointers.has(pointer)) {
      entries.push([key, cloneJson(currentSettings[key])]);
    }
  }
  return Object.fromEntries(entries);
}

function buildProviders(
  currentProviders,
  desiredProviders,
  priorProviders,
  retainedPointers,
) {
  const managedIds = new Set(desiredProviders.keys());
  for (const pointer of Object.keys(priorProviders)) {
    managedIds.add(providerIdFromPointer(pointer));
  }

  const entries = [];
  for (const providerId of Object.keys(currentProviders)) {
    if (!managedIds.has(providerId)) {
      entries.push([providerId, cloneJson(currentProviders[providerId])]);
    }
  }
  for (const providerId of PROVIDER_ORDER) {
    const pointer = providerPointer(providerId);
    if (desiredProviders.has(providerId)) {
      entries.push([providerId, cloneJson(desiredProviders.get(providerId))]);
    } else if (retainedPointers.has(pointer)) {
      entries.push([providerId, cloneJson(currentProviders[providerId])]);
    }
  }
  return Object.fromEntries(entries);
}

function buildModels(currentModels, nextProviders) {
  const entries = [];
  let foundProviders = false;
  for (const key of Object.keys(currentModels)) {
    if (key === "providers") {
      entries.push([key, nextProviders]);
      foundProviders = true;
    } else {
      entries.push([key, cloneJson(currentModels[key])]);
    }
  }
  if (!foundProviders && Object.keys(nextProviders).length !== 0) {
    entries.push(["providers", nextProviders]);
  }
  return Object.fromEntries(entries);
}

function ownershipState(generation, transaction, hashes) {
  const files = [];
  for (const path of [MODELS_PATH, SETTINGS_PATH]) {
    const records = hashes.get(path);
    if (!records || records.size === 0) {
      continue;
    }
    files.push([
      path,
      Object.fromEntries(
        [...records.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([pointer, valueHash]) => [pointer, { valueHash }]),
      ),
    ]);
  }
  return {
    schemaVersion: 1,
    generation,
    transaction,
    files: Object.fromEntries(files),
  };
}

function planEnabled(input) {
  if (!isPlainObject(input)) {
    invalidInput("$");
  }
  const inputKeys = [
    "managedConfig",
    "providerProjection",
    "currentSettings",
    "currentModels",
  ];
  if (hasOwn(input, "ownershipState")) {
    inputKeys.push("ownershipState");
  }
  requireExactKeys(input, inputKeys, "$");

  validateTargetRoot(input.currentSettings, SETTINGS_PATH);
  validateTargetRoot(input.currentModels, MODELS_PATH);
  if (
    hasOwn(input.currentModels, "providers") &&
    !isPlainObject(input.currentModels.providers)
  ) {
    fail({ kind: "invalid-json", path: MODELS_PATH });
  }

  validateManagedConfig(input.managedConfig);
  validateProviderProjection(input.providerProjection);
  const priorOwnership = hasOwn(input, "ownershipState")
    ? validateOwnershipState(input.ownershipState)
    : null;
  if (priorOwnership?.transaction === "pending") {
    fail({ kind: "pending-transaction", path: OWNERSHIP_PATH });
  }
  if (input.managedConfig.generation !== input.providerProjection.generation) {
    invalidInput("providerProjection.generation");
  }
  if (
    !sameClosedValue(
      input.managedConfig.settings.defaultModel,
      input.providerProjection.default.model,
    ) ||
    input.managedConfig.settings.defaultThinkingLevel !==
      input.providerProjection.default.reasoning
  ) {
    invalidInput("providerProjection.default");
  }
  if (
    input.managedConfig.providerSelection.mode !== input.providerProjection.mode
  ) {
    invalidInput("providerProjection.mode");
  }
  const selectedProviderIds =
    input.managedConfig.providerSelection.mode === "shopify-gateway"
      ? new Set(input.managedConfig.providerSelection.enabledRoles)
      : new Set();
  const projectedProviderIds = new Set(
    input.providerProjection.providers.map(({ providerId }) => providerId),
  );
  for (const providerId of PROVIDER_ORDER) {
    if (
      selectedProviderIds.has(providerId) !==
      projectedProviderIds.has(providerId)
    ) {
      invalidInput("providerProjection.providers");
    }
  }

  const currentProviders = hasOwn(input.currentModels, "providers")
    ? input.currentModels.providers
    : Object.create(null);
  const desiredSettings = new Map(
    MANAGED_SETTING_KEYS.map((key) => [
      key,
      cloneJson(input.managedConfig.settings[key]),
    ]),
  );
  const projectionByProvider = new Map(
    input.providerProjection.providers.map((provider) => [
      provider.providerId,
      provider,
    ]),
  );
  const desiredProviders = new Map(
    PROVIDER_ORDER.filter((providerId) =>
      projectionByProvider.has(providerId),
    ).map((providerId) => [
      providerId,
      projectProvider(projectionByProvider.get(providerId)),
    ]),
  );
  const priorSettings = recordsFor(priorOwnership, SETTINGS_PATH);
  const priorProviders = recordsFor(priorOwnership, MODELS_PATH);
  const retainedSettings = new Set();
  const retainedProviders = new Set();
  const nextHashes = new Map([
    [SETTINGS_PATH, new Map()],
    [MODELS_PATH, new Map()],
  ]);
  checkSameGenerationProviderIdentity(
    priorOwnership,
    priorProviders,
    desiredProviders,
    input.providerProjection.generation,
  );

  for (const [key, desiredValue] of desiredSettings) {
    const pointer = `/${key}`;
    const desiredHash = checkActiveValue({
      path: SETTINGS_PATH,
      pointer,
      currentContainer: input.currentSettings,
      currentKey: key,
      desiredValue,
      priorRecord: priorSettings[pointer],
    });
    nextHashes.get(SETTINGS_PATH).set(pointer, desiredHash);
  }
  for (const pointer of Object.keys(priorSettings)) {
    const key = pointer.slice(1);
    if (desiredSettings.has(key)) {
      continue;
    }
    const disposition = checkStaleValue({
      path: SETTINGS_PATH,
      pointer,
      currentContainer: input.currentSettings,
      currentKey: key,
      priorRecord: priorSettings[pointer],
    });
    if (disposition === "retain") {
      retainedSettings.add(pointer);
      nextHashes
        .get(SETTINGS_PATH)
        .set(pointer, priorSettings[pointer].valueHash);
    }
  }

  for (const [providerId, desiredValue] of desiredProviders) {
    const pointer = providerPointer(providerId);
    const desiredHash = checkActiveValue({
      path: MODELS_PATH,
      pointer,
      currentContainer: currentProviders,
      currentKey: providerId,
      desiredValue,
      priorRecord: priorProviders[pointer],
      providerId,
    });
    nextHashes.get(MODELS_PATH).set(pointer, desiredHash);
  }
  for (const pointer of Object.keys(priorProviders)) {
    const providerId = providerIdFromPointer(pointer);
    if (desiredProviders.has(providerId)) {
      continue;
    }
    const disposition = checkStaleValue({
      path: MODELS_PATH,
      pointer,
      currentContainer: currentProviders,
      currentKey: providerId,
      priorRecord: priorProviders[pointer],
    });
    if (disposition === "retain") {
      retainedProviders.add(pointer);
      nextHashes
        .get(MODELS_PATH)
        .set(pointer, priorProviders[pointer].valueHash);
    }
  }

  const nextSettings = buildSettings(
    input.currentSettings,
    desiredSettings,
    priorSettings,
    retainedSettings,
  );
  const nextProviders = buildProviders(
    currentProviders,
    desiredProviders,
    priorProviders,
    retainedProviders,
  );
  const nextModels = buildModels(input.currentModels, nextProviders);
  const candidates = [
    [MODELS_PATH, input.currentModels, nextModels],
    [SETTINGS_PATH, input.currentSettings, nextSettings],
  ];
  const writes = candidates
    .filter(
      ([_path, currentValue, nextValue]) =>
        canonicalHash(currentValue) !== canonicalHash(nextValue),
    )
    .map(([path, _currentValue, value]) => ({ path, value }));
  const generation = input.managedConfig.generation;

  const reconcileResult = {
    ok: true,
    generation,
    changed: writes.map(({ path }) => path),
  };
  return {
    reconcileResult,
    writePlan: {
      schemaVersion: 1,
      generation,
      writes,
      ownershipStates: {
        pending: ownershipState(generation, "pending", nextHashes),
        committed: ownershipState(generation, "committed", nextHashes),
      },
    },
  };
}

// Pure Task 2.4 handoff: this computes write intent and ownership states without I/O.
export function planManagedReconciliationInternal(input) {
  try {
    return planEnabled(input);
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      return {
        reconcileResult: { ok: false, error: error.error },
        writePlan: null,
      };
    }
    return {
      reconcileResult: {
        ok: false,
        error: { kind: "invalid-input", path: "$" },
      },
      writePlan: null,
    };
  }
}

export function planManagedReconciliation(input) {
  return planManagedReconciliationInternal(input).reconcileResult;
}

function byteHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function writeFailure(filePath) {
  fail({ kind: "write-failure", path: filePath });
}

function lockCompromised(filePath) {
  throw new LockCompromisedFailure({ kind: "write-failure", path: filePath });
}

function pendingTransaction() {
  fail({ kind: "pending-transaction", path: OWNERSHIP_PATH });
}

function getProperLockfile() {
  if (properLockfile === undefined) {
    try {
      properLockfile = require("proper-lockfile");
    } catch (_error) {
      writeFailure(INTEGRATION_LOCK_PATH);
    }
  }
  return properLockfile;
}

async function readBytes(agentDir, filePath) {
  try {
    return await fs.promises.readFile(path.join(agentDir, filePath), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    writeFailure(filePath);
  }
}

function parseJsonBytes(bytes, filePath, fallback) {
  if (bytes === null) {
    return fallback;
  }
  try {
    return JSON.parse(bytes);
  } catch (_error) {
    fail({ kind: "invalid-json", path: filePath });
  }
}

async function readOwnership(agentDir) {
  const bytes = await readBytes(agentDir, OWNERSHIP_PATH);
  if (bytes === null) {
    return { bytes, value: null };
  }
  const value = parseJsonBytes(bytes, OWNERSHIP_PATH, null);
  try {
    validateOwnershipState(value);
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      fail({ kind: "invalid-json", path: OWNERSHIP_PATH });
    }
    throw error;
  }
  return { bytes, value };
}

async function syncDirectory(agentDir, errorPath, assertLocks) {
  let handle;
  try {
    handle = await fs.promises.open(agentDir, "r");
    assertLocks();
    await handle.sync();
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    writeFailure(errorPath);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (_error) {
        writeFailure(errorPath);
      }
    }
  }
}

async function removeFile(agentDir, filePath, errorPath, assertLocks) {
  try {
    assertLocks();
    await fs.promises.unlink(path.join(agentDir, filePath));
    return true;
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    writeFailure(errorPath);
  }
}

function privateTemporaryName(targetPath) {
  return `${TEMPORARY_PREFIX}${randomUUID()}-${path.basename(targetPath)}.tmp`;
}

async function writePrivateTemporary(
  agentDir,
  temporaryPath,
  bytes,
  errorPath,
  assertLocks,
) {
  let handle;
  try {
    assertLocks();
    handle = await fs.promises.open(
      path.join(agentDir, temporaryPath),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      FILE_MODE,
    );
    assertLocks();
    await handle.chmod(FILE_MODE);
    assertLocks();
    await handle.writeFile(bytes, "utf8");
    assertLocks();
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (_closeError) {
        // The original write failure remains authoritative.
      }
    }
    try {
      assertLocks();
      await fs.promises.unlink(path.join(agentDir, temporaryPath));
    } catch (cleanupError) {
      if (cleanupError instanceof ReconcileFailure) {
        throw error instanceof ReconcileFailure ? error : cleanupError;
      }
      if (errorCode(cleanupError) !== "ENOENT") {
        writeFailure(errorPath);
      }
    }
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    writeFailure(errorPath);
  }
}

async function publishTemporary(
  agentDir,
  temporaryPath,
  targetPath,
  assertLocks,
) {
  try {
    assertLocks();
    await fs.promises.rename(
      path.join(agentDir, temporaryPath),
      path.join(agentDir, targetPath),
    );
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    writeFailure(targetPath);
  }
  await syncDirectory(agentDir, targetPath, assertLocks);
}

async function atomicWritePrivate(agentDir, targetPath, bytes, assertLocks) {
  const temporaryPath = privateTemporaryName(targetPath);
  await writePrivateTemporary(
    agentDir,
    temporaryPath,
    bytes,
    targetPath,
    assertLocks,
  );
  try {
    await publishTemporary(agentDir, temporaryPath, targetPath, assertLocks);
  } catch (error) {
    await removeFile(agentDir, temporaryPath, targetPath, assertLocks);
    throw error;
  }
}

async function cleanupTemporaryFiles(agentDir, assertLocks, keep = new Set()) {
  let names;
  try {
    names = await fs.promises.readdir(agentDir);
  } catch (_error) {
    writeFailure(OWNERSHIP_PATH);
  }
  let changed = false;
  for (const name of names) {
    if (
      name !== TRANSACTION_PATH &&
      name.startsWith(TEMPORARY_PREFIX) &&
      !keep.has(name)
    ) {
      changed =
        (await removeFile(agentDir, name, OWNERSHIP_PATH, assertLocks)) ||
        changed;
    }
  }
  if (changed) {
    await syncDirectory(agentDir, OWNERSHIP_PATH, assertLocks);
  }
}

function validateTransactionJournal(journal) {
  try {
    validateInputJson(journal, "transaction");
    requireExactKeys(
      journal,
      [
        "schemaVersion",
        "generation",
        "previousOwnershipHash",
        "pendingOwnership",
        "committedOwnership",
        "targets",
      ],
      "transaction",
    );
    if (journal.schemaVersion !== 1) {
      pendingTransaction();
    }
    validateSafeString(
      journal.generation,
      SAFE_IDENTIFIER,
      "transaction.generation",
    );
    if (
      journal.previousOwnershipHash !== null &&
      (typeof journal.previousOwnershipHash !== "string" ||
        !VALUE_HASH.test(journal.previousOwnershipHash))
    ) {
      pendingTransaction();
    }
    validateOwnershipState(journal.pendingOwnership);
    validateOwnershipState(journal.committedOwnership);
    if (
      journal.pendingOwnership.transaction !== "pending" ||
      journal.committedOwnership.transaction !== "committed" ||
      journal.pendingOwnership.generation !== journal.generation ||
      journal.committedOwnership.generation !== journal.generation ||
      !sameClosedValue(
        { ...journal.pendingOwnership, transaction: "committed" },
        journal.committedOwnership,
      )
    ) {
      pendingTransaction();
    }
    if (
      !Array.isArray(journal.targets) ||
      journal.targets.length === 0 ||
      journal.targets.length > TARGET_PATHS.size
    ) {
      pendingTransaction();
    }
    const targetPaths = new Set();
    const temporaryPaths = new Set();
    for (const target of journal.targets) {
      requireExactKeys(
        target,
        ["path", "temporaryPath", "beforeHash", "afterHash"],
        "transaction.targets",
      );
      if (
        !TARGET_PATHS.has(target.path) ||
        targetPaths.has(target.path) ||
        typeof target.temporaryPath !== "string" ||
        path.basename(target.temporaryPath) !== target.temporaryPath ||
        !target.temporaryPath.startsWith(TEMPORARY_PREFIX) ||
        !target.temporaryPath.endsWith(`-${target.path}.tmp`) ||
        temporaryPaths.has(target.temporaryPath) ||
        (target.beforeHash !== null &&
          (typeof target.beforeHash !== "string" ||
            !VALUE_HASH.test(target.beforeHash))) ||
        typeof target.afterHash !== "string" ||
        !VALUE_HASH.test(target.afterHash)
      ) {
        pendingTransaction();
      }
      targetPaths.add(target.path);
      temporaryPaths.add(target.temporaryPath);
    }
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      pendingTransaction();
    }
    throw error;
  }
  return journal;
}

async function readTransactionJournal(agentDir) {
  const bytes = await readBytes(agentDir, TRANSACTION_PATH);
  if (bytes === null) {
    return null;
  }
  let journal;
  try {
    journal = JSON.parse(bytes);
  } catch (_error) {
    pendingTransaction();
  }
  return validateTransactionJournal(journal);
}

async function inspectTransactionTarget(agentDir, target) {
  const [currentBytes, temporaryBytes] = await Promise.all([
    readBytes(agentDir, target.path),
    readBytes(agentDir, target.temporaryPath),
  ]);
  return {
    target,
    currentHash: currentBytes === null ? null : byteHash(currentBytes),
    temporaryHash: temporaryBytes === null ? null : byteHash(temporaryBytes),
  };
}

async function cleanupJournal(agentDir, journal, assertLocks) {
  for (const target of journal.targets) {
    await removeFile(
      agentDir,
      target.temporaryPath,
      OWNERSHIP_PATH,
      assertLocks,
    );
  }
  await removeFile(agentDir, TRANSACTION_PATH, OWNERSHIP_PATH, assertLocks);
  await cleanupTemporaryFiles(agentDir, assertLocks);
  await syncDirectory(agentDir, OWNERSHIP_PATH, assertLocks);
}

async function recoverPendingTransaction(agentDir, assertLocks) {
  const ownership = await readOwnership(agentDir);
  const journal = await readTransactionJournal(agentDir);

  if (journal === null) {
    if (ownership.value?.transaction === "pending") {
      pendingTransaction();
    }
    await cleanupTemporaryFiles(agentDir, assertLocks);
    return;
  }

  const inspected = await Promise.all(
    journal.targets.map((target) => inspectTransactionTarget(agentDir, target)),
  );
  if (ownership.value?.transaction === "pending") {
    if (!sameClosedValue(ownership.value, journal.pendingOwnership)) {
      pendingTransaction();
    }
    for (const state of inspected) {
      if (state.currentHash === state.target.afterHash) {
        if (
          state.temporaryHash !== null &&
          state.temporaryHash !== state.target.afterHash
        ) {
          pendingTransaction();
        }
      } else if (
        state.currentHash !== state.target.beforeHash ||
        state.temporaryHash !== state.target.afterHash
      ) {
        pendingTransaction();
      }
    }

    for (const state of inspected) {
      assertLocks();
      if (state.currentHash === state.target.afterHash) {
        await removeFile(
          agentDir,
          state.target.temporaryPath,
          state.target.path,
          assertLocks,
        );
      } else {
        await publishTemporary(
          agentDir,
          state.target.temporaryPath,
          state.target.path,
          assertLocks,
        );
      }
    }
    assertLocks();
    await atomicWritePrivate(
      agentDir,
      OWNERSHIP_PATH,
      jsonBytes(journal.committedOwnership),
      assertLocks,
    );
    await cleanupJournal(agentDir, journal, assertLocks);
    return;
  }

  const ownershipHash =
    ownership.bytes === null ? null : byteHash(ownership.bytes);
  if (ownershipHash === journal.previousOwnershipHash) {
    if (
      inspected.some(
        (state) =>
          state.currentHash !== state.target.beforeHash ||
          state.temporaryHash !== state.target.afterHash,
      )
    ) {
      pendingTransaction();
    }
    await cleanupJournal(agentDir, journal, assertLocks);
    return;
  }

  if (
    ownership.value?.transaction === "committed" &&
    sameClosedValue(ownership.value, journal.committedOwnership) &&
    inspected.every(
      (state) =>
        state.currentHash === state.target.afterHash &&
        (state.temporaryHash === null ||
          state.temporaryHash === state.target.afterHash),
    )
  ) {
    await cleanupJournal(agentDir, journal, assertLocks);
    return;
  }
  pendingTransaction();
}

async function acquireLock(
  targetPath,
  lockfilePath,
  timeoutMs,
  errorPath,
  prerequisiteLock = null,
) {
  const lockfile = getProperLockfile();
  const deadline = Date.now() + timeoutMs;
  let compromised = false;
  const assertOwned = () => {
    if (compromised) {
      lockCompromised(errorPath);
    }
  };
  const assertPrerequisite = () => prerequisiteLock?.assert();
  const assertHeld = () => {
    assertPrerequisite();
    assertOwned();
  };
  for (;;) {
    assertPrerequisite();
    try {
      const release = await lockfile.lock(targetPath, {
        realpath: false,
        retries: 0,
        ...(lockfilePath === null ? {} : { lockfilePath }),
        onCompromised: () => {
          compromised = true;
        },
      });
      assertHeld();
      const heldLock = {
        assert: assertHeld,
        async release() {
          assertHeld();
          try {
            await release();
          } catch (_error) {
            assertHeld();
            writeFailure(errorPath);
          }
        },
      };
      return heldLock;
    } catch (error) {
      assertPrerequisite();
      if (error instanceof ReconcileFailure) {
        throw error;
      }
      if (errorCode(error) !== "ELOCKED") {
        writeFailure(errorPath);
      }
      const remaining = deadline - Date.now();
      assertPrerequisite();
      if (remaining <= 0) {
        assertPrerequisite();
        fail({ kind: "lock-timeout", path: errorPath });
      }
      assertPrerequisite();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(20, remaining)),
      );
      assertPrerequisite();
    }
  }
}

async function withLock(lock, errorPath, operation) {
  let operationError;
  let value;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }

  if (operationError instanceof LockCompromisedFailure) {
    throw operationError;
  }
  lock.assert();

  let releaseError;
  try {
    await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (releaseError instanceof LockCompromisedFailure) {
    throw releaseError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (releaseError !== undefined) {
    if (releaseError instanceof ReconcileFailure) {
      throw releaseError;
    }
    writeFailure(errorPath);
  }
  return value;
}

function validateExecutionInput(input) {
  if (!isPlainObject(input)) {
    invalidInput("$");
  }
  const inputKeys = ["agentDir", "managedConfig", "providerProjection"];
  if (hasOwn(input, "lockTimeoutMs")) {
    inputKeys.push("lockTimeoutMs");
  }
  requireExactKeys(input, inputKeys, "$");
  if (
    typeof input.agentDir !== "string" ||
    !path.isAbsolute(input.agentDir) ||
    path.normalize(input.agentDir) !== input.agentDir
  ) {
    invalidInput("agentDir");
  }
  const lockTimeoutMs = input.lockTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs <= 0 ||
    lockTimeoutMs > 600_000
  ) {
    invalidInput("lockTimeoutMs");
  }
  const validation = planManagedReconciliationInternal({
    managedConfig: input.managedConfig,
    providerProjection: input.providerProjection,
    currentSettings: {},
    currentModels: {},
  });
  if (!validation.reconcileResult.ok) {
    fail(validation.reconcileResult.error);
  }
  return lockTimeoutMs;
}

function validateProjectionExecutionInput(input) {
  try {
    if (!isPlainObject(input)) {
      invalidInput("$");
    }
    const actualKeys = Reflect.ownKeys(input);
    const inputKeys = ["agentDir", "managedConfig", "projectionCallback"];
    if (actualKeys.includes("lockTimeoutMs")) {
      inputKeys.push("lockTimeoutMs");
    }
    if (
      actualKeys.some((key) => typeof key !== "string") ||
      actualKeys.length !== inputKeys.length ||
      [...actualKeys]
        .sort()
        .some((key, index) => key !== [...inputKeys].sort()[index])
    ) {
      invalidInput("$");
    }
    for (const key of actualKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        invalidInput("$");
      }
    }
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    invalidInput("$");
  }
  if (
    typeof input.agentDir !== "string" ||
    !path.isAbsolute(input.agentDir) ||
    path.normalize(input.agentDir) !== input.agentDir
  ) {
    invalidInput("agentDir");
  }
  if (typeof input.projectionCallback !== "function") {
    invalidInput("projectionCallback");
  }
  const lockTimeoutMs = input.lockTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs <= 0 ||
    lockTimeoutMs > 600_000
  ) {
    invalidInput("lockTimeoutMs");
  }
  validateManagedConfig(input.managedConfig);
  return lockTimeoutMs;
}

function projectionFromCallbackResult(result) {
  try {
    if (!isPlainObject(result)) {
      invalidInput("projectionCallback");
    }
    const keys = Reflect.ownKeys(result);
    if (keys.length !== 1 || keys[0] !== "providerProjection") {
      invalidInput("projectionCallback");
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      result,
      "providerProjection",
    );
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      invalidInput("projectionCallback");
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      throw error;
    }
    invalidInput("projectionCallback");
  }
}

async function executeWritePlan(
  agentDir,
  writePlan,
  currentBytes,
  ownershipBytes,
  assertLocks,
) {
  const staged = [];
  let journalPublished = false;
  try {
    for (const write of writePlan.writes) {
      const bytes = jsonBytes(write.value);
      const temporaryPath = privateTemporaryName(write.path);
      await writePrivateTemporary(
        agentDir,
        temporaryPath,
        bytes,
        write.path,
        assertLocks,
      );
      staged.push({
        path: write.path,
        temporaryPath,
        beforeHash:
          currentBytes.get(write.path) === null
            ? null
            : byteHash(currentBytes.get(write.path)),
        afterHash: byteHash(bytes),
      });
    }

    const journal = {
      schemaVersion: 1,
      generation: writePlan.generation,
      previousOwnershipHash:
        ownershipBytes === null ? null : byteHash(ownershipBytes),
      pendingOwnership: writePlan.ownershipStates.pending,
      committedOwnership: writePlan.ownershipStates.committed,
      targets: staged,
    };
    const journalTemporaryPath = privateTemporaryName(TRANSACTION_PATH);
    await writePrivateTemporary(
      agentDir,
      journalTemporaryPath,
      jsonBytes(journal),
      OWNERSHIP_PATH,
      assertLocks,
    );
    try {
      assertLocks();
      await fs.promises.rename(
        path.join(agentDir, journalTemporaryPath),
        path.join(agentDir, TRANSACTION_PATH),
      );
      journalPublished = true;
    } catch (error) {
      if (error instanceof ReconcileFailure) {
        throw error;
      }
      writeFailure(OWNERSHIP_PATH);
    }
    await syncDirectory(agentDir, OWNERSHIP_PATH, assertLocks);

    assertLocks();
    await atomicWritePrivate(
      agentDir,
      OWNERSHIP_PATH,
      jsonBytes(writePlan.ownershipStates.pending),
      assertLocks,
    );
    for (const target of staged) {
      assertLocks();
      await publishTemporary(
        agentDir,
        target.temporaryPath,
        target.path,
        assertLocks,
      );
    }
    assertLocks();
    await atomicWritePrivate(
      agentDir,
      OWNERSHIP_PATH,
      jsonBytes(writePlan.ownershipStates.committed),
      assertLocks,
    );
    await cleanupJournal(agentDir, journal, assertLocks);
  } catch (error) {
    if (!journalPublished) {
      for (const target of staged) {
        await removeFile(
          agentDir,
          target.temporaryPath,
          OWNERSHIP_PATH,
          assertLocks,
        );
      }
      await cleanupTemporaryFiles(agentDir, assertLocks);
    }
    throw error;
  }
}

async function reconcileLocked(
  input,
  integrationLock,
  settingsLock,
  projectionCallback = null,
) {
  const assertLocks = () => {
    integrationLock.assert();
    settingsLock.assert();
  };
  await recoverPendingTransaction(input.agentDir, assertLocks);
  assertLocks();

  const [settingsBytes, modelsBytes, ownership, authBytes] = await Promise.all([
    readBytes(input.agentDir, SETTINGS_PATH),
    readBytes(input.agentDir, MODELS_PATH),
    readOwnership(input.agentDir),
    projectionCallback === null
      ? Promise.resolve(null)
      : readBytes(input.agentDir, AUTH_PATH),
  ]);
  assertLocks();
  const currentSettings = parseJsonBytes(settingsBytes, SETTINGS_PATH, {});
  const currentModels = parseJsonBytes(modelsBytes, MODELS_PATH, {});
  let providerProjection = input.providerProjection;
  if (projectionCallback !== null) {
    const currentAuth = parseJsonBytes(authBytes, AUTH_PATH, {});
    validateTargetRoot(currentAuth, AUTH_PATH);
    const snapshot = {
      currentSettings,
      currentModels,
      currentAuthProviderIds: Object.freeze(
        Object.keys(currentAuth).sort(compareText),
      ),
      ...(ownership.value === null ? {} : { ownershipState: ownership.value }),
    };
    deepFreezeJson(snapshot);
    providerProjection = projectionFromCallbackResult(
      projectionCallback(snapshot),
    );
    assertLocks();
  }
  const execution = planManagedReconciliationInternal({
    managedConfig: input.managedConfig,
    providerProjection,
    currentSettings,
    currentModels,
    ...(ownership.value === null ? {} : { ownershipState: ownership.value }),
  });
  if (!execution.reconcileResult.ok) {
    return execution.reconcileResult;
  }

  if (execution.writePlan.writes.length === 0) {
    const committedBytes = jsonBytes(
      execution.writePlan.ownershipStates.committed,
    );
    let ownershipMode = null;
    if (ownership.bytes !== null) {
      try {
        ownershipMode =
          (await fs.promises.stat(path.join(input.agentDir, OWNERSHIP_PATH)))
            .mode & 0o777;
      } catch (_error) {
        writeFailure(OWNERSHIP_PATH);
      }
    }
    if (ownership.bytes !== committedBytes || ownershipMode !== FILE_MODE) {
      assertLocks();
      await atomicWritePrivate(
        input.agentDir,
        OWNERSHIP_PATH,
        committedBytes,
        assertLocks,
      );
    }
    return execution.reconcileResult;
  }

  await executeWritePlan(
    input.agentDir,
    execution.writePlan,
    new Map([
      [SETTINGS_PATH, settingsBytes],
      [MODELS_PATH, modelsBytes],
    ]),
    ownership.bytes,
    assertLocks,
  );
  return execution.reconcileResult;
}

async function reconcileWithLocks(
  input,
  lockTimeoutMs,
  projectionCallback = null,
) {
  try {
    await fs.promises.mkdir(input.agentDir, { recursive: true, mode: 0o700 });
  } catch (_error) {
    writeFailure(OWNERSHIP_PATH);
  }
  const integrationLock = await acquireLock(
    input.agentDir,
    path.join(input.agentDir, INTEGRATION_LOCK_PATH),
    lockTimeoutMs,
    INTEGRATION_LOCK_PATH,
  );
  return withLock(integrationLock, INTEGRATION_LOCK_PATH, async () => {
    const settingsLock = await acquireLock(
      path.join(input.agentDir, SETTINGS_PATH),
      null,
      lockTimeoutMs,
      SETTINGS_PATH,
      integrationLock,
    );
    return withLock(settingsLock, SETTINGS_PATH, () =>
      reconcileLocked(input, integrationLock, settingsLock, projectionCallback),
    );
  });
}

export async function reconcileManagedState(input) {
  try {
    const lockTimeoutMs = validateExecutionInput(input);
    return await reconcileWithLocks(input, lockTimeoutMs);
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      return { ok: false, error: error.error };
    }
    return {
      ok: false,
      error: { kind: "write-failure", path: OWNERSHIP_PATH },
    };
  }
}

export async function reconcileManagedStateWithProviderProjection(input) {
  try {
    const lockTimeoutMs = validateProjectionExecutionInput(input);
    return await reconcileWithLocks(
      input,
      lockTimeoutMs,
      input.projectionCallback,
    );
  } catch (error) {
    if (error instanceof ReconcileFailure) {
      return { ok: false, error: error.error };
    }
    throw error;
  }
}

async function runCli() {
  if (process.argv.length > 2) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { kind: "invalid-input", path: "argv" } })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { kind: "invalid-input", path: "$" } })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await reconcileManagedState(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli().catch(() => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { kind: "write-failure", path: OWNERSHIP_PATH } })}\n`,
    );
    process.exitCode = 1;
  });
}
