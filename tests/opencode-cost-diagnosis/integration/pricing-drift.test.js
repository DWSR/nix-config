/*
 * pricing-drift.test.js — task 8.3 of .kiro/specs/v2-diagnosis.
 *
 * End-to-end verification of the AttributionEngine's pricing-drift
 * fallback path:
 *   - AttributionEngine._computeV2Cost stamps `_v2PricingDrift = true`
 *     and `_v2DriftKey = "<providerID>/<modelID>"` on the cost object
 *     the moment `PricingTable.lookup(providerID, modelID)` returns
 *     null for any assistant message in the session
 *     (scripts/opencode-cost-report.js:2255-2268).
 *   - AttributionEngine.attribute() (5.6 emit site) then overwrites
 *     the partial cost shape wholesale with `makeNullCostShape(
 *     session.cost || 0)` and pushes ONE `pricing_table_drift`
 *     finding naming the session id + the first unmatched key
 *     (scripts/opencode-cost-report.js:1839-1852).
 *   - Other (non-drift) sessions in the same run retain their
 *     populated v2 cost shape unchanged.
 *
 * Requirements covered:
 *   R3.4 — unrecognized providerID/modelID nullifies ALL v2 per-bucket
 *          cost fields for the affected session (cost.total preserved
 *          from session.cost), and the report carries a
 *          pricing_table_drift finding naming the unmatched key.
 *   R7.5 — pricing drift is a per-session degradation: matched
 *          sessions in the same run still carry populated cost; the
 *          report still emits cleanly.
 *
 * Drift trigger strategy (per task brief):
 *   Strategy A — point `$OPENCODE_COST_PRICING_PATH` at a
 *   PERTURBED pricing JSON that removes one model entry. The Nix
 *   wrapper's path-resolution logic
 *   (scripts/opencode-cost-report.js:4848-4885) reads the env var
 *   first, so we can override the bundled JSON without touching the
 *   filesystem at the script's install path.
 *
 *   The canonical fixture at
 *   tests/opencode-cost-diagnosis/fixtures/opencode-stable.db
 *   carries nine sessions all using a single (providerID, modelID):
 *   anthropic/claude-opus-4-7. Removing that model from the
 *   perturbed pricing JSON would drive EVERY session into drift,
 *   leaving no "other sessions retain populated cost" branch to
 *   assert against (the second half of R7.5). We therefore build a
 *   purpose-built two-model fixture here — one session on the model
 *   we remove from the perturbed pricing JSON, one session on a
 *   model we leave in place — so a single test asserts both branches
 *   in one report.
 *
 *   This follows the same "custom fixture, principle preserved"
 *   pattern cost-invariant.test.js (task 8.2) established: the task
 *   brief language about "the standard fixture DB" describes the
 *   pipeline ENTRY POINT, not the literal opencode-stable.db file.
 *   The fixture builder below mirrors that file's schema and
 *   data_migration baseline exactly so SqliteReader.open() is
 *   satisfied.
 *
 * Feature-flag posture (per task 8.1): V2_COST_COMPUTE_ENABLED's
 * default is `true`, so the drift gate at
 * scripts/opencode-cost-report.js:1839 is always live during
 * integration runs — the test does not need to manipulate the flag.
 *
 * Boundary: pricing-drift.test.js + this file's local fixture and
 * pricing-perturbation helpers. We do NOT touch
 * scripts/opencode-cost-report.js, the bundled pricing JSON in
 * scripts/, the canonical fixture, the unit test tree, the other
 * integration tests, or the golden files.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const test = require('node:test');
const assert = require('node:assert/strict');

const Database = require('better-sqlite3');

const { mkSandbox, readReport, runMain } = require('./_helpers.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUNDLED_PRICING_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'opencode-cost-report-pricing.json',
);

// ── Determinism anchors ──────────────────────────────────────────
//
// BASE_TIME mirrors cost-invariant.test.js / the canonical fixture
// so both sessions sit comfortably inside `--last 365d`.
const BASE_TIME = 1778775290084;

// Two providerID/modelID pairs that both exist in the BUNDLED
// pricing JSON. We will remove the FIRST from the perturbed JSON to
// trigger drift; the SECOND must remain so its session carries
// populated cost.
const DRIFT_PROVIDER_ID = 'anthropic';
const DRIFT_MODEL_ID = 'claude-opus-4-7';
const DRIFT_PRICING_KEY = `${DRIFT_PROVIDER_ID}/${DRIFT_MODEL_ID}`;

const MATCHED_PROVIDER_ID = 'anthropic';
const MATCHED_MODEL_ID = 'claude-sonnet-4-5';

const DRIFT_SESSION_ID = 'ses_drift_opus';
const MATCHED_SESSION_ID = 'ses_matched_sonnet';

// Token shape used by both sessions. Values are arbitrary positive
// integers — the matched-session cost assertions only check
// `typeof === 'number'` and `> 0`, NOT exact dollar amounts (those
// drift with any future pricing-rate edit, which would make this
// test fragile for no diagnostic value).
const FIXTURE_TOKENS = {
  total: 16500,
  input: 10000,
  output: 500,
  reasoning: 0,
  cache: { read: 5000, write: 1000 },
};

// session.cost values that the makeNullCostShape() drift fallback
// must preserve on cost.total. Chosen as a recognizable non-round
// number so a regression where the fallback drops session.cost
// (e.g. `makeNullCostShape()` with no arg) would surface as a wrong
// total rather than an assertion-noise pass.
const DRIFT_SESSION_COST_USD = 0.12345;
const MATCHED_SESSION_COST_USD = 0.07125;

// ── Local fixture builder ────────────────────────────────────────
//
// Two-session DB: one assistant message per session, each tagged
// with a distinct (providerID, modelID). Mirrors cost-invariant
// .test.js's single-session builder almost verbatim — same schema,
// same data_migration baseline, same message/part shape — but takes
// an `entries` array so the caller stamps out as many sessions as
// it needs without N copies of the boilerplate.

function buildMultiSessionFixture(entries) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-pricing-drift-'),
  );
  const dbPath = path.join(tmpDir, 'opencode-stable.db');

  const db = new Database(dbPath);
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
    let timeOffset = 0;
    for (const e of entries) {
      insertSession.run(
        e.sessionId,
        null,
        e.directory,
        'build',
        e.modelID,
        e.sessionCostUsd,
        FIXTURE_TOKENS.input,
        FIXTURE_TOKENS.output,
        FIXTURE_TOKENS.reasoning,
        FIXTURE_TOKENS.cache.read,
        FIXTURE_TOKENS.cache.write,
        BASE_TIME + timeOffset,
        BASE_TIME + timeOffset + 100,
        '',
        '',
        '',
      );

      const msgId = `msg_${e.sessionId}_ast`;
      insertMessage.run(
        msgId,
        e.sessionId,
        JSON.stringify({
          role: 'assistant',
          cost: e.sessionCostUsd,
          tokens: FIXTURE_TOKENS,
          modelID: e.modelID,
          providerID: e.providerID,
          path: { cwd: e.directory, root: e.directory },
        }),
        BASE_TIME + timeOffset + 20,
        BASE_TIME + timeOffset + 20,
      );

      insertPart.run(
        `prt_${e.sessionId}_ast_0`,
        msgId,
        e.sessionId,
        JSON.stringify({ type: 'text', text: 'fixture text' }),
        BASE_TIME + timeOffset + 21,
        BASE_TIME + timeOffset + 21,
      );

      // Bump the wall-clock window for the next session so the
      // (time_created, id) sort the assembler uses produces a
      // stable, declared order.
      timeOffset += 1000;
    }

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

// ── Pricing-JSON perturbation helper ─────────────────────────────
//
// Reads the bundled pricing JSON, drops the named (providerID,
// modelID) entry, writes the result to a temp file. The temp file
// lives in its own tempdir so cleanup() removes both atomically.
// We deep-clone the parsed object before mutating so a future
// caller in the same process (none today, but cheap insurance)
// can't see the perturbation leak via shared references.

function writePerturbedPricing(removeProviderID, removeModelID) {
  const raw = fs.readFileSync(BUNDLED_PRICING_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  // Defensive: the bundled JSON must currently contain the model
  // we're about to remove. If it doesn't, the test's drift trigger
  // is a no-op (the model is already absent) and the perturbation
  // is meaningless — fail loudly so a future pricing-JSON edit
  // that drops the model surfaces the test breakage at setup time
  // rather than as a confusing assertion failure downstream.
  const providerEntry = parsed.models && parsed.models[removeProviderID];
  if (
    !providerEntry ||
    typeof providerEntry !== 'object' ||
    !Object.prototype.hasOwnProperty.call(providerEntry, removeModelID)
  ) {
    throw new Error(
      `writePerturbedPricing: precondition failed — bundled pricing JSON ` +
        `at ${BUNDLED_PRICING_PATH} has no entry for ` +
        `"${removeProviderID}/${removeModelID}". The test's drift ` +
        `trigger requires the model to be present in the source so ` +
        `removing it produces a meaningful perturbation.`,
    );
  }

  delete providerEntry[removeModelID];
  // If the provider has no remaining models, leave the empty provider
  // object behind — PricingTable accepts empty provider objects (the
  // outer `models` shape just needs to be an object) and an empty
  // entry on `anthropic` more accurately models "this provider lost
  // a model" than "this provider was withdrawn entirely".

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-pricing-perturbed-'),
  );
  const tmpPath = path.join(tmpDir, 'pricing-perturbed.json');
  fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');

  return {
    path: tmpPath,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Predicate over a top-level finding entry. Same shape conventions
// as cost-invariant.test.js's isCostInvariantFor: top-level findings
// carry `{ kind, detail, sessionId }`.
function isPricingDriftFor(finding, sessionId) {
  return (
    finding != null &&
    finding.kind === 'pricing_table_drift' &&
    finding.sessionId === sessionId
  );
}

// ── The test ─────────────────────────────────────────────────────

test('integration (8.3): perturbed pricing JSON drives drift fallback for affected session; matched session retains populated cost (R3.4 + R7.5)', () => {
  const fixture = buildMultiSessionFixture([
    {
      sessionId: DRIFT_SESSION_ID,
      providerID: DRIFT_PROVIDER_ID,
      modelID: DRIFT_MODEL_ID,
      sessionCostUsd: DRIFT_SESSION_COST_USD,
      directory: '/Users/test/pricing-drift-affected',
    },
    {
      sessionId: MATCHED_SESSION_ID,
      providerID: MATCHED_PROVIDER_ID,
      modelID: MATCHED_MODEL_ID,
      sessionCostUsd: MATCHED_SESSION_COST_USD,
      directory: '/Users/test/pricing-drift-matched',
    },
  ]);
  const perturbed = writePerturbedPricing(DRIFT_PROVIDER_ID, DRIFT_MODEL_ID);

  // Override OPENCODE_COST_PRICING_PATH for the duration of this
  // test. mkSandbox() only manages XDG_STATE_HOME + OPENCODE_DB_PATH;
  // it does NOT know about the pricing-path env var (that knob is
  // owned by scripts/opencode-cost-report.js:4865-4866, not by the
  // sandbox harness). We capture-and-restore here in a finally.
  const priorPricingEnv = process.env.OPENCODE_COST_PRICING_PATH;
  process.env.OPENCODE_COST_PRICING_PATH = perturbed.path;

  const sb = mkSandbox({ dbPath: fixture.path });
  try {
    const { exitCode, stderr } = runMain(['--last', '365d']);

    // R7.5 — the drift state must NOT block emission. Exit 0 +
    // stderr clean prove the drift sites rode the happy path.
    assert.equal(
      exitCode,
      0,
      `command must exit 0 even when one session enters pricing drift; ` +
        `stderr=${stderr}`,
    );

    const report = readReport(sb.stateDir);

    // ── R3.4: affected session has all v2 cost fields nullified ──
    const drifted = report.parsed.sessions.find(
      (s) => s.sessionId === DRIFT_SESSION_ID,
    );
    assert.ok(
      drifted,
      `drift session ${DRIFT_SESSION_ID} must appear in report.sessions[]; ` +
        `got ids=${JSON.stringify(report.parsed.sessions.map((s) => s.sessionId))}`,
    );
    const dc = drifted.cost;

    // Each null-field assertion is its own line so a regression that
    // nullifies the wrong subset of fields prints the SPECIFIC field
    // that survived rather than a single opaque deep-equal failure.
    // Order mirrors makeNullCostShape() at
    // scripts/opencode-cost-report.js:3471-3481.
    assert.equal(
      dc.cachedRead,
      null,
      `drift session: cost.cachedRead must be null; got ${dc.cachedRead}`,
    );
    assert.equal(
      dc.cachedWrite,
      null,
      `drift session: cost.cachedWrite must be null; got ${dc.cachedWrite}`,
    );
    assert.equal(
      dc.uncachedInput,
      null,
      `drift session: cost.uncachedInput must be null; got ${dc.uncachedInput}`,
    );
    assert.equal(
      dc.output,
      null,
      `drift session: cost.output must be null; got ${dc.output}`,
    );
    assert.equal(
      dc.reasoning,
      null,
      `drift session: cost.reasoning must be null; got ${dc.reasoning}`,
    );
    assert.equal(
      dc.subagentDispatch,
      null,
      `drift session: cost.subagentDispatch must be null; got ${dc.subagentDispatch}`,
    );
    assert.equal(
      dc.uncachedSystemPrompt,
      null,
      `drift session: cost.uncachedSystemPrompt must be null; got ${dc.uncachedSystemPrompt}`,
    );
    assert.equal(
      dc.history,
      null,
      `drift session: cost.history must be null; got ${dc.history}`,
    );
    assert.equal(
      dc.toolOutputs,
      null,
      `drift session: cost.toolOutputs must be null; got ${dc.toolOutputs}`,
    );

    // Decomposed maps go fully null (NOT empty objects) — distinct
    // from the matched-session shape where they're populated
    // objects.
    assert.equal(
      dc.subagentDispatchByAgent,
      null,
      `drift session: cost.subagentDispatchByAgent must be null; got ` +
        `${JSON.stringify(dc.subagentDispatchByAgent)}`,
    );
    assert.equal(
      dc.toolOutputsByTool,
      null,
      `drift session: cost.toolOutputsByTool must be null; got ` +
        `${JSON.stringify(dc.toolOutputsByTool)}`,
    );

    // cachedReadBreakdown: makeNullCostShape() at
    // scripts/opencode-cost-report.js:3474-3477 sets the OUTER
    // object to `{}` and then assigns each CACHED_READ_SUB_BUCKET_KEYS
    // entry to `null`. The outer object is therefore NOT itself
    // null — it's a populated object whose every value is null.
    // (The task brief's observable wording "cost.cachedReadBreakdown
    // === null" is technically inconsistent with the production
    // shape; we assert against actual production behavior here and
    // call the discrepancy out in CONCERNS so a reviewer can flag
    // either the brief or the production code for follow-up.)
    assert.ok(
      dc.cachedReadBreakdown !== null &&
        typeof dc.cachedReadBreakdown === 'object',
      `drift session: cost.cachedReadBreakdown must be an object (not null); ` +
        `got ${JSON.stringify(dc.cachedReadBreakdown)}`,
    );
    for (const k of [
      'systemPromptCached',
      'agentsMdCached',
      'mcpToolSchemasCached',
      'accumulatedHistoryCached',
      'accumulatedToolOutputsCached',
      'unclassifiedCached',
    ]) {
      assert.equal(
        dc.cachedReadBreakdown[k],
        null,
        `drift session: cost.cachedReadBreakdown.${k} must be null; got ` +
          `${dc.cachedReadBreakdown[k]}`,
      );
    }

    // total: must be a number, MUST equal session.cost from the DB.
    // The fallback at scripts/opencode-cost-report.js:1851 calls
    // makeNullCostShape(session.cost || 0); the only way this fails
    // is a regression that drops the argument.
    assert.equal(
      typeof dc.total,
      'number',
      `drift session: cost.total must be a number; got ${typeof dc.total} ${dc.total}`,
    );
    assert.notEqual(
      dc.total,
      null,
      `drift session: cost.total must not be null`,
    );
    assert.equal(
      dc.total,
      DRIFT_SESSION_COST_USD,
      `drift session: cost.total must equal session.cost from the DB ` +
        `(${DRIFT_SESSION_COST_USD}); got ${dc.total}`,
    );

    // ── R3.4 (cont.): pricing_table_drift finding presence ──────
    const driftFindings = report.parsed.findings.filter((f) =>
      isPricingDriftFor(f, DRIFT_SESSION_ID),
    );
    assert.equal(
      driftFindings.length,
      1,
      `expected exactly 1 pricing_table_drift finding for ` +
        `${DRIFT_SESSION_ID}; got ${driftFindings.length}. findings: ` +
        `${JSON.stringify(report.parsed.findings, null, 2)}`,
    );
    const driftFinding = driftFindings[0];
    // The finding's detail must name the unmatched key so an
    // operator reading the JSON can grep `${providerID}/${modelID}`.
    // Pinned at scripts/opencode-cost-report.js:1844-1850.
    assert.match(
      driftFinding.detail,
      new RegExp(DRIFT_SESSION_ID),
      `pricing_table_drift detail must name the affected session; ` +
        `got: ${driftFinding.detail}`,
    );
    assert.match(
      driftFinding.detail,
      new RegExp(
        // Escape the slash for regex safety even though /'s aren't
        // metacharacters in JS regex — keeps the intent explicit.
        DRIFT_PRICING_KEY.replace('/', '\\/'),
      ),
      `pricing_table_drift detail must name the unmatched ` +
        `providerID/modelID key "${DRIFT_PRICING_KEY}"; got: ${driftFinding.detail}`,
    );

    // ── R7.5: matched session is untouched ──────────────────────
    const matched = report.parsed.sessions.find(
      (s) => s.sessionId === MATCHED_SESSION_ID,
    );
    assert.ok(
      matched,
      `matched session ${MATCHED_SESSION_ID} must appear in ` +
        `report.sessions[]; got ids=` +
        `${JSON.stringify(report.parsed.sessions.map((s) => s.sessionId))}`,
    );
    const mc = matched.cost;

    // Numeric (not null) cost fields. Exact dollar values are NOT
    // pinned here — they're a function of the bundled pricing JSON
    // which will drift; the test asserts the populated/null
    // distinction R7.5 cares about rather than the absolute math
    // (which is what cost-invariant.test.js's known-rates check
    // covers for its own model).
    for (const k of [
      'cachedRead',
      'cachedWrite',
      'uncachedInput',
      'output',
      'uncachedSystemPrompt',
      'history',
      'toolOutputs',
    ]) {
      assert.equal(
        typeof mc[k],
        'number',
        `matched session: cost.${k} must be a populated number ` +
          `(R7.5 — other sessions unaffected by drift); got ` +
          `${typeof mc[k]} ${JSON.stringify(mc[k])}`,
      );
      assert.notEqual(
        mc[k],
        null,
        `matched session: cost.${k} must not be null`,
      );
    }

    // Decomposed maps are populated objects on the matched path
    // (possibly empty if there are no descendants / no tool parts
    // — but never null, which is the drift sentinel).
    assert.ok(
      mc.subagentDispatchByAgent !== null &&
        typeof mc.subagentDispatchByAgent === 'object',
      `matched session: cost.subagentDispatchByAgent must be an object ` +
        `(not null); got ${JSON.stringify(mc.subagentDispatchByAgent)}`,
    );
    assert.ok(
      mc.toolOutputsByTool !== null && typeof mc.toolOutputsByTool === 'object',
      `matched session: cost.toolOutputsByTool must be an object ` +
        `(not null); got ${JSON.stringify(mc.toolOutputsByTool)}`,
    );
    assert.ok(
      mc.cachedReadBreakdown !== null &&
        typeof mc.cachedReadBreakdown === 'object',
      `matched session: cost.cachedReadBreakdown must be an object; got ` +
        `${JSON.stringify(mc.cachedReadBreakdown)}`,
    );
    // Sub-buckets must be NUMBERS on the matched path (the drift
    // signature is sub-buckets === null; the matched signature is
    // sub-buckets === number).
    for (const k of [
      'systemPromptCached',
      'agentsMdCached',
      'mcpToolSchemasCached',
      'accumulatedHistoryCached',
      'accumulatedToolOutputsCached',
      'unclassifiedCached',
    ]) {
      assert.equal(
        typeof mc.cachedReadBreakdown[k],
        'number',
        `matched session: cost.cachedReadBreakdown.${k} must be a number ` +
          `(R7.5); got ${typeof mc.cachedReadBreakdown[k]} ` +
          `${JSON.stringify(mc.cachedReadBreakdown[k])}`,
      );
    }

    // R7.5 negative assertion: the matched session must NOT carry
    // a pricing_table_drift finding. A leak here would mean the
    // engine emitted drift for a session whose pricing was, in
    // fact, matched — a serious cross-session contamination bug.
    const matchedDriftFindings = report.parsed.findings.filter((f) =>
      isPricingDriftFor(f, MATCHED_SESSION_ID),
    );
    assert.equal(
      matchedDriftFindings.length,
      0,
      `expected NO pricing_table_drift finding for matched session ` +
        `${MATCHED_SESSION_ID}; got ${matchedDriftFindings.length}. ` +
        `findings: ${JSON.stringify(report.parsed.findings, null, 2)}`,
    );
  } finally {
    if (priorPricingEnv === undefined) {
      delete process.env.OPENCODE_COST_PRICING_PATH;
    } else {
      process.env.OPENCODE_COST_PRICING_PATH = priorPricingEnv;
    }
    sb.cleanup();
    perturbed.cleanup();
    fixture.cleanup();
  }
});
