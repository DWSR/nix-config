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
  setV2CostComputeEnabled,
  PER_BUCKET_COST_KEYS,
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

test('assemble(fixture, default): sessions[i].content is absent', () => {
  // Default path (no --include-content): every session entry in
  // the assembled report must NOT carry a `content` field. R4.AC1
  // / R4.AC2 promise the operator that the default report contains
  // no message bodies / tool-output content / prompt content.
  const attrs = attributeAllFixtureSessions();
  const report = new ReportAssembler().assemble(attrs);
  for (const s of report.sessions) {
    assert.equal(
      s.content,
      undefined,
      `default-mode session "${s.sessionId}" must NOT carry a content field`,
    );
  }
});

test('assemble: --include-content with contentLoader embeds content on every session', () => {
  // R4.AC3: when --include-content is set, the assembler invokes
  // the operator-supplied contentLoader once per session and
  // attaches its return value as `session.content`. The CLI Entry
  // (task 5.3) wires the loader using the Reader; this unit test
  // uses a stub loader so the assembler contract can be exercised
  // without an active SQLite handle.
  const attrs = [
    makeAttribution({ sessionId: 'ses_a', directory: '/p/a' }),
    makeAttribution({ sessionId: 'ses_b', directory: '/p/b' }),
  ];
  const loadedFor = [];
  const loader = (sessionId) => {
    loadedFor.push(sessionId);
    return {
      messages: [{ id: `msg-${sessionId}`, data: { role: 'user' } }],
      parts: [{ id: `prt-${sessionId}`, data: { text: `body for ${sessionId}` } }],
    };
  };
  const report = new ReportAssembler().assemble(attrs, {
    includeContent: true,
    contentLoader: loader,
  });

  // Loader invoked exactly once per session.
  assert.equal(loadedFor.length, 2);
  assert.ok(loadedFor.includes('ses_a'));
  assert.ok(loadedFor.includes('ses_b'));

  // Each session entry carries its loaded content.
  for (const s of report.sessions) {
    assert.ok(s.content, `session "${s.sessionId}" must carry content`);
    assert.ok(Array.isArray(s.content.messages));
    assert.ok(Array.isArray(s.content.parts));
    assert.equal(s.content.messages.length, 1);
    assert.equal(s.content.parts.length, 1);
    assert.equal(s.content.messages[0].id, `msg-${s.sessionId}`);
    assert.equal(s.content.parts[0].id, `prt-${s.sessionId}`);
  }
});

test('assemble: --include-content WITHOUT contentLoader throws an actionable error', () => {
  // The CLI Entry (5.3) is the only legitimate caller; if it
  // forgets to pass a contentLoader the failure must be loud (per
  // design.md Error Categories — programming error, not a silent
  // no-op). The error message must name the missing argument so
  // the operator/CLI-author can diagnose without reading source.
  const attrs = [makeAttribution({ sessionId: 'ses_a' })];
  assert.throws(
    () =>
      new ReportAssembler().assemble(attrs, { includeContent: true }),
    (err) =>
      err instanceof Error &&
      /contentLoader/i.test(err.message),
    'must throw an Error whose message references "contentLoader"',
  );
});

test('assemble: --include-content with contentLoader does NOT mutate input attributions', () => {
  // The assembler must not write `content` back into the caller's
  // SessionAttribution objects — that would leak content into any
  // future re-use of the same array. The test passes the same
  // attrs array to two assemble() calls (one with content, one
  // without) and asserts the second call's sessions don't carry
  // the first call's content.
  const attrs = [makeAttribution({ sessionId: 'ses_a' })];
  const loader = () => ({
    messages: [{ id: 'm1', data: {} }],
    parts: [{ id: 'p1', data: {} }],
  });
  const withContent = new ReportAssembler().assemble(attrs, {
    includeContent: true,
    contentLoader: loader,
  });
  assert.ok(withContent.sessions[0].content);
  // Input attrs must be unmutated by the assembler.
  assert.equal(
    attrs[0].content,
    undefined,
    'assembler must not mutate input SessionAttribution objects',
  );
  // And a second default-path assemble() against the same input
  // produces sessions with no content field.
  const defaultPath = new ReportAssembler().assemble(attrs);
  assert.equal(
    defaultPath.sessions[0].content,
    undefined,
    'default-path assemble() against shared input must not see leaked content',
  );
});

test('assemble: content_inclusion_deferred finding is NEVER emitted (removed in 4.3)', () => {
  // The 4.2 implementation emitted a content_inclusion_deferred
  // finding to acknowledge --include-content without actually
  // honoring it. Task 4.3 makes the flag work via contentLoader,
  // so the finding is no longer appropriate and must not appear
  // in either branch.
  const attrs = [makeAttribution({ sessionId: 'ses_a' })];
  // Default path.
  const defaultReport = new ReportAssembler().assemble(attrs);
  assert.equal(
    defaultReport.findings.filter(
      (f) => f.kind === 'content_inclusion_deferred',
    ).length,
    0,
    'content_inclusion_deferred must not appear on default path',
  );
  // --include-content path.
  const includeReport = new ReportAssembler().assemble(attrs, {
    includeContent: true,
    contentLoader: () => ({ messages: [], parts: [] }),
  });
  assert.equal(
    includeReport.findings.filter(
      (f) => f.kind === 'content_inclusion_deferred',
    ).length,
    0,
    'content_inclusion_deferred must not appear on --include-content path',
  );
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

/* ── Task 6.1: extended cost-shape aggregation (V2_COST_COMPUTE_ENABLED) ── */
//
// The flag-OFF branch is the v1 invariant: only `cost.total`
// accumulates; every per-bucket cost field stays `null`. The
// integration goldens depend on this exact shape, so every existing
// test above implicitly covers the flag-OFF branch by not flipping
// the flag.
//
// The flag-ON branch (task 6.1) iterates over the 9-key
// `PER_BUCKET_COST_KEYS` set and contributes to both
// `globalTotals.cost.<k>` and every `byProject[dir].cost.<k>` from
// matched-pricing sessions, while drift sessions (whose per-key cost
// field is `null`) skip per-key accumulation but still contribute
// their `cost.total`.
//
// All flag-ON tests own their own enable/disable in a try/finally so
// a failure can never leak the flag into the rest of the suite (a
// leak would silently break the byte-identical integration goldens).
//
// Requirements: R2.2 (per-project + global dollar aggregation using
// v1's token-aggregation pattern), R7.3 (preserve v1 sum-correctness
// invariants — exercised by the flag-OFF branch staying null).

// Build a v2-extended `cost` shape on a fixture attribution. Per
// `makeNullCostShape` semantics: every per-key field is `null` for
// drift sessions; matched sessions populate every per-key field with
// numeric dollar values. `total` is always a number (it's sourced
// from `session.cost`, which is independent of per-bucket pricing).
function makeV2Cost(overrides) {
  const o = overrides || {};
  const base = { total: typeof o.total === 'number' ? o.total : 0 };
  for (const k of PER_BUCKET_COST_KEYS) {
    base[k] = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : 0;
  }
  return base;
}

function makeDriftCost(sessionCost) {
  // Drift fallback: `total` carries session.cost (authoritative,
  // independent of pricing), every per-key field is `null`. Matches
  // `makeNullCostShape(sessionCost)` minus the nested containers
  // (which task 6.1 does not aggregate).
  const out = { total: sessionCost };
  for (const k of PER_BUCKET_COST_KEYS) out[k] = null;
  return out;
}

test('assemble: flag OFF leaves per-bucket cost fields null (v1 invariant)', () => {
  // Belt-and-suspenders: explicitly confirm the v1 shape with the
  // flag in its default state. Every other "all-null" assertion in
  // this file implicitly relies on this, but pinning it as its own
  // case makes a future regression diagnosable from this test name.
  // We do NOT call setV2CostComputeEnabled here so the default OFF
  // state is exercised.
  const attrs = [
    makeAttribution({
      sessionId: 'ses_a',
      directory: '/p/a',
      tokens: { cachedRead: 5000 },
      cost: makeV2Cost({ total: 0.5, cachedRead: 0.1 }),
    }),
    makeAttribution({
      sessionId: 'ses_b',
      directory: '/p/a',
      tokens: { cachedRead: 5000 },
      cost: makeV2Cost({ total: 0.25, cachedRead: 0.05 }),
    }),
  ];
  const report = new ReportAssembler().assemble(attrs);

  // globalTotals.cost: total accumulated, every per-key field null.
  assert.ok(Math.abs(report.globalTotals.cost.total - 0.75) < 1e-9);
  for (const k of PER_BUCKET_COST_FIELDS) {
    assert.equal(
      report.globalTotals.cost[k],
      null,
      `flag OFF: globalTotals.cost.${k} must remain null`,
    );
  }

  // byProject[].cost: same invariant.
  const agg = report.byProject['/p/a'];
  assert.ok(Math.abs(agg.cost.total - 0.75) < 1e-9);
  for (const k of PER_BUCKET_COST_FIELDS) {
    assert.equal(
      agg.cost[k],
      null,
      `flag OFF: byProject[/p/a].cost.${k} must remain null`,
    );
  }
});

test('assemble: flag ON aggregates per-bucket cost across matched sessions on globalTotals', () => {
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({
          total: 1.0,
          cachedRead: 0.10,
          cachedWrite: 0.05,
          uncachedInput: 0.30,
          output: 0.40,
          reasoning: 0.05,
          subagentDispatch: 0.02,
          uncachedSystemPrompt: 0.08,
          history: 0.20,
          toolOutputs: 0.02,
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({
          total: 0.50,
          cachedRead: 0.04,
          cachedWrite: 0.01,
          uncachedInput: 0.15,
          output: 0.20,
          reasoning: 0.02,
          subagentDispatch: 0.01,
          uncachedSystemPrompt: 0.04,
          history: 0.10,
          toolOutputs: 0.01,
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);

    // total: sum of both
    assert.ok(
      Math.abs(report.globalTotals.cost.total - 1.5) < 1e-9,
      `globalTotals.cost.total expected ~1.5, got ${report.globalTotals.cost.total}`,
    );

    // Every 9 per-key field is the matched sum across both sessions.
    const expected = {
      cachedRead: 0.14,
      cachedWrite: 0.06,
      uncachedInput: 0.45,
      output: 0.60,
      reasoning: 0.07,
      subagentDispatch: 0.03,
      uncachedSystemPrompt: 0.12,
      history: 0.30,
      toolOutputs: 0.03,
    };
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.equal(
        typeof report.globalTotals.cost[k],
        'number',
        `flag ON: globalTotals.cost.${k} must be a number, got ${report.globalTotals.cost[k]}`,
      );
      assert.ok(
        Math.abs(report.globalTotals.cost[k] - expected[k]) < 1e-9,
        `flag ON: globalTotals.cost.${k} expected ~${expected[k]}, got ${report.globalTotals.cost[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON drift session skips per-key accumulation but contributes to total', () => {
  // The canonical task 6.1 observable: one matched + one drift →
  //   globalCost.cachedRead == ONLY the matched session's value
  //   globalCost.total      == BOTH sessions' totals summed
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_matched',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({
          total: 0.80,
          cachedRead: 0.10,
          cachedWrite: 0.05,
          uncachedInput: 0.20,
          output: 0.35,
          reasoning: 0.05,
          subagentDispatch: 0.05,
          uncachedSystemPrompt: 0.04,
          history: 0.12,
          toolOutputs: 0.04,
        }),
      }),
      makeAttribution({
        sessionId: 'ses_drift',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeDriftCost(0.20),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);

    // total: sum of BOTH sessions (drift still contributes total).
    assert.ok(
      Math.abs(report.globalTotals.cost.total - 1.0) < 1e-9,
      `expected total ~1.0, got ${report.globalTotals.cost.total}`,
    );

    // Every per-key field: ONLY the matched session's value
    // (the drift session's null contribution is skipped).
    const expected = {
      cachedRead: 0.10,
      cachedWrite: 0.05,
      uncachedInput: 0.20,
      output: 0.35,
      reasoning: 0.05,
      subagentDispatch: 0.05,
      uncachedSystemPrompt: 0.04,
      history: 0.12,
      toolOutputs: 0.04,
    };
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.ok(
        Math.abs(report.globalTotals.cost[k] - expected[k]) < 1e-9,
        `flag ON drift-skip: globalTotals.cost.${k} expected ${expected[k]} (matched-only), got ${report.globalTotals.cost[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON drift-only suite produces zero per-key sums but non-zero total', () => {
  // Every session drift → per-key sums are 0 (nothing accumulated)
  // but `total` is still the sum of session.cost values.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_drift_a',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeDriftCost(0.30),
      }),
      makeAttribution({
        sessionId: 'ses_drift_b',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeDriftCost(0.20),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);

    assert.ok(
      Math.abs(report.globalTotals.cost.total - 0.50) < 1e-9,
      `total expected 0.5, got ${report.globalTotals.cost.total}`,
    );
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.equal(
        report.globalTotals.cost[k],
        0,
        `drift-only: globalTotals.cost.${k} expected 0 (no contributions), got ${report.globalTotals.cost[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON aggregates per-bucket cost on byProject symmetrically', () => {
  // Two sessions in /p/a (one matched, one drift) and one in /p/b
  // (matched). Per-project:
  //   /p/a.cost.cachedRead == matched-in-a only
  //   /p/a.cost.total      == matched-in-a + drift-in-a
  //   /p/b.cost.cachedRead == /p/b matched value
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a_matched',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({
          total: 0.70,
          cachedRead: 0.10,
          cachedWrite: 0.05,
          uncachedInput: 0.20,
          output: 0.30,
          reasoning: 0.03,
          subagentDispatch: 0.02,
          uncachedSystemPrompt: 0.05,
          history: 0.10,
          toolOutputs: 0.05,
        }),
      }),
      makeAttribution({
        sessionId: 'ses_a_drift',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeDriftCost(0.25),
      }),
      makeAttribution({
        sessionId: 'ses_b_matched',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({
          total: 0.40,
          cachedRead: 0.06,
          cachedWrite: 0.02,
          uncachedInput: 0.12,
          output: 0.16,
          reasoning: 0.02,
          subagentDispatch: 0.02,
          uncachedSystemPrompt: 0.03,
          history: 0.06,
          toolOutputs: 0.03,
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);

    const aggA = report.byProject['/p/a'];
    const aggB = report.byProject['/p/b'];
    assert.ok(aggA, 'byProject[/p/a] present');
    assert.ok(aggB, 'byProject[/p/b] present');

    // /p/a totals: matched + drift = 0.95.
    assert.ok(
      Math.abs(aggA.cost.total - 0.95) < 1e-9,
      `/p/a cost.total expected 0.95, got ${aggA.cost.total}`,
    );
    // /p/a per-key: matched-only (drift's nulls skip).
    const aExpected = {
      cachedRead: 0.10,
      cachedWrite: 0.05,
      uncachedInput: 0.20,
      output: 0.30,
      reasoning: 0.03,
      subagentDispatch: 0.02,
      uncachedSystemPrompt: 0.05,
      history: 0.10,
      toolOutputs: 0.05,
    };
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.ok(
        Math.abs(aggA.cost[k] - aExpected[k]) < 1e-9,
        `/p/a cost.${k} expected ${aExpected[k]} (matched-only), got ${aggA.cost[k]}`,
      );
    }

    // /p/b totals: single matched session.
    assert.ok(
      Math.abs(aggB.cost.total - 0.40) < 1e-9,
      `/p/b cost.total expected 0.40, got ${aggB.cost.total}`,
    );
    const bExpected = {
      cachedRead: 0.06,
      cachedWrite: 0.02,
      uncachedInput: 0.12,
      output: 0.16,
      reasoning: 0.02,
      subagentDispatch: 0.02,
      uncachedSystemPrompt: 0.03,
      history: 0.06,
      toolOutputs: 0.03,
    };
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.ok(
        Math.abs(aggB.cost[k] - bExpected[k]) < 1e-9,
        `/p/b cost.${k} expected ${bExpected[k]}, got ${aggB.cost[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON exposes all 9 PER_BUCKET_COST_KEYS on the aggregator shape', () => {
  // Belt-and-suspenders for R7.AC1 (forward-compat shape): the
  // flag-ON aggregator must expose all 9 v2 per-key fields on both
  // globalTotals.cost and every byProject entry's cost. v1's 6
  // fields plus the 3 uncached sub-buckets.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2Cost({ total: 0.10 }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.globalTotals.cost, k),
        `flag ON: globalTotals.cost must expose key "${k}"`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.byProject['/p/a'].cost, k),
        `flag ON: byProject[/p/a].cost must expose key "${k}"`,
      );
    }
    // The three v2-only keys must be present (would not be on v1's
    // 6-key shape).
    for (const k of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.globalTotals.cost, k),
        `flag ON: globalTotals.cost missing v2-only key "${k}"`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});
