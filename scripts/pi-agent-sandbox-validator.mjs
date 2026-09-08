import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const NONO_EXECUTABLE = "__PI_AGENT_SANDBOX_VALIDATOR_NONO__";
const NONO_TIMEOUT_MS = 15_000;
const NONO_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SOURCE_PROFILE_ROOT = fileURLToPath(
  new URL("../../share/pi-agent/nono/profiles/", import.meta.url),
);
const RESOLVED_PROFILE_ROOT = fileURLToPath(
  new URL("../../share/pi-agent/nono/resolved/", import.meta.url),
);
const STATES = Object.freeze(["disabled", "audit", "enforced"]);
const PROFILES = Object.freeze(["pi-audit", "pi-managed", "pi-review"]);
const SELECTION_KEYS = Object.freeze([
  "schemaVersion",
  "state",
  "profile",
  "listenPorts",
  "piTools",
  "source",
  "rollback",
  "disableReason",
  "accepted",
]);

function fail() {
  throw new Error("sandbox profile validation failed");
}

function exactDataObject(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys]
      .sort()
      .every((key, index) => key === [...expectedKeys].sort()[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function validateResolvedProfile(profileName) {
  const sourcePath = `${SOURCE_PROFILE_ROOT}${profileName}.json`;
  const resolvedPath = `${RESOLVED_PROFILE_ROOT}${profileName}.json`;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    fail();
  }
  if (
    !exactDataObject(value, [
      "description",
      "extends",
      "filesystem",
      "groups",
      "name",
      "network",
      "rollback",
      "security",
      "workdir",
    ]) ||
    value.name !== profileName ||
    !Array.isArray(value.extends) ||
    value.extends.length !== 1 ||
    value.extends[0] !== "default" ||
    !Array.isArray(value.network?.open_port) ||
     value.network.open_port.length !== 2 ||
     value.network.open_port[0] !== 8080 ||
     value.network.open_port[1] !== 3111
  ) {
    fail();
  }
  const validated = spawnSync(
    NONO_EXECUTABLE,
    ["profile", "validate", "--strict", sourcePath],
    {
      encoding: "utf8",
      maxBuffer: NONO_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NONO_TIMEOUT_MS,
    },
  );
  if (
    validated.error !== undefined ||
    validated.status !== 0 ||
    validated.stderr !== ""
  ) {
    fail();
  }
  const shown = spawnSync(
    NONO_EXECUTABLE,
    ["profile", "show", sourcePath, "--json", "--silent"],
    {
      encoding: "utf8",
      maxBuffer: NONO_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NONO_TIMEOUT_MS,
    },
  );
  if (
    shown.error !== undefined ||
    shown.status !== 0 ||
    shown.stderr !== ""
  ) {
    fail();
  }
  let resolved;
  try {
    resolved = JSON.parse(shown.stdout);
  } catch {
    fail();
  }
  if (!isDeepStrictEqual(resolved, value)) fail();
}

export function validateSandboxSelection(...inputs) {
  if (inputs.length !== 1) fail();
  const selection = inputs[0];
  if (
    !exactDataObject(selection, SELECTION_KEYS) ||
    selection.schemaVersion !== 1 ||
    !STATES.includes(selection.state) ||
    (selection.state === "disabled"
      ? selection.profile !== null
      : !PROFILES.includes(selection.profile)) ||
    !Array.isArray(selection.listenPorts)
  ) {
    fail();
  }
  if (selection.profile !== null) validateResolvedProfile(selection.profile);
  return selection;
}
