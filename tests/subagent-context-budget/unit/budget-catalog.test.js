'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateBudgetMetadata,
} = require(path.join(__dirname, '../../../scripts/subagent-context-budget.js'));

function completeMetadata(overrides = {}) {
  return {
    version: 1,
    host: 'all',
    enforcementEnabled: true,
    minimalBaseline: {
      name: 'minimal-readonly',
      measuredTokens: {
        status: 'placeholder',
        firstTurnInput: null,
        measuredAt: null,
        source: null,
      },
      instructionCategories: [
        'universal',
        'memory-mcpproxy',
        'readonly-operation',
      ],
      allowedToolCategories: [
        'local-read',
        'code-search',
        'planning',
        'clarification',
        'skill-loading',
        'mcp-discovery',
        'mcp-read',
      ],
    },
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
  assert.deepEqual(result.value.minimalBaseline.instructionCategories, [
    'memory-mcpproxy',
    'readonly-operation',
    'universal',
  ]);
  assert.deepEqual(result.value.minimalBaseline.allowedToolCategories, [
    'clarification',
    'code-search',
    'local-read',
    'mcp-discovery',
    'mcp-read',
    'planning',
    'skill-loading',
  ]);
  assert.equal(result.value.minimalBaseline.measuredTokens.status, 'placeholder');
  assert.equal(result.value.minimalBaseline.measuredTokens.firstTurnInput, null);
});

test('validateBudgetMetadata rejects minimal baseline without measured-token placeholders', () => {
  const metadata = completeMetadata();
  delete metadata.minimalBaseline.measuredTokens.firstTurnInput;

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: '<minimalBaseline>',
      field: 'measuredTokens.firstTurnInput',
      message: 'minimal read-only baseline must include first-turn token placeholder or measured count',
    },
  ]);
});

test('validateBudgetMetadata rejects host-specific and project-specific baseline instruction categories', () => {
  const metadata = completeMetadata();
  metadata.minimalBaseline.instructionCategories = [
    'universal',
    'memory-mcpproxy',
    'shopify',
    'nix-config',
    'project-specific',
  ];

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: '<minimalBaseline>',
      field: 'instructionCategories.shopify',
      message: 'minimal read-only baseline must not include host-specific or project-specific instruction categories',
    },
    {
      agent: '<minimalBaseline>',
      field: 'instructionCategories.nix-config',
      message: 'minimal read-only baseline must not include host-specific or project-specific instruction categories',
    },
    {
      agent: '<minimalBaseline>',
      field: 'instructionCategories.project-specific',
      message: 'minimal read-only baseline must not include host-specific or project-specific instruction categories',
    },
  ]);
});

test('minimal-readonly-baseline artifact is operator-readable and metadata-valid', () => {
  const artifactPath = path.join(
    __dirname,
    '../../../home-manager/common/subagent-context-budget/minimal-readonly-baseline.json',
  );
  const minimalBaseline = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  const result = validateBudgetMetadata(completeMetadata({ minimalBaseline }));

  assert.equal(result.ok, true);
  assert.equal(result.value.minimalBaseline.name, 'minimal-readonly');
  assert.equal(result.value.minimalBaseline.measuredTokens.status, 'placeholder');
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

test('validateBudgetMetadata rejects unsupported permission budget keys', () => {
  const metadata = completeMetadata();
  metadata.agents.general.permissionBudget.write = 'allow';

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'general',
      field: 'permissionBudget.write',
      message: 'permission budget key is not supported; use supported permission keys and avoid undocumented mutation aliases',
    },
  ]);
});

test('validateBudgetMetadata rejects deprecated tools usage in budget metadata', () => {
  const metadata = completeMetadata();
  metadata.agents.general.tools = ['read', 'grep'];
  metadata.agents['nix-pkg'].permissionBudget.tools = ['read'];

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'general',
      field: 'tools',
      message: 'deprecated tools allowlists are not supported in budget metadata; use permissionBudget',
    },
    {
      agent: 'nix-pkg',
      field: 'permissionBudget.tools',
      message: 'deprecated tools allowlists are not supported in budget metadata; use permissionBudget',
    },
  ]);
});

test('validateBudgetMetadata requires rationale for mutation, web, external-directory, and shell capability', () => {
  const metadata = completeMetadata({
    agents: {
      editor: {
        name: 'editor',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'repo-editor',
        permissionBudget: { read: 'allow', edit: 'allow' },
        capabilityRationale: [],
        smokeClass: 'repo-edit',
      },
      researcher: {
        name: 'researcher',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'web-research',
        permissionBudget: { read: 'allow', webfetch: 'allow' },
        capabilityRationale: [],
        smokeClass: 'web-research',
      },
      importer: {
        name: 'importer',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'external-import',
        permissionBudget: { read: 'allow', external_directory: 'allow' },
        capabilityRationale: [],
        smokeClass: 'external-import',
      },
      sheller: {
        name: 'sheller',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'shell-inspection',
        permissionBudget: { read: 'allow', bash: { git: 'allow' } },
        capabilityRationale: [],
        smokeClass: 'shell-inspection',
      },
    },
  });

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'editor',
      field: 'capabilityRationale',
      message: 'agent must document rationale for broad mutation capability: edit',
    },
    {
      agent: 'importer',
      field: 'capabilityRationale',
      message: 'agent must document rationale for external-directory capability: external_directory',
    },
    {
      agent: 'researcher',
      field: 'capabilityRationale',
      message: 'agent must document rationale for web capability: webfetch',
    },
    {
      agent: 'sheller',
      field: 'capabilityRationale',
      message: 'agent must document rationale for shell capability: bash',
    },
  ]);
});

test('validateBudgetMetadata rejects whitespace-only rationale for broad capabilities', () => {
  const metadata = completeMetadata({
    agents: {
      editor: {
        name: 'editor',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'repo-editor',
        permissionBudget: { read: 'allow', edit: 'allow' },
        capabilityRationale: ['   '],
        smokeClass: 'repo-edit',
      },
    },
  });

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      agent: 'editor',
      field: 'capabilityRationale',
      message: 'agent must document rationale for broad mutation capability: edit',
    },
  ]);
});

test('validateBudgetMetadata accepts write-capable agents with explicit capability rationale', () => {
  const metadata = completeMetadata({
    agents: {
      editor: {
        name: 'editor',
        source: 'common-markdown',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'repo-editor',
        permissionBudget: {
          read: 'allow',
          edit: 'allow',
          external_directory: { '/tmp/opencode-fixtures/**': 'allow' },
          bash: { nix: 'allow' },
          webfetch: 'allow',
        },
        capabilityRationale: [
          'repo edits, fixture imports, nix evaluation, and upstream documentation checks',
        ],
        smokeClass: 'repo-edit',
      },
    },
  });

  const result = validateBudgetMetadata(metadata);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.agentNames, ['editor']);
});
