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

const profileMap = Object.freeze({
  general: 'general-research',
  explore: 'readonly-codebase',
  'nix-pkg': 'nix-package',
  'nvim-tailor': 'nvim-config',
  'security-auditor': 'security-readonly',
  'stack-captain': 'shopify-stack',
  'yb-sleuth': 'shopify-yugabyte-readonly',
});

test('decideProfile returns apply for known subagent with mapped profile', async () => {
  const mod = await loadPlugin();

  const decision = mod.SubagentContextBudgetPlugin.decideProfile({
    agentName: 'general',
    isSubagent: true,
    profileMap,
  });

  assert.equal(decision.kind, 'apply');
  assert.equal(decision.agentName, 'general');
  assert.equal(decision.profileName, 'general-research');
  assert.match(decision.systemText, /Universal subagent instructions/);
  assert.match(decision.systemText, /Mandatory AgentMemory and mcpproxy safety/);
  assert.match(decision.systemText, /AgentMemory/);
  assert.match(decision.systemText, /memory_recall/);
  assert.match(decision.systemText, /memory_save/);
  assert.match(decision.systemText, /memory_lesson_save/);
  assert.match(decision.systemText, /call_tool_destructive/);
  assert.doesNotMatch(decision.systemText, /Obsidian|cavemem|vault/i);
  assert.match(decision.systemText, /mcpproxy/);
  assert.match(decision.systemText, /General research role/);
});

test('decideProfile skips primary sessions with reason primary-session', async () => {
  const mod = await loadPlugin();

  for (const isSubagent of [false, undefined, null, 'yes', 0]) {
    const decision = mod.SubagentContextBudgetPlugin.decideProfile({
      agentName: 'general',
      isSubagent,
      profileMap,
    });
    assert.deepEqual(
      decision,
      { kind: 'skip', reason: 'primary-session' },
      `isSubagent=${String(isSubagent)} must skip as primary-session`,
    );
  }
});

test('decideProfile skips unknown agents with reason agent-unknown', async () => {
  const mod = await loadPlugin();

  // No agent name at all.
  assert.deepEqual(
    mod.SubagentContextBudgetPlugin.decideProfile({
      isSubagent: true,
      profileMap,
    }),
    { kind: 'skip', reason: 'agent-unknown' },
  );

  // Empty agent name string.
  assert.deepEqual(
    mod.SubagentContextBudgetPlugin.decideProfile({
      agentName: '',
      isSubagent: true,
      profileMap,
    }),
    { kind: 'skip', reason: 'agent-unknown' },
  );

  // Agent name not present in profileMap.
  assert.deepEqual(
    mod.SubagentContextBudgetPlugin.decideProfile({
      agentName: 'unmapped-agent',
      isSubagent: true,
      profileMap,
    }),
    { kind: 'skip', reason: 'agent-unknown' },
  );
});

test('decideProfile skips with reason profile-missing when mapped profile cannot compose', async () => {
  const mod = await loadPlugin();

  const decision = mod.SubagentContextBudgetPlugin.decideProfile({
    agentName: 'general',
    isSubagent: true,
    profileMap: { general: 'no-such-profile' },
  });
  assert.deepEqual(decision, { kind: 'skip', reason: 'profile-missing' });
});

test('decideProfile apply outcomes always include mandatory universal + memory-mcpproxy fragments', async () => {
  const mod = await loadPlugin();

  for (const [agentName, profileName] of Object.entries(profileMap)) {
    const decision = mod.SubagentContextBudgetPlugin.decideProfile({
      agentName,
      isSubagent: true,
      profileMap,
    });
    assert.equal(decision.kind, 'apply', `${agentName} -> ${profileName} should apply`);
    assert.match(decision.systemText, /Universal subagent instructions/);
    assert.match(decision.systemText, /Mandatory AgentMemory and mcpproxy safety/);
  }
});

test('decide resolves a subagent session via sessionLookup and applies its profile', async () => {
  const mod = await loadPlugin();

  const sessionLookups = [];
  const decision = await mod.SubagentContextBudgetPlugin.decide({
    sessionID: 'sess-subagent-1',
    currentSystemText: 'PRIMARY MAIN-THREAD TEXT THAT MUST BE REPLACED',
    sessionLookup: async (sessionID) => {
      sessionLookups.push(sessionID);
      return { agentName: 'explore', isSubagent: true };
    },
    profileMap,
  });

  assert.deepEqual(sessionLookups, ['sess-subagent-1']);
  assert.equal(decision.kind, 'apply');
  assert.equal(decision.agentName, 'explore');
  assert.equal(decision.profileName, 'readonly-codebase');
  assert.match(decision.systemText, /Read-only codebase role/);
  // Replacement systemText must not carry through the primary text.
  assert.doesNotMatch(decision.systemText, /PRIMARY MAIN-THREAD TEXT/);
});

test('decide preserves primary session text by returning skip primary-session', async () => {
  const mod = await loadPlugin();

  const decision = await mod.SubagentContextBudgetPlugin.decide({
    sessionID: 'sess-primary',
    currentSystemText: 'PRIMARY MAIN-THREAD TEXT',
    sessionLookup: async () => ({ agentName: 'general', isSubagent: false }),
    profileMap,
  });

  assert.deepEqual(decision, { kind: 'skip', reason: 'primary-session' });
});

test('decide treats falsy sessionLookup results as agent-unknown', async () => {
  const mod = await loadPlugin();

  for (const lookupResult of [undefined, null, false, 0, '']) {
    const decision = await mod.SubagentContextBudgetPlugin.decide({
      sessionID: 'sess-missing',
      currentSystemText: '',
      sessionLookup: async () => lookupResult,
      profileMap,
    });
    assert.deepEqual(
      decision,
      { kind: 'skip', reason: 'agent-unknown' },
      `lookup=${String(lookupResult)} must skip as agent-unknown`,
    );
  }
});

test('decide treats thrown sessionLookup as agent-unknown', async () => {
  const mod = await loadPlugin();

  const decision = await mod.SubagentContextBudgetPlugin.decide({
    sessionID: 'sess-throw',
    currentSystemText: '',
    sessionLookup: async () => {
      throw new Error('session lookup failed');
    },
    profileMap,
  });
  assert.deepEqual(decision, { kind: 'skip', reason: 'agent-unknown' });
});

test('decide returns profile-missing when mapped profile cannot compose', async () => {
  const mod = await loadPlugin();

  const decision = await mod.SubagentContextBudgetPlugin.decide({
    sessionID: 'sess-bad-profile',
    currentSystemText: '',
    sessionLookup: async () => ({ agentName: 'general', isSubagent: true }),
    profileMap: { general: 'no-such-profile' },
  });
  assert.deepEqual(decision, { kind: 'skip', reason: 'profile-missing' });
});

test('decide treats a missing sessionLookup function as agent-unknown', async () => {
  const mod = await loadPlugin();

  const decision = await mod.SubagentContextBudgetPlugin.decide({
    sessionID: 'sess-no-lookup',
    currentSystemText: '',
    profileMap,
  });
  assert.deepEqual(decision, { kind: 'skip', reason: 'agent-unknown' });
});

test('plugin entrypoint with runtime.enabled false stays inert and registers no behavioral hooks', async () => {
  const mod = await loadPlugin();
  const logs = [];

  const hooks = await mod.SubagentContextBudgetPlugin({
    client: {
      app: {
        log: async ({ body }) => {
          logs.push(body);
          return true;
        },
      },
    },
    subagentContextBudget: { enabled: false },
  });

  // Flag-off: no hooks registered (no experimental.system.prompt etc.).
  assert.deepEqual(hooks, {});
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'plugin self-check disabled');
  assert.equal(logs[0].level, 'info');
});
