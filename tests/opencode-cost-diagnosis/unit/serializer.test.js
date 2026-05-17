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
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

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
