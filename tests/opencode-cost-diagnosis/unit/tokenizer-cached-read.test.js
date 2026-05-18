/*
 * tokenizer-cached-read.test.js — unit tests for the cachedRead
 * sub-bucket classifier extension to TokenizerSplitter
 * (task 3.1 of .kiro/specs/v2-diagnosis).
 *
 * Acceptance: requirements.md 4.1 (named sub-buckets, at minimum
 * the five named ones) + 4.5 (residual handling); design.md
 * TokenizerSplitter (extended) (lines 454-514); design.md Decision 6
 * (markersDegraded fallback per Strategy A unreliability).
 *
 * The extension adds, in parallel to the existing v1 four-bucket
 * uncached split:
 *
 *   - `cachedReadBreakdown`: a six-key object covering the five
 *     named cachedRead sub-buckets (systemPromptCached, agentsMdCached,
 *     mcpToolSchemasCached, accumulatedHistoryCached,
 *     accumulatedToolOutputsCached) plus the `unclassifiedCached`
 *     residual. All six keys ALWAYS present; each a non-negative
 *     integer.
 *
 *   - `markersDegraded`: boolean signal indicating whether one or
 *     more classifier markers from task 1.5 is the unreliable
 *     sentinel. Computed STATICALLY from the marker map (NOT
 *     data-dependent), so an empty parts list still reports the
 *     correct degraded state for the bundled production constants.
 *
 *   - `failedMarkers`: ReadonlyArray<string> naming each marker
 *     that resolved to the unreliable sentinel. Empty when every
 *     marker is by-structure; the cardinality matches the count of
 *     unreliable markers in the constructor's `markers` map.
 *
 * Per task 1.1's finding (encoded in the bundled production
 * constants in scripts/opencode-cost-report.js:1817-1824), three of
 * the five markers (systemPrompt, agentsMd, mcpToolSchemas) are
 * unreliable in the shipped configuration; the other two
 * (accumulatedHistory, accumulatedToolOutputs) are structural and
 * always reliable. So the default-markers path is always
 * `markersDegraded: true` for production sessions, and downstream
 * (task 5.7) consumes the signal to fall back to the
 * proportional-from-uncached degraded path.
 *
 * The constructor accepts an OPTIONAL `markers` parameter so unit
 * tests can exercise the happy path (all markers by-structure) and
 * the all-broken path (all markers unreliable) without touching the
 * module-level production constants. Production wiring continues to
 * call `new TokenizerSplitter()` with zero args.
 *
 * The v1 return shape — { systemPrompt, history, toolOutput,
 * unclassifiedCount } — MUST remain intact under every test in this
 * file. tokenizer.test.js's existing assertions on that shape stay
 * green; this file's assertions are purely additive.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  TokenizerSplitter,
  MARKER_BY_STRUCTURE,
  MARKER_UNRELIABLE_SENTINEL,
  CACHED_READ_SUB_BUCKET_KEYS,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

// Mixed-role fixture used by every test below. One system text part
// + one user text part + one assistant text part + one tool part
// with state.output. Tokens-positive on every part so any
// misbucketing or under-counting is detectable.
function makeMixedFixture() {
  const messages = new Map([
    ['m_sys', { id: 'm_sys', role: 'system' }],
    ['m_usr', { id: 'm_usr', role: 'user' }],
    ['m_ast', { id: 'm_ast', role: 'assistant' }],
  ]);
  const parts = [
    {
      message_id: 'm_sys',
      type: 'text',
      data: JSON.stringify({
        text: 'You are a helpful assistant. AGENTS.md content here.',
      }),
    },
    {
      message_id: 'm_usr',
      type: 'text',
      data: JSON.stringify({ text: 'Please answer the question concisely.' }),
    },
    {
      message_id: 'm_ast',
      type: 'text',
      data: JSON.stringify({
        text: 'Sure, here is the answer with several extra words.',
      }),
    },
    {
      message_id: 'm_ast',
      type: 'tool',
      data: JSON.stringify({
        tool: 'bash',
        state: { status: 'completed', output: 'tool output body text' },
      }),
    },
  ];
  return { parts, messages };
}

// Helper: assert the full cachedReadBreakdown shape contract — all
// six keys present, each a non-negative integer. Reused in every
// test below so a future schema change surfaces consistently.
function assertCachedReadBreakdownShape(breakdown) {
  assert.ok(
    breakdown && typeof breakdown === 'object',
    'cachedReadBreakdown must be an object',
  );
  for (const key of CACHED_READ_SUB_BUCKET_KEYS) {
    assert.equal(
      typeof breakdown[key],
      'number',
      `cachedReadBreakdown.${key} must be a number`,
    );
    assert.ok(
      Number.isInteger(breakdown[key]) && breakdown[key] >= 0,
      `cachedReadBreakdown.${key} must be a non-negative integer`,
    );
  }
  // No extra keys: every key in the breakdown is in the canonical set
  for (const key of Object.keys(breakdown)) {
    assert.ok(
      CACHED_READ_SUB_BUCKET_KEYS.includes(key),
      `cachedReadBreakdown has unexpected key: ${key}`,
    );
  }
}

test('TokenizerSplitter (cachedRead): v1 return shape is preserved (backward-compat)', () => {
  // Hard contract: AttributionEngine's existing Flow 2 consumes
  // { systemPrompt, history, toolOutput, unclassifiedCount }. Those
  // four keys MUST remain on the classifyAndCount return object
  // even after the v2 additions. New keys are additive only.
  const { parts, messages } = makeMixedFixture();
  const t = new TokenizerSplitter();
  const result = t.classifyAndCount(parts, messages);

  assert.equal(typeof result.systemPrompt, 'number');
  assert.equal(typeof result.history, 'number');
  assert.equal(typeof result.toolOutput, 'number');
  assert.equal(typeof result.unclassifiedCount, 'number');
  assert.ok(result.systemPrompt > 0, 'v1 systemPrompt accumulates system-role text');
  assert.ok(result.history > 0, 'v1 history accumulates user+assistant text');
  assert.ok(result.toolOutput > 0, 'v1 toolOutput accumulates tool state.output');
  assert.equal(result.unclassifiedCount, 0, 'no unknown part types in fixture');
});

test('TokenizerSplitter (cachedRead): default constructor markers yield markersDegraded=true (bundled production state)', () => {
  // The bundled production constants set systemPrompt, agentsMd,
  // and mcpToolSchemas markers to MARKER_UNRELIABLE_SENTINEL
  // (task 1.1's finding, encoded in opencode-cost-report.js:1820-1824).
  // The classifier MUST surface this state via markersDegraded=true
  // and failedMarkers naming all three.
  const { parts, messages } = makeMixedFixture();
  const t = new TokenizerSplitter();
  const result = t.classifyAndCount(parts, messages);

  assert.equal(
    result.markersDegraded,
    true,
    'default markers include 3 unreliable sentinels; markersDegraded must be true',
  );
  assert.ok(
    Array.isArray(result.failedMarkers),
    'failedMarkers must be an array',
  );
  assert.equal(
    result.failedMarkers.length,
    3,
    'failedMarkers must name exactly the 3 unreliable system-role markers',
  );
  for (const name of ['systemPrompt', 'agentsMd', 'mcpToolSchemas']) {
    assert.ok(
      result.failedMarkers.includes(name),
      `failedMarkers must include ${name}`,
    );
  }
  // Structural markers must NOT appear in failedMarkers — they are
  // reliable by role/type dispatch.
  for (const name of ['accumulatedHistory', 'accumulatedToolOutputs']) {
    assert.ok(
      !result.failedMarkers.includes(name),
      `failedMarkers must NOT include the structural marker ${name}`,
    );
  }
});

test('TokenizerSplitter (cachedRead): default markers route system-role parts into unclassifiedCached, structural parts to their named buckets', () => {
  // Per task 3.1 acceptance criterion 4: when a marker is
  // MARKER_UNRELIABLE_SENTINEL the part falls into unclassifiedCached
  // (NOT into the marker's nominal sub-bucket). The 3 system-role
  // markers are unreliable in the default configuration → system-role
  // text accumulates into unclassifiedCached. The 2 structural
  // markers are reliable → history and tool parts populate their
  // named sub-buckets.
  const { parts, messages } = makeMixedFixture();
  const t = new TokenizerSplitter();
  const result = t.classifyAndCount(parts, messages);

  assertCachedReadBreakdownShape(result.cachedReadBreakdown);
  const breakdown = result.cachedReadBreakdown;

  // Unreliable markers → nominal buckets all 0
  assert.equal(breakdown.systemPromptCached, 0);
  assert.equal(breakdown.agentsMdCached, 0);
  assert.equal(breakdown.mcpToolSchemasCached, 0);

  // Structural markers → user+assistant text in accumulatedHistoryCached,
  // tool state.output in accumulatedToolOutputsCached.
  assert.ok(
    breakdown.accumulatedHistoryCached > 0,
    'user+assistant text must accumulate to accumulatedHistoryCached when marker is structural',
  );
  assert.ok(
    breakdown.accumulatedToolOutputsCached > 0,
    'tool state.output must accumulate to accumulatedToolOutputsCached when marker is structural',
  );

  // System-role text part landed in unclassifiedCached (the only
  // place it could land given the unreliable systemPrompt marker).
  assert.ok(
    breakdown.unclassifiedCached > 0,
    'system-role text MUST land in unclassifiedCached when its marker is unreliable',
  );
});

test('TokenizerSplitter (cachedRead): happy path — all markers structural → markersDegraded=false and 5 named sub-buckets populated', () => {
  // The observable from tasks.md:316: a happy-path fixture exercises
  // the by-structure dispatch end to end, sums to positive count, and
  // does NOT degrade. Achieved by injecting an alternative markers
  // map where all 5 are MARKER_BY_STRUCTURE.
  const happyMarkers = Object.freeze({
    systemPrompt: MARKER_BY_STRUCTURE,
    agentsMd: MARKER_BY_STRUCTURE,
    mcpToolSchemas: MARKER_BY_STRUCTURE,
    accumulatedHistory: MARKER_BY_STRUCTURE,
    accumulatedToolOutputs: MARKER_BY_STRUCTURE,
  });
  const { parts, messages } = makeMixedFixture();
  const t = new TokenizerSplitter(happyMarkers);
  const result = t.classifyAndCount(parts, messages);

  assert.equal(
    result.markersDegraded,
    false,
    'all structural markers → markersDegraded must be false',
  );
  assert.deepEqual(
    result.failedMarkers,
    [],
    'no unreliable markers → failedMarkers must be empty',
  );

  assertCachedReadBreakdownShape(result.cachedReadBreakdown);
  const breakdown = result.cachedReadBreakdown;
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  assert.ok(
    sum > 0,
    'cachedReadBreakdown values must sum to a positive count on the happy path',
  );

  // System-role parts → systemPromptCached (per task brief: the
  // simplest sensible structural bucket for role=system).
  assert.ok(
    breakdown.systemPromptCached > 0,
    'system-role text must accumulate to systemPromptCached under by-structure dispatch',
  );
  // User+assistant → accumulatedHistoryCached.
  assert.ok(
    breakdown.accumulatedHistoryCached > 0,
    'user+assistant text must accumulate to accumulatedHistoryCached',
  );
  // Tool parts → accumulatedToolOutputsCached.
  assert.ok(
    breakdown.accumulatedToolOutputsCached > 0,
    'tool state.output must accumulate to accumulatedToolOutputsCached',
  );
  // No unknown-type parts → unclassifiedCached stays 0.
  assert.equal(
    breakdown.unclassifiedCached,
    0,
    'fixture has no unknown part types; unclassifiedCached must be 0 on the happy path',
  );

  // Structural-only fixture has no per-part content-shape grep to
  // distinguish agentsMd / mcpToolSchemas from systemPrompt. Both
  // remain 0; they are only populated when content-shape markers
  // become string-substring sentinels (a future opencode upstream
  // change). Today they ALWAYS hold 0 under by-structure dispatch.
  assert.equal(breakdown.agentsMdCached, 0);
  assert.equal(breakdown.mcpToolSchemasCached, 0);
});

test('TokenizerSplitter (cachedRead): explicitly-broken fixture — every marker unreliable → markersDegraded=true and ALL tokens land in unclassifiedCached', () => {
  // The other end of the observable: an explicitly-broken markers
  // map with EVERY marker set to MARKER_UNRELIABLE_SENTINEL forces
  // the entire cachedRead split into unclassifiedCached and tags
  // all 5 markers. Verifies the static markersDegraded computation
  // covers ALL five markers (not only the three system-role ones).
  const brokenMarkers = Object.freeze({
    systemPrompt: MARKER_UNRELIABLE_SENTINEL,
    agentsMd: MARKER_UNRELIABLE_SENTINEL,
    mcpToolSchemas: MARKER_UNRELIABLE_SENTINEL,
    accumulatedHistory: MARKER_UNRELIABLE_SENTINEL,
    accumulatedToolOutputs: MARKER_UNRELIABLE_SENTINEL,
  });
  const { parts, messages } = makeMixedFixture();
  const t = new TokenizerSplitter(brokenMarkers);
  const result = t.classifyAndCount(parts, messages);

  assert.equal(result.markersDegraded, true);
  assert.equal(
    result.failedMarkers.length,
    5,
    'every marker unreliable → failedMarkers must list all 5 names',
  );
  for (const name of [
    'systemPrompt',
    'agentsMd',
    'mcpToolSchemas',
    'accumulatedHistory',
    'accumulatedToolOutputs',
  ]) {
    assert.ok(
      result.failedMarkers.includes(name),
      `failedMarkers must include ${name}`,
    );
  }

  assertCachedReadBreakdownShape(result.cachedReadBreakdown);
  const breakdown = result.cachedReadBreakdown;
  // Every named sub-bucket collapses to 0…
  assert.equal(breakdown.systemPromptCached, 0);
  assert.equal(breakdown.agentsMdCached, 0);
  assert.equal(breakdown.mcpToolSchemasCached, 0);
  assert.equal(breakdown.accumulatedHistoryCached, 0);
  assert.equal(breakdown.accumulatedToolOutputsCached, 0);
  // …and unclassifiedCached absorbs every classifiable part.
  assert.ok(
    breakdown.unclassifiedCached > 0,
    'every classifiable part must land in unclassifiedCached when all markers are unreliable',
  );

  // v1 keys MUST still reflect the role/type dispatch (the v1 path
  // is independent of the cachedRead markers).
  assert.ok(result.systemPrompt > 0);
  assert.ok(result.history > 0);
  assert.ok(result.toolOutput > 0);
});

test('TokenizerSplitter (cachedRead): empty parts list still reports markersDegraded and full shape', () => {
  // markersDegraded is a property of the markers MAP, not of the
  // data — an empty parts list with default (production) markers
  // must STILL surface degraded=true and the full 6-key breakdown.
  // This matters because AttributionEngine (task 5.7) will read the
  // signal even when a session happens to have zero classifiable
  // parts (e.g. a session opened but never used).
  const t = new TokenizerSplitter();
  const result = t.classifyAndCount([], new Map());

  assert.equal(result.markersDegraded, true);
  assert.equal(result.failedMarkers.length, 3);

  assertCachedReadBreakdownShape(result.cachedReadBreakdown);
  for (const key of CACHED_READ_SUB_BUCKET_KEYS) {
    assert.equal(
      result.cachedReadBreakdown[key],
      0,
      `empty parts list must produce 0 for every cachedRead sub-bucket (${key})`,
    );
  }

  // v1 four-key shape also zero, preserved.
  assert.deepEqual(
    {
      systemPrompt: result.systemPrompt,
      history: result.history,
      toolOutput: result.toolOutput,
      unclassifiedCount: result.unclassifiedCount,
    },
    { systemPrompt: 0, history: 0, toolOutput: 0, unclassifiedCount: 0 },
  );
});

test('TokenizerSplitter (cachedRead): per-part counts equal the v1 totals (single-pass invariant)', () => {
  // The classifier walks `parts` exactly ONCE; the v1 split and the
  // v2 cachedRead split see the same per-part tokens. Verify the
  // structural pairings:
  //   - happy-path systemPromptCached === v1 systemPrompt
  //   - default-markers accumulatedHistoryCached === v1 history
  //   - default-markers accumulatedToolOutputsCached === v1 toolOutput
  // This guards against a refactor that adds a second walk and
  // accidentally drifts the two splits.
  const { parts, messages } = makeMixedFixture();

  const happyMarkers = Object.freeze({
    systemPrompt: MARKER_BY_STRUCTURE,
    agentsMd: MARKER_BY_STRUCTURE,
    mcpToolSchemas: MARKER_BY_STRUCTURE,
    accumulatedHistory: MARKER_BY_STRUCTURE,
    accumulatedToolOutputs: MARKER_BY_STRUCTURE,
  });
  const tHappy = new TokenizerSplitter(happyMarkers);
  const happy = tHappy.classifyAndCount(parts, messages);
  assert.equal(
    happy.cachedReadBreakdown.systemPromptCached,
    happy.systemPrompt,
    'happy-path systemPromptCached must equal v1 systemPrompt (single-pass tiktoken count)',
  );
  assert.equal(
    happy.cachedReadBreakdown.accumulatedHistoryCached,
    happy.history,
    'happy-path accumulatedHistoryCached must equal v1 history (single-pass tiktoken count)',
  );
  assert.equal(
    happy.cachedReadBreakdown.accumulatedToolOutputsCached,
    happy.toolOutput,
    'happy-path accumulatedToolOutputsCached must equal v1 toolOutput (single-pass tiktoken count)',
  );

  const tDefault = new TokenizerSplitter();
  const def = tDefault.classifyAndCount(parts, messages);
  assert.equal(
    def.cachedReadBreakdown.accumulatedHistoryCached,
    def.history,
    'default accumulatedHistoryCached must equal v1 history (structural marker unaffected by degraded state)',
  );
  assert.equal(
    def.cachedReadBreakdown.accumulatedToolOutputsCached,
    def.toolOutput,
    'default accumulatedToolOutputsCached must equal v1 toolOutput (structural marker unaffected by degraded state)',
  );
  assert.equal(
    def.cachedReadBreakdown.unclassifiedCached,
    def.systemPrompt,
    'default unclassifiedCached must equal v1 systemPrompt (unreliable marker reroutes system-role tokens here)',
  );
});

test('TokenizerSplitter (cachedRead): failedMarkers is read-only', () => {
  // Defensive: the failedMarkers array represents a static
  // classification fact, not a mutable scratchpad. Downstream
  // (AttributionEngine, ReportSerializer) must not be able to
  // accidentally mutate it. Freezing also catches a future
  // refactor that exposes a shared internal array by reference.
  const t = new TokenizerSplitter();
  const result = t.classifyAndCount([], new Map());
  // Guard against Object.isFrozen(undefined)===true: assert the
  // array exists FIRST so a missing field surfaces explicitly.
  assert.ok(
    Array.isArray(result.failedMarkers),
    'failedMarkers must exist as an array before the freeze check is meaningful',
  );
  assert.ok(
    Object.isFrozen(result.failedMarkers),
    'failedMarkers must be frozen so downstream consumers cannot mutate it',
  );
});
