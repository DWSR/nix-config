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
const path = require('node:path');

const COMMANDS = Object.freeze(['audit', 'validate', 'smoke-plan']);
const SOURCES = Object.freeze(['builtin', 'common-markdown', 'host-markdown']);
const HOST_SCOPES = Object.freeze(['all', 'personal', 'shopify']);
const BASELINE_TOKEN_STATUSES = Object.freeze(['placeholder', 'measured']);
const FORBIDDEN_BASELINE_INSTRUCTION_CATEGORIES = Object.freeze(new Set([
  'host-specific',
  'project-specific',
  'personal',
  'shopify',
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
  'mcpproxy_code_execution',
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
const SMOKE_RESULT_STATUSES = Object.freeze(new Set(['pass', 'fail', 'skipped-unbudgeted']));
const SMOKE_FAILURE_CATEGORIES = Object.freeze(new Set([
  'denied-required-tool',
  'missing-instruction',
  'non-zero-command',
  'unspecified',
]));

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

function openCodeConfigShapeError(field, message) {
  return { field, message };
}

function validateOpenCodeConfigShape(renderedConfig) {
  const errors = [];

  if (!isObject(renderedConfig)) {
    return {
      ok: false,
      errors: [openCodeConfigShapeError('config', 'rendered OpenCode config shape must be an object')],
    };
  }

  const enforced = isObject(renderedConfig.enforced) ? renderedConfig.enforced : renderedConfig;
  const disabledRules = renderedConfig.disabledRules;
  const settings = enforced.settings;
  const agents = isObject(settings) ? settings.agent : undefined;
  const metadata = enforced.metadata;

  if (typeof enforced.rules !== 'string') {
    errors.push(openCodeConfigShapeError('enforced.rules', 'rendered OpenCode rules must be a string'));
  } else if (typeof disabledRules === 'string' && enforced.rules !== disabledRules) {
    errors.push(openCodeConfigShapeError('enforced.rules', 'budget enforcement must not change global OpenCode rules'));
  }

  if (enforced.pluginFilePresent !== true) {
    errors.push(openCodeConfigShapeError('enforced.pluginFilePresent', 'local subagent context budget plugin file must be rendered'));
  }

  if (!isObject(settings)) {
    errors.push(openCodeConfigShapeError('enforced.settings', 'rendered OpenCode settings must be an object'));
  }
  if (!isObject(agents)) {
    errors.push(openCodeConfigShapeError('settings.agent', 'rendered OpenCode settings.agent must be an object'));
  }
  if (!isObject(metadata) || !isObject(metadata.agents)) {
    errors.push(openCodeConfigShapeError('enforced.metadata', 'budget metadata with agents must be present'));
  }

  if (isObject(agents)) {
    for (const agentName of Object.keys(agents).sort()) {
      const agent = agents[agentName];
      if (!isObject(agent)) {
        errors.push(openCodeConfigShapeError(`settings.agent.${agentName}`, 'rendered agent override must be an object'));
        continue;
      }
      if (hasOwn(agent, 'tools')) {
        errors.push(openCodeConfigShapeError(`settings.agent.${agentName}.tools`, 'rendered agent override must not use deprecated tools allowlists'));
      }
      if (isObject(agent.permission) && hasOwn(agent.permission, 'tools')) {
        errors.push(openCodeConfigShapeError(`settings.agent.${agentName}.permission.tools`, 'rendered agent permission must not use deprecated tools allowlists'));
      }
    }
  }

  if (isObject(metadata) && isObject(metadata.agents) && isObject(agents)) {
    for (const agentName of Object.keys(metadata.agents).sort()) {
      const metadataAgent = metadata.agents[agentName];
      if (!isObject(metadataAgent) || !isObject(metadataAgent.state) || metadataAgent.state.kind !== 'enforced') {
        continue;
      }

      const agentOverride = agents[agentName];
      if (!isObject(agentOverride)) {
        errors.push(openCodeConfigShapeError(`settings.agent.${agentName}`, 'enforced budgeted agent must render an OpenCode agent override'));
        continue;
      }
      if (!isObject(agentOverride.permission)) {
        errors.push(openCodeConfigShapeError(`settings.agent.${agentName}.permission`, 'enforced budgeted agent permission must be an object'));
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { agentCount: Object.keys(agents).length } };
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
    errors.push(validationError(catalogName, 'hostScope', 'agent host scope must be all, personal, or shopify'));
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

      if (permissionKey === 'mcpproxy_code_execution' && agent.permissionBudget[permissionKey] !== 'deny') {
        errors.push(validationError(catalogName, `permissionBudget.${permissionKey}`, 'mcpproxy_code_execution must be denied'));
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
    errors.push(validationError('<metadata>', 'host', 'metadata host must be all or personal'));
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
  return {
    ok: false,
    error: {
      kind: 'missing-field',
      field,
      hint: diagnosticFieldHint(field),
    },
  };
}

function errShape(field) {
  return {
    ok: false,
    error: {
      kind: 'invalid-shape',
      field,
      hint: diagnosticFieldHint(field),
    },
  };
}

function errPricingDrift(detail) {
  return { ok: false, error: { kind: 'pricing-drift', detail } };
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function diagnosticFieldHint(field) {
  return {
    kind: 'missing-diagnostic-field',
    message: `Required diagnostic field ${field} is missing or unusable. Rerun opencode-cost-report --format json > "$REPORT"; if the field is still absent, check the report schema and use a supported opencode-cost-report version.`,
  };
}

function thresholdFailureHint() {
  return {
    kind: 'threshold-failure',
    message: 'Validation must meet the 40% target. Review audit output, widen or adjust per-agent budgets, run smoke plan, and recapture the post report from a comparable workload.',
  };
}

function pluginSelfCheckHint() {
  return {
    kind: 'plugin-self-check',
    message: 'Run subagent-context-budget-smoke-test, inspect opencode app logs for subagent-context-budget, and check plugin metadata/self-check status before claiming validation success.',
  };
}

function smokeFailureHint(agentName, failure) {
  const budgetCategory = failure.category === 'denied-required-tool'
    || failure.category === 'missing-instruction';
  if (!budgetCategory) {
    return null;
  }
  const capability = isNonEmptyString(failure.missingCapability)
    ? ` Missing capability: ${failure.missingCapability}.`
    : '';
  return {
    kind: 'insufficient-agent-budget',
    message: `Budget is insufficient for ${agentName}; widen that agent's permission or instruction profile, not the global budget.${capability}`,
  };
}

function residualAttributionHint() {
  return {
    kind: 'residual-heavy-attribution',
    message: 'Residual buckets are not credited to named agents. Rerun with diagnostics that include per-agent attribution before claiming agent-level success.',
  };
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

function flattenPermissionSurfaces(permissionBudget) {
  if (!isObject(permissionBudget)) {
    return [];
  }

  const surfaces = [];
  for (const key of Object.keys(permissionBudget).sort()) {
    const rule = permissionBudget[key];
    if (isObject(rule)) {
      for (const subKey of Object.keys(rule).sort()) {
        surfaces.push(`${key}.${subKey}`);
      }
    } else {
      surfaces.push(key);
    }
  }
  return surfaces;
}

function buildHostSpecificSurfaces(metadata, agentNames) {
  if (metadata.host === 'all') {
    return { agents: [], permissions: [] };
  }

  const agents = agentNames
    .filter((name) => metadata.agents[name].hostScope !== 'all')
    .map((name) => ({
      name,
      hostScope: metadata.agents[name].hostScope,
      permissions: flattenPermissionSurfaces(metadata.agents[name].permissionBudget),
    }));

  const permissions = [...new Set(agents.flatMap((agent) => agent.permissions))].sort();

  return { agents, permissions };
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
  const hostSpecificSurfaces = buildHostSpecificSurfaces(metadata, agentNames);

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
    hostSpecificSurfaces,
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
  const hostSpecificPermissions = report.hostSpecificSurfaces.permissions.length === 0
    ? '(none)'
    : report.hostSpecificSurfaces.permissions.join(', ');
  sections.push(`- Host-specific permission surfaces: ${hostSpecificPermissions}`);
  sections.push('');

  if (report.hostSpecificSurfaces.agents.length > 0) {
    sections.push('## Host-specific surfaces');
    sections.push('');
    sections.push(renderMarkdownTable(
      ['Agent', 'Host scope', 'Permission surfaces'],
      report.hostSpecificSurfaces.agents.map((agent) => [
        agent.name,
        agent.hostScope,
        agent.permissions.join(', '),
      ]),
    ));
    sections.push('');
  }

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
// ValidationComparator (task 4.3)
//
// Compares baseline and post-change CostReportSummary objects produced
// by `parseReport`. Enforces the ≥40% per-parent-session
// `subagentDispatch` reduction threshold (R5.4) and surfaces failure
// modes per design.md's `ValidationFailure` union (~ design.md:550).
//
// Residual handling (R5.5): the upstream `parseReport` already strips
// sentinel keys (`unknown`, `null`, `''`) from the per-agent map and
// folds them into `residualAgentTokens`. The comparator sums named-
// agent tokens across sessions for `byAgent` and sums per-session
// `residualAgentTokens` separately. Residual tokens are NEVER added
// to a named agent's reduction credit.
//
// Smoke-test and plugin self-check inputs (R6.4): optional. When
// supplied with a failing entry, the comparator appends the
// corresponding `ValidationFailure` and flips status to `fail`. When
// absent, no smoke or plugin failure is invented (smoke enforcement is
// task 5.3's responsibility).
//
// Determinism: report keys are alphabetised via `stableSortKeys`; no
// wall-clock or environment-dependent values appear.
// ---------------------------------------------------------------------

const VALIDATION_THRESHOLD_PCT = 40;

/**
 * Sum a CostReportSummary's per-session tokens and residual tokens,
 * and aggregate per-named-agent tokens across every session. The
 * upstream parser already discards residual sentinel keys, so the
 * map here only contains named agents.
 *
 * @param {{ sessions: Array<object> }} summary
 * @returns {{
 *   sessionCount: number,
 *   totalTokens: number,
 *   tokensPerParent: number,
 *   byAgent: Record<string, number>,
 *   residualTokens: number,
 * }}
 */
function aggregateSummary(summary) {
  const sessions = summary.sessions;
  const sessionCount = sessions.length;
  let totalTokens = 0;
  let residualTokens = 0;
  const byAgent = {};
  for (const ses of sessions) {
    totalTokens += ses.subagentDispatchTokens;
    residualTokens += ses.residualAgentTokens;
    if (ses.subagentDispatchByAgent !== null && isObject(ses.subagentDispatchByAgent)) {
      for (const [name, value] of Object.entries(ses.subagentDispatchByAgent)) {
        byAgent[name] = (byAgent[name] || 0) + value;
      }
    }
  }
  const tokensPerParent = sessionCount === 0 ? 0 : totalTokens / sessionCount;
  return {
    sessionCount,
    totalTokens,
    tokensPerParent,
    byAgent,
    residualTokens,
  };
}

/**
 * Compute the reduction percentage from baseline to post per parent.
 * Returns 0 when baseline is zero (the caller must already have
 * raised a missing-diagnostic-field failure for that case).
 *
 * @param {number} baseline
 * @param {number} post
 * @returns {number}
 */
function computeReductionPct(baseline, post) {
  if (baseline <= 0) return 0;
  return ((baseline - post) / baseline) * 100;
}

/**
 * Build the per-agent reduction map. Every agent appearing on either
 * side is reported; the absent side reports 0 tokens. Residual buckets
 * are excluded by construction (the parser strips sentinel keys
 * before tokens reach this stage).
 *
 * @param {Record<string, number>} baselineByAgent
 * @param {Record<string, number>} postByAgent
 * @returns {Record<string, { baselineTokens: number, postTokens: number, reductionPct: number }>}
 */
function buildAgentReductions(baselineByAgent, postByAgent) {
  const names = new Set([
    ...Object.keys(baselineByAgent),
    ...Object.keys(postByAgent),
  ]);
  const out = {};
  for (const name of [...names].sort()) {
    const baselineTokens = baselineByAgent[name] || 0;
    const postTokens = postByAgent[name] || 0;
    out[name] = {
      baselineTokens,
      postTokens,
      reductionPct: computeReductionPct(baselineTokens, postTokens),
    };
  }
  return out;
}

function smokeResultError(index, agentName, field, message) {
  return { resultIndex: index, agentName, field, message };
}

function detailForSmokeFailure(rawFailure) {
  if (isObject(rawFailure) && isNonEmptyString(rawFailure.detail)) {
    return rawFailure.detail;
  }
  return 'smoke test failed without structured evidence';
}

/**
 * Classify synthetic smoke-runner failure evidence into the categories
 * used by validation output. This is a pure data-layer helper; it does
 * not execute smoke tests.
 *
 * @param {unknown} rawFailure
 * @returns {{ category: string, detail: string, missingCapability?: string }}
 */
function classifySmokeFailure(rawFailure) {
  const failure = isObject(rawFailure) ? rawFailure : {};
  const evidence = isObject(failure.evidence) ? failure.evidence : {};
  const out = { category: 'unspecified', detail: detailForSmokeFailure(failure) };

  if (isNonEmptyString(evidence.missingTool)) {
    out.category = 'denied-required-tool';
    out.missingCapability = evidence.missingTool;
    return out;
  }
  if (isNonEmptyString(evidence.missingFragment)) {
    out.category = 'missing-instruction';
    out.missingCapability = evidence.missingFragment;
    return out;
  }
  if (Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0) {
    out.category = 'non-zero-command';
    return out;
  }

  return out;
}

function normalizeSmokeFailure(result) {
  const explicit = isObject(result) && isObject(result.failure) ? result.failure : null;
  const failure = explicit || classifySmokeFailure(result);
  const out = {};

  if (isNonEmptyString(failure.category)) {
    out.category = failure.category;
  }
  if (isNonEmptyString(failure.detail)) {
    out.detail = failure.detail;
  } else if (!explicit && isObject(result) && isNonEmptyString(result.detail)) {
    out.detail = result.detail;
  }
  if (isNonEmptyString(failure.missingCapability)) {
    out.missingCapability = failure.missingCapability;
  }

  return out;
}

function smokeDefinitionsByClass(catalog) {
  const definitions = Array.isArray(catalog && catalog.smokeDefinitions)
    ? catalog.smokeDefinitions
    : [];
  const out = new Map();
  for (const def of definitions) {
    if (isObject(def) && isNonEmptyString(def.class)) {
      out.set(def.class, def);
    }
  }
  return out;
}

/**
 * Validate and normalize synthetic per-agent smoke results from a smoke
 * runner. Cross-checks are intentionally limited to static metadata and
 * catalog data; live smoke execution belongs to a later task.
 *
 * @param {unknown} results
 * @param {unknown} catalog
 * @param {unknown} metadata
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array<object> }}
 */
function validateSmokeResults(results, catalog, metadata) {
  if (!Array.isArray(results)) {
    return {
      ok: false,
      errors: [smokeResultError(null, null, 'results', 'smoke results must be an array')],
    };
  }

  const errors = [];
  const normalized = [];
  const agents = isObject(metadata) && isObject(metadata.agents) ? metadata.agents : {};
  const classes = smokeDefinitionsByClass(catalog);

  results.forEach((result, index) => {
    if (!isObject(result)) {
      errors.push(smokeResultError(index, null, 'result', 'smoke result must be an object'));
      return;
    }

    const agentName = isNonEmptyString(result.agentName) ? result.agentName : null;
    const smokeClass = isNonEmptyString(result.class) ? result.class : null;
    const entry = {};

    if (!agentName) {
      errors.push(smokeResultError(index, null, 'agentName', 'smoke result must name an agent'));
    } else {
      entry.agentName = agentName;
      if (!isObject(agents[agentName])) {
        errors.push(smokeResultError(index, agentName, 'agentName', `agent ${agentName} not found in budget metadata`));
      }
    }

    if (!smokeClass) {
      errors.push(smokeResultError(index, agentName, 'class', 'smoke result must name a smoke class'));
    } else {
      entry.class = smokeClass;
      if (!classes.has(smokeClass)) {
        errors.push(smokeResultError(index, agentName, 'class', `smoke class ${smokeClass} not found in smoke catalog`));
      } else {
        const catalogDefinition = classes.get(smokeClass);
        if (
          agentName
          && isObject(catalogDefinition)
          && isNonEmptyString(catalogDefinition.agentName)
          && catalogDefinition.agentName !== agentName
        ) {
          errors.push(smokeResultError(index, agentName, 'class', `smoke class ${smokeClass} belongs to catalog agent ${catalogDefinition.agentName}, not result agent ${agentName}`));
        }
      }
    }

    const agent = agentName ? agents[agentName] : null;
    if (isObject(agent) && smokeClass && agent.smokeClass !== smokeClass) {
      errors.push(smokeResultError(index, agentName, 'class', `smoke class ${smokeClass} does not match smokeClass ${agent.smokeClass} declared for agent ${agentName}`));
    }

    if (!SMOKE_RESULT_STATUSES.has(result.status)) {
      errors.push(smokeResultError(index, agentName, 'status', 'status must be pass, fail, or skipped-unbudgeted'));
    } else {
      entry.status = result.status;
    }

    if (result.status === 'fail') {
      const failure = normalizeSmokeFailure(result);
      const hasExplicitFailureDetail = isNonEmptyString(result.detail)
        || (isObject(result.failure) && isNonEmptyString(result.failure.detail));
      if (!SMOKE_FAILURE_CATEGORIES.has(failure.category)) {
        errors.push(smokeResultError(index, agentName, 'failure.category', 'failure.category must be denied-required-tool, missing-instruction, non-zero-command, or unspecified'));
      }
      if (!hasExplicitFailureDetail) {
        errors.push(smokeResultError(index, agentName, 'failure.detail', 'failure.detail must be a non-empty string'));
      }
      entry.failure = failure;
    }

    if (result.status === 'skipped-unbudgeted') {
      const skip = isObject(result.skip) ? result.skip : {};
      if (skip.reason !== 'operator-escape-hatch') {
        errors.push(smokeResultError(index, agentName, 'skip.reason', 'skipped-unbudgeted requires skip.reason operator-escape-hatch'));
      }
      if (!isNonEmptyString(skip.explanation)) {
        errors.push(smokeResultError(index, agentName, 'skip.explanation', 'skipped-unbudgeted requires a non-empty skip.explanation'));
      }
      entry.skip = {
        reason: skip.reason,
        explanation: skip.explanation,
      };
    }

    normalized.push(entry);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  normalized.sort((a, b) => a.agentName.localeCompare(b.agentName));
  const summary = {
    resultCount: normalized.length,
    passCount: normalized.filter((result) => result.status === 'pass').length,
    failCount: normalized.filter((result) => result.status === 'fail').length,
    skippedUnbudgetedCount: normalized.filter((result) => result.status === 'skipped-unbudgeted').length,
  };

  return {
    ok: true,
    value: stableSortKeys({
      results: normalized,
      summary,
    }),
  };
}

/**
 * Compare baseline and post `CostReportSummary` objects and return a
 * deterministic `ValidationReport` per design.md (~ lines 530-554).
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.4.
 *
 * @param {{ sessions: Array<object>, global: object }} baseline
 * @param {{ sessions: Array<object>, global: object }} post
 * @param {{
 *   smokeResults?: Array<{ agentName: string, status: string, detail?: string }>,
 *   pluginSelfCheck?: { status: string, detail?: string },
 * }} [options]
 * @returns {object} a deterministic ValidationReport
 */
function compareReports(baseline, post, options) {
  const opts = isObject(options) ? options : {};

  const baselineAgg = aggregateSummary(baseline);
  const postAgg = aggregateSummary(post);

  const failures = [];

  // R5.6: missing-diagnostic-field surfaces empty sessions on either side
  // and zero-baseline tokens (no comparison anchor).
  if (baselineAgg.sessionCount === 0) {
    failures.push({
      kind: 'missing-diagnostic-field',
      field: 'baseline.sessions',
      hint: diagnosticFieldHint('baseline.sessions'),
    });
  }
  if (postAgg.sessionCount === 0) {
    failures.push({
      kind: 'missing-diagnostic-field',
      field: 'post.sessions',
      hint: diagnosticFieldHint('post.sessions'),
    });
  }
  if (baselineAgg.sessionCount > 0 && baselineAgg.tokensPerParent === 0) {
    failures.push({
      kind: 'missing-diagnostic-field',
      field: 'baseline.subagentDispatch',
      hint: diagnosticFieldHint('baseline.subagentDispatch'),
    });
  }

  const reductionPct = computeReductionPct(
    baselineAgg.tokensPerParent,
    postAgg.tokensPerParent,
  );

  // R5.4: threshold enforcement only meaningful when baseline anchor exists.
  const baselineUsable = baselineAgg.sessionCount > 0 && baselineAgg.tokensPerParent > 0;
  const postUsable = postAgg.sessionCount > 0;
  if (baselineUsable && postUsable && reductionPct < VALIDATION_THRESHOLD_PCT) {
    failures.push({
      kind: 'threshold-not-met',
      actualPct: reductionPct,
      requiredPct: VALIDATION_THRESHOLD_PCT,
      hint: thresholdFailureHint(),
    });
  }

  // R6.4: surface smoke failures when caller supplied them.
  if (Array.isArray(opts.smokeResults)) {
    const sorted = [...opts.smokeResults].sort((a, b) => {
      const an = isObject(a) && isNonEmptyString(a.agentName) ? a.agentName : '';
      const bn = isObject(b) && isNonEmptyString(b.agentName) ? b.agentName : '';
      return an.localeCompare(bn);
    });
    for (const result of sorted) {
      if (isObject(result) && result.status === 'fail' && isNonEmptyString(result.agentName)) {
        const failure = normalizeSmokeFailure(result);
        const smokeFailure = { kind: 'smoke-failure', agentName: result.agentName };
        if (isNonEmptyString(failure.category)) {
          smokeFailure.category = failure.category;
        }
        if (isNonEmptyString(failure.detail)) {
          smokeFailure.detail = failure.detail;
        }
        if (isNonEmptyString(failure.missingCapability)) {
          smokeFailure.missingCapability = failure.missingCapability;
        }
        const hint = smokeFailureHint(result.agentName, failure);
        if (hint !== null) {
          smokeFailure.hint = hint;
        }
        failures.push(smokeFailure);
      }
    }
  }

  // Plugin self-check surfacing (wired by task 6.1; comparator only
  // forwards the structured input here).
  if (isObject(opts.pluginSelfCheck) && opts.pluginSelfCheck.status === 'failed') {
    failures.push({
      kind: 'plugin-self-check-failed',
      detail: isNonEmptyString(opts.pluginSelfCheck.detail)
        ? opts.pluginSelfCheck.detail
        : 'plugin self-check failed',
      hint: pluginSelfCheckHint(),
    });
  }

  const byAgent = buildAgentReductions(baselineAgg.byAgent, postAgg.byAgent);
  const postNamedAgentTokens = Object.values(postAgg.byAgent).reduce((sum, value) => sum + value, 0);
  const residualHeavy = postAgg.residualTokens > postNamedAgentTokens
    || (postAgg.residualTokens > 0 && Object.keys(postAgg.byAgent).length === 0);
  const hints = residualHeavy ? [residualAttributionHint()] : [];

  const report = {
    schemaVersion: 1,
    command: 'validate',
    status: failures.length === 0 ? 'pass' : 'fail',
    reductionPct,
    requiredReductionPct: VALIDATION_THRESHOLD_PCT,
    baselineTokensPerParent: baselineAgg.tokensPerParent,
    postTokensPerParent: postAgg.tokensPerParent,
    baselineSessionCount: baselineAgg.sessionCount,
    postSessionCount: postAgg.sessionCount,
    byAgent,
    residualAgentTokens: postAgg.residualTokens,
    baselineResidualAgentTokens: baselineAgg.residualTokens,
    failures,
    hints,
  };

  return stableSortKeys(report);
}

function buildValidationReport(baseline, post, options) {
  return compareReports(baseline, post, options);
}

/**
 * Deterministic JSON renderer for ValidationReport (mirrors
 * `renderAuditReportJson` — keys are already sorted, so
 * `JSON.stringify` preserves order).
 *
 * @param {object} report
 * @returns {string}
 */
function renderValidationReportJson(report) {
  return JSON.stringify(report, null, 2);
}

function describeFailure(failure) {
  switch (failure.kind) {
    case 'threshold-not-met':
      return `threshold-not-met: actual ${failure.actualPct.toFixed(2)}% < required ${failure.requiredPct}%`;
    case 'missing-diagnostic-field':
      return `missing-diagnostic-field: ${failure.field}`;
    case 'smoke-failure':
      return [
        `smoke-failure: ${failure.agentName}`,
        isNonEmptyString(failure.category) ? `category=${failure.category}` : null,
        isNonEmptyString(failure.missingCapability) ? `missingCapability=${failure.missingCapability}` : null,
        isNonEmptyString(failure.detail) ? `detail=${failure.detail}` : null,
      ].filter(Boolean).join(' ');
    case 'plugin-self-check-failed':
      return `plugin-self-check-failed: ${failure.detail}`;
    default:
      return JSON.stringify(failure);
  }
}

function describeHint(hint) {
  if (!isObject(hint) || !isNonEmptyString(hint.message)) {
    return null;
  }
  return hint.message;
}

/**
 * Deterministic Markdown renderer. Derived from the same
 * ValidationReport object as the JSON output. No timestamps or
 * wall-clock fields appear.
 *
 * @param {object} report
 * @returns {string}
 */
function renderValidationReportMarkdown(report) {
  const lines = [];
  lines.push('# Subagent Context Budget — Validation Report');
  lines.push('');

  lines.push('## Overview');
  lines.push('');
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Reduction: ${report.reductionPct.toFixed(2)}% (required: ${report.requiredReductionPct}%)`);
  lines.push(`- Baseline tokens / parent session: ${report.baselineTokensPerParent}`);
  lines.push(`- Post tokens / parent session: ${report.postTokensPerParent}`);
  lines.push(`- Baseline session count: ${report.baselineSessionCount}`);
  lines.push(`- Post session count: ${report.postSessionCount}`);
  lines.push(`- Residual tokens (post): ${report.residualAgentTokens}`);
  lines.push(`- Residual tokens (baseline): ${report.baselineResidualAgentTokens}`);
  lines.push('');

  if (Array.isArray(report.hints) && report.hints.length > 0) {
    lines.push('## Hints');
    lines.push('');
    for (const hint of report.hints) {
      const message = describeHint(hint);
      if (message !== null) {
        lines.push(`- ${message}`);
      }
    }
    lines.push('');
  }

  lines.push('## Per-agent reduction');
  lines.push('');
  const agentNames = Object.keys(report.byAgent).sort();
  if (agentNames.length === 0) {
    lines.push('- (no named agents found in either report)');
  } else {
    lines.push(renderMarkdownTable(
      ['Agent', 'Baseline tokens', 'Post tokens', 'Reduction %'],
      agentNames.map((name) => {
        const entry = report.byAgent[name];
        return [
          name,
          String(entry.baselineTokens),
          String(entry.postTokens),
          entry.reductionPct.toFixed(2),
        ];
      }),
    ));
  }
  lines.push('');

  lines.push('## Failures');
  lines.push('');
  if (report.failures.length === 0) {
    lines.push('- (none)');
  } else {
    for (const failure of report.failures) {
      lines.push(`- ${describeFailure(failure)}`);
      const hintMessage = describeHint(failure.hint);
      if (hintMessage !== null) {
        lines.push(`  - Hint: ${hintMessage}`);
      }
    }
  }
  lines.push('');

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
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

function formatCliHint(error) {
  const message = describeHint(error && error.hint);
  return message === null ? '' : ` Hint: ${message}`;
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
      writeStderr(`audit: missing-field in diagnostic: ${error.field}.${formatCliHint(error)}\n`);
    } else if (error.kind === 'invalid-shape') {
      writeStderr(`audit: invalid-shape in diagnostic: ${error.field}.${formatCliHint(error)}\n`);
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

function parseValidateFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (
      arg === '--baseline'
      || arg === '--post'
      || arg === '--metadata'
      || arg === '--format'
    ) {
      flags[arg.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return flags;
}

function runValidateCommand(rest) {
  const flags = parseValidateFlags(rest);
  if (!isNonEmptyString(flags.baseline)) {
    writeStderr('validate: missing required --baseline <path>\n');
    return 1;
  }
  if (!isNonEmptyString(flags.post)) {
    writeStderr('validate: missing required --post <path>\n');
    return 1;
  }

  let baselineJson;
  try {
    baselineJson = JSON.parse(fs.readFileSync(flags.baseline, 'utf8'));
  } catch (err) {
    writeStderr(`validate: failed to read baseline file ${flags.baseline}: ${err.message}\n`);
    return 1;
  }

  let postJson;
  try {
    postJson = JSON.parse(fs.readFileSync(flags.post, 'utf8'));
  } catch (err) {
    writeStderr(`validate: failed to read post file ${flags.post}: ${err.message}\n`);
    return 1;
  }

  // The optional --metadata flag is reserved for richer rendering /
  // per-agent labels in a future patch; reading it now lets the
  // operator pass it without a CLI error. Validation against
  // `validateBudgetMetadata` ensures bad metadata still surfaces.
  if (isNonEmptyString(flags.metadata)) {
    let metadataJson;
    try {
      metadataJson = JSON.parse(fs.readFileSync(flags.metadata, 'utf8'));
    } catch (err) {
      writeStderr(`validate: failed to read metadata file ${flags.metadata}: ${err.message}\n`);
      return 1;
    }
    const metadataValidation = validateBudgetMetadata(metadataJson);
    if (!metadataValidation.ok) {
      writeStderr(`validate: invalid-metadata\n${formatValidationErrors(metadataValidation.errors)}\n`);
      return 1;
    }
  }

  const baselineParsed = parseReport(baselineJson);
  if (!baselineParsed.ok) {
    const e = baselineParsed.error;
    if (e.kind === 'pricing-drift') {
      writeStderr(`validate: pricing-drift in baseline: ${e.detail}\n`);
    } else if (e.kind === 'missing-field') {
      writeStderr(`validate: missing-field in baseline: ${e.field}.${formatCliHint(e)}\n`);
    } else if (e.kind === 'invalid-shape') {
      writeStderr(`validate: invalid-shape in baseline: ${e.field}.${formatCliHint(e)}\n`);
    } else {
      writeStderr(`validate: ${JSON.stringify(e)}\n`);
    }
    return 1;
  }

  const postParsed = parseReport(postJson);
  if (!postParsed.ok) {
    const e = postParsed.error;
    if (e.kind === 'pricing-drift') {
      writeStderr(`validate: pricing-drift in post: ${e.detail}\n`);
    } else if (e.kind === 'missing-field') {
      writeStderr(`validate: missing-field in post: ${e.field}.${formatCliHint(e)}\n`);
    } else if (e.kind === 'invalid-shape') {
      writeStderr(`validate: invalid-shape in post: ${e.field}.${formatCliHint(e)}\n`);
    } else {
      writeStderr(`validate: ${JSON.stringify(e)}\n`);
    }
    return 1;
  }

  const report = compareReports(baselineParsed.value, postParsed.value);

  if (flags.format === 'markdown') {
    writeStdout(renderValidationReportMarkdown(report));
  } else {
    writeStdout(`${renderValidationReportJson(report)}\n`);
  }
  return report.status === 'pass' ? 0 : 1;
}

function usage() {
  return [
    'Usage: subagent-context-budget <command> [options]',
    '',
    'Commands:',
    '  audit        Render an audit report from budget metadata and a diagnostic JSON',
    '  validate     Compare baseline and post diagnostic reports and render a validation report',
    '  smoke-plan   Generate a per-agent smoke plan from budget metadata and the smoke catalog',
    '',
    'Options:',
    '  --metadata <path>        Rendered budget metadata JSON',
    '  --diagnostic <path>      Diagnostic report JSON for audit',
    '  --baseline <path>        Baseline diagnostic report JSON for validate',
    '  --post <path>            Post-change diagnostic report JSON for validate',
    '  --smoke-catalog <path>   Smoke-test catalog JSON for smoke-plan',
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

  if (command === 'validate') {
    return runValidateCommand(args.slice(1));
  }

  if (command === 'smoke-plan') {
    return runSmokePlanCommand(args.slice(1));
  }

  writeStdout(`${JSON.stringify(placeholderReport(command), null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------
// SmokeTestRunner catalog (task 5.1)
//
// Loads and validates the per-agent smoke-test catalog at
// `home-manager/common/subagent-context-budget/smoke-catalog.json`.
// Task 5.1 owns the data + schema; the runner itself is built in
// tasks 5.2 (plan), 5.3 (result handling), and 5.4 (Nix smoke
// wrapper).
//
// Requirements: 6.1 (smoke per agent), 6.2 (representative tasks),
// 6.5 (preserve direct invocation), 7.2 (host parity).
// ---------------------------------------------------------------------

const SMOKE_HOST_SCOPES = Object.freeze(new Set(HOST_SCOPES));
const SMOKE_NONINTERACTIVE_STRATEGIES = Object.freeze(new Set([
  'allow-only',
  'auto-allow-ask',
  'task-restricts-ask',
]));

function smokeError(definitionIndex, field, message) {
  return { definitionIndex, field, message };
}

function validateSmokeDefinition(index, def) {
  const errors = [];
  if (!isObject(def)) {
    return [smokeError(index, 'definition', 'smoke definition must be an object')];
  }

  if (!isNonEmptyString(def.class)) {
    errors.push(smokeError(index, 'class', 'smoke definition must define a non-empty class'));
  }
  if (!isNonEmptyString(def.agentName)) {
    errors.push(smokeError(index, 'agentName', 'smoke definition must define a non-empty agentName'));
  }
  if (!SMOKE_HOST_SCOPES.has(def.hostScope)) {
    errors.push(smokeError(index, 'hostScope', 'hostScope must be all or personal'));
  }
  if (!isNonEmptyString(def.representativeTask)) {
    errors.push(smokeError(index, 'representativeTask', 'representativeTask must be a non-empty string'));
  }

  if (!isObject(def.expectations)) {
    errors.push(smokeError(index, 'expectations', 'expectations must be an object'));
  } else {
    if (!Array.isArray(def.expectations.passCriteria) || def.expectations.passCriteria.length === 0
      || !def.expectations.passCriteria.every(isNonEmptyString)) {
      errors.push(smokeError(index, 'expectations.passCriteria', 'expectations.passCriteria must be a non-empty array of non-empty strings'));
    }
    if (!Array.isArray(def.expectations.failureSignals) || def.expectations.failureSignals.length === 0
      || !def.expectations.failureSignals.every(isNonEmptyString)) {
      errors.push(smokeError(index, 'expectations.failureSignals', 'expectations.failureSignals must be a non-empty array of non-empty strings'));
    }
    if (!isNonEmptyString(def.expectations.skippedUnbudgeted)) {
      errors.push(smokeError(index, 'expectations.skippedUnbudgeted', 'expectations.skippedUnbudgeted must be a non-empty string'));
    }
  }

  if (!isObject(def.nonInteractive)) {
    errors.push(smokeError(index, 'nonInteractive', 'nonInteractive must be an object'));
  } else {
    if (!SMOKE_NONINTERACTIVE_STRATEGIES.has(def.nonInteractive.strategy)) {
      errors.push(smokeError(
        index,
        'nonInteractive.strategy',
        'nonInteractive.strategy must be allow-only, auto-allow-ask, or task-restricts-ask',
      ));
    }
    if (!isNonEmptyString(def.nonInteractive.details)) {
      errors.push(smokeError(index, 'nonInteractive.details', 'nonInteractive.details must be a non-empty string'));
    }
  }

  if (!isNonEmptyString(def.directInvocation)) {
    errors.push(smokeError(index, 'directInvocation', 'directInvocation must be a non-empty string'));
  } else if (isNonEmptyString(def.agentName) && !def.directInvocation.includes(def.agentName)) {
    errors.push(smokeError(index, 'directInvocation', `directInvocation must mention agentName ${def.agentName}`));
  }

  if (hasOwn(def, 'notes') && def.notes !== null && typeof def.notes !== 'string') {
    errors.push(smokeError(index, 'notes', 'notes, when present, must be a string or null'));
  }

  return errors;
}

/**
 * Validate a smoke catalog object. Performs schema validation by
 * default, and optional cross-checks against a budget metadata object
 * when `options.budgetMetadata` is supplied.
 *
 * Catalog-level checks:
 *   - schemaVersion must be 1
 *   - smokeDefinitions must be an array
 *   - definitions must be alphabetised by class (deterministic order
 *     when serialised, per design.md `SmokeTestRunner`)
 *   - no duplicate `class` entries
 *
 * Cross-check (when budgetMetadata is provided):
 *   - every smoke `agentName` must appear in budgetMetadata.agents
 *   - the budgeted agent's smokeClass must equal the smoke `class`
 *   - the budgeted agent's hostScope must equal the smoke `hostScope`
 *
 * Returns `{ ok: true, value: { definitionCount, classes, agentNames } }`
 * on success, `{ ok: false, errors: [...] }` on failure.
 *
 * Requirements: 6.1, 6.2, 6.5, 7.2.
 *
 * @param {unknown} catalog
 * @param {{ budgetMetadata?: object }} [options]
 */
function validateSmokeCatalog(catalog, options) {
  const errors = [];

  if (!isObject(catalog)) {
    return { ok: false, errors: [{ definitionIndex: null, field: 'catalog', message: 'catalog must be an object' }] };
  }

  if (catalog.schemaVersion !== 1) {
    errors.push({ definitionIndex: null, field: 'schemaVersion', message: 'schemaVersion must be 1' });
  }

  if (!Array.isArray(catalog.smokeDefinitions)) {
    errors.push({ definitionIndex: null, field: 'smokeDefinitions', message: 'smokeDefinitions must be an array' });
    return { ok: false, errors };
  }

  const definitions = catalog.smokeDefinitions;
  const seenClasses = new Map(); // class -> first index seen

  definitions.forEach((def, index) => {
    errors.push(...validateSmokeDefinition(index, def));

    if (isObject(def) && isNonEmptyString(def.class)) {
      if (seenClasses.has(def.class)) {
        errors.push({
          definitionIndex: index,
          field: 'class',
          message: `duplicate class ${def.class} also at index ${seenClasses.get(def.class)}`,
        });
      } else {
        seenClasses.set(def.class, index);
      }
    }
  });

  // Determinism: definitions must be alphabetised by class.
  const orderedClasses = definitions
    .filter((d) => isObject(d) && isNonEmptyString(d.class))
    .map((d) => d.class);
  const sortedClasses = [...orderedClasses].sort();
  for (let i = 0; i < orderedClasses.length; i += 1) {
    if (orderedClasses[i] !== sortedClasses[i]) {
      errors.push({
        definitionIndex: i,
        field: 'class',
        message: `smoke definitions must be alphabetically sorted by class; expected ${sortedClasses[i]} at index ${i}, got ${orderedClasses[i]}`,
      });
      break;
    }
  }

  // Cross-check against budget metadata when supplied.
  const budgetMetadata = options && isObject(options.budgetMetadata) ? options.budgetMetadata : null;
  if (budgetMetadata) {
    const agents = isObject(budgetMetadata.agents) ? budgetMetadata.agents : {};
    definitions.forEach((def, index) => {
      if (!isObject(def)) return;
      if (!isNonEmptyString(def.agentName)) return;
      const agent = agents[def.agentName];
      if (!isObject(agent)) {
        errors.push({
          definitionIndex: index,
          field: 'agentName',
          message: `agentName ${def.agentName} not found in budget metadata agents`,
        });
        return;
      }
      if (isNonEmptyString(def.class) && agent.smokeClass !== def.class) {
        errors.push({
          definitionIndex: index,
          field: 'class',
          message: `smoke class ${def.class} does not match smokeClass ${agent.smokeClass} declared for agent ${def.agentName} in budget metadata`,
        });
      }
      if (isNonEmptyString(def.hostScope) && agent.hostScope !== def.hostScope) {
        errors.push({
          definitionIndex: index,
          field: 'hostScope',
          message: `smoke hostScope ${def.hostScope} does not match agent ${def.agentName} hostScope ${agent.hostScope} in budget metadata`,
        });
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const classes = definitions.map((d) => d.class);
  const agentNames = definitions.map((d) => d.agentName);
  return {
    ok: true,
    value: {
      definitionCount: definitions.length,
      classes,
      agentNames,
    },
  };
}

/**
 * Read and validate a smoke catalog file. Returns
 * `{ ok: true, value: { ...catalog, definitionCount, classes, agentNames } }`
 * on success, `{ ok: false, error: { kind, message } }` on filesystem
 * or JSON errors, or `{ ok: false, errors: [...] }` on schema errors.
 *
 * Optional `options.budgetMetadata` triggers the same cross-check as
 * `validateSmokeCatalog`.
 *
 * @param {string} filePath
 * @param {{ budgetMetadata?: object }} [options]
 */
function loadSmokeCatalog(filePath, options) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: err.code === 'ENOENT' ? 'not-found' : 'read-error',
        message: `failed to read smoke catalog ${filePath}: ${err.message}`,
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'invalid-json',
        message: `failed to parse smoke catalog ${filePath}: ${err.message}`,
      },
    };
  }

  const validation = validateSmokeCatalog(parsed, options);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: {
      schemaVersion: parsed.schemaVersion,
      smokeDefinitions: parsed.smokeDefinitions,
      definitionCount: validation.value.definitionCount,
      classes: validation.value.classes,
      agentNames: validation.value.agentNames,
    },
  };
}

// ---------------------------------------------------------------------
// SmokePlan report (task 5.2)
//
// Builds a deterministic per-agent smoke plan by joining validated
// budget metadata with the smoke-test catalog. Each enforced agent
// gains a full smoke entry (representative task, expectations,
// non-interactive strategy, direct-invocation example — R6.5). Each
// unbudgeted (escape-hatch) agent gains a `skipped-unbudgeted` entry
// that names the agent + host scope and cites the escape hatch
// reason (R7.5). Catalog entries whose agent is not present in the
// metadata are silently ignored (metadata defines scope).
//
// Cross-check semantics: every enforced agent in metadata MUST have
// a matching smoke definition in the catalog (matched by agentName)
// AND the metadata's `smokeClass` MUST equal the catalog's `class`
// (R6.1). The unbudgeted case never requires a catalog match —
// rolled-back agents stay unchanged (R7.5).
//
// Determinism: entries are sorted alphabetically by agentName via
// `stableSortKeys`. No wall-clock or environment-dependent values.
// ---------------------------------------------------------------------

const DEFAULT_SMOKE_CATALOG_PATH = path.join(
  __dirname,
  '..',
  'home-manager',
  'common',
  'subagent-context-budget',
  'smoke-catalog.json',
);

const ESCAPE_HATCH_EXPLANATION = (
  'agent is unbudgeted via the operator escape hatch; budget '
  + 'enforcement is disabled and the agent retains its pre-budget '
  + 'permission and instruction context. Smoke runner emits '
  + 'skipped-unbudgeted without invoking the agent.'
);

function buildEnforcedEntry(agentName, agent, definition) {
  return {
    agentName,
    hostScope: agent.hostScope,
    state: 'enforced',
    smoke: {
      class: definition.class,
      representativeTask: definition.representativeTask,
      expectations: {
        passCriteria: [...definition.expectations.passCriteria],
        failureSignals: [...definition.expectations.failureSignals],
        skippedUnbudgeted: definition.expectations.skippedUnbudgeted,
      },
      nonInteractive: {
        strategy: definition.nonInteractive.strategy,
        details: definition.nonInteractive.details,
      },
      directInvocation: definition.directInvocation,
    },
  };
}

function buildSkippedEntry(agentName, agent) {
  return {
    agentName,
    hostScope: agent.hostScope,
    state: 'skipped-unbudgeted',
    skip: {
      reason: agent.state.reason,
      explanation: ESCAPE_HATCH_EXPLANATION,
    },
  };
}

/**
 * Build a deterministic smoke plan from validated budget metadata and
 * a validated smoke catalog.
 *
 * Requirements: 6.1 (smoke entry per enforced agent), 6.5 (preserve
 * direct invocation), 7.5 (skipped-unbudgeted state for disabled
 * agents).
 *
 * Errors:
 *   - `invalid-metadata`: metadata failed `validateBudgetMetadata`.
 *   - `invalid-catalog`: catalog failed `validateSmokeCatalog`.
 *   - `missing-smoke-definition`: enforced agent has no catalog match.
 *   - `smoke-class-mismatch`: enforced agent and catalog class disagree.
 *
 * @param {unknown} metadata — parsed budget metadata JSON
 * @param {unknown} catalog — parsed smoke catalog JSON
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 */
function buildSmokePlan(metadata, catalog) {
  const metadataValidation = validateBudgetMetadata(metadata);
  if (!metadataValidation.ok) {
    return {
      ok: false,
      error: { kind: 'invalid-metadata', errors: metadataValidation.errors },
    };
  }

  const catalogValidation = validateSmokeCatalog(catalog);
  if (!catalogValidation.ok) {
    return {
      ok: false,
      error: { kind: 'invalid-catalog', errors: catalogValidation.errors },
    };
  }

  const definitionsByAgent = {};
  for (const def of catalog.smokeDefinitions) {
    definitionsByAgent[def.agentName] = def;
  }

  const entries = [];
  let enforcedCount = 0;
  let skippedUnbudgetedCount = 0;

  for (const agentName of Object.keys(metadata.agents).sort()) {
    const agent = metadata.agents[agentName];

    if (agent.state.kind === 'unbudgeted') {
      entries.push(buildSkippedEntry(agentName, agent));
      skippedUnbudgetedCount += 1;
      continue;
    }

    // Enforced agent: must have a catalog match by agentName, and the
    // catalog class must equal the metadata smokeClass.
    const definition = definitionsByAgent[agentName];
    if (!definition) {
      return {
        ok: false,
        error: {
          kind: 'missing-smoke-definition',
          agentName,
          message: `enforced agent ${agentName} has no matching smoke definition in the catalog`,
        },
      };
    }
    if (definition.class !== agent.smokeClass) {
      return {
        ok: false,
        error: {
          kind: 'smoke-class-mismatch',
          agentName,
          expectedClass: agent.smokeClass,
          actualClass: definition.class,
          message: `enforced agent ${agentName} smokeClass ${agent.smokeClass} does not match catalog class ${definition.class}`,
        },
      };
    }

    entries.push(buildEnforcedEntry(agentName, agent, definition));
    enforcedCount += 1;
  }

  const plan = {
    schemaVersion: 1,
    command: 'smoke-plan',
    host: metadata.host,
    summary: {
      agentCount: entries.length,
      enforcedCount,
      skippedUnbudgetedCount,
    },
    entries,
  };

  return { ok: true, value: stableSortKeys(plan) };
}

/**
 * Deterministic JSON renderer. The plan is already key-sorted by
 * `stableSortKeys`; `JSON.stringify` then preserves that order.
 *
 * @param {object} plan
 * @returns {string}
 */
function renderSmokePlanJson(plan) {
  return JSON.stringify(plan, null, 2);
}

/**
 * Deterministic Markdown renderer. Derived from the same plan object
 * as the JSON output, so byte stability follows from the JSON
 * stability. No timestamps or wall-clock fields appear.
 *
 * @param {object} plan
 * @returns {string}
 */
function renderSmokePlanMarkdown(plan) {
  const lines = [];
  lines.push('# Subagent Context Budget — Smoke Plan');
  lines.push('');

  lines.push('## Overview');
  lines.push('');
  lines.push(`- Host: ${plan.host}`);
  lines.push(`- Agent count: ${plan.summary.agentCount}`);
  lines.push(`- Enforced count: ${plan.summary.enforcedCount}`);
  lines.push(`- Skipped (unbudgeted) count: ${plan.summary.skippedUnbudgetedCount}`);
  lines.push('');

  lines.push('## Agents');
  lines.push('');

  for (const entry of plan.entries) {
    lines.push(`### ${entry.agentName}`);
    lines.push('');
    lines.push(`- Host scope: ${entry.hostScope}`);
    lines.push(`- State: ${entry.state}`);
    lines.push('');

    if (entry.state === 'enforced') {
      lines.push('#### Smoke definition');
      lines.push('');
      lines.push(`- Class: ${entry.smoke.class}`);
      lines.push(`- Representative task: ${entry.smoke.representativeTask}`);
      lines.push(`- Non-interactive strategy: ${entry.smoke.nonInteractive.strategy}`);
      lines.push(`- Non-interactive details: ${entry.smoke.nonInteractive.details}`);
      lines.push('');

      lines.push('##### Pass criteria');
      lines.push('');
      for (const item of entry.smoke.expectations.passCriteria) {
        lines.push(`- ${item}`);
      }
      lines.push('');

      lines.push('##### Failure signals');
      lines.push('');
      for (const item of entry.smoke.expectations.failureSignals) {
        lines.push(`- ${item}`);
      }
      lines.push('');

      lines.push('##### Skipped-unbudgeted expectation');
      lines.push('');
      lines.push(`- ${entry.smoke.expectations.skippedUnbudgeted}`);
      lines.push('');

      lines.push('##### Direct invocation');
      lines.push('');
      lines.push(`- \`${entry.smoke.directInvocation}\``);
      lines.push('');
    } else if (entry.state === 'skipped-unbudgeted') {
      lines.push('#### Skip');
      lines.push('');
      lines.push(`- Reason: ${entry.skip.reason}`);
      lines.push(`- Explanation: ${entry.skip.explanation}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function parseSmokePlanFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (
      arg === '--metadata'
      || arg === '--smoke-catalog'
      || arg === '--format'
    ) {
      flags[arg.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return flags;
}

function formatSmokePlanErrors(errors) {
  return errors
    .map((e) => {
      if (e.agent && e.field) {
        return `  - [${e.agent}] ${e.field}: ${e.message}`;
      }
      if (typeof e.definitionIndex === 'number') {
        return `  - [definition #${e.definitionIndex}] ${e.field}: ${e.message}`;
      }
      return `  - ${e.field || ''}: ${e.message || JSON.stringify(e)}`;
    })
    .join('\n');
}

function runSmokePlanCommand(rest) {
  const flags = parseSmokePlanFlags(rest);
  if (!isNonEmptyString(flags.metadata)) {
    writeStderr('smoke-plan: missing required --metadata <path>\n');
    return 1;
  }
  const catalogPath = isNonEmptyString(flags['smoke-catalog'])
    ? flags['smoke-catalog']
    : DEFAULT_SMOKE_CATALOG_PATH;

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(flags.metadata, 'utf8'));
  } catch (err) {
    writeStderr(`smoke-plan: failed to read metadata file ${flags.metadata}: ${err.message}\n`);
    return 1;
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    writeStderr(`smoke-plan: failed to read smoke-catalog file ${catalogPath}: ${err.message}\n`);
    return 1;
  }

  const result = buildSmokePlan(metadata, catalog);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === 'invalid-metadata') {
      writeStderr(`smoke-plan: invalid-metadata\n${formatSmokePlanErrors(error.errors)}\n`);
    } else if (error.kind === 'invalid-catalog') {
      writeStderr(`smoke-plan: invalid-catalog\n${formatSmokePlanErrors(error.errors)}\n`);
    } else if (error.kind === 'missing-smoke-definition') {
      writeStderr(`smoke-plan: missing-smoke-definition: ${error.message}\n`);
    } else if (error.kind === 'smoke-class-mismatch') {
      writeStderr(`smoke-plan: smoke-class-mismatch: ${error.message}\n`);
    } else {
      writeStderr(`smoke-plan: ${JSON.stringify(error)}\n`);
    }
    return 1;
  }

  if (flags.format === 'markdown') {
    writeStdout(renderSmokePlanMarkdown(result.value));
  } else {
    writeStdout(`${renderSmokePlanJson(result.value)}\n`);
  }
  return 0;
}

module.exports = {
  COMMANDS,
  DEFAULT_SMOKE_CATALOG_PATH,
  buildAuditReport,
  buildSmokePlan,
  buildValidationReport,
  classifySmokeFailure,
  compareReports,
  detectPricingDrift,
  loadSmokeCatalog,
  main,
  normalizeDispatchSummary,
  parseReport,
  parseSession,
  parseSmokePlanFlags,
  placeholderReport,
  renderAuditReportJson,
  renderAuditReportMarkdown,
  renderSmokePlanJson,
  renderSmokePlanMarkdown,
  renderValidationReportJson,
  renderValidationReportMarkdown,
  runSmokePlanCommand,
  stableSortKeys,
  usage,
  validateAgentBudget,
  validateBudgetMetadata,
  validateMinimalBaseline,
  validateOpenCodeConfigShape,
  validateSmokeCatalog,
  validateSmokeResults,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
