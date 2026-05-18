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
  PricingTable,
  setV2CostComputeEnabled,
  PER_BUCKET_COST_KEYS,
  CACHED_READ_SUB_BUCKET_KEYS,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');
const SYNTHETIC_PRICING = path.join(
  __dirname,
  '../fixtures/synthetic-pricing.json',
);

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

/* ── Task 6.2: cachedReadBreakdown / byAgent / byTool aggregation ── */
//
// Task 6.2 extends ReportAssembler's flag-ON aggregation loops to
// merge the three NESTED structures on `attribution.cost`:
//
//   - `cachedReadBreakdown` — plain object with the 6 keys from
//     `CACHED_READ_SUB_BUCKET_KEYS`. Deep-merged per sub-bucket key
//     (sum of session contributions). Drift sessions emit `null`
//     here; null contributions are skipped (consistent with 6.1).
//
//   - `subagentDispatchByAgent` — per-agent dollar dispatch keyed by
//     agent type. AttributionEngine MAY emit this as a plain object
//     (per design.md interface) or as a Map (the toolOutputsByTool
//     precedent at line 2553). The assembler defensively handles
//     both shapes via `instanceof Map` and converts to a plain
//     object on the assembled report so the JSON serializer's
//     alphabetical-key replacer can sort them (design.md
//     ReportSerializer Implementation Notes, line 695).
//
//   - `toolOutputsByTool` — per-tool `{ cached, uncached }`
//     partition. Same Map↔Object defensive handling as above; the
//     partition is preserved during merge (per-tool cached and
//     uncached are summed independently across sessions).
//
// Drift contract: per-session `null` on any of these three fields
// skips the merge for that field (parallel to 6.1's per-key
// `null` skip on the flat PER_BUCKET_COST_KEYS).
//
// Boundary observable from tasks.md: `byProject[A].cachedReadBreakdown
// .systemPromptCached` equals the sum across A's sessions; same for
// byAgent / byTool; and the assembled report's byAgent / byTool
// fields are plain objects (NOT Map instances) after assembly.
//
// Requirements: R4.3 (cachedRead sub-buckets at per-session,
// per-project, global aggregation), R5.3 (per-agent sub-buckets at
// all three aggregation levels), R6.4 (per-tool sub-buckets at all
// three aggregation levels).

// Build a v2-extended cost shape with optional nested sub-bucket
// contributions. Defaults to a populated cachedReadBreakdown (all
// zeros across the 6 sub-buckets) plus empty plain-object maps,
// mirroring the shape the AttributionEngine emits on a matched
// session with no per-tool / per-agent activity. Pass
// `cachedReadBreakdown: null` (or `subagentDispatchByAgent: null`,
// or `toolOutputsByTool: null`) to simulate a drift session for the
// corresponding field.
function makeV2CostExtended(overrides) {
  const o = overrides || {};
  const base = makeV2Cost(o);
  if (Object.prototype.hasOwnProperty.call(o, 'cachedReadBreakdown')) {
    base.cachedReadBreakdown = o.cachedReadBreakdown;
  } else {
    const crb = {};
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) crb[k] = 0;
    base.cachedReadBreakdown = crb;
  }
  base.subagentDispatchByAgent = Object.prototype.hasOwnProperty.call(
    o,
    'subagentDispatchByAgent',
  )
    ? o.subagentDispatchByAgent
    : {};
  base.toolOutputsByTool = Object.prototype.hasOwnProperty.call(
    o,
    'toolOutputsByTool',
  )
    ? o.toolOutputsByTool
    : {};
  return base;
}

test('assemble: flag ON aggregates cachedReadBreakdown deep-merge across sessions on globalTotals', () => {
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 1.0,
          cachedRead: 0.30,
          cachedReadBreakdown: {
            systemPromptCached: 0.10,
            agentsMdCached: 0.05,
            mcpToolSchemasCached: 0.04,
            accumulatedHistoryCached: 0.08,
            accumulatedToolOutputsCached: 0.02,
            unclassifiedCached: 0.01,
          },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 0.50,
          cachedRead: 0.15,
          cachedReadBreakdown: {
            systemPromptCached: 0.05,
            agentsMdCached: 0.025,
            mcpToolSchemasCached: 0.02,
            accumulatedHistoryCached: 0.04,
            accumulatedToolOutputsCached: 0.01,
            unclassifiedCached: 0.005,
          },
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const crb = report.globalTotals.cost.cachedReadBreakdown;
    assert.ok(crb && typeof crb === 'object', 'cachedReadBreakdown present');
    // Every sub-bucket sum across both sessions.
    const expected = {
      systemPromptCached: 0.15,
      agentsMdCached: 0.075,
      mcpToolSchemasCached: 0.06,
      accumulatedHistoryCached: 0.12,
      accumulatedToolOutputsCached: 0.03,
      unclassifiedCached: 0.015,
    };
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.ok(
        Math.abs(crb[k] - expected[k]) < 1e-9,
        `globalTotals.cost.cachedReadBreakdown.${k} expected ~${expected[k]}, got ${crb[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON byProject[A].cachedReadBreakdown.systemPromptCached equals sum across A sessions (canonical observable)', () => {
  // The canonical task 6.2 observable from tasks.md: per-project
  // sub-bucket merging is isolated — /p/a's systemPromptCached is
  // the sum across A's sessions only, NOT including B's.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a1',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.50,
          cachedReadBreakdown: {
            systemPromptCached: 0.10,
            agentsMdCached: 0,
            mcpToolSchemasCached: 0,
            accumulatedHistoryCached: 0,
            accumulatedToolOutputsCached: 0,
            unclassifiedCached: 0,
          },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_a2',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.40,
          cachedReadBreakdown: {
            systemPromptCached: 0.07,
            agentsMdCached: 0,
            mcpToolSchemasCached: 0,
            accumulatedHistoryCached: 0,
            accumulatedToolOutputsCached: 0,
            unclassifiedCached: 0,
          },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b1',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.30,
          cachedReadBreakdown: {
            systemPromptCached: 0.99, // MUST NOT bleed into /p/a
            agentsMdCached: 0,
            mcpToolSchemasCached: 0,
            accumulatedHistoryCached: 0,
            accumulatedToolOutputsCached: 0,
            unclassifiedCached: 0,
          },
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const aA = report.byProject['/p/a'];
    const aB = report.byProject['/p/b'];
    assert.ok(
      Math.abs(aA.cost.cachedReadBreakdown.systemPromptCached - 0.17) < 1e-9,
      `/p/a systemPromptCached expected 0.17 (A1+A2 only), got ${aA.cost.cachedReadBreakdown.systemPromptCached}`,
    );
    assert.ok(
      Math.abs(aB.cost.cachedReadBreakdown.systemPromptCached - 0.99) < 1e-9,
      `/p/b systemPromptCached expected 0.99, got ${aB.cost.cachedReadBreakdown.systemPromptCached}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON aggregates subagentDispatchByAgent merge across sessions on globalTotals', () => {
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.50,
          subagentDispatch: 0.15,
          subagentDispatchByAgent: { general: 0.10, explore: 0.05 },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.40,
          subagentDispatch: 0.18,
          subagentDispatchByAgent: { general: 0.08, build: 0.10 },
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const sda = report.globalTotals.cost.subagentDispatchByAgent;
    assert.ok(sda && typeof sda === 'object', 'subagentDispatchByAgent present');
    assert.ok(
      !(sda instanceof Map),
      'subagentDispatchByAgent must be a plain object on the assembled report (not Map)',
    );
    assert.ok(
      Math.abs(sda.general - 0.18) < 1e-9,
      `subagentDispatchByAgent.general expected 0.18 (A+B), got ${sda.general}`,
    );
    assert.ok(
      Math.abs(sda.explore - 0.05) < 1e-9,
      `subagentDispatchByAgent.explore expected 0.05 (A only), got ${sda.explore}`,
    );
    assert.ok(
      Math.abs(sda.build - 0.10) < 1e-9,
      `subagentDispatchByAgent.build expected 0.10 (B only), got ${sda.build}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON aggregates toolOutputsByTool merge with {cached,uncached} partition preserved on globalTotals', () => {
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 1.0,
          toolOutputs: 0.20,
          toolOutputsByTool: {
            read: { cached: 0.05, uncached: 0.10 },
            bash: { cached: 0.02, uncached: 0.03 },
          },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.5,
          toolOutputs: 0.10,
          toolOutputsByTool: {
            read: { cached: 0.01, uncached: 0.04 },
            edit: { cached: 0, uncached: 0.05 },
          },
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const tot = report.globalTotals.cost.toolOutputsByTool;
    assert.ok(tot && typeof tot === 'object', 'toolOutputsByTool present');
    assert.ok(
      !(tot instanceof Map),
      'toolOutputsByTool must be a plain object on the assembled report (not Map)',
    );
    // read appears in BOTH sessions → cached and uncached summed.
    assert.ok(
      Math.abs(tot.read.cached - 0.06) < 1e-9,
      `tot.read.cached expected 0.06 (A+B), got ${tot.read.cached}`,
    );
    assert.ok(
      Math.abs(tot.read.uncached - 0.14) < 1e-9,
      `tot.read.uncached expected 0.14 (A+B), got ${tot.read.uncached}`,
    );
    // bash only in A.
    assert.ok(
      Math.abs(tot.bash.cached - 0.02) < 1e-9,
      `tot.bash.cached expected 0.02 (A only), got ${tot.bash.cached}`,
    );
    assert.ok(
      Math.abs(tot.bash.uncached - 0.03) < 1e-9,
      `tot.bash.uncached expected 0.03 (A only), got ${tot.bash.uncached}`,
    );
    // edit only in B.
    assert.ok(
      Math.abs(tot.edit.cached - 0) < 1e-9,
      `tot.edit.cached expected 0 (B only), got ${tot.edit.cached}`,
    );
    assert.ok(
      Math.abs(tot.edit.uncached - 0.05) < 1e-9,
      `tot.edit.uncached expected 0.05 (B only), got ${tot.edit.uncached}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON per-project byAgent and byTool merges are isolated by directory', () => {
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a1',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.5,
          subagentDispatchByAgent: { general: 0.10 },
          toolOutputsByTool: { read: { cached: 0.01, uncached: 0.02 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_a2',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.4,
          subagentDispatchByAgent: { general: 0.07, explore: 0.03 },
          toolOutputsByTool: { read: { cached: 0.005, uncached: 0.015 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b1',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.3,
          subagentDispatchByAgent: { build: 0.99 }, // MUST NOT bleed
          toolOutputsByTool: { bash: { cached: 0.99, uncached: 0.99 } },
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const aA = report.byProject['/p/a'];
    const aB = report.byProject['/p/b'];

    // /p/a per-agent: A1+A2 only.
    assert.ok(
      Math.abs(aA.cost.subagentDispatchByAgent.general - 0.17) < 1e-9,
      `/p/a general expected 0.17, got ${aA.cost.subagentDispatchByAgent.general}`,
    );
    assert.ok(
      Math.abs(aA.cost.subagentDispatchByAgent.explore - 0.03) < 1e-9,
      `/p/a explore expected 0.03, got ${aA.cost.subagentDispatchByAgent.explore}`,
    );
    assert.equal(
      aA.cost.subagentDispatchByAgent.build,
      undefined,
      '/p/a must not carry the build agent (only in /p/b)',
    );
    // /p/a per-tool: A1+A2 only.
    assert.ok(
      Math.abs(aA.cost.toolOutputsByTool.read.cached - 0.015) < 1e-9,
      `/p/a read.cached expected 0.015, got ${aA.cost.toolOutputsByTool.read.cached}`,
    );
    assert.ok(
      Math.abs(aA.cost.toolOutputsByTool.read.uncached - 0.035) < 1e-9,
      `/p/a read.uncached expected 0.035, got ${aA.cost.toolOutputsByTool.read.uncached}`,
    );
    assert.equal(
      aA.cost.toolOutputsByTool.bash,
      undefined,
      '/p/a must not carry the bash tool (only in /p/b)',
    );
    // /p/b stays uncontaminated.
    assert.ok(
      Math.abs(aB.cost.subagentDispatchByAgent.build - 0.99) < 1e-9,
      `/p/b build expected 0.99, got ${aB.cost.subagentDispatchByAgent.build}`,
    );
    assert.ok(
      Math.abs(aB.cost.toolOutputsByTool.bash.cached - 0.99) < 1e-9,
      `/p/b bash.cached expected 0.99, got ${aB.cost.toolOutputsByTool.bash.cached}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON defensively converts Map<string,*> contributions to plain objects via Object.fromEntries', () => {
  // The current AttributionEngine emits `toolOutputsByTool` as a JS
  // Map (line ~2553) and may emit `subagentDispatchByAgent` as a Map
  // when task 5.8 lands. design.md ReportSerializer Implementation
  // Notes (line 695) require the conversion to plain object happen
  // here, not in the serializer. Verify the assembler handles a Map
  // contribution identically to a plain-object contribution and
  // produces a plain object on the assembled report.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.5,
          subagentDispatchByAgent: new Map([
            ['general', 0.10],
            ['explore', 0.05],
          ]),
          toolOutputsByTool: new Map([
            ['read', { cached: 0.02, uncached: 0.03 }],
            ['bash', { cached: 0.01, uncached: 0.04 }],
          ]),
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    const sda = report.globalTotals.cost.subagentDispatchByAgent;
    const tot = report.globalTotals.cost.toolOutputsByTool;
    assert.ok(
      !(sda instanceof Map),
      'subagentDispatchByAgent must be plain object even when contribution is a Map',
    );
    assert.ok(
      !(tot instanceof Map),
      'toolOutputsByTool must be plain object even when contribution is a Map',
    );
    assert.ok(Math.abs(sda.general - 0.10) < 1e-9);
    assert.ok(Math.abs(sda.explore - 0.05) < 1e-9);
    assert.ok(Math.abs(tot.read.cached - 0.02) < 1e-9);
    assert.ok(Math.abs(tot.read.uncached - 0.03) < 1e-9);
    assert.ok(Math.abs(tot.bash.cached - 0.01) < 1e-9);
    assert.ok(Math.abs(tot.bash.uncached - 0.04) < 1e-9);
    // Per-project must also be plain object.
    const aA = report.byProject['/p/a'];
    assert.ok(!(aA.cost.subagentDispatchByAgent instanceof Map));
    assert.ok(!(aA.cost.toolOutputsByTool instanceof Map));
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON drift contributions (null nested fields) skip merge but contribute to total', () => {
  // Parallel to 6.1's per-key drift-skip: a session whose
  // cachedReadBreakdown / subagentDispatchByAgent / toolOutputsByTool
  // is `null` (drift fallback shape) contributes nothing to the
  // per-sub-key sums but its `cost.total` still flows through.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_matched',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.80,
          cachedRead: 0.20,
          cachedReadBreakdown: {
            systemPromptCached: 0.10,
            agentsMdCached: 0.04,
            mcpToolSchemasCached: 0.03,
            accumulatedHistoryCached: 0.02,
            accumulatedToolOutputsCached: 0.005,
            unclassifiedCached: 0.005,
          },
          subagentDispatchByAgent: { general: 0.05 },
          toolOutputsByTool: { read: { cached: 0.01, uncached: 0.02 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_drift',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.20,
          cachedReadBreakdown: null,
          subagentDispatchByAgent: null,
          toolOutputsByTool: null,
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);

    // total: BOTH sessions (drift still contributes total).
    assert.ok(
      Math.abs(report.globalTotals.cost.total - 1.0) < 1e-9,
      `total expected 1.0, got ${report.globalTotals.cost.total}`,
    );
    // cachedReadBreakdown: matched-only.
    const crb = report.globalTotals.cost.cachedReadBreakdown;
    assert.ok(Math.abs(crb.systemPromptCached - 0.10) < 1e-9);
    assert.ok(Math.abs(crb.agentsMdCached - 0.04) < 1e-9);
    assert.ok(Math.abs(crb.mcpToolSchemasCached - 0.03) < 1e-9);
    assert.ok(Math.abs(crb.accumulatedHistoryCached - 0.02) < 1e-9);
    assert.ok(Math.abs(crb.accumulatedToolOutputsCached - 0.005) < 1e-9);
    assert.ok(Math.abs(crb.unclassifiedCached - 0.005) < 1e-9);
    // subagentDispatchByAgent: only the matched session's keys appear.
    const sda = report.globalTotals.cost.subagentDispatchByAgent;
    assert.ok(Math.abs(sda.general - 0.05) < 1e-9);
    assert.equal(
      Object.keys(sda).length,
      1,
      `expected exactly 1 agent key (drift contributed nothing), got ${Object.keys(sda).join(',')}`,
    );
    // toolOutputsByTool: only matched contributes.
    const tot = report.globalTotals.cost.toolOutputsByTool;
    assert.ok(Math.abs(tot.read.cached - 0.01) < 1e-9);
    assert.ok(Math.abs(tot.read.uncached - 0.02) < 1e-9);
    assert.equal(
      Object.keys(tot).length,
      1,
      `expected exactly 1 tool key (drift contributed nothing), got ${Object.keys(tot).join(',')}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON drift-only suite yields zero/empty sub-bucket shape but non-zero total', () => {
  // Mirror of 6.1's drift-only test, extended to the three nested
  // structures. Every session drift → cachedReadBreakdown all 0,
  // byAgent / byTool empty objects; total = sum of session.cost.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'd1',
        directory: '/p/a',
        cost: makeV2CostExtended({
          total: 0.30,
          cachedReadBreakdown: null,
          subagentDispatchByAgent: null,
          toolOutputsByTool: null,
        }),
      }),
      makeAttribution({
        sessionId: 'd2',
        directory: '/p/b',
        cost: makeV2CostExtended({
          total: 0.20,
          cachedReadBreakdown: null,
          subagentDispatchByAgent: null,
          toolOutputsByTool: null,
        }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    assert.ok(Math.abs(report.globalTotals.cost.total - 0.50) < 1e-9);
    const crb = report.globalTotals.cost.cachedReadBreakdown;
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.equal(crb[k], 0, `drift-only: cachedReadBreakdown.${k} expected 0`);
    }
    assert.deepEqual(report.globalTotals.cost.subagentDispatchByAgent, {});
    assert.deepEqual(report.globalTotals.cost.toolOutputsByTool, {});
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON exposes cachedReadBreakdown / byAgent / byTool on globalTotals AND every byProject entry', () => {
  // Forward-compat presence check: even with no per-session
  // contributions on these fields, the flag-ON aggregator must
  // initialise the keys so downstream consumers (ReportSerializer
  // 7.x, integration goldens 8.1) see a stable shape.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2Cost({ total: 0.10 }), // no cachedReadBreakdown/by*
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    for (const target of [report.globalTotals.cost, report.byProject['/p/a'].cost]) {
      assert.ok(
        target.cachedReadBreakdown &&
          typeof target.cachedReadBreakdown === 'object',
        'cachedReadBreakdown must be present (zero-shape) when flag is ON',
      );
      for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
        assert.equal(
          target.cachedReadBreakdown[k],
          0,
          `cachedReadBreakdown.${k} must default to 0`,
        );
      }
      assert.ok(
        target.subagentDispatchByAgent &&
          typeof target.subagentDispatchByAgent === 'object' &&
          !(target.subagentDispatchByAgent instanceof Map),
        'subagentDispatchByAgent must be a plain object (empty default)',
      );
      assert.ok(
        target.toolOutputsByTool &&
          typeof target.toolOutputsByTool === 'object' &&
          !(target.toolOutputsByTool instanceof Map),
        'toolOutputsByTool must be a plain object (empty default)',
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag OFF preserves v1 shape — no cachedReadBreakdown / byAgent / byTool on aggregator', () => {
  // v1 invariant. Even when the attribution carries the v2 nested
  // structures, the flag-OFF aggregator must NOT add them to
  // globalTotals.cost or to byProject entries — otherwise the
  // byte-identical integration goldens (8.1) would shift.
  const attrs = [
    makeAttribution({
      sessionId: 'ses_a',
      directory: '/p/a',
      cost: makeV2CostExtended({
        total: 0.50,
        cachedReadBreakdown: {
          systemPromptCached: 0.10,
          agentsMdCached: 0,
          mcpToolSchemasCached: 0,
          accumulatedHistoryCached: 0,
          accumulatedToolOutputsCached: 0,
          unclassifiedCached: 0,
        },
        subagentDispatchByAgent: { general: 0.05 },
        toolOutputsByTool: { read: { cached: 0.01, uncached: 0.02 } },
      }),
    }),
  ];
  const report = new ReportAssembler().assemble(attrs);
  assert.equal(
    report.globalTotals.cost.cachedReadBreakdown,
    undefined,
    'flag OFF: globalTotals.cost.cachedReadBreakdown must not be present',
  );
  assert.equal(
    report.globalTotals.cost.subagentDispatchByAgent,
    undefined,
    'flag OFF: globalTotals.cost.subagentDispatchByAgent must not be present',
  );
  assert.equal(
    report.globalTotals.cost.toolOutputsByTool,
    undefined,
    'flag OFF: globalTotals.cost.toolOutputsByTool must not be present',
  );
  const aA = report.byProject['/p/a'];
  assert.equal(aA.cost.cachedReadBreakdown, undefined);
  assert.equal(aA.cost.subagentDispatchByAgent, undefined);
  assert.equal(aA.cost.toolOutputsByTool, undefined);
});

/* ── Task 6.3: pricing pin block, threshold metadata, extended affectedBuckets ── */
//
// The flag-OFF branch must preserve the v1 disclaimer shape verbatim
// (no `thresholds`, no top-level `pricing`, `affectedBuckets` is the
// v1 3-element list). Any drift here would break the byte-identical
// integration goldens that 8.1 refreshes.
//
// The flag-ON branch adds:
//   - top-level `pricing: { pinDate, pinSource, pinVersion? }` sourced
//     from PricingTable.pinMetadata
//   - `tokenizer_disclaimer.thresholds: { subagentBelowThresholdPct,
//     subagentBelowThresholdChildFloor, toolBelowThresholdPct }`
//   - `tokenizer_disclaimer.affectedBuckets` is the V2 list (includes
//     the 6 cachedRead sub-buckets plus `toolOutputsByTool` and
//     `subagentDispatchByAgent` dimension labels)
//
// ReportAssembler.length === 1 (constructor now declares a single
// `pricingTable` parameter — backward-compat is preserved by an
// in-body null check, NOT a default value, because default values
// do not count toward Function.length).
//
// Requirements: R3.3 (pin metadata visible), R4.4 (extended
// disclaimer), R5.4 (subagent threshold disclosure), R6.5 (tool
// threshold disclosure).

test('ReportAssembler.length === 1 (constructor accepts pricingTable)', () => {
  // Function.length is the count of formal parameters BEFORE the
  // first default. The 6.3 constructor declares pricingTable as a
  // bare param (no `= null` default) and handles the no-arg case in
  // the body — so length is 1 and existing `new ReportAssembler()`
  // call sites continue to work without modification.
  assert.equal(
    ReportAssembler.length,
    1,
    `ReportAssembler.length expected 1 (now accepts pricingTable), got ${ReportAssembler.length}`,
  );
});

test('ReportAssembler: still constructable with no arguments (backward compat)', () => {
  // The 6.3 constructor accepts a single pricingTable arg but must
  // tolerate `new ReportAssembler()` calls — every existing v1 test
  // (above) constructs with no args and the integration harness
  // relied on this through tasks 4.x. A throw here would break
  // every existing case.
  const a = new ReportAssembler();
  assert.equal(typeof a.assemble, 'function');
});

test('assemble: flag ON + pricingTable injects top-level pricing block', () => {
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2Cost({ total: 0.10 }),
      }),
    ];
    const report = new ReportAssembler(pricingTable).assemble(attrs);

    assert.equal(typeof report.pricing, 'object', 'report.pricing must be an object');
    assert.notEqual(report.pricing, null);
    // Synthetic pricing fixture pin metadata: hand-coded at
    // tests/opencode-cost-diagnosis/fixtures/synthetic-pricing.json
    // so the assertions are deterministic and decoupled from the
    // production pin date.
    assert.equal(report.pricing.pinDate, '2026-01-01');
    assert.equal(report.pricing.pinSource, 'synthetic-test-fixture');
    assert.equal(report.pricing.pinVersion, 'v1.0-test');
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON + pricingTable — report.pricing is independent of pinMetadata mutation', () => {
  // Defensive shallow-copy guard: PricingTable.pinMetadata is frozen
  // (see lines 656 + 678 of opencode-cost-report.js). A consumer that
  // tries to extend `report.pricing` (e.g. adding a `notes` field)
  // would otherwise hit a TypeError if we passed the frozen reference
  // through unchanged. The assembler shallow-clones so the report
  // itself stays mutable.
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const report = new ReportAssembler(pricingTable).assemble([]);
    assert.notStrictEqual(
      report.pricing,
      pricingTable.pinMetadata,
      'report.pricing must be a shallow clone, not the same frozen reference',
    );
    // Mutability sanity: a consumer can add an annotation without
    // throwing. (The fact that this doesn't throw is the assertion.)
    report.pricing.note = 'consumer-annotation';
    assert.equal(report.pricing.note, 'consumer-annotation');
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON without pricingTable omits the pricing block', () => {
  // The constructor accepts `null` (or no-arg) for back-compat with
  // every existing unit test. When pricingTable is absent, the
  // assembler MUST NOT fabricate a pricing block — there's no
  // authoritative pinDate to report. Downstream renderers can use
  // the absence as a "pin metadata unavailable" signal.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a',
        directory: '/p/a',
        cost: makeV2Cost({ total: 0.10 }),
      }),
    ];
    const report = new ReportAssembler().assemble(attrs);
    assert.equal(
      report.pricing,
      undefined,
      'flag ON without pricingTable: report.pricing must be omitted',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON injects tokenizer_disclaimer.thresholds with R5.4 / R6.5 values', () => {
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const report = new ReportAssembler(pricingTable).assemble([]);
    const t = report.tokenizer_disclaimer.thresholds;
    assert.equal(typeof t, 'object', 'tokenizer_disclaimer.thresholds must be an object');
    assert.notEqual(t, null);
    // Canonical R5.4 disclosure: subagent below-threshold fold
    // percentage (1% of descendant count) and the floor (never less
    // than 1 child). Source: SUBAGENT_BELOW_THRESHOLD_PCT and
    // SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR module constants.
    assert.equal(t.subagentBelowThresholdPct, 0.01);
    assert.equal(t.subagentBelowThresholdChildFloor, 1);
    // Canonical R6.5 disclosure: tool below-threshold fold percentage.
    assert.equal(t.toolBelowThresholdPct, 0.01);
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON extends tokenizer_disclaimer.affectedBuckets with cachedRead sub-buckets and per-tool/per-agent dimensions', () => {
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const report = new ReportAssembler(pricingTable).assemble([]);
    const ab = report.tokenizer_disclaimer.affectedBuckets;

    // Preserved v1 entries (forward-compat: no rename, no drop)
    assert.ok(ab.includes('uncachedSystemPrompt'));
    assert.ok(ab.includes('history'));
    assert.ok(ab.includes('toolOutputs'));

    // New v2 entries — task-observable spot check on systemPromptCached
    assert.ok(
      ab.includes('systemPromptCached'),
      `affectedBuckets must include systemPromptCached, got: ${ab.join(', ')}`,
    );

    // Every cachedRead sub-bucket from CACHED_READ_SUB_BUCKET_KEYS
    // should appear — the entire decomposition is tokenizer-derived
    // per R4.4 ("the cached-read sub-buckets whose values are
    // tokenizer-derived").
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.ok(
        ab.includes(k),
        `affectedBuckets must include cachedRead sub-bucket '${k}', got: ${ab.join(', ')}`,
      );
    }

    // Per-tool and per-agent dimensions (task brief: "the byTool/byAgent dimensions").
    assert.ok(
      ab.includes('toolOutputsByTool'),
      'affectedBuckets must include the byTool dimension label',
    );
    assert.ok(
      ab.includes('subagentDispatchByAgent'),
      'affectedBuckets must include the byAgent dimension label',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag OFF preserves v1 disclaimer shape verbatim — no thresholds, no top-level pricing, v1 affectedBuckets list', () => {
  // v1 invariant: flag-OFF emission must NOT acquire any of the v2
  // additions. The byte-identical integration goldens 8.1 will
  // refresh against the flag-ON shape; flag-OFF must continue to
  // emit the exact v1 disclaimer through the 5.x/6.x rollout window.
  const pricingTable = new PricingTable(SYNTHETIC_PRICING);
  // Even when pricingTable IS supplied, flag-OFF must suppress the
  // pricing block — the flag is the authoritative gate, not the
  // presence of the table. (Operators flipping the flag back to
  // OFF during a regression hunt must see the exact v1 emission.)
  const report = new ReportAssembler(pricingTable).assemble([]);

  // No top-level pricing
  assert.equal(report.pricing, undefined, 'flag OFF: report.pricing must be absent');

  // No thresholds inside the disclaimer
  assert.equal(
    report.tokenizer_disclaimer.thresholds,
    undefined,
    'flag OFF: tokenizer_disclaimer.thresholds must be absent',
  );

  // affectedBuckets is the exact v1 3-element list (preserved order)
  assert.deepEqual(report.tokenizer_disclaimer.affectedBuckets, [
    'uncachedSystemPrompt',
    'history',
    'toolOutputs',
  ]);
});

test('assemble: flag ON pricing.pinVersion is omitted when source JSON lacks it', () => {
  // Belt-and-suspenders for the optional pinVersion contract: the
  // synthetic fixture DOES include pinVersion; this test rebuilds the
  // pricing table from a stripped fixture and confirms `pricing` then
  // omits pinVersion (PricingTable.pinMetadata only sets pinVersion
  // when the source has it; the assembler propagates whatever
  // pinMetadata returns).
  const fs = require('node:fs');
  const os = require('node:os');
  const stripped = JSON.parse(fs.readFileSync(SYNTHETIC_PRICING, 'utf8'));
  delete stripped.pinVersion;
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rep-asm-test-')),
    'pricing-no-version.json',
  );
  fs.writeFileSync(tmpFile, JSON.stringify(stripped));
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(tmpFile);
    const report = new ReportAssembler(pricingTable).assemble([]);
    assert.equal(report.pricing.pinDate, '2026-01-01');
    assert.equal(report.pricing.pinSource, 'synthetic-test-fixture');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(report.pricing, 'pinVersion'),
      'pricing.pinVersion must be absent when source JSON omits it',
    );
  } finally {
    setV2CostComputeEnabled(false);
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
});

/* ── Task 6.4: cross-cutting composition + adversarial coverage ── */
//
// The flag-ON tests above each exercise one v2 surface in isolation
// (per-bucket cost; cachedReadBreakdown; byAgent; byTool; pricing;
// thresholds; extended affectedBuckets). Task 6.4's review criteria
// call for cross-cutting cases that catch shape-contradictions between
// those surfaces — e.g. an assembler change that wires up pricing but
// forgets to initialise cachedReadBreakdown on byProject entries would
// pass every isolated test but fail an end-to-end shape check.
//
// These tests deliberately combine the v2 surfaces, scale beyond the
// 2-project pairwise tests, exercise all five spec-named findings in
// one assembler run, and pin the empty-attrs flag-ON behaviour.
//
// Requirements covered: R2.2 (global + per-project dollar aggregation),
// R4.3 (cachedRead sub-buckets at all aggregation levels), R4.4
// (extended disclaimer affectedBuckets), R5.3 (per-agent sub-buckets at
// all aggregation levels), R5.4 (subagent threshold disclosure), R6.4
// (per-tool sub-buckets at all aggregation levels), R6.5 (tool
// threshold disclosure).

test('assemble: flag ON end-to-end composition — every v2 surface present and self-consistent in one report', () => {
  // Adversarial composition (task 6.4 review criterion A): exercise
  // every new v2 surface AT THE SAME TIME on a single assembler call
  // and prove the parts don't contradict each other. A regression
  // that, say, wires up `pricing` but forgets to default
  // `cachedReadBreakdown` on `byProject` entries would pass each
  // isolated 6.1/6.2/6.3 test but fail here.
  //
  // Composition coverage:
  //   - 2 projects × 2 sessions each (4 attributions)
  //   - matched per-bucket cost on every session (R2.2 globalTotals
  //     AND byProject sums consistent)
  //   - non-zero cachedReadBreakdown on every session (R4.3)
  //   - non-zero subagentDispatchByAgent on every session (R5.3)
  //   - non-zero toolOutputsByTool on every session (R6.4)
  //   - pricing table supplied → top-level pricing block (R3.3)
  //   - flag ON → thresholds (R5.4 / R6.5) + extended affectedBuckets
  //     (R4.4)
  //   - tokenizer_disclaimer present (R2.AC9 forward-compat)
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const attrs = [
      makeAttribution({
        sessionId: 'ses_a1',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 1.00,
          cachedRead: 0.20,
          cachedWrite: 0.05,
          uncachedInput: 0.30,
          output: 0.30,
          reasoning: 0.05,
          subagentDispatch: 0.10,
          uncachedSystemPrompt: 0.08,
          history: 0.20,
          toolOutputs: 0.02,
          cachedReadBreakdown: {
            systemPromptCached: 0.05,
            agentsMdCached: 0.04,
            mcpToolSchemasCached: 0.03,
            accumulatedHistoryCached: 0.05,
            accumulatedToolOutputsCached: 0.02,
            unclassifiedCached: 0.01,
          },
          subagentDispatchByAgent: { general: 0.06, explore: 0.04 },
          toolOutputsByTool: { read: { cached: 0.01, uncached: 0.01 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_a2',
        directory: '/p/a',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 0.50,
          cachedRead: 0.10,
          cachedWrite: 0.02,
          uncachedInput: 0.15,
          output: 0.15,
          reasoning: 0.02,
          subagentDispatch: 0.06,
          uncachedSystemPrompt: 0.04,
          history: 0.10,
          toolOutputs: 0.01,
          cachedReadBreakdown: {
            systemPromptCached: 0.03,
            agentsMdCached: 0.02,
            mcpToolSchemasCached: 0.02,
            accumulatedHistoryCached: 0.02,
            accumulatedToolOutputsCached: 0.005,
            unclassifiedCached: 0.005,
          },
          subagentDispatchByAgent: { general: 0.04, build: 0.02 },
          toolOutputsByTool: { bash: { cached: 0, uncached: 0.01 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b1',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 0.40,
          cachedRead: 0.08,
          cachedWrite: 0.02,
          uncachedInput: 0.12,
          output: 0.12,
          reasoning: 0.02,
          subagentDispatch: 0.04,
          uncachedSystemPrompt: 0.03,
          history: 0.08,
          toolOutputs: 0.01,
          cachedReadBreakdown: {
            systemPromptCached: 0.02,
            agentsMdCached: 0.02,
            mcpToolSchemasCached: 0.01,
            accumulatedHistoryCached: 0.02,
            accumulatedToolOutputsCached: 0.005,
            unclassifiedCached: 0.005,
          },
          subagentDispatchByAgent: { explore: 0.04 },
          toolOutputsByTool: { edit: { cached: 0, uncached: 0.01 } },
        }),
      }),
      makeAttribution({
        sessionId: 'ses_b2',
        directory: '/p/b',
        tokens: { cachedRead: 5000 },
        cost: makeV2CostExtended({
          total: 0.30,
          cachedRead: 0.06,
          cachedWrite: 0.01,
          uncachedInput: 0.09,
          output: 0.10,
          reasoning: 0.02,
          subagentDispatch: 0.02,
          uncachedSystemPrompt: 0.02,
          history: 0.06,
          toolOutputs: 0.01,
          cachedReadBreakdown: {
            systemPromptCached: 0.02,
            agentsMdCached: 0.01,
            mcpToolSchemasCached: 0.01,
            accumulatedHistoryCached: 0.01,
            accumulatedToolOutputsCached: 0.005,
            unclassifiedCached: 0.005,
          },
          subagentDispatchByAgent: { build: 0.02 },
          toolOutputsByTool: { bash: { cached: 0, uncached: 0.01 } },
        }),
      }),
    ];
    const report = new ReportAssembler(pricingTable).assemble(attrs);

    // ── Top-level shape ─────────────────────────────────────────
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.reportType, 'opencode-cost-diagnosis');
    assert.equal(report.sessionCount, 4);
    assert.equal(typeof report.tokenizer_disclaimer, 'object');

    // ── Pricing block (R3.3) ────────────────────────────────────
    assert.equal(report.pricing.pinDate, '2026-01-01');
    assert.equal(report.pricing.pinSource, 'synthetic-test-fixture');

    // ── Disclaimer thresholds (R5.4 / R6.5) ─────────────────────
    const t = report.tokenizer_disclaimer.thresholds;
    assert.equal(t.subagentBelowThresholdPct, 0.01);
    assert.equal(t.subagentBelowThresholdChildFloor, 1);
    assert.equal(t.toolBelowThresholdPct, 0.01);

    // ── Disclaimer extended affectedBuckets (R4.4) ──────────────
    const ab = report.tokenizer_disclaimer.affectedBuckets;
    assert.ok(ab.includes('systemPromptCached'));
    assert.ok(ab.includes('toolOutputsByTool'));
    assert.ok(ab.includes('subagentDispatchByAgent'));

    // ── Global per-bucket cost (R2.2) — every key summed ────────
    const g = report.globalTotals.cost;
    assert.ok(Math.abs(g.total - 2.20) < 1e-9, `globalTotals.cost.total expected 2.20, got ${g.total}`);
    const expectedGlobalPerBucket = {
      cachedRead: 0.44,
      cachedWrite: 0.10,
      uncachedInput: 0.66,
      output: 0.67,
      reasoning: 0.11,
      subagentDispatch: 0.22,
      uncachedSystemPrompt: 0.17,
      history: 0.44,
      toolOutputs: 0.05,
    };
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.ok(
        Math.abs(g[k] - expectedGlobalPerBucket[k]) < 1e-9,
        `globalTotals.cost.${k} expected ${expectedGlobalPerBucket[k]}, got ${g[k]}`,
      );
    }

    // ── Global cachedReadBreakdown (R4.3) ───────────────────────
    assert.ok(Math.abs(g.cachedReadBreakdown.systemPromptCached - 0.12) < 1e-9);
    assert.ok(Math.abs(g.cachedReadBreakdown.agentsMdCached - 0.09) < 1e-9);
    assert.ok(Math.abs(g.cachedReadBreakdown.unclassifiedCached - 0.025) < 1e-9);

    // ── Global subagentDispatchByAgent (R5.3) ───────────────────
    assert.ok(!(g.subagentDispatchByAgent instanceof Map));
    assert.ok(Math.abs(g.subagentDispatchByAgent.general - 0.10) < 1e-9);
    assert.ok(Math.abs(g.subagentDispatchByAgent.explore - 0.08) < 1e-9);
    assert.ok(Math.abs(g.subagentDispatchByAgent.build - 0.04) < 1e-9);

    // ── Global toolOutputsByTool (R6.4) ─────────────────────────
    assert.ok(!(g.toolOutputsByTool instanceof Map));
    assert.ok(Math.abs(g.toolOutputsByTool.read.cached - 0.01) < 1e-9);
    assert.ok(Math.abs(g.toolOutputsByTool.bash.uncached - 0.02) < 1e-9);
    assert.ok(Math.abs(g.toolOutputsByTool.edit.uncached - 0.01) < 1e-9);

    // ── Per-project shape parity — every v2 surface exists ──────
    for (const dir of ['/p/a', '/p/b']) {
      const agg = report.byProject[dir];
      assert.equal(agg.sessionCount, 2, `${dir}.sessionCount expected 2`);
      assert.equal(typeof agg.cost.total, 'number');
      for (const k of PER_BUCKET_COST_KEYS) {
        assert.equal(
          typeof agg.cost[k],
          'number',
          `${dir}.cost.${k} must be a number under flag ON`,
        );
      }
      assert.ok(agg.cost.cachedReadBreakdown && typeof agg.cost.cachedReadBreakdown === 'object');
      assert.ok(!(agg.cost.subagentDispatchByAgent instanceof Map));
      assert.ok(!(agg.cost.toolOutputsByTool instanceof Map));
    }

    // ── Per-project + global sum-correctness invariant ──────────
    // The global cachedReadBreakdown.systemPromptCached must equal
    // the sum across every byProject entry's same field. This is
    // the strongest cross-cutting consistency assertion: a bug
    // that aggregated to global but skipped byProject (or vice
    // versa) would fail here.
    const globalSPC = g.cachedReadBreakdown.systemPromptCached;
    const projSumSPC =
      report.byProject['/p/a'].cost.cachedReadBreakdown.systemPromptCached +
      report.byProject['/p/b'].cost.cachedReadBreakdown.systemPromptCached;
    assert.ok(
      Math.abs(globalSPC - projSumSPC) < 1e-9,
      `cross-cutting: globalTotals.cachedReadBreakdown.systemPromptCached (${globalSPC}) must equal sum across byProject (${projSumSPC})`,
    );
    // Same invariant for per-bucket cost total.
    const projSumCachedRead =
      report.byProject['/p/a'].cost.cachedRead +
      report.byProject['/p/b'].cost.cachedRead;
    assert.ok(
      Math.abs(g.cachedRead - projSumCachedRead) < 1e-9,
      `cross-cutting: globalTotals.cost.cachedRead (${g.cachedRead}) must equal sum across byProject (${projSumCachedRead})`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON aggregates per-bucket and nested sub-buckets correctly across 3+ projects', () => {
  // Task 6.4 review criterion B: prove per-project grouping scales
  // beyond pairwise. Three distinct cwds, each with two sessions
  // contributing to the v2 surfaces. A regression that worked on the
  // 2-project test cases but lost the third project (e.g. a Map
  // iteration that only converted the first two entries) would fail
  // here even though the byProject key count looks right.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [];
    // Each project A/B/C gets two sessions with the same per-session
    // cost so the per-project sums are independent of session order.
    for (const [dir, sda] of [
      ['/p/a', { general: 0.10 }],
      ['/p/b', { explore: 0.10 }],
      ['/p/c', { build: 0.10 }],
    ]) {
      for (const sfx of ['1', '2']) {
        attrs.push(
          makeAttribution({
            sessionId: `ses${dir.replace('/p/', '')}${sfx}`,
            directory: dir,
            tokens: { cachedRead: 5000 },
            cost: makeV2CostExtended({
              total: 0.25,
              cachedRead: 0.05,
              cachedReadBreakdown: {
                systemPromptCached: 0.02,
                agentsMdCached: 0.01,
                mcpToolSchemasCached: 0.005,
                accumulatedHistoryCached: 0.01,
                accumulatedToolOutputsCached: 0.0025,
                unclassifiedCached: 0.0025,
              },
              subagentDispatchByAgent: sda,
              toolOutputsByTool: { read: { cached: 0.01, uncached: 0.02 } },
            }),
          }),
        );
      }
    }
    const report = new ReportAssembler().assemble(attrs);

    // sessionCount and byProject cardinality
    assert.equal(report.sessionCount, 6);
    assert.equal(Object.keys(report.byProject).length, 3);
    assert.ok(report.byProject['/p/a']);
    assert.ok(report.byProject['/p/b']);
    assert.ok(report.byProject['/p/c']);

    // Per-project sessionCount = 2 each
    for (const dir of ['/p/a', '/p/b', '/p/c']) {
      assert.equal(report.byProject[dir].sessionCount, 2, `${dir}.sessionCount`);
    }

    // Per-project per-bucket sum (2 × 0.05 = 0.10 each for cachedRead)
    for (const dir of ['/p/a', '/p/b', '/p/c']) {
      assert.ok(
        Math.abs(report.byProject[dir].cost.cachedRead - 0.10) < 1e-9,
        `${dir}.cost.cachedRead expected 0.10, got ${report.byProject[dir].cost.cachedRead}`,
      );
      // Per-project cachedReadBreakdown.systemPromptCached = 2 × 0.02
      assert.ok(
        Math.abs(report.byProject[dir].cost.cachedReadBreakdown.systemPromptCached - 0.04) < 1e-9,
      );
    }

    // Per-project byAgent isolation: each project sees only its own agent
    assert.equal(Object.keys(report.byProject['/p/a'].cost.subagentDispatchByAgent).length, 1);
    assert.ok(Math.abs(report.byProject['/p/a'].cost.subagentDispatchByAgent.general - 0.20) < 1e-9);
    assert.equal(report.byProject['/p/a'].cost.subagentDispatchByAgent.explore, undefined);
    assert.equal(report.byProject['/p/a'].cost.subagentDispatchByAgent.build, undefined);
    assert.equal(Object.keys(report.byProject['/p/b'].cost.subagentDispatchByAgent).length, 1);
    assert.ok(Math.abs(report.byProject['/p/b'].cost.subagentDispatchByAgent.explore - 0.20) < 1e-9);
    assert.equal(Object.keys(report.byProject['/p/c'].cost.subagentDispatchByAgent).length, 1);
    assert.ok(Math.abs(report.byProject['/p/c'].cost.subagentDispatchByAgent.build - 0.20) < 1e-9);

    // Global aggregates: total = 6 × 0.25, cachedRead = 6 × 0.05,
    // cachedReadBreakdown.systemPromptCached = 6 × 0.02, byAgent
    // contains all 3 distinct agents each at 2 × 0.10.
    const g = report.globalTotals.cost;
    assert.ok(Math.abs(g.total - 1.50) < 1e-9);
    assert.ok(Math.abs(g.cachedRead - 0.30) < 1e-9);
    assert.ok(Math.abs(g.cachedReadBreakdown.systemPromptCached - 0.12) < 1e-9);
    assert.equal(Object.keys(g.subagentDispatchByAgent).length, 3);
    assert.ok(Math.abs(g.subagentDispatchByAgent.general - 0.20) < 1e-9);
    assert.ok(Math.abs(g.subagentDispatchByAgent.explore - 0.20) < 1e-9);
    assert.ok(Math.abs(g.subagentDispatchByAgent.build - 0.20) < 1e-9);

    // Cross-cutting invariant: global cachedRead = sum of every project's cachedRead.
    const sumProj = Object.values(report.byProject).reduce((s, p) => s + p.cost.cachedRead, 0);
    assert.ok(Math.abs(g.cachedRead - sumProj) < 1e-9);
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: aggregates all 5 spec-named findings into global findings array with sessionId tagging preserved', () => {
  // Task 6.4 review criterion C: the assembler's per-session-findings
  // forwarding loop (lines ~3765-3775) must propagate every finding
  // kind verbatim AND attach the originating sessionId. The existing
  // test `assemble: per-session finding carries session ID context`
  // only exercises one finding on one session; this case exercises
  // all five v2-relevant finding kinds simultaneously to catch a
  // regression where the loop accidentally filters by kind or only
  // forwards the first finding per session.
  //
  // Finding kinds chosen to mirror the v2 spec catalog:
  //   - drift                                (R3.x pricing drift)
  //   - cost_invariant_violation             (R2.x sum-correctness)
  //   - cached_read_classification_residual  (R4.x cachedRead residual)
  //   - subagent_agent_attribution_drift     (R5.x subagent drift)
  //   - per_bucket_cost_deferred             (v1→v2 forward-compat marker)
  const allFiveKinds = [
    'drift',
    'cost_invariant_violation',
    'cached_read_classification_residual',
    'subagent_agent_attribution_drift',
    'per_bucket_cost_deferred',
  ];
  const attrs = [
    makeAttribution({
      sessionId: 'ses_multi_findings',
      directory: '/p/a',
      findings: allFiveKinds.map((k) => ({
        kind: k,
        detail: `synthetic ${k} detail`,
      })),
    }),
    makeAttribution({
      sessionId: 'ses_clean',
      directory: '/p/b',
      findings: [], // no findings — must not appear in the per-session forwarding
    }),
  ];
  const report = new ReportAssembler().assemble(attrs);

  // Every forwarded finding must carry sessionId === 'ses_multi_findings'.
  const forwarded = report.findings.filter((f) =>
    allFiveKinds.includes(f.kind),
  );
  assert.equal(
    forwarded.length,
    5,
    `expected all 5 finding kinds to be forwarded, got ${forwarded.length}: ${forwarded.map((f) => f.kind).join(',')}`,
  );
  for (const k of allFiveKinds) {
    const found = forwarded.find((f) => f.kind === k);
    assert.ok(found, `finding kind '${k}' missing from forwarded findings`);
    assert.equal(
      found.sessionId,
      'ses_multi_findings',
      `finding '${k}' must be tagged with originating sessionId`,
    );
    assert.equal(
      found.detail,
      `synthetic ${k} detail`,
      `finding '${k}' detail must be preserved verbatim`,
    );
  }
  // ses_clean must NOT contribute any per-session findings (empty
  // array on the input). The only entries with sessionId === 'ses_clean'
  // would be assembler-emitted globals tagged with sesId — and the
  // global caching_not_enabled finding is NOT per-session-tagged.
  const cleanTagged = report.findings.filter((f) => f.sessionId === 'ses_clean');
  assert.equal(
    cleanTagged.length,
    0,
    `ses_clean must not contribute per-session findings, got ${cleanTagged.length}`,
  );
});

test('assemble([]): flag ON + pricingTable produces valid empty report with pricing + disclaimer + thresholds, no crash', () => {
  // Task 6.4 review criterion D: the zero-attribution path
  // (empty `attrs` array) must produce a valid v2 report — no
  // crashes, empty byProject/sessions, sessionCount=0 — AND must
  // still inject the pricing block + thresholds + extended
  // affectedBuckets when the flag is ON and a pricingTable is
  // supplied. The empty-attrs case is the canonical "empty DB / no
  // matching sessions" path and is the smallest possible regression
  // surface for a missing `if (attrs.length > 0)` guard around any
  // of the v2 emission paths.
  setV2CostComputeEnabled(true);
  try {
    const pricingTable = new PricingTable(SYNTHETIC_PRICING);
    const report = new ReportAssembler(pricingTable).assemble([]);

    // Empty-shape invariants (R2.AC8)
    assert.equal(report.sessionCount, 0);
    assert.deepEqual(report.byProject, {});
    assert.deepEqual(report.sessions, []);
    assert.ok(Array.isArray(report.findings));

    // caching_not_enabled MUST NOT fire on the empty path
    // (R2.AC7 — requirement presupposes ≥1 in-scope session).
    const cne = report.findings.filter((f) => f.kind === 'caching_not_enabled');
    assert.equal(cne.length, 0, 'caching_not_enabled must not fire on empty attrs');

    // globalTotals.tokens should be an object with zeroed counts;
    // globalTotals.cost.total === 0.
    assert.equal(typeof report.globalTotals.tokens, 'object');
    assert.equal(typeof report.globalTotals.cost, 'object');
    assert.equal(report.globalTotals.cost.total, 0);

    // Per-bucket cost keys present under flag ON (default initialised
    // to numeric zero, not null).
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.equal(
        typeof report.globalTotals.cost[k],
        'number',
        `flag ON + empty: globalTotals.cost.${k} must be a number (defaulted to 0)`,
      );
      assert.equal(report.globalTotals.cost[k], 0);
    }
    // Nested sub-bucket structures present and empty/zeroed.
    const crb = report.globalTotals.cost.cachedReadBreakdown;
    assert.ok(crb && typeof crb === 'object');
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.equal(crb[k], 0, `empty: cachedReadBreakdown.${k} expected 0`);
    }
    assert.deepEqual(report.globalTotals.cost.subagentDispatchByAgent, {});
    assert.deepEqual(report.globalTotals.cost.toolOutputsByTool, {});

    // Pricing block STILL injected when flag is ON and pricingTable
    // is supplied — the empty-attrs case must not suppress it.
    assert.equal(typeof report.pricing, 'object');
    assert.equal(report.pricing.pinDate, '2026-01-01');
    assert.equal(report.pricing.pinSource, 'synthetic-test-fixture');

    // Disclaimer thresholds + extended affectedBuckets must still be
    // present on the empty-attrs path.
    const t = report.tokenizer_disclaimer.thresholds;
    assert.equal(t.subagentBelowThresholdPct, 0.01);
    assert.equal(t.toolBelowThresholdPct, 0.01);
    const ab = report.tokenizer_disclaimer.affectedBuckets;
    assert.ok(ab.includes('systemPromptCached'));
    assert.ok(ab.includes('toolOutputsByTool'));
    assert.ok(ab.includes('subagentDispatchByAgent'));
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('assemble: flag ON mixes matched + drift sessions ACROSS multiple projects with correct per-project AND global aggregates', () => {
  // Task 6.4 review criterion E: the existing drift-skip tests cover
  // (matched on /p/a) + (drift on /p/b), so drift never coexists with
  // matched WITHIN a project. This case puts both a matched and a
  // drift session in every project, scales to 3 projects, and asserts
  // both byProject-level AND global aggregates simultaneously. A
  // regression that handled drift correctly at the global level but
  // double-counted (or skipped) at the per-project level would fail
  // here but pass every existing 6.x test.
  setV2CostComputeEnabled(true);
  try {
    const attrs = [];
    for (const dir of ['/p/a', '/p/b', '/p/c']) {
      // One matched session per project — full v2 cost.
      attrs.push(
        makeAttribution({
          sessionId: `${dir}-matched`,
          directory: dir,
          tokens: { cachedRead: 5000 },
          cost: makeV2CostExtended({
            total: 0.50,
            cachedRead: 0.10,
            cachedWrite: 0.02,
            uncachedInput: 0.15,
            output: 0.15,
            reasoning: 0.02,
            subagentDispatch: 0.06,
            uncachedSystemPrompt: 0.04,
            history: 0.10,
            toolOutputs: 0.01,
            cachedReadBreakdown: {
              systemPromptCached: 0.03,
              agentsMdCached: 0.02,
              mcpToolSchemasCached: 0.02,
              accumulatedHistoryCached: 0.02,
              accumulatedToolOutputsCached: 0.005,
              unclassifiedCached: 0.005,
            },
            subagentDispatchByAgent: { general: 0.06 },
            toolOutputsByTool: { read: { cached: 0.005, uncached: 0.005 } },
          }),
        }),
      );
      // One drift session per project — total only; per-key null;
      // nested sub-bucket structures null. Must contribute its total
      // to BOTH the project's cost.total and the global cost.total
      // but NOTHING to per-key or nested sums.
      attrs.push(
        makeAttribution({
          sessionId: `${dir}-drift`,
          directory: dir,
          tokens: { cachedRead: 0 },
          cost: Object.assign(makeDriftCost(0.20), {
            cachedReadBreakdown: null,
            subagentDispatchByAgent: null,
            toolOutputsByTool: null,
          }),
        }),
      );
    }
    const report = new ReportAssembler().assemble(attrs);

    // sessionCount === 6, 3 projects each with 2 sessions
    assert.equal(report.sessionCount, 6);
    assert.equal(Object.keys(report.byProject).length, 3);

    // Per-project assertions for every project
    for (const dir of ['/p/a', '/p/b', '/p/c']) {
      const agg = report.byProject[dir];
      assert.equal(agg.sessionCount, 2, `${dir}.sessionCount expected 2 (matched + drift)`);
      // total = matched (0.50) + drift (0.20) = 0.70
      assert.ok(
        Math.abs(agg.cost.total - 0.70) < 1e-9,
        `${dir}.cost.total expected 0.70 (matched+drift), got ${agg.cost.total}`,
      );
      // Per-key = matched ONLY (drift contributed null → skipped)
      assert.ok(
        Math.abs(agg.cost.cachedRead - 0.10) < 1e-9,
        `${dir}.cost.cachedRead expected 0.10 (matched only), got ${agg.cost.cachedRead}`,
      );
      assert.ok(
        Math.abs(agg.cost.uncachedInput - 0.15) < 1e-9,
        `${dir}.cost.uncachedInput expected 0.15 (matched only), got ${agg.cost.uncachedInput}`,
      );
      // Nested: cachedReadBreakdown.systemPromptCached = matched only (0.03)
      assert.ok(
        Math.abs(agg.cost.cachedReadBreakdown.systemPromptCached - 0.03) < 1e-9,
        `${dir}.cachedReadBreakdown.systemPromptCached expected 0.03 (matched only)`,
      );
      // byAgent / byTool — drift contributed null → only matched keys
      assert.equal(Object.keys(agg.cost.subagentDispatchByAgent).length, 1);
      assert.ok(Math.abs(agg.cost.subagentDispatchByAgent.general - 0.06) < 1e-9);
      assert.equal(Object.keys(agg.cost.toolOutputsByTool).length, 1);
      assert.ok(Math.abs(agg.cost.toolOutputsByTool.read.cached - 0.005) < 1e-9);
    }

    // Global aggregates: total = 6 × (0.50 + 0.20) / 2 — wait, that's
    // 3 × (0.50 + 0.20) = 2.10. Per-key = 3 × 0.10 = 0.30. Nested
    // cachedReadBreakdown.systemPromptCached = 3 × 0.03 = 0.09.
    // byAgent.general = 3 × 0.06 = 0.18. byTool.read.cached = 3 × 0.005 = 0.015.
    const g = report.globalTotals.cost;
    assert.ok(Math.abs(g.total - 2.10) < 1e-9, `global.cost.total expected 2.10, got ${g.total}`);
    assert.ok(Math.abs(g.cachedRead - 0.30) < 1e-9);
    assert.ok(Math.abs(g.uncachedInput - 0.45) < 1e-9);
    assert.ok(Math.abs(g.cachedReadBreakdown.systemPromptCached - 0.09) < 1e-9);
    assert.equal(Object.keys(g.subagentDispatchByAgent).length, 1);
    assert.ok(Math.abs(g.subagentDispatchByAgent.general - 0.18) < 1e-9);
    assert.equal(Object.keys(g.toolOutputsByTool).length, 1);
    assert.ok(Math.abs(g.toolOutputsByTool.read.cached - 0.015) < 1e-9);

    // Cross-cutting sum invariant: global per-key total === sum
    // across byProject entries for every per-key field, drift-skipped
    // contributions don't break the equality because they're skipped
    // identically at both levels.
    for (const k of PER_BUCKET_COST_KEYS) {
      const sumProj = Object.values(report.byProject).reduce((s, p) => s + (p.cost[k] || 0), 0);
      assert.ok(
        Math.abs(g[k] - sumProj) < 1e-9,
        `cross-cutting sum invariant: global.${k} (${g[k]}) must equal Σ byProject (${sumProj})`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});
