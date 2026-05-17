#!/usr/bin/env node
/*
 * opencode-cost-report.js — diagnostic CLI entry point for the
 * opencode session cost-attribution report.
 *
 * Spec: .kiro/specs/opencode-cost-diagnosis.
 *
 * Task 1.3 landed the stub. Task 2.1 added the SQLite Reader's
 * open/close lifecycle + schema-drift detection. Task 2.2 (this
 * revision) layers the four iteration methods —
 * rootSessionsMatching, descendantSessionsOf, partsOfSession,
 * messagesOfSession — onto the same class. All four return lazy
 * iterables (better-sqlite3 StatementIterator) so large sessions do
 * not buffer entirely in memory. SQL is parameterized end-to-end;
 * no string concatenation of user input. Subsequent 3.x–5.x tasks
 * layer the attribution, tokenizer, reporter, and argument-parser
 * surfaces onto the same file (or split once it grows beyond
 * one-screen-of-purpose, per design.md File Structure Plan lines
 * 200-211).
 *
 * The stub --help / no-args / unknown-args behavior from 1.3 is
 * preserved verbatim and ONLY runs when this file is executed as a
 * script (require.main === module). When required as a module by the
 * test suite under tests/opencode-cost-diagnosis/, only the named
 * exports below are surfaced — there are no top-level side effects.
 *
 * Invoked from `scripts/opencode-cost-report.nix`, which is a
 * `writeShellApplication` that sets NODE_PATH to the vendored deps
 * tree produced by `pkgs.opencode-cost-diagnosis-deps`
 * (overlays/mcp-servers.nix) and execs `node` against this file.
 *
 * Design references:
 *   - design.md SQLite Reader component (lines 408-540)
 *   - design.md schema-drift Implementation Notes (lines 525-539)
 *   - requirements.md Requirement 5 (schema-drift detection) and
 *     Requirement 6 (read-only safety; AC4 names the expected DB
 *     path on missing-DB exit)
 */
'use strict';

const Database = require('better-sqlite3');

/* ------------------------------------------------------------------ *
 * Pinned schema baseline
 * ------------------------------------------------------------------ */

// Semver range this build of the diagnostic supports. design.md does
// not pin a specific string; the range below brackets opencode releases
// around the 2026-05-16 verification baseline (when the v1 migration
// set was confirmed live on the Shopify host) and is intentionally
// generous so unrelated opencode point releases don't trigger spurious
// drift warnings — schema drift is detected by the migration-set check
// below, not by parsing opencode's version string. Tightened/bumped in
// future tasks if a new migration lands.
const SUPPORTED_VERSION_RANGE = '>=0.18.0 <0.30.0';

// Pinned set of `data_migration.name` rows the reader expects to see.
// design.md:539 records this as the v1 baseline, verified live on
// 2026-05-16. Object.freeze prevents accidental mutation from any
// downstream caller that imports the constant.
const SUPPORTED_MIGRATION_SET = Object.freeze(['session_usage_from_messages']);

/* ------------------------------------------------------------------ *
 * SchemaDriftError
 * ------------------------------------------------------------------ */

class SchemaDriftError extends Error {
  constructor(detectedMigrationSet, supportedMigrationSet, supportedVersionRange) {
    const detected = [...detectedMigrationSet].sort();
    const supported = [...supportedMigrationSet].sort();
    const added = detected.filter((n) => !supported.includes(n));
    const removed = supported.filter((n) => !detected.includes(n));

    const drift = [];
    if (added.length > 0) drift.push(`unexpected: [${added.join(', ')}]`);
    if (removed.length > 0) drift.push(`missing: [${removed.join(', ')}]`);

    const message =
      `opencode schema drift detected: data_migration table does not match the pinned baseline.\n` +
      `  detected:  [${detected.join(', ')}]\n` +
      `  supported: [${supported.join(', ')}]\n` +
      `  drift:     ${drift.join('; ') || '(set difference)'}\n` +
      `  supported opencode version range: ${supportedVersionRange}\n` +
      `\n` +
      `Recommended next action: re-verify the opencode-cost-diagnosis spec's\n` +
      `pinned migration set against the current opencode release, then either\n` +
      `(a) update SUPPORTED_MIGRATION_SET in scripts/opencode-cost-report.js\n` +
      `and re-run the smoke test, or (b) pin opencode back to a release within\n` +
      `the supported version range (${supportedVersionRange}).`;

    super(message);
    this.name = 'SchemaDriftError';
    this.detectedMigrationSet = detected;
    this.supportedMigrationSet = supported;
    this.supportedVersionRange = supportedVersionRange;
  }
}

/* ------------------------------------------------------------------ *
 * SqliteReader
 *
 * Read-only access to the opencode session DB, with a schema-drift
 * gate on open() and lazy iteration over the four row sets the rest
 * of the pipeline needs (root sessions matching a filter, the
 * recursive descendant tree of a root, parts of a single session,
 * and messages of a single session with role pre-parsed).
 * ------------------------------------------------------------------ */

class SqliteReader {
  constructor() {
    this._db = null;
  }

  get supportedVersionRange() {
    return SUPPORTED_VERSION_RANGE;
  }

  /**
   * Open the opencode session DB read-only and verify schema is at
   * the pinned baseline. On drift, throws SchemaDriftError carrying
   * both sets + the version range. On missing-DB, throws an Error
   * whose message names the expected path verbatim (R6.AC4).
   *
   * @param {string} dbPath absolute path to opencode-stable.db
   */
  open(dbPath) {
    if (this._db !== null) {
      throw new Error(
        `SqliteReader.open: already open against a database; call close() first`,
      );
    }

    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      // better-sqlite3 throws SqliteError with code 'SQLITE_CANTOPEN'
      // when fileMustExist:true and the path is missing, or a plain
      // Error from Node's underlying open() on ENOENT/EACCES paths
      // that don't make it as far as SQLite. Either way, surface the
      // expected path so an operator can act on it without spelunking
      // a stack trace (R6.AC4).
      const cause = e && e.message ? e.message : String(e);
      const wrapped = new Error(
        `opencode session database not found or not readable at ${dbPath}: ${cause}`,
      );
      wrapped.cause = e;
      wrapped.dbPath = dbPath;
      throw wrapped;
    }

    // Schema-drift check runs once per open(); if it throws, we
    // release the underlying handle before propagating so the caller
    // doesn't have to close a reader whose open() failed.
    try {
      const detected = this._readMigrationSet(db);
      if (!setsEqual(detected, SUPPORTED_MIGRATION_SET)) {
        throw new SchemaDriftError(
          detected,
          SUPPORTED_MIGRATION_SET,
          SUPPORTED_VERSION_RANGE,
        );
      }
    } catch (e) {
      try {
        db.close();
      } catch {
        // Best-effort cleanup; the original error is what the caller
        // wanted to know about.
      }
      throw e;
    }

    this._db = db;
  }

  /**
   * Reads the data_migration table and returns the sorted set of
   * applied migration names. Public so the smoke test in 6.3 can
   * inspect the live schema without going through open() (and so the
   * argument parser in 5.3 can implement --supported-opencode-version
   * by reading SUPPORTED_MIGRATION_SET directly).
   *
   * Requires an open reader.
   */
  detectMigrationSet() {
    if (this._db === null) {
      throw new Error(
        `SqliteReader.detectMigrationSet: reader is not open; call open() first`,
      );
    }
    return this._readMigrationSet(this._db);
  }

  // Internal: shared between open()'s drift check and the public
  // detectMigrationSet(). Sorted so callers (and the drift check)
  // can rely on deterministic ordering.
  _readMigrationSet(db) {
    const rows = db
      .prepare('SELECT name FROM data_migration ORDER BY name')
      .all();
    return rows.map((r) => r.name).sort();
  }

  /**
   * Iterate root sessions (parent_id IS NULL) matching the given
   * filter. Filter fields are AND-combined; absent / null fields are
   * not applied. SQL is parameterized — no user input is ever
   * concatenated into the query string.
   *
   * For task 2.2 cwdPattern is treated as an exact match. The
   * Session Selector (task 5.2) is the layer that translates a glob
   * into a SQL LIKE pattern and re-invokes this method; the design
   * intentionally keeps glob semantics out of the reader.
   *
   * Returns better-sqlite3's StatementIterator, which fetches one
   * row per `next()` call and so does not materialize the full
   * result set in memory.
   *
   * @param {{
   *   timeRangeStart?: number,
   *   timeRangeEnd?: number,
   *   sessionId?: string,
   *   cwdPattern?: string,
   * }} filter
   * @returns {Iterable<object>} session rows in (time_created, id) ASC
   */
  rootSessionsMatching(filter) {
    this._ensureOpen('rootSessionsMatching');
    const f = filter || {};
    const clauses = ['parent_id IS NULL'];
    const params = [];
    if (f.timeRangeStart != null) {
      clauses.push('time_created >= ?');
      params.push(f.timeRangeStart);
    }
    if (f.timeRangeEnd != null) {
      clauses.push('time_created < ?');
      params.push(f.timeRangeEnd);
    }
    if (f.sessionId != null) {
      clauses.push('id = ?');
      params.push(f.sessionId);
    }
    if (f.cwdPattern != null) {
      clauses.push('directory = ?');
      params.push(f.cwdPattern);
    }
    const sql =
      `SELECT * FROM session WHERE ${clauses.join(' AND ')} ` +
      `ORDER BY time_created ASC, id ASC`;
    return this._db.prepare(sql).iterate(...params);
  }

  /**
   * Iterate the recursive descendants of `rootSessionId` (direct
   * children + grandchildren + …, walking via parent_id). Used by
   * the Subagent Aggregator (task 3.1) to roll subagent token
   * totals up to the originating root.
   *
   * @param {string} rootSessionId
   * @returns {Iterable<object>} session rows
   */
  descendantSessionsOf(rootSessionId) {
    this._ensureOpen('descendantSessionsOf');
    const sql = `
      WITH RECURSIVE descendants AS (
        SELECT * FROM session WHERE parent_id = ?
        UNION ALL
        SELECT s.* FROM session s
        JOIN descendants d ON s.parent_id = d.id
      )
      SELECT * FROM descendants
    `;
    return this._db.prepare(sql).iterate(rootSessionId);
  }

  /**
   * Iterate parts of a single session in (time_created, id) ASC
   * order. The Tokenizer Splitter (task 4.x) needs deterministic
   * ordering both for prompt-composition reasoning and for stable
   * test snapshots.
   *
   * @param {string} sessionId
   * @returns {Iterable<object>} part rows
   */
  partsOfSession(sessionId) {
    this._ensureOpen('partsOfSession');
    return this._db
      .prepare(
        'SELECT * FROM part WHERE session_id = ? ' +
          'ORDER BY time_created ASC, id ASC',
      )
      .iterate(sessionId);
  }

  /**
   * Iterate messages of a single session in time_created ASC order,
   * with `role` pre-parsed out of `message.data` JSON. Defaults to
   * null when the JSON is missing a `role` field or fails to parse,
   * so downstream callers can rely on the field being present even
   * for malformed rows without re-parsing the blob themselves.
   *
   * The wrapper iterator parses one row at a time inside `next()`,
   * preserving the laziness of the underlying StatementIterator —
   * roleless rows do not force a full table read.
   *
   * @param {string} sessionId
   * @returns {Iterable<object>} message rows with `role` added
   */
  messagesOfSession(sessionId) {
    this._ensureOpen('messagesOfSession');
    const inner = this._db
      .prepare(
        'SELECT * FROM message WHERE session_id = ? ' +
          'ORDER BY time_created ASC',
      )
      .iterate(sessionId);
    return {
      [Symbol.iterator]() {
        return {
          next() {
            const step = inner.next();
            if (step.done) return { value: undefined, done: true };
            const row = step.value;
            let role = null;
            try {
              const parsed = JSON.parse(row.data);
              if (parsed && typeof parsed.role === 'string') {
                role = parsed.role;
              }
            } catch {
              // Malformed JSON → role stays null. The full data blob
              // is preserved on the row so callers can introspect.
            }
            return { value: { ...row, role }, done: false };
          },
          // Forward early-termination (for…of break, throw, etc.) to
          // the inner better-sqlite3 StatementIterator so it releases
          // the underlying sqlite3_stmt. Without this, a partial
          // iteration would leave the connection "busy executing a
          // query" and any subsequent close() / re-query would throw.
          return(value) {
            if (typeof inner.return === 'function') inner.return();
            return { value, done: true };
          },
        };
      },
    };
  }

  // Internal guard for iteration methods; keeps each method's
  // "reader is not open" error self-identifying so an operator can
  // see which API was misused without a stack-trace dive.
  _ensureOpen(method) {
    if (this._db === null) {
      throw new Error(
        `SqliteReader.${method}: reader is not open; call open() first`,
      );
    }
  }

  /**
   * Releases the underlying file handle. Safe to call multiple times
   * and safe to call before open() — the latter matters because
   * open()'s drift-failure path may want to call close() defensively
   * during test teardown.
   */
  close() {
    if (this._db === null) return;
    try {
      this._db.close();
    } finally {
      this._db = null;
    }
  }
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * CLI stub (preserved verbatim from task 1.3)
 *
 * The real CLI surface (--last, --session, --cwd, --include-content,
 * --format, --output) is implemented by tasks 5.x. This stub keeps
 * the contract from 1.3: --help / -h prints usage and exits 0;
 * anything else prints usage to stderr and exits 1.
 * ------------------------------------------------------------------ */

const usage = [
  'opencode-cost-report — per-component cost-attribution report for opencode sessions',
  '',
  'USAGE:',
  '  opencode-cost-report --help',
  '',
  'STATUS:',
  '  Stub (Task 1.3 of the opencode-cost-diagnosis spec). The full CLI',
  '  surface — --last, --session, --cwd, --include-content, --format,',
  '  --output — is implemented by tasks 2.x-5.x of the same spec.',
  '',
].join('\n');

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    process.exit(0);
  }
  process.stderr.write(usage);
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  SqliteReader,
  SchemaDriftError,
  SUPPORTED_VERSION_RANGE,
  SUPPORTED_MIGRATION_SET,
  main,
};
