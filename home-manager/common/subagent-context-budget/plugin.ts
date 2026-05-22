// Runtime plugin scaffold for the subagent-context-budget feature.
//
// This file is intentionally inert until a later Home Manager task wires it
// into OpenCode's plugin directory with budget enforcement metadata. Task 1.3
// owns only the package-load path and a deterministic self-check surface that
// test harnesses and future smoke wrappers can call without changing prompts.

const SERVICE = "subagent-context-budget"
const REQUIRED_SYSTEM_HOOK = "experimental.system.prompt"

/**
 * @typedef {"disabled" | "ready" | "failed"} SelfCheckStatus
 *
 * @typedef {object} SelfCheckRuntime
 * @property {boolean} [enabled]
 * @property {readonly string[]} [availableHooks]
 * @property {boolean} [sessionAgentLookupAvailable]
 *
 * @typedef {object} SelfCheckResult
 * @property {SelfCheckStatus} status
 * @property {string} requiredHook
 * @property {readonly string[]} missing
 * @property {string} reason
 */

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object"
}

/** @param {unknown} runtime */
function normalizeRuntime(runtime) {
  if (!isObject(runtime)) {
    return {
      enabled: false,
      availableHooks: [],
      sessionAgentLookupAvailable: false,
    }
  }

  const value = /** @type {Record<string, unknown>} */ (runtime)
  return {
    enabled: value.enabled === true,
    availableHooks: Array.isArray(value.availableHooks)
      ? value.availableHooks.filter((hook) => typeof hook === "string")
      : [],
    sessionAgentLookupAvailable: value.sessionAgentLookupAvailable === true,
  }
}

/**
 * Evaluate runtime prerequisites without registering hooks or mutating prompts.
 *
 * @param {SelfCheckRuntime | unknown} runtime
 * @returns {SelfCheckResult}
 */
function selfCheck(runtime) {
  const normalized = normalizeRuntime(runtime)

  if (!normalized.enabled) {
    return {
      status: "disabled",
      requiredHook: REQUIRED_SYSTEM_HOOK,
      missing: [],
      reason: "budget-enforcement-disabled",
    }
  }

  const missing: string[] = []
  if (!normalized.availableHooks.includes(REQUIRED_SYSTEM_HOOK)) {
    missing.push(`hook:${REQUIRED_SYSTEM_HOOK}`)
  }
  if (!normalized.sessionAgentLookupAvailable) {
    missing.push("session-agent-lookup")
  }

  if (missing.length > 0) {
    return {
      status: "failed",
      requiredHook: REQUIRED_SYSTEM_HOOK,
      missing,
      reason: "runtime-prerequisites-missing",
    }
  }

  return {
    status: "ready",
    requiredHook: REQUIRED_SYSTEM_HOOK,
    missing: [],
    reason: "hook-and-agent-lookup-available",
  }
}

/**
 * Command-style self-check entry point for fixture tests and future wrappers.
 * It returns stable JSON and performs no OpenCode runtime side effects.
 *
 * @param {SelfCheckRuntime | unknown} runtime
 */
function runSelfCheckCommand(runtime) {
  return `${JSON.stringify(selfCheck(runtime), null, 2)}\n`
}

/**
 * @param {unknown} ctx
 * @param {SelfCheckResult} result
 */
async function logSelfCheck(ctx, result) {
  if (!isObject(ctx)) return
  const client = /** @type {Record<string, unknown>} */ (ctx).client
  if (!isObject(client)) return
  const app = /** @type {Record<string, unknown>} */ (client).app
  if (!isObject(app) || typeof app.log !== "function") return

  await app.log({
    body: {
      service: SERVICE,
      level: result.status === "failed" ? "error" : "info",
      message: `plugin self-check ${result.status}`,
      extra: result,
    },
  })
}

/**
 * The OpenCode plugin entrypoint. Returning an empty hook object keeps this
 * scaffold non-behavioral: no prompt transform hooks are registered in task 1.3.
 *
 * @param {unknown} ctx
 */
async function pluginEntrypoint(ctx) {
  const runtime = isObject(ctx)
    ? /** @type {Record<string, unknown>} */ (ctx).subagentContextBudget
    : undefined
  const result = selfCheck(runtime)
  await logSelfCheck(ctx, result)
  return {}
}

export const SubagentContextBudgetPlugin = Object.assign(pluginEntrypoint, {
  selfCheck,
  runSelfCheckCommand,
})
