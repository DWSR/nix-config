/*
 * _helpers.js — shared utilities for the integration test suite of
 * the opencode-cost-diagnosis spec (task 6.2).
 *
 * Filename prefix `_` so the test discovery regex in run.js
 * (`(\.|-)test\.(?:c?js|mjs)$`) ignores us — we are NOT a test file
 * ourselves; we expose helpers to sibling `*.test.js` files.
 *
 * Most helpers are siblings/refinements of the ones cli-entry.test.js
 * developed in task 5.3; they are deliberately reimplemented here
 * rather than imported across the unit/integration boundary so each
 * test layer can evolve its plumbing independently.
 *
 *   mkSandbox        — XDG_STATE_HOME + OPENCODE_DB_PATH sandbox
 *   runMain          — capture stdout/stderr + return numeric exit code
 *   listReports      — enumerate report files written by the sandbox
 *   readReport       — { md, json } single-report read with parsing
 *   normalizeMd      — strip wall-clock noise from MD for golden diff
 *   copyFixture      — copy the pinned 1.6 fixture to a writable temp
 *   mkEmptyFixture   — schema-but-no-rows DB for test 3
 *   updateGolden     — `UPDATE_GOLDEN=1`-aware regen helper
 *   readGolden       — read a golden file, normalising the line ending
 *
 * The shared `main()` is loaded once at module scope so individual
 * tests don't pay the cost of re-resolving the production script and
 * its native deps (better-sqlite3 / tiktoken) for every test case.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Database = require('better-sqlite3');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'opencode-cost-report.js');
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'opencode-cost-diagnosis', 'fixtures');
const FIXTURE_DB = path.join(FIXTURE_DIR, 'opencode-stable.db');
const GOLDEN_DIR = path.join(__dirname, 'golden');

const productionScript = require(SCRIPT_PATH);

// ── Sandbox / environment ───────────────────────────────────────

/**
 * Create a per-test sandbox. Sets:
 *   - XDG_STATE_HOME to a fresh tempdir so FileWriter writes there
 *     instead of polluting $HOME.
 *   - OPENCODE_DB_PATH to opts.dbPath (default: the pinned fixture).
 *     Pass `null` to UNSET (testing the default-resolution path).
 *
 * Returns { stateDir, cleanup }. ALWAYS call cleanup() in a finally
 * block — node:test runs in parallel by default, so a leaked env var
 * across sibling tests would tangle stable output.
 */
function mkSandbox(opts) {
  const o = opts || {};
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-integ-state-'),
  );
  const prior = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    OPENCODE_DB_PATH: process.env.OPENCODE_DB_PATH,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.XDG_STATE_HOME = stateDir;
  if (o.dbPath === null) {
    delete process.env.OPENCODE_DB_PATH;
  } else if (o.dbPath !== undefined) {
    process.env.OPENCODE_DB_PATH = o.dbPath;
  } else {
    process.env.OPENCODE_DB_PATH = FIXTURE_DB;
  }
  return {
    stateDir,
    cleanup() {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // Best-effort; the test's result matters more.
      }
    },
  };
}

/**
 * Invoke productionScript.main(argv) with stdout/stderr captured.
 * Returns { exitCode, stdout, stderr }. main() is contractually
 * non-throwing (errors map to exit codes per design.md:1025-1041),
 * but we still restore the streams in a finally to keep paranoia
 * cheap.
 */
function runMain(argv) {
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
    const exitCode = productionScript.main(argv);
    return {
      exitCode,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

// ── Report-file enumeration / reading ───────────────────────────

function reportsDir(stateDir) {
  return path.join(stateDir, 'opencode-cost-diagnosis', 'reports');
}

function listReports(stateDir) {
  const dir = reportsDir(stateDir);
  if (!fs.existsSync(dir)) return { mds: [], jsons: [] };
  const entries = fs.readdirSync(dir);
  return {
    mds: entries.filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n)).sort(),
    jsons: entries.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)).sort(),
  };
}

/**
 * Read the single (MD, JSON) pair from a sandbox's reports dir.
 * Assumes exactly one of each — tests that produce multiple pairs
 * should enumerate via listReports() directly.
 *
 * Returns { mdPath, jsonPath, md, json, parsed } where `parsed` is
 * the JSON-deserialised object.
 */
function readReport(stateDir) {
  const { mds, jsons } = listReports(stateDir);
  if (mds.length !== 1 || jsons.length !== 1) {
    throw new Error(
      `readReport: expected exactly one MD and one JSON in ${reportsDir(stateDir)}; ` +
        `got ${mds.length} MD, ${jsons.length} JSON`,
    );
  }
  const md = fs.readFileSync(mds[0], 'utf8');
  const json = fs.readFileSync(jsons[0], 'utf8');
  return {
    mdPath: mds[0],
    jsonPath: jsons[0],
    md,
    json,
    parsed: JSON.parse(json),
  };
}

// ── Golden-file plumbing ────────────────────────────────────────

/**
 * Normalise wall-clock noise out of a Markdown report so two runs
 * produce identical strings. The MD serializer (per
 * scripts/opencode-cost-report.js:1791-1799) is the ONLY place
 * the timestamp leaks into report content (JSON has none, by
 * R6.AC3). Replace that line with a stable placeholder so the
 * golden diff still pins the presence of the line without binding
 * to a specific instant.
 *
 * If the report format ever grows additional wall-clock fields,
 * extend this function with more regex passes; the byte-identical
 * JSON path (R6.AC3) means we never need a parallel normaliser
 * for JSON.
 */
function normalizeMd(md) {
  return md.replace(
    /^_Report generated: [^_]+_$/m,
    '_Report generated: <REDACTED-FOR-GOLDEN>_',
  );
}

/**
 * Read a committed golden file from golden/. Returns null if the
 * file does not exist; lets the test fall through to a seed-on-first-
 * run flow gated by UPDATE_GOLDEN=1.
 */
function readGolden(filename) {
  const p = path.join(GOLDEN_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * Write a golden file. Used ONLY when UPDATE_GOLDEN=1 is in the
 * environment OR when a golden file doesn't exist yet (initial
 * seed). Always recreates the golden dir to keep behaviour stable
 * if a developer deletes it.
 */
function writeGolden(filename, contents) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(GOLDEN_DIR, filename), contents, 'utf8');
}

function isUpdateMode() {
  return process.env.UPDATE_GOLDEN === '1';
}

// ── Fixture helpers ─────────────────────────────────────────────

/**
 * Copy the pinned fixture DB to a fresh tempdir and return both the
 * path and a cleanup() that removes the parent tempdir. Used by
 * tests that need to mutate the DB (mutate journal mode, add rows,
 * etc.) without contaminating the canonical fixture committed at
 * tests/opencode-cost-diagnosis/fixtures/opencode-stable.db.
 */
function copyFixture(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix || 'opencode-integ-copy-'}`));
  const tmp = path.join(tmpDir, 'opencode-stable.db');
  fs.copyFileSync(FIXTURE_DB, tmp);
  return {
    path: tmp,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Create a fresh DB with the SAME schema as the 1.6 fixture but no
 * session / message / part rows. The one row inserted is the pinned
 * `data_migration` baseline (`session_usage_from_messages`) so the
 * reader's schema-drift check passes.
 *
 * Returns { path, cleanup }. Test 3 (empty-DB success) uses this to
 * verify the assembler's empty-but-valid report path (R2.AC8) end-
 * to-end through main().
 */
function mkEmptyFixture(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix || 'opencode-integ-empty-'}`));
  const tmp = path.join(tmpDir, 'opencode-empty.db');
  const db = new Database(tmp);
  // Mirror the production-fixture journal/sync posture so any future
  // operator who inspects the file with `file(1)` sees identical
  // metadata. Not load-bearing for the test logic.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  db.pragma('application_id = 0');
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
      type         TEXT NOT NULL,
      data         TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE data_migration (
      name           TEXT PRIMARY KEY,
      time_completed INTEGER NOT NULL
    );
  `);
  // The pinned baseline so SqliteReader.open() does not throw
  // SchemaDriftError. Timestamp value is irrelevant — the diagnostic
  // never reads it.
  db.prepare(
    'INSERT INTO data_migration (name, time_completed) VALUES (?, ?)',
  ).run('session_usage_from_messages', 0);
  db.close();
  return {
    path: tmp,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

module.exports = {
  FIXTURE_DB,
  FIXTURE_DIR,
  GOLDEN_DIR,
  copyFixture,
  isUpdateMode,
  listReports,
  mkEmptyFixture,
  mkSandbox,
  normalizeMd,
  readGolden,
  readReport,
  runMain,
  writeGolden,
};
