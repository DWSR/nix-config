'use strict';

/*
 * e2e-fixture.test.js — Task 8.1 fixture-level validation.
 *
 * Exercises the full committed-fixture path in-process: rendered budget
 * metadata + diagnostic audit, metadata + smoke catalog smoke-plan,
 * smoke-result normalization, and validation comparison/rendering.
 * No live host activation or live agent execution occurs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../../../scripts/subagent-context-budget.js');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const SMOKE_CATALOG_PATH = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/smoke-catalog.json',
);

const {
  buildAuditReport,
  buildSmokePlan,
  compareReports,
  parseReport,
  renderAuditReportJson,
  renderAuditReportMarkdown,
  renderSmokePlanJson,
  renderSmokePlanMarkdown,
  renderValidationReportJson,
  renderValidationReportMarkdown,
  stableSortKeys,
  validateSmokeResults,
} = require(CLI_PATH);

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadFixture(name) {
  return loadJson(path.join(FIXTURES_DIR, name));
}

function parseFixture(name) {
  const parsed = parseReport(loadFixture(name));
  assert.equal(parsed.ok, true, `fixture ${name} must parse; got ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function unwrapResult(label, result) {
  assert.equal(result.ok, true, `${label} must succeed; got ${JSON.stringify(result.error || result.errors)}`);
  return result.value;
}

function buildEscapeHatchMetadata() {
  const metadata = loadFixture('budget-metadata.json');
  metadata.agents.general = {
    ...metadata.agents.general,
    state: { kind: 'unbudgeted', reason: 'operator-escape-hatch' },
    instructionProfile: '',
    permissionBudget: {},
    capabilityRationale: [],
  };
  return metadata;
}

function buildSnapshots() {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadJson(SMOKE_CATALOG_PATH);
  const audit = unwrapResult('audit report', buildAuditReport(metadata, loadFixture('cost-report-valid.json')));
  const smokePlan = unwrapResult('smoke plan', buildSmokePlan(metadata, catalog));

  const smokeResults = unwrapResult('smoke results', validateSmokeResults([
    { agentName: 'explore', class: 'readonly-codebase-question', status: 'pass' },
    { agentName: 'general', class: 'general-research', status: 'pass' },
  ], catalog, metadata));

  const baseline = parseFixture('cost-report-valid.json');
  const passingPost = parseFixture('validation-pass-post.json');
  const thresholdFailPost = parseFixture('validation-threshold-fail-post.json');
  const residualBaseline = parseFixture('validation-residual-heavy-baseline.json');
  const residualPost = parseFixture('validation-residual-heavy-post.json');

  const validationPass = compareReports(baseline, passingPost, {
    smokeResults: smokeResults.results,
  });
  const validationFail = compareReports(baseline, thresholdFailPost, {
    smokeResults: smokeResults.results,
  });
  const smokeFailureValidation = compareReports(baseline, passingPost, {
    smokeResults: unwrapResult('failed smoke results', validateSmokeResults([
      { agentName: 'explore', class: 'readonly-codebase-question', status: 'pass' },
      {
        agentName: 'general',
        class: 'general-research',
        status: 'fail',
        failure: {
          category: 'denied-required-tool',
          detail: 'webfetch permission denied during representative research task',
          missingCapability: 'webfetch',
        },
      },
    ], catalog, metadata)).results,
  });
  const residualValidation = compareReports(residualBaseline, residualPost, {
    smokeResults: smokeResults.results,
  });

  const escapeMetadata = buildEscapeHatchMetadata();
  const escapeAudit = unwrapResult(
    'escape-hatch audit report',
    buildAuditReport(escapeMetadata, loadFixture('cost-report-valid.json')),
  );
  const escapeSmokePlan = unwrapResult('escape-hatch smoke plan', buildSmokePlan(escapeMetadata, catalog));
  const escapeSmokeResults = unwrapResult('escape-hatch smoke results', validateSmokeResults([
    { agentName: 'explore', class: 'readonly-codebase-question', status: 'pass' },
    {
      agentName: 'general',
      class: 'general-research',
      status: 'skipped-unbudgeted',
      skip: {
        reason: 'operator-escape-hatch',
        explanation: 'general budget enforcement is disabled for this fixture',
      },
    },
  ], catalog, escapeMetadata));
  const escapeValidation = compareReports(baseline, passingPost, {
    smokeResults: escapeSmokeResults.results,
  });

  return stableSortKeys({
    audit,
    escapeHatch: {
      audit: escapeAudit,
      smokePlan: escapeSmokePlan,
      smokeResults: escapeSmokeResults,
      validation: escapeValidation,
    },
    residualValidation,
    smokeFailureValidation,
    smokePlan,
    smokeResults,
    validationFail,
    validationPass,
  });
}

function compactSnapshots(snapshots) {
  const agentStates = (report) => Object.fromEntries(
    report.agents.map((agent) => [agent.name, agent.state.kind]),
  );
  const smokeStates = (plan) => Object.fromEntries(
    plan.entries.map((entry) => [entry.agentName, entry.state]),
  );
  const validationSummary = (report) => ({
    status: report.status,
    reductionPct: report.reductionPct,
    failures: report.failures,
    hints: report.hints,
    byAgent: report.byAgent,
    residualAgentTokens: report.residualAgentTokens,
  });

  return stableSortKeys({
    audit: {
      agentStates: agentStates(snapshots.audit),
      observedTools: Object.fromEntries(
        snapshots.audit.agents.map((agent) => [agent.name, agent.observedTools]),
      ),
      summary: snapshots.audit.summary,
    },
    escapeHatch: {
      auditAgentStates: agentStates(snapshots.escapeHatch.audit),
      smokePlanStates: smokeStates(snapshots.escapeHatch.smokePlan),
      smokeResultsSummary: snapshots.escapeHatch.smokeResults.summary,
      validation: validationSummary(snapshots.escapeHatch.validation),
    },
    residualValidation: validationSummary(snapshots.residualValidation),
    smokeFailureValidation: validationSummary(snapshots.smokeFailureValidation),
    smokePlan: {
      states: smokeStates(snapshots.smokePlan),
      summary: snapshots.smokePlan.summary,
    },
    smokeResultsSummary: snapshots.smokeResults.summary,
    validationFail: validationSummary(snapshots.validationFail),
    validationPass: validationSummary(snapshots.validationPass),
  });
}

function assertNoSensitiveContent(serialized) {
  for (const forbidden of [
    'promptBody',
    'toolOutputBody',
    'SECRET-PROMPT-PAYLOAD',
    'SECRET-TOOL-OUTPUT-PAYLOAD',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `must not include ${forbidden}`);
  }
}

test('e2e fixture path matches committed golden snapshots', () => {
  const actual = compactSnapshots(buildSnapshots());
  const expected = loadFixture('e2e-fixture-golden.json');

  assert.deepEqual(actual, expected);
});

test('e2e pass path keeps audit, smoke, and validation artifacts internally consistent', () => {
  const snapshots = buildSnapshots();
  const auditAgentNames = snapshots.audit.agents.map((agent) => agent.name);
  const smokeAgentNames = snapshots.smokePlan.entries.map((entry) => entry.agentName);
  const validationAgentNames = Object.keys(snapshots.validationPass.byAgent);

  assert.deepEqual(auditAgentNames, ['explore', 'general']);
  assert.deepEqual(smokeAgentNames, auditAgentNames);
  assert.deepEqual(validationAgentNames, auditAgentNames);
  assert.equal(snapshots.validationPass.status, 'pass');
  assert.equal(snapshots.validationPass.failures.length, 0);
  assert.equal(snapshots.smokePlan.entries.every((entry) => entry.state !== 'placeholder'), true);

  assertNoSensitiveContent([
    renderAuditReportJson(snapshots.audit),
    renderAuditReportMarkdown(snapshots.audit),
    renderSmokePlanJson(snapshots.smokePlan),
    renderSmokePlanMarkdown(snapshots.smokePlan),
    renderValidationReportJson(snapshots.validationPass),
    renderValidationReportMarkdown(snapshots.validationPass),
  ].join('\n'));
});

test('e2e fail paths include actionable JSON and Markdown hints', () => {
  const snapshots = buildSnapshots();
  const thresholdJson = renderValidationReportJson(snapshots.validationFail);
  const thresholdMarkdown = renderValidationReportMarkdown(snapshots.validationFail);
  const smokeJson = renderValidationReportJson(snapshots.smokeFailureValidation);
  const smokeMarkdown = renderValidationReportMarkdown(snapshots.smokeFailureValidation);

  assert.equal(snapshots.validationFail.status, 'fail');
  assert.ok(thresholdJson.includes('threshold-failure'));
  assert.ok(thresholdJson.includes('40% target'));
  assert.ok(thresholdMarkdown.includes('Hint:'));
  assert.ok(thresholdMarkdown.includes('recapture the post report'));

  const smokeFailure = snapshots.smokeFailureValidation.failures.find((failure) => failure.kind === 'smoke-failure');
  assert.ok(smokeFailure, 'smoke failure must be present');
  assert.equal(smokeFailure.agentName, 'general');
  assert.equal(smokeFailure.category, 'denied-required-tool');
  assert.ok(smokeFailure.hint.message.includes('webfetch'));
  assert.ok(smokeJson.includes('general'));
  assert.ok(smokeMarkdown.includes('category=denied-required-tool'));
});

test('e2e escape hatch and residual paths retain required validation semantics', () => {
  const snapshots = buildSnapshots();

  const unbudgetedAuditAgent = snapshots.escapeHatch.audit.agents.find((agent) => agent.name === 'general');
  const skippedPlanEntry = snapshots.escapeHatch.smokePlan.entries.find((entry) => entry.agentName === 'general');
  assert.equal(unbudgetedAuditAgent.state.kind, 'unbudgeted');
  assert.equal(skippedPlanEntry.state, 'skipped-unbudgeted');
  assert.equal(snapshots.escapeHatch.smokeResults.summary.skippedUnbudgetedCount, 1);
  assert.equal(snapshots.escapeHatch.validation.status, 'pass');
  assert.equal(
    snapshots.escapeHatch.validation.failures.some((failure) => failure.kind === 'smoke-failure'),
    false,
  );

  assert.equal(snapshots.residualValidation.residualAgentTokens, 800);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshots.residualValidation.byAgent, 'unknown'), false);
  assert.ok(
    snapshots.residualValidation.hints.some((hint) => hint.kind === 'residual-heavy-attribution'),
    'residual-heavy path must include residual attribution hint',
  );
  assert.ok(renderValidationReportMarkdown(snapshots.residualValidation).includes('Residual buckets are not credited'));
});
