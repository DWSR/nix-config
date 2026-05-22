'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../../../scripts/subagent-context-budget.js');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

const {
  buildAuditReport,
  main,
  renderAuditReportJson,
  renderAuditReportMarkdown,
} = require(CLI_PATH);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
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
// R1.1, R1.2, R1.5: report enumerates every configured subagent with
// instruction context, exposed tool context, observed tools, and
// first-turn token count separated into named branches.
// ---------------------------------------------------------------------

test('buildAuditReport: matches golden audit fixture for valid metadata and diagnostic (R1.1, R1.2, R1.3, R1.5, R4.2)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');
  const expected = loadFixture('audit-report-golden.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true, `buildAuditReport must succeed; got error ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.value, expected);
});

test('buildAuditReport: enumerates every agent configured in metadata (R1.1)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  const names = result.value.agents.map((agent) => agent.name);
  assert.deepEqual(names, ['explore', 'general']);
  assert.equal(result.value.summary.agentCount, 2);
});

test('buildAuditReport: separates instructionContext, exposedToolContext, observedTools, baselineDelta, firstTurnInputTokens into named branches (R1.5)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  for (const agent of result.value.agents) {
    assert.ok(agent.instructionContext, 'agent must expose instructionContext branch');
    assert.ok(agent.exposedToolContext, 'agent must expose exposedToolContext branch');
    assert.ok(agent.observedTools, 'agent must expose observedTools branch');
    assert.ok(agent.baselineDelta, 'agent must expose baselineDelta branch');
    assert.ok(Object.prototype.hasOwnProperty.call(agent, 'firstTurnInputTokens'),
      'agent must expose firstTurnInputTokens branch');
    // These dimensions must not collapse into each other.
    assert.notStrictEqual(agent.instructionContext, agent.exposedToolContext);
    assert.notStrictEqual(agent.observedTools, agent.baselineDelta);
  }
});

// ---------------------------------------------------------------------
// R1.4: missing recent usage marked absent.
// ---------------------------------------------------------------------

test('buildAuditReport: marks observedTools absent when diagnostic has no entry for the agent (R1.4)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-residual-only.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  for (const agent of result.value.agents) {
    assert.deepEqual(agent.observedTools, { kind: 'absent' });
  }
});

test('buildAuditReport: marks observedTools absent for agents not present in diagnostic even when other agents are present (R1.4)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');
  // Drop one agent's data from the global map and from every session map.
  diagnostic.global.cost.subagentDispatchByAgent = { explore: 800 };
  diagnostic.global.cost.subagentDispatch = 800;
  for (const proj of diagnostic.projects) {
    for (const ses of proj.sessions) {
      const byAgent = ses.cost.subagentDispatchByAgent;
      if (byAgent && Object.prototype.hasOwnProperty.call(byAgent, 'general')) {
        delete byAgent.general;
      }
    }
  }

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  const explore = result.value.agents.find((a) => a.name === 'explore');
  const general = result.value.agents.find((a) => a.name === 'general');
  assert.deepEqual(explore.observedTools, { kind: 'observed', tokenCount: 800 });
  assert.deepEqual(general.observedTools, { kind: 'absent' });
});

test('buildAuditReport: does not infer firstTurnInputTokens when no measurement source is present (R1.2, R1.4)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  for (const agent of result.value.agents) {
    assert.equal(agent.firstTurnInputTokens, null,
      `agent ${agent.name} firstTurnInputTokens must be null without a measurement source`);
  }
});

// ---------------------------------------------------------------------
// R4.2, R4.3: baseline delta reporting.
// ---------------------------------------------------------------------

test('buildAuditReport: reports baseline-placeholder delta when minimal baseline has placeholder measurement (R4.2, R4.3)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  for (const agent of result.value.agents) {
    assert.deepEqual(agent.baselineDelta, { kind: 'baseline-placeholder' });
  }
});

test('buildAuditReport: reports measured baseline delta when minimal baseline has measured tokens (R4.2, R4.3)', () => {
  const metadata = loadFixture('budget-metadata.json');
  metadata.minimalBaseline.measuredTokens = {
    status: 'measured',
    firstTurnInput: 1200,
    measuredAt: '2026-05-22T10:00:00Z',
    source: 'first-turn-capture-script',
  };
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  for (const agent of result.value.agents) {
    // firstTurnInputTokens is absent for all agents in this task; delta is therefore absent.
    assert.deepEqual(agent.baselineDelta, {
      kind: 'measured',
      baselineTokens: 1200,
      observedTokens: null,
      deltaTokens: null,
    });
  }
});

// ---------------------------------------------------------------------
// R7.3: host-specific tool surfaces.
// ---------------------------------------------------------------------

test('buildAuditReport: host=all leaves hostSpecificAgents empty (R7.3)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  assert.equal(result.value.host, 'all');
  assert.deepEqual(result.value.summary.hostSpecificAgents, []);
});

test('buildAuditReport: non-"all" host scope surfaces host-specific agents separately (R7.3)', () => {
  const metadata = loadFixture('budget-metadata.json');
  metadata.host = 'shopify';
  metadata.agents.shopify_helper = {
    name: 'shopify_helper',
    source: 'host-markdown',
    hostScope: 'shopify',
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'shopify-helper',
    permissionBudget: { read: 'allow', glob: 'allow' },
    capabilityRationale: [],
    smokeClass: 'shopify-helper-task',
  };
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  assert.equal(result.value.host, 'shopify');
  assert.deepEqual(result.value.summary.hostSpecificAgents, ['shopify_helper']);
  // Common agents are NOT in the host-specific list.
  for (const name of ['explore', 'general']) {
    assert.equal(result.value.summary.hostSpecificAgents.includes(name), false);
  }
});

// ---------------------------------------------------------------------
// Unbudgeted state.
// ---------------------------------------------------------------------

test('buildAuditReport: counts unbudgeted agents separately in summary', () => {
  const metadata = loadFixture('budget-metadata.json');
  metadata.agents.general.state = { kind: 'unbudgeted', reason: 'operator-escape-hatch' };
  delete metadata.agents.general.instructionProfile;
  delete metadata.agents.general.permissionBudget;
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  assert.equal(result.value.summary.agentCount, 2);
  assert.equal(result.value.summary.enforcedCount, 1);
  assert.equal(result.value.summary.unbudgetedCount, 1);
});

// ---------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------

test('buildAuditReport: byte-stable JSON output for identical input (determinism)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const a = buildAuditReport(metadata, diagnostic);
  const b = buildAuditReport(loadFixture('budget-metadata.json'), loadFixture('cost-report-valid.json'));

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(renderAuditReportJson(a.value), renderAuditReportJson(b.value));
});

test('renderAuditReportJson: agents are alphabetically sorted; per-agent object keys are alphabetical', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);
  const serialized = renderAuditReportJson(result.value);
  const reparsed = JSON.parse(serialized);

  // Top-level keys must be alphabetical.
  const topKeys = [];
  // Use a regex to find object-level keys in serialized JSON deterministically.
  // Since the report contains nested objects, use the parsed structure instead.
  const expectedTopKeys = Object.keys(reparsed).sort();
  assert.deepEqual(Object.keys(reparsed), expectedTopKeys);
  // Each agent's keys are alphabetical.
  for (const agent of reparsed.agents) {
    assert.deepEqual(Object.keys(agent), Object.keys(agent).slice().sort());
  }
});

test('renderAuditReportJson: identical input produces byte-identical serialization (determinism, no wall-clock fields)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const a = buildAuditReport(metadata, diagnostic);
  const b = buildAuditReport(metadata, diagnostic);

  const sa = renderAuditReportJson(a.value);
  const sb = renderAuditReportJson(b.value);

  assert.equal(sa, sb);
  // No common wall-clock fields.
  for (const term of ['generatedAt', 'timestamp', 'createdAt', new Date().getFullYear().toString()]) {
    assert.equal(sa.includes(term), false, `serialized JSON must not contain ${term}`);
  }
});

// ---------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------

test('renderAuditReportMarkdown: byte-stable for identical input (determinism)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const a = buildAuditReport(metadata, diagnostic);
  const b = buildAuditReport(metadata, diagnostic);

  const ma = renderAuditReportMarkdown(a.value);
  const mb = renderAuditReportMarkdown(b.value);

  assert.equal(ma, mb);
});

test('renderAuditReportMarkdown: contains all five named dimensions per agent (R1.5)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);
  const md = renderAuditReportMarkdown(result.value);

  for (const heading of [
    'Instruction context',
    'Exposed tool context',
    'Observed tools',
    'Baseline delta',
    'First-turn input tokens',
  ]) {
    assert.ok(md.includes(heading), `markdown output must include heading: ${heading}`);
  }
  // Markdown must mention each enforced agent's name.
  for (const agentName of ['explore', 'general']) {
    assert.ok(md.includes(agentName), `markdown must mention agent ${agentName}`);
  }
});

test('renderAuditReportMarkdown: contains no wall-clock timestamps', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');

  const md = renderAuditReportMarkdown(buildAuditReport(metadata, diagnostic).value);
  const year = new Date().getFullYear().toString();
  assert.equal(md.includes(year), false, `markdown must not include current year ${year}`);
  for (const term of ['generated at', 'Generated:', 'timestamp']) {
    assert.equal(md.includes(term), false, `markdown must not include ${term}`);
  }
});

// ---------------------------------------------------------------------
// Privacy posture.
// ---------------------------------------------------------------------

test('buildAuditReport: output never contains prompt or tool-output body content (R5.7)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-with-content.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes('promptBody'), false);
  assert.equal(serialized.includes('toolOutputBody'), false);
  assert.equal(serialized.includes('SECRET-PROMPT-PAYLOAD'), false);
  assert.equal(serialized.includes('SECRET-TOOL-OUTPUT-PAYLOAD'), false);
});

// ---------------------------------------------------------------------
// Error propagation.
// ---------------------------------------------------------------------

test('buildAuditReport: propagates pricing-drift errors from the cost-report adapter', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-pricing-drift.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'pricing-drift');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0);
});

test('buildAuditReport: fails when metadata is invalid (validateBudgetMetadata error)', () => {
  const metadata = loadFixture('budget-metadata.json');
  metadata.version = 42; // invalid version
  const diagnostic = loadFixture('cost-report-valid.json');

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-metadata');
  assert.ok(Array.isArray(result.error.errors) && result.error.errors.length > 0);
});

test('buildAuditReport: fails when diagnostic is missing required fields', () => {
  const metadata = loadFixture('budget-metadata.json');
  const diagnostic = loadFixture('cost-report-valid.json');
  delete diagnostic.privacy;

  const result = buildAuditReport(metadata, diagnostic);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'missing-field');
  assert.equal(result.error.field, 'privacy');
});

// ---------------------------------------------------------------------
// CLI integration (`main`).
// ---------------------------------------------------------------------

test('main(audit --metadata --diagnostic): emits non-placeholder JSON audit report and exits 0', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--metadata', metadataPath,
    '--diagnostic', diagnosticPath,
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.command, 'audit');
  assert.notEqual(report.status, 'placeholder');
  assert.equal(Array.isArray(report.agents), true);
  assert.equal(report.agents.length, 2);
});

test('main(audit --format markdown): emits Markdown audit report instead of JSON and exits 0', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--metadata', metadataPath,
    '--diagnostic', diagnosticPath,
    '--format', 'markdown',
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  // Markdown begins with a heading, not a JSON brace.
  assert.equal(stdout.trimStart().startsWith('#'), true);
  assert.ok(stdout.includes('Instruction context'));
  assert.ok(stdout.includes('Observed tools'));
});

test('main(audit): same input produces byte-stable JSON across two invocations (determinism)', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  const a = captureMain(['audit', '--metadata', metadataPath, '--diagnostic', diagnosticPath]);
  const b = captureMain(['audit', '--metadata', metadataPath, '--diagnostic', diagnosticPath]);

  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.equal(a.stdout, b.stdout);
});

test('main(audit): exits non-zero with named error when --metadata is missing', () => {
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--diagnostic', diagnosticPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--metadata'));
});

test('main(audit): exits non-zero with named error when --diagnostic is missing', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--metadata', metadataPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--diagnostic'));
});

test('main(audit): exits non-zero on pricing-drift diagnostic and prints actionable reason', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-pricing-drift.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--metadata', metadataPath,
    '--diagnostic', diagnosticPath,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('pricing-drift'),
    `stderr must mention pricing-drift; got: ${stderr}`);
});

test('main(audit): exits non-zero on invalid metadata and prints validation errors', () => {
  const badMetadata = loadFixture('budget-metadata.json');
  badMetadata.version = 42;
  const metadataPath = writeTempJson('bad-metadata', badMetadata);
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-valid.json');

  try {
    const { exitCode, stdout, stderr } = captureMain([
      'audit',
      '--metadata', metadataPath,
      '--diagnostic', diagnosticPath,
    ]);

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.ok(stderr.includes('invalid-metadata') || stderr.includes('version'),
      `stderr must surface metadata validation failure; got: ${stderr}`);
  } finally {
    fs.unlinkSync(metadataPath);
  }
});

test('main(audit): emitted JSON does not include any prompt or tool-output body content (R5.7)', () => {
  const metadataPath = path.join(FIXTURES_DIR, 'budget-metadata.json');
  const diagnosticPath = path.join(FIXTURES_DIR, 'cost-report-with-content.json');

  const { exitCode, stdout, stderr } = captureMain([
    'audit',
    '--metadata', metadataPath,
    '--diagnostic', diagnosticPath,
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  assert.equal(stdout.includes('promptBody'), false);
  assert.equal(stdout.includes('toolOutputBody'), false);
  assert.equal(stdout.includes('SECRET-PROMPT-PAYLOAD'), false);
  assert.equal(stdout.includes('SECRET-TOOL-OUTPUT-PAYLOAD'), false);
});

test('main(validate) and main(smoke-plan): still emit deterministic placeholders (task 4.3+/5.* not implemented)', () => {
  for (const cmd of ['validate', 'smoke-plan']) {
    const { exitCode, stdout, stderr } = captureMain([cmd]);
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.command, cmd);
    assert.equal(report.status, 'placeholder');
  }
});
