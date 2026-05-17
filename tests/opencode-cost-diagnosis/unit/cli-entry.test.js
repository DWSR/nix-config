/*
 * cli-entry.test.js — unit tests for the CLI Entry main() (task 5.3
 * of .kiro/specs/opencode-cost-diagnosis).
 *
 * Scope: main(argv) is the process-entry orchestrator. It wires
 * ArgumentParser → SqliteReader → SessionSelector → SubagentAggregator
 * → TokenizerSplitter → AttributionEngine → ReportAssembler →
 * ReportSerializer → FileWriter into a single end-to-end pipeline,
 * and is wrapped in a single top-level try/catch that maps caught
 * errors to the design's Error Categories table (design.md:1025-1041):
 *
 *   1 = bad CLI arg               (ArgumentError)
 *   2 = missing source DB         (ENOENT on Reader.open)
 *   3 = schema drift              (SchemaDriftError)
 *   4 = I/O error                 (FileWriterError, non-ENOENT)
 *   5 = programming/assertion     (anything else; INVARIANT throw etc.)
 *
 * Test contract for main():
 *
 *   - main(argv) returns a numeric exit code rather than calling
 *     process.exit. The `require.main === module` block at the
 *     bottom of opencode-cost-report.js passes the return value to
 *     process.exit; tests exercise main() directly so they can
 *     observe the exit code without forking.
 *   - main(argv) writes to process.stdout / process.stderr through
 *     process.stdout.write / process.stderr.write. Tests capture by
 *     monkey-patching those two methods for the duration of one
 *     invocation. Capture is scoped so a thrown test failure can't
 *     leave the patch in place for other tests.
 *
 * Testability hooks (consumed but not implemented here):
 *
 *   - `OPENCODE_DB_PATH` env var overrides the default
 *     `${XDG_DATA_HOME}/opencode/opencode-stable.db` resolution.
 *     Implementation must consult it before falling back to XDG.
 *   - `XDG_STATE_HOME` env var redirects the FileWriter's default
 *     output dir; tests use a mkdtemp'd state dir so we never write
 *     into the operator's real $HOME/.local/state.
 *
 * Requirements covered (per tasks.md task 5.3):
 *   - R1.AC5: identical command surface on both hosts (by
 *     construction; this layer is host-agnostic)
 *   - R2.AC8: zero-session scope → empty-but-valid reports + exit 0
 *   - R6.AC3: byte-identical JSON across two identical invocations
 *     (tested elsewhere; here we verify main() exits 0 + writes a
 *     pair of files that load cleanly as JSON)
 *
 * Design references:
 *   - design.md CLI Entry component summary (line 402)
 *   - design.md Error Handling section, Error Categories table
 *     (lines 1025-1041)
 *   - design.md Recoverable conditions list (lines 1035-1040)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const Database = require('better-sqlite3');

const {
  main,
  SUPPORTED_VERSION_RANGE,
  SUPPORTED_MIGRATION_SET,
} = require(path.join(__dirname, '../../../scripts/opencode-cost-report.js'));

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

// ── Helpers ──────────────────────────────────────────────────────

// Per-test sandbox: a state dir for FileWriter output + (optionally)
// a custom OPENCODE_DB_PATH. Returns a `cleanup()` that removes the
// state dir and restores any env vars we touched. ALWAYS call
// cleanup in a try/finally even on assertion failure — tests run in
// parallel by default under node:test, so a leaked env var would
// poison sibling tests.
function mkSandbox(opts) {
  const o = opts || {};
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cli-entry-test-'),
  );
  const prior = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    OPENCODE_DB_PATH: process.env.OPENCODE_DB_PATH,
  };
  process.env.XDG_STATE_HOME = stateDir;
  if (o.dbPath !== undefined) {
    process.env.OPENCODE_DB_PATH = o.dbPath;
  } else {
    // Default test posture: point at the pinned fixture unless the
    // test explicitly overrides (or unsets via dbPath: null).
    process.env.OPENCODE_DB_PATH = FIXTURE;
  }
  if (o.dbPath === null) {
    delete process.env.OPENCODE_DB_PATH;
  }
  return {
    stateDir,
    cleanup() {
      if (prior.XDG_STATE_HOME === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prior.XDG_STATE_HOME;
      }
      if (prior.OPENCODE_DB_PATH === undefined) {
        delete process.env.OPENCODE_DB_PATH;
      } else {
        process.env.OPENCODE_DB_PATH = prior.OPENCODE_DB_PATH;
      }
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the test result is what matters.
      }
    },
  };
}

// Capture process.stdout + process.stderr writes for the duration
// of `fn`. Returns { exitCode, stdout, stderr }. Restoration is in
// a finally block so a throwing main() (which the design forbids,
// but tests are paranoia) doesn't leave stdout/stderr patched.
function runMain(argv, fn) {
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
    const exitCode = main(argv);
    if (typeof fn === 'function') fn();
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

function listReports(stateDir) {
  const reportsDir = path.join(stateDir, 'opencode-cost-diagnosis', 'reports');
  if (!fs.existsSync(reportsDir)) return { mds: [], jsons: [] };
  const entries = fs.readdirSync(reportsDir);
  return {
    mds: entries.filter((n) => n.endsWith('.md')).map((n) => path.join(reportsDir, n)),
    jsons: entries.filter((n) => n.endsWith('.json')).map((n) => path.join(reportsDir, n)),
  };
}

function mkMutatedFixture() {
  // Same trick as reader.test.js: copy the fixture to tmp and add an
  // unexpected data_migration row so open() throws SchemaDriftError.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cli-entry-drift-'));
  const tmp = path.join(tmpDir, 'opencode-mutated.db');
  fs.copyFileSync(FIXTURE, tmp);
  const m = new Database(tmp);
  m.exec(
    "INSERT INTO data_migration (name, time_completed) " +
      "VALUES ('hypothetical_v2_migration', 1700000000000)",
  );
  m.close();
  return {
    tmp,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ── --help ──────────────────────────────────────────────────────

test('main(--help): prints full usage, exits 0', () => {
  // The 1.3 stub printed a placeholder "Stub (Task 1.3 …)" line.
  // The 5.3 surface must replace it with the real flag list.
  const sb = mkSandbox();
  try {
    const { exitCode, stdout, stderr } = runMain(['--help']);
    assert.equal(exitCode, 0, '--help must exit 0');
    assert.equal(stderr, '', '--help writes only to stdout');
    // Every published flag must appear so an operator who runs
    // --help is never left guessing about the surface.
    for (const flag of [
      '--last',
      '--session',
      '--cwd',
      '--include-content',
      '--format',
      '--output',
      '--supported-opencode-version',
      '--help',
    ]) {
      assert.ok(
        stdout.includes(flag),
        `--help output must mention ${flag} (saw: ${stdout.slice(0, 200)}…)`,
      );
    }
    // The stub's "Stub (Task 1.3" line MUST be gone — the 1.3 task
    // brief explicitly says 5.3 is the trigger to remove it. If
    // this string survives the implementation, the stub usage was
    // left in place by mistake.
    assert.ok(
      !stdout.includes('Stub (Task 1.3'),
      '--help must no longer reference the 1.3 stub language',
    );
  } finally {
    sb.cleanup();
  }
});

test('main(-h): short form is equivalent to --help', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stdout, stderr } = runMain(['-h']);
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.length > 0, '-h must print usage');
  } finally {
    sb.cleanup();
  }
});

// ── --supported-opencode-version ────────────────────────────────

test('main(--supported-opencode-version): prints version range + migration set, exits 0', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stdout, stderr } = runMain(['--supported-opencode-version']);
    assert.equal(exitCode, 0, 'introspection command must exit 0');
    assert.equal(stderr, '', 'introspection writes only to stdout');
    assert.ok(
      stdout.includes(SUPPORTED_VERSION_RANGE),
      `output must include the pinned version range (got: ${stdout})`,
    );
    for (const migration of SUPPORTED_MIGRATION_SET) {
      assert.ok(
        stdout.includes(migration),
        `output must include the pinned migration name '${migration}'`,
      );
    }
  } finally {
    sb.cleanup();
  }
});

// ── Bad argument → exit 1 ───────────────────────────────────────

test('main(--last 7d6h): exit 1 + stderr trailer naming the offending arg', () => {
  // R3.AC5: actionable error naming the offending value. The CLI
  // Entry maps ArgumentError → exit 1 and writes a one-line stderr
  // trailer that includes the parser's error message verbatim.
  const sb = mkSandbox();
  try {
    const { exitCode, stdout, stderr } = runMain(['--last', '7d6h']);
    assert.equal(exitCode, 1, 'bad arg must exit 1');
    assert.ok(
      stderr.length > 0,
      'bad-arg trailer must be written to stderr',
    );
    assert.ok(
      stderr.includes('7d6h'),
      `stderr must name the offending value (got: ${stderr})`,
    );
    assert.ok(
      stderr.includes('--last'),
      `stderr must name the offending flag (got: ${stderr})`,
    );
    // No reports should have been written.
    const reports = listReports(sb.stateDir);
    assert.equal(
      reports.mds.length, 0,
      'bad-arg path must not write any Markdown report',
    );
    assert.equal(
      reports.jsons.length, 0,
      'bad-arg path must not write any JSON report',
    );
  } finally {
    sb.cleanup();
  }
});

test('main(unknown flag): exit 1 + stderr names the unknown flag', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stderr } = runMain(['--bogus-flag']);
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes('--bogus-flag'),
      `stderr must name the unknown flag (got: ${stderr})`,
    );
  } finally {
    sb.cleanup();
  }
});

// ── Missing DB → exit 2 ─────────────────────────────────────────

test('main: missing DB path produces exit 2 with the path in stderr (R6.AC4)', () => {
  const sb = mkSandbox({
    dbPath: '/nonexistent/path/opencode-stable.db',
  });
  try {
    const { exitCode, stderr } = runMain([]);
    assert.equal(exitCode, 2, 'missing DB must exit 2');
    assert.ok(
      stderr.includes('/nonexistent/path/opencode-stable.db'),
      `stderr trailer must name the expected DB path (R6.AC4); got: ${stderr}`,
    );
  } finally {
    sb.cleanup();
  }
});

// ── Schema drift → exit 3 ───────────────────────────────────────

test('main: mutated DB with drifted data_migration → exit 3 + drift trailer', () => {
  const drift = mkMutatedFixture();
  const sb = mkSandbox({ dbPath: drift.tmp });
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);
    assert.equal(exitCode, 3, 'schema drift must exit 3');
    assert.ok(
      stderr.toLowerCase().includes('drift') ||
        stderr.toLowerCase().includes('schema'),
      `stderr trailer must mention drift/schema (got: ${stderr})`,
    );
    // The drift detail (the unexpected migration name) should
    // appear so an operator can act without spelunking.
    assert.ok(
      stderr.includes('hypothetical_v2_migration'),
      `stderr should name the unexpected migration (got: ${stderr})`,
    );
  } finally {
    sb.cleanup();
    drift.cleanup();
  }
});

// ── End-to-end success against the 1.6 fixture ─────────────────

test('main(--last 365d): full end-to-end run produces MD + JSON reports + exit 0', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stdout, stderr } = runMain(['--last', '365d']);
    assert.equal(
      exitCode, 0,
      `e2e run must exit 0 (stderr was: ${stderr})`,
    );
    assert.equal(stderr, '', 'happy path must not write to stderr');
    const reports = listReports(sb.stateDir);
    assert.equal(
      reports.mds.length, 1,
      `expected exactly one Markdown report; got ${reports.mds.length}`,
    );
    assert.equal(
      reports.jsons.length, 1,
      `expected exactly one JSON report; got ${reports.jsons.length}`,
    );
    // Operator summary should mention both paths so the operator
    // can locate the artifacts without re-deriving the XDG dir.
    assert.ok(
      stdout.includes(reports.mds[0]),
      `stdout summary must mention the MD report path; stdout=${stdout}`,
    );
    assert.ok(
      stdout.includes(reports.jsons[0]),
      `stdout summary must mention the JSON report path; stdout=${stdout}`,
    );
    // JSON output must round-trip through JSON.parse, and the
    // report should observe the 3 root sessions in the fixture.
    const parsed = JSON.parse(fs.readFileSync(reports.jsons[0], 'utf8'));
    assert.equal(parsed.sessionCount, 3, 'fixture has 3 root sessions');
    assert.equal(parsed.reportType, 'opencode-cost-diagnosis');
  } finally {
    sb.cleanup();
  }
});

// ── --session non-existent → empty-but-valid + exit 0 (R2.AC8) ─

test('main(--session non-existent-id): empty-but-valid reports, exit 0 (R2.AC8)', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stderr } = runMain(['--session', 'no-such-session']);
    assert.equal(exitCode, 0, 'empty-result is success per R2.AC8');
    assert.equal(stderr, '', 'happy path must not write to stderr');
    const reports = listReports(sb.stateDir);
    assert.equal(reports.mds.length, 1, 'MD report still produced');
    assert.equal(reports.jsons.length, 1, 'JSON report still produced');
    const parsed = JSON.parse(fs.readFileSync(reports.jsons[0], 'utf8'));
    assert.equal(parsed.sessionCount, 0, 'no sessions in scope');
    // Disclaimer is always present (R2.AC9 + assembler contract).
    assert.ok(
      parsed.tokenizer_disclaimer,
      'tokenizer disclaimer must be present even in the empty case',
    );
  } finally {
    sb.cleanup();
  }
});

// ── Default DB path resolution (no env var) ────────────────────

test('main: with no OPENCODE_DB_PATH env, resolves to XDG_DATA_HOME/opencode/...', () => {
  // We can't easily exercise the happy path of the default
  // resolution (it would try to open the operator's real DB), but
  // we CAN verify that with both env vars unset and a non-existent
  // default path, the resolution lands on the expected XDG-derived
  // path. Use a temp XDG_DATA_HOME pointing nowhere; expect exit 2
  // with the resolved path named in stderr.
  const xdgDataHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cli-xdg-data-'),
  );
  const sb = mkSandbox({ dbPath: null });
  const priorXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;
  try {
    const { exitCode, stderr } = runMain([]);
    assert.equal(exitCode, 2, 'missing DB at default path must exit 2');
    const expectedPath = path.join(xdgDataHome, 'opencode', 'opencode-stable.db');
    assert.ok(
      stderr.includes(expectedPath),
      `stderr must name the resolved default DB path (got: ${stderr})`,
    );
  } finally {
    if (priorXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = priorXdg;
    }
    fs.rmSync(xdgDataHome, { recursive: true, force: true });
    sb.cleanup();
  }
});

// ── Output override hits exit 0 with exactly one named file ─────

test('main(--output <path.json>): single-file mode writes one JSON, exit 0', () => {
  const sb = mkSandbox();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cli-out-'));
  const outPath = path.join(outDir, 'report.json');
  try {
    const { exitCode, stderr } = runMain([
      '--last', '365d',
      '--output', outPath,
    ]);
    assert.equal(exitCode, 0, `override mode must exit 0 (stderr=${stderr})`);
    assert.ok(fs.existsSync(outPath), 'override path must contain the JSON');
    // Default reports/ dir should NOT have been created in override
    // mode (design says single-file mode skips that branch entirely).
    const defaultReports = listReports(sb.stateDir);
    assert.equal(
      defaultReports.mds.length, 0,
      'override mode must not write the default-path Markdown report',
    );
    assert.equal(
      defaultReports.jsons.length, 0,
      'override mode must not write the default-path JSON report',
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    sb.cleanup();
  }
});

// ── Exit code is a number (not undefined / null) ────────────────

test('main: always returns a numeric exit code', () => {
  // Catches the "forgot to return on the happy path" regression
  // where process.exit(undefined) would silently behave as exit 0
  // but break the `process.exit(main(...))` wrapper.
  const sb = mkSandbox();
  try {
    const { exitCode } = runMain(['--help']);
    assert.equal(
      typeof exitCode, 'number',
      'main() must return a number for process.exit to consume',
    );
  } finally {
    sb.cleanup();
  }
});
