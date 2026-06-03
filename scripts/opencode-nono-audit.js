/*
 * scripts/opencode-nono-audit.js — entry point for the
 * opencode-nono-audit CLI (opencode-nono-audit spec, Task 1.2,
 * Requirement 1.1).
 *
 * This is the SCAFFOLD stub. It supports the two short-circuit flags
 * required by the observable completion (`--help`, `--version`) and a
 * `require.main === module` script-vs-module guard so the file is
 * cleanly `require()`-able by the node:test suite without triggering
 * CLI side effects. Subsequent tasks fill in the audit / assess /
 * review business logic; there is intentionally none here yet.
 *
 * The `.nix` wrapper (scripts/opencode-nono-audit.nix) execs this
 * file via the repo nodejs, exporting NODE_PATH against the vendored
 * `opencode-cost-diagnosis-deps` tree and OPENCODE_NONO_COST_REPORT_LIB
 * pointing at the sibling cost-report library. The audit code below
 * does `require(process.env.OPENCODE_NONO_COST_REPORT_LIB)` for
 * SqliteReader at runtime, falling back to a relative require of the
 * sibling cost-report script (resolved from __dirname) when that env
 * var is unset — which is the case under `node --test`, where tests
 * pass fixture paths directly to runAudit().
 *
 * ─────────────────────────────────────────────────────────────────
 * Task 2.1 (Requirements 1.1, 1.3, 1.4, 1.5, 1.6) adds runAudit's
 * SOURCE-OPENING layer: open the OpenCode session DB read-only via the
 * reused SqliteReader, optionally open the cavemem data.db read-only as
 * a version-guarded secondary source, track per-source SourceStatus,
 * mark the report `partial` on any degraded source, and return an
 * error Result (no UsageAudit / no assessment) when no source is
 * readable at all (R1.5).
 *
 * SCOPE: 2.1 owns ONLY source-opening + SourceStatus + partial +
 * no-source-error. CAPABILITY EXTRACTION (parsing tool parts into
 * CapabilityRecord[]) and unobservableClasses population are task 2.2;
 * see the documented extension point in buildAudit() where both are
 * returned as empty arrays for now (NOT a silent stub).
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.0.0';

/**
 * Resolve and load the reused cost-report library (SqliteReader +
 * SchemaDriftError). The `.nix` wrapper exports
 * OPENCODE_NONO_COST_REPORT_LIB to the store path of
 * scripts/opencode-cost-report.js; under `node --test` that env var is
 * unset, so we fall back to the sibling script resolved from this
 * file's directory. Either way the reader opens sources read-only
 * (SqliteReader uses `{ readonly: true, fileMustExist: true }`).
 *
 * @returns {{ SqliteReader: Function, SchemaDriftError: Function }}
 */
function loadCostReportLib() {
  const fromEnv = process.env.OPENCODE_NONO_COST_REPORT_LIB;
  const libPath =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : path.resolve(__dirname, 'opencode-cost-report.js');
  return require(libPath);
}

/**
 * Resolve the default OpenCode session DB path when the caller gives
 * none: `OPENCODE_DB_PATH` else `${XDG_DATA_HOME:-~/.local/share}/
 * opencode/opencode-stable.db`.
 *
 * @returns {string}
 */
function defaultSessionDbPath() {
  if (process.env.OPENCODE_DB_PATH && process.env.OPENCODE_DB_PATH.length > 0) {
    return process.env.OPENCODE_DB_PATH;
  }
  const xdgData =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : path.join(process.env.HOME || '', '.local', 'share');
  return path.join(xdgData, 'opencode', 'opencode-stable.db');
}

/**
 * The cavemem `data.db` schema version this audit understands. The
 * fixture (and the live cavemem store) is schema_version = 2; opening a
 * cavemem DB whose `schema_version.version` differs is treated as an
 * `incompatible` source (version guard, R1.3), never a crash.
 */
const SUPPORTED_CAVEMEM_SCHEMA_VERSION = 2;

/**
 * Open the OpenCode session DB read-only via the reused SqliteReader
 * and classify the result into a SourceStatus.
 *
 * - Success → `{ status: 'ok' }`, with the open reader returned so the
 *   capability parser (task 2.2) can iterate it. The caller owns
 *   closing the reader.
 * - SchemaDriftError (or any other open failure that is not a plain
 *   missing/unreadable file) → `{ status: 'incompatible' }`; NEVER
 *   crashes on drift (R1.4).
 * - Missing / unreadable file → `{ status: 'missing' }` (the reader
 *   wraps SQLITE_CANTOPEN / ENOENT and attaches `.dbPath`).
 *
 * @param {string} dbPath
 * @param {{ SqliteReader: Function, SchemaDriftError: Function }} lib
 * @returns {{ status: { source: 'opencode-sqlite', status: string, detail?: string }, reader: object|null }}
 */
function openSessionSource(dbPath, lib) {
  const { SqliteReader, SchemaDriftError } = lib;
  const reader = new SqliteReader();
  try {
    reader.open(dbPath);
    return {
      status: { source: 'opencode-sqlite', status: 'ok' },
      reader,
    };
  } catch (e) {
    // Best-effort: a failed open() already released its own handle, but
    // close defensively in case a future reader leaves one open.
    try {
      reader.close();
    } catch {
      /* reader never opened a handle; nothing to release */
    }

    if (e instanceof SchemaDriftError) {
      // Schema drift → incompatible source + partial; the reader cannot
      // be iterated. R1.4: degrade, never crash.
      const detail = `schema drift: detected [${(e.detectedMigrationSet || []).join(', ')}]`;
      return {
        status: { source: 'opencode-sqlite', status: 'incompatible', detail },
        reader: null,
      };
    }

    // Missing / unreadable file: the reader attaches `.dbPath` and a
    // descriptive message. We cannot distinguish ENOENT from EACCES
    // reliably across platforms, so a missing file existence check
    // disambiguates "missing" from "unreadable".
    const exists = fileExists(dbPath);
    const detail = e && e.message ? e.message : String(e);
    return {
      status: {
        source: 'opencode-sqlite',
        status: exists ? 'unreadable' : 'missing',
        detail,
      },
      reader: null,
    };
  }
}

/**
 * Open the cavemem `data.db` read-only as a best-effort SECONDARY
 * source, version-guarded on `schema_version.version` (R1.3).
 *
 * - Success at the supported schema version → `{ status: 'ok' }`.
 * - Wrong schema version → `{ status: 'incompatible' }`.
 * - Missing / unreadable file (or unexpected schema layout) →
 *   `{ status: 'missing' | 'unreadable' }`.
 *
 * The handle is opened `{ readonly: true, fileMustExist: true }` and is
 * closed before returning — task 2.1 only needs the version guard and
 * status; cavemem observation iteration is a task 2.2 concern.
 *
 * @param {string} cavememDbPath
 * @returns {{ source: 'cavemem', status: string, detail?: string }}
 */
function openCavememSource(cavememDbPath) {
  // better-sqlite3 is resolvable via NODE_PATH (wrapper) or the deps
  // tree the test node exports. Require lazily so a session-only audit
  // that never touches cavemem does not pay for it.
  const Database = require('better-sqlite3');

  let db = null;
  try {
    db = new Database(cavememDbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT version FROM schema_version').get();
    const version = row && typeof row.version !== 'undefined' ? row.version : null;
    if (version !== SUPPORTED_CAVEMEM_SCHEMA_VERSION) {
      return {
        source: 'cavemem',
        status: 'incompatible',
        detail: `unsupported cavemem schema_version ${String(version)} (expected ${SUPPORTED_CAVEMEM_SCHEMA_VERSION})`,
      };
    }
    return { source: 'cavemem', status: 'ok' };
  } catch (e) {
    const exists = fileExists(cavememDbPath);
    const detail = e && e.message ? e.message : String(e);
    return {
      source: 'cavemem',
      status: exists ? 'unreadable' : 'missing',
      detail,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* best-effort handle release */
      }
    }
  }
}

/** True iff `p` names an existing path on disk. */
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * R1.5's hard-fail discriminator: the audit returns an error Result
 * (no UsageAudit, no assessment) only when NO source was even openable
 * — i.e., every recorded source is `missing` or `unreadable`. An
 * `incompatible` source (schema drift / wrong cavemem version) IS a
 * source that was found and inspected; it degrades the report to
 * `partial` but the audit still proceeds and reports it. This matches
 * the task observable completion: the drift fixture produces
 * `incompatible` + partial (an ok Result), while the truly-empty
 * (missing/unreadable everything) case exits nonzero.
 *
 * @param {{ status: string }} status
 * @returns {boolean} true when this source can anchor a report.
 */
function isReportable(status) {
  return status.status === 'ok' || status.status === 'incompatible';
}

/**
 * @typedef {object} AuditOptions
 * @property {string} [sessionDbPath] Override the OpenCode session DB
 *   path. Defaults to {@link defaultSessionDbPath}.
 * @property {string} [cavememDbPath] Optional cavemem data.db path. When
 *   omitted, cavemem is treated as not-configured (its absence is NOT a
 *   degradation and does NOT mark the report partial — R1.3).
 */

/**
 * runAudit — the read-only audit entry point. Task 2.1 implements the
 * source-opening layer only.
 *
 * Opens the OpenCode session DB read-only (R1.1) and, when configured,
 * the cavemem data.db read-only as a version-guarded secondary source
 * (R1.3). Records a SourceStatus per source; a degraded source marks
 * the report `partial` and is named in `sources[]` (R1.4). Never
 * mutates any source (R1.6: SqliteReader opens `{ readonly: true }`,
 * cavemem opens `{ readonly: true, fileMustExist: true }`). When NO
 * source is readable, returns an error Result with no UsageAudit and no
 * assessment (R1.5).
 *
 * @param {AuditOptions} [opts]
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 *   On success, `value` is a UsageAudit
 *   ({ schemaVersion, generatedAt, partial, sources, capabilities,
 *   unobservableClasses }).
 */
function runAudit(opts) {
  const options = opts || {};
  const sessionDbPath = options.sessionDbPath || defaultSessionDbPath();
  const cavememConfigured =
    typeof options.cavememDbPath === 'string' && options.cavememDbPath.length > 0;

  const lib = loadCostReportLib();

  /** @type {Array<{ source: string, status: string, detail?: string }>} */
  const sources = [];

  // Primary source: OpenCode session DB (R1.1).
  const session = openSessionSource(sessionDbPath, lib);
  sources.push(session.status);

  // The session reader is opened for the capability parser (task 2.2);
  // task 2.1 has no capability work, so release it immediately to keep
  // the audit strictly read-only with no lingering handle. Task 2.2
  // will move the iteration before this close().
  if (session.reader) {
    try {
      session.reader.close();
    } catch {
      /* best-effort handle release */
    }
  }

  // Secondary source: cavemem data.db (R1.3), version-guarded and
  // optional. Only recorded when a path was configured; an unconfigured
  // optional source is not a degradation.
  if (cavememConfigured) {
    sources.push(openCavememSource(options.cavememDbPath));
  }

  // R1.5: no source readable at all → error Result, no UsageAudit, no
  // assessment. "No source readable" means nothing was even openable
  // (every source missing/unreadable); an `incompatible` source is
  // still reportable (drift → partial report, not hard fail). The
  // actual process.exit mapping is wired in task 5.3; here we surface
  // the error envelope and name the inspected sources.
  if (!sources.some(isReportable)) {
    return {
      ok: false,
      error: {
        kind: 'no-readable-source',
        detail: 'no audit source was readable; cannot produce an assessment',
        sources,
      },
    };
  }

  return { ok: true, value: buildAudit(sources) };
}

/**
 * Assemble a UsageAudit from the opened sources. A report is `partial`
 * when ANY recorded source is degraded (status !== 'ok'); an
 * unconfigured optional source is simply absent from `sources` and so
 * does not count toward partiality (R1.4).
 *
 * 2.2 EXTENSION POINT: `capabilities` and `unobservableClasses` are
 * intentionally empty here. Task 2.1 owns only the source-opening
 * layer; the capability parser (task 2.2) iterates the readable session
 * source into CapabilityRecord[] and enumerates the capability classes
 * that could not be observed into `unobservableClasses`. Empty arrays
 * are the CORRECT 2.1 output, not a stub.
 *
 * @param {Array<{ source: string, status: string, detail?: string }>} sources
 * @returns {object} UsageAudit
 */
function buildAudit(sources) {
  const partial = sources.some((s) => s.status !== 'ok');
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    partial,
    sources,
    capabilities: [], // populated by task 2.2 (capability parser)
    unobservableClasses: [], // populated by task 2.2 (coverage-gap disclosure)
  };
}

const USAGE = `opencode-nono-audit — read-only OpenCode tool-usage audit

Usage:
  opencode-nono-audit [options]

Options:
  -h, --help       Print this usage text and exit.
  -v, --version    Print the version and exit.
`;

/**
 * CLI entry point.
 *
 * @param {string[]} argv - Arguments after `node script.js` (i.e.
 *   `process.argv.slice(2)`).
 * @returns {number} Process exit code.
 */
function main(argv) {
  const args = Array.isArray(argv) ? argv : [];

  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // No business logic yet (scaffold). Print usage to stderr and signal
  // "not implemented" so an accidental bare invocation is obvious
  // rather than silently succeeding.
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  main,
  VERSION,
  USAGE,
  // Task 2.1: source-opening layer. runAudit is the public entry point;
  // the helpers are exported for unit-test reach. Capability extraction
  // (task 2.2) consumes runAudit's readable session source.
  runAudit,
  defaultSessionDbPath,
  SUPPORTED_CAVEMEM_SCHEMA_VERSION,
};
