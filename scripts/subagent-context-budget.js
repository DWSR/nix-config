#!/usr/bin/env node
/*
 * subagent-context-budget.js — BudgetCLI entry point.
 *
 * Task 1.2 owns only CLI and test-runner scaffolding. The audit,
 * validate, and smoke-plan commands intentionally return deterministic
 * placeholders until later tasks add report parsing and comparison.
 *
 * Task 4.2 replaces the `audit` placeholder with a real report that
 * combines budget metadata, the minimal read-only baseline artifact,
 * diagnostic usage from the cost-report adapter, and observed tool
 * data into deterministic JSON and Markdown audit reports
 * (Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 4.2, 4.3, 7.3).
 */
'use strict';

const fs = require('node:fs');

const COMMANDS = Object.freeze(['audit', 'validate', 'smoke-plan']);
const SOURCES = Object.freeze(['builtin', 'common-markdown', 'host-markdown']);
const HOST_SCOPES = Object.freeze(['all', 'shopify', 'personal']);
const BASELINE_TOKEN_STATUSES = Object.freeze(['placeholder', 'measured']);
const FORBIDDEN_BASELINE_INSTRUCTION_CATEGORIES = Object.freeze(new Set([
  'host-specific',
  'project-specific',
  'shopify',
  'personal',
  'nix-config',
]));
const FORBIDDEN_BASELINE_TOOL_CATEGORIES = Object.freeze(new Set([
  'write',
  'mutation',
  'destructive',
  'shell',
  'external-directory',
]));
const SUPPORTED_PERMISSION_KEYS = Object.freeze(new Set([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'skill',
  'doom_loop',
  'mcpproxy_retrieve_tools',
  'mcpproxy_call_tool_read',
  'mcpproxy_call_tool_write',
  'mcpproxy_call_tool_destructive',
]));
const RATIONALE_REQUIRED_PERMISSIONS = Object.freeze({
  edit: 'broad mutation',
  mcpproxy_call_tool_write: 'broad mutation',
  mcpproxy_call_tool_destructive: 'broad mutation',
  webfetch: 'web',
  websearch: 'web',
  external_directory: 'external-directory',
  bash: 'shell',
});
const BUDGET_STATE_REASONS = Object.freeze({
  enforced: Object.freeze(['default', 'host-override']),
  unbudgeted: Object.freeze(['operator-escape-hatch']),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyObject(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidTokenCount(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function isValidBudgetState(value) {
  if (!isObject(value) || !isNonEmptyString(value.kind)) {
    return false;
  }

  const validReasons = BUDGET_STATE_REASONS[value.kind];
  return Array.isArray(validReasons) && validReasons.includes(value.reason);
}

function permissionRuleGrantsCapability(rule) {
  if (rule === 'allow' || rule === 'ask') {
    return true;
  }
  if (!isObject(rule)) {
    return false;
  }

  return Object.values(rule).some((action) => action === 'allow' || action === 'ask');
}

function hasCapabilityRationale(agent) {
  return Array.isArray(agent.capabilityRationale)
    && agent.capabilityRationale.some((entry) => isNonEmptyString(entry) && entry.trim().length > 0);
}

function validationError(agent, field, message) {
  return { agent, field, message };
}

function validateStringArray(owner, field, value) {
  if (!Array.isArray(value) || value.length === 0) {
    return [validationError(owner, field, `${field} must be a non-empty array`)];
  }

  const errors = [];
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      errors.push(validationError(owner, `${field}.${index}`, `${field} entries must be non-empty strings`));
    }
  });
  return errors;
}

function validateMinimalBaseline(minimalBaseline) {
  const owner = '<minimalBaseline>';
  const errors = [];

  if (!isObject(minimalBaseline)) {
    return [validationError(owner, 'minimalBaseline', 'minimal read-only baseline must be an object')];
  }

  if (minimalBaseline.name !== 'minimal-readonly') {
    errors.push(validationError(owner, 'name', 'minimal read-only baseline name must be minimal-readonly'));
  }

  if (!isObject(minimalBaseline.measuredTokens)) {
    errors.push(validationError(owner, 'measuredTokens', 'minimal read-only baseline must include measured-token fields'));
  } else {
    const measuredTokens = minimalBaseline.measuredTokens;
    if (!BASELINE_TOKEN_STATUSES.includes(measuredTokens.status)) {
      errors.push(validationError(owner, 'measuredTokens.status', 'minimal read-only baseline token status must be placeholder or measured'));
    }
    if (!hasOwn(measuredTokens, 'firstTurnInput') || !isValidTokenCount(measuredTokens.firstTurnInput)) {
      errors.push(validationError(owner, 'measuredTokens.firstTurnInput', 'minimal read-only baseline must include first-turn token placeholder or measured count'));
    }
    for (const field of ['measuredAt', 'source']) {
      if (!hasOwn(measuredTokens, field) || !(measuredTokens[field] === null || isNonEmptyString(measuredTokens[field]))) {
        errors.push(validationError(owner, `measuredTokens.${field}`, `minimal read-only baseline measured-token ${field} must be null or a non-empty string`));
      }
    }
    if (hasOwn(measuredTokens, 'firstTurnInput') && measuredTokens.status === 'placeholder' && measuredTokens.firstTurnInput !== null) {
      errors.push(validationError(owner, 'measuredTokens.firstTurnInput', 'placeholder minimal read-only baseline token count must be null'));
    }
    if (hasOwn(measuredTokens, 'firstTurnInput') && measuredTokens.status === 'measured' && !Number.isInteger(measuredTokens.firstTurnInput)) {
      errors.push(validationError(owner, 'measuredTokens.firstTurnInput', 'measured minimal read-only baseline token count must be an integer'));
    }
  }

  errors.push(...validateStringArray(owner, 'instructionCategories', minimalBaseline.instructionCategories));
  errors.push(...validateStringArray(owner, 'allowedToolCategories', minimalBaseline.allowedToolCategories));

  if (Array.isArray(minimalBaseline.instructionCategories)) {
    for (const category of minimalBaseline.instructionCategories) {
      if (FORBIDDEN_BASELINE_INSTRUCTION_CATEGORIES.has(category)) {
        errors.push(validationError(owner, `instructionCategories.${category}`, 'minimal read-only baseline must not include host-specific or project-specific instruction categories'));
      }
    }
  }

  if (Array.isArray(minimalBaseline.allowedToolCategories)) {
    for (const category of minimalBaseline.allowedToolCategories) {
      if (FORBIDDEN_BASELINE_TOOL_CATEGORIES.has(category)) {
        errors.push(validationError(owner, `allowedToolCategories.${category}`, 'minimal read-only baseline must include only read-only tool categories'));
      }
    }
  }

  return errors;
}

function summarizeMinimalBaseline(minimalBaseline) {
  return {
    name: minimalBaseline.name,
    measuredTokens: { ...minimalBaseline.measuredTokens },
    instructionCategories: [...minimalBaseline.instructionCategories].sort(),
    allowedToolCategories: [...minimalBaseline.allowedToolCategories].sort(),
  };
}

function validateAgentBudget(catalogName, agent) {
  const errors = [];

  if (!isObject(agent)) {
    return [validationError(catalogName, 'agent', 'agent budget entry must be an object')];
  }

  if (agent.name !== catalogName) {
    errors.push(validationError(catalogName, 'name', 'agent name must match its catalog key'));
  }
  if (!SOURCES.includes(agent.source)) {
    errors.push(validationError(catalogName, 'source', 'agent source must be builtin, common-markdown, or host-markdown'));
  }
  if (!HOST_SCOPES.includes(agent.hostScope)) {
    errors.push(validationError(catalogName, 'hostScope', 'agent host scope must be all, shopify, or personal'));
  }
  if (!isValidBudgetState(agent.state)) {
    errors.push(validationError(catalogName, 'state', 'agent state must be enforced/default, enforced/host-override, or unbudgeted/operator-escape-hatch'));
  }
  if (!isNonEmptyString(agent.smokeClass)) {
    errors.push(validationError(catalogName, 'smokeClass', 'agent must define a smoke class'));
  }
  if (!Array.isArray(agent.capabilityRationale)) {
    errors.push(validationError(catalogName, 'capabilityRationale', 'agent capability rationale must be an array'));
  }

  if (Object.prototype.hasOwnProperty.call(agent, 'tools')) {
    errors.push(validationError(catalogName, 'tools', 'deprecated tools allowlists are not supported in budget metadata; use permissionBudget'));
  }

  if (isObject(agent.state) && agent.state.kind === 'enforced') {
    if (!isNonEmptyString(agent.instructionProfile)) {
      errors.push(validationError(catalogName, 'instructionProfile', 'enforced agent must define an instruction profile'));
    }
    if (!isNonEmptyObject(agent.permissionBudget)) {
      errors.push(validationError(catalogName, 'permissionBudget', 'enforced agent must define a non-empty permission budget'));
    }
  }

  if (isObject(agent.permissionBudget)) {
    for (const permissionKey of Object.keys(agent.permissionBudget).sort()) {
      if (permissionKey === 'tools') {
        errors.push(validationError(catalogName, 'permissionBudget.tools', 'deprecated tools allowlists are not supported in budget metadata; use permissionBudget'));
        continue;
      }
      if (!SUPPORTED_PERMISSION_KEYS.has(permissionKey)) {
        errors.push(validationError(catalogName, `permissionBudget.${permissionKey}`, 'permission budget key is not supported; use supported permission keys and avoid undocumented mutation aliases'));
        continue;
      }

      const rationaleCategory = RATIONALE_REQUIRED_PERMISSIONS[permissionKey];
      if (rationaleCategory !== undefined && permissionRuleGrantsCapability(agent.permissionBudget[permissionKey]) && !hasCapabilityRationale(agent)) {
        errors.push(validationError(catalogName, 'capabilityRationale', `agent must document rationale for ${rationaleCategory} capability: ${permissionKey}`));
      }
    }
  }

  return errors;
}

function validateBudgetMetadata(metadata) {
  const errors = [];

  if (!isObject(metadata)) {
    return {
      ok: false,
      errors: [validationError('<metadata>', 'metadata', 'metadata must be an object')],
    };
  }

  if (metadata.version !== 1) {
    errors.push(validationError('<metadata>', 'version', 'metadata version must be 1'));
  }
  if (!HOST_SCOPES.includes(metadata.host)) {
    errors.push(validationError('<metadata>', 'host', 'metadata host must be all, shopify, or personal'));
  }
  if (typeof metadata.enforcementEnabled !== 'boolean') {
    errors.push(validationError('<metadata>', 'enforcementEnabled', 'metadata must declare enforcement state'));
  }
  if (!isObject(metadata.agents)) {
    errors.push(validationError('<metadata>', 'agents', 'metadata agents must be an object'));
  }
  errors.push(...validateMinimalBaseline(metadata.minimalBaseline));

  const agents = isObject(metadata.agents) ? metadata.agents : {};
  for (const name of Object.keys(agents).sort()) {
    errors.push(...validateAgentBudget(name, agents[name]));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const agentNames = Object.keys(agents).sort();
  return {
    ok: true,
    value: {
      agentCount: agentNames.length,
      agentNames,
      minimalBaseline: summarizeMinimalBaseline(metadata.minimalBaseline),
    },
  };
}

// ---------------------------------------------------------------------
// CostReportAdapter (task 4.1)
//
// Defensive parser for `opencode-cost-report` v2 JSON output. Reads only
// the public fields named in design.md's `CostReportSummary` contract
// (~ design.md:466-514) and discards everything else, preserving the
// diagnostic's default privacy posture (R5.7). Errors are returned as
// `Result<T, E>` values per design.md:340-343; the adapter never throws.
//
// Loose coupling: this module deliberately does NOT import internal
// helpers from `scripts/opencode-cost-report.js`; only the documented
// JSON shape is pinned.
// ---------------------------------------------------------------------

const SENTINEL_AGENT_KEYS = Object.freeze(new Set(['unknown', 'null', '']));
const PRICING_DRIFT_FINDING = /(pricing|drift)/i;

function errMissing(field) {
  return { ok: false, error: { kind: 'missing-field', field } };
}

function errShape(field) {
  return { ok: false, error: { kind: 'invalid-shape', field } };
}

function errPricingDrift(detail) {
  return { ok: false, error: { kind: 'pricing-drift', detail } };
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Walk every finding bucket reachable from the public report shape and
 * return the first `detail` (or kind, when no detail is present) that
 * matches a pricing/drift kind. Returns `null` when no drift finding is
 * present. Buckets walked: top-level `findings`, `global.findings`, and
 * each per-session `findings` array. (R5.6 — fail on unusable fields.)
 *
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function detectPricingDrift(input) {
  const buckets = [];
  if (Array.isArray(input.findings)) {
    buckets.push(input.findings);
  }
  if (isObject(input.global) && Array.isArray(input.global.findings)) {
    buckets.push(input.global.findings);
  }
  if (Array.isArray(input.projects)) {
    for (const proj of input.projects) {
      if (!isObject(proj) || !Array.isArray(proj.sessions)) continue;
      for (const ses of proj.sessions) {
        if (isObject(ses) && Array.isArray(ses.findings)) {
          buckets.push(ses.findings);
        }
      }
    }
  }
  for (const bucket of buckets) {
    for (const finding of bucket) {
      if (!isObject(finding) || typeof finding.kind !== 'string') continue;
      if (PRICING_DRIFT_FINDING.test(finding.kind)) {
        return isNonEmptyString(finding.detail) ? finding.detail : finding.kind;
      }
    }
  }
  return null;
}

/**
 * Normalize a dispatch-cost node (either the global node or a session
 * node) into a `DispatchCostSummary`. Strips residual sentinel keys
 * (`unknown`, `null`, `''`) from the per-agent map and computes
 * `residualAgentTokens` as `total - Σ named-agent values`. Emits `null`
 * for the per-agent map when the upstream provides `null` or when every
 * key was a sentinel. Returns Result with a missing-field/invalid-shape
 * error otherwise.
 *
 * @param {Record<string, unknown>} node — the parent node carrying `cost`.
 * @param {string} basePath — dotted field path used in error messages.
 */
function normalizeDispatchSummary(node, basePath) {
  if (!hasOwn(node, 'cost')) {
    return errMissing(`${basePath}.cost`);
  }
  if (!isObject(node.cost)) {
    return errShape(`${basePath}.cost`);
  }
  const cost = node.cost;
  if (!hasOwn(cost, 'subagentDispatch')) {
    return errMissing(`${basePath}.cost.subagentDispatch`);
  }
  if (!isNonNegativeNumber(cost.subagentDispatch)) {
    return errShape(`${basePath}.cost.subagentDispatch`);
  }
  if (!hasOwn(cost, 'subagentDispatchByAgent')) {
    return errMissing(`${basePath}.cost.subagentDispatchByAgent`);
  }

  const total = cost.subagentDispatch;
  const rawMap = cost.subagentDispatchByAgent;

  if (rawMap === null) {
    return {
      ok: true,
      value: {
        subagentDispatchTokens: total,
        subagentDispatchByAgent: null,
        residualAgentTokens: total,
      },
    };
  }
  if (!isObject(rawMap)) {
    return errShape(`${basePath}.cost.subagentDispatchByAgent`);
  }

  const named = {};
  let namedSum = 0;
  for (const key of Object.keys(rawMap)) {
    const value = rawMap[key];
    if (!isNonNegativeNumber(value)) {
      return errShape(`${basePath}.cost.subagentDispatchByAgent.${key}`);
    }
    if (SENTINEL_AGENT_KEYS.has(key)) {
      continue;
    }
    named[key] = value;
    namedSum += value;
  }
  const hasNamed = Object.keys(named).length > 0;
  const residual = Math.max(0, total - namedSum);
  return {
    ok: true,
    value: {
      subagentDispatchTokens: total,
      subagentDispatchByAgent: hasNamed ? named : null,
      residualAgentTokens: residual,
    },
  };
}

/**
 * Parse a single session entry. Pins only the `sessionId`, `project`,
 * and `cost` fields and discards everything else (R5.7 — privacy
 * preservation). Returns Result with the per-session
 * `SessionCostSummary` on success.
 *
 * @param {unknown} ses
 * @param {string} basePath
 */
function parseSession(ses, basePath) {
  if (!isObject(ses)) {
    return errShape(basePath);
  }
  if (!hasOwn(ses, 'sessionId')) {
    return errMissing(`${basePath}.sessionId`);
  }
  if (!isNonEmptyString(ses.sessionId)) {
    return errShape(`${basePath}.sessionId`);
  }
  if (!hasOwn(ses, 'project')) {
    return errMissing(`${basePath}.project`);
  }
  if (ses.project !== null && typeof ses.project !== 'string') {
    return errShape(`${basePath}.project`);
  }
  const dispatch = normalizeDispatchSummary(ses, basePath);
  if (!dispatch.ok) return dispatch;
  return {
    ok: true,
    value: {
      sessionID: ses.sessionId,
      project: ses.project,
      subagentDispatchTokens: dispatch.value.subagentDispatchTokens,
      subagentDispatchByAgent: dispatch.value.subagentDispatchByAgent,
      residualAgentTokens: dispatch.value.residualAgentTokens,
    },
  };
}

/**
 * Defensively parse an `opencode-cost-report` v2 JSON payload into a
 * `CostReportSummary`. The adapter is read-only, never throws, and only
 * extracts the fields named in design.md's
 * `CostReportSummary` / `DispatchCostSummary` / `SessionCostSummary`
 * contracts (~ design.md:466-514).
 *
 * Error categories (design.md:505-508):
 *   - `missing-field` — a required field is absent
 *   - `invalid-shape` — a required field has the wrong type
 *   - `pricing-drift` — the report contains a finding indicating
 *                       pricing drift; surface upstream detail
 *
 * Requirements: 1.3, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 */
function parseReport(input) {
  if (!isObject(input)) {
    return errShape('report');
  }

  if (!hasOwn(input, 'privacy')) {
    return errMissing('privacy');
  }
  if (!isObject(input.privacy)) {
    return errShape('privacy');
  }

  // Gate pricing drift before downstream parsing so the operator sees
  // the actionable diagnostic reason instead of a derivative
  // missing-field error.
  const drift = detectPricingDrift(input);
  if (drift !== null) {
    return errPricingDrift(drift);
  }

  if (!hasOwn(input, 'global')) {
    return errMissing('global');
  }
  if (!isObject(input.global)) {
    return errShape('global');
  }
  const globalDispatch = normalizeDispatchSummary(input.global, 'global');
  if (!globalDispatch.ok) {
    return globalDispatch;
  }

  if (!hasOwn(input, 'projects')) {
    return errMissing('projects');
  }
  if (!Array.isArray(input.projects)) {
    return errShape('projects');
  }

  const sessions = [];
  for (let pi = 0; pi < input.projects.length; pi += 1) {
    const proj = input.projects[pi];
    const projPath = `projects[${pi}]`;
    if (!isObject(proj)) {
      return errShape(projPath);
    }
    if (!hasOwn(proj, 'sessions')) {
      return errMissing(`${projPath}.sessions`);
    }
    if (!Array.isArray(proj.sessions)) {
      return errShape(`${projPath}.sessions`);
    }
    for (let si = 0; si < proj.sessions.length; si += 1) {
      const sesPath = `${projPath}.sessions[${si}]`;
      const sesResult = parseSession(proj.sessions[si], sesPath);
      if (!sesResult.ok) return sesResult;
      sessions.push(sesResult.value);
    }
  }

  return {
    ok: true,
    value: {
      sessions,
      global: globalDispatch.value,
    },
  };
}

// ---------------------------------------------------------------------
// AuditReport (task 4.2)
//
// Combines budget metadata, baseline artifact, diagnostic usage, and
// observed tool data into deterministic JSON and Markdown audit
// reports. Per design.md `BudgetCLI` (~ lines 439-464), the report is
// JSON by default and Markdown via `--format markdown`; the Markdown
// is derived from the same object (design.md:625 — "Markdown is
// derived from the same object").
//
// Determinism: all object keys are emitted in alphabetical order via
// `stableSortKeys`. Arrays preserve construction order, which is also
// alphabetical for agent names and permission keys. No wall-clock
// timestamps are introduced.
//
// Per-tool observed data is a v2 future extension. The diagnostic's
// `subagentDispatchByAgent` map exposes per-agent *dispatch token*
// totals, not per-tool names. The audit report surfaces those token
// counts as `observedTools.tokenCount` and notes the v2 limitation in
// `observedToolsNote`. Agents not present in the map are marked
// `{kind: "absent"}` — never inferred (R1.4).
// ---------------------------------------------------------------------

/**
 * Recursively re-emit an object with alphabetically sorted keys.
 * Arrays preserve order. Primitives are returned unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stableSortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortKeys);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableSortKeys(value[key]);
  }
  return out;
}

function describePermissionAction(rule) {
  if (typeof rule === 'string') {
    return rule;
  }
  if (isObject(rule)) {
    // Sub-keyed permission objects (e.g. bash sub-rules); summarize.
    return 'object';
  }
  return 'unknown';
}

function buildAgentEntry(name, agent, observedByAgent, baselineMeasured) {
  const observed = observedByAgent !== null
    && isObject(observedByAgent)
    && Object.prototype.hasOwnProperty.call(observedByAgent, name)
    ? { kind: 'observed', tokenCount: observedByAgent[name] }
    : { kind: 'absent' };

  let baselineDelta;
  if (baselineMeasured.status === 'placeholder') {
    baselineDelta = { kind: 'baseline-placeholder' };
  } else {
    // Task 4.2 has no first-turn-tokens measurement source for
    // individual agents in the diagnostic; firstTurnInputTokens is
    // always null and so is deltaTokens. Future tasks add the
    // measurement source.
    const observedFirstTurn = null;
    baselineDelta = {
      kind: 'measured',
      baselineTokens: baselineMeasured.firstTurnInput,
      observedTokens: observedFirstTurn,
      deltaTokens: observedFirstTurn === null
        ? null
        : observedFirstTurn - baselineMeasured.firstTurnInput,
    };
  }

  const instructionContext = isNonEmptyString(agent.instructionProfile)
    ? { profile: agent.instructionProfile }
    : { profile: null };

  const permissions = isObject(agent.permissionBudget)
    ? Object.keys(agent.permissionBudget).sort().map((key) => ({
      key,
      action: describePermissionAction(agent.permissionBudget[key]),
    }))
    : [];

  return {
    name,
    source: agent.source,
    hostScope: agent.hostScope,
    state: { kind: agent.state.kind, reason: agent.state.reason },
    instructionContext,
    exposedToolContext: { permissions },
    observedTools: observed,
    baselineDelta,
    firstTurnInputTokens: null,
  };
}

/**
 * Build a deterministic audit report from validated budget metadata
 * and a parsed diagnostic. Validation is performed inline so the CLI
 * `main()` and tests can call this with raw parsed JSON.
 *
 * Requirements: 1.1 (enumerate every agent), 1.2 (first-turn tokens
 * or absent), 1.3 (observed-tool data), 1.4 (mark missing data
 * absent), 1.5 (separate dimensions), 4.2/4.3 (baseline delta), 7.3
 * (host-specific surfaces), 5.7 (privacy preservation).
 *
 * @param {unknown} metadata — parsed budget metadata JSON
 * @param {unknown} diagnostic — parsed diagnostic report JSON
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 */
function buildAuditReport(metadata, diagnostic) {
  const validation = validateBudgetMetadata(metadata);
  if (!validation.ok) {
    return {
      ok: false,
      error: { kind: 'invalid-metadata', errors: validation.errors },
    };
  }

  const parsed = parseReport(diagnostic);
  if (!parsed.ok) {
    return parsed;
  }

  const observedByAgent = parsed.value.global.subagentDispatchByAgent;
  const baselineMeasured = metadata.minimalBaseline.measuredTokens;

  const agentNames = Object.keys(metadata.agents).sort();
  const agents = agentNames.map((name) => buildAgentEntry(
    name,
    metadata.agents[name],
    observedByAgent,
    baselineMeasured,
  ));

  const enforcedCount = agents.filter((a) => a.state.kind === 'enforced').length;
  const unbudgetedCount = agents.filter((a) => a.state.kind === 'unbudgeted').length;
  const hostSpecificAgents = metadata.host === 'all'
    ? []
    : agents
      .filter((a) => a.hostScope !== 'all')
      .map((a) => a.name)
      .sort();

  const minimalBaseline = {
    name: metadata.minimalBaseline.name,
    measuredTokens: { ...baselineMeasured },
    instructionCategories: [...metadata.minimalBaseline.instructionCategories].sort(),
    allowedToolCategories: [...metadata.minimalBaseline.allowedToolCategories].sort(),
  };

  const report = {
    schemaVersion: 1,
    command: 'audit',
    host: metadata.host,
    enforcementEnabled: metadata.enforcementEnabled,
    minimalBaseline,
    agents,
    observedToolsNote: 'per-tool data not available in diagnostic v2; tokenCount is dispatch tokens',
    summary: {
      agentCount: agents.length,
      enforcedCount,
      unbudgetedCount,
      host: metadata.host,
      hostSpecificAgents,
    },
  };

  return { ok: true, value: stableSortKeys(report) };
}

/**
 * Deterministic JSON renderer. The report is already key-sorted by
 * `stableSortKeys`; `JSON.stringify` then preserves that order.
 *
 * @param {object} report
 * @returns {string}
 */
function renderAuditReportJson(report) {
  return JSON.stringify(report, null, 2);
}

function renderMarkdownTable(headerCells, rows) {
  const lines = [];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

function describeMeasuredTokens(tokens) {
  if (tokens.status === 'placeholder') {
    return 'placeholder (no measurement yet)';
  }
  return `${tokens.firstTurnInput} tokens (source: ${tokens.source || 'unknown'})`;
}

function describeObservedTools(observed) {
  if (observed.kind === 'absent') {
    return 'absent (no recent dispatch data)';
  }
  return `dispatch tokens: ${observed.tokenCount}`;
}

function describeBaselineDelta(delta) {
  if (delta.kind === 'baseline-placeholder') {
    return 'baseline-placeholder (no measured baseline)';
  }
  const obs = delta.observedTokens === null ? 'absent' : `${delta.observedTokens}`;
  const diff = delta.deltaTokens === null ? 'absent' : `${delta.deltaTokens}`;
  return `baseline ${delta.baselineTokens}, observed ${obs}, delta ${diff}`;
}

function describeFirstTurnTokens(value) {
  return value === null ? 'absent' : `${value}`;
}

/**
 * Deterministic Markdown renderer. Derived from the same audit-report
 * object as the JSON output, so byte stability follows from the JSON
 * stability. No timestamps or wall-clock fields appear.
 *
 * @param {object} report
 * @returns {string}
 */
function renderAuditReportMarkdown(report) {
  const sections = [];
  sections.push('# Subagent Context Budget — Audit Report');
  sections.push('');

  sections.push('## Overview');
  sections.push('');
  sections.push(`- Host: ${report.host}`);
  sections.push(`- Enforcement enabled: ${report.enforcementEnabled}`);
  sections.push(`- Agent count: ${report.summary.agentCount}`);
  sections.push(`- Enforced count: ${report.summary.enforcedCount}`);
  sections.push(`- Unbudgeted count: ${report.summary.unbudgetedCount}`);
  const hostSpecific = report.summary.hostSpecificAgents.length === 0
    ? '(none)'
    : report.summary.hostSpecificAgents.join(', ');
  sections.push(`- Host-specific agents: ${hostSpecific}`);
  sections.push('');

  sections.push('## Minimal read-only baseline');
  sections.push('');
  const baseline = report.minimalBaseline;
  sections.push(`- Name: ${baseline.name}`);
  sections.push(`- Measured tokens: ${describeMeasuredTokens(baseline.measuredTokens)}`);
  sections.push(`- Instruction categories: ${baseline.instructionCategories.join(', ')}`);
  sections.push(`- Allowed tool categories: ${baseline.allowedToolCategories.join(', ')}`);
  sections.push('');

  sections.push('## Agents');
  sections.push('');
  sections.push(`> Observed tools: ${report.observedToolsNote}`);
  sections.push('');

  for (const agent of report.agents) {
    sections.push(`### ${agent.name}`);
    sections.push('');
    sections.push(`- Source: ${agent.source}`);
    sections.push(`- Host scope: ${agent.hostScope}`);
    sections.push(`- State: ${agent.state.kind} (${agent.state.reason})`);
    sections.push('');

    sections.push('#### Instruction context');
    sections.push('');
    const profile = agent.instructionContext.profile === null
      ? 'absent (unbudgeted)'
      : agent.instructionContext.profile;
    sections.push(`- Profile: ${profile}`);
    sections.push('');

    sections.push('#### Exposed tool context');
    sections.push('');
    if (agent.exposedToolContext.permissions.length === 0) {
      sections.push('- (no permissions budgeted)');
    } else {
      sections.push(renderMarkdownTable(
        ['Permission', 'Action'],
        agent.exposedToolContext.permissions.map((p) => [p.key, p.action]),
      ));
    }
    sections.push('');

    sections.push('#### Observed tools');
    sections.push('');
    sections.push(`- ${describeObservedTools(agent.observedTools)}`);
    sections.push('');

    sections.push('#### Baseline delta');
    sections.push('');
    sections.push(`- ${describeBaselineDelta(agent.baselineDelta)}`);
    sections.push('');

    sections.push('#### First-turn input tokens');
    sections.push('');
    sections.push(`- ${describeFirstTurnTokens(agent.firstTurnInputTokens)}`);
    sections.push('');
  }

  return `${sections.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------

function parseAuditFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--metadata' || arg === '--diagnostic' || arg === '--format') {
      flags[arg.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return flags;
}

function formatValidationErrors(errors) {
  return errors
    .map((e) => `  - [${e.agent}] ${e.field}: ${e.message}`)
    .join('\n');
}

function runAuditCommand(rest) {
  const flags = parseAuditFlags(rest);
  if (!isNonEmptyString(flags.metadata)) {
    writeStderr('audit: missing required --metadata <path>\n');
    return 1;
  }
  if (!isNonEmptyString(flags.diagnostic)) {
    writeStderr('audit: missing required --diagnostic <path>\n');
    return 1;
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(flags.metadata, 'utf8'));
  } catch (err) {
    writeStderr(`audit: failed to read metadata file ${flags.metadata}: ${err.message}\n`);
    return 1;
  }

  let diagnostic;
  try {
    diagnostic = JSON.parse(fs.readFileSync(flags.diagnostic, 'utf8'));
  } catch (err) {
    writeStderr(`audit: failed to read diagnostic file ${flags.diagnostic}: ${err.message}\n`);
    return 1;
  }

  const result = buildAuditReport(metadata, diagnostic);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === 'invalid-metadata') {
      writeStderr(`audit: invalid-metadata\n${formatValidationErrors(error.errors)}\n`);
    } else if (error.kind === 'pricing-drift') {
      writeStderr(`audit: pricing-drift: ${error.detail}\n`);
    } else if (error.kind === 'missing-field') {
      writeStderr(`audit: missing-field in diagnostic: ${error.field}\n`);
    } else if (error.kind === 'invalid-shape') {
      writeStderr(`audit: invalid-shape in diagnostic: ${error.field}\n`);
    } else {
      writeStderr(`audit: ${JSON.stringify(error)}\n`);
    }
    return 1;
  }

  if (flags.format === 'markdown') {
    writeStdout(renderAuditReportMarkdown(result.value));
  } else {
    writeStdout(`${renderAuditReportJson(result.value)}\n`);
  }
  return 0;
}

function usage() {
  return [
    'Usage: subagent-context-budget <command> [options]',
    '',
    'Commands:',
    '  audit        Render an audit report from budget metadata and a diagnostic JSON',
    '  validate     Placeholder for baseline/post diagnostic validation reports',
    '  smoke-plan   Placeholder for agent smoke-plan report generation',
    '',
    'Options:',
    '  --metadata <path>        Rendered budget metadata JSON',
    '  --diagnostic <path>      Diagnostic report JSON for audit',
    '  --baseline <path>        Baseline diagnostic report JSON for validate',
    '  --post <path>            Post-change diagnostic report JSON for validate',
    '  --format <json|markdown> Output format; JSON is the default',
    '  --help, -h               Show this help text',
    '',
  ].join('\n');
}

function placeholderReport(command) {
  return {
    schemaVersion: 1,
    command,
    status: 'placeholder',
    next: [],
  };
}

function writeStdout(text) {
  process.stdout.write(text);
}

function writeStderr(text) {
  process.stderr.write(text);
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    writeStdout(usage());
    return 0;
  }

  if (!COMMANDS.includes(command)) {
    writeStderr(`unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  if (command === 'audit') {
    return runAuditCommand(args.slice(1));
  }

  writeStdout(`${JSON.stringify(placeholderReport(command), null, 2)}\n`);
  return 0;
}

module.exports = {
  COMMANDS,
  buildAuditReport,
  detectPricingDrift,
  main,
  normalizeDispatchSummary,
  parseReport,
  parseSession,
  placeholderReport,
  renderAuditReportJson,
  renderAuditReportMarkdown,
  stableSortKeys,
  usage,
  validateAgentBudget,
  validateBudgetMetadata,
  validateMinimalBaseline,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
