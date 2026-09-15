'use strict';

/*
 * smoke-result.test.js — Task 5.3 smoke-result data handling.
 *
 * Covers synthetic SmokeTestRunner results only. Live smoke execution is
 * intentionally out of scope for this task.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../../../scripts/subagent-context-budget.js');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

const {
  classifySmokeFailure,
  compareReports,
  parseReport,
  renderValidationReportMarkdown,
  validateSmokeResults,
} = require(CLI_PATH);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function parseFixture(name) {
  const parsed = parseReport(loadFixture(name));
  assert.equal(parsed.ok, true, `fixture ${name} must parse; got error ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function metadata() {
  return {
    agents: {
      explore: {
        name: 'explore',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'readonly',
        permissionBudget: { read: 'allow' },
        capabilityRationale: [],
        smokeClass: 'readonly-codebase-question',
      },
      general: {
        name: 'general',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'enforced', reason: 'default' },
        instructionProfile: 'general',
        permissionBudget: { read: 'allow' },
        capabilityRationale: [],
        smokeClass: 'general-research',
      },
      'operator-escape': {
        name: 'operator-escape',
        source: 'builtin',
        hostScope: 'all',
        state: { kind: 'unbudgeted', reason: 'operator-escape-hatch' },
        instructionProfile: '',
        permissionBudget: {},
        capabilityRationale: [],
        smokeClass: 'operator-escape',
      },
    },
  };
}

function catalog() {
  return {
    schemaVersion: 1,
    smokeDefinitions: [
      { class: 'general-research', agentName: 'general', hostScope: 'all' },
      { class: 'readonly-codebase-question', agentName: 'explore', hostScope: 'all' },
      { class: 'operator-escape', agentName: 'operator-escape', hostScope: 'all' },
    ],
  };
}

test('classifySmokeFailure: maps missing tool evidence to denied-required-tool with missingCapability', () => {
  const failure = classifySmokeFailure({
    detail: 'webfetch was denied',
    evidence: { missingTool: 'webfetch' },
  });

  assert.deepEqual(failure, {
    category: 'denied-required-tool',
    detail: 'webfetch was denied',
    missingCapability: 'webfetch',
  });
});

test('classifySmokeFailure: maps missing instruction evidence to missing-instruction', () => {
  const failure = classifySmokeFailure({
    detail: 'memory workflow fragment was absent',
    evidence: { missingFragment: 'memory-workflow' },
  });

  assert.deepEqual(failure, {
    category: 'missing-instruction',
    detail: 'memory workflow fragment was absent',
    missingCapability: 'memory-workflow',
  });
});

test('classifySmokeFailure: maps non-zero exit evidence when no missing capability is present', () => {
  const failure = classifySmokeFailure({
    detail: 'command exited 2',
    evidence: { exitCode: 2 },
  });

  assert.deepEqual(failure, {
    category: 'non-zero-command',
    detail: 'command exited 2',
  });
});

test('classifySmokeFailure: falls back to unspecified with deterministic detail', () => {
  const failure = classifySmokeFailure({});

  assert.deepEqual(failure, {
    category: 'unspecified',
    detail: 'smoke test failed without structured evidence',
  });
});

test('validateSmokeResults: normalizes pass, fail, and skipped-unbudgeted results with summary counts', () => {
  const result = validateSmokeResults([
    { agentName: 'general', class: 'general-research', status: 'pass' },
    {
      agentName: 'explore',
      class: 'readonly-codebase-question',
      status: 'fail',
      detail: 'grep permission missing',
      evidence: { missingTool: 'grep' },
    },
    {
      agentName: 'operator-escape',
      class: 'operator-escape',
      status: 'skipped-unbudgeted',
      skip: {
        reason: 'operator-escape-hatch',
        explanation: 'operator disabled budget enforcement for this agent',
      },
    },
  ], catalog(), metadata());

  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.value.summary, {
    resultCount: 3,
    passCount: 1,
    failCount: 1,
    skippedUnbudgetedCount: 1,
  });
  assert.deepEqual(result.value.results.map((entry) => entry.agentName), ['explore', 'general', 'operator-escape']);
  const failed = result.value.results.find((entry) => entry.agentName === 'explore');
  assert.deepEqual(failed.failure, {
    category: 'denied-required-tool',
    detail: 'grep permission missing',
    missingCapability: 'grep',
  });
});

test('validateSmokeResults: rejects unknown agent, class mismatch, unknown catalog class, bad fail, and bad skip', () => {
  const result = validateSmokeResults([
    { agentName: 'ghost', class: 'general-research', status: 'pass' },
    { agentName: 'explore', class: 'general-research', status: 'pass' },
    { agentName: 'general', class: 'not-in-catalog', status: 'pass' },
    { agentName: 'explore', class: 'readonly-codebase-question', status: 'fail', failure: { category: 'missing-instruction' } },
    { agentName: 'operator-escape', class: 'operator-escape', status: 'skipped-unbudgeted', skip: { reason: 'manual' } },
  ], catalog(), metadata());

  assert.equal(result.ok, false);
  const fields = result.errors.map((error) => error.field);
  assert.ok(fields.includes('agentName'), JSON.stringify(result.errors));
  assert.ok(fields.includes('class'), JSON.stringify(result.errors));
  assert.ok(fields.includes('failure.detail'), JSON.stringify(result.errors));
  assert.ok(fields.includes('skip.reason'), JSON.stringify(result.errors));
});

test('validateSmokeResults: rejects fail results without explicit non-empty failure detail', () => {
  const result = validateSmokeResults([
    {
      agentName: 'explore',
      class: 'readonly-codebase-question',
      status: 'fail',
      evidence: { missingTool: 'grep' },
    },
  ], catalog(), metadata());

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.field === 'failure.detail'),
    JSON.stringify(result.errors),
  );
});

test('validateSmokeResults: rejects catalog class entries assigned to a different agent', () => {
  const badCatalog = catalog();
  badCatalog.smokeDefinitions = badCatalog.smokeDefinitions.map((definition) => (
    definition.class === 'general-research'
      ? { ...definition, agentName: 'explore' }
      : definition
  ));

  const result = validateSmokeResults([
    { agentName: 'general', class: 'general-research', status: 'pass' },
  ], badCatalog, metadata());

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.field === 'class' && /general-research/.test(error.message) && /general/.test(error.message)),
    JSON.stringify(result.errors),
  );
});

test('compareReports: smoke failures include category, missingCapability, and detail while skipped results do not fail', () => {
  const report = compareReports(parseFixture('cost-report-valid.json'), parseFixture('validation-pass-post.json'), {
    smokeResults: [
      {
        agentName: 'explore',
        class: 'readonly-codebase-question',
        status: 'fail',
        failure: {
          category: 'missing-instruction',
          detail: 'memory startup check missing',
          missingCapability: 'memory-workflow',
        },
      },
      {
        agentName: 'operator-escape',
        class: 'operator-escape',
        status: 'skipped-unbudgeted',
        skip: { reason: 'operator-escape-hatch', explanation: 'operator disabled budget enforcement' },
      },
    ],
  });

  assert.equal(report.status, 'fail');
  const failures = report.failures.filter((failure) => failure.kind === 'smoke-failure');
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    kind: 'smoke-failure',
    agentName: 'explore',
    category: 'missing-instruction',
    detail: 'memory startup check missing',
    hint: {
      kind: 'insufficient-agent-budget',
      message: "Budget is insufficient for explore; widen that agent's permission or instruction profile, not the global budget. Missing capability: memory-workflow.",
    },
    missingCapability: 'memory-workflow',
  });
});

test('renderValidationReportMarkdown: smoke failures show category and missing capability', () => {
  const report = compareReports(parseFixture('cost-report-valid.json'), parseFixture('validation-pass-post.json'), {
    smokeResults: [
      {
        agentName: 'general',
        status: 'fail',
        failure: {
          category: 'denied-required-tool',
          detail: 'webfetch was denied',
          missingCapability: 'webfetch',
        },
      },
    ],
  });

  const markdown = renderValidationReportMarkdown(report);

  assert.match(markdown, /smoke-failure: general/);
  assert.match(markdown, /denied-required-tool/);
  assert.match(markdown, /webfetch/);
  assert.match(markdown, /webfetch was denied/);
  assert.match(markdown, /Hint: Budget is insufficient for general/);
  assert.match(markdown, /not the global budget/);
});
