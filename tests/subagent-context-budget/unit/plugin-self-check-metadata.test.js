'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginPath = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/plugin.ts',
);

async function loadPlugin() {
  return import(pathToFileURL(pluginPath).href);
}

function baseEnabledRuntime(overrides) {
  return Object.assign(
    {
      enabled: true,
      availableHooks: ['experimental.system.prompt'],
      sessionAgentLookupAvailable: true,
    },
    overrides,
  );
}

test('selfCheck flags non-object budgetMetadata as missing metadata', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({ budgetMetadata: 'not-an-object' }),
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.metadataPresent, false);
  assert.deepEqual(result.missing, ['metadata']);
  assert.deepEqual(result.unknownAgents, []);
  assert.deepEqual(result.unresolvedProfiles, []);
});

test('selfCheck flags metadata with non-object agents map as agent-map missing', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({ budgetMetadata: { version: 1, agents: 'wrong-type' } }),
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.metadataPresent, true);
  assert.deepEqual(result.missing, ['agent-map']);
});

test('selfCheck flags empty agents object as agent-map missing', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({ budgetMetadata: { version: 1, agents: {} } }),
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.metadataPresent, true);
  assert.deepEqual(result.missing, ['agent-map']);
});

test('selfCheck collects multiple unknown agents in deterministic order', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({
      budgetMetadata: {
        version: 1,
        agents: {
          'z-agent': { state: 'enforced' },
          'a-agent': { state: 'enforced', instructionProfile: '' },
          'm-agent': { state: 'enforced' },
        },
      },
    }),
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.unknownAgents, ['a-agent', 'm-agent', 'z-agent']);
  assert.deepEqual(result.missing, [
    'agent:a-agent',
    'agent:m-agent',
    'agent:z-agent',
  ]);
});

test('selfCheck collects unresolved profile references deduplicated and sorted', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({
      budgetMetadata: {
        version: 1,
        agents: {
          alpha: { state: 'enforced', instructionProfile: 'zeta-profile' },
          bravo: { state: 'enforced', instructionProfile: 'alpha-profile' },
          charlie: { state: 'enforced', instructionProfile: 'zeta-profile' },
        },
      },
    }),
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.unresolvedProfiles, ['alpha-profile', 'zeta-profile']);
  assert.deepEqual(result.missing, [
    'profile:alpha-profile',
    'profile:zeta-profile',
  ]);
});

test('selfCheck skips unbudgeted agents (escape-hatch state)', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck(
    baseEnabledRuntime({
      budgetMetadata: {
        version: 1,
        agents: {
          'escape-hatch-agent': { state: 'unbudgeted' },
          'enforced-agent': {
            state: 'enforced',
            instructionProfile: 'general-research',
          },
        },
      },
    }),
  );

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.unknownAgents, []);
  assert.deepEqual(result.unresolvedProfiles, []);
});

test('selfCheck combines hook, lookup, and metadata failure modes', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck({
    enabled: true,
    availableHooks: [],
    sessionAgentLookupAvailable: false,
    budgetMetadata: {
      version: 1,
      agents: {
        'broken-agent': { state: 'enforced', instructionProfile: 'no-such-profile' },
      },
    },
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.missing, [
    'hook:experimental.system.prompt',
    'session-agent-lookup',
    'profile:no-such-profile',
  ]);
  assert.deepEqual(result.unresolvedProfiles, ['no-such-profile']);
});

test('selfCheck disabled result remains backward compatible (no new fields leak)', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const result = SubagentContextBudgetPlugin.selfCheck({ enabled: false });

  assert.equal(result.status, 'disabled');
  assert.deepEqual(result, {
    status: 'disabled',
    requiredHook: 'experimental.system.prompt',
    missing: [],
    reason: 'budget-enforcement-disabled',
  });
});

test('runSelfCheckCommand emits JSON-serializable result with no undefined fields', async () => {
  const { SubagentContextBudgetPlugin } = await loadPlugin();
  const runtime = baseEnabledRuntime({
    budgetMetadata: {
      version: 1,
      agents: {
        broken: { state: 'enforced' },
      },
    },
  });
  const serialized = SubagentContextBudgetPlugin.runSelfCheckCommand(runtime);

  // Trailing newline preserved; JSON parses cleanly; no `undefined` slipped through.
  assert.match(serialized, /\n$/);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.status, 'failed');
  assert.equal(typeof parsed.metadataPresent, 'boolean');
  assert.ok(Array.isArray(parsed.unknownAgents));
  assert.ok(Array.isArray(parsed.unresolvedProfiles));
});
