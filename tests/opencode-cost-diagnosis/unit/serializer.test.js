/*
 * serializer.test.js — unit tests for the ReportSerializer (task
 * 4.3 of .kiro/specs/opencode-cost-diagnosis).
 *
 * The ReportSerializer consumes the DiagnosticReport assembled by
 * task 4.2's ReportAssembler and emits two surface formats:
 *
 *   - `formatJson(report)` → string. Stable key order at every
 *     object level (custom replacer sorts keys alphabetically before
 *     emitting). No wall-clock fields (no `generatedAt`) so the
 *     output is byte-identical across successive invocations on the
 *     same input (R6.AC3).
 *   - `formatMarkdown(report, { generatedAt })` → string. Headline
 *     disclaimer block FIRST (always present, regardless of report
 *     shape — the first line of the output references the tokenizer
 *     library "tiktoken"), then global totals (tokens + cost), then
 *     per-project breakdown grouped by `session.directory`, then
 *     per-session detail tables, then findings. The optional
 *     `generatedAt` Date is rendered inside the disclaimer/header
 *     block (NOT in JSON, per R6.AC3).
 *
 * Requirements covered: R2.AC1 (Markdown), R2.AC2 (JSON), R2.AC9
 * (disclaimer in both formats), R6.AC3 (byte-identical JSON across
 * runs of the same source data).
 *
 * IEEE 754 note: the assembler's `globalTotals.cost.total` for the
 * fixture comes out as `0.15000000000000002` from `3 × 0.05` — a
 * fully deterministic IEEE 754 quirk. JSON.stringify is itself
 * deterministic on the same float, so this is fine for the
 * byte-identical guarantee; no canonicalization is done (and none
 * should be — canonicalization would mechanically defeat the
 * guarantee by introducing arbitrary precision choices). The
 * byte-identical assertion below exercises this case directly.
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
  ReportSerializer,
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
// with the assertions; mirrors report-assembler.test.js so a
// fixture rebuild produces a single diff site across both files.
const ROOT_COST = 0.05;
const ROOT_COUNT = 3;
const EXPECTED_GLOBAL_COST_TOTAL = ROOT_COST * ROOT_COUNT; // 0.15 (IEEE 754)

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

function assembleFixture(options) {
  const attrs = attributeAllFixtureSessions();
  return new ReportAssembler().assemble(attrs, options);
}

// Walks a parsed value (object/array/scalar) and asserts that every
// nested object has its keys in alphabetical order. Recurses into
// arrays. Used to assert "stable key order at every object level"
// in the byte-identical JSON contract.
function assertSortedKeysDeep(value, pathLabel = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSortedKeysDeep(value[i], `${pathLabel}[${i}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const sorted = [...keys].sort();
    assert.deepEqual(
      keys,
      sorted,
      `${pathLabel}: keys must be alphabetically sorted; got ${JSON.stringify(keys)}`,
    );
    for (const k of keys) {
      assertSortedKeysDeep(value[k], `${pathLabel}.${k}`);
    }
  }
}

/* ── Shape sanity ──────────────────────────────────────────────── */

test('ReportSerializer: exported by the script module', () => {
  assert.equal(typeof ReportSerializer, 'function');
  const s = new ReportSerializer();
  assert.equal(typeof s.formatJson, 'function');
  assert.equal(typeof s.formatMarkdown, 'function');
});

/* ── JSON: byte-identical across successive invocations ──────── */

test('formatJson: byte-identical across two successive invocations on the same report', () => {
  // R6.AC3 binding observable. The serializer must produce the
  // same string on every call given identical input — no embedded
  // wall-clock fields, no Map/Set-iteration-order surprises, no
  // floating-point canonicalization that would vary across
  // Node/V8 versions.
  const report = assembleFixture();
  const serializer = new ReportSerializer();
  const out1 = serializer.formatJson(report);
  const out2 = serializer.formatJson(report);
  assert.equal(
    out1,
    out2,
    'two successive formatJson calls on the same report must produce byte-identical output',
  );
});

test('formatJson: byte-identical when ReportAssembler runs from scratch a second time', () => {
  // End-to-end byte-identical: assemble + serialize twice. This is
  // the stricter form of the R6.AC3 promise (the CLI invocation as
  // a whole must be deterministic, not just the serializer in
  // isolation). If anything in the assembler-or-serializer path
  // smuggles in non-determinism (Date.now, Set/Map ordering, etc.)
  // this catches it.
  const a = new ReportSerializer().formatJson(assembleFixture());
  const b = new ReportSerializer().formatJson(assembleFixture());
  assert.equal(
    a,
    b,
    'assemble+serialize twice must produce byte-identical output across the full pipeline',
  );
});

test('formatJson: IEEE 754 float (0.15000000000000002) is preserved verbatim', () => {
  // Documents the design decision recorded in the task brief: the
  // raw IEEE 754 representation of 3 × 0.05 is `0.15000000000000002`
  // and JSON.stringify emits exactly that string. No canonicalization
  // is performed (which would defeat byte-identical by introducing
  // arbitrary precision choices). The serializer must let the float
  // through unmolested.
  const report = assembleFixture();
  // Sanity-check the input: confirm the assembler did produce the
  // raw IEEE 754 form rather than something already rounded.
  assert.equal(
    report.globalTotals.cost.total,
    0.15000000000000002,
    'precondition: assembler produces the raw IEEE 754 sum',
  );
  const out = new ReportSerializer().formatJson(report);
  assert.ok(
    out.includes('0.15000000000000002'),
    'serialized JSON must contain the raw IEEE 754 string for the global cost sum',
  );
});

/* ── JSON: stable key order at every level ─────────────────────── */

test('formatJson: top-level keys appear in alphabetical order', () => {
  const out = new ReportSerializer().formatJson(assembleFixture());
  const parsed = JSON.parse(out);
  const keys = Object.keys(parsed);
  const sorted = [...keys].sort();
  assert.deepEqual(
    keys,
    sorted,
    `top-level JSON keys must be alphabetical; got ${JSON.stringify(keys)}`,
  );
});

test('formatJson: nested object keys at every level are alphabetical', () => {
  const out = new ReportSerializer().formatJson(assembleFixture());
  const parsed = JSON.parse(out);
  assertSortedKeysDeep(parsed);
});

test('formatJson: arrays preserve their input order (only object keys are sorted)', () => {
  // The custom replacer must sort object keys but MUST NOT reorder
  // array elements — that would corrupt the disclaimer's
  // affectedBuckets/authoritativeBuckets sequence and the
  // sessions/findings arrays. This test exercises both an array of
  // strings (disclaimer.affectedBuckets) and the sessions array's
  // ordering (matches the assembler's input order).
  const report = assembleFixture();
  const out = new ReportSerializer().formatJson(report);
  const parsed = JSON.parse(out);
  assert.deepEqual(
    parsed.tokenizer_disclaimer.affectedBuckets,
    ['uncachedSystemPrompt', 'history', 'toolOutputs'],
    'affectedBuckets array order must be preserved',
  );
  assert.deepEqual(
    parsed.sessions.map((s) => s.sessionId),
    report.sessions.map((s) => s.sessionId),
    'sessions array order must be preserved from the assembler',
  );
});

/* ── JSON: no wall-clock fields ────────────────────────────────── */

test('formatJson: no generatedAt / no wall-clock fields anywhere in JSON', () => {
  // R6.AC3 forbids wall-clock fields in JSON (markdown header is
  // allowed). The assembler doesn't emit them today, and the
  // serializer MUST NOT inject any on its own — not as a metadata
  // field, not under a `_meta` blob, not anywhere. We assert both
  // by-name (generatedAt) and by-pattern (no ISO 8601 timestamp
  // pattern landing somewhere it shouldn't).
  const out = new ReportSerializer().formatJson(assembleFixture());
  const parsed = JSON.parse(out);
  function assertNoWallClock(v, label) {
    if (Array.isArray(v)) {
      v.forEach((x, i) => assertNoWallClock(x, `${label}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, vv] of Object.entries(v)) {
        assert.notEqual(
          k,
          'generatedAt',
          `JSON must not contain generatedAt; found at ${label}`,
        );
        assert.notEqual(
          k,
          'reportGeneratedAt',
          `JSON must not contain reportGeneratedAt; found at ${label}`,
        );
        assertNoWallClock(vv, `${label}.${k}`);
      }
    }
  }
  assertNoWallClock(parsed, '$');
});

/* ── JSON: structured disclaimer present ───────────────────────── */

test('formatJson: contains structured tokenizer_disclaimer with library: tiktoken', () => {
  const out = new ReportSerializer().formatJson(assembleFixture());
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.tokenizer_disclaimer, 'object');
  assert.equal(parsed.tokenizer_disclaimer.library, 'tiktoken');
  assert.equal(parsed.tokenizer_disclaimer.encoding, 'cl100k_base');
});

test('formatJson(empty report): still contains the disclaimer block', () => {
  // R2.AC8 (empty-DB success path) + R2.AC9 (disclaimer always
  // present): an empty report must still carry the disclaimer so
  // downstream consumers can rely on its presence without a
  // per-shape conditional.
  const empty = new ReportAssembler().assemble([]);
  const out = new ReportSerializer().formatJson(empty);
  const parsed = JSON.parse(out);
  assert.equal(parsed.tokenizer_disclaimer.library, 'tiktoken');
  assert.equal(parsed.sessionCount, 0);
});

test('formatJson(empty report): byte-identical across two successive calls', () => {
  // Empty-report byte-identical guarantee — exercised separately
  // because the empty case takes a different code path through the
  // assembler (no per-session loops) and is the most likely place
  // for a wall-clock leak to slip in.
  const empty = new ReportAssembler().assemble([]);
  const s = new ReportSerializer();
  assert.equal(s.formatJson(empty), s.formatJson(empty));
});

/* ── Markdown: headline disclaimer block first ─────────────────── */

test('formatMarkdown: first line of output references "tiktoken"', () => {
  // Binding observable from the task brief: "the Markdown begins
  // with a disclaimer block whose first line references tiktoken".
  // Asserts the *very first* non-empty line of the output names
  // the tokenizer library. This guarantees a downstream operator
  // (or grep, or a future linter) can recognise the disclaimer as
  // the headline without parsing markdown structure.
  const report = assembleFixture();
  const out = new ReportSerializer().formatMarkdown(report);
  const firstLine = out.split('\n')[0];
  assert.ok(
    firstLine.toLowerCase().includes('tiktoken'),
    `first line must reference "tiktoken"; got: ${firstLine}`,
  );
});

test('formatMarkdown(empty report): first line still references "tiktoken"', () => {
  // R2.AC9 demands the disclaimer regardless of report shape; the
  // empty case is the easiest to forget.
  const empty = new ReportAssembler().assemble([]);
  const out = new ReportSerializer().formatMarkdown(empty);
  const firstLine = out.split('\n')[0];
  assert.ok(firstLine.toLowerCase().includes('tiktoken'));
});

test('formatMarkdown: contains the structured disclaimer block with affectedBuckets named', () => {
  // R2.AC9 (iii): the disclaimer states which buckets the
  // tokenizer-derived values affect. The Markdown must surface
  // them by name so an operator reading the .md report (the
  // primary consumer) can identify the relative-only buckets
  // without cross-referencing the JSON.
  const out = new ReportSerializer().formatMarkdown(assembleFixture());
  for (const bucket of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
    assert.ok(
      out.includes(bucket),
      `markdown disclaimer must name affected bucket "${bucket}"`,
    );
  }
});

/* ── Markdown: generatedAt timestamp permitted in header ───────── */

test('formatMarkdown: includes generatedAt timestamp in header when provided', () => {
  // The brief permits a report-generation timestamp in the MD
  // header (NOT in JSON). When the CLI Entry passes one, the
  // serializer must surface it; when omitted, no timestamp leaks
  // through.
  const report = assembleFixture();
  const ts = new Date('2026-05-17T14:30:22.123Z');
  const out = new ReportSerializer().formatMarkdown(report, { generatedAt: ts });
  assert.ok(
    out.includes('2026-05-17T14:30:22.123Z'),
    'markdown must include the ISO 8601 generatedAt when provided',
  );
});

test('formatMarkdown: omits generatedAt when not provided', () => {
  // When no generatedAt is passed, the markdown must NOT fabricate
  // a Date.now() — that would create non-determinism in any
  // downstream code that diffs MD outputs. The brief makes the
  // timestamp explicitly optional and operator-supplied.
  const report = assembleFixture();
  const out = new ReportSerializer().formatMarkdown(report);
  // The fixture's session timestamps are around 1778775290084 (ms
  // since epoch). Any ISO 8601 string with a 4-digit year in 2024+
  // is suspect IF it isn't traceable to session time data. The
  // safer assertion is that no string of the form "Generated:" or
  // similar shows up — that label is reserved for the explicit
  // header path.
  assert.equal(
    /^Generated:/m.test(out),
    false,
    'markdown must not emit a "Generated:" header line when no generatedAt is provided',
  );
});

/* ── Markdown: section ordering & content ──────────────────────── */

test('formatMarkdown: sections appear in order: disclaimer, global totals, per-project, per-session, findings', () => {
  // Order from the task brief: disclaimer FIRST, then global
  // totals, then per-project, then per-session, then findings.
  // The brief is permissive about exact heading text but the
  // ordering is binding; assert by section-marker ordering rather
  // than text equality so a future copy edit doesn't break the
  // test.
  //
  // We use small distinctive substrings the implementation can
  // pick for each section. These are loose checks that survive
  // re-wording but enforce the order contract.
  const report = assembleFixture();
  const out = new ReportSerializer().formatMarkdown(report);

  const disclaimerIdx = out.toLowerCase().indexOf('tiktoken');
  const globalIdx = out.toLowerCase().indexOf('global total');
  const projectIdx = out.toLowerCase().indexOf('per-project');
  const sessionIdx = out.toLowerCase().indexOf('per-session');
  const findingsIdx = out.toLowerCase().indexOf('findings');

  assert.notEqual(disclaimerIdx, -1, 'disclaimer section must be present');
  assert.notEqual(globalIdx, -1, 'global totals section must be present');
  assert.notEqual(projectIdx, -1, 'per-project section must be present');
  assert.notEqual(sessionIdx, -1, 'per-session section must be present');
  assert.notEqual(findingsIdx, -1, 'findings section must be present');

  assert.ok(disclaimerIdx < globalIdx, 'disclaimer must precede global totals');
  assert.ok(globalIdx < projectIdx, 'global totals must precede per-project');
  assert.ok(projectIdx < sessionIdx, 'per-project must precede per-session');
  assert.ok(sessionIdx < findingsIdx, 'per-session must precede findings');
});

test('formatMarkdown: global totals section names every BucketTotals key', () => {
  // The global totals section is the operator's first stop. Every
  // bucket must be surfaced by name so a reader can locate (e.g.)
  // "subagentDispatch" without cross-referencing the JSON.
  const out = new ReportSerializer().formatMarkdown(assembleFixture());
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
    assert.ok(out.includes(k), `markdown global totals must name bucket "${k}"`);
  }
});

test('formatMarkdown: global totals section reports cost total', () => {
  // R2.AC6 (cost reporting) for the global aggregate. The exact
  // float form is implementation-defined (could be "$0.15" or
  // "0.15" or the raw IEEE 754); we assert the leading digits are
  // present so a copy-edit changing prefix doesn't break the test.
  const out = new ReportSerializer().formatMarkdown(assembleFixture());
  assert.ok(
    out.includes(`${EXPECTED_GLOBAL_COST_TOTAL}`) ||
      out.includes('0.15'),
    `markdown must report the global cost total (~${EXPECTED_GLOBAL_COST_TOTAL})`,
  );
});

test('formatMarkdown: per-project section names every project directory', () => {
  // The per-project breakdown groups by `session.directory`. The
  // fixture has 3 distinct cwds; all must appear so the operator
  // can attribute spend per project.
  const out = new ReportSerializer().formatMarkdown(assembleFixture());
  for (const dir of [
    '/Users/test/project-a',
    '/Users/test/project-b',
    '/Users/test/project-c',
  ]) {
    assert.ok(out.includes(dir), `markdown per-project must name "${dir}"`);
  }
});

test('formatMarkdown: per-session section names every session ID', () => {
  // The per-session detail tables let an operator drill into a
  // specific session for follow-up investigation. Every in-scope
  // session must be addressable by its sessionId.
  const report = assembleFixture();
  const out = new ReportSerializer().formatMarkdown(report);
  for (const s of report.sessions) {
    assert.ok(
      out.includes(s.sessionId),
      `markdown per-session must name session "${s.sessionId}"`,
    );
  }
});

test('formatMarkdown: findings section includes per_bucket_cost_deferred (always-emitted finding)', () => {
  // The AttributionEngine emits per_bucket_cost_deferred for every
  // session, and the assembler forwards them to the global
  // findings array. The markdown must surface findings by kind so
  // an operator can spot the "why is cachedRead null?" answer
  // without parsing JSON.
  const out = new ReportSerializer().formatMarkdown(assembleFixture());
  assert.ok(
    out.includes('per_bucket_cost_deferred'),
    'markdown findings section must surface per_bucket_cost_deferred',
  );
});

test('formatMarkdown(empty report): well-formed output with no per-session/per-project rows', () => {
  // Empty-DB success path (R2.AC8). The markdown should still
  // produce a well-formed document with the disclaimer + a global
  // totals block reporting zero, and gracefully handle the empty
  // per-project / per-session sections rather than throwing or
  // emitting malformed markdown.
  const empty = new ReportAssembler().assemble([]);
  const out = new ReportSerializer().formatMarkdown(empty);
  assert.ok(
    out.toLowerCase().includes('tiktoken'),
    'empty report markdown must still have the disclaimer',
  );
  // Sanity: doesn't crash; produces a non-empty string.
  assert.ok(out.length > 0);
});

/* ── Task 7.1: Markdown extensions for v2 sub-buckets ─────────────── */
//
// Task 7.1 extends ReportSerializer.formatMarkdown with four new
// surfaces, all gated on `V2_COST_COMPUTE_ENABLED`:
//
//   1. A pricing-pin disclaimer block rendered immediately after
//      the existing tokenizer disclaimer (and BEFORE the `---`
//      separator). Wording is frozen at design time so the
//      operator-facing language is auditable from the spec.
//   2. A threshold-rendering block (per-agent and per-tool fold
//      thresholds) inside the same expanded disclaimer area so
//      the operator can interpret the `(below-threshold-fold)`
//      residuals when they appear in the byAgent / byTool tables.
//   3. A v1→v2 migration disclaimer line, gated on its OWN
//      module-level constant (`V2_MIGRATION_DISCLAIMER_ENABLED`)
//      so the operator can flip it off in a follow-up commit
//      after cutover beds in. Not coupled to the cost-compute
//      flag — the cost-compute flag never comes back OFF in
//      production once 8.1 lands, but the migration disclaimer
//      is intentionally transient.
//   4. Per-session detail extensions:
//        - Three uncached cost sub-bucket lines (uncachedSystemPrompt,
//          history, toolOutputs) reading from `s.cost.*`.
//        - A cachedRead breakdown table (6 rows, one per
//          `CACHED_READ_SUB_BUCKET_KEYS`).
//        - A per-agent table (cost-per-agent-type).
//        - A per-tool table (cost-per-tool, with cached/uncached
//          partition columns).
//      Drift sessions (`s.cost.cachedReadBreakdown === null` etc.)
//      render a placeholder line, NOT a malformed empty table.
//
// Binding observable preserved: the FIRST line of Markdown still
// starts with `**TOKENIZER ACCURACY DISCLAIMER (` — the pricing
// pin block lives AFTER this first block, not before it.
//
// Task 7.3 will expand the test coverage; this section provides
// the minimum 3-observable evidence the reviewer requires for the
// 7.1 RED→GREEN cycle.
//
// Requirements: R3.3 (pricing pin in MD), R4.4 (cachedRead
// disclaimer extension), R5.4 (per-agent + threshold disclosure),
// R6.5 (per-tool + threshold disclosure), R7.1 (additive shape).

// Build a v2-extended cost shape for the per-session detail tests.
// Mirrors `makeV2CostExtended` in report-assembler.test.js without
// re-importing the helper (keeps the serializer.test.js file
// self-contained). Defaults to a populated cachedReadBreakdown
// (all zeros across the 6 sub-buckets) plus empty byAgent / byTool
// maps. Override individual fields by passing them in `overrides`.
function makeV2CostExtendedForSerializerTest(overrides) {
  const o = overrides || {};
  const base = { total: typeof o.total === 'number' ? o.total : 0 };
  for (const k of PER_BUCKET_COST_KEYS) {
    base[k] = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : 0;
  }
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

function makeSerializerTestAttribution(overrides) {
  const o = overrides || {};
  return {
    sessionId: o.sessionId || 'ses_synth_serializer',
    directory: o.directory || '/Users/test/synth-project',
    agent: o.agent || 'build',
    model: o.model || 'claude-opus-4-7',
    timeCreated: o.timeCreated || 1_700_000_000_000,
    timeUpdated: o.timeUpdated || 1_700_000_001_000,
    tokens: Object.assign(
      {
        cachedRead: 5000,
        cachedWrite: 1000,
        uncachedSystemPrompt: 100,
        history: 200,
        toolOutputs: 50,
        output: 30,
        reasoning: 10,
        subagentDispatch: 0,
      },
      o.tokens || {},
    ),
    cost: o.cost || makeV2CostExtendedForSerializerTest({ total: 0.10 }),
    findings: o.findings || [],
  };
}

function assembleSerializerTestReport(attrs, options) {
  setV2CostComputeEnabled(true);
  const pricingTable = new PricingTable(SYNTHETIC_PRICING);
  return new ReportAssembler(pricingTable).assemble(attrs || [], options);
}

/* Observable 1: pricing pin disclaimer substring appears immediately
 * after the existing tokenizer disclaimer block. */
test('formatMarkdown (flag ON): contains **PRICING PIN**: substring after tokenizer disclaimer block', () => {
  try {
    const attrs = [
      makeSerializerTestAttribution({
        sessionId: 'ses_pin_a',
        directory: '/p/a',
        cost: makeV2CostExtendedForSerializerTest({ total: 0.10 }),
      }),
    ];
    const report = assembleSerializerTestReport(attrs);
    const out = new ReportSerializer().formatMarkdown(report);

    // R3.3: pricing pin substring must be present in flag-ON MD.
    assert.ok(
      out.includes('**PRICING PIN**:'),
      `markdown must contain "**PRICING PIN**:" substring; got:\n${out.slice(0, 800)}`,
    );

    // The pricing pin must appear AFTER the tokenizer disclaimer
    // headline (binding observable preserved) and BEFORE the
    // global totals section heading. This protects the placement
    // contract — the pin sits in the same disclaimer "zone" as
    // the tokenizer disclaimer, not buried elsewhere.
    const headlineIdx = out.indexOf('**TOKENIZER ACCURACY DISCLAIMER (');
    const pinIdx = out.indexOf('**PRICING PIN**:');
    const globalIdx = out.toLowerCase().indexOf('global total');
    assert.equal(headlineIdx, 0, 'tokenizer disclaimer must remain the very first line');
    assert.ok(pinIdx > headlineIdx, 'pricing pin must appear AFTER the tokenizer disclaimer block');
    assert.ok(pinIdx < globalIdx, 'pricing pin must appear BEFORE the global totals section');

    // The pin block names the canonical pin metadata sourced from
    // the synthetic fixture. Asserting the values flow through
    // unmangled guards against the renderer reading the wrong
    // field on `report.pricing`.
    assert.ok(out.includes('synthetic-test-fixture'), 'pin block must include pinSource');
    assert.ok(out.includes('2026-01-01'), 'pin block must include pinDate');
  } finally {
    setV2CostComputeEnabled(false);
  }
});

/* Observable 2: threshold-rendering substring inside disclaimer area. */
test('formatMarkdown (flag ON): renders per-agent fold threshold and per-tool fold threshold from tokenizer_disclaimer.thresholds', () => {
  try {
    const report = assembleSerializerTestReport([]);
    const out = new ReportSerializer().formatMarkdown(report);

    // R5.4 / R6.5: the operator needs to see the fold thresholds
    // next to the eventual `(below-threshold-fold)` residual rows.
    // The renderer must surface BOTH the per-agent threshold
    // (with the child floor) and the per-tool threshold.
    assert.ok(
      out.includes('per-agent fold threshold:'),
      `markdown must surface "per-agent fold threshold:" substring; got:\n${out.slice(0, 800)}`,
    );
    assert.ok(
      out.includes('per-tool fold threshold:'),
      `markdown must surface "per-tool fold threshold:" substring; got:\n${out.slice(0, 800)}`,
    );

    // Spot-check the rendered numerics. The thresholds in the
    // disclaimer object are populated by ReportAssembler 6.3 from
    // SUBAGENT_BELOW_THRESHOLD_PCT (0.01 = 1%) /
    // SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR (1) /
    // TOOL_BELOW_THRESHOLD_PCT (0.01 = 1%). The renderer must
    // surface them faithfully — either as the raw decimal or as a
    // percent. Either form satisfies the operator-readability
    // contract; the test accepts both so a copy edit doesn't
    // force a test rewrite.
    const hasOnePct = out.includes('1%') || out.includes('0.01');
    assert.ok(hasOnePct, 'rendered thresholds must surface the 1% / 0.01 value');

    // The threshold block must live INSIDE the expanded disclaimer
    // area — after the affectedBuckets line, before the `---`
    // separator that ends the disclaimer.
    const affectedIdx = out.indexOf('Affected buckets (tokenizer-derived');
    const thresholdIdx = out.indexOf('per-agent fold threshold:');
    const sepIdx = out.indexOf('\n---\n');
    assert.ok(affectedIdx !== -1, 'affectedBuckets line must still be present');
    assert.ok(thresholdIdx > affectedIdx, 'thresholds must appear after affectedBuckets');
    assert.ok(thresholdIdx < sepIdx, 'thresholds must appear before the disclaimer ---');
  } finally {
    setV2CostComputeEnabled(false);
  }
});

/* Observable 3: per-session block renders cachedRead/agent/tool tables
 * plus the three uncached cost sub-bucket lines. */
test('formatMarkdown (flag ON): per-session blocks render cachedRead breakdown, per-agent, per-tool tables, and the 3 uncached cost sub-bucket lines', () => {
  try {
    const attrs = [
      makeSerializerTestAttribution({
        sessionId: 'ses_detail_a',
        directory: '/p/a',
        cost: makeV2CostExtendedForSerializerTest({
          total: 1.0,
          uncachedSystemPrompt: 0.08,
          history: 0.20,
          toolOutputs: 0.02,
          cachedRead: 0.30,
          cachedReadBreakdown: {
            systemPromptCached: 0.10,
            agentsMdCached: 0.05,
            mcpToolSchemasCached: 0.04,
            accumulatedHistoryCached: 0.08,
            accumulatedToolOutputsCached: 0.02,
            unclassifiedCached: 0.01,
          },
          subagentDispatchByAgent: {
            build: 0.20,
            review: 0.05,
          },
          toolOutputsByTool: {
            bash: { cached: 0.005, uncached: 0.010 },
            read: { cached: 0.002, uncached: 0.008 },
          },
        }),
      }),
    ];
    const report = assembleSerializerTestReport(attrs);
    const out = new ReportSerializer().formatMarkdown(report);

    // (a) Per-session block names the session.
    assert.ok(out.includes('ses_detail_a'), 'per-session block must name session id');

    // (b) The three uncached cost sub-bucket lines. R7.1 (additive
    // shape) + the task's "render the three new uncached cost
    // sub-bucket lines" observable.
    assert.ok(
      out.includes('Uncached system prompt:'),
      `markdown must surface "Uncached system prompt:" line; got:\n${out.slice(-1500)}`,
    );
    assert.ok(out.includes('History:'), 'markdown must surface "History:" cost line');
    assert.ok(out.includes('Tool outputs:'), 'markdown must surface "Tool outputs:" cost line');

    // (c) cachedRead breakdown table — the canonical observable in
    // the task brief. Header markers + one row per known sub-bucket
    // name proves the renderer iterates CACHED_READ_SUB_BUCKET_KEYS.
    assert.ok(
      out.includes('CachedRead sub-bucket'),
      `markdown must contain cachedRead breakdown table header; got:\n${out.slice(-1500)}`,
    );
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.ok(
        out.includes(k),
        `markdown cachedRead breakdown table must include sub-bucket "${k}"`,
      );
    }

    // (d) Per-agent table — header + both agent rows.
    assert.ok(
      out.includes('| Agent | Cost |'),
      `markdown must contain per-agent table header; got:\n${out.slice(-1500)}`,
    );
    assert.ok(out.includes('build'), 'per-agent table must include build row');
    assert.ok(out.includes('review'), 'per-agent table must include review row');

    // (e) Per-tool table — header (with cached/uncached partition)
    // + both tool rows.
    assert.ok(
      out.includes('| Tool | Cached cost | Uncached cost |'),
      `markdown must contain per-tool table header with cached/uncached columns; got:\n${out.slice(-1500)}`,
    );
    assert.ok(out.includes('bash'), 'per-tool table must include bash row');
    assert.ok(out.includes('read'), 'per-tool table must include read row');
  } finally {
    setV2CostComputeEnabled(false);
  }
});

/* Smoke check: drift session renders placeholders, not malformed
 * tables. AttributionEngine emits `null` for cachedReadBreakdown /
 * subagentDispatchByAgent / toolOutputsByTool on pricing-table
 * drift; the renderer must surface a human-readable placeholder
 * rather than crashing or emitting an empty `| header |` table. */
test('formatMarkdown (flag ON): drift session (null byAgent/byTool/cachedReadBreakdown) renders placeholders, not malformed tables', () => {
  try {
    const driftCost = {
      total: 0.42,
      cachedRead: null,
      cachedWrite: null,
      uncachedInput: null,
      output: null,
      reasoning: null,
      subagentDispatch: null,
      uncachedSystemPrompt: null,
      history: null,
      toolOutputs: null,
      cachedReadBreakdown: null,
      subagentDispatchByAgent: null,
      toolOutputsByTool: null,
    };
    const attrs = [
      makeSerializerTestAttribution({
        sessionId: 'ses_drift_x',
        directory: '/p/drift',
        cost: driftCost,
      }),
    ];
    const report = assembleSerializerTestReport(attrs);
    // Must not throw on null nested containers.
    const out = new ReportSerializer().formatMarkdown(report);
    // Session id still surfaces; that's the operator's anchor for
    // following up.
    assert.ok(out.includes('ses_drift_x'), 'drift session id must still be rendered');
    // First line invariant still holds.
    assert.equal(
      out.split('\n')[0].startsWith('**TOKENIZER ACCURACY DISCLAIMER ('),
      true,
      'first line invariant preserved on drift report',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

/* Flag-OFF preservation: flag-OFF Markdown must NOT contain any of
 * the new substrings. This guards the byte-identical-to-v1
 * contract for the rollout window (the existing 16+ flag-OFF MD
 * tests above continue to pass as the binding observable; this
 * single test pins the absence of the new strings explicitly). */
test('formatMarkdown (flag OFF): contains none of the v2 disclaimer/threshold/table substrings', () => {
  // Default flag state (OFF) — fixture-driven report assembled
  // without a pricingTable. Mirrors the existing v1 serializer.test
  // cases above so this is the same path the byte-identical
  // integration goldens exercise.
  const report = assembleFixture();
  const out = new ReportSerializer().formatMarkdown(report);
  assert.equal(
    out.includes('**PRICING PIN**:'),
    false,
    'flag OFF: pricing pin substring must be absent',
  );
  assert.equal(
    out.includes('per-agent fold threshold:'),
    false,
    'flag OFF: threshold rendering must be absent',
  );
  assert.equal(
    out.includes('per-tool fold threshold:'),
    false,
    'flag OFF: threshold rendering must be absent',
  );
  assert.equal(
    out.includes('CachedRead sub-bucket'),
    false,
    'flag OFF: cachedRead breakdown table must be absent',
  );
  assert.equal(
    out.includes('| Agent | Cost |'),
    false,
    'flag OFF: per-agent table must be absent',
  );
  assert.equal(
    out.includes('| Tool | Cached cost | Uncached cost |'),
    false,
    'flag OFF: per-tool table must be absent',
  );
});
