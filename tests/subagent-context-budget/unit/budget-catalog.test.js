'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  validateBudgetMetadata,
} = require(path.join(__dirname, '../../../scripts/subagent-context-budget.js'));

function completeMetadata(overrides = {}) {
  return {
    version: 1,
    host: 'all',
    enforcementEnabled: true,
    agents: {
      general: {
        name: 'general',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'general-research',
        permissionBudget: { read: 'allow', grep: 'allow', glob: 'allow' },
        capabilityRationale: [],
        smokeClass: 'general-research',
      },
      'nix-pkg': {
        name: 'nix-pkg',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'nix-package',
        permissionBudget: { read: 'allow', grep: 'allow', glob: 'allow', bash: { nix: 'allow' } },
        capabilityRationale: ['nix dry-run and evaluation commands'],
        smokeClass: 'nix-package-evaluation',
      },
      'yb-sleuth': {
        name: 'yb-sleuth',
        source: 'host-markdown',
        hostScope: 'shopify',
        state: { kind: 'enforced', reason: 'host-override' },
        instructionProfile: 'shopify-yugabyte-readonly',
        permissionBudget: { read: 'allow', grep: 'allow', glob: 'allow', bash: { git: 'allow' } },
        capabilityRationale: ['repository history inspection'],
        smokeClass: 'shopify-source-trace',
      },
    },
    ...overrides,
  };
}

test('validateBudgetMetadata accepts complete built-in, common, and host catalog entries', () => {
  const result = validateBudgetMetadata(completeMetadata());

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.agentNames, ['general', 'nix-pkg', 'yb-sleuth']);
  assert.equal(result.value.agentCount, 3);
});

test('validateBudgetMetadata rejects enforced agents without permission budgets', () => {
  const metadata = completeMetadata();
  delete metadata.agents.general.permissionBudget;

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'general',
      field: 'permissionBudget',
      message: 'enforced agent must define a non-empty permission budget',
    },
  ]);
});

test('validateBudgetMetadata rejects enforced agents without instruction profiles', () => {
  const metadata = completeMetadata();
  metadata.agents['nix-pkg'].instructionProfile = '';

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'nix-pkg',
      field: 'instructionProfile',
      message: 'enforced agent must define an instruction profile',
    },
  ]);
});

test('validateBudgetMetadata rejects unknown budget state kinds without accepting missing enforced fields', () => {
  const metadata = completeMetadata();
  metadata.agents.general.state = { kind: 'invalid-state', reason: 'default' };
  delete metadata.agents.general.instructionProfile;
  delete metadata.agents.general.permissionBudget;

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'general',
      field: 'state',
      message: 'agent state must be enforced/default, enforced/host-override, or unbudgeted/operator-escape-hatch',
    },
  ]);
});

test('validateBudgetMetadata rejects invalid enforced state reasons and still requires enforced fields', () => {
  const metadata = completeMetadata();
  metadata.agents.general.state = { kind: 'enforced', reason: 'operator-escape-hatch' };
  delete metadata.agents.general.instructionProfile;
  delete metadata.agents.general.permissionBudget;

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'general',
      field: 'state',
      message: 'agent state must be enforced/default, enforced/host-override, or unbudgeted/operator-escape-hatch',
    },
    {
      agent: 'general',
      field: 'instructionProfile',
      message: 'enforced agent must define an instruction profile',
    },
    {
      agent: 'general',
      field: 'permissionBudget',
      message: 'enforced agent must define a non-empty permission budget',
    },
  ]);
});

test('validateBudgetMetadata rejects entries whose natural key and name differ', () => {
  const metadata = completeMetadata();
  metadata.agents['nix-pkg'].name = 'nix-package';

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'nix-pkg',
      field: 'name',
      message: 'agent name must match its catalog key',
    },
  ]);
});

test('validateBudgetMetadata accepts unbudgeted agents without enforcement-only fields', () => {
  const metadata = completeMetadata({
    agents: {
      explore: {
        name: 'explore',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'unbudgeted', reason: 'operator-escape-hatch' },
        capabilityRationale: [],
        smokeClass: 'readonly-codebase-question',
      },
    },
  });

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.agentNames, ['explore']);
});

test('validateBudgetMetadata rejects invalid unbudgeted state reasons', () => {
  const metadata = completeMetadata({
    agents: {
      explore: {
        name: 'explore',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'unbudgeted', reason: 'default' },
        capabilityRationale: [],
        smokeClass: 'readonly-codebase-question',
      },
    },
  });

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'explore',
      field: 'state',
      message: 'agent state must be enforced/default, enforced/host-override, or unbudgeted/operator-escape-hatch',
    },
  ]);
});
