import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CATALOG_DIGEST = "__PI_AGENT_SANDBOX_CATALOG_DIGEST__";
const DEFAULT_DIGEST = "__PI_AGENT_SANDBOX_DEFAULT_DIGEST__";
const CATALOG_PATH = fileURLToPath(
  new URL("../../share/pi-agent/nono/catalog.json", import.meta.url),
);
const DEFAULT_PATH = fileURLToPath(
  new URL("../../share/pi-agent/sandbox/default.json", import.meta.url),
);
const OVERRIDE_NAMES = Object.freeze([
  "PI_NONO",
  "PI_NONO_PROFILE",
  "PI_NONO_LISTEN_PORTS",
]);
const STATES = Object.freeze(["disabled", "audit", "enforced"]);
const PROFILES = Object.freeze(["pi-audit", "pi-managed", "pi-review"]);
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const LISTEN_PORT_FORMAT =
  "comma-separated canonical decimal ports from 1 through 65535";
const ACCEPTED = deepFreeze({
  states: STATES,
  profiles: PROFILES,
  listenPorts: LISTEN_PORT_FORMAT,
});
const DEFAULT_PROFILES = Object.freeze({
  audit: "pi-audit",
  enforced: "pi-managed",
});
const INVOCATION_ERROR = "sandbox resolver invocation rejected";
const CONTRACT_ERROR = "sandbox resolver contract validation failed";
const ENVIRONMENT_ERROR = "sandbox environment input rejected";
const STATE_ERROR =
  "sandbox override PI_NONO is invalid; accepted values: disabled, audit, enforced";
const PROFILE_ERROR =
  "sandbox override PI_NONO_PROFILE is invalid; accepted values: pi-audit, pi-managed, pi-review";
const PORT_ERROR =
  `sandbox override PI_NONO_LISTEN_PORTS is invalid; accepted format: ${LISTEN_PORT_FORMAT}`;
const DISABLED_CONFLICT_ERROR =
  "sandbox disabled state conflicts with enabled-only overrides; accepted recovery: unset PI_NONO_PROFILE and PI_NONO_LISTEN_PORTS, or set PI_NONO to audit or enforced";

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

function isExactDataObject(value, expectedKeys) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string") ||
    [...keys].sort().some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function readVerifiedArtifact(artifactPath, expectedDigest) {
  try {
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) fail(CONTRACT_ERROR);
    const bytes = readFileSync(artifactPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedDigest) fail(CONTRACT_ERROR);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(CONTRACT_ERROR);
  }
}

function validateContract() {
  const catalog = readVerifiedArtifact(CATALOG_PATH, CATALOG_DIGEST);
  const defaultArtifact = readVerifiedArtifact(DEFAULT_PATH, DEFAULT_DIGEST);
  if (
    !isExactDataObject(defaultArtifact, ["defaultState", "schemaVersion"]) ||
    defaultArtifact.schemaVersion !== 1 ||
    !STATES.includes(defaultArtifact.defaultState) ||
    !isExactDataObject(catalog, [
      "license",
      "nonoVersion",
      "profiles",
      "schemaVersion",
      "source",
    ]) ||
    catalog.schemaVersion !== 1 ||
    !isExactDataObject(catalog.profiles, PROFILES)
  ) {
    fail(CONTRACT_ERROR);
  }
  deepFreeze(catalog);
  deepFreeze(defaultArtifact);
  return defaultArtifact.defaultState;
}

function snapshotEnvironment(environment) {
  const snapshot = {};
  try {
    if (
      environment === null ||
      typeof environment !== "object" ||
      Array.isArray(environment)
    ) {
      fail(ENVIRONMENT_ERROR);
    }
    for (const name of OVERRIDE_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      if (descriptor === undefined) {
        snapshot[name] = "";
      } else if (!("value" in descriptor)) {
        fail(ENVIRONMENT_ERROR);
      } else if (descriptor.value === undefined) {
        snapshot[name] = "";
      } else {
        snapshot[name] = descriptor.value;
      }
    }
  } catch {
    fail(ENVIRONMENT_ERROR);
  }
  return Object.freeze(snapshot);
}

function parseState(value, defaultState) {
  if (value === "") {
    return Object.freeze({ state: defaultState, source: "sandbox.defaultState" });
  }
  if (typeof value !== "string" || !STATES.includes(value)) fail(STATE_ERROR);
  return Object.freeze({ state: value, source: "PI_NONO" });
}

function parseListenPorts(value) {
  if (value === "") return Object.freeze([]);
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(value)
  ) {
    fail(PORT_ERROR);
  }

  const ports = [];
  const seen = new Set();
  for (const segment of value.split(",")) {
    const port = Number(segment);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || seen.has(port)) {
      fail(PORT_ERROR);
    }
    seen.add(port);
    ports.push(port);
  }
  return Object.freeze(ports);
}

function resolveFromEnvironment(environment) {
  const defaultState = validateContract();
  const snapshot = snapshotEnvironment(environment);
  const stateSelection = parseState(snapshot.PI_NONO, defaultState);
  const profileOverride = snapshot.PI_NONO_PROFILE;
  const listenPortOverride = snapshot.PI_NONO_LISTEN_PORTS;

  if (stateSelection.state === "disabled") {
    if (profileOverride !== "" || listenPortOverride !== "") {
      fail(DISABLED_CONFLICT_ERROR);
    }
    const rollback = stateSelection.source === "PI_NONO";
    return deepFreeze({
      schemaVersion: 1,
      state: "disabled",
      profile: null,
      listenPorts: [],
      piTools: null,
      source: {
        state: stateSelection.source,
        profile: null,
        listenPorts: "none",
      },
      rollback,
      disableReason: rollback ? "override" : "host-default",
      accepted: ACCEPTED,
    });
  }

  if (
    typeof profileOverride !== "string" ||
    (profileOverride !== "" && !PROFILES.includes(profileOverride))
  ) {
    fail(PROFILE_ERROR);
  }
  const profile =
    profileOverride === ""
      ? DEFAULT_PROFILES[stateSelection.state]
      : profileOverride;
  const listenPorts = parseListenPorts(listenPortOverride);
  return deepFreeze({
    schemaVersion: 1,
    state: stateSelection.state,
    profile,
    listenPorts,
    piTools: profile === "pi-review" ? REVIEW_TOOLS : null,
    source: {
      state: stateSelection.source,
      profile:
        profileOverride === "" ? "state-default" : "PI_NONO_PROFILE",
      listenPorts:
        listenPortOverride === "" ? "none" : "PI_NONO_LISTEN_PORTS",
    },
    rollback: false,
    disableReason: null,
    accepted: ACCEPTED,
  });
}

export function resolveSandboxSelection(...inputs) {
  if (inputs.length !== 0) {
    fail(INVOCATION_ERROR);
  }
  return resolveFromEnvironment(process.env);
}

export function resolveSandboxSelectionFromEnvironment(...inputs) {
  if (inputs.length !== 1) {
    fail(INVOCATION_ERROR);
  }
  return resolveFromEnvironment(inputs[0]);
}
