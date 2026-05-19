/*
 * cost-invariant.test.js — task 8.2 of .kiro/specs/v2-diagnosis.
 *
 * End-to-end verification of the AttributionEngine's per-session
 * cost-reconciliation invariant (design.md § AttributionEngine
 * reconciliation; tolerance constants COST_INVARIANT_TOLERANCE_PCT
 * = 0.001 and COST_INVARIANT_TOLERANCE_FLOOR_USD = 0.01 declared at
 * scripts/opencode-cost-report.js:3210-3211; emission site at
 * scripts/opencode-cost-report.js:1773-1799).
 *
 * Requirements covered:
 *   R2.AC3 — when |sum(per-bucket cost) - session.cost| exceeds
 *            max(0.1% × session.cost, $0.01), the report carries a
 *            `cost_invariant_violation` finding naming the session.
 *   R2.AC4 — that finding NEVER blocks emission: the report's MD +
 *            JSON files are still written and the command exits 0.
 *
 * Why a custom fixture (not the canonical opencode-stable.db):
 *   The canonical fixture's three root sessions all happen to fall
 *   OUTSIDE tolerance (see the existing golden at
 *   integration/golden/fixture-365d-all.json — every root has a
 *   `cost_invariant_violation` finding). It therefore exercises the
 *   "violation" path well but cannot exercise the "within-tolerance,
 *   no finding" path. This test synthesizes both states in two
 *   purpose-built single-session fixtures so each assertion is a
 *   crisp presence/absence check, not a side-effect of the canonical
 *   fixture's particular cost shape.
 *
 * Why two separate fixtures rather than one with both sessions:
 *   Isolation. Each test reads `report.findings` and filters by
 *   sessionId. A single shared fixture would still work, but two
 *   isolated fixtures keep the assertion logic dead-simple (the
 *   within-tolerance assertion can do a blanket "no
 *   cost_invariant_violation findings at all" check rather than a
 *   filter-by-sessionId-then-assert-empty).
 *
 * Feature-flag posture (per task 8.1): V2_COST_COMPUTE_ENABLED's
 * default is now `true`, so the reconciliation gate at line 1773 is
 * always live during integration runs — the test does not need to
 * manipulate the flag.
 *
 * Boundary: cost-invariant.test.js + this file's local fixture
 * helper. We do NOT touch scripts/opencode-cost-report.js, the unit
 * test tree, the canonical fixture, the other integration tests, or
 * the golden files.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const test = require('node:test');
const assert = require('node:assert/strict');

const Database = require('better-sqlite3');

const { mkSandbox, readReport, runMain } = require('./_helpers.js');

// ── Determinism anchors ──────────────────────────────────────────
//
// BASE_TIME mirrors scripts/opencode-cost-diagnosis-test-fixture.js
// so the fixture sits comfortably inside `--last 365d` (currently
// ~5 days in the past) and the data_migration row looks identical
// to the live opencode install.
const BASE_TIME = 1778775290084;

// Tokens chosen so the V2 cost computation produces a known
// per-bucket sum. With anthropic/claude-opus-4-7 pricing (see
// scripts/opencode-cost-report-pricing.json):
//
//   input        10000 × $5/M     = $0.05
//   output       500   × $25/M    = $0.0125
//   cache_read   5000  × $0.5/M   = $0.0025
//   cache_write  1000  × $6.25/M  = $0.00625
//   reasoning    0     × $0/M     = $0          (opus carries no
//                                                 reasoning rate)
//                                  --------
//                                  $0.07125
//
// Subagent dispatch contributes 0 because both fixture sessions
// are leaf roots (no descendants). The per-bucket sum the
// reconciliation check sums therefore equals exactly $0.07125.
const FIXTURE_TOKENS = {
  total: 16500,
  input: 10000,
  output: 500,
  reasoning: 0,
  cache: { read: 5000, write: 1000 },
};
const EXPECTED_BUCKET_SUM_USD = 0.07125;

const MODEL_ID = 'claude-opus-4-7';
const PROVIDER_ID = 'anthropic';

// session.cost values for the two scenarios. The violation amount is
// chosen so the delta against EXPECTED_BUCKET_SUM_USD ($0.07125) is
// $0.02125 — comfortably above the floor tolerance of $0.01 and the
// 0.1%-of-expected ($0.00005) bound. The within-tolerance amount is
// exactly EXPECTED_BUCKET_SUM_USD so the delta is at most one ulp.
const COST_OUT_OF_TOLERANCE = 0.05;
const COST_WITHIN_TOLERANCE = EXPECTED_BUCKET_SUM_USD;

// ── Local fixture builder ────────────────────────────────────────
//
// Mirrors the schema + insert pattern from
// scripts/opencode-cost-diagnosis-test-fixture.js but parameterises
// (sessionId, sessionCostUsd) so each test can stamp out exactly the
// shape it needs without dragging in the full 9-session topology of
// the canonical fixture.
//
// Returns { path, cleanup }. The caller MUST call cleanup() in a
// finally; the temp dir is the only thing we created.

function buildSingleSessionFixture(opts) {
  const { sessionId, sessionCostUsd, directory } = opts;

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cost-invariant-'),
  );
  const dbPath = path.join(tmpDir, 'opencode-stable.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  db.pragma('application_id = 0');

  // Schema mirrors the canonical fixture and _helpers.mkEmptyFixture
  // exactly. Any column the diagnostic might read in the future
  // needs to exist on the table even if we leave it null/empty.
  db.exec(`
    CREATE TABLE session (
      id              TEXT PRIMARY KEY,
      parent_id       TEXT,
      directory       TEXT,
      agent           TEXT,
      model           TEXT,
      cost            REAL    NOT NULL DEFAULT 0,
      tokens_input    INTEGER NOT NULL DEFAULT 0,
      tokens_output   INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created    INTEGER NOT NULL,
      time_updated    INTEGER NOT NULL,
      slug            TEXT,
      share_url       TEXT,
      permission      TEXT
    );
    CREATE TABLE message (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      data         TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE part (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      data         TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE data_migration (
      name           TEXT PRIMARY KEY,
      time_completed INTEGER NOT NULL
    );
  `);

  const insertSession = db.prepare(`
    INSERT INTO session (
      id, parent_id, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write,
      time_created, time_updated,
      slug, share_url, permission
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO message (id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPart = db.prepare(`
    INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMigration = db.prepare(`
    INSERT INTO data_migration (name, time_completed) VALUES (?, ?)
  `);

  const tx = db.transaction(() => {
    // Root session — no parent, no descendants. session.cost is the
    // caller-controlled value the reconciliation will compare
    // against the computed per-bucket sum.
    insertSession.run(
      sessionId,
      null,
      directory,
      'build',
      MODEL_ID,
      sessionCostUsd,
      FIXTURE_TOKENS.input,
      FIXTURE_TOKENS.output,
      FIXTURE_TOKENS.reasoning,
      FIXTURE_TOKENS.cache.read,
      FIXTURE_TOKENS.cache.write,
      BASE_TIME,
      BASE_TIME + 100,
      '',
      '',
      '',
    );

    // Single assistant message — only assistant messages contribute
    // to _computeV2Cost (per scripts/opencode-cost-report.js:2223).
    // The message.data carries the providerID + modelID +
    // per-message tokens shape the pricing lookup needs. Note that
    // session.cost is the reconciliation's "expected" — message.data
    // .cost is recorded but the reconciliation check never reads it
    // (the per-message cost is opencode's own snapshot; the
    // diagnostic recomputes from tokens × rates).
    const msgId = `msg_${sessionId}_ast`;
    insertMessage.run(
      msgId,
      sessionId,
      JSON.stringify({
        role: 'assistant',
        cost: sessionCostUsd,
        tokens: FIXTURE_TOKENS,
        modelID: MODEL_ID,
        providerID: PROVIDER_ID,
        path: { cwd: directory, root: directory },
      }),
      BASE_TIME + 20,
      BASE_TIME + 20,
    );

    // One text part so the tokenizer's parts walk has something to
    // chew on; the reconciliation check itself sums the six
    // top-level bucket fields (cachedRead, cachedWrite,
    // uncachedInput, output, reasoning, subagentDispatch) and does
    // NOT consult the parts, but a session with zero parts can
    // surface noisy `unclassifiable_input` findings that are
    // orthogonal to what we're verifying here.
    insertPart.run(
      `prt_${sessionId}_ast_0`,
      msgId,
      sessionId,
      JSON.stringify({ type: 'text', text: 'fixture text' }),
      BASE_TIME + 21,
      BASE_TIME + 21,
    );

    // Pinned baseline migration so SqliteReader.open() does not
    // surface SchemaDriftError — identical to
    // _helpers.mkEmptyFixture and the canonical fixture.
    insertMigration.run('session_usage_from_messages', BASE_TIME);
  });
  tx();

  db.exec('VACUUM');
  db.close();

  return {
    path: dbPath,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Predicate over a finding object from report.findings. The
// top-level findings carry `{ kind, detail, sessionId }` (per
// integration/golden/fixture-365d-all.json — verified with
// `node -e ...` during test authoring); the per-session nested
// findings carry `{ kind, detail }` only. This test asserts against
// the top-level array exclusively because the sessionId attribution
// is the point of the requirement.
function isCostInvariantFor(finding, sessionId) {
  return (
    finding != null &&
    finding.kind === 'cost_invariant_violation' &&
    finding.sessionId === sessionId
  );
}

// ── Test A: out-of-tolerance ─────────────────────────────────────

test('integration (8.2): out-of-tolerance session emits cost_invariant_violation; report still emits (R2.AC3 + R2.AC4)', () => {
  const fixture = buildSingleSessionFixture({
    sessionId: 'ses_cost_invariant_violation',
    sessionCostUsd: COST_OUT_OF_TOLERANCE,
    directory: '/Users/test/cost-invariant-violation',
  });
  const sb = mkSandbox({ dbPath: fixture.path });
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);

    // R2.AC4 — emission is NEVER blocked. Exit 0 + stderr clean
    // proves the reconciliation finding rode the happy path.
    assert.equal(
      exitCode,
      0,
      `command must exit 0 even when a cost_invariant_violation fires; stderr=${stderr}`,
    );

    // R2.AC4 cont. — the MD and JSON report files must exist on disk.
    // readReport() throws if it cannot find exactly one of each, so
    // a successful call here is the assertion.
    const report = readReport(sb.stateDir);

    // R2.AC3 — the finding kind, naming the session, must be present.
    const matches = report.parsed.findings.filter((f) =>
      isCostInvariantFor(f, 'ses_cost_invariant_violation'),
    );
    assert.equal(
      matches.length,
      1,
      `expected exactly 1 cost_invariant_violation finding for ` +
        `ses_cost_invariant_violation; got ${matches.length}. ` +
        `findings: ${JSON.stringify(report.parsed.findings, null, 2)}`,
    );

    // Detail-string spot check: the finding's detail must mention
    // the expected (session.cost), the actual (per-bucket sum), and
    // the tolerance, so an operator reading the JSON report can
    // reconstruct the math. The exact wording is pinned at
    // scripts/opencode-cost-report.js:1791-1796; we assert each
    // substring independently so a stylistic edit to one part
    // doesn't drag the whole assertion down.
    const f = matches[0];
    assert.match(
      f.detail,
      /per-bucket sum diverged from session\.cost beyond tolerance/,
      'detail must explain that the bucket sum diverged from session.cost',
    );
    assert.match(
      f.detail,
      /expected=0\.05\b/,
      'detail must surface the session.cost as `expected=0.05`',
    );
    assert.match(
      f.detail,
      /actual=0\.07125/,
      'detail must surface the computed bucket sum as `actual=0.07125`',
    );
    assert.match(
      f.detail,
      /tolerance=0\.01\b/,
      'detail must surface the tolerance ($0.01 floor dominates at this scale)',
    );
  } finally {
    sb.cleanup();
    fixture.cleanup();
  }
});

// ── Test B: within-tolerance ─────────────────────────────────────

test('integration (8.2): within-tolerance session emits NO cost_invariant_violation', () => {
  const fixture = buildSingleSessionFixture({
    sessionId: 'ses_cost_invariant_within',
    sessionCostUsd: COST_WITHIN_TOLERANCE,
    directory: '/Users/test/cost-invariant-within',
  });
  const sb = mkSandbox({ dbPath: fixture.path });
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);
    assert.equal(
      exitCode,
      0,
      `command must exit 0 on the within-tolerance path; stderr=${stderr}`,
    );

    // Report must still be emitted (the happy-path baseline — if
    // this fails, the within-tolerance branch broke emission, which
    // would be a much more severe regression than missing the
    // finding).
    const report = readReport(sb.stateDir);

    // Negative assertion: NO cost_invariant_violation finding for
    // this session. We assert against the within-session id rather
    // than a blanket "no such findings" so a future test adding
    // another session into the same fixture does not silently turn
    // this assertion into a no-op.
    const matches = report.parsed.findings.filter((f) =>
      isCostInvariantFor(f, 'ses_cost_invariant_within'),
    );
    assert.equal(
      matches.length,
      0,
      `expected NO cost_invariant_violation finding for ` +
        `ses_cost_invariant_within (delta should be ~0); got ` +
        `${matches.length}. findings: ` +
        `${JSON.stringify(report.parsed.findings, null, 2)}`,
    );

    // Belt-and-suspenders: assert against the per-session nested
    // findings array too. The top-level findings list and the
    // per-session findings list are populated from the same source
    // (scripts/opencode-cost-report.js:1788-1798), so any leak in
    // either is a real bug.
    const sessionEntry = report.parsed.sessions.find(
      (s) => s.sessionId === 'ses_cost_invariant_within',
    );
    assert.ok(
      sessionEntry,
      'fixture session must appear in report.sessions[]',
    );
    const nestedMatches = (sessionEntry.findings || []).filter(
      (f) => f && f.kind === 'cost_invariant_violation',
    );
    assert.equal(
      nestedMatches.length,
      0,
      `nested per-session findings must also not carry the violation; ` +
        `got ${JSON.stringify(sessionEntry.findings, null, 2)}`,
    );
  } finally {
    sb.cleanup();
    fixture.cleanup();
  }
});
