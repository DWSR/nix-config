import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  createProviderRuntimeSecrets,
  resolverPlans,
} from "__PI_AGENT_CREDENTIAL_POLICY_MODULE__";

const RESOLVER_TIMEOUT_MS = 5_000;
const RESOLVER_OUTPUT_LIMIT_BYTES = 16 * 1024;
const DEVX_EXECUTABLE =
  /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[^/]+\/bin\/devx$/;
const SHOPIFY_RESOLVER_KINDS = [
  "shopify-gateway-token",
  "shopify-gateway-base",
];
const OPERATION_BY_KIND = Object.freeze({
  "shopify-gateway-token": "token",
  "shopify-gateway-base": "base",
});
const EXECUTION_PLAN_VALUES = PI_AGENT_EXECUTION_PLAN_VALUES_PLACEHOLDER;
const EXECUTION_PLAN_DIGEST = "__PI_AGENT_EXECUTION_PLAN_DIGEST__";

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(EXECUTION_PLAN_VALUES);

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
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expectedKeys.length ||
    [...keys]
      .sort()
      .some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function contractFailure() {
  throw new Error("credential resolver contract validation failed");
}

function validateExecutionContract() {
  const executionPlanDigest = createHash("sha256")
    .update(JSON.stringify(EXECUTION_PLAN_VALUES))
    .digest("hex");
  if (
    !/^[0-9a-f]{64}$/.test(EXECUTION_PLAN_DIGEST) ||
    executionPlanDigest !== EXECUTION_PLAN_DIGEST ||
    !Array.isArray(resolverPlans) ||
    !Object.isFrozen(resolverPlans) ||
    !Array.isArray(EXECUTION_PLAN_VALUES) ||
    !Object.isFrozen(EXECUTION_PLAN_VALUES) ||
    resolverPlans.length !== EXECUTION_PLAN_VALUES.length
  ) {
    contractFailure();
  }

  if (resolverPlans.length === 1) {
    const plan = resolverPlans[0];
    const execution = EXECUTION_PLAN_VALUES[0];
    if (
      !isExactDataObject(plan, ["kind"]) ||
      !Object.isFrozen(plan) ||
      plan.kind !== "pi-auth" ||
      !isExactDataObject(execution, ["kind", "executable", "argv"]) ||
      !Object.isFrozen(execution) ||
      execution.kind !== "pi-auth" ||
      execution.executable !== null ||
      execution.argv !== null
    ) {
      contractFailure();
    }
    return Object.freeze({ mode: "personal", executions: Object.freeze([]) });
  }

  if (resolverPlans.length !== SHOPIFY_RESOLVER_KINDS.length) contractFailure();
  for (let index = 0; index < SHOPIFY_RESOLVER_KINDS.length; index += 1) {
    const expectedKind = SHOPIFY_RESOLVER_KINDS[index];
    const plan = resolverPlans[index];
    const execution = EXECUTION_PLAN_VALUES[index];
    if (
      !isExactDataObject(plan, ["kind", "executable"]) ||
      !Object.isFrozen(plan) ||
      plan.kind !== expectedKind ||
      typeof plan.executable !== "string" ||
      !DEVX_EXECUTABLE.test(plan.executable) ||
      !isExactDataObject(execution, ["kind", "executable", "argv"]) ||
      !Object.isFrozen(execution) ||
      execution.kind !== plan.kind ||
      execution.executable !== plan.executable ||
      !Array.isArray(execution.argv) ||
      !Object.isFrozen(execution.argv) ||
      execution.argv.length === 0 ||
      execution.argv.length > 8 ||
      execution.argv.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.includes("\0"),
      )
    ) {
      contractFailure();
    }
  }
  if (resolverPlans[0].executable !== resolverPlans[1].executable)
    contractFailure();
  return Object.freeze({
    mode: "shopify-gateway",
    executions: EXECUTION_PLAN_VALUES,
  });
}

function resolverFailure(kind, operation, failure) {
  return new Error(
    `credential resolver ${kind} operation ${operation} failed: ${failure}`,
  );
}

function terminateResolverProcess(child) {
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code === "ESRCH") return;
    try {
      child.kill("SIGKILL");
    } catch (fallbackError) {
      if (fallbackError.code !== "ESRCH") return;
    }
  }
}

function normalizeResolverOutput(output, kind, operation) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw resolverFailure(kind, operation, "invalid-output");
  }

  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);

  if (
    value.trim().length === 0 ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    throw resolverFailure(kind, operation, "invalid-output");
  }
  return value;
}

function executeResolver(invocation) {
  const { kind } = invocation;
  const operation = OPERATION_BY_KIND[kind];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.executable, invocation.argv, {
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(resolverFailure(kind, operation, "spawn"));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    const stop = (reason) => {
      if (failure !== null) return;
      failure = reason;
      terminateResolverProcess(child);
    };
    const timeout = setTimeout(() => stop("timeout"), RESOLVER_TIMEOUT_MS);

    child.stdout.on("data", (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > RESOLVER_OUTPUT_LIMIT_BYTES) {
        stop("output-limit");
      } else if (failure === null) {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on("data", (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrBytes += chunk.length;
      if (stderrBytes > RESOLVER_OUTPUT_LIMIT_BYTES) stop("output-limit");
    });
    child.once("error", () => {
      if (failure === null) failure = "spawn";
      clearTimeout(timeout);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure !== null) {
        reject(resolverFailure(kind, operation, failure));
      } else if (code !== 0 || signal !== null) {
        reject(resolverFailure(kind, operation, "command"));
      } else {
        try {
          resolve(
            normalizeResolverOutput(
              Buffer.concat(stdoutChunks),
              kind,
              operation,
            ),
          );
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

export async function resolveProviderRuntimeSecrets(...inputs) {
  if (inputs.length !== 0) {
    throw new Error("credential resolver invocation rejected");
  }
  const contract = validateExecutionContract();
  if (contract.mode === "personal") {
    return Object.freeze({
      runtimeSecrets: createProviderRuntimeSecrets({
        resolverResults: {},
        launchId: null,
      }),
      baseCandidate: null,
    });
  }

  const resolverResults = {};
  for (const invocation of contract.executions) {
    resolverResults[invocation.kind] = await executeResolver(invocation);
  }
  const runtimeSecrets = createProviderRuntimeSecrets({
    resolverResults,
    launchId: randomUUID(),
  });
  return Object.freeze({
    runtimeSecrets,
    baseCandidate: resolverResults["shopify-gateway-base"],
  });
}
