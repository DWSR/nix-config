/*
 * reader.test.js — unit tests for the SQLite Reader (task 2.1 of
 * .kiro/specs/opencode-cost-diagnosis).
 *
 * Covers the open/close lifecycle and schema-drift detection layer
 * only. Iteration methods (rootSessionsMatching, descendantSessionsOf,
 * partsOfSession, messagesOfSession) are validated by task 2.2.
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
