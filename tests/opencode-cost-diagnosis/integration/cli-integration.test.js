/*
 * cli-integration.test.js — the five integration tests enumerated in
 * design.md Testing Strategy (lines 1089-1104), per task 6.2 of
 * .kiro/specs/opencode-cost-diagnosis.
 *
 *   (1) End-to-end against the 1.6 fixture w/ golden-file comparison
 *       for MD (normalised) and byte-identical JSON.
 *   (2) Concurrent reader vs active writer — diagnostic reads while
 *       a writer adds rows; neither blocks the other; no corruption.
 *   (3) Empty-DB success — fixture with schema but no session rows
 *       produces valid empty MD + JSON reports and exit 0.
 *   (4) Disclaimer presence — every report whose attribution touches
 *       uncached sub-buckets contains the human-readable disclaimer
 *       block (MD) and the structured `tokenizer_disclaimer` object
 *       (JSON).
 *   (5) CLI-flag AND semantics — `--last 365d --cwd <fixture-cwd>`
 *       returns exactly the matching root session.
 *
 * Tests 1 + 4 share data (the e2e run produces output that exercises
 * both); they are nevertheless implemented as distinct `test()`
 * declarations so a regression in one doesn't mask the other. Test 1
 * pins the bytes; test 4 pins the contract.
 *
 * Boundary: tests/opencode-cost-diagnosis/integration/ only. We do
 * NOT touch scripts/opencode-cost-report.js, the unit-test tree, or
 * the pinned 1.6 fixture — copyFixture() / mkEmptyFixture() spin up
 * isolated DBs in $TMPDIR for the cases that need to mutate.
 *
 * Golden-file regeneration: rerun the suite with `UPDATE_GOLDEN=1`
 * (e.g. `UPDATE_GOLDEN=1 opencode-cost-diagnosis-node --test
 * tests/opencode-cost-diagnosis/integration/`); the helper layer
 * detects the env var and rewrites the committed bytes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Database = require('better-sqlite3');

const {
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
} = require('./_helpers.js');

const GOLDEN_MD = 'fixture-365d-all.md';
const GOLDEN_JSON = 'fixture-365d-all.json';

// ── Test 1: End-to-end golden comparison ────────────────────────

test('integration (1): end-to-end fixture run produces golden MD (normalised) + byte-identical JSON', () => {
  // Two successive invocations into two separate sandboxes so we can
  // verify byte-identical JSON across runs (R6.AC3) without sharing
  // a reports dir. mkSandbox mutates process.env at call time, so
  // sandbox lifecycles must be strictly nested — set up sb1, run,
  // read, tear down; THEN set up sb2, run, read, tear down. Stacking
  // both sandboxes before running would let sb2 overwrite sb1's
  // OPENCODE_DB_PATH / XDG_STATE_HOME and silently make both runs
  // write into sb2 (with the first invocation's output landing in
  // sb1's empty dir).
  let out1;
  const sb1 = mkSandbox();
  try {
    const r1 = runMain(['--last', '365d']);
    assert.equal(r1.exitCode, 0, `run 1 must exit 0 (stderr=${r1.stderr})`);
    out1 = readReport(sb1.stateDir);
  } finally {
    sb1.cleanup();
  }

  let out2;
  const sb2 = mkSandbox();
  try {
    const r2 = runMain(['--last', '365d']);
    assert.equal(r2.exitCode, 0, `run 2 must exit 0 (stderr=${r2.stderr})`);
    out2 = readReport(sb2.stateDir);
  } finally {
    sb2.cleanup();
  }

  // From here on no sandbox is active — pure in-memory assertions
  // against the captured outputs.
  {

    // R6.AC3: byte-identical JSON across two identical invocations.
    // String equality on the raw on-disk bytes is the strictest
    // form of this assertion; if formatJson() ever leaks a
    // non-deterministic field (Date, PID, etc.) this test catches it.
    assert.equal(
      out1.json,
      out2.json,
      'JSON output MUST be byte-identical across two identical runs (R6.AC3)',
    );

    // Golden seeding: on first run (no committed golden file) OR
    // when the operator runs with UPDATE_GOLDEN=1, write the
    // observed bytes back to disk and mark the test passing. The
    // CI invocation (no env var, files exist) hits the assertion
    // branch.
    const goldenJson = readGolden(GOLDEN_JSON);
    const goldenMd = readGolden(GOLDEN_MD);
    const normalisedMd = normalizeMd(out1.md);

    if (goldenJson === null || isUpdateMode()) {
      writeGolden(GOLDEN_JSON, out1.json);
    }
    if (goldenMd === null || isUpdateMode()) {
      writeGolden(GOLDEN_MD, normalisedMd);
    }

    // Re-read after potential seed write so the post-seed run
    // exercises the same comparison codepath as a steady-state run.
    const expectedJson = readGolden(GOLDEN_JSON);
    const expectedMd = readGolden(GOLDEN_MD);

    assert.equal(
      out1.json,
      expectedJson,
      'JSON output must match the committed golden bytes; ' +
        'regenerate with UPDATE_GOLDEN=1 if the change is intentional',
    );
    assert.equal(
      normalisedMd,
      expectedMd,
      'Markdown output (with wall-clock line normalised) must match ' +
        'the committed golden bytes; regenerate with UPDATE_GOLDEN=1 ' +
        'if the change is intentional',
    );

    // Spot-checks beyond the golden bytes: belt-and-suspenders so a
    // mistaken UPDATE_GOLDEN=1 that snapshots a broken state still
    // surfaces here.
    assert.equal(out1.parsed.sessionCount, 3, 'fixture has 3 root sessions');
    assert.equal(out1.parsed.reportType, 'opencode-cost-diagnosis');
    assert.equal(
      Object.keys(out1.parsed.byProject).length,
      3,
      'fixture spans 3 distinct project directories',
    );
  }
});

// ── Test 2: Concurrent reader vs active writer ─────────────────

test('integration (2): diagnostic reads while a writer mutates a parallel DB; neither blocks; no corruption', async () => {
  // Strategy: copy the pinned fixture into $TMPDIR, flip it to WAL
  // (the journal mode opencode itself uses in production), fork a
  // child process that writes one row every few ms via
  // _concurrent-writer.js, and have THIS process run main() against
  // the same DB. Because main() is synchronous, the writes have to
  // come from a separate event loop to be live during the read —
  // an in-process setInterval would only fire AFTER main() returned.
  //
  // The handshake (`ready` → start writes → run main() → `stop` →
  // join) guarantees writes overlap main()'s execution window, so
  // the "concurrent" claim under test is actually exercised.
  //
  // Acceptance criteria from design.md:1095-1097 + task brief:
  //   - Neither side blocks the other (main() returns 0; writer
  //     completes ≥1 write while main() is running).
  //   - No corruption (PRAGMA integrity_check returns 'ok').
  //   - Diagnostic surfaces a valid report (parses cleanly; contains
  //     at least the 3 fixture roots).
  const { fork } = require('node:child_process');

  const fixture = copyFixture('opencode-integ-rwfixture-');
  let child = null;
  let setupHandle = null;
  let verifyHandle = null;

  try {
    // Stage 1: WAL is persistent across handles per SQLite docs, so
    // we set it once on a transient handle. The diagnostic's reader
    // opens read-only; the journal mode that matters is what's
    // baked into the file itself.
    setupHandle = new Database(fixture.path);
    setupHandle.pragma('journal_mode = WAL');
    setupHandle.close();
    setupHandle = null;

    // Stage 2: fork the writer worker. The worker waits for `start`
    // before firing any writes, so the parent can pace the handshake
    // to bracket main()'s window exactly.
    child = fork(
      require('node:path').join(__dirname, '_concurrent-writer.js'),
      [],
      {
        env: { ...process.env, WRITER_DB_PATH: fixture.path },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );

    // Suppress child stdout/stderr — they'd interleave with TAP and
    // confuse the test reporter. The IPC `error` messages give us
    // a structured channel for surfacing failures instead.
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    let writeAttempts = 0;
    let writeSuccesses = 0;
    let stoppedResolve;
    const stoppedPromise = new Promise((res) => { stoppedResolve = res; });
    let readyResolve;
    const readyPromise = new Promise((res) => { readyResolve = res; });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        readyResolve();
      } else if (msg.type === 'wrote') {
        writeAttempts = msg.attempts;
        writeSuccesses = msg.successes;
      } else if (msg.type === 'stopped') {
        writeAttempts = msg.attempts;
        writeSuccesses = msg.successes;
        stoppedResolve();
      }
    });

    // Stage 3: wait for the writer to confirm it has the DB open.
    // 5s timeout — the worker should reach `ready` in <100ms on any
    // sane host; if it takes longer, something is wrong with the
    // fork (deps not resolved, sandbox env not propagated, etc.).
    const readyTimeout = setTimeout(() => {
      readyResolve(); // unblock so the test can fail in a controlled way
    }, 5_000).unref();
    await readyPromise;
    clearTimeout(readyTimeout);

    // Stage 4: arm the writer + give it a head start (~50ms) so a
    // handful of writes have committed BEFORE main() opens its
    // reader handle. This proves the reader can attach to a DB
    // that's been mutated since boot, AND any further writes
    // during main() exercise the live-concurrency claim.
    child.send({ type: 'start' });
    await new Promise((res) => setTimeout(res, 50));
    const writesBeforeMain = writeAttempts;

    // Stage 5: run the diagnostic. Sandbox points it at the writable
    // fixture copy. Capture exit + the report contents for the
    // post-conditions.
    let report;
    let exitCode;
    let stderr;
    const sb = mkSandbox({ dbPath: fixture.path });
    try {
      ({ exitCode, stderr } = runMain(['--last', '365d']));
      report = readReport(sb.stateDir);
    } finally {
      sb.cleanup();
    }
    // IPC messages queued by the child WHILE main() ran cannot be
    // processed until the parent yields the event loop — main() is
    // synchronous end-to-end, so the `wrote` messages from those
    // ticks are still pending in the queue. Yield once so the
    // message handler drains them, then sample. (Without this, the
    // before/after counts would be identical even though the child
    // really did write during main()'s run — a false negative.)
    await new Promise((res) => setImmediate(res));
    const writesAfterMain = writeAttempts;

    // Stage 6: stop the writer cleanly, wait for the IPC ack so we
    // have a final attempts/successes count to assert against, then
    // wait for the process to exit so the test's clean-up doesn't
    // race the OS.
    child.send({ type: 'stop' });
    await Promise.race([
      stoppedPromise,
      new Promise((res) => setTimeout(res, 5_000)),
    ]);
    await new Promise((res) => {
      if (child.exitCode !== null) return res();
      child.once('exit', res);
    });

    // ── Assertions ─────────────────────────────────────────────
    assert.equal(
      exitCode, 0,
      `diagnostic must exit 0 while writer is active; stderr=${stderr}`,
    );
    assert.equal(report.parsed.reportType, 'opencode-cost-diagnosis');
    assert.ok(
      report.parsed.sessionCount >= 3,
      `report must surface at least the fixture's 3 roots; ` +
        `got ${report.parsed.sessionCount}`,
    );
    // Round-trip the JSON — proves no in-band corruption leaked
    // into the serialised output (which would manifest as a parse
    // error or an inequality after re-stringification).
    assert.deepEqual(JSON.parse(report.json), report.parsed);

    // Concurrency claim: writes happened both before main() opened
    // and DURING main()'s execution. If writesAfterMain ===
    // writesBeforeMain, main() returned faster than the worker's
    // event loop could re-schedule — either the host is bizarrely
    // fast or the worker has stalled. The 50ms head start in stage
    // 4 makes that effectively impossible (worker tick interval is
    // 5ms in _concurrent-writer.js).
    assert.ok(
      writesAfterMain > writesBeforeMain,
      `writer must have ticked DURING main(); before=${writesBeforeMain} ` +
        `after=${writesAfterMain}. If this fires, _concurrent-writer.js's ` +
        `interval may be too slow OR main() is returning before the worker ` +
        `gets event-loop time.`,
    );
    // Most concurrent SQLITE_BUSY retries succeed on second attempt,
    // so successes should track attempts closely. Allow up to 25%
    // attrition before flagging.
    assert.ok(
      writeSuccesses >= Math.floor(writeAttempts * 0.75),
      `at least 75% of writer attempts must succeed; ` +
        `attempts=${writeAttempts} successes=${writeSuccesses}`,
    );

    // No-corruption claim: re-open the DB cleanly and run
    // PRAGMA integrity_check. The result row's column name varies
    // by SQLite version; we just check that 'ok' appears somewhere
    // in the row's values.
    verifyHandle = new Database(fixture.path, { readonly: true });
    const integrity = verifyHandle.prepare('PRAGMA integrity_check').all();
    const flat = integrity
      .flatMap((row) => Object.values(row))
      .map((v) => String(v))
      .join(',');
    assert.ok(
      flat.includes('ok'),
      `PRAGMA integrity_check must report 'ok' after the run; got: ${JSON.stringify(integrity)}`,
    );
  } finally {
    if (setupHandle !== null) {
      try { setupHandle.close(); } catch { /* best-effort */ }
    }
    if (verifyHandle !== null) {
      try { verifyHandle.close(); } catch { /* best-effort */ }
    }
    if (child !== null && child.exitCode === null) {
      // Force-kill any orphaned child to avoid a leaked process.
      // _concurrent-writer.js has its own 30s safety unref'd timer
      // for the same reason; this is the parent-side belt.
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    }
    fixture.cleanup();
  }
});

// ── Test 3: Empty-DB success ───────────────────────────────────

test('integration (3): empty DB (schema but no rows) produces valid empty reports + exit 0 (R2.AC8)', () => {
  const empty = mkEmptyFixture('opencode-integ-empty-');
  const sb = mkSandbox({ dbPath: empty.path });
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);
    assert.equal(
      exitCode, 0,
      `empty-DB must be empty-but-valid, exit 0 (R2.AC8); stderr=${stderr}`,
    );
    assert.equal(stderr, '', 'happy path must not write to stderr');

    // The MD + JSON must still be produced — the design's R2.AC8
    // case is "valid empty reports", not "no reports written".
    const reports = listReports(sb.stateDir);
    assert.equal(reports.mds.length, 1, 'MD report must be written even on empty DB');
    assert.equal(reports.jsons.length, 1, 'JSON report must be written even on empty DB');

    const { parsed, md } = readReport(sb.stateDir);
    assert.equal(parsed.sessionCount, 0, 'empty DB → sessionCount: 0');
    assert.deepEqual(parsed.sessions, [], 'empty DB → sessions: []');
    assert.deepEqual(parsed.byProject, {}, 'empty DB → byProject: {}');
    assert.equal(
      parsed.reportType, 'opencode-cost-diagnosis',
      'reportType must still be set on empty reports',
    );

    // R2.AC9: disclaimer is ALWAYS present, even on empty reports.
    // The assembler attaches it unconditionally; this catches any
    // future "skip disclaimer when no uncached buckets" optimisation
    // that would silently drop the operator-facing label.
    assert.ok(
      parsed.tokenizer_disclaimer,
      'tokenizer_disclaimer object must be present on empty reports too',
    );
    assert.match(
      md,
      /^\*\*TOKENIZER ACCURACY DISCLAIMER /m,
      'MD must start with the disclaimer block even on empty reports',
    );
  } finally {
    sb.cleanup();
    empty.cleanup();
  }
});

// ── Test 4: Disclaimer presence ────────────────────────────────

test('integration (4): full-attribution report contains the disclaimer in both MD and JSON (R2.AC9)', () => {
  const sb = mkSandbox();
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);
    assert.equal(exitCode, 0, `e2e run must exit 0 (stderr=${stderr})`);

    const { md, parsed } = readReport(sb.stateDir);

    // Structured JSON disclaimer (per design.md:912-921 +
    // ReportAssembler line 1615 of the production script). Every
    // field below is operator-facing — if any of them go missing,
    // the disclaimer's value to the operator collapses.
    const d = parsed.tokenizer_disclaimer;
    assert.ok(d, 'tokenizer_disclaimer object must be present');
    assert.equal(d.library, 'tiktoken', 'disclaimer must name the library');
    assert.equal(d.encoding, 'cl100k_base', 'disclaimer must name the encoding');
    assert.equal(
      d.accuracyClass, 'relative-only',
      'disclaimer must surface accuracyClass so an operator knows the bound',
    );
    // v2 (task 8.1: V2_COST_COMPUTE_ENABLED default flipped to true)
    // extends affectedBuckets with the cachedRead sub-buckets and the
    // per-tool / per-agent dimension labels. See
    // TOKENIZER_AFFECTED_BUCKETS_V2 in scripts/opencode-cost-report.js
    // (lines 3063-3079) for the canonical ordering, and design.md
    // §ReportSerializer (extended) for the rationale. The v1 list was
    // the three uncached sub-buckets only and is now retained as
    // TOKENIZER_AFFECTED_BUCKETS for the flag-OFF emission path
    // (preserved for the successor cleanup task).
    assert.deepEqual(
      d.affectedBuckets,
      [
        // v1: uncached sub-buckets (proportional split of session.tokens_input)
        'uncachedSystemPrompt',
        'history',
        'toolOutputs',
        // v2: cachedRead sub-buckets (R4.4 tokenizer-derived)
        'systemPromptCached',
        'agentsMdCached',
        'mcpToolSchemasCached',
        'accumulatedHistoryCached',
        'accumulatedToolOutputsCached',
        'unclassifiedCached',
        // v2: per-tool / per-agent dimension labels (R5.4 / R6.5)
        'toolOutputsByTool',
        'subagentDispatchByAgent',
      ],
      'affectedBuckets must enumerate the v2 tokenizer-affected buckets ' +
        '(3 uncached + 6 cachedRead sub-buckets + 2 dimension labels)',
    );
    assert.deepEqual(
      d.authoritativeBuckets,
      ['cachedRead', 'cachedWrite', 'output', 'reasoning', 'subagentDispatch'],
      'authoritativeBuckets must enumerate the five opencode-direct buckets',
    );
    assert.ok(
      typeof d.sumCorrectnessGuarantee === 'string' && d.sumCorrectnessGuarantee.length > 0,
      'sumCorrectnessGuarantee must be non-empty so the operator sees the invariant',
    );
    assert.ok(
      typeof d.humanReadable === 'string' && d.humanReadable.length > 0,
      'humanReadable must be non-empty so the MD path has a paragraph to render',
    );

    // Markdown headline disclaimer (per ReportSerializer line
    // 1762-1789). The exact bolded headline is operator-facing; the
    // task brief calls it out by name.
    assert.match(
      md,
      /\*\*TOKENIZER ACCURACY DISCLAIMER \(tiktoken \/ cl100k_base\)\*\*/,
      'MD must include the verbatim disclaimer headline naming tiktoken/cl100k_base',
    );
    assert.match(
      md,
      /Affected buckets \(tokenizer-derived, relative-only\): uncachedSystemPrompt, history, toolOutputs, systemPromptCached, agentsMdCached, mcpToolSchemasCached, accumulatedHistoryCached, accumulatedToolOutputsCached, unclassifiedCached, toolOutputsByTool, subagentDispatchByAgent/,
      'MD must list the v2 affected buckets human-readably (3 uncached + ' +
        '6 cachedRead sub-buckets + 2 dimension labels)',
    );
    assert.match(
      md,
      /Authoritative buckets \(read directly from opencode\): cachedRead, cachedWrite, output, reasoning, subagentDispatch/,
      'MD must list the authoritative buckets human-readably',
    );
  } finally {
    sb.cleanup();
  }
});

// ── Test 5: --last + --cwd AND semantics ───────────────────────

test('integration (5): --last 365d --cwd /Users/test/project-a returns exactly the matching root (R3.AC4)', () => {
  const sb = mkSandbox();
  try {
    // The fixture has 3 root sessions across 3 distinct directories
    // (per scripts/opencode-cost-diagnosis-test-fixture.js:205-233):
    //   ses_root_a → /Users/test/project-a
    //   ses_root_b → /Users/test/project-b
    //   ses_root_c → /Users/test/project-c
    //
    // --last 365d alone matches all 3 (every fixture timestamp is
    // anchored at BASE_TIME = 1778775290084 which is comfortably
    // within the last year as of test authoring). Adding
    // --cwd /Users/test/project-a must narrow to exactly ses_root_a
    // by R3.AC4's AND semantics.
    const { exitCode, stderr } = runMain([
      '--last', '365d',
      '--cwd', '/Users/test/project-a',
    ]);
    assert.equal(
      exitCode, 0,
      `combined-flag run must exit 0; stderr=${stderr}`,
    );

    const { parsed } = readReport(sb.stateDir);
    assert.equal(
      parsed.sessionCount, 1,
      `expected exactly 1 root session for --last 365d --cwd ` +
        `/Users/test/project-a; got ${parsed.sessionCount}`,
    );
    assert.equal(
      parsed.sessions.length, 1,
      'sessions array length must match sessionCount',
    );
    assert.equal(
      parsed.sessions[0].sessionId,
      'ses_root_a',
      `expected ses_root_a; got ${parsed.sessions[0].sessionId}`,
    );
    assert.equal(
      parsed.sessions[0].directory,
      '/Users/test/project-a',
      'returned session must be in the requested directory',
    );

    // byProject must contain ONLY the requested directory — proves
    // the cwd filter applies at session selection time (not just at
    // surfacing time, which would still flow the other 2 cwds into
    // the aggregation).
    assert.deepEqual(
      Object.keys(parsed.byProject),
      ['/Users/test/project-a'],
      'byProject must contain exactly the cwd-matched directory',
    );

    // Sanity: the OTHER fixture cwds must not surface anywhere in
    // the report — guards against a future "always include cwd
    // breakdown" change that would dilute the filter's effect.
    for (const otherDir of ['/Users/test/project-b', '/Users/test/project-c']) {
      assert.ok(
        !JSON.stringify(parsed).includes(otherDir),
        `unfiltered cwd ${otherDir} must not appear anywhere in the report`,
      );
    }
  } finally {
    sb.cleanup();
  }
});

// Exactly 5 tests above — matches the task 6.2 observable count.
