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
  'kiro-spec-orchestration',
  'nvim-config',
  'security-readonly',
  'shopify-stack',
  'shopify-yugabyte-readonly',
];

test('instruction fragment files exist for universal, memory, SDD, host, and roles', () => {
  for (const relativePath of [
    'universal.md',
    'memory-mcpproxy.md',
    'cc-sdd-minimal.md',
    'github-native-stacks-minimal.md',
    'host-specific/shopify.md',
    'role-fragments/general-research.md',
    'role-fragments/kiro-spec-orchestration.md',
    'role-fragments/readonly-codebase.md',
    'role-fragments/shopify-stack.md',
  ]) {
    const absolutePath = path.join(instructionsDir, relativePath);
    assert.ok(fs.existsSync(absolutePath), `${relativePath} must exist`);
    assert.ok(fs.readFileSync(absolutePath, 'utf8').trim().length > 0);
  }
});

test('retired vault fragments and profiles are absent', async () => {
  const mod = await loadPlugin();

  for (const relativePath of [
    'role-fragments/vault-curation.md',
    'role-fragments/vault-synthesis.md',
  ]) {
    assert.equal(
      fs.existsSync(path.join(instructionsDir, relativePath)),
      false,
      `${relativePath} must be retired`,
    );
  }

  for (const retiredName of ['vault-curation', 'vault-synthesis']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(mod.SubagentContextBudgetPlugin.instructionFragments, retiredName),
      false,
      `${retiredName} must not be an instruction fragment`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(mod.SubagentContextBudgetPlugin.instructionProfiles, retiredName),
      false,
      `${retiredName} must not be an instruction profile`,
    );
    assert.deepEqual(
      mod.SubagentContextBudgetPlugin.composeInstructionProfile(retiredName),
      { kind: 'missing-profile', profileName: retiredName },
    );
  }
});

test('canonical memory fragment matches the plugin runtime copy', async () => {
  const mod = await loadPlugin();
  const source = fs.readFileSync(
    path.join(instructionsDir, 'memory-mcpproxy.md'),
    'utf8',
  ).trim();

  assert.equal(
    mod.SubagentContextBudgetPlugin.instructionFragments['memory-mcpproxy'].text,
    source,
  );
});

test('GitHub-native Stack compact guidance matches runtime and preserves local, remote, and handoff policy', async () => {
  const mod = await loadPlugin();
  const source = fs.readFileSync(
    path.join(instructionsDir, 'github-native-stacks-minimal.md'),
    'utf8',
  ).trim();
  const runtime = mod.SubagentContextBudgetPlugin.instructionFragments['github-native-stacks-minimal'].text;

  assert.equal(runtime, source);
  assert.match(source, /Use GitHub MCP for remote-only Stack work\./);
  assert.match(
    source,
    /Discover typed local Stack tools and\s+exact `name`\/`call_with` for `stack_checkout`, `stack_rebase` start\/guarded\s+continue, and `stack_push`/,
  );
  assert.match(source, /never run `gh stack` or imitate Stack work with\s+per-branch Git calls/);
  assert.match(
    source,
    /Before each local mutation, follow the skill's explicit-path Git-MCP and affected\s+GitHub MCP snapshots, preview exact scope, and obtain scoped authorization\./,
  );
  assert.match(
    source,
    /Rebase and push need separate authorization; re-inspect `exited_unverified` or\s+uncertain outcomes before success\/retry, and reauthorize if state changes\./,
  );
  assert.match(
    source,
    /Use a user-owned handoff with the exact command; stop\s+for unavailable tools, explicit CLI preference, abort/,
  );
  assert.match(source, /Never merge or\s+unstack\./);
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
    assert.match(profile.systemText, /AgentMemory/);
    assert.match(profile.systemText, /memory_recall/);
    assert.match(profile.systemText, /memory_smart_search/);
    assert.match(profile.systemText, /memory_save/);
    assert.match(profile.systemText, /memory_lesson_save/);
    assert.match(profile.systemText, /retrieve_tools/);
    assert.match(profile.systemText, /call_tool_read/);
    assert.match(profile.systemText, /call_tool_write/);
    assert.match(profile.systemText, /call_tool_destructive/);
    assert.match(profile.systemText, /call_with/);
    assert.match(profile.systemText, /mcpproxy/);
    assert.doesNotMatch(profile.systemText, /Obsidian|cavemem|vault/i);
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
  assert.ok(shopify.fragments.some((fragment) => fragment.name === 'github-native-stacks-minimal'));
  assert.ok(shopify.fragments.some((fragment) => fragment.name === 'shopify-host'));
  assert.match(shopify.systemText, /GitHub-native Stack/);
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
