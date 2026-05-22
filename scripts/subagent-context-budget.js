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

function isValidBudgetState(value) {
  if (!isObject(value) || !isNonEmptyString(value.kind)) {
    return false;
  }

  const validReasons = BUDGET_STATE_REASONS[value.kind];
  return Array.isArray(validReasons) && validReasons.includes(value.reason);
}

function validationError(agent, field, message) {
  return { agent, field, message };
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

  if (isObject(agent.state) && agent.state.kind === 'enforced') {
    if (!isNonEmptyString(agent.instructionProfile)) {
      errors.push(validationError(catalogName, 'instructionProfile', 'enforced agent must define an instruction profile'));
    }
    if (!isNonEmptyObject(agent.permissionBudget)) {
      errors.push(validationError(catalogName, 'permissionBudget', 'enforced agent must define a non-empty permission budget'));
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
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
