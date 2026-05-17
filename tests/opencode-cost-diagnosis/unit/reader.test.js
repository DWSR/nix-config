/*
 * reader.test.js — unit tests for the SQLite Reader (tasks 2.1 + 2.2
 * of .kiro/specs/opencode-cost-diagnosis).
 *
 * 2.1 covers the open/close lifecycle and schema-drift detection
 * layer. 2.2 extends with the four iteration methods
 * (rootSessionsMatching, descendantSessionsOf, partsOfSession,
 * messagesOfSession) that the rest of the pipeline (Session Selector,
 * Subagent Aggregator, Attribution Engine, Tokenizer Splitter)
 * depends on. Lazy iteration is asserted by spying on the returned
 * iterator's shape and by partial-consume-then-break.
 *
 * The shared fixture at fixtures/opencode-stable.db is the
 * pinned-baseline opencode-shaped DB built by
 * scripts/opencode-cost-diagnosis-test-fixture.js. Its
 * `data_migration` table contains the single v1-baseline row
 * `session_usage_from_messages`, so it exercises the success path of
 * `open()`. For the drift path we copy the fixture to a tmp file and
 * INSERT an extra `data_migration` row, then confirm `open()` throws
 * `SchemaDriftError` carrying both sets and the version range.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const Database = require('better-sqlite3');

const {
  SqliteReader,
  SchemaDriftError,
  SUPPORTED_MIGRATION_SET,
  SUPPORTED_VERSION_RANGE,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

function mkMutatedFixture() {
  // Copy the pinned fixture to an OS-tmp file so we can mutate
  // `data_migration` without dirtying the committed fixture. Caller
  // is responsible for unlinking after the test.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-reader-test-'));
  const tmp = path.join(tmpDir, 'opencode-mutated.db');
  fs.copyFileSync(FIXTURE, tmp);
  const m = new Database(tmp);
  m.exec(
    "INSERT INTO data_migration (name, time_completed) " +
      "VALUES ('hypothetical_v2_migration', 1700000000000)",
  );
  m.close();
  return { tmp, tmpDir };
}

function mkFixtureCopy() {
  // Like mkMutatedFixture but without touching data_migration, so
  // open() succeeds. Used by 2.2 tests that want to inject extra rows
  // (e.g. a roleless message) without leaving the pinned fixture dirty.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-reader-test-'));
  const tmp = path.join(tmpDir, 'opencode-copy.db');
  fs.copyFileSync(FIXTURE, tmp);
  return { tmp, tmpDir };
}

test('SqliteReader.open succeeds against the pinned-baseline fixture', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    assert.deepEqual(
      r.detectMigrationSet(),
      [...SUPPORTED_MIGRATION_SET],
      'detectMigrationSet must return the pinned baseline against the v1 fixture',
    );
    assert.equal(
      typeof r.supportedVersionRange,
      'string',
      'supportedVersionRange must be a string',
    );
    assert.ok(
      r.supportedVersionRange.length > 0,
      'supportedVersionRange must not be empty',
    );
    assert.equal(
      r.supportedVersionRange,
      SUPPORTED_VERSION_RANGE,
      'reader instance must expose the module-level constant verbatim',
    );
  } finally {
    r.close();
  }
});

test('SUPPORTED_MIGRATION_SET is the v1 baseline and is frozen', () => {
  assert.deepEqual(
    [...SUPPORTED_MIGRATION_SET],
    ['session_usage_from_messages'],
    'v1 baseline pinned set (design.md:539)',
  );
  assert.ok(
    Object.isFrozen(SUPPORTED_MIGRATION_SET),
    'pinned set must be Object.freeze()d to prevent accidental mutation',
  );
});

test('open() throws SchemaDriftError when data_migration has extra rows', () => {
  const { tmp, tmpDir } = mkMutatedFixture();
  const r = new SqliteReader();
  try {
    assert.throws(
      () => r.open(tmp),
      (err) => {
        assert.ok(
          err instanceof SchemaDriftError,
          `expected SchemaDriftError, got ${err && err.constructor && err.constructor.name}`,
        );
        assert.deepEqual(
          err.detectedMigrationSet,
          ['hypothetical_v2_migration', 'session_usage_from_messages'],
          'detected set must include the extra row, sorted',
        );
        assert.deepEqual(
          err.supportedMigrationSet,
          ['session_usage_from_messages'],
          'supported set must match the pinned v1 baseline',
        );
        assert.equal(
          err.supportedVersionRange,
          SUPPORTED_VERSION_RANGE,
          'error must carry the supportedVersionRange',
        );
        // Actionable message must name both sets so the operator
        // can see exactly what drifted without inspecting the
        // error object fields.
        assert.match(
          err.message,
          /hypothetical_v2_migration/,
          'message must name the unexpected migration',
        );
        assert.match(
          err.message,
          /session_usage_from_messages/,
          'message must name the supported baseline',
        );
        assert.match(
          err.message,
          new RegExp(SUPPORTED_VERSION_RANGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'message must name the supported version range',
        );
        return true;
      },
    );
  } finally {
    // Reader may or may not have left a handle open; close() must
    // tolerate the failed-open case.
    r.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('open() throws with the expected path named when the DB is missing (R6.AC4)', () => {
  const missing = '/nonexistent/path/opencode-stable.db';
  const r = new SqliteReader();
  assert.throws(
    () => r.open(missing),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.match(
        err.message,
        new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'error message must name the expected path verbatim (R6.AC4)',
      );
      return true;
    },
  );
});

test('close() is a safe no-op when no DB is open', () => {
  const r = new SqliteReader();
  // Must not throw — close() before open() is a legitimate cleanup
  // path (e.g. failed-open in the schema-drift test above).
  r.close();
  // And idempotent under repeated invocation.
  r.close();
});

test('close() releases the handle so the file can be reopened', () => {
  const r1 = new SqliteReader();
  r1.open(FIXTURE);
  r1.close();
  // Second instance must succeed on the same path — proves the
  // first close() actually released the underlying handle.
  const r2 = new SqliteReader();
  r2.open(FIXTURE);
  r2.close();
});

/* ------------------------------------------------------------------ *
 * Task 2.2 — iteration methods
 *
 * Fixture topology (confirmed against the pinned 1.6 fixture via
 * sqlite3 at test-authoring time):
 *
 *   ses_root_a        (/Users/test/project-a, parent null, 6 parts, 3 msgs)
 *     ses_root_a_child_0
 *       ses_root_a_child_0_sub_0
 *     ses_root_a_child_1
 *   ses_root_b        (/Users/test/project-b, parent null, 6 parts, 3 msgs)
 *     ses_root_b_child_0
 *       ses_root_b_child_0_sub_0
 *     ses_root_b_child_1
 *   ses_root_c        (/Users/test/project-c, parent null, 6 parts, 3 msgs,
 *                      no children)
 *
 * Root time_created stamps: a=…290084, b=…291084, c=…292084
 * Root messages cover the three message roles per fixture builder
 * (system / user / assistant), so messagesOfSession on a root is the
 * natural place to assert role-parsing coverage.
 * ------------------------------------------------------------------ */

const FIXTURE_ROOTS = ['ses_root_a', 'ses_root_b', 'ses_root_c'];
const FIXTURE_ROOT_A_DESCENDANTS = [
  'ses_root_a_child_0',
  'ses_root_a_child_0_sub_0',
  'ses_root_a_child_1',
];

test('rootSessionsMatching({}) returns all 3 roots, all parent_id null', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const it = r.rootSessionsMatching({});
    assert.equal(
      typeof it[Symbol.iterator],
      'function',
      'returned value must be iterable',
    );
    assert.ok(
      !Array.isArray(it),
      'returned value must not be a pre-collected array (laziness)',
    );
    const rows = [...it];
    assert.equal(rows.length, 3, 'fixture has exactly 3 root sessions');
    for (const row of rows) {
      assert.equal(
        row.parent_id,
        null,
        `root rows must have parent_id null; got ${row.parent_id} for ${row.id}`,
      );
    }
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      FIXTURE_ROOTS,
      'root ids must match the pinned fixture topology',
    );
  } finally {
    r.close();
  }
});

test('rootSessionsMatching honors sessionId filter (exact match)', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [...r.rootSessionsMatching({ sessionId: 'ses_root_a' })];
    assert.equal(rows.length, 1, 'sessionId filter narrows to one row');
    assert.equal(rows[0].id, 'ses_root_a');
    assert.equal(rows[0].parent_id, null);
  } finally {
    r.close();
  }
});

test('rootSessionsMatching honors cwdPattern filter (exact match for 2.2)', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [
      ...r.rootSessionsMatching({ cwdPattern: '/Users/test/project-a' }),
    ];
    assert.equal(rows.length, 1, 'cwd filter narrows to one row');
    assert.equal(rows[0].id, 'ses_root_a');
    assert.equal(rows[0].directory, '/Users/test/project-a');
  } finally {
    r.close();
  }
});

test('rootSessionsMatching honors timeRangeStart/timeRangeEnd', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    // Window covers only ses_root_b (…291084) — exclusive end excludes
    // ses_root_c (…292084), inclusive start excludes ses_root_a
    // (…290084).
    const rows = [
      ...r.rootSessionsMatching({
        timeRangeStart: 1778775291000,
        timeRangeEnd: 1778775292000,
      }),
    ];
    assert.equal(rows.length, 1, 'window contains exactly ses_root_b');
    assert.equal(rows[0].id, 'ses_root_b');
  } finally {
    r.close();
  }
});

test('rootSessionsMatching combines filters with AND (returns empty when no match)', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [
      ...r.rootSessionsMatching({
        sessionId: 'ses_root_a',
        cwdPattern: '/Users/test/project-b', // mismatch on purpose
      }),
    ];
    assert.equal(rows.length, 0, 'conflicting filters return no rows');
  } finally {
    r.close();
  }
});

test('descendantSessionsOf returns recursive children + grandchildren', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const it = r.descendantSessionsOf('ses_root_a');
    assert.equal(
      typeof it[Symbol.iterator],
      'function',
      'returned value must be iterable',
    );
    assert.ok(!Array.isArray(it), 'returned value must not be a pre-collected array');
    const ids = [...it].map((r) => r.id).sort();
    assert.deepEqual(
      ids,
      FIXTURE_ROOT_A_DESCENDANTS,
      'recursive CTE must surface both direct children and the grandchild',
    );
  } finally {
    r.close();
  }
});

test('descendantSessionsOf returns empty iterable when no children', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [...r.descendantSessionsOf('ses_root_c')];
    assert.equal(rows.length, 0, 'ses_root_c has no descendants in fixture');
  } finally {
    r.close();
  }
});

test('descendantSessionsOf returns empty iterable for unknown root', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [...r.descendantSessionsOf('ses_does_not_exist')];
    assert.equal(rows.length, 0);
  } finally {
    r.close();
  }
});

test('partsOfSession returns parts in time_created ASC, id ASC order', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const it = r.partsOfSession('ses_root_a');
    assert.ok(!Array.isArray(it), 'returned value must not be a pre-collected array');
    const rows = [...it];
    assert.equal(rows.length, 6, 'ses_root_a has 6 parts per fixture');
    for (const row of rows) {
      assert.equal(row.session_id, 'ses_root_a');
    }
    // Verify the ordering invariant in one pass.
    let prevTime = -Infinity;
    let prevId = '';
    for (const row of rows) {
      assert.ok(
        row.time_created > prevTime ||
          (row.time_created === prevTime && row.id >= prevId),
        `ordering invariant broken at row ${row.id} (t=${row.time_created})`,
      );
      prevTime = row.time_created;
      prevId = row.id;
    }
  } finally {
    r.close();
  }
});

test('partsOfSession returns empty iterable for unknown session', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const rows = [...r.partsOfSession('ses_does_not_exist')];
    assert.equal(rows.length, 0);
  } finally {
    r.close();
  }
});

test('messagesOfSession returns rows with role parsed from data JSON', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const it = r.messagesOfSession('ses_root_a');
    assert.equal(
      typeof it[Symbol.iterator],
      'function',
      'returned value must be iterable',
    );
    assert.ok(!Array.isArray(it), 'returned value must not be a pre-collected array');
    const rows = [...it];
    assert.equal(rows.length, 3, 'ses_root_a has 3 messages per fixture');
    for (const row of rows) {
      assert.equal(row.session_id, 'ses_root_a');
      assert.equal(typeof row.data, 'string', 'data blob preserved untouched');
    }
    assert.deepEqual(
      rows.map((r) => r.role).sort(),
      ['assistant', 'system', 'user'],
      'role must be parsed for the three fixture-baseline roles',
    );
    // And the order is time_created ASC.
    let prev = -Infinity;
    for (const row of rows) {
      assert.ok(
        row.time_created >= prev,
        `time_created must be ascending; ${row.time_created} < ${prev} at ${row.id}`,
      );
      prev = row.time_created;
    }
  } finally {
    r.close();
  }
});

test('messagesOfSession returns role=null when message.data lacks a role field', () => {
  const { tmp, tmpDir } = mkFixtureCopy();
  // Inject a roleless message attached to ses_root_a.
  {
    const m = new Database(tmp);
    m.exec(
      "INSERT INTO message (id, session_id, data, time_created, time_updated) " +
        "VALUES ('msg_no_role', 'ses_root_a', '{\"other\":\"x\"}', " +
        '1778775289000, 1778775289000)',
    );
    m.close();
  }
  const r = new SqliteReader();
  try {
    r.open(tmp);
    const rows = [...r.messagesOfSession('ses_root_a')];
    const injected = rows.find((row) => row.id === 'msg_no_role');
    assert.ok(injected, 'injected roleless message must be present');
    assert.equal(
      injected.role,
      null,
      'role must default to null when missing from data JSON',
    );
  } finally {
    r.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iteration methods are lazy: break early without materializing all rows', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    // partsOfSession on ses_root_a returns 6 rows; consuming only 2
    // and breaking must not throw and must not require collecting all
    // 6 first. We can't directly observe row-by-row fetches from
    // better-sqlite3 in a unit test, but we can prove the contract by
    // confirming:
    //   (a) the returned object is not Array — proves no buffer-and-
    //       return-array shortcut
    //   (b) Symbol.iterator is present
    //   (c) we can break out partway through
    let count = 0;
    for (const _row of r.partsOfSession('ses_root_a')) {
      void _row;
      count++;
      if (count >= 2) break;
    }
    assert.equal(count, 2, 'break must stop iteration at 2 rows');

    // Same for messagesOfSession (the wrapper iterator must preserve
    // laziness rather than pre-collecting in order to add role).
    let mcount = 0;
    for (const _row of r.messagesOfSession('ses_root_a')) {
      void _row;
      mcount++;
      if (mcount >= 1) break;
    }
    assert.equal(mcount, 1, 'message-iterator break must stop at 1 row');

    // And none of the four iteration helpers returns a pre-collected
    // Array — Array.isArray would be a false positive for the laziness
    // contract. Each iterator is fully consumed below so the
    // underlying better-sqlite3 StatementIterator releases its stmt
    // reference before the test's finally-close() (otherwise close()
    // would throw "database connection is busy executing a query",
    // which is itself a real laziness signal but distracts from the
    // assertion we care about here).
    const rootsIt = r.rootSessionsMatching({});
    assert.ok(!Array.isArray(rootsIt));
    for (const _row of rootsIt) void _row;

    const descIt = r.descendantSessionsOf('ses_root_a');
    assert.ok(!Array.isArray(descIt));
    for (const _row of descIt) void _row;

    const partsIt = r.partsOfSession('ses_root_a');
    assert.ok(!Array.isArray(partsIt));
    for (const _row of partsIt) void _row;

    const msgsIt = r.messagesOfSession('ses_root_a');
    assert.ok(!Array.isArray(msgsIt));
    for (const _row of msgsIt) void _row;
  } finally {
    r.close();
  }
});

test('iteration methods throw when called before open()', () => {
  const r = new SqliteReader();
  // Use a regex match per method to confirm the method name is named
  // back in the error (helps an operator pinpoint the misuse).
  assert.throws(
    () => r.rootSessionsMatching({}),
    /rootSessionsMatching.*not open/,
  );
  assert.throws(
    () => r.descendantSessionsOf('x'),
    /descendantSessionsOf.*not open/,
  );
  assert.throws(() => r.partsOfSession('x'), /partsOfSession.*not open/);
  assert.throws(() => r.messagesOfSession('x'), /messagesOfSession.*not open/);
});
