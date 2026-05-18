/*
 * null-cost-shape.test.js — unit tests for the v2 `makeNullCostShape()`
 * helper and its supporting module-level constants (task 1.5 of
 * .kiro/specs/v2-diagnosis).
 *
 * The helper is the single source of truth for the v2 "pricing
 * drift" fallback cost shape: every cost-bearing field is `null` —
 * the six v1 fields (`cachedRead`, `cachedWrite`, `uncachedInput`,
 * `output`, `reasoning`, `subagentDispatch`), the three new v2
 * uncached sub-bucket fields (`uncachedSystemPrompt`, `history`,
 * `toolOutputs`), every key in `cachedReadBreakdown`, and the entire
 * `subagentDispatchByAgent` and `toolOutputsByTool` maps. The sole
 * exception is `cost.total`, which continues to carry `session.cost`
 * — the helper takes that value as an optional argument.
 *
 * See design.md § AttributionEngine `makeNullCostShape()` paragraph
 * (lines 581-583, 648) and the `CostBuckets` interface
 * (lines 597-622). Requirements 2.1, 3.4, 5.4, 6.5, 7.5.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const {
  makeNullCostShape,
  PER_BUCKET_COST_KEYS,
  CACHED_READ_SUB_BUCKET_KEYS,
} = mod;

// The 6 cachedRead sub-bucket keys named in design.md:612-618 and
// the task brief. Hard-coded here so a constant rename in the source
// produces a single-site test failure rather than a silent drift.
const EXPECTED_CACHED_READ_SUB_BUCKETS = [
  'systemPromptCached',
  'agentsMdCached',
  'mcpToolSchemasCached',
  'accumulatedHistoryCached',
  'accumulatedToolOutputsCached',
  'unclassifiedCached',
];

// The 9 per-bucket cost keys: the six v1 fields verbatim plus the
// three new v2 uncached sub-buckets appended (design.md:599-611).
const EXPECTED_PER_BUCKET_COST_KEYS = [
  'cachedRead',
  'cachedWrite',
  'uncachedInput',
  'output',
  'reasoning',
  'subagentDispatch',
  'uncachedSystemPrompt',
  'history',
  'toolOutputs',
];

test('PER_BUCKET_COST_KEYS extends v1 with three new uncached sub-bucket keys', () => {
  assert.deepEqual(
    Array.from(PER_BUCKET_COST_KEYS),
    EXPECTED_PER_BUCKET_COST_KEYS,
    'PER_BUCKET_COST_KEYS must be the six v1 fields verbatim followed ' +
      'by uncachedSystemPrompt, history, toolOutputs (in that order)',
  );
});

test('PER_BUCKET_COST_KEYS is frozen (immutable export)', () => {
  assert.equal(Object.isFrozen(PER_BUCKET_COST_KEYS), true);
});

test('CACHED_READ_SUB_BUCKET_KEYS lists the six named sub-buckets including unclassifiedCached', () => {
  assert.deepEqual(
    Array.from(CACHED_READ_SUB_BUCKET_KEYS),
    EXPECTED_CACHED_READ_SUB_BUCKETS,
  );
});

test('CACHED_READ_SUB_BUCKET_KEYS is frozen (immutable export)', () => {
  assert.equal(Object.isFrozen(CACHED_READ_SUB_BUCKET_KEYS), true);
});

test('makeNullCostShape is exported as a function', () => {
  assert.equal(typeof makeNullCostShape, 'function');
});

test('makeNullCostShape() default-arg returns total=0 and every other field null', () => {
  const shape = makeNullCostShape();

  assert.equal(shape.total, 0, 'default sessionCost is 0');

  for (const key of EXPECTED_PER_BUCKET_COST_KEYS) {
    assert.equal(
      shape[key],
      null,
      `per-bucket cost field ${key} must be null on the drift fallback`,
    );
  }

  assert.ok(
    shape.cachedReadBreakdown !== null &&
      typeof shape.cachedReadBreakdown === 'object',
    'cachedReadBreakdown must be an object (not null) — its KEYS are null',
  );
  for (const key of EXPECTED_CACHED_READ_SUB_BUCKETS) {
    assert.equal(
      shape.cachedReadBreakdown[key],
      null,
      `cachedReadBreakdown.${key} must be null on the drift fallback`,
    );
  }

  assert.equal(
    shape.subagentDispatchByAgent,
    null,
    'subagentDispatchByAgent map is null on drift (the entire map, not its entries)',
  );
  assert.equal(
    shape.toolOutputsByTool,
    null,
    'toolOutputsByTool map is null on drift (the entire map, not its entries)',
  );
});

test('makeNullCostShape(sessionCost) preserves total verbatim from caller-supplied session.cost', () => {
  // Design.md AttributionEngine paragraph: "cost.total, which
  // continues to carry session.cost." The helper accepts the
  // session cost as its argument so the caller has one allocation
  // site rather than two-step assignment.
  const shape = makeNullCostShape(0.1234);
  assert.equal(shape.total, 0.1234);

  // Other fields still null even when total is non-zero.
  for (const key of EXPECTED_PER_BUCKET_COST_KEYS) {
    assert.equal(shape[key], null);
  }
});

test('makeNullCostShape() returns a fresh object each call (no shared mutable state)', () => {
  // The helper is used per-session on drift; a shared reference
  // would let one session's assignment leak into another.
  const a = makeNullCostShape(1);
  const b = makeNullCostShape(2);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.cachedReadBreakdown, b.cachedReadBreakdown);
  assert.equal(a.total, 1);
  assert.equal(b.total, 2);
});

test('makeNullCostShape() returned shape has exactly the documented keys (no extras, no gaps)', () => {
  const shape = makeNullCostShape();
  const expected = new Set([
    'total',
    ...EXPECTED_PER_BUCKET_COST_KEYS,
    'cachedReadBreakdown',
    'subagentDispatchByAgent',
    'toolOutputsByTool',
  ]);
  const actual = new Set(Object.keys(shape));
  assert.deepEqual(
    actual,
    expected,
    'makeNullCostShape() top-level keys must match the CostBuckets ' +
      'interface (design.md:597-622) exactly: total + 9 per-bucket ' +
      'cost keys + cachedReadBreakdown + subagentDispatchByAgent + ' +
      'toolOutputsByTool',
  );

  const cachedReadKeys = new Set(Object.keys(shape.cachedReadBreakdown));
  assert.deepEqual(
    cachedReadKeys,
    new Set(EXPECTED_CACHED_READ_SUB_BUCKETS),
    'cachedReadBreakdown keys must match CACHED_READ_SUB_BUCKET_KEYS exactly',
  );
});
