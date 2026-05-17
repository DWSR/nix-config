#!/usr/bin/env node
/*
 * opencode-cost-report.js — diagnostic CLI entry point for the
 * opencode session cost-attribution report.
 *
 * Spec: .kiro/specs/opencode-cost-diagnosis.
 *
 * Task 1.3 landed the stub. Task 2.1 (this revision) adds the SQLite
 * Reader's open/close lifecycle + schema-drift detection. Subsequent
 * 2.x–5.x tasks layer the iteration methods, attribution, tokenizer,
 * reporter, and argument-parser surfaces onto the same file (or split
 * once it grows beyond one-screen-of-purpose, per design.md File
 * Structure Plan lines 200-211).
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
 * gate on open(). Iteration methods (rootSessionsMatching,
 * descendantSessionsOf, partsOfSession, messagesOfSession) are
 * implemented by task 2.2; this revision only ships the lifecycle
 * + drift surfaces named in tasks.md task 2.1.
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
