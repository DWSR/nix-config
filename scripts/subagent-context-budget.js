#!/usr/bin/env node
/*
 * subagent-context-budget.js — BudgetCLI entry point.
 *
 * Task 1.2 owns only CLI and test-runner scaffolding. The audit,
 * validate, and smoke-plan commands intentionally return deterministic
 * placeholders until later tasks add report parsing and comparison.
 */
'use strict';

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

function usage() {
  return [
    'Usage: subagent-context-budget <command> [options]',
    '',
    'Commands:',
    '  audit        Placeholder for budget metadata and diagnostic audit reports',
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

  writeStdout(`${JSON.stringify(placeholderReport(command), null, 2)}\n`);
  return 0;
}

module.exports = {
  COMMANDS,
  main,
  placeholderReport,
  usage,
  validateAgentBudget,
  validateBudgetMetadata,
  validateMinimalBaseline,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
