/*
 * report-assembler.test.js — unit tests for the ReportAssembler
 * (task 4.2 of .kiro/specs/opencode-cost-diagnosis).
 *
 * The ReportAssembler ingests SessionAttribution[] (the output of
 * the AttributionEngine in 3.3) and produces a DiagnosticReport per
 * design.md:870-879. It groups by `session.directory` into
 * ProjectAggregate[], computes globalTotals, builds the structured
 * TokenizerDisclaimer, applies privacy filtering, and aggregates
 * findings (including the global-level `caching_not_enabled`
 * finding when the sum of session-level tokens_cache_read is 0).
 *
 * v1 forward-compat invariants enforced by these tests:
 *
 *   - Every per-bucket cost field on globalTotals.cost AND on every
 *     ProjectAggregate.cost is `null` (Iteration 2.5 decision —
 *     only cost.total is populated; per-bucket cost values require
 *     the deferred per-bucket cost recompute spec).
 *   - The TokenizerDisclaimer object is present on EVERY report,
 *     including the empty-DB case (R2.AC9 applies whenever the
 *     report's attribution path runs; in v1 the assembler always
 *     emits the disclaimer regardless of whether sessions are
 *     present, because future spec changes that introduce sub-bucket
 *     reporting in empty cases would otherwise lose the disclaimer).
 *   - `affectedBuckets` is exactly the 3 uncached sub-buckets
 *     (`uncachedSystemPrompt`, `history`, `toolOutputs`).
 *
 * Fixture shape — verified directly via sqlite3 (NOT 2-cwd as the
 * task brief said; the actual fixture has 3 root sessions across 3
 * distinct cwds project-a, project-b, project-c, each with the
 * same per-root counters):
 *
 *   ROOT_INPUT       = 10000   (per session)
 *   ROOT_OUTPUT      = 500
 *   ROOT_REASONING   = 100
 *   ROOT_CACHE_READ  = 5000
 *   ROOT_CACHE_WRITE = 1000
 *   ROOT_COST        = 0.05
 *
 *   3 root sessions → globalTotals.cost.total = 0.15
 *   3 distinct cwds  → byProject has 3 keys
 *   tokens_cache_read sum = 15000 > 0 → caching_not_enabled NOT emitted
 *
 * Privacy default-exclude posture (R4.AC1, R4.AC2): the
 * AttributionEngine's SessionAttribution shape (design.md:617-624)
 * does NOT carry message bodies / tool-output content / prompt
 * content — only token counts, identifiers, timestamps, and
 * findings. So the default-exclude posture is satisfied
 * by-construction in v1: the assembler doesn't need to strip
 * anything because nothing sensitive is reachable from its input.
 * The `--include-content` opt-in (R4.AC3) would require the
 * assembler to additionally fetch part bodies via a Reader, which
 * is out of scope for v1. v1 surfaces this as a
 * `content_inclusion_deferred` finding when the flag is passed and
 * behaves identically to the default path otherwise.
 *
 * `caching_not_enabled` finding (R2.AC7): emitted at the GLOBAL
 * level when sum(tokens_cache_read) across in-scope sessions is 0.
 * The fixture exercises tokens_cache_read = 5000 per root, so the
 * fixture path never emits it; a synthetic SessionAttribution
 * array with all cachedRead=0 exercises the trigger.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  SqliteReader,
  SubagentAggregator,
  TokenizerSplitter,
  AttributionEngine,
  ReportAssembler,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

// Per-root fixture constants. Single source of truth co-located
// with the assertions so a fixture rebuild produces a single diff
// site.
const ROOT_INPUT = 10000;
const ROOT_OUTPUT = 500;
const ROOT_REASONING = 100;
const ROOT_CACHE_READ = 5000;
const ROOT_CACHE_WRITE = 1000;
const ROOT_COST = 0.05;
const ROOT_COUNT = 3;
const EXPECTED_GLOBAL_COST_TOTAL = ROOT_COST * ROOT_COUNT; // 0.15

// Forward-compat: every per-bucket cost field must be null in v1
// per the per_bucket_cost_deferred decision. Kept as a Set for
// O(1) membership checks in the per-bucket loop below.
const PER_BUCKET_COST_FIELDS = [
  'cachedRead',
  'cachedWrite',
  'uncachedInput',
  'output',
  'reasoning',
  'subagentDispatch',
];

function buildEngine(reader) {
  return new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
  );
}

function attributeAllFixtureSessions() {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const eng = buildEngine(r);
    const out = [];
    for (const ses of r.rootSessionsMatching({})) {
      out.push(eng.attributeSession(ses));
    }
    return out;
  } finally {
    r.close();
  }
}

// Synthesise a SessionAttribution with the given overrides. Used
// to exercise the `caching_not_enabled` branch without rebuilding
// the fixture, and to verify findings aggregation with deterministic
// per-session finding payloads.
function makeAttribution(overrides) {
  const o = overrides || {};
  return {
    sessionId: o.sessionId || 'ses_synth_1',
    directory: o.directory || '/Users/test/synth-project',
    agent: o.agent || 'build',
    model: o.model || 'claude-opus-4-7',
    timeCreated: o.timeCreated || 1_700_000_000_000,
    timeUpdated: o.timeUpdated || 1_700_000_001_000,
    tokens: Object.assign(
      {
        cachedRead: 0,
        cachedWrite: 0,
        uncachedSystemPrompt: 100,
        history: 200,
        toolOutputs: 50,
        output: 30,
        reasoning: 10,
        subagentDispatch: 0,
      },
      o.tokens || {},
    ),
    cost: Object.assign(
      {
        total: 0.01,
        cachedRead: null,
        cachedWrite: null,
        uncachedInput: null,
        output: null,
        reasoning: null,
        subagentDispatch: null,
      },
      o.cost || {},
    ),
    findings: o.findings || [],
  };
}

/* ── Constructor / shape sanity ────────────────────────────────── */

test('ReportAssembler: exported by the script module', () => {
  assert.equal(typeof ReportAssembler, 'function');
  const a = new ReportAssembler();
  assert.equal(typeof a.assemble, 'function');
});

/* ── 1.6-fixture assembly: top-level shape ─────────────────────── */

test('assemble(fixture): top-level DiagnosticReport shape per design.md:870-879', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.reportType, 'opencode-cost-diagnosis');
  assert.equal(typeof report.tokenizer_disclaimer, 'object');
  assert.notEqual(report.tokenizer_disclaimer, null);
  assert.equal(report.sessionCount, ROOT_COUNT);
  assert.equal(typeof report.globalTotals, 'object');
  assert.equal(typeof report.globalTotals.tokens, 'object');
  assert.equal(typeof report.globalTotals.cost, 'object');
  assert.equal(typeof report.byProject, 'object');
  assert.ok(Array.isArray(report.sessions));
  assert.ok(Array.isArray(report.findings));
});

/* ── globalTotals math ─────────────────────────────────────────── */

test('assemble(fixture): globalTotals.tokens sums every session BucketTotals', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const expected = {
    cachedRead: 0,
    cachedWrite: 0,
    uncachedSystemPrompt: 0,
    history: 0,
    toolOutputs: 0,
    output: 0,
    reasoning: 0,
    subagentDispatch: 0,
  };
  for (const a of attrs) {
    for (const k of Object.keys(expected)) {
      expected[k] += a.tokens[k];
    }
  }

  for (const k of Object.keys(expected)) {
    assert.equal(
      report.globalTotals.tokens[k],
      expected[k],
      `globalTotals.tokens.${k} must be the sum across all sessions`,
    );
  }
});

test('assemble(fixture): globalTotals.cost.total equals sum of session cost.total', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  // Floating-point math: assert a small epsilon rather than ==.
  const expected = attrs.reduce((acc, a) => acc + a.cost.total, 0);
  const diff = Math.abs(report.globalTotals.cost.total - expected);
  assert.ok(
    diff < 1e-9,
    `globalTotals.cost.total expected ~${expected}, got ${report.globalTotals.cost.total}`,
  );
  // Fixture is 3 sessions × 0.05 = 0.15 — sanity-check the hand
  // value against the computed expected so a fixture rebuild
  // changing per-session cost fails this test instead of producing
  // a silently-different total.
  assert.ok(
    Math.abs(expected - EXPECTED_GLOBAL_COST_TOTAL) < 1e-9,
    `expected hand-derived total ${EXPECTED_GLOBAL_COST_TOTAL}, got ${expected}`,
  );
});

test('assemble(fixture): per-bucket cost fields on globalTotals.cost all null (forward-compat)', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  for (const k of PER_BUCKET_COST_FIELDS) {
    assert.equal(
      report.globalTotals.cost[k],
      null,
      `globalTotals.cost.${k} must be null in v1 (per_bucket_cost_deferred)`,
    );
  }
});

/* ── byProject grouping ────────────────────────────────────────── */

test('assemble(fixture): byProject has 3 keys (one per distinct cwd)', () => {
  // NOTE: task brief said 2 distinct cwds, but sqlite3 against the
  // 1.6 fixture confirms 3 (project-a, project-b, project-c). We
  // assert against the truth of the fixture, not the brief.
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const keys = Object.keys(report.byProject).sort();
  assert.deepEqual(keys, [
    '/Users/test/project-a',
    '/Users/test/project-b',
    '/Users/test/project-c',
  ]);
});

test('assemble(fixture): each ProjectAggregate carries directory, sessionCount=1, summed tokens, and cost.total', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  for (const dir of [
    '/Users/test/project-a',
    '/Users/test/project-b',
    '/Users/test/project-c',
  ]) {
    const agg = report.byProject[dir];
    assert.equal(agg.directory, dir, `byProject[${dir}].directory`);
    assert.equal(agg.sessionCount, 1, `byProject[${dir}].sessionCount`);

    // Find the source session attribution for this project.
    const src = attrs.find((a) => a.directory === dir);
    assert.ok(src, `fixture must contain a session for ${dir}`);

    // Tokens equal the single source session verbatim (one session
    // per project in this fixture, so the project sum is the
    // identity).
    for (const k of Object.keys(src.tokens)) {
      assert.equal(
        agg.tokens[k],
        src.tokens[k],
        `byProject[${dir}].tokens.${k}`,
      );
    }

    // cost.total equals source session.cost.total
    assert.ok(
      Math.abs(agg.cost.total - src.cost.total) < 1e-9,
      `byProject[${dir}].cost.total expected ${src.cost.total}, got ${agg.cost.total}`,
    );

    // Per-bucket cost fields all null (forward-compat).
    for (const k of PER_BUCKET_COST_FIELDS) {
      assert.equal(
        agg.cost[k],
        null,
        `byProject[${dir}].cost.${k} must be null in v1`,
      );
    }
  }
});

/* ── TokenizerDisclaimer ───────────────────────────────────────── */

test('assemble(fixture): tokenizer_disclaimer matches design.md:912-921 shape', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const d = report.tokenizer_disclaimer;
  assert.equal(d.library, 'tiktoken');
  assert.equal(d.encoding, 'cl100k_base');
  assert.equal(d.accuracyClass, 'relative-only');
  assert.deepEqual(d.affectedBuckets, [
    'uncachedSystemPrompt',
    'history',
    'toolOutputs',
  ]);
  assert.deepEqual(d.authoritativeBuckets, [
    'cachedRead',
    'cachedWrite',
    'output',
    'reasoning',
    'subagentDispatch',
  ]);
  assert.equal(typeof d.sumCorrectnessGuarantee, 'string');
  assert.ok(d.sumCorrectnessGuarantee.length > 0);
  assert.equal(typeof d.humanReadable, 'string');
  assert.ok(d.humanReadable.length > 0);
});

/* ── Empty-DB shape (R2.AC8) ───────────────────────────────────── */

test('assemble([]): valid empty DiagnosticReport with disclaimer present', () => {
  const assembler = new ReportAssembler();
  const report = assembler.assemble([]);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.reportType, 'opencode-cost-diagnosis');
  assert.equal(report.sessionCount, 0);
  assert.deepEqual(report.sessions, []);
  assert.deepEqual(report.byProject, {});

  // globalTotals is structurally present, every bucket zero, every
  // per-bucket cost null.
  for (const k of [
    'cachedRead',
    'cachedWrite',
    'uncachedSystemPrompt',
    'history',
    'toolOutputs',
    'output',
    'reasoning',
    'subagentDispatch',
  ]) {
    assert.equal(report.globalTotals.tokens[k], 0);
  }
  assert.equal(report.globalTotals.cost.total, 0);
  for (const k of PER_BUCKET_COST_FIELDS) {
    assert.equal(report.globalTotals.cost[k], null);
  }

  // Disclaimer is structurally present even in the empty case.
  assert.equal(typeof report.tokenizer_disclaimer, 'object');
  assert.equal(report.tokenizer_disclaimer.library, 'tiktoken');
  assert.deepEqual(report.tokenizer_disclaimer.affectedBuckets, [
    'uncachedSystemPrompt',
    'history',
    'toolOutputs',
  ]);
});

/* ── caching_not_enabled global finding (R2.AC7) ───────────────── */

test('assemble: emits caching_not_enabled when every session has cachedRead == 0', () => {
  const attrs = [
    makeAttribution({ sessionId: 'a', tokens: { cachedRead: 0 } }),
    makeAttribution({ sessionId: 'b', tokens: { cachedRead: 0 } }),
  ];
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const cne = report.findings.filter((f) => f.kind === 'caching_not_enabled');
  assert.equal(
    cne.length,
    1,
    `expected exactly one caching_not_enabled finding, got ${cne.length}`,
  );
  assert.equal(typeof cne[0].detail, 'string');
  assert.ok(cne[0].detail.length > 0);
});

test('assemble: does NOT emit caching_not_enabled when any session has cachedRead > 0', () => {
  const attrs = [
    makeAttribution({ sessionId: 'a', tokens: { cachedRead: 0 } }),
    makeAttribution({ sessionId: 'b', tokens: { cachedRead: 5000 } }),
  ];
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const cne = report.findings.filter((f) => f.kind === 'caching_not_enabled');
  assert.equal(cne.length, 0);
});

test('assemble(fixture): does NOT emit caching_not_enabled (fixture cachedRead=5000 per root)', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const cne = report.findings.filter((f) => f.kind === 'caching_not_enabled');
  assert.equal(cne.length, 0);
});

test('assemble([]): does NOT emit caching_not_enabled when there are no sessions', () => {
  // Vacuous case: zero sessions trivially sum to 0 cachedRead, but
  // there's nothing to flag — emitting the finding here would be
  // noise. R2.AC7 talks about "Anthropic prompt-caching not being
  // exercised by opencode", which presupposes at least one session.
  const assembler = new ReportAssembler();
  const report = assembler.assemble([]);

  const cne = report.findings.filter((f) => f.kind === 'caching_not_enabled');
  assert.equal(cne.length, 0);
});

/* ── Per-session findings aggregation ──────────────────────────── */

test('assemble: aggregates per-session findings into the global findings array', () => {
  const attrs = [
    makeAttribution({
      sessionId: 'ses_a',
      tokens: { cachedRead: 5000 }, // suppress caching_not_enabled
      findings: [
        { kind: 'per_bucket_cost_deferred', detail: 'a-deferred' },
        { kind: 'schema_partial_data', detail: 'a-partial' },
      ],
    }),
    makeAttribution({
      sessionId: 'ses_b',
      tokens: { cachedRead: 5000 },
      findings: [{ kind: 'per_bucket_cost_deferred', detail: 'b-deferred' }],
    }),
  ];
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  // Every per-session finding must appear in the global findings
  // array. Order doesn't matter (the assembler is free to sort
  // however it likes); membership does.
  const findingDetails = report.findings.map((f) => f.detail);
  assert.ok(findingDetails.includes('a-deferred'));
  assert.ok(findingDetails.includes('a-partial'));
  assert.ok(findingDetails.includes('b-deferred'));
});

test('assemble: per-session finding carries session ID context', () => {
  // The task brief says "with session ID context" — the natural
  // shape is a sessionId field on each aggregated finding so the
  // Reporter can surface "session X reported finding Y". Don't
  // require a specific carrier name (could be sessionId or
  // attached to detail), but ensure SOME form of session context
  // is reachable from the aggregated finding so the global
  // findings array isn't an anonymous bag.
  const attrs = [
    makeAttribution({
      sessionId: 'ses_distinctive_id',
      tokens: { cachedRead: 5000 },
      findings: [{ kind: 'schema_partial_data', detail: 'sample' }],
    }),
  ];
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  const sp = report.findings.find((f) => f.kind === 'schema_partial_data');
  assert.ok(sp, 'aggregated finding must be present');
  // Look for the session ID either in a top-level sessionId field
  // or anywhere in the detail string. Either is acceptable; the
  // contract is "the operator can trace this finding back to its
  // source session from the global findings array alone".
  const reachable =
    sp.sessionId === 'ses_distinctive_id' ||
    (typeof sp.detail === 'string' && sp.detail.includes('ses_distinctive_id'));
  assert.ok(
    reachable,
    `aggregated finding must reference its source session ID; got ${JSON.stringify(sp)}`,
  );
});

/* ── Privacy filtering (R4.AC1, R4.AC2, R4.AC3) ────────────────── */

test('assemble(fixture, default): no message-body strings in the assembled report', () => {
  // Privacy default-exclude: with the AttributionEngine's
  // SessionAttribution shape, no message body content is reachable
  // from the assembler's input, so this is satisfied by-construction.
  // We assert it by checking that the fixture's known message-body
  // content ("system message body for ses_root_a", etc., emitted by
  // scripts/opencode-cost-diagnosis-test-fixture.js) does not
  // appear anywhere in the serialised report.
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);
  const serialised = JSON.stringify(report);

  // Pick a few characteristic substrings from the fixture's part
  // bodies and ensure none of them leaks. The fixture sets
  // distinctive text on text/tool parts; if any of these appear in
  // the assembled report we've leaked content.
  const forbidden = [
    'system message body',
    'user prompt body',
    'assistant response body',
    'tool output body',
  ];
  for (const f of forbidden) {
    assert.equal(
      serialised.includes(f),
      false,
      `default-mode report must NOT contain "${f}"; found in serialised output`,
    );
  }
});

test('assemble(fixture, --include-content): emits content_inclusion_deferred finding', () => {
  // v1 limitation per task brief: --include-content does not yet
  // fetch part bodies (would require Reader access from inside the
  // assembler). The assembler instead emits a finding documenting
  // the deferral so the operator knows the flag was acknowledged
  // and why content is still absent.
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs, { includeContent: true });

  const cid = report.findings.filter(
    (f) => f.kind === 'content_inclusion_deferred',
  );
  assert.equal(
    cid.length,
    1,
    `expected exactly one content_inclusion_deferred finding, got ${cid.length}`,
  );
  assert.equal(typeof cid[0].detail, 'string');
  assert.ok(cid[0].detail.length > 0);
});

test('assemble(fixture, default): does NOT emit content_inclusion_deferred', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs); // default — no includeContent

  const cid = report.findings.filter(
    (f) => f.kind === 'content_inclusion_deferred',
  );
  assert.equal(cid.length, 0);
});

/* ── sessions array passes through SessionAttribution payload ──── */

test('assemble: sessions array has one entry per input attribution (sessionCount parity)', () => {
  const attrs = attributeAllFixtureSessions();
  const assembler = new ReportAssembler();
  const report = assembler.assemble(attrs);

  assert.equal(report.sessions.length, report.sessionCount);
  assert.equal(report.sessions.length, ROOT_COUNT);

  // Every session in the output must correspond to a session in
  // the input (by sessionId).
  const inIds = new Set(attrs.map((a) => a.sessionId));
  for (const s of report.sessions) {
    assert.ok(
      inIds.has(s.sessionId),
      `output session ${s.sessionId} must map to an input attribution`,
    );
  }
});
