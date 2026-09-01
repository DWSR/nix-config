import fs from "node:fs";
import { TextDecoder, types } from "node:util";

import { parseArgs } from "__PI_AGENT_PI_PARSER_MODULE__";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ARGUMENTS = 1_024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = MAX_ARGUMENT_BYTES + 4 * 1024;
const EXPECTED_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ARG_FIELDS = Object.freeze([
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
const OPTIONAL_STRING_FIELDS = Object.freeze([
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
const OPTIONAL_STRING_ARRAY_FIELDS = Object.freeze([
  "appendSystemPrompt",
  "models",
  "tools",
  "excludeTools",
  "extensions",
  "skills",
  "promptTemplates",
  "themes",
]);
const OPTIONAL_BOOLEAN_FIELDS = Object.freeze([
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

class HelperError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function reject(kind) {
  throw new HelperError(kind);
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
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function snapshotArray(value, maximumLength = MAX_ARGUMENTS) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    reject("output");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength ||
    Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
  ) {
    reject("output");
  }
  const snapshot = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      reject("output");
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function checkedString(value, maximumBytes = MAX_ARGUMENT_BYTES) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    reject("output");
  }
  return value;
}

function stringArray(value) {
  return snapshotArray(value).map((entry) => checkedString(entry));
}

function optionalValue(parsed, name, validate) {
  const descriptor = Object.getOwnPropertyDescriptor(parsed, name);
  return descriptor === undefined ? null : validate(descriptor.value);
}

function normalizeParsed(parsed) {
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    types.isProxy(parsed) ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    reject("output");
  }
  const keys = Reflect.ownKeys(parsed);
  if (
    keys.some((key) => typeof key !== "string" || !ARG_FIELDS.includes(key)) ||
    !["messages", "fileArgs", "unknownFlags", "diagnostics"].every((key) =>
      keys.includes(key),
    )
  ) {
    reject("output");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      reject("output");
    }
  }

  const normalized = Object.fromEntries(ARG_FIELDS.map((name) => [name, null]));
  for (const name of OPTIONAL_STRING_FIELDS) {
    normalized[name] = optionalValue(parsed, name, checkedString);
  }
  for (const name of OPTIONAL_STRING_ARRAY_FIELDS) {
    normalized[name] = optionalValue(parsed, name, stringArray);
  }
  for (const name of OPTIONAL_BOOLEAN_FIELDS) {
    normalized[name] = optionalValue(parsed, name, (value) => {
      if (typeof value !== "boolean") reject("output");
      return value;
    });
  }
  normalized.listModels = optionalValue(parsed, "listModels", (value) => {
    if (value !== true && typeof value !== "string") reject("output");
    return typeof value === "string" ? checkedString(value) : value;
  });
  normalized.messages = stringArray(parsed.messages);
  normalized.fileArgs = stringArray(parsed.fileArgs);

  const unknownFlags = parsed.unknownFlags;
  if (
    unknownFlags === null ||
    typeof unknownFlags !== "object" ||
    types.isProxy(unknownFlags) ||
    Object.getPrototypeOf(unknownFlags) !== Map.prototype
  ) {
    reject("output");
  }
  let unknownFlagCount;
  try {
    unknownFlagCount = Object.getOwnPropertyDescriptor(Map.prototype, "size").get.call(
      unknownFlags,
    );
  } catch {
    reject("output");
  }
  if (
    Reflect.ownKeys(unknownFlags).length !== 0 ||
    unknownFlagCount > MAX_ARGUMENTS
  ) {
    reject("output");
  }
  normalized.unknownFlags = [];
  for (const [name, value] of Map.prototype.entries.call(unknownFlags)) {
    checkedString(name);
    if (typeof value !== "boolean" && typeof value !== "string") reject("output");
    if (typeof value === "string") checkedString(value);
    normalized.unknownFlags.push([name, value]);
  }

  normalized.diagnostics = snapshotArray(parsed.diagnostics).map((diagnostic) => {
    if (!exactDataObject(diagnostic, ["type", "message"])) reject("output");
    if (!["warning", "error"].includes(diagnostic.type)) reject("output");
    return {
      type: diagnostic.type,
      message: checkedString(diagnostic.message, MAX_DIAGNOSTIC_BYTES),
    };
  });
  if (
    normalized.thinking !== null &&
    !EXPECTED_THINKING_LEVELS.includes(normalized.thinking)
  ) {
    reject("output");
  }
  if (normalized.mode !== null && !["text", "json", "rpc"].includes(normalized.mode)) {
    reject("output");
  }
  return normalized;
}

function readInput() {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) reject("input");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function decodeRequest() {
  let request;
  try {
    const input = new TextDecoder("utf-8", { fatal: true }).decode(readInput());
    request = JSON.parse(input);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    reject("decode");
  }
  if (
    !exactDataObject(request, ["schemaVersion", "argv"]) ||
    request.schemaVersion !== 1
  ) {
    reject("input");
  }
  const argv = stringArray(request.argv);
  let argumentBytes = 0;
  for (const argument of argv) {
    argumentBytes += Buffer.byteLength(argument);
    if (argumentBytes > MAX_ARGUMENT_BYTES) reject("input");
  }
  return argv;
}

function parseRequest() {
  const argv = decodeRequest();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch {
    reject("parser");
  }
  return normalizeParsed(parsed);
}

let report;
try {
  report = { schemaVersion: 1, ok: true, parsed: parseRequest() };
} catch (error) {
  report = {
    schemaVersion: 1,
    ok: false,
    error: error instanceof HelperError ? error.kind : "internal",
  };
}

let output = JSON.stringify(report);
if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
  output = JSON.stringify({ schemaVersion: 1, ok: false, error: "output" });
}
try {
  fs.writeSync(1, output);
} catch {
  process.exitCode = 1;
}
