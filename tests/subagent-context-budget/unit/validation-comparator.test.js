'use strict';

/*
 * validation-comparator.test.js — ValidationComparator unit and CLI
 * tests for task 4.3.
 *
 * Exercises the `compareReports` API and the `validate` CLI dispatcher
 * against fixture-driven pass / threshold-fail / missing-field /
 * residual-heavy cases (Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6,
 * 6.4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../../../scripts/subagent-context-budget.js');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

const {
  compareReports,
  main,
  parseReport,
  renderValidationReportJson,
  renderValidationReportMarkdown,
} = require(CLI_PATH);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function parseFixture(name) {
  const parsed = parseReport(loadFixture(name));
  assert.equal(parsed.ok, true, `fixture ${name} must parse; got error ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function captureMain(argv) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    return {
      exitCode: main(argv),
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function writeTempJson(prefix, body) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

// ---------------------------------------------------------------------
// R5.1, R5.2, R5.3, R5.4: pass-case validation.
// ---------------------------------------------------------------------

test('compareReports: pass when post per-parent tokens are >=40% below baseline (R5.1, R5.2, R5.3, R5.4)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post);

  assert.equal(report.status, 'pass');
  // baseline = 1500 / 2 sessions = 750
  assert.equal(report.baselineTokensPerParent, 750);
  // post = 800 / 2 sessions = 400
  assert.equal(report.postTokensPerParent, 400);
  // reduction = (750-400)/750 * 100 ≈ 46.67%
  assert.ok(report.reductionPct >= 40,
    `reductionPct must be >= 40 for pass case; got ${report.reductionPct}`);
  assert.deepEqual(report.failures, []);
});

test('compareReports: pass report includes per-agent breakdown for agents present in both reports (R5.5)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post);

  // explore: baseline 800, post 400 → 50% reduction
  assert.ok(Object.prototype.hasOwnProperty.call(report.byAgent, 'explore'),
    'byAgent must include explore');
  assert.equal(report.byAgent.explore.baselineTokens, 800);
  assert.equal(report.byAgent.explore.postTokens, 400);
  // general: baseline 400, post 200 → 50% reduction
  assert.equal(report.byAgent.general.baselineTokens, 400);
  assert.equal(report.byAgent.general.postTokens, 200);
  // The residual sentinel (`unknown`) must NEVER appear as a named agent (R5.5).
  assert.equal(Object.prototype.hasOwnProperty.call(report.byAgent, 'unknown'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.byAgent, 'null'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.byAgent, ''), false);
});

// ---------------------------------------------------------------------
// R5.4: threshold-failure.
// ---------------------------------------------------------------------

test('compareReports: fails with threshold-not-met when reduction <40% (R5.4)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-threshold-fail-post.json');

  const report = compareReports(baseline, post);

  assert.equal(report.status, 'fail');
  // baseline 750 vs post 1200/2 = 600 → reduction 20%
  assert.equal(report.baselineTokensPerParent, 750);
  assert.equal(report.postTokensPerParent, 600);
  const threshold = report.failures.find((f) => f.kind === 'threshold-not-met');
  assert.ok(threshold, 'must include a threshold-not-met failure');
  assert.equal(threshold.requiredPct, 40);
  assert.ok(threshold.actualPct < 40,
    `actualPct must reflect the under-threshold reduction; got ${threshold.actualPct}`);
  assert.equal(threshold.hint.kind, 'threshold-failure');
  assert.ok(threshold.hint.message.includes('40% target'));
  assert.ok(threshold.hint.message.includes('audit output'));
});

test('renderValidationReportJson/Markdown: threshold failure includes actionable remediation hint (R5.4)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-threshold-fail-post.json');

  const report = compareReports(baseline, post);
  const json = renderValidationReportJson(report);
  const md = renderValidationReportMarkdown(report);

  assert.ok(json.includes('threshold-failure'));
  assert.ok(json.includes('40% target'));
  assert.ok(md.includes('Hint:'));
  assert.ok(md.includes('run smoke plan'));
  assert.ok(md.includes('recapture the post report'));
});

// ---------------------------------------------------------------------
// R5.6: missing-diagnostic-field for empty inputs.
// ---------------------------------------------------------------------

test('compareReports: fails with missing-diagnostic-field when post has zero sessions (R5.6)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-empty-sessions.json');

  const report = compareReports(baseline, post);

  assert.equal(report.status, 'fail');
  const missing = report.failures.find((f) => f.kind === 'missing-diagnostic-field');
  assert.ok(missing, 'must include a missing-diagnostic-field failure');
  assert.ok(typeof missing.field === 'string' && missing.field.length > 0,
    'failure must name the missing field');
  assert.equal(missing.hint.kind, 'missing-diagnostic-field');
  assert.ok(missing.hint.message.includes(missing.field));
  assert.ok(missing.hint.message.includes('opencode-cost-report --format json > "$REPORT"'));
});

test('compareReports: fails with missing-diagnostic-field when baseline has zero sessions (R5.6)', () => {
  const baseline = parseFixture('validation-empty-sessions.json');
  const post = parseFixture('cost-report-valid.json');

  const report = compareReports(baseline, post);

  assert.equal(report.status, 'fail');
  const missing = report.failures.find((f) => f.kind === 'missing-diagnostic-field');
  assert.ok(missing, 'must include a missing-diagnostic-field failure');
});

test('compareReports: fails with missing-diagnostic-field when baseline tokens-per-parent is zero (R5.6)', () => {
  const baseline = {
    sessions: [
      {
        sessionID: 's-zero',
        project: null,
        subagentDispatchTokens: 0,
        subagentDispatchByAgent: null,
        residualAgentTokens: 0,
      },
    ],
    global: {
      subagentDispatchTokens: 0,
      subagentDispatchByAgent: null,
      residualAgentTokens: 0,
    },
  };
  const post = parseFixture('cost-report-valid.json');

  const report = compareReports(baseline, post);

  assert.equal(report.status, 'fail');
  assert.ok(
    report.failures.some((f) => f.kind === 'missing-diagnostic-field'),
    'must surface missing-diagnostic-field when baseline tokens are zero',
  );
});

// ---------------------------------------------------------------------
// R5.5: residual exclusion.
// ---------------------------------------------------------------------

test('compareReports: residual-heavy report keeps residual tokens out of named-agent credit (R5.5)', () => {
  const baseline = parseFixture('validation-residual-heavy-baseline.json');
  const post = parseFixture('validation-residual-heavy-post.json');

  const report = compareReports(baseline, post);

  // explore: baseline 1500, post 200. The named-agent post tokens
  // must NOT include the residual 800; if residual were credited,
  // postTokens would be larger.
  assert.equal(report.byAgent.explore.baselineTokens, 1500);
  assert.equal(report.byAgent.explore.postTokens, 200);
  // general: baseline 500, post 100. Same residual exclusion.
  assert.equal(report.byAgent.general.baselineTokens, 500);
  assert.equal(report.byAgent.general.postTokens, 100);
  // Residual share is reported separately (post side).
  assert.equal(report.residualAgentTokens, 800);
  assert.ok(Array.isArray(report.hints), 'report must include hints array for report-level remediation');
  const residualHint = report.hints.find((hint) => hint.kind === 'residual-heavy-attribution');
  assert.ok(residualHint, 'residual-heavy report must include residual attribution hint');
  assert.ok(residualHint.message.includes('Residual buckets are not credited to named agents'));
  assert.ok(residualHint.message.includes('per-agent attribution'));
  // Residual must never appear in the named map.
  assert.equal(Object.prototype.hasOwnProperty.call(report.byAgent, 'unknown'), false);
});

test('renderValidationReportMarkdown: residual-heavy report includes residual attribution hint (R5.5)', () => {
  const baseline = parseFixture('validation-residual-heavy-baseline.json');
  const post = parseFixture('validation-residual-heavy-post.json');

  const md = renderValidationReportMarkdown(compareReports(baseline, post));

  assert.ok(md.includes('## Hints'));
  assert.ok(md.includes('Residual buckets are not credited to named agents'));
  assert.ok(md.includes('per-agent attribution'));
});

// ---------------------------------------------------------------------
// R6.4: smoke-failure surfacing.
// ---------------------------------------------------------------------

test('compareReports: appends smoke-failure when smokeResults include a failed agent (R6.4)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post, {
    smokeResults: [
      { agentName: 'explore', status: 'pass' },
      { agentName: 'general', status: 'fail', detail: 'missing webfetch' },
    ],
  });

  assert.equal(report.status, 'fail');
  const smoke = report.failures.find((f) => f.kind === 'smoke-failure');
  assert.ok(smoke, 'must surface smoke-failure');
  assert.equal(smoke.agentName, 'general');
});

test('compareReports: denied-required-tool smoke failure includes per-agent widening hint with missing capability (R6.3)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post, {
    smokeResults: [
      {
        agentName: 'general',
        status: 'fail',
        detail: 'webfetch permission denied',
        failure: {
          category: 'denied-required-tool',
          detail: 'webfetch permission denied',
          missingCapability: 'webfetch',
        },
      },
    ],
  });

  const smoke = report.failures.find((f) => f.kind === 'smoke-failure');
  assert.ok(smoke, 'must surface smoke-failure');
  assert.equal(smoke.category, 'denied-required-tool');
  assert.equal(smoke.hint.kind, 'insufficient-agent-budget');
  assert.ok(smoke.hint.message.includes('general'));
  assert.ok(smoke.hint.message.includes('widen that agent'));
  assert.ok(smoke.hint.message.includes('not the global budget'));
  assert.ok(smoke.hint.message.includes('webfetch'));
});

test('compareReports: omits smoke-failure when smokeResults are not provided (R6.4)', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post);

  assert.equal(
    report.failures.some((f) => f.kind === 'smoke-failure'),
    false,
    'must not invent smoke failures when smokeResults is undefined',
  );
});

test('compareReports: omits smoke-failure when every smokeResult passes', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post, {
    smokeResults: [
      { agentName: 'explore', status: 'pass' },
      { agentName: 'general', status: 'pass' },
    ],
  });

  assert.equal(
    report.failures.some((f) => f.kind === 'smoke-failure'),
    false,
  );
});

// ---------------------------------------------------------------------
// Plugin self-check surfacing.
// ---------------------------------------------------------------------

test('compareReports: surfaces plugin-self-check-failed when pluginSelfCheck status is failed', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post, {
    pluginSelfCheck: { status: 'failed', detail: 'hook unavailable' },
  });

  assert.equal(report.status, 'fail');
  const selfCheck = report.failures.find((f) => f.kind === 'plugin-self-check-failed');
  assert.ok(selfCheck, 'must surface plugin-self-check-failed failure');
  assert.equal(selfCheck.detail, 'hook unavailable');
  assert.equal(selfCheck.hint.kind, 'plugin-self-check');
  assert.ok(selfCheck.hint.message.includes('subagent-context-budget-smoke-test'));
  assert.ok(selfCheck.hint.message.includes('opencode app logs'));
  assert.ok(selfCheck.hint.message.includes('plugin metadata/self-check status'));
});

test('compareReports: ignores pluginSelfCheck when status is passed', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post, {
    pluginSelfCheck: { status: 'passed', detail: 'ok' },
  });

  assert.equal(report.status, 'pass');
});

// ---------------------------------------------------------------------
// Deterministic output (no wall-clock; identical input → identical bytes).
// ---------------------------------------------------------------------

test('compareReports: identical input produces byte-identical JSON output (determinism)', () => {
  const baseline1 = parseFixture('cost-report-valid.json');
  const post1 = parseFixture('validation-pass-post.json');
  const baseline2 = parseFixture('cost-report-valid.json');
  const post2 = parseFixture('validation-pass-post.json');

  const a = compareReports(baseline1, post1);
  const b = compareReports(baseline2, post2);

  assert.equal(renderValidationReportJson(a), renderValidationReportJson(b));
});

test('renderValidationReportJson: top-level and byAgent object keys are alphabetical', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const report = compareReports(baseline, post);
  const serialized = renderValidationReportJson(report);
  const reparsed = JSON.parse(serialized);

  assert.deepEqual(Object.keys(reparsed), Object.keys(reparsed).slice().sort());
  assert.deepEqual(Object.keys(reparsed.byAgent), Object.keys(reparsed.byAgent).slice().sort());
});

test('renderValidationReportJson: serialized output contains no wall-clock fields', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const serialized = renderValidationReportJson(compareReports(baseline, post));
  for (const term of ['generatedAt', 'timestamp', 'createdAt', new Date().getFullYear().toString()]) {
    assert.equal(serialized.includes(term), false,
      `serialized JSON must not include ${term}`);
  }
});

// ---------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------

test('renderValidationReportMarkdown: byte-stable for identical input', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-pass-post.json');

  const a = compareReports(baseline, post);
  const b = compareReports(baseline, post);

  assert.equal(renderValidationReportMarkdown(a), renderValidationReportMarkdown(b));
});

test('renderValidationReportMarkdown: surfaces status, threshold details, and per-agent breakdown', () => {
  const baseline = parseFixture('cost-report-valid.json');
  const post = parseFixture('validation-threshold-fail-post.json');

  const md = renderValidationReportMarkdown(compareReports(baseline, post));

  assert.ok(md.startsWith('#'), 'markdown must begin with a heading');
  assert.ok(md.toLowerCase().includes('status'), 'must mention status');
  assert.ok(md.includes('explore'), 'must mention agent explore in per-agent breakdown');
  assert.ok(md.includes('general'), 'must mention agent general in per-agent breakdown');
});

// ---------------------------------------------------------------------
// Privacy posture (R5.7 — comparator must not leak content).
// ---------------------------------------------------------------------

test('compareReports: serialized JSON never contains prompt or tool-output body content (R5.7)', () => {
  // Build baseline / post from cost-report-with-content via parseReport
  // — the parser already strips body content, but verify the
  // comparator does not reintroduce it.
  const baseline = parseFixture('cost-report-with-content.json');
  const post = parseFixture('cost-report-with-content.json');
  const report = compareReports(baseline, post);
  const serialized = renderValidationReportJson(report);

  assert.equal(serialized.includes('promptBody'), false);
  assert.equal(serialized.includes('toolOutputBody'), false);
  assert.equal(serialized.includes('SECRET-PROMPT-PAYLOAD'), false);
  assert.equal(serialized.includes('SECRET-TOOL-OUTPUT-PAYLOAD'), false);
});

// ---------------------------------------------------------------------
// CLI integration (`main(validate ...)`).
// ---------------------------------------------------------------------

test('main(validate --baseline --post): emits JSON validation report and exits 0', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.command, 'validate');
  assert.notEqual(report.status, 'placeholder');
  assert.equal(report.status, 'pass');
});

test('main(validate): exits 1 when threshold-fail post fixture is supplied', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-threshold-fail-post.json');

  const { exitCode, stdout } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
  ]);

  // Status fail must produce non-zero exit so operators notice in CI.
  assert.equal(exitCode, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'fail');
  assert.ok(
    report.failures.some((f) => f.kind === 'threshold-not-met'),
    'CLI report must include threshold-not-met failure',
  );
});

test('main(validate --format markdown): emits Markdown validation report', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
    '--format', 'markdown',
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  assert.equal(stdout.trimStart().startsWith('#'), true);
});

test('main(validate): same input produces byte-stable output across two invocations (determinism)', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const a = captureMain(['validate', '--baseline', baselinePath, '--post', postPath]);
  const b = captureMain(['validate', '--baseline', baselinePath, '--post', postPath]);

  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.equal(a.stdout, b.stdout);
});

test('main(validate): exits 1 with named error when --baseline is missing', () => {
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--post', postPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--baseline'));
});

test('main(validate): exits 1 with named error when --post is missing', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', baselinePath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--post'));
});

test('main(validate): exits 1 on pricing-drift baseline and prints actionable reason', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-pricing-drift.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('pricing-drift'),
    `stderr must mention pricing-drift; got: ${stderr}`);
});

test('main(validate): exits 1 on missing-diagnostic-field with empty-sessions post fixture (R5.6)', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-empty-sessions.json');

  const { exitCode, stdout } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
  ]);

  assert.equal(exitCode, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'fail');
  assert.ok(report.failures.some((f) => f.kind === 'missing-diagnostic-field'));
});

test('main(validate): with --metadata accepts the optional flag and still emits a real report', () => {
  // metadata is optional and currently only consumed for richer
  // rendering; absent or present, the report shape stays stable.
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-valid.json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
    '--metadata', metadataPath,
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.command, 'validate');
  assert.notEqual(report.status, 'placeholder');
});

test('main(validate): emitted JSON does not include prompt or tool-output body content (R5.7)', () => {
  const baselinePath = path.join(FIXTURES_DIR, 'cost-report-with-content.json');
  const postPath = path.join(FIXTURES_DIR, 'cost-report-with-content.json');

  const { exitCode, stdout } = captureMain([
    'validate',
    '--baseline', baselinePath,
    '--post', postPath,
  ]);

  // Either pass (0) or fail (1) is acceptable here; we only test
  // privacy of the serialized output.
  assert.ok(exitCode === 0 || exitCode === 1);
  assert.equal(stdout.includes('promptBody'), false);
  assert.equal(stdout.includes('toolOutputBody'), false);
  assert.equal(stdout.includes('SECRET-PROMPT-PAYLOAD'), false);
  assert.equal(stdout.includes('SECRET-TOOL-OUTPUT-PAYLOAD'), false);
});

test('main(validate): exits 1 when baseline file does not exist', () => {
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  const { exitCode, stdout, stderr } = captureMain([
    'validate',
    '--baseline', path.join(os.tmpdir(), 'nonexistent-baseline-file.json'),
    '--post', postPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.length > 0);
});

test('main(validate): rejects malformed JSON in --baseline', () => {
  const malformedPath = writeTempJson('malformed', '{not json');
  // Overwrite with truly malformed JSON.
  fs.writeFileSync(malformedPath, '{not json');
  const postPath = path.join(FIXTURES_DIR, 'validation-pass-post.json');

  try {
    const { exitCode, stdout, stderr } = captureMain([
      'validate',
      '--baseline', malformedPath,
      '--post', postPath,
    ]);

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.ok(stderr.length > 0);
  } finally {
    fs.unlinkSync(malformedPath);
  }
});
