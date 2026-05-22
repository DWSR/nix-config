'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseReport } = require(path.join(
  __dirname,
  '../../../scripts/subagent-context-budget.js',
));

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('parseReport: valid upstream report returns CostReportSummary with named-agent map and computed residuals', () => {
  const input = loadFixture('cost-report-valid.json');

  const result = parseReport(input);

  assert.equal(result.ok, true, 'parseReport should succeed on a valid report');
  assert.ok(result.value, 'parseReport should expose a summary value');

  const { sessions, global: globalSummary } = result.value;
  assert.deepEqual(globalSummary, {
    subagentDispatchTokens: 1500,
    subagentDispatchByAgent: { explore: 800, general: 400 },
    residualAgentTokens: 300,
  });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    sessionID: 's-1',
    project: '/repo/example',
    subagentDispatchTokens: 1000,
    subagentDispatchByAgent: { explore: 800 },
    residualAgentTokens: 200,
  });
  assert.deepEqual(sessions[1], {
    sessionID: 's-2',
    project: '/repo/example',
    subagentDispatchTokens: 500,
    subagentDispatchByAgent: { general: 400 },
    residualAgentTokens: 100,
  });
});

test('parseReport: residual-only report (subagentDispatchByAgent === null) credits all tokens to residual', () => {
  const input = loadFixture('cost-report-residual-only.json');

  const result = parseReport(input);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.global, {
    subagentDispatchTokens: 750,
    subagentDispatchByAgent: null,
    residualAgentTokens: 750,
  });
  assert.equal(result.value.sessions.length, 1);
  assert.deepEqual(result.value.sessions[0], {
    sessionID: 's-residual',
    project: null,
    subagentDispatchTokens: 750,
    subagentDispatchByAgent: null,
    residualAgentTokens: 750,
  });
});

test('parseReport: rejects non-object input with invalid-shape', () => {
  for (const bad of [null, undefined, 'string', 42, true, []]) {
    const result = parseReport(bad);
    assert.equal(result.ok, false, `non-object input ${typeof bad} should not parse`);
    assert.equal(result.error.kind, 'invalid-shape');
    assert.equal(result.error.field, 'report');
  }
});

test('parseReport: missing privacy field returns missing-field error naming the field path', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.privacy;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(result.error.field, 'privacy');
});

test('parseReport: missing global field returns missing-field error', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.global;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(result.error.field, 'global');
});

test('parseReport: missing global.cost.subagentDispatch returns missing-field with full path', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.global.cost.subagentDispatch;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(result.error.field, 'global.cost.subagentDispatch');
});

test('parseReport: invalid shape for subagentDispatch (string) returns invalid-shape error', () => {
  const input = loadFixture('cost-report-valid.json');
  input.global.cost.subagentDispatch = '1500';

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-shape');
  assert.equal(result.error.field, 'global.cost.subagentDispatch');
});

test('parseReport: invalid shape for subagentDispatchByAgent (array) returns invalid-shape error', () => {
  const input = loadFixture('cost-report-valid.json');
  input.global.cost.subagentDispatchByAgent = ['explore', 800];

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-shape');
  assert.equal(result.error.field, 'global.cost.subagentDispatchByAgent');
});

test('parseReport: invalid per-agent token value (string) returns invalid-shape error naming the offending key', () => {
  const input = loadFixture('cost-report-valid.json');
  input.global.cost.subagentDispatchByAgent = { explore: 'eight-hundred' };

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-shape');
  assert.equal(
    result.error.field,
    'global.cost.subagentDispatchByAgent.explore',
  );
});

test('parseReport: pricing-drift finding in global.findings is rejected with detail', () => {
  const input = loadFixture('cost-report-pricing-drift.json');

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'pricing-drift');
  assert.equal(
    result.error.detail,
    'model claude-opus-9 missing from pinned pricing table 2026-05-01',
  );
});

test('parseReport: pricing-drift finding at top-level findings is also rejected', () => {
  const input = loadFixture('cost-report-residual-only.json');
  input.findings.push({
    kind: 'pricing_drift',
    detail: 'top-level drift detected',
  });

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'pricing-drift');
  assert.equal(result.error.detail, 'top-level drift detected');
});

test('parseReport: pricing-drift finding in per-session findings is rejected', () => {
  const input = loadFixture('cost-report-valid.json');
  input.projects[0].sessions[0].findings.push({
    kind: 'pricing_table_drift',
    detail: 'session s-1 hit unknown model',
  });

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'pricing-drift');
  assert.equal(result.error.detail, 'session s-1 hit unknown model');
});

test('parseReport: missing projects array returns missing-field error', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.projects;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(result.error.field, 'projects');
});

test('parseReport: per-session missing sessionId returns missing-field with indexed path', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.projects[0].sessions[1].sessionId;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(
    result.error.field,
    'projects[0].sessions[1].sessionId',
  );
});

test('parseReport: per-session missing cost.subagentDispatch returns missing-field with indexed path', () => {
  const input = loadFixture('cost-report-valid.json');
  delete input.projects[0].sessions[0].cost.subagentDispatch;

  const result = parseReport(input);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(
    result.error.field,
    'projects[0].sessions[0].cost.subagentDispatch',
  );
});

test('parseReport: residual-mixed map strips unknown/null/empty sentinel keys and recomputes residual', () => {
  const input = loadFixture('cost-report-valid.json');
  input.global.cost.subagentDispatchByAgent = {
    explore: 800,
    general: 400,
    unknown: 200,
    null: 50,
    '': 50,
  };
  input.global.cost.subagentDispatch = 1500;

  const result = parseReport(input);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.global.subagentDispatchByAgent, {
    explore: 800,
    general: 400,
  });
  // residual = 1500 - (800 + 400) = 300; includes sentinel buckets
  assert.equal(result.value.global.residualAgentTokens, 300);
});

test('parseReport: per-agent map containing only sentinel keys emits null map and full residual', () => {
  const input = loadFixture('cost-report-residual-only.json');
  input.global.cost.subagentDispatchByAgent = { unknown: 750 };
  input.global.cost.subagentDispatch = 750;

  const result = parseReport(input);

  assert.equal(result.ok, true);
  assert.equal(result.value.global.subagentDispatchByAgent, null);
  assert.equal(result.value.global.residualAgentTokens, 750);
});

test('parseReport: privacy preservation - output never includes prompt or tool-output body content even when input carries them', () => {
  const input = loadFixture('cost-report-with-content.json');

  const result = parseReport(input);

  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes('promptBody'), false);
  assert.equal(serialized.includes('toolOutputBody'), false);
  assert.equal(serialized.includes('SECRET-PROMPT-PAYLOAD'), false);
  assert.equal(serialized.includes('SECRET-TOOL-OUTPUT-PAYLOAD'), false);
  // The summary still surfaces the data the adapter is supposed to pin.
  assert.equal(result.value.global.subagentDispatchTokens, 200);
  assert.deepEqual(result.value.sessions[0].subagentDispatchByAgent, {
    explore: 200,
  });
});

test('parseReport: output object keys are restricted to the documented summary contract (no surprise leakage)', () => {
  const input = loadFixture('cost-report-valid.json');

  const result = parseReport(input);

  assert.equal(result.ok, true);
  assert.deepEqual(
    Object.keys(result.value).sort(),
    ['global', 'sessions'],
  );
  assert.deepEqual(
    Object.keys(result.value.global).sort(),
    ['residualAgentTokens', 'subagentDispatchByAgent', 'subagentDispatchTokens'],
  );
  for (const session of result.value.sessions) {
    assert.deepEqual(
      Object.keys(session).sort(),
      [
        'project',
        'residualAgentTokens',
        'sessionID',
        'subagentDispatchByAgent',
        'subagentDispatchTokens',
      ],
    );
  }
});

test('parseReport: returns Result-shaped errors (no throws) for all invalid inputs', () => {
  const cases = [
    {},
    { privacy: {} },
    { privacy: {}, global: 'not-an-object', projects: [] },
    { privacy: {}, global: { cost: null }, projects: [] },
    { privacy: {}, global: { cost: { subagentDispatch: -10, subagentDispatchByAgent: null } }, projects: [] },
  ];
  for (const bad of cases) {
    let threw = false;
    let result;
    try {
      result = parseReport(clone(bad));
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, `parseReport should not throw for ${JSON.stringify(bad)}`);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.kind, 'string');
  }
});
