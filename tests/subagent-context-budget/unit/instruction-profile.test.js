'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginPath = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/plugin.ts',
);
const instructionsDir = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/instructions',
);

async function loadPlugin() {
  return import(pathToFileURL(pluginPath).href);
}

const budgetProfileNames = [
  'general-research',
  'readonly-codebase',
  'nix-package',
  'nvim-config',
  'security-readonly',
  'vault-curation',
  'vault-synthesis',
  'shopify-stack',
  'shopify-yugabyte-readonly',
];

test('instruction fragment files exist for universal, memory, SDD, host, and roles', () => {
  for (const relativePath of [
    'universal.md',
    'memory-mcpproxy.md',
    'cc-sdd-minimal.md',
    'host-specific/shopify.md',
    'role-fragments/general-research.md',
    'role-fragments/readonly-codebase.md',
    'role-fragments/shopify-stack.md',
  ]) {
    const absolutePath = path.join(instructionsDir, relativePath);
    assert.ok(fs.existsSync(absolutePath), `${relativePath} must exist`);
    assert.ok(fs.readFileSync(absolutePath, 'utf8').trim().length > 0);
  }
});

test('composeInstructionProfile includes mandatory safety fragments for every budget profile', async () => {
  const mod = await loadPlugin();

  for (const profileName of budgetProfileNames) {
    const profile = mod.SubagentContextBudgetPlugin.composeInstructionProfile(profileName);

    assert.equal(profile.kind, 'composed', `${profileName} should compose`);
    assert.equal(profile.fragments[0].name, 'universal');
    assert.ok(
      profile.fragments.some((fragment) => fragment.name === 'memory-mcpproxy'),
      `${profileName} must include the memory/mcpproxy fragment`,
    );
    assert.match(profile.systemText, /Obsidian/);
    assert.match(profile.systemText, /cavemem/);
    assert.match(profile.systemText, /mcpproxy/);
  }
});

test('composeInstructionProfile omits unrelated workflow fragments', async () => {
  const mod = await loadPlugin();

  const readonly = mod.SubagentContextBudgetPlugin.composeInstructionProfile('readonly-codebase');
  const shopify = mod.SubagentContextBudgetPlugin.composeInstructionProfile('shopify-stack');

  assert.equal(readonly.kind, 'composed');
  assert.deepEqual(
    readonly.fragments.map((fragment) => fragment.name),
    ['universal', 'memory-mcpproxy', 'readonly-codebase'],
  );
  assert.doesNotMatch(readonly.systemText, /Graphite/);
  assert.doesNotMatch(readonly.systemText, /Spec-Driven Development/);
  assert.doesNotMatch(readonly.systemText, /Shopify host/);

  assert.equal(shopify.kind, 'composed');
  assert.ok(shopify.fragments.some((fragment) => fragment.name === 'graphite-minimal'));
  assert.ok(shopify.fragments.some((fragment) => fragment.name === 'shopify-host'));
  assert.doesNotMatch(shopify.systemText, /Neovim/);
});

test('composeInstructionProfile supports widening one profile without mutating others', async () => {
  const mod = await loadPlugin();

  const base = mod.SubagentContextBudgetPlugin.composeInstructionProfile('readonly-codebase');
  const widened = mod.SubagentContextBudgetPlugin.composeInstructionProfile('readonly-codebase', {
    extraFragments: ['cc-sdd-minimal'],
  });
  const general = mod.SubagentContextBudgetPlugin.composeInstructionProfile('general-research');

  assert.equal(base.kind, 'composed');
  assert.equal(widened.kind, 'composed');
  assert.equal(general.kind, 'composed');

  assert.equal(base.fragments.some((fragment) => fragment.name === 'cc-sdd-minimal'), false);
  assert.equal(widened.fragments.some((fragment) => fragment.name === 'cc-sdd-minimal'), true);
  assert.equal(general.fragments.some((fragment) => fragment.name === 'cc-sdd-minimal'), false);
});

test('composeInstructionProfile fails closed for unknown profiles or fragments', async () => {
  const mod = await loadPlugin();

  assert.deepEqual(
    mod.SubagentContextBudgetPlugin.composeInstructionProfile('missing-profile'),
    { kind: 'missing-profile', profileName: 'missing-profile' },
  );
  assert.deepEqual(
    mod.SubagentContextBudgetPlugin.composeInstructionProfile('readonly-codebase', {
      extraFragments: ['missing-fragment'],
    }),
    {
      kind: 'missing-fragment',
      profileName: 'readonly-codebase',
      fragmentName: 'missing-fragment',
    },
  );
});
