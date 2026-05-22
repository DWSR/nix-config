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
const fixturesDir = path.join(__dirname, '../fixtures/plugin-self-check');

async function loadPlugin() {
  return import(pathToFileURL(pluginPath).href);
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

test('packaged plugin module exposes the runtime plugin entrypoint', async () => {
  const mod = await loadPlugin();

  assert.equal(typeof mod.SubagentContextBudgetPlugin, 'function');
  assert.equal(typeof mod.SubagentContextBudgetPlugin.selfCheck, 'function');
  assert.equal(typeof mod.SubagentContextBudgetPlugin.runSelfCheckCommand, 'function');
});

for (const fixtureName of ['disabled', 'ready', 'failed']) {
  test(`plugin self-check fixture reports ${fixtureName} deterministically`, async () => {
    const mod = await loadPlugin();
    const fixture = readFixture(fixtureName);

    const result = mod.SubagentContextBudgetPlugin.selfCheck(fixture.runtime);
    const commandResult = JSON.parse(
      mod.SubagentContextBudgetPlugin.runSelfCheckCommand(fixture.runtime),
    );

    assert.deepEqual(result, fixture.expected);
    assert.deepEqual(commandResult, fixture.expected);
  });
}

test('plugin initialization logs self-check status and registers no prompt hooks', async () => {
  const mod = await loadPlugin();
  const fixture = readFixture('ready');
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
    subagentContextBudget: fixture.runtime,
  });

  assert.deepEqual(hooks, {});
  assert.equal(logs.length, 1);
  assert.equal(logs[0].service, 'subagent-context-budget');
  assert.equal(logs[0].message, 'plugin self-check ready');
  assert.equal(logs[0].level, 'info');
  assert.deepEqual(logs[0].extra, fixture.expected);
});
