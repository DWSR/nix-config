'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require(path.join(
  __dirname,
  '../../../scripts/subagent-context-budget.js',
));

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

test('main(--help): prints command surface and exits 0', () => {
  const { exitCode, stdout, stderr } = captureMain(['--help']);

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  for (const term of [
    'subagent-context-budget',
    'audit',
    'validate',
    'smoke-plan',
    '--format',
    '--metadata',
  ]) {
    assert.ok(stdout.includes(term), `help output must mention ${term}`);
  }
});

// `audit` is no longer a placeholder as of task 4.2 and `validate` is
// no longer a placeholder as of task 4.3 — see `audit-report.test.js`
// and `validation-comparator.test.js` for the real contracts. The
// smoke-plan command remains a placeholder pending task 5.*.
test('main(smoke-plan): exposes a deterministic placeholder', () => {
  const { exitCode, stdout, stderr } = captureMain(['smoke-plan']);

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');

  const report = JSON.parse(stdout);
  assert.equal(report.command, 'smoke-plan');
  assert.equal(report.status, 'placeholder');
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.next, []);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('toolOutput'), false);
});

test('main(audit): without required flags exits 1 with a named-flag error (no placeholder)', () => {
  const { exitCode, stdout, stderr } = captureMain(['audit']);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--metadata'));
});

test('main(unknown): exits 1 and names the offending command', () => {
  const { exitCode, stdout, stderr } = captureMain(['bogus']);

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('unknown command: bogus'));
  assert.ok(stderr.includes('audit'));
});

test('fixtures: metadata and diagnostic reports are parseable and content-private', () => {
  const fixturesDir = path.join(__dirname, '../fixtures');
  const metadata = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'budget-metadata.json'), 'utf8'),
  );
  const baseline = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'report-baseline.json'), 'utf8'),
  );
  const post = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'report-post.json'), 'utf8'),
  );

  assert.equal(metadata.version, 1);
  assert.equal(metadata.enforcementEnabled, false);
  for (const report of [baseline, post]) {
    assert.equal(report.privacy.includeContent, false);
    assert.equal(report.privacy.promptBodiesIncluded, false);
    assert.equal(report.privacy.toolOutputBodiesIncluded, false);
    assert.equal(JSON.stringify(report).includes('promptBody'), false);
    assert.equal(JSON.stringify(report).includes('toolOutputBody'), false);
  }
});
