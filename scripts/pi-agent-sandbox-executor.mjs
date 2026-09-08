import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder, types } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveSandboxSelection } from "__PI_AGENT_SANDBOX_RESOLVER_MODULE__";

const EXPECTED_CATALOG = PI_AGENT_EXPECTED_CATALOG_PLACEHOLDER;
const EXPECTED_CATALOG_DIGEST = "__PI_AGENT_EXECUTOR_CATALOG_DIGEST__";
const EXPECTED_NONO_VERSION = "__PI_AGENT_NONO_VERSION__";
const EXPECTED_PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const EXPECTED_PI_VERSION = "0.83.0";
const EXPECTED_PI_PACKAGE_MANIFEST_DIGEST =
  "3253f5d0c59c6661d9975cb813e6b9ced77122a09279bd871d63e14247393ed8";
const EXPECTED_PI_PARSER_DIGEST =
  "4918c54a35a1190f4a1a8d6829d9b7de707a97b30a74640838345e54011147e5";
const NONO_EXECUTABLE = "__PI_AGENT_NONO_EXECUTABLE__";
const PI_EXECUTABLE = "__PI_AGENT_PI_EXECUTABLE__";
const PI_PACKAGE_ROOT = "__PI_AGENT_PI_PACKAGE_ROOT__";
const PI_PACKAGE_MANIFEST = "__PI_AGENT_PI_PACKAGE_MANIFEST__";
const PI_PARSER_MODULE = "__PI_AGENT_PI_PARSER_MODULE__";
const PARSER_NODE_EXECUTABLE = "__PI_AGENT_PARSER_NODE_EXECUTABLE__";
const EXECUTABLE_DIGESTS = Object.freeze({
  nono: "__PI_AGENT_NONO_EXECUTABLE_DIGEST__",
  parserNode: "__PI_AGENT_PARSER_NODE_EXECUTABLE_DIGEST__",
  pi: "__PI_AGENT_PI_EXECUTABLE_DIGEST__",
});
const PROFILE_DIGESTS = Object.freeze({
  "pi-audit": Object.freeze({
    source: "__PI_AGENT_PI_AUDIT_SOURCE_DIGEST__",
    resolved: "__PI_AGENT_PI_AUDIT_RESOLVED_DIGEST__",
  }),
  "pi-managed": Object.freeze({
    source: "__PI_AGENT_PI_MANAGED_SOURCE_DIGEST__",
    resolved: "__PI_AGENT_PI_MANAGED_RESOLVED_DIGEST__",
  }),
  "pi-review": Object.freeze({
    source: "__PI_AGENT_PI_REVIEW_SOURCE_DIGEST__",
    resolved: "__PI_AGENT_PI_REVIEW_RESOLVED_DIGEST__",
  }),
});
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CATALOG_PATH = path.join(PACKAGE_ROOT, "share/pi-agent/nono/catalog.json");
const PI_PARSER_HELPER = path.join(
  PACKAGE_ROOT,
  "lib/pi-agent/pi-args-parser-helper.mjs",
);
const PI_PARSER_HELPER_DIGEST = "__PI_AGENT_PI_PARSER_HELPER_DIGEST__";
const PROFILE_NAMES = Object.freeze(["pi-audit", "pi-managed", "pi-review"]);
const STATES = Object.freeze(["disabled", "audit", "enforced"]);
const SANDBOX_CONTROL_NAMES = Object.freeze([
  "PI_NONO",
  "PI_NONO_PROFILE",
  "PI_NONO_LISTEN_PORTS",
]);
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const PROVIDER_NETWORK_PROFILE = "minimal";
const PI_ARGUMENT_FIELDS = Object.freeze([
  "provider",
  "model",
  "apiKey",
  "systemPrompt",
  "appendSystemPrompt",
  "thinking",
  "continue",
  "resume",
  "help",
  "version",
  "mode",
  "name",
  "noSession",
  "session",
  "sessionId",
  "fork",
  "sessionDir",
  "models",
  "tools",
  "excludeTools",
  "noTools",
  "noBuiltinTools",
  "extensions",
  "noExtensions",
  "print",
  "export",
  "noSkills",
  "skills",
  "promptTemplates",
  "noPromptTemplates",
  "themes",
  "noThemes",
  "noContextFiles",
  "listModels",
  "offline",
  "verbose",
  "projectTrustOverride",
  "messages",
  "fileArgs",
  "unknownFlags",
  "diagnostics",
]);
const PI_OPTIONAL_STRING_FIELDS = Object.freeze([
  "provider",
  "model",
  "apiKey",
  "systemPrompt",
  "thinking",
  "mode",
  "name",
  "session",
  "sessionId",
  "fork",
  "sessionDir",
  "export",
]);
const PI_OPTIONAL_STRING_ARRAY_FIELDS = Object.freeze([
  "appendSystemPrompt",
  "models",
  "tools",
  "excludeTools",
  "extensions",
  "skills",
  "promptTemplates",
  "themes",
]);
const PI_OPTIONAL_BOOLEAN_FIELDS = Object.freeze([
  "continue",
  "resume",
  "help",
  "version",
  "noSession",
  "noTools",
  "noBuiltinTools",
  "noExtensions",
  "print",
  "noSkills",
  "noPromptTemplates",
  "noThemes",
  "noContextFiles",
  "offline",
  "verbose",
  "projectTrustOverride",
]);
const LISTEN_PORT_FORMAT =
  "comma-separated canonical decimal ports from 1 through 65535";
const PROFILE_COMMAND_TIMEOUT_MS = 15_000;
const PROFILE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 5_000;
const PARSER_PROTOCOL_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_ARGUMENTS = 1_024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_PARSER_DIAGNOSTIC_BYTES = MAX_ARGUMENT_BYTES + 4 * 1024;
const STORE_PATH = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[^/]+(?:\/.*)?$/;
const SOURCE_TOP_LEVEL_KEYS = Object.freeze([
  "environment",
  "extends",
  "filesystem",
  "groups",
  "meta",
  "network",
  "security",
  "workdir",
]);
const RESOLVED_TOP_LEVEL_KEYS = Object.freeze([
  "description",
  "extends",
  "filesystem",
  "groups",
  "name",
  "network",
  "rollback",
  "security",
  "workdir",
]);
const RECOVERY_BY_COMPONENT = Object.freeze({
  invocation: "use the closed sandbox executor input contract",
  catalog: "rebuild the managed Pi sandbox catalog and activate the generation",
  selection: "use an accepted PI_NONO, profile, and listen-port override",
  pi: "rebuild the managed Pi package and activate the generation",
  nono: `restore the selected nono ${EXPECTED_NONO_VERSION} package and rebuild`,
  profile: "rebuild the selected Pi sandbox profile and activate the generation",
  "provider-network": "supply the validated HTTPS provider origin or select audit rollback",
  mcpproxy: "restore the profile localhost port 8080 grant and rebuild",
  "package-read": "restore read access to the immutable package closure and rebuild",
  "pi-state": "restore writable Pi agent state access and rebuild",
  "temp-state": "restore writable private Pi temporary state access and rebuild",
  workspace: "select a profile with the required current-workspace access",
  environment: "restore the admitted root-Pi environment-name contract and rebuild",
  "process-control": "select a profile with the required process-control mode",
  execution: "repair the managed executable and retry without an unsandboxed fallback",
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(EXPECTED_CATALOG);

export class SandboxExecutionError extends Error {
  constructor(component, kind) {
    const recovery = RECOVERY_BY_COMPONENT[component];
    super(`Pi sandbox ${component} failed (${kind}). Recovery: ${recovery}.`);
    this.name = "SandboxExecutionError";
    this.component = component;
    this.kind = kind;
    this.recovery = recovery;
  }
}

function fail(component, kind) {
  throw new SandboxExecutionError(component, kind);
}

function exactDataObject(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string") ||
    [...keys].sort().some((key, index) => key !== expected[index])
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      "value" in descriptor
    );
  });
}

function snapshotDataArray(value, maximumLength = 100_000) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 0
  ) {
    return null;
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1 ||
    ownKeys.some((key) => typeof key === "symbol")
  ) {
    return null;
  }

  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return null;
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function snapshotStringArray(value, maximumLength = 100_000) {
  const snapshot = snapshotDataArray(value, maximumLength);
  if (snapshot === null) return null;
  for (let index = 0; index < snapshot.length; index += 1) {
    if (typeof snapshot[index] !== "string") return null;
  }
  return snapshot;
}

function snapshotNumberArray(value, maximumLength = 100_000) {
  const snapshot = snapshotDataArray(value, maximumLength);
  if (snapshot === null) return null;
  for (let index = 0; index < snapshot.length; index += 1) {
    if (!Number.isInteger(snapshot[index])) return null;
  }
  return snapshot;
}

function exactStringArray(value, expected = null) {
  const snapshot = snapshotStringArray(value);
  return (
    snapshot !== null &&
    (expected === null || isDeepStrictEqual(snapshot, expected))
  );
}

function exactNumberArray(value, expected = null) {
  const snapshot = snapshotNumberArray(value);
  return (
    snapshot !== null &&
    (expected === null || isDeepStrictEqual(snapshot, expected))
  );
}

function readVerifiedBytes(file, expectedDigest, component) {
  try {
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) fail(component, "identity");
    const bytes = fs.readFileSync(file);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedDigest) fail(component, "identity");
    return bytes;
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail(component, "unavailable");
  }
}

function parseJsonBytes(bytes, component) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail(component, "malformed");
  }
}

function readVerifiedJson(file, expectedDigest, component) {
  return parseJsonBytes(readVerifiedBytes(file, expectedDigest, component), component);
}

function verifyExecutable(file, expectedDigest, component) {
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
    const stat = fs.statSync(file);
    const target = fs.realpathSync.native(file);
    if (!stat.isFile() || !STORE_PATH.test(file) || !STORE_PATH.test(target)) {
      fail(component, "identity");
    }
    readVerifiedBytes(file, expectedDigest, component);
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail(component, "unavailable");
  }
}

function verifyReadableArtifact(file, expectedDigest, component) {
  try {
    const stat = fs.statSync(file);
    const target = fs.realpathSync.native(file);
    if (!stat.isFile() || !STORE_PATH.test(file) || !STORE_PATH.test(target)) {
      fail(component, "identity");
    }
    return readVerifiedBytes(file, expectedDigest, component);
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail(component, "unavailable");
  }
}

function snapshotArguments(value) {
  try {
    const snapshot = snapshotStringArray(value, MAX_ARGUMENTS);
    if (snapshot === null) fail("invocation", "invalid");
    let bytes = 0;
    for (let index = 0; index < snapshot.length; index += 1) {
      const argument = snapshot[index];
      if (argument.includes("\0")) fail("invocation", "invalid");
      bytes += Buffer.byteLength(argument);
      if (bytes > MAX_ARGUMENT_BYTES) fail("invocation", "invalid");
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail("invocation", "invalid");
  }
}

function snapshotInput(inputs) {
  try {
    if (
      inputs.length !== 1 ||
      !exactDataObject(inputs[0], ["providerOrigin", "userArguments"])
    ) {
      fail("invocation", "invalid");
    }
    const providerDescriptor = Object.getOwnPropertyDescriptor(
      inputs[0],
      "providerOrigin",
    );
    const argumentsDescriptor = Object.getOwnPropertyDescriptor(
      inputs[0],
      "userArguments",
    );
    const providerOrigin = providerDescriptor.value;
    if (
      providerOrigin !== null &&
      (typeof providerOrigin !== "string" ||
        providerOrigin.length === 0 ||
        providerOrigin.length > 2_048 ||
        /[\0\r\n\t]/.test(providerOrigin))
    ) {
      fail("invocation", "invalid");
    }
    return Object.freeze({
      providerOrigin,
      userArguments: snapshotArguments(argumentsDescriptor.value),
    });
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail("invocation", "invalid");
  }
}

function boundedParserString(value, maximumBytes = MAX_ARGUMENT_BYTES) {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximumBytes
  );
}

function validNormalizedPiArguments(value) {
  try {
    if (!exactDataObject(value, PI_ARGUMENT_FIELDS)) return false;
    for (const field of PI_OPTIONAL_STRING_FIELDS) {
      if (value[field] !== null && !boundedParserString(value[field])) return false;
    }
    if (
      value.thinking !== null &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        value.thinking,
      )
    ) {
      return false;
    }
    if (value.mode !== null && !["text", "json", "rpc"].includes(value.mode)) {
      return false;
    }
    for (const field of PI_OPTIONAL_STRING_ARRAY_FIELDS) {
      if (value[field] === null) continue;
      const entries = snapshotStringArray(value[field], MAX_ARGUMENTS);
      if (entries === null || entries.some((entry) => !boundedParserString(entry))) {
        return false;
      }
    }
    for (const field of PI_OPTIONAL_BOOLEAN_FIELDS) {
      if (value[field] !== null && typeof value[field] !== "boolean") return false;
    }
    if (
      value.listModels !== null &&
      value.listModels !== true &&
      !boundedParserString(value.listModels)
    ) {
      return false;
    }
    for (const field of ["messages", "fileArgs"]) {
      const entries = snapshotStringArray(value[field], MAX_ARGUMENTS);
      if (entries === null || entries.some((entry) => !boundedParserString(entry))) {
        return false;
      }
    }

    const unknownFlags = snapshotDataArray(value.unknownFlags, MAX_ARGUMENTS);
    if (unknownFlags === null) return false;
    const unknownNames = new Set();
    for (const entry of unknownFlags) {
      const pair = snapshotDataArray(entry, 2);
      if (
        pair === null ||
        pair.length !== 2 ||
        !boundedParserString(pair[0]) ||
        (typeof pair[1] !== "boolean" && !boundedParserString(pair[1])) ||
        unknownNames.has(pair[0])
      ) {
        return false;
      }
      unknownNames.add(pair[0]);
    }

    const diagnostics = snapshotDataArray(value.diagnostics, MAX_ARGUMENTS);
    if (diagnostics === null) return false;
    for (const diagnostic of diagnostics) {
      if (
        !exactDataObject(diagnostic, ["type", "message"]) ||
        !["warning", "error"].includes(diagnostic.type) ||
        !boundedParserString(diagnostic.message, MAX_PARSER_DIAGNOSTIC_BYTES)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function verifyPiPackageArtifact(file, relativePath, expectedDigest) {
  if (file !== path.join(PI_PACKAGE_ROOT, relativePath)) fail("pi", "identity");
  const bytes = verifyReadableArtifact(file, expectedDigest, "pi");
  try {
    const packageTarget = fs.realpathSync.native(PI_PACKAGE_ROOT);
    const artifactTarget = fs.realpathSync.native(file);
    if (
      !STORE_PATH.test(PI_PACKAGE_ROOT) ||
      !fs.statSync(PI_PACKAGE_ROOT).isDirectory() ||
      !pathContains(packageTarget, artifactTarget)
    ) {
      fail("pi", "identity");
    }
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail("pi", "unavailable");
  }
  return bytes;
}

function verifiedPiParserRuntime() {
  const manifest = parseJsonBytes(
    verifyPiPackageArtifact(
      PI_PACKAGE_MANIFEST,
      "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      EXPECTED_PI_PACKAGE_MANIFEST_DIGEST,
    ),
    "pi",
  );
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.name !== EXPECTED_PI_PACKAGE_NAME ||
    manifest.version !== EXPECTED_PI_VERSION ||
    manifest.type !== "module" ||
    !exactDataObject(manifest.bin, ["pi"]) ||
    manifest.bin.pi !== "dist/cli.js"
  ) {
    fail("pi", "identity");
  }
  verifyPiPackageArtifact(
    PI_PARSER_MODULE,
    "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js",
    EXPECTED_PI_PARSER_DIGEST,
  );
  verifyReadableArtifact(
    PI_PARSER_HELPER,
    PI_PARSER_HELPER_DIGEST,
    "pi",
  );
  verifyExecutable(
    PARSER_NODE_EXECUTABLE,
    EXECUTABLE_DIGESTS.parserNode,
    "pi",
  );
}

function parsePiArguments(arguments_) {
  let request;
  try {
    request = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        argv: arguments_,
      }),
      "utf8",
    );
  } catch {
    fail("invocation", "review-parser");
  }
  if (request.length > PARSER_PROTOCOL_LIMIT_BYTES) {
    fail("invocation", "review-parser");
  }

  let result;
  try {
    result = spawnSync(PARSER_NODE_EXECUTABLE, [PI_PARSER_HELPER], {
      cwd: "/",
      encoding: null,
      env: {},
      input: request,
      maxBuffer: PARSER_PROTOCOL_LIMIT_BYTES,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: PARSER_TIMEOUT_MS,
    });
  } catch {
    fail("invocation", "review-parser");
  }
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length === 0 ||
    result.stdout.length > PARSER_PROTOCOL_LIMIT_BYTES
  ) {
    fail("invocation", "review-parser");
  }

  let response;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    response = JSON.parse(text);
  } catch {
    fail("invocation", "review-parser");
  }
  if (
    exactDataObject(response, ["schemaVersion", "ok", "error"]) &&
    response.schemaVersion === 1 &&
    response.ok === false &&
    ["input", "decode", "parser", "output", "internal"].includes(
      response.error,
    )
  ) {
    fail("invocation", "review-parser");
  }
  if (
    !exactDataObject(response, ["schemaVersion", "ok", "parsed"]) ||
    response.schemaVersion !== 1 ||
    response.ok !== true ||
    !validNormalizedPiArguments(response.parsed)
  ) {
    fail("invocation", "review-parser");
  }
  return deepFreeze(response.parsed);
}

function validateSelection(selection) {
  try {
    let listenPorts;
    if (
      !exactDataObject(selection, [
        "accepted",
        "disableReason",
        "listenPorts",
        "piTools",
        "profile",
        "rollback",
        "schemaVersion",
        "source",
        "state",
      ]) ||
      selection.schemaVersion !== 1 ||
      !STATES.includes(selection.state) ||
      !exactDataObject(selection.source, ["listenPorts", "profile", "state"]) ||
      !exactDataObject(selection.accepted, ["listenPorts", "profiles", "states"]) ||
      selection.accepted.listenPorts !== LISTEN_PORT_FORMAT ||
      !exactStringArray(selection.accepted.profiles, PROFILE_NAMES) ||
      !exactStringArray(selection.accepted.states, STATES) ||
      (listenPorts = snapshotNumberArray(selection.listenPorts, 65_535)) ===
        null ||
      listenPorts.some((port) => port < 1 || port > 65_535) ||
      new Set(listenPorts).size !== listenPorts.length ||
      !["none", "PI_NONO_LISTEN_PORTS"].includes(selection.source.listenPorts) ||
      !["sandbox.defaultState", "PI_NONO"].includes(selection.source.state)
    ) {
      fail("selection", "invalid");
    }

    if (selection.state === "disabled") {
      const rollback = selection.source.state === "PI_NONO";
      if (
        selection.profile !== null ||
        selection.piTools !== null ||
        listenPorts.length !== 0 ||
        selection.source.profile !== null ||
        selection.source.listenPorts !== "none" ||
        selection.rollback !== rollback ||
        selection.disableReason !== (rollback ? "override" : "host-default")
      ) {
        fail("selection", "mismatch");
      }
      return selection;
    }

    if (
      !PROFILE_NAMES.includes(selection.profile) ||
      !["state-default", "PI_NONO_PROFILE"].includes(selection.source.profile) ||
      selection.rollback !== false ||
      selection.disableReason !== null ||
      (selection.profile === "pi-review"
        ? !exactStringArray(selection.piTools, REVIEW_TOOLS)
        : selection.piTools !== null) ||
      (selection.source.profile === "state-default" &&
        selection.profile !==
          (selection.state === "audit" ? "pi-audit" : "pi-managed"))
    ) {
      fail("selection", "mismatch");
    }
    return selection;
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail("selection", "invalid");
  }
}

function managedFinalArguments(selection, userArguments) {
  if (selection.profile !== "pi-review") return Object.freeze([]);
  const finalArguments = Object.freeze(["--tools", REVIEW_TOOLS.join(",")]);
  verifiedPiParserRuntime();
  const userParsed = parsePiArguments(userArguments);
  const finalParsed = parsePiArguments([
    ...userArguments,
    ...finalArguments,
  ]);
  if (
    userParsed.diagnostics.some((diagnostic) => diagnostic.type === "error") ||
    finalParsed.diagnostics.some((diagnostic) => diagnostic.type === "error")
  ) {
    fail("invocation", "review-argv");
  }
  for (const field of PI_ARGUMENT_FIELDS) {
    if (field === "tools") continue;
    if (!isDeepStrictEqual(userParsed[field], finalParsed[field])) {
      fail("invocation", "review-argv");
    }
  }
  if (
    (finalParsed.noTools ?? false) !== false ||
    (finalParsed.noBuiltinTools ?? false) !== false ||
    !exactStringArray(finalParsed.tools, REVIEW_TOOLS) ||
    (finalParsed.excludeTools !== null &&
      finalParsed.excludeTools.some((tool) => REVIEW_TOOLS.includes(tool)))
  ) {
    fail("invocation", "review-argv");
  }
  return finalArguments;
}

function loadCatalog() {
  const catalog = readVerifiedJson(
    CATALOG_PATH,
    EXPECTED_CATALOG_DIGEST,
    "catalog",
  );
  if (
    !isDeepStrictEqual(catalog, EXPECTED_CATALOG) ||
    catalog.nonoVersion !== EXPECTED_NONO_VERSION
  ) {
    fail("catalog", "identity");
  }
  return deepFreeze(catalog);
}

function runNono(args, component) {
  let result;
  try {
    result = spawnSync(NONO_EXECUTABLE, args, {
      cwd: process.cwd(),
      encoding: null,
      env: { ...process.env, NONO_NO_SAVE_PROMPT: "1" },
      maxBuffer: PROFILE_OUTPUT_LIMIT_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROFILE_COMMAND_TIMEOUT_MS,
    });
  } catch {
    fail(component, "command");
  }
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    fail(component, "command");
  }
  return result.stdout;
}

function validateNonoVersion() {
  const output = runNono(["--version"], "nono");
  let version;
  try {
    version = new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
  } catch {
    fail("nono", "version");
  }
  if (version !== `nono ${EXPECTED_NONO_VERSION}`) fail("nono", "version");
}

function resolveArtifactPath(relativePath, expectedPath, component) {
  if (relativePath !== expectedPath) fail(component, "identity");
  const candidate = path.resolve(PACKAGE_ROOT, relativePath);
  const relative = path.relative(PACKAGE_ROOT, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(component, "identity");
  }
  return candidate;
}

function validateSourceProfile(source, profileName, contract, networkPolicy) {
  if (
    !exactDataObject(source, SOURCE_TOP_LEVEL_KEYS) ||
    !exactDataObject(source.meta, ["author", "description", "name", "version"]) ||
    !exactDataObject(source.groups, ["include"]) ||
    !exactDataObject(source.security, [
      "capability_elevation",
      "ipc_mode",
      "process_info_mode",
      "signal_mode",
    ]) ||
    !exactDataObject(source.filesystem, ["allow", "deny", "read"]) ||
    !exactDataObject(source.network, [
      "allow_domain",
      "block",
      "listen_port",
      "open_port",
    ]) ||
    !exactDataObject(source.environment, ["allow_vars", "deny_vars"]) ||
    !exactDataObject(source.workdir, ["access"]) ||
    source.meta.name !== profileName ||
    !exactStringArray(source.extends, ["default"]) ||
    !exactStringArray(source.network.allow_domain, []) ||
    !exactNumberArray(source.network.listen_port, []) ||
    source.network.block !==
      (networkPolicy === "runtime-provider-host-required")
  ) {
    fail("profile", "source");
  }
  if (
    !exactStringArray(
      source.environment.allow_vars,
      contract.requiredEnvironmentNames,
    ) ||
    !exactStringArray(source.environment.deny_vars)
  ) {
    fail("environment", "grant");
  }
}

function validateResolvedShape(resolved, profileName) {
  if (
    !exactDataObject(resolved, RESOLVED_TOP_LEVEL_KEYS) ||
    !exactDataObject(resolved.filesystem, [
      "allow",
      "allow_file",
      "bypass_protection",
      "deny",
      "read",
      "read_file",
      "suppress_save_prompt",
      "write",
      "write_file",
    ]) ||
    !exactDataObject(resolved.groups, ["exclude", "include"]) ||
    !exactDataObject(resolved.network, [
      "allow_domain",
      "block",
      "credentials",
      "listen_port",
      "network_profile",
      "no_proxy",
      "open_port",
      "upstream_bypass",
      "upstream_proxy",
    ]) ||
    !exactDataObject(resolved.rollback, ["exclude_globs", "exclude_patterns"]) ||
    !exactDataObject(resolved.security, [
      "capability_elevation",
      "ipc_mode",
      "process_info_mode",
      "signal_mode",
    ]) ||
    !exactDataObject(resolved.workdir, ["access"]) ||
    resolved.name !== profileName ||
    !exactStringArray(resolved.extends, ["default"])
  ) {
    fail("profile", "resolved");
  }
}

function validateResolvedGrants(
  resolved,
  contract,
  networkPolicy,
  providerHost,
  listenPorts,
) {
  validateResolvedShape(resolved, resolved.name);
  const expectedBlocked =
    providerHost === null && networkPolicy === "runtime-provider-host-required";
  const expectedDomains = providerHost === null ? [] : [providerHost];
  const expectedNetworkProfile =
    providerHost === null ? null : PROVIDER_NETWORK_PROFILE;
  if (
    resolved.network.block !== expectedBlocked ||
    !exactStringArray(resolved.network.allow_domain, expectedDomains) ||
    !exactStringArray(resolved.network.credentials, []) ||
    !exactNumberArray(resolved.network.listen_port, listenPorts) ||
    resolved.network.network_profile !== expectedNetworkProfile ||
    !exactStringArray(resolved.network.no_proxy, []) ||
    resolved.network.upstream_proxy !== null ||
    !exactStringArray(resolved.network.upstream_bypass, [])
  ) {
    fail("provider-network", "grant");
  }
   if (!exactNumberArray(resolved.network.open_port, [contract.mcpPort, 3111])) {
    fail("mcpproxy", "grant");
  }
  if (resolved.workdir.access !== contract.workspaceAccess) {
    fail("workspace", "grant");
  }
  if (
    resolved.security.signal_mode !== contract.processMode ||
    resolved.security.process_info_mode !== contract.processMode ||
    resolved.security.ipc_mode !== "shared_memory_only" ||
    resolved.security.capability_elevation !== false
  ) {
    fail("process-control", "grant");
  }
}

function validateProviderOrigin(providerOrigin, networkPolicy) {
  if (providerOrigin === null) {
    if (networkPolicy === "runtime-provider-host-required") {
      fail("provider-network", "missing");
    }
    return null;
  }
  let parsed;
  try {
    parsed = new URL(providerOrigin);
  } catch {
    fail("provider-network", "invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin === "null" ||
    providerOrigin !== parsed.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    !/^[\x21-\x7e]+$/.test(parsed.hostname)
  ) {
    fail("provider-network", "invalid");
  }
  return networkPolicy === "runtime-provider-host-required"
    ? parsed.hostname
    : null;
}

function absoluteEnvironmentPath(name, fallback, component) {
  const value = process.env[name] ?? fallback;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    fail(component, "path");
  }
  return path.normalize(value);
}

function runtimePaths() {
  const home = absoluteEnvironmentPath("HOME", null, "pi-state");
  const tmp = absoluteEnvironmentPath("TMPDIR", null, "temp-state");
  const agent = absoluteEnvironmentPath(
    "PI_CODING_AGENT_DIR",
    path.join(home, ".pi/agent"),
    "pi-state",
  );
  let workspace;
  try {
    workspace = fs.realpathSync.native(process.cwd());
  } catch {
    fail("workspace", "path");
  }
  return Object.freeze({
    agent,
    temp: path.join(tmp, "pi-agent"),
    workspace,
  });
}

function canonicalCapabilityPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    return null;
  }

  let candidate = path.normalize(value);
  const remainder = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(candidate);
      return path.join(resolved, ...remainder);
    } catch (error) {
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) return null;
      } catch {
        // Continue through absent path components to the nearest real ancestor.
      }
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    remainder.unshift(path.basename(candidate));
    candidate = parent;
  }
}

function pathContains(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function accessBits(access) {
  if (access === "read") return 1;
  if (access === "write") return 2;
  if (access === "readwrite") return 3;
  return 0;
}

function parseFilesystemCapabilities(filesystem) {
  const denyRows = snapshotDataArray(filesystem.deny);
  const grantRows = snapshotDataArray(filesystem.grants);
  if (denyRows === null || grantRows === null) fail("profile", "manifest");

  const denies = [];
  for (const deny of denyRows) {
    if (!exactDataObject(deny, ["path"])) fail("profile", "manifest");
    const canonicalPath = canonicalCapabilityPath(deny.path);
    if (canonicalPath === null) fail("profile", "manifest");
    denies.push(Object.freeze({ path: canonicalPath }));
  }

  const grants = [];
  for (const grant of grantRows) {
    if (
      !exactDataObject(grant, ["access", "path", "type"]) ||
      !["read", "readwrite", "write"].includes(grant.access) ||
      !["directory", "file"].includes(grant.type)
    ) {
      fail("profile", "manifest");
    }
    const canonicalPath = canonicalCapabilityPath(grant.path);
    if (canonicalPath === null) fail("profile", "manifest");
    grants.push(
      Object.freeze({
        access: grant.access,
        path: canonicalPath,
        type: grant.type,
      }),
    );
  }
  return Object.freeze({
    denies: Object.freeze(denies),
    grants: Object.freeze(grants),
  });
}

function deniedAt(capabilities, target) {
  for (const deny of capabilities.denies) {
    if (pathContains(deny.path, target)) return true;
  }
  return false;
}

function effectiveCapabilitySatisfies(
  capabilities,
  target,
  requiredAccess,
  requiredType = "directory",
) {
  if (deniedAt(capabilities, target)) return false;
  let effectiveBits = 0;
  for (const grant of capabilities.grants) {
    const applies =
      grant.type === "directory"
        ? pathContains(grant.path, target)
        : requiredType === "file" && grant.path === target;
    if (applies) effectiveBits |= accessBits(grant.access);
  }
  const requiredBits = accessBits(requiredAccess);
  return requiredBits !== 0 && (effectiveBits & requiredBits) === requiredBits;
}

function writeGrantOverlapsWorkspace(capabilities, workspace) {
  for (const grant of capabilities.grants) {
    if ((accessBits(grant.access) & 2) === 0 || deniedAt(capabilities, grant.path)) {
      continue;
    }
    if (
      grant.type === "directory"
        ? pathContains(grant.path, workspace) ||
          pathContains(workspace, grant.path)
        : grant.path === workspace || pathContains(workspace, grant.path)
    ) {
      return true;
    }
  }
  return false;
}

function validateManifest(
  manifest,
  contract,
  networkPolicy,
  providerHost,
  listenPorts,
) {
  if (
    !exactDataObject(manifest, [
      "$schema",
      "filesystem",
      "network",
      "process",
      "version",
    ]) ||
    manifest.$schema !==
      "https://nono.sh/schemas/capability-manifest.schema.json" ||
    manifest.version !== "0.1.0" ||
    !exactDataObject(manifest.filesystem, ["deny", "grants"]) ||
    !exactDataObject(manifest.process, [
      "blocked_commands",
      "exec_strategy",
      "ipc_mode",
      "process_info_mode",
      "signal_mode",
    ]) ||
    !exactStringArray(manifest.process.blocked_commands) ||
    manifest.process.exec_strategy !== "monitor" ||
    manifest.process.ipc_mode !== "shared_memory_only"
  ) {
    fail("profile", "manifest");
  }
  const filesystemCapabilities = parseFilesystemCapabilities(
    manifest.filesystem,
  );

  const expectedNetworkKeys = ["dns", "mode", "ports"];
  if (providerHost !== null) expectedNetworkKeys.push("allow_domains");
  const expectedPortKeys = ["localhost"];
  if (listenPorts.length > 0) expectedPortKeys.push("bind");
  if (
    !exactDataObject(manifest.network, expectedNetworkKeys) ||
    !exactDataObject(manifest.network.ports, expectedPortKeys) ||
    manifest.network.dns !== true ||
    manifest.network.mode !==
      (providerHost !== null
        ? "proxy"
        : networkPolicy === "unrestricted-audit"
          ? "unrestricted"
          : "blocked") ||
     !exactNumberArray(manifest.network.ports.localhost, [contract.mcpPort, 3111]) ||
    (listenPorts.length > 0 &&
      !exactNumberArray(manifest.network.ports.bind, listenPorts)) ||
    (providerHost !== null &&
      !exactStringArray(manifest.network.allow_domains, [providerHost]))
  ) {
    if (
      !exactDataObject(manifest.network?.ports, expectedPortKeys) ||
       !exactNumberArray(manifest.network?.ports?.localhost, [contract.mcpPort, 3111])
    ) {
      fail("mcpproxy", "grant");
    }
    fail("provider-network", "grant");
  }

  if (
    manifest.process.signal_mode !== contract.processMode ||
    manifest.process.process_info_mode !== contract.processMode
  ) {
    fail("process-control", "grant");
  }
  const storePath = canonicalCapabilityPath("/nix/store");
  if (
    storePath === null ||
    !effectiveCapabilitySatisfies(
      filesystemCapabilities,
      storePath,
      "read",
    )
  ) {
    fail("package-read", "grant");
  }

  const paths = runtimePaths();
  const canonicalPaths = {};
  for (const [name, component] of [
    ["agent", "pi-state"],
    ["temp", "temp-state"],
    ["workspace", "workspace"],
  ]) {
    const value = paths[name];
    const canonicalPath = canonicalCapabilityPath(value);
    if (canonicalPath === null) fail(component, "path");
    canonicalPaths[name] = canonicalPath;
  }
  for (const [component, expectedPath, access] of [
    ["pi-state", canonicalPaths.agent, contract.agentDirAccess],
    ["temp-state", canonicalPaths.temp, contract.tempDirAccess],
    ["workspace", canonicalPaths.workspace, contract.workspaceAccess],
  ]) {
    if (
      !effectiveCapabilitySatisfies(
        filesystemCapabilities,
        expectedPath,
        access,
      )
    ) {
      fail(component, "grant");
    }
  }

  if (contract.workspaceAccess === "read") {
    for (const statePath of [
      canonicalPaths.agent,
      canonicalPaths.temp,
    ]) {
      if (pathContains(statePath, canonicalPaths.workspace)) {
        fail("workspace", "topology");
      }
    }
    if (
      writeGrantOverlapsWorkspace(
        filesystemCapabilities,
        canonicalPaths.workspace,
      )
    ) {
      fail("workspace", "write-overlap");
    }
  }
}

function createRuntimeProfile(source, providerHost, listenPorts) {
  const paths = runtimePaths();
  let directory;
  try {
    fs.mkdirSync(paths.temp, { mode: 0o700, recursive: true });
    const state = fs.lstatSync(paths.temp);
    if (!state.isDirectory() || state.isSymbolicLink()) fail("temp-state", "path");
    fs.chmodSync(paths.temp, 0o700);
    directory = fs.mkdtempSync(path.join(paths.temp, "sandbox-profile-"));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "profile.json");
    const runtimeSource = structuredClone(source);
    runtimeSource.network.block = providerHost === null ? source.network.block : false;
    runtimeSource.network.network_profile =
      providerHost === null ? null : PROVIDER_NETWORK_PROFILE;
    runtimeSource.network.allow_domain = providerHost === null ? [] : [providerHost];
    runtimeSource.network.listen_port = [...listenPorts];
    fs.writeFileSync(file, `${JSON.stringify(runtimeSource)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return Object.freeze({ directory, file, source: runtimeSource });
  } catch (error) {
    if (directory !== undefined) {
      try {
        fs.rmSync(directory, { force: true, recursive: true });
      } catch {
        // The fixed failure below remains value-free.
      }
    }
    if (error instanceof SandboxExecutionError) throw error;
    fail("temp-state", "write");
  }
}

function parseNonoJson(args, component) {
  return parseJsonBytes(runNono(args, component), component);
}

function prepareEnabledExecution(input, selection, catalog) {
  verifyExecutable(NONO_EXECUTABLE, EXECUTABLE_DIGESTS.nono, "nono");
  validateNonoVersion();

  const entry = catalog.profiles[selection.profile];
  const expectedEntry = EXPECTED_CATALOG.profiles[selection.profile];
  if (
    !exactDataObject(entry, [
      "grantContract",
      "networkPolicy",
      "resolvedPath",
      "sourcePath",
    ]) ||
    !isDeepStrictEqual(entry, expectedEntry) ||
    !exactDataObject(entry.grantContract, [
      "agentDirAccess",
      "agentMemoryUrl",
      "mcpPort",
      "processMode",
      "providerHost",
      "requiredEnvironmentNames",
      "tempDirAccess",
      "workspaceAccess",
    ]) ||
    entry.grantContract.providerHost !== null
  ) {
    fail("profile", "contract");
  }

  const sourcePath = resolveArtifactPath(
    entry.sourcePath,
    `share/pi-agent/nono/profiles/${selection.profile}.json`,
    "profile",
  );
  const resolvedPath = resolveArtifactPath(
    entry.resolvedPath,
    `share/pi-agent/nono/resolved/${selection.profile}.json`,
    "profile",
  );
  const source = readVerifiedJson(
    sourcePath,
    PROFILE_DIGESTS[selection.profile].source,
    "profile",
  );
  const packagedResolved = readVerifiedJson(
    resolvedPath,
    PROFILE_DIGESTS[selection.profile].resolved,
    "profile",
  );

  runNono(["profile", "validate", "--strict", sourcePath], "profile");
  validateSourceProfile(
    source,
    selection.profile,
    entry.grantContract,
    entry.networkPolicy,
  );
  const selectedResolved = parseNonoJson(
    ["profile", "show", sourcePath, "--json", "--silent"],
    "profile",
  );
  validateResolvedShape(selectedResolved, selection.profile);
  if (!isDeepStrictEqual(selectedResolved, packagedResolved)) {
    fail("profile", "identity");
  }
  validateResolvedGrants(
    selectedResolved,
    entry.grantContract,
    entry.networkPolicy,
    null,
    [],
  );

  const providerHost = validateProviderOrigin(
    input.providerOrigin,
    entry.networkPolicy,
  );
  const runtimeProfile = createRuntimeProfile(
    source,
    providerHost,
    selection.listenPorts,
  );
  try {
    runNono(
      ["profile", "validate", "--strict", runtimeProfile.file],
      "profile",
    );
    const runtimeResolved = parseNonoJson(
      ["profile", "show", runtimeProfile.file, "--json", "--silent"],
      "profile",
    );
    const expectedRuntimeResolved = structuredClone(selectedResolved);
    expectedRuntimeResolved.network.block =
      providerHost === null ? selectedResolved.network.block : false;
    expectedRuntimeResolved.network.network_profile =
      providerHost === null ? null : PROVIDER_NETWORK_PROFILE;
    expectedRuntimeResolved.network.allow_domain =
      providerHost === null ? [] : [providerHost];
    expectedRuntimeResolved.network.listen_port = [...selection.listenPorts];
    if (!isDeepStrictEqual(runtimeResolved, expectedRuntimeResolved)) {
      fail("profile", "materialization");
    }
    validateResolvedGrants(
      runtimeResolved,
      entry.grantContract,
      entry.networkPolicy,
      providerHost,
      selection.listenPorts,
    );
    const manifest = parseNonoJson(
      [
        "profile",
        "show",
        runtimeProfile.file,
        "--format",
        "manifest",
        "--silent",
      ],
      "profile",
    );
    validateManifest(
      manifest,
      entry.grantContract,
      entry.networkPolicy,
      providerHost,
      selection.listenPorts,
    );

    return Object.freeze({
      cleanup: () => {
        try {
          fs.rmSync(runtimeProfile.directory, { force: true, recursive: true });
        } catch {
          fail("temp-state", "cleanup");
        }
      },
      profile: runtimeProfile.file,
    });
  } catch (error) {
    try {
      fs.rmSync(runtimeProfile.directory, { force: true, recursive: true });
    } catch {
      // Preserve the original finite failure.
    }
    throw error;
  }
}

function executeProgram(executable, arguments_, environment) {
  let result;
  try {
    result = spawnSync(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: "inherit",
    });
  } catch {
    fail("execution", "spawn");
  }
  if (result.error !== undefined) fail("execution", "spawn");
  return Object.freeze({ status: result.status, signal: result.signal });
}

function barePiEnvironment() {
  const environment = { ...process.env };
  for (const name of SANDBOX_CONTROL_NAMES) delete environment[name];
  return Object.freeze(environment);
}

export function executeSandboxedPi(...inputs) {
  const input = snapshotInput(inputs);
  const catalog = loadCatalog();
  let selection;
  try {
    selection = validateSelection(resolveSandboxSelection());
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error;
    fail("selection", "invalid");
  }
  verifyExecutable(PI_EXECUTABLE, EXECUTABLE_DIGESTS.pi, "pi");

  if (selection.state === "disabled") {
    return executeProgram(PI_EXECUTABLE, input.userArguments, barePiEnvironment());
  }

  const finalArguments = managedFinalArguments(
    selection,
    input.userArguments,
  );
  const prepared = prepareEnabledExecution(input, selection, catalog);
  try {
    return executeProgram(
      NONO_EXECUTABLE,
      [
        "run",
        "--profile",
        prepared.profile,
        "--allow-cwd",
        "--",
        PI_EXECUTABLE,
        ...input.userArguments,
        ...finalArguments,
      ],
      { ...process.env, NONO_NO_SAVE_PROMPT: "1" },
    );
  } finally {
    prepared.cleanup();
  }
}
