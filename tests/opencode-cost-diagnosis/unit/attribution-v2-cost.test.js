/*
 * attribution-v2-cost.test.js — unit tests for task 5.2 of the
 * v2-diagnosis spec.
 *
 * Scope (5.2 _Boundary_): AttributionEngine per-message cost
 * compute. Walks message rows in chronological order, parses
 * `message.data` JSON per assistant message, looks up rates via
 * PricingTable.lookup(providerID, modelID), and accumulates per-
 * bucket dollar contributions into the 9 flat cost fields:
 *
 *   six v1 (verbatim from design.md §AttributionEngine extended):
 *     cachedRead, cachedWrite, uncachedInput, output, reasoning,
 *     subagentDispatch
 *
 *   three v2 uncached sub-buckets:
 *     uncachedSystemPrompt, history, toolOutputs
 *
 * Feature Flag Protocol (kiro-impl SKILL §Feature Flag Protocol):
 * The v2 cost-compute path is gated behind the module-level
 * `V2_COST_COMPUTE_ENABLED` flag exported via
 * `setV2CostComputeEnabled(bool)`. Default state is OFF — that
 * preserves v1's null cost shape and keeps the integration-test
 * goldens byte-identical until task 8.1 refreshes them. Every test
 * in this file flips the flag ON in its setup and OFF in teardown
 * so it can never leak state into the v1-shape unit tests.
 *
 * Out of scope for 5.2 (covered by sibling tasks):
 *   - cachedReadBreakdown apportionment      → task 5.3
 *   - toolOutputsByTool                       → task 5.4
 *   - reconciliation / cost_invariant_violation → task 5.5
 *   - pricing_table_drift finding + makeNullCostShape fallback → 5.6
 *   - markersDegraded proportional-from-uncached → 5.7
 *   - subagent_agent_attribution_drift finding → 5.8
 *   - rewritten per_bucket_cost_deferred detail → 5.9
 *
 * Rate convention (matches PricingTable shape at design.md:597-622):
 * `rate.inputPerM` is dollars per million tokens, so per-token cost
 * is `tokens × ratePerM / 1e6`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const {
  SubagentAggregator,
  TokenizerSplitter,
  AttributionEngine,
  setV2CostComputeEnabled,
} = mod;

// ---------------------------------------------------------------------
// Fake pricing table — implements the same surface as PricingTable
// (lookup(providerID, modelID) → Rates|null) without needing to
// materialize a JSON fixture on disk.
// ---------------------------------------------------------------------
function makeFakePricing(rateMap) {
  return {
    lookup(providerID, modelID) {
      if (typeof providerID !== 'string' || typeof modelID !== 'string') {
        return null;
      }
      const hit = rateMap.get(providerID + '::' + modelID);
      return hit === undefined ? null : hit;
    },
    get pinMetadata() {
      return { pinDate: '2099-01-01', pinSource: 'synthetic' };
    },
    get knownModels() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------
// Synthetic session helpers.
// ---------------------------------------------------------------------

// Token counts the synthetic session below uses. Single source of
// truth so the cost-side assertions can re-derive expected values
// without magic numbers drifting between sites.
const M = 1_000_000;
const SYN_INPUT = 1000;
const SYN_OUTPUT = 200;
const SYN_REASONING = 50;
const SYN_CACHE_READ = 500;
const SYN_CACHE_WRITE = 100;
// Session.cost is derived from the per-message message.cost in
// opencode's own accounting; v2 reconciles against it (task 5.5).
// For 5.2's happy-path coverage we pick a value that matches the
// per-bucket sum at the chosen rates, so reconciliation in 5.5
// will be tight too.
const SYN_INPUT_PER_M = 3.0;
const SYN_OUTPUT_PER_M = 15.0;
const SYN_REASONING_PER_M = 8.0;
const SYN_CACHE_READ_PER_M = 0.3;
const SYN_CACHE_WRITE_PER_M = 3.75;
const SYN_EXPECTED_COST =
  (SYN_INPUT * SYN_INPUT_PER_M +
    SYN_OUTPUT * SYN_OUTPUT_PER_M +
    SYN_REASONING * SYN_REASONING_PER_M +
    SYN_CACHE_READ * SYN_CACHE_READ_PER_M +
    SYN_CACHE_WRITE * SYN_CACHE_WRITE_PER_M) /
  M;

function makeSyntheticSession(overrides = {}) {
  return {
    id: 'ses_synth_v2cost',
    parent_id: null,
    directory: '/Users/test/synth',
    agent: 'build',
    model: 'anthropic/claude-opus-4-7',
    tokens_input: SYN_INPUT,
    tokens_output: SYN_OUTPUT,
    tokens_reasoning: SYN_REASONING,
    tokens_cache_read: SYN_CACHE_READ,
    tokens_cache_write: SYN_CACHE_WRITE,
    cost: SYN_EXPECTED_COST,
    time_created: 1700000000000,
    time_updated: 1700000000001,
    ...overrides,
  };
}

// A reader with a single assistant message whose data carries the
// full v2 token shape opencode persists per design.md:704
// (`tokens.{input, output, reasoning, cache.{read, write}}`).
// Parts include a system text, a user text, an assistant text, and
// a tool with state.output — so the Tokenizer's three classified
// buckets all contribute and the proportional split runs normally.
function makeMatchedSingleModelReader(session) {
  return {
    partsOfSession(sessionId) {
      assert.equal(sessionId, session.id);
      return [
        {
          id: 'prt_sys',
          message_id: 'msg_sys',
          session_id: session.id,
          type: 'text',
          data: JSON.stringify({ text: 'you are a coding agent' }),
          time_created: 0,
          time_updated: 0,
        },
        {
          id: 'prt_user',
          message_id: 'msg_user',
          session_id: session.id,
          type: 'text',
          data: JSON.stringify({ text: 'help me with this task' }),
          time_created: 1,
          time_updated: 1,
        },
        {
          id: 'prt_asst',
          message_id: 'msg_asst',
          session_id: session.id,
          type: 'text',
          data: JSON.stringify({ text: 'sure here is the plan' }),
          time_created: 2,
          time_updated: 2,
        },
        {
          id: 'prt_tool',
          message_id: 'msg_asst',
          session_id: session.id,
          type: 'tool',
          data: JSON.stringify({
            tool: 'bash',
            state: { output: 'ls -la\ntotal 0\n' },
          }),
          time_created: 3,
          time_updated: 3,
        },
      ];
    },
    messagesOfSession(sessionId) {
      assert.equal(sessionId, session.id);
      return [
        {
          id: 'msg_sys',
          session_id: session.id,
          data: JSON.stringify({ role: 'system' }),
          role: 'system',
          time_created: 0,
          time_updated: 0,
        },
        {
          id: 'msg_user',
          session_id: session.id,
          data: JSON.stringify({ role: 'user' }),
          role: 'user',
          time_created: 1,
          time_updated: 1,
        },
        {
          id: 'msg_asst',
          session_id: session.id,
          data: JSON.stringify({
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-opus-4-7',
            variant: 'default',
            tokens: {
              input: SYN_INPUT,
              output: SYN_OUTPUT,
              reasoning: SYN_REASONING,
              cache: { read: SYN_CACHE_READ, write: SYN_CACHE_WRITE },
            },
            cost: SYN_EXPECTED_COST,
          }),
          role: 'assistant',
          time_created: 2,
          time_updated: 2,
        },
      ];
    },
    descendantSessionsOf() {
      return [];
    },
  };
}

function makeMatchedSinglePricing() {
  return makeFakePricing(
    new Map([
      [
        'anthropic::claude-opus-4-7',
        Object.freeze({
          inputPerM: SYN_INPUT_PER_M,
          outputPerM: SYN_OUTPUT_PER_M,
          reasoningPerM: SYN_REASONING_PER_M,
          cacheReadPerM: SYN_CACHE_READ_PER_M,
          cacheWritePerM: SYN_CACHE_WRITE_PER_M,
        }),
      ],
    ]),
  );
}

// Cost tolerance: floating-point math at parts-per-million scales
// produces sub-cent rounding noise. The reconciliation finding at
// task 5.5 uses `max(0.1% × session.cost, $0.01)`; the per-bucket
// arithmetic invariant we assert here is tighter than that because
// the numerator is identical on both sides (we're just splitting
// one number into three with last-bucket-absorbs-rounding).
const COST_EPSILON = 1e-9;

// ---------------------------------------------------------------------
// Feature flag: presence and default state.
// ---------------------------------------------------------------------

test('setV2CostComputeEnabled is exported', () => {
  assert.equal(typeof setV2CostComputeEnabled, 'function');
});

test('V2 cost compute is OFF by default — engine emits the v1 6-key cost shape', () => {
  // R7.AC1 / R7.AC2: byte-identical golden output during the
  // staged rollout window depends on the flag defaulting to OFF.
  // We do NOT call setV2CostComputeEnabled here so the flag's
  // module-scope default is exercised directly.
  const ses = makeSyntheticSession();
  const reader = makeMatchedSingleModelReader(ses);
  const pricing = makeMatchedSinglePricing();
  const eng = new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
    pricing,
  );
  const attr = eng.attributeSession(ses);

  // v1 cost shape: total (from session.cost) plus six null
  // per-bucket fields. The three v2 uncached sub-bucket cost
  // keys must NOT be present in OFF mode.
  assert.equal(attr.cost.total, SYN_EXPECTED_COST);
  for (const k of [
    'cachedRead',
    'cachedWrite',
    'uncachedInput',
    'output',
    'reasoning',
    'subagentDispatch',
  ]) {
    assert.equal(
      attr.cost[k],
      null,
      `flag OFF: cost.${k} must be null (v1 shape preserved)`,
    );
  }
  for (const k of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(attr.cost, k),
      false,
      `flag OFF: cost.${k} must not appear (v1 shape, no v2 extensions)`,
    );
  }
});

// ---------------------------------------------------------------------
// V2 cost compute with the flag enabled.
// Tests own their own enable/disable so failures in one cannot
// leak the flag into the v1-shape suite.
// ---------------------------------------------------------------------

test('flag ON: matched single-model session — cost.total === session.cost', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    // R2.AC6 invariant preserved: cost.total is sourced from
    // session.cost regardless of pricing-table outcomes.
    assert.equal(attr.cost.total, ses.cost);
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: cost shape contains exactly the 9 flat cost fields + total', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    // Design.md:597-622 CostBuckets shape. Task 5.2 scope is the
    // 9 flat fields + total. The remaining containers
    // (cachedReadBreakdown, subagentDispatchByAgent,
    // toolOutputsByTool) are populated by tasks 5.3 / 5.4 / 5.6;
    // for 5.2 they MUST be present-but-null so the JSON shape is
    // stable and downstream consumers can rely on a single
    // contract regardless of which apportionment task has landed.
    const expectedFlatKeys = [
      'total',
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
    for (const k of expectedFlatKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(attr.cost, k),
        `cost.${k} must be present in v2 cost shape`,
      );
    }
    for (const k of [
      'cachedRead',
      'cachedWrite',
      'uncachedInput',
      'output',
      'reasoning',
      'subagentDispatch',
      'uncachedSystemPrompt',
      'history',
      'toolOutputs',
    ]) {
      assert.equal(
        typeof attr.cost[k],
        'number',
        `cost.${k} must be a number on the matched path`,
      );
      assert.ok(
        Number.isFinite(attr.cost[k]),
        `cost.${k} must be finite, got ${attr.cost[k]}`,
      );
      assert.ok(
        attr.cost[k] >= 0,
        `cost.${k} must be non-negative, got ${attr.cost[k]}`,
      );
    }
    // 5.3 / 5.4 / 5.6 containers — still null at the 5.2 boundary.
    assert.equal(
      attr.cost.cachedReadBreakdown,
      null,
      'cost.cachedReadBreakdown is task 5.3 boundary — must stay null in 5.2',
    );
    assert.equal(
      attr.cost.subagentDispatchByAgent,
      null,
      'cost.subagentDispatchByAgent is task 5.4 / 5.6 boundary — must stay null in 5.2',
    );
    assert.equal(
      attr.cost.toolOutputsByTool,
      null,
      'cost.toolOutputsByTool is task 5.4 boundary — must stay null in 5.2',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: per-bucket cost values equal tokens × rate / 1e6 for each flat field', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const expCachedRead = (SYN_CACHE_READ * SYN_CACHE_READ_PER_M) / M;
    const expCachedWrite = (SYN_CACHE_WRITE * SYN_CACHE_WRITE_PER_M) / M;
    const expUncachedInput = (SYN_INPUT * SYN_INPUT_PER_M) / M;
    const expOutput = (SYN_OUTPUT * SYN_OUTPUT_PER_M) / M;
    const expReasoning = (SYN_REASONING * SYN_REASONING_PER_M) / M;

    assert.ok(
      Math.abs(attr.cost.cachedRead - expCachedRead) < COST_EPSILON,
      `cost.cachedRead expected ≈ ${expCachedRead}, got ${attr.cost.cachedRead}`,
    );
    assert.ok(
      Math.abs(attr.cost.cachedWrite - expCachedWrite) < COST_EPSILON,
      `cost.cachedWrite expected ≈ ${expCachedWrite}, got ${attr.cost.cachedWrite}`,
    );
    assert.ok(
      Math.abs(attr.cost.uncachedInput - expUncachedInput) < COST_EPSILON,
      `cost.uncachedInput expected ≈ ${expUncachedInput}, got ${attr.cost.uncachedInput}`,
    );
    assert.ok(
      Math.abs(attr.cost.output - expOutput) < COST_EPSILON,
      `cost.output expected ≈ ${expOutput}, got ${attr.cost.output}`,
    );
    assert.ok(
      Math.abs(attr.cost.reasoning - expReasoning) < COST_EPSILON,
      `cost.reasoning expected ≈ ${expReasoning}, got ${attr.cost.reasoning}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: cost.uncachedSystemPrompt + history + toolOutputs === cost.uncachedInput (sum invariant)', () => {
  // R2.AC5: sub-bucket dollars sum to the parent bucket dollars
  // using the same per-bucket rate. The apportionment mirrors v1's
  // Flow 2 token split (last bucket absorbs rounding) so the sum
  // is exact on the matched path.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const subSum =
      attr.cost.uncachedSystemPrompt +
      attr.cost.history +
      attr.cost.toolOutputs;
    assert.ok(
      Math.abs(subSum - attr.cost.uncachedInput) < COST_EPSILON,
      `uncachedSystemPrompt(${attr.cost.uncachedSystemPrompt}) + ` +
        `history(${attr.cost.history}) + ` +
        `toolOutputs(${attr.cost.toolOutputs}) = ${subSum} must equal ` +
        `cost.uncachedInput(${attr.cost.uncachedInput}) within tolerance`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: cost.subagentDispatch === sum(SubagentAggregator.byAgent[*].cost)', () => {
  // Per design.md:586 the per-agent cost numbers from the
  // aggregator already incorporate the descendants' authoritative
  // `session.cost`; AttributionEngine MUST NOT recompute them.
  // We assert with a mock aggregator so the test is deterministic
  // without needing a recursive-descendant fixture.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const mockAggregator = {
      schemaSupportsParentLink: true,
      rollup(rootId) {
        assert.equal(rootId, ses.id);
        const byAgent = new Map([
          ['general', { tokensTotal: 1234, cost: 0.0123, childCount: 2 }],
          ['build', { tokensTotal: 5678, cost: 0.0456, childCount: 3 }],
        ]);
        return {
          totals: { tokensTotal: 6912, cost: 0.0579, childCount: 5 },
          findings: [],
          byAgent,
          nullAgentDescendantIds: Object.freeze([]),
        };
      },
    };
    const eng = new AttributionEngine(
      reader,
      mockAggregator,
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const expSubagentDispatchCost = 0.0123 + 0.0456;
    assert.ok(
      Math.abs(attr.cost.subagentDispatch - expSubagentDispatchCost) <
        COST_EPSILON,
      `cost.subagentDispatch must equal sum of byAgent[*].cost ` +
        `(${expSubagentDispatchCost}); got ${attr.cost.subagentDispatch}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: token-side fields unchanged (v1 BucketTotals contract preserved)', () => {
  // R7.AC1: existing v1 fields cannot be renamed, removed, or
  // changed in shape. The TokenBuckets shape is computed before
  // the cost flag is read, so flipping the flag MUST NOT alter
  // any numeric token field.
  setV2CostComputeEnabled(false);
  const ses = makeSyntheticSession();
  const readerOff = makeMatchedSingleModelReader(ses);
  const engOff = new AttributionEngine(
    readerOff,
    new SubagentAggregator(readerOff),
    new TokenizerSplitter(),
    makeMatchedSinglePricing(),
  );
  const tokensOff = engOff.attributeSession(ses).tokens;

  setV2CostComputeEnabled(true);
  try {
    const readerOn = makeMatchedSingleModelReader(ses);
    const engOn = new AttributionEngine(
      readerOn,
      new SubagentAggregator(readerOn),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const tokensOn = engOn.attributeSession(ses).tokens;
    assert.deepEqual(
      tokensOn,
      tokensOff,
      'tokens shape must be byte-identical regardless of cost flag state',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: identity/findings carry through unchanged from v1 path', () => {
  // R7.AC4 + R7.AC5 forward-compat guards: v1's
  // per_bucket_cost_deferred / aggregator findings flow continues
  // to work in the v2 cost-compute path. (5.9 rewrites the
  // per_bucket_cost_deferred detail string; 5.2 only verifies the
  // emit site still fires when the flag is on.)
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.equal(attr.sessionId, ses.id);
    assert.equal(attr.directory, ses.directory);
    assert.equal(attr.agent, ses.agent);
    assert.equal(attr.model, ses.model);
    const pbcd = attr.findings.filter(
      (f) => f.kind === 'per_bucket_cost_deferred',
    );
    assert.equal(
      pbcd.length,
      1,
      'per_bucket_cost_deferred must still be emitted under the v2 flag (5.9 rewrites the detail, 5.2 keeps the emit)',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON: P_sum==0 collapses all three uncached sub-bucket costs to 0', () => {
  // Edge case: when the Tokenizer cannot classify any input parts
  // (every part skipped, or no parts at all), the v1 Flow 2 path
  // already zeroes the three uncached *token* sub-buckets. The v2
  // cost extension must do the same on the cost side so the sum
  // invariant (0+0+0 === uncachedInput) holds vacuously — i.e.,
  // cost.uncachedInput is also 0 because there is nothing to
  // apportion. The unclassifiable_input finding still fires
  // (verified by the existing v1 test in attribution.test.js).
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({
      id: 'ses_synth_v2_psumzero',
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost: 0,
    });
    // Reader with no classified parts → P_sum == 0.
    const reader = {
      partsOfSession() {
        return [
          {
            id: 'prt_step',
            message_id: 'msg_asst',
            session_id: ses.id,
            type: 'step-start',
            data: JSON.stringify({}),
            time_created: 0,
            time_updated: 0,
          },
        ];
      },
      messagesOfSession() {
        return [
          {
            id: 'msg_asst',
            session_id: ses.id,
            data: JSON.stringify({
              role: 'assistant',
              providerID: 'anthropic',
              modelID: 'claude-opus-4-7',
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              cost: 0,
            }),
            role: 'assistant',
            time_created: 0,
            time_updated: 0,
          },
        ];
      },
      descendantSessionsOf() {
        return [];
      },
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.equal(attr.cost.uncachedSystemPrompt, 0);
    assert.equal(attr.cost.history, 0);
    assert.equal(attr.cost.toolOutputs, 0);
    assert.equal(attr.cost.uncachedInput, 0);
    // unclassifiable_input must still be emitted by the v1 path.
    const uci = attr.findings.filter(
      (f) => f.kind === 'unclassifiable_input',
    );
    assert.equal(uci.length, 1);
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag toggles cleanly OFF after every test (no leakage)', () => {
  // Defensive: every test above resets the flag in `finally`. This
  // bottom-of-file test confirms that the flag is in fact OFF at
  // the suite boundary so the global v1-shape tests in
  // attribution.test.js cannot pick up our state.
  const ses = makeSyntheticSession();
  const reader = makeMatchedSingleModelReader(ses);
  const eng = new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
    makeMatchedSinglePricing(),
  );
  const attr = eng.attributeSession(ses);
  for (const k of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(attr.cost, k),
      false,
      `flag must be OFF at suite boundary; cost.${k} must not appear`,
    );
  }
});
