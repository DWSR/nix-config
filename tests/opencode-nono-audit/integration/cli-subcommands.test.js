/*
 * cli-subcommands.test.js — integration tests for the CLI subcommand
 * wiring (opencode-nono-audit spec, Task 5.3, Requirements 1.1, 2.5,
 * 3.1).
 *
 * Task 5.3 replaces the scaffold stub `main(argv)` with the four real
 * subcommands (`audit`, `assess`, `review`, `all`), flag parsing,
 * injectable paths (so the observable runs over the fixtures), and the
 * documented exit-code table:
 *   - success → 0
 *   - no readable source (R1.5 hard failure) → 1 (nonzero)
 *   - unknown subcommand / bad flags / no subcommand → 2 (nonzero)
 *   - --help / --version → 0 (no regression)
 *   - schema-drift → 0 (partial, NOT a hard failure)
 *
 * `all` runs the full pipeline (audit → assess → review → report) AND
 * additionally writes the cross-spec freshness marker
 * (last-report.json). The other subcommands write the combined report
 * but NOT the marker (only `all` writes the marker — the task
 * observable).
 *
 * Tests drive `main(argv)` directly: it returns the process exit code
 * (captured here) and writes its report/marker under the injected
 * `--state-dir`, so assertions check BOTH the exit code AND
 * file existence/content. Redaction stays on by default (R1.7), so the
 * planted fixture secrets must be absent from the written report.
 *
 * Lives under tests/opencode-nono-audit/integration/ (run.js recurses
 * everywhere except fixtures/ and node_modules/). runAudit resolves
 * SqliteReader by relative path under `node --test` (env var unset), so
 * no env setup is needed — mirrors report-emit.test.js. `assess` over
 * the fixtures shells out to a (absent) `nono`, so its assessment is
 * SKIPPED on this host; that skip is exercised here too.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
const METADATA_FIXTURE = path.join(FIXTURES_DIR, 'sandbox-metadata.json');

// The two OBVIOUSLY-FAKE secrets planted in the session fixture by
// make-fixtures.js. Both MUST be absent from the written report after
// redaction (R1.7, on by default — no disable flag).
const FIXTURE_SECRETS = ['FAKE_SECRET_PW', 'ghp_FAKE000000000000000000000000000000'];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Fresh per-test temp state dir (auto-unique). */
function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nono-cli-'));
}

const reportsDirOf = (stateDir) => path.join(stateDir, 'opencode-nono', 'reports');
const markerPathOf = (stateDir) => path.join(stateDir, 'opencode-nono', 'last-report.json');

/** List the report files (json/md) written under a state dir. */
function listReports(stateDir) {
  const dir = reportsDirOf(stateDir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  return {
    json: entries.filter((n) => n.endsWith('.json')),
    md: entries.filter((n) => n.endsWith('.md')),
  };
}

/** Read the single written JSON report under a state dir (asserts exactly one). */
function readSingleJsonReport(stateDir) {
  const { json } = listReports(stateDir);
  assert.equal(json.length, 1, `expected exactly one JSON report, got ${json.length}`);
  return fs.readFileSync(path.join(reportsDirOf(stateDir), json[0]), 'utf8');
}

/**
 * Capture process.stdout/stderr writes while running `fn`, returning the
 * captured streams. Restores the originals in a finally.
 */
function captureStdio(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const result = fn();
    return { result, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ────────────────────────────────────────────────────────────────────
// 1. `all` — the observable: full pipeline → report (JSON+MD) + marker
//    (R1.1, R2.5, R3.1)
// ────────────────────────────────────────────────────────────────────

test('main([all]) over the fixtures returns 0 and writes a report (JSON+MD) plus a freshness marker (R1.1/2.5/3.1)', () => {
  const stateDir = mkStateDir();

  const { result: code } = captureStdio(() =>
    main([
      'all',
      '--session-db',
      SESSION_DB,
      '--metadata',
      METADATA_FIXTURE,
      '--state-dir',
      stateDir,
      '--profile',
      'opencode',
    ]),
  );

  assert.equal(code, 0, '`all` over the fixtures must exit 0');

  const reports = listReports(stateDir);
  assert.equal(reports.json.length, 1, '`all` must write exactly one JSON report');
  assert.equal(reports.md.length, 1, '`all` must write exactly one Markdown report');

  // The cross-spec freshness marker is written ONLY by `all`.
  const markerPath = markerPathOf(stateDir);
  assert.ok(fs.existsSync(markerPath), '`all` must write the freshness marker last-report.json');

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.markerSchemaVersion, 1, 'marker carries markerSchemaVersion 1');
  assert.equal(
    marker.profileVersion,
    'fixture-profile-0001',
    'marker profileVersion read from the metadata fixture',
  );
});

test('main([all]) keeps redaction on by default — fixture secrets absent from the written report (R1.7)', () => {
  const stateDir = mkStateDir();

  captureStdio(() =>
    main([
      'all',
      '--session-db',
      SESSION_DB,
      '--metadata',
      METADATA_FIXTURE,
      '--state-dir',
      stateDir,
    ]),
  );

  const json = readSingleJsonReport(stateDir);
  for (const secret of FIXTURE_SECRETS) {
    assert.ok(!json.includes(secret), `written report must NOT contain fixture secret ${secret}`);
  }
  assert.ok(json.includes('***'), 'the redaction mask must appear in the written report');
});

test('main([all]) report + marker files are written at mode 0600', () => {
  const stateDir = mkStateDir();

  captureStdio(() =>
    main(['all', '--session-db', SESSION_DB, '--metadata', METADATA_FIXTURE, '--state-dir', stateDir]),
  );

  const { json, md } = listReports(stateDir);
  const jsonPath = path.join(reportsDirOf(stateDir), json[0]);
  const mdPath = path.join(reportsDirOf(stateDir), md[0]);
  const markerPath = markerPathOf(stateDir);

  assert.equal(fs.statSync(jsonPath).mode & 0o777, 0o600, 'JSON report must be 0600');
  assert.equal(fs.statSync(mdPath).mode & 0o777, 0o600, 'Markdown report must be 0600');
  assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600, 'freshness marker must be 0600');
});

// ────────────────────────────────────────────────────────────────────
// 2. audit / assess / review — each returns 0 + produces a report; NO
//    marker (only `all` writes the marker)
// ────────────────────────────────────────────────────────────────────

test('main([audit]) over the fixtures returns 0 and writes a report but NO marker', () => {
  const stateDir = mkStateDir();

  const { result: code } = captureStdio(() =>
    main(['audit', '--session-db', SESSION_DB, '--metadata', METADATA_FIXTURE, '--state-dir', stateDir]),
  );

  assert.equal(code, 0, '`audit` must exit 0 over the fixtures');
  const reports = listReports(stateDir);
  assert.equal(reports.json.length, 1, '`audit` must write a JSON report');
  assert.equal(reports.md.length, 1, '`audit` must write a Markdown report');
  assert.ok(!fs.existsSync(markerPathOf(stateDir)), '`audit` must NOT write the freshness marker');

  // The audit report names the session source and discloses coverage gaps.
  const parsed = JSON.parse(readSingleJsonReport(stateDir));
  assert.ok(Array.isArray(parsed.audit.sources), 'report carries audit.sources');
  assert.ok(
    parsed.audit.sources.some((s) => s.source === 'opencode-sqlite'),
    'audit report names the opencode-sqlite source',
  );
  assert.ok(
    Array.isArray(parsed.audit.unobservableClasses) && parsed.audit.unobservableClasses.length > 0,
    'audit report discloses unobservable classes',
  );
});

test('main([assess]) over the fixtures returns 0; with nono absent the assessment carries the skip status', () => {
  const stateDir = mkStateDir();

  const { result: code } = captureStdio(() =>
    main([
      'assess',
      '--session-db',
      SESSION_DB,
      '--metadata',
      METADATA_FIXTURE,
      '--state-dir',
      stateDir,
      '--profile',
      'opencode',
    ]),
  );

  assert.equal(code, 0, '`assess` must exit 0 even when nono is unavailable (skip ≠ hard fail)');
  const parsed = JSON.parse(readSingleJsonReport(stateDir));
  // nono is absent on this host → assessment is a skip envelope, not findings.
  assert.equal(
    parsed.assessment.assessment,
    'skipped',
    'assessment must carry the skip status when nono is unavailable',
  );
  assert.equal(typeof parsed.assessment.reason, 'string', 'skip envelope carries a reason');
});

test('main([review]) over the fixtures returns 0 and writes a report carrying the review sections', () => {
  const stateDir = mkStateDir();

  const { result: code } = captureStdio(() =>
    main(['review', '--session-db', SESSION_DB, '--metadata', METADATA_FIXTURE, '--state-dir', stateDir]),
  );

  assert.equal(code, 0, '`review` must exit 0 over the fixtures');
  assert.ok(!fs.existsSync(markerPathOf(stateDir)), '`review` must NOT write the freshness marker');

  const parsed = JSON.parse(readSingleJsonReport(stateDir));
  assert.ok(parsed.review && typeof parsed.review === 'object', 'report carries a review section');
  assert.ok(Array.isArray(parsed.review.ranked), 'review.ranked is present');
  assert.ok(Array.isArray(parsed.review.candidates), 'review.candidates is present');
  assert.ok(parsed.review.ledger && typeof parsed.review.ledger === 'object', 'review.ledger present');
});

// ────────────────────────────────────────────────────────────────────
// 3. No readable source (R1.5 hard failure) → NONZERO, no report
// ────────────────────────────────────────────────────────────────────

test('main([all]) with an unreadable session DB and no cavemem returns NONZERO and writes no report (R1.5)', () => {
  const stateDir = mkStateDir();
  const missingDb = path.join(FIXTURES_DIR, 'does-not-exist-session.db');

  const { result: code } = captureStdio(() =>
    main(['all', '--session-db', missingDb, '--metadata', METADATA_FIXTURE, '--state-dir', stateDir]),
  );

  assert.notEqual(code, 0, 'no readable source → nonzero exit (R1.5)');
  const reports = listReports(stateDir);
  assert.equal(reports.json.length, 0, 'no report JSON may be assembled when no source is readable');
  assert.equal(reports.md.length, 0, 'no report Markdown may be assembled when no source is readable');
  assert.ok(!fs.existsSync(markerPathOf(stateDir)), 'no marker may be written on hard failure');
});

test('main([audit]) with an unreadable session DB returns NONZERO (R1.5)', () => {
  const stateDir = mkStateDir();
  const missingDb = path.join(FIXTURES_DIR, 'does-not-exist-session.db');

  const { result: code } = captureStdio(() =>
    main(['audit', '--session-db', missingDb, '--state-dir', stateDir]),
  );

  assert.notEqual(code, 0, '`audit` with no readable source → nonzero (R1.5)');
});

// ────────────────────────────────────────────────────────────────────
// 4. Unknown subcommand / unknown flag / no subcommand → NONZERO + usage
// ────────────────────────────────────────────────────────────────────

test('main([bogus]) — unknown subcommand returns NONZERO and prints usage', () => {
  const { result: code, stderr } = captureStdio(() => main(['bogus']));
  assert.notEqual(code, 0, 'unknown subcommand → nonzero');
  assert.match(stderr, /usage/i, 'unknown subcommand prints usage to stderr');
});

test('main([audit, --nope]) — unknown flag returns NONZERO and prints usage', () => {
  const { result: code, stderr } = captureStdio(() =>
    main(['audit', '--nope', '--session-db', SESSION_DB]),
  );
  assert.notEqual(code, 0, 'unknown flag → nonzero');
  assert.match(stderr, /usage/i, 'unknown flag prints usage to stderr');
});

test('main([]) — no subcommand returns NONZERO and prints usage', () => {
  const { result: code, stderr } = captureStdio(() => main([]));
  assert.notEqual(code, 0, 'no subcommand → nonzero');
  assert.match(stderr, /usage/i, 'no subcommand prints usage to stderr');
});

test('main([--session-db]) — a flag missing its value returns NONZERO + usage', () => {
  const { result: code, stderr } = captureStdio(() => main(['audit', '--session-db']));
  assert.notEqual(code, 0, 'flag missing its value → nonzero');
  assert.match(stderr, /usage/i, 'missing flag value prints usage to stderr');
});

// ────────────────────────────────────────────────────────────────────
// 5. --help / --version still exit 0 (no regression) + document subcommands
// ────────────────────────────────────────────────────────────────────

test('main([--help]) still returns 0 and the usage documents the subcommands', () => {
  const { result: code, stdout } = captureStdio(() => main(['--help']));
  assert.equal(code, 0, '--help must exit 0');
  for (const sub of ['audit', 'assess', 'review', 'all']) {
    assert.ok(stdout.includes(sub), `usage must document the ${sub} subcommand`);
  }
});

test('main([-h]) and main([--version]) and main([-v]) still return 0', () => {
  assert.equal(captureStdio(() => main(['-h'])).result, 0, '-h must exit 0');
  assert.equal(captureStdio(() => main(['--version'])).result, 0, '--version must exit 0');
  assert.equal(captureStdio(() => main(['-v'])).result, 0, '-v must exit 0');
});

// ────────────────────────────────────────────────────────────────────
// 6. Schema-drift is NOT a hard failure → exit 0 with a partial report
// ────────────────────────────────────────────────────────────────────

test('main([all]) over the drift fixture returns 0 with a partial report (drift is NOT a hard fail)', () => {
  const stateDir = mkStateDir();

  const { result: code } = captureStdio(() =>
    main(['all', '--session-db', DRIFT_DB, '--metadata', METADATA_FIXTURE, '--state-dir', stateDir]),
  );

  assert.equal(code, 0, 'schema drift → partial report, still exit 0');
  const parsed = JSON.parse(readSingleJsonReport(stateDir));
  assert.equal(parsed.audit.partial, true, 'drift report must be partial');
  assert.ok(
    parsed.audit.sources.some((s) => s.status === 'incompatible'),
    'drift report names the incompatible source',
  );
});
