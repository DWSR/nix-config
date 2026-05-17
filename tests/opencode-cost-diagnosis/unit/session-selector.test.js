/*
 * session-selector.test.js — unit tests for the SessionSelector
 * (task 5.2 of .kiro/specs/opencode-cost-diagnosis).
 *
 * Scope: SessionSelector is a thin pure translator. It takes the
 * structured action descriptor that ArgumentParser.parse() produced
 * (task 5.1) and returns a SessionFilter object shaped for the
 * SqliteReader.rootSessionsMatching(filter) method (task 2.2):
 *
 *   parsedArgs = {
 *     action: 'report' | …,
 *     selectors: { timeRangeStart?, timeRangeEnd?, sessionId?, cwdPattern? },
 *     …
 *   }
 *                                  │
 *                                  ▼
 *   filter = { timeRangeStart?, timeRangeEnd?, sessionId?, cwdPattern? }
 *                                  │
 *                                  ▼
 *   reader.rootSessionsMatching(filter) →  parameterized SQL WHERE
 *                                          (AND-combined, no
 *                                          string interpolation)
 *
 * The "translate to parameterised SQL fragments" half of R3.AC4 is
 * already satisfied by the SqliteReader (2.2): it builds the WHERE
 * clauses with `?` placeholders, joins them with ` AND `, and
 * calls .iterate(...params). The Selector therefore exists purely
 * as a shape-mapping layer between the parser's nested
 * `parsedArgs.selectors` object and the flat filter object the
 * reader consumes. The boundary keeps the parser ignorant of the
 * reader's filter shape (so reordering 2.2 columns doesn't
 * cascade into 5.1) and keeps the reader ignorant of the CLI's
 * argument shape (so adding a new flag in 5.1 doesn't cascade into
 * 2.2 either).
 *
 * Requirements covered:
 *   - R3.AC1 (--last → timeRangeStart)
 *   - R3.AC2 (--session → sessionId)
 *   - R3.AC3 (--cwd → cwdPattern)
 *   - R3.AC4 (multiple selectors AND-combined; SQL parameterised)
 *
 * Design references: design.md Components table line 396 ("Build
 * SQL WHERE clauses from validated selectors") and the SqliteReader
 * filter shape documented in scripts/opencode-cost-report.js
 * rootSessionsMatching() jsdoc.
 *
 * End-to-end observable (the task-brief observable, exercised
 * against the 1.6 fixture without going through the 5.3 CLI Entry
 * — we wire ArgumentParser → SessionSelector → SqliteReader by
 * hand in test code):
 *
 *   --last 1d                                    → 0 root sessions
 *   --last 365d --cwd /Users/test/project-a      → exactly 1 root
 *                                                  session
 *                                                  (ses_root_a)
 *
 * `now` injection: we pin a FIXED_NOW (matches the
 * argument-parser test's anchor) so the --last math is
 * independent of wall-clock drift between fixture generation and
 * test execution. The fixture's BASE_TIME is 2026-05-14T16:14:50Z;
 * FIXED_NOW is 2026-05-17T12:00:00Z — close enough that --last 1d
 * excludes every fixture session, far enough that --last 365d
 * includes every fixture session.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  SessionSelector,
  ArgumentParser,
  SqliteReader,
} = require(path.join(__dirname, '../../../scripts/opencode-cost-report.js'));

const FIXTURE_DB = path.join(
  __dirname,
  '..',
  'fixtures',
  'opencode-stable.db',
);

// Frozen "now" — same epoch as the argument-parser test so a
// future reader can compare time-window expectations side by side
// without recomputing. 2026-05-17T12:00:00Z.
const FIXED_NOW = Date.UTC(2026, 4, 17, 12, 0, 0);

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Smoke / shape
 * ------------------------------------------------------------------ */

test('SessionSelector: is exported with a fromParsedArgs static method', () => {
  assert.equal(typeof SessionSelector, 'function');
  assert.equal(typeof SessionSelector.fromParsedArgs, 'function');
});

/* ------------------------------------------------------------------ *
 * Translation: each selector field, in isolation
 * ------------------------------------------------------------------ */

test('SessionSelector: empty selectors → empty filter object', () => {
  // No selectors present → filter has no keys. The reader treats
  // an empty filter as "all root sessions" (its WHERE clause is
  // just `parent_id IS NULL`); the Selector must not invent keys
  // that would change that meaning.
  const filter = SessionSelector.fromParsedArgs({
    action: 'report',
    selectors: {},
    includeContent: false,
    format: 'both',
    outputOverride: null,
  });
  assert.deepEqual(filter, {});
});

test('SessionSelector: --last 30d only → filter has timeRangeStart, no other selector keys', () => {
  const parsed = new ArgumentParser().parse(['--last', '30d'], { now: FIXED_NOW });
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.timeRangeStart, FIXED_NOW - 30 * DAY_MS);
  assert.equal(filter.timeRangeEnd, undefined);
  assert.equal(filter.sessionId, undefined);
  assert.equal(filter.cwdPattern, undefined);
});

test('SessionSelector: --session ses_X only → filter has sessionId, no other selector keys', () => {
  const parsed = new ArgumentParser().parse(['--session', 'ses_abc123']);
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.sessionId, 'ses_abc123');
  assert.equal(filter.timeRangeStart, undefined);
  assert.equal(filter.timeRangeEnd, undefined);
  assert.equal(filter.cwdPattern, undefined);
});

test('SessionSelector: --cwd /foo only → filter has cwdPattern, no other selector keys', () => {
  const parsed = new ArgumentParser().parse(['--cwd', '/Users/x/foo']);
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.cwdPattern, '/Users/x/foo');
  assert.equal(filter.timeRangeStart, undefined);
  assert.equal(filter.timeRangeEnd, undefined);
  assert.equal(filter.sessionId, undefined);
});

test('SessionSelector: a timeRangeEnd selector (if produced upstream) is propagated', () => {
  // ArgumentParser 5.1 doesn't currently emit timeRangeEnd — the
  // --last flag is "since N ago" with an implicit open end. The
  // selector contract is intentionally wider so a future parser
  // change adding e.g. --before doesn't require reworking the
  // translator. Construct a synthetic parsedArgs to pin this.
  const parsed = {
    action: 'report',
    selectors: { timeRangeEnd: 1700000000000 },
    includeContent: false,
    format: 'both',
    outputOverride: null,
  };
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.timeRangeEnd, 1700000000000);
  // And the other fields stay absent — synthetic input had only
  // timeRangeEnd set.
  assert.equal(filter.timeRangeStart, undefined);
});

/* ------------------------------------------------------------------ *
 * Combined selectors — R3.AC4 (logical AND)
 *
 * The Selector doesn't itself compose SQL; the AND-combination is
 * the SqliteReader's job. These tests pin the contract that the
 * Selector emits BOTH fields when both selectors are present (so
 * the reader has the data it needs to AND them) and emits ONLY
 * those fields (so the reader doesn't AND in stale defaults).
 * ------------------------------------------------------------------ */

test('SessionSelector: --last 30d --cwd /foo → both fields set, others absent', () => {
  const parsed = new ArgumentParser().parse(
    ['--last', '30d', '--cwd', '/Users/x/foo'],
    { now: FIXED_NOW },
  );
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.timeRangeStart, FIXED_NOW - 30 * DAY_MS);
  assert.equal(filter.cwdPattern, '/Users/x/foo');
  assert.equal(filter.sessionId, undefined);
  assert.equal(filter.timeRangeEnd, undefined);
});

test('SessionSelector: all three selectors set → all three fields in filter', () => {
  const parsed = new ArgumentParser().parse(
    ['--last', '7d', '--session', 'ses_xyz', '--cwd', '/repo'],
    { now: FIXED_NOW },
  );
  const filter = SessionSelector.fromParsedArgs(parsed);
  assert.equal(filter.timeRangeStart, FIXED_NOW - 7 * DAY_MS);
  assert.equal(filter.sessionId, 'ses_xyz');
  assert.equal(filter.cwdPattern, '/repo');
});

/* ------------------------------------------------------------------ *
 * Tightness — selector keys absent from parsedArgs MUST be absent
 * from the filter (NOT present-with-undefined). The reader's WHERE
 * builder uses `f.X != null` to decide whether to emit a clause;
 * a present-but-undefined key passes the `!= null` check (undefined
 * != null is true under `!=`) — wait, actually `undefined != null`
 * is FALSE under `!=` (both are loose-equal to each other). So a
 * present-but-undefined key would NOT add a clause — the reader is
 * defensive. But emitting present-but-undefined would still be a
 * leaky abstraction (downstream code that uses `'X' in filter` to
 * test presence would get a wrong answer). Tightness is the
 * Selector's invariant either way.
 * ------------------------------------------------------------------ */

test('SessionSelector: absent selectors do not appear as own keys on the filter', () => {
  const parsed = new ArgumentParser().parse(['--cwd', '/p']);
  const filter = SessionSelector.fromParsedArgs(parsed);
  // The cwd field is present; the others must not be own keys
  // (NOT present-with-undefined). Use Object.prototype.hasOwnProperty
  // to distinguish absent from undefined.
  assert.ok(Object.prototype.hasOwnProperty.call(filter, 'cwdPattern'));
  assert.equal(Object.prototype.hasOwnProperty.call(filter, 'timeRangeStart'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(filter, 'timeRangeEnd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(filter, 'sessionId'), false);
});

/* ------------------------------------------------------------------ *
 * Source argument is not mutated
 *
 * Pure translator contract: the parsedArgs object the caller hands
 * in must not be modified, so the CLI Entry (5.3) can call this
 * method multiple times against the same parsed object (e.g. to
 * re-run with a tightened filter) without observing state leak.
 * ------------------------------------------------------------------ */

test('SessionSelector: does not mutate the input parsedArgs', () => {
  const parsed = new ArgumentParser().parse(
    ['--last', '30d', '--cwd', '/p'],
    { now: FIXED_NOW },
  );
  // Snapshot via JSON round-trip; comparing deep-equal after the
  // call detects any in-place add/delete/rename.
  const before = JSON.parse(JSON.stringify(parsed));
  SessionSelector.fromParsedArgs(parsed);
  const after = JSON.parse(JSON.stringify(parsed));
  assert.deepEqual(after, before);
});

/* ------------------------------------------------------------------ *
 * End-to-end against the 1.6 fixture
 *
 * Task-brief observable, verbatim:
 *   --last 1d                                  → 0 root sessions
 *   --last 365d --cwd /Users/test/project-a    → exactly 1 root
 *                                                (ses_root_a)
 *
 * We wire ArgumentParser → SessionSelector → SqliteReader by hand
 * here because the CLI Entry (5.3) doesn't exist yet. That's the
 * point of the task brief's "exercise the integration without
 * waiting for 5.3" framing: 5.2 must observably translate args
 * such that the reader returns the expected row count.
 * ------------------------------------------------------------------ */

test('SessionSelector: end-to-end against fixture, --last 1d → 0 root sessions (fixture is older)', () => {
  const reader = new SqliteReader();
  reader.open(FIXTURE_DB);
  try {
    const parsed = new ArgumentParser().parse(['--last', '1d'], { now: FIXED_NOW });
    const filter = SessionSelector.fromParsedArgs(parsed);
    const rows = Array.from(reader.rootSessionsMatching(filter));
    assert.equal(rows.length, 0,
      'fixture sessions are all anchored on BASE_TIME 2026-05-14T16:14:50Z; ' +
      'a 1-day window ending 2026-05-17T12:00:00Z must exclude them all.');
  } finally {
    reader.close();
  }
});

test('SessionSelector: end-to-end against fixture, --last 365d --cwd /Users/test/project-a → exactly 1 root session (ses_root_a)', () => {
  const reader = new SqliteReader();
  reader.open(FIXTURE_DB);
  try {
    const parsed = new ArgumentParser().parse(
      ['--last', '365d', '--cwd', '/Users/test/project-a'],
      { now: FIXED_NOW },
    );
    const filter = SessionSelector.fromParsedArgs(parsed);
    const rows = Array.from(reader.rootSessionsMatching(filter));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'ses_root_a');
    assert.equal(rows[0].directory, '/Users/test/project-a');
    // parent_id IS NULL is the reader's hard-wired root filter —
    // re-assert it here so a regression that ever returns a
    // descendant is caught here, not in a higher-level test.
    assert.equal(rows[0].parent_id, null);
  } finally {
    reader.close();
  }
});

test('SessionSelector: end-to-end against fixture, --cwd /Users/test/project-a alone → 1 root (no time filter)', () => {
  // Sanity check that the cwd filter on its own still hits exactly
  // one root, independent of --last. Pins the AND-combination's
  // soundness: in the test above, both selectors are present and
  // both must hold (time → all 3 roots match, cwd → 1 root matches,
  // intersection → 1 root). Here only cwd is present and the
  // intersection-of-one is the same row.
  const reader = new SqliteReader();
  reader.open(FIXTURE_DB);
  try {
    const parsed = new ArgumentParser().parse(['--cwd', '/Users/test/project-a']);
    const filter = SessionSelector.fromParsedArgs(parsed);
    const rows = Array.from(reader.rootSessionsMatching(filter));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'ses_root_a');
  } finally {
    reader.close();
  }
});

test('SessionSelector: end-to-end against fixture, empty filter → all 3 root sessions', () => {
  // Empty filter from `parse([])` → reader returns every root,
  // which the fixture establishes as exactly 3 (ses_root_a/b/c).
  // The 6 descendants are excluded by the reader's hard-wired
  // `parent_id IS NULL`; the Selector doesn't need to know that.
  const reader = new SqliteReader();
  reader.open(FIXTURE_DB);
  try {
    const parsed = new ArgumentParser().parse([]);
    const filter = SessionSelector.fromParsedArgs(parsed);
    const rows = Array.from(reader.rootSessionsMatching(filter));
    assert.equal(rows.length, 3);
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['ses_root_a', 'ses_root_b', 'ses_root_c']);
  } finally {
    reader.close();
  }
});
