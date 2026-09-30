// Runtime plugin scaffold for the subagent-context-budget feature.
//
// This file is intentionally inert until a later Home Manager task wires it
// into OpenCode's plugin directory with budget enforcement metadata. Task 1.3
// owns only the package-load path and a deterministic self-check surface that
// test harnesses and future smoke wrappers can call without changing prompts.

const SERVICE = "subagent-context-budget"
const REQUIRED_SYSTEM_HOOK = "experimental.system.prompt"

type InstructionFragment = {
  name: string
  category: string
  text: string
}

type ComposeOptions = {
  extraFragments?: readonly string[]
}

const INSTRUCTION_FRAGMENTS: Readonly<Record<string, InstructionFragment>> = Object.freeze({
  universal: Object.freeze({
    name: "universal",
    category: "universal",
    text: [
      "# Universal subagent instructions",
      "Stay inside the assigned task boundary, preserve existing user work, and report only verified results.",
      "Use TodoWrite for multi-step work and cite files with file_path:line_number when referencing code.",
    ].join("\n"),
  }),
  "memory-mcpproxy": Object.freeze({
    name: "memory-mcpproxy",
    category: "memory-mcpproxy",
    text: [
      "# Mandatory AgentMemory and mcpproxy safety",
      "",
      "AgentMemory is the only active memory system. Route every memory operation through mcpproxy's discover-then-invoke surface.",
      "",
      "- Discover recall with `retrieve_tools(query: \"agentmemory core recall\")` and durable writes with `retrieve_tools(query: \"agentmemory memory save lesson\")`.",
      "- Use the exact discovered `name`, `call_with` operation class, and `args` JSON object. Never invent tool names or use raw MCP `arguments`.",
      "- Use `agentmemory:memory_recall` or `agentmemory:memory_smart_search` through `call_tool_read` for prior context.",
      "- Use `agentmemory:memory_save` or `agentmemory:memory_lesson_save` through `call_tool_write` for durable knowledge and reusable lessons.",
      "- Use `call_tool_destructive` only for an explicitly discovered destructive operation after approval. Never call an AgentMemory REST endpoint directly or bypass mcpproxy.",
    ].join("\n"),
  }),
  "cc-sdd-minimal": Object.freeze({
    name: "cc-sdd-minimal",
    category: "workflow",
    text: [
      "# Minimal Spec-Driven Development instructions",
      "Use Kiro spec documents as the source of requirements, design boundaries, and task validation.",
      "Do not edit tasks.md from subagent implementation handoffs unless explicitly assigned that parent-controller role.",
    ].join("\n"),
  }),
  "github-native-stacks-minimal": Object.freeze({
    name: "github-native-stacks-minimal",
    category: "workflow",
    text: [
      "# Minimal GitHub-native Stack instructions",
      "",
      "Use GitHub MCP for remote-only Stack work. Discover typed local Stack tools and",
      "exact `name`/`call_with` for `stack_checkout`, `stack_rebase` start/guarded",
      "continue, and `stack_push`; never run `gh stack` or imitate Stack work with",
      "per-branch Git calls.",
      "",
      "Before each local mutation, follow the skill's explicit-path Git-MCP and affected",
      "GitHub MCP snapshots, preview exact scope, and obtain scoped authorization.",
      "Rebase and push need separate authorization; re-inspect `exited_unverified` or",
      "uncertain outcomes before success/retry, and reauthorize if state changes.",
      "",
      "Stage only explicit conflict paths through Git-MCP; continue only after the",
      "skill's marker/preflight. Use a user-owned handoff with the exact command; stop",
      "for unavailable tools, explicit CLI preference, abort (`gh stack rebase --abort`),",
      "TUI (`gh stack modify`), or another unsupported operation. Never merge or",
      "unstack.",
    ].join("\n"),
  }),
  "shopify-host": Object.freeze({
    name: "shopify-host",
    category: "host-specific",
    text: [
      "# Shopify host instructions",
      "Apply Shopify host constraints only for host-scoped agents and keep personal-host profiles free of Shopify-only workflow text.",
    ].join("\n"),
  }),
  "general-research": Object.freeze({
    name: "general-research",
    category: "role-fragment",
    text: "# General research role\nAnswer bounded research questions with local, memory, and approved web documentation sources.",
  }),
  "readonly-codebase": Object.freeze({
    name: "readonly-codebase",
    category: "role-fragment",
    text: "# Read-only codebase role\nInspect files and symbols without modifying repository content.",
  }),
  "nix-package": Object.freeze({
    name: "nix-package",
    category: "role-fragment",
    text: "# Nix package role\nInspect Nix package definitions, evaluations, and dry-run output within the assigned scope.",
  }),
  "kiro-spec-orchestration": Object.freeze({
    name: "kiro-spec-orchestration",
    category: "role-fragment",
    text: [
      "# Kiro spec orchestration role",
      "Drive cc-sdd/Kiro specification generation through discovery, requirements, research/gap validation, design, design validation, and tasks.",
      "Stop before implementation. Review generated artifacts for ambiguity, loose scope, boundary gaps, excessive prose, and research gaps before task generation.",
    ].join("\n"),
  }),
  "nvim-config": Object.freeze({
    name: "nvim-config",
    category: "role-fragment",
    text: "# Neovim configuration role\nInspect Neovim module, plugin, and configuration paths without unrelated workflow guidance.",
  }),
  "security-readonly": Object.freeze({
    name: "security-readonly",
    category: "role-fragment",
    text: "# Security read-only role\nAudit fixture and repository paths for security concerns without mutation.",
  }),
  "shopify-stack": Object.freeze({
    name: "shopify-stack",
    category: "role-fragment",
    text: "# Shopify stack role\nPlan and inspect Shopify GitHub-native Stack workflows without applying bypasses unless explicitly authorized.",
  }),
  "shopify-yugabyte-readonly": Object.freeze({
    name: "shopify-yugabyte-readonly",
    category: "role-fragment",
    text: "# Shopify Yugabyte read-only role\nTrace Yugabyte source context on Shopify hosts without repository mutation.",
  }),
})

const INSTRUCTION_PROFILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "general-research": Object.freeze(["universal", "memory-mcpproxy", "general-research"]),
  "readonly-codebase": Object.freeze(["universal", "memory-mcpproxy", "readonly-codebase"]),
  "nix-package": Object.freeze(["universal", "memory-mcpproxy", "cc-sdd-minimal", "nix-package"]),
  "kiro-spec-orchestration": Object.freeze(["universal", "memory-mcpproxy", "cc-sdd-minimal", "kiro-spec-orchestration"]),
  "nvim-config": Object.freeze(["universal", "memory-mcpproxy", "nvim-config"]),
  "security-readonly": Object.freeze(["universal", "memory-mcpproxy", "security-readonly"]),
  "shopify-stack": Object.freeze(["universal", "memory-mcpproxy", "github-native-stacks-minimal", "shopify-host", "shopify-stack"]),
  "shopify-yugabyte-readonly": Object.freeze(["universal", "memory-mcpproxy", "shopify-host", "shopify-yugabyte-readonly"]),
})

/**
 * @typedef {"disabled" | "ready" | "failed"} SelfCheckStatus
 *
 * @typedef {object} SelfCheckRuntime
 * @property {boolean} [enabled]
 * @property {readonly string[]} [availableHooks]
 * @property {boolean} [sessionAgentLookupAvailable]
 * @property {object} [budgetMetadata]
 *
 * @typedef {object} SelfCheckResult
 * @property {SelfCheckStatus} status
 * @property {string} requiredHook
 * @property {readonly string[]} missing
 * @property {string} reason
 * @property {boolean} [metadataPresent]
 * @property {readonly string[]} [unknownAgents]
 * @property {readonly string[]} [unresolvedProfiles]
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
      budgetMetadata: undefined,
    }
  }

  const value = /** @type {Record<string, unknown>} */ (runtime)
  return {
    enabled: value.enabled === true,
    availableHooks: Array.isArray(value.availableHooks)
      ? value.availableHooks.filter((hook) => typeof hook === "string")
      : [],
    sessionAgentLookupAvailable: value.sessionAgentLookupAvailable === true,
    budgetMetadata: isObject(value.budgetMetadata) ? value.budgetMetadata : undefined,
  }
}

/**
 * Inspect a runtime-supplied budget metadata object and identify which agent
 * entries cannot be mapped to a resolvable instruction profile. Returns a
 * structure that downstream self-check logic uses to assemble both the
 * deterministic `missing[]` sentinels and the validation-readable optional
 * fields. Does not read from disk: the runtime caller (HM-wired plugin) is
 * responsible for hydrating `budgetMetadata` from the rendered metadata file.
 *
 * @param {unknown} budgetMetadata
 */
function inspectBudgetMetadata(budgetMetadata) {
  if (!isObject(budgetMetadata)) {
    return {
      metadataPresent: false,
      agentMapPresent: false,
      unknownAgents: /** @type {readonly string[]} */ ([]),
      unresolvedProfiles: /** @type {readonly string[]} */ ([]),
    }
  }

  const metadata = /** @type {Record<string, unknown>} */ (budgetMetadata)
  const agents = metadata.agents
  if (!isObject(agents)) {
    return {
      metadataPresent: true,
      agentMapPresent: false,
      unknownAgents: /** @type {readonly string[]} */ ([]),
      unresolvedProfiles: /** @type {readonly string[]} */ ([]),
    }
  }

  const entries = Object.entries(/** @type {Record<string, unknown>} */ (agents))
  if (entries.length === 0) {
    return {
      metadataPresent: true,
      agentMapPresent: false,
      unknownAgents: /** @type {readonly string[]} */ ([]),
      unresolvedProfiles: /** @type {readonly string[]} */ ([]),
    }
  }

  const unknownAgents: string[] = []
  const unresolvedSet = new Set<string>()

  for (const [agentName, agentEntry] of entries) {
    if (!isObject(agentEntry)) {
      unknownAgents.push(agentName)
      continue
    }
    const entry = agentEntry as Record<string, unknown>
    // Escape-hatch state: unbudgeted agents intentionally bypass profile
    // enforcement. Per requirement 2.4 their absence from the profile map is
    // not a self-check failure.
    if (entry.state === "unbudgeted") {
      continue
    }
    const profileName = entry.instructionProfile
    if (typeof profileName !== "string" || profileName.length === 0) {
      unknownAgents.push(agentName)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(INSTRUCTION_PROFILES, profileName)) {
      unresolvedSet.add(profileName)
    }
  }

  return {
    metadataPresent: true,
    agentMapPresent: true,
    unknownAgents: /** @type {readonly string[]} */ (unknownAgents.slice().sort()),
    unresolvedProfiles: /** @type {readonly string[]} */ (
      Array.from(unresolvedSet).sort()
    ),
  }
}

/** @param {unknown} value */
function normalizeExtraFragments(value) {
  return Array.isArray(value)
    ? value.filter((fragmentName) => typeof fragmentName === "string" && fragmentName.length > 0)
    : []
}

/**
 * Compose a profile-specific replacement system prompt from ordered fragments.
 *
 * @param {string} profileName
 * @param {{ extraFragments?: readonly string[] } | unknown} options
 */
function composeInstructionProfile(profileName: string, options: ComposeOptions = {}) {
  if (typeof profileName !== "string" || profileName.length === 0 || !Object.prototype.hasOwnProperty.call(INSTRUCTION_PROFILES, profileName)) {
    return { kind: "missing-profile", profileName }
  }

  const orderedFragmentNames = [
    ...INSTRUCTION_PROFILES[profileName],
    ...normalizeExtraFragments(options.extraFragments),
  ]
  const seen = new Set<string>()
  const fragments: InstructionFragment[] = []

  for (const fragmentName of orderedFragmentNames) {
    if (seen.has(fragmentName)) continue
    seen.add(fragmentName)

    if (!Object.prototype.hasOwnProperty.call(INSTRUCTION_FRAGMENTS, fragmentName)) {
      return { kind: "missing-fragment", profileName, fragmentName }
    }

    const fragment = INSTRUCTION_FRAGMENTS[fragmentName]
    fragments.push({
      name: fragment.name,
      category: fragment.category,
      text: fragment.text,
    })
  }

  const fragmentNames = fragments.map((fragment) => fragment.name)
  for (const mandatoryName of ["universal", "memory-mcpproxy"]) {
    if (!fragmentNames.includes(mandatoryName)) {
      return { kind: "missing-fragment", profileName, fragmentName: mandatoryName }
    }
  }

  return {
    kind: "composed",
    profileName,
    fragments,
    systemText: fragments.map((fragment) => fragment.text).join("\n\n"),
  }
}

/**
 * Evaluate runtime prerequisites without registering hooks or mutating prompts.
 *
 * Collects every failure mode the plugin must fail closed on:
 * - hook availability (`hook:experimental.system.prompt`)
 * - session-agent lookup availability (`session-agent-lookup`)
 * - budget metadata presence (`metadata`)
 * - non-empty agent map (`agent-map`)
 * - agent entries that map to a resolvable profile (`agent:<name>`)
 * - referenced profiles that exist in INSTRUCTION_PROFILES (`profile:<name>`)
 *
 * The `disabled` branch stays minimal (no metadata fields) so existing
 * disabled fixtures remain unchanged. Enabled results always include the new
 * optional fields (`metadataPresent`, `unknownAgents`, `unresolvedProfiles`)
 * so the audit and validation CLIs can ingest a stable machine-readable shape.
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

  const metadataInfo = inspectBudgetMetadata(normalized.budgetMetadata)
  const missing: string[] = []

  if (!normalized.availableHooks.includes(REQUIRED_SYSTEM_HOOK)) {
    missing.push(`hook:${REQUIRED_SYSTEM_HOOK}`)
  }
  if (!normalized.sessionAgentLookupAvailable) {
    missing.push("session-agent-lookup")
  }
  if (!metadataInfo.metadataPresent) {
    missing.push("metadata")
  } else if (!metadataInfo.agentMapPresent) {
    missing.push("agent-map")
  } else {
    for (const agentName of metadataInfo.unknownAgents) {
      missing.push(`agent:${agentName}`)
    }
    for (const profileName of metadataInfo.unresolvedProfiles) {
      missing.push(`profile:${profileName}`)
    }
  }

  if (missing.length > 0) {
    return {
      status: "failed",
      requiredHook: REQUIRED_SYSTEM_HOOK,
      missing,
      reason: "runtime-prerequisites-missing",
      metadataPresent: metadataInfo.metadataPresent,
      unknownAgents: metadataInfo.unknownAgents,
      unresolvedProfiles: metadataInfo.unresolvedProfiles,
    }
  }

  return {
    status: "ready",
    requiredHook: REQUIRED_SYSTEM_HOOK,
    missing: [],
    reason: "hook-and-agent-lookup-available",
    metadataPresent: true,
    unknownAgents: [],
    unresolvedProfiles: [],
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
 * @typedef {"primary-session" | "agent-unknown" | "profile-missing"} SkipReason
 *
 * @typedef {{ kind: "apply"; agentName: string; profileName: string; systemText: string }} ApplyDecision
 * @typedef {{ kind: "skip"; reason: SkipReason }} SkipDecision
 * @typedef {ApplyDecision | SkipDecision} ProfileDecision
 *
 * @typedef {object} SessionInfo
 * @property {string} [agentName]
 * @property {boolean} [isSubagent]
 *
 * @typedef {(sessionID: string) => (SessionInfo | undefined | null | Promise<SessionInfo | undefined | null>)} SessionLookup
 *
 * @typedef {Readonly<Record<string, string>>} AgentProfileMap
 *
 * @typedef {object} DecideProfileInput
 * @property {string} [agentName]
 * @property {boolean} [isSubagent]
 * @property {AgentProfileMap} [profileMap]
 *
 * @typedef {object} DecideInput
 * @property {string} sessionID
 * @property {string} [currentSystemText]
 * @property {SessionLookup} [sessionLookup]
 * @property {AgentProfileMap} [profileMap]
 */

const SKIP_PRIMARY_SESSION = Object.freeze({ kind: "skip", reason: "primary-session" })
const SKIP_AGENT_UNKNOWN = Object.freeze({ kind: "skip", reason: "agent-unknown" })
const SKIP_PROFILE_MISSING = Object.freeze({ kind: "skip", reason: "profile-missing" })

/**
 * Decide whether to apply a profile system prompt based on already-resolved
 * session identity. Pure: no I/O, deterministic on its inputs, exposed for
 * testing the four ProfileDecision branches without spinning up the runtime
 * hook wiring (which is task 3.3's responsibility).
 *
 * @param {DecideProfileInput | unknown} input
 * @returns {ProfileDecision}
 */
function decideProfile(input) {
  if (!isObject(input)) {
    return SKIP_PRIMARY_SESSION
  }
  const value = /** @type {Record<string, unknown>} */ (input)

  if (value.isSubagent !== true) {
    return SKIP_PRIMARY_SESSION
  }

  const agentName = typeof value.agentName === "string" ? value.agentName : ""
  if (agentName.length === 0) {
    return SKIP_AGENT_UNKNOWN
  }

  const profileMap = value.profileMap
  if (!isObject(profileMap) || !Object.prototype.hasOwnProperty.call(profileMap, agentName)) {
    return SKIP_AGENT_UNKNOWN
  }

  const profileName = /** @type {Record<string, unknown>} */ (profileMap)[agentName]
  if (typeof profileName !== "string" || profileName.length === 0) {
    return SKIP_PROFILE_MISSING
  }

  const composed = composeInstructionProfile(profileName)
  if (composed.kind !== "composed") {
    return SKIP_PROFILE_MISSING
  }

  return {
    kind: "apply",
    agentName,
    profileName,
    systemText: composed.systemText,
  }
}

/**
 * Resolve a subagent session via the injected session lookup and delegate to
 * decideProfile. Falsy or thrown lookup results map to `agent-unknown` so the
 * runtime fails closed without applying partial filtering. Matches the
 * InstructionProfileService.decide contract in design.md so task 3.3 can
 * register an OpenCode system-prompt hook around this function without
 * reshaping its inputs.
 *
 * @param {DecideInput | unknown} input
 * @returns {Promise<ProfileDecision>}
 */
async function decide(input) {
  if (!isObject(input)) {
    return SKIP_AGENT_UNKNOWN
  }
  const value = /** @type {Record<string, unknown>} */ (input)

  const sessionLookup = value.sessionLookup
  if (typeof sessionLookup !== "function") {
    return SKIP_AGENT_UNKNOWN
  }

  let sessionInfo
  try {
    sessionInfo = await sessionLookup(/** @type {string} */ (value.sessionID))
  } catch {
    return SKIP_AGENT_UNKNOWN
  }

  if (!isObject(sessionInfo)) {
    return SKIP_AGENT_UNKNOWN
  }

  const session = /** @type {Record<string, unknown>} */ (sessionInfo)
  return decideProfile({
    agentName: typeof session.agentName === "string" ? session.agentName : undefined,
    isSubagent: session.isSubagent === true,
    profileMap: isObject(value.profileMap)
      ? /** @type {AgentProfileMap} */ (value.profileMap)
      : Object.freeze({}),
  })
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
  composeInstructionProfile,
  decideProfile,
  decide,
  inspectBudgetMetadata,
  instructionFragments: INSTRUCTION_FRAGMENTS,
  instructionProfiles: INSTRUCTION_PROFILES,
  selfCheck,
  runSelfCheckCommand,
})
