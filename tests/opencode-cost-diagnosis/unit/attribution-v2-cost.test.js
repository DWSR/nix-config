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
    // 5.4 / 5.6 containers — still null at this boundary.
    // (Task 5.3 populated `cachedReadBreakdown`; the assertion that
    // it stays null moved out and its replacement lives in the
    // task 5.3 block lower in this file.)
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

// ---------------------------------------------------------------------
// Task 5.3 — cachedRead sub-bucket apportionment.
//
// Scope (5.3 _Boundary_): AttributionEngine apportions
// `session.tokens_cache_read` across the 6 cachedRead sub-buckets
// using `TokenizerProvenance.cachedReadBreakdown` counts. Last
// sub-bucket (`unclassifiedCached`) absorbs rounding so both
// invariants hold exactly:
//
//   sum(tokens per sub-bucket) === session.tokens_cache_read     (exact)
//   sum(cost.cachedReadBreakdown.*) === cost.cachedRead          (within ULP)
//
// Each non-absorber sub-bucket's cost is `subBucketTokens × rate`
// where `rate = cost.cachedRead / session.tokens_cache_read` is the
// effective per-token rate (a weighted average across messages when
// model identity varies, identical to `cacheReadPerM / 1e6` on the
// single-model happy path). The absorber's cost is computed by
// subtraction so the cost sum is exact regardless of float rounding
// on the multiplication side.
//
// The tests inject the TokenizerProvenance via a stub Tokenizer so
// the per-sub-bucket count distribution is controlled directly —
// the real TokenizerSplitter in production today returns
// `markersDegraded: true` with three of the six counts at zero
// (Decision 6 / task 5.7 territory). Decoupling the apportionment
// test from the classifier lets 5.3 own its boundary cleanly without
// also pinning it to the classifier's current behavior.
// ---------------------------------------------------------------------

// Stub tokenizer factory: returns whatever provenance the test asks
// for. Mirrors the surface `AttributionEngine._attributeSession`
// touches: a single `classifyAndCount(parts, messages)` call.
function makeStubTokenizer(provenance) {
  return {
    classifyAndCount(_parts, _messages) {
      return provenance;
    },
  };
}

// Build a provenance whose uncached side classifies cleanly (so
// 5.2's flow 2 split runs and the existing v1 invariants hold) and
// whose cachedRead side carries the requested 6-key breakdown with
// markersDegraded explicitly false. The unclassifiedCount stays at
// 0 so we don't trigger schema_partial_data noise.
function makeProvenance(cachedReadBreakdown, uncached = null) {
  const u = uncached || {
    systemPrompt: 100,
    history: 200,
    toolOutput: 50,
  };
  return {
    systemPrompt: u.systemPrompt,
    history: u.history,
    toolOutput: u.toolOutput,
    unclassifiedCount: 0,
    cachedReadBreakdown,
    markersDegraded: false,
    failedMarkers: Object.freeze([]),
    byTool: new Map(),
  };
}

test('flag ON / 5.3: cost.cachedReadBreakdown is a populated 6-key object on the matched path', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 150,
      accumulatedToolOutputsCached: 100,
      unclassifiedCached: 50,
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(breakdown)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    // R4.AC1: at minimum five named sub-buckets + the residual.
    // The container must be a populated object (not null) on the
    // matched path. CACHED_READ_SUB_BUCKET_KEYS pins the exact set.
    assert.notEqual(
      attr.cost.cachedReadBreakdown,
      null,
      'cost.cachedReadBreakdown must be populated after task 5.3',
    );
    assert.equal(typeof attr.cost.cachedReadBreakdown, 'object');
    const keys = Object.keys(attr.cost.cachedReadBreakdown).sort();
    assert.deepEqual(
      keys,
      [
        'accumulatedHistoryCached',
        'accumulatedToolOutputsCached',
        'agentsMdCached',
        'mcpToolSchemasCached',
        'systemPromptCached',
        'unclassifiedCached',
      ],
      'cachedReadBreakdown must carry exactly the 6 CACHED_READ_SUB_BUCKET_KEYS',
    );
    for (const k of keys) {
      assert.equal(
        typeof attr.cost.cachedReadBreakdown[k],
        'number',
        `cachedReadBreakdown.${k} must be a number on the matched path`,
      );
      assert.ok(
        Number.isFinite(attr.cost.cachedReadBreakdown[k]),
        `cachedReadBreakdown.${k} must be finite`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.3: cost sum invariant — sum(cachedReadBreakdown.*) === cost.cachedRead within $0.01', () => {
  // R4.AC2: sum-correctness with last-sub-bucket-absorbs-rounding.
  // Observable from task 5.3 brief:
  //   sum(cost.cachedReadBreakdown.*) === cost.cachedRead within $0.01
  // In practice we achieve this within float ULP (much tighter
  // than $0.01) by computing unclassifiedCached's cost via
  // subtraction from the parent total rather than via the
  // multiply-then-round path the other five sub-buckets take.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    // Pick counts whose sum (337) does NOT divide T_cacheR=500 so
    // rounding actually has to be absorbed somewhere. A clean
    // divisible split would not exercise the absorber.
    const breakdown = {
      systemPromptCached: 17,
      agentsMdCached: 23,
      mcpToolSchemasCached: 31,
      accumulatedHistoryCached: 113,
      accumulatedToolOutputsCached: 89,
      unclassifiedCached: 64,
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(breakdown)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const subSum =
      attr.cost.cachedReadBreakdown.systemPromptCached +
      attr.cost.cachedReadBreakdown.agentsMdCached +
      attr.cost.cachedReadBreakdown.mcpToolSchemasCached +
      attr.cost.cachedReadBreakdown.accumulatedHistoryCached +
      attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached +
      attr.cost.cachedReadBreakdown.unclassifiedCached;
    assert.ok(
      Math.abs(subSum - attr.cost.cachedRead) < 0.01,
      `cachedReadBreakdown.* sum (${subSum}) must equal cost.cachedRead ` +
        `(${attr.cost.cachedRead}) within $0.01; observed delta = ` +
        `${Math.abs(subSum - attr.cost.cachedRead)}`,
    );
    // Bonus tightness — ULP-scale, not cent-scale.
    assert.ok(
      Math.abs(subSum - attr.cost.cachedRead) < COST_EPSILON,
      `cachedReadBreakdown.* sum must equal cost.cachedRead within ` +
        `the ULP-scale tolerance the absorber pattern guarantees`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.3: token sum invariant — sum(per-sub-bucket tokens) === session.tokens_cache_read exactly', () => {
  // R4.AC2: "sum of cached-read sub-bucket token counts equals the
  // cached-read bucket total exactly". The token-side breakdown is
  // not exposed on SessionAttribution (the cost shape carries only
  // dollars), so we reconstruct it indirectly: every non-absorber
  // sub-bucket's cost is exactly `subBucketTokens × rate`, so
  // `cost.cachedReadBreakdown[k] / rate` returns the exact integer
  // token count for that sub-bucket. The absorber's tokens are
  // T_cacheR minus the apportioned sum.
  //
  // This indirect check is sufficient because the invariant is
  // about the existence and correctness of the underlying token
  // apportionment, not its API exposure.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    // Same non-divisible counts as the cost-sum test so rounding
    // actually has to be absorbed.
    const counts = {
      systemPromptCached: 17,
      agentsMdCached: 23,
      mcpToolSchemasCached: 31,
      accumulatedHistoryCached: 113,
      accumulatedToolOutputsCached: 89,
      unclassifiedCached: 64,
    };
    const breakdownSum =
      counts.systemPromptCached +
      counts.agentsMdCached +
      counts.mcpToolSchemasCached +
      counts.accumulatedHistoryCached +
      counts.accumulatedToolOutputsCached +
      counts.unclassifiedCached;
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(counts)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const T = ses.tokens_cache_read;
    const rate = attr.cost.cachedRead / T; // effective per-token rate

    // Re-derive the expected per-sub-bucket token counts using the
    // same apportionment formula the implementation MUST use.
    // (Mirrored from spec design.md:584 / task 5.3 brief.)
    const KEYS = [
      'systemPromptCached',
      'agentsMdCached',
      'mcpToolSchemasCached',
      'accumulatedHistoryCached',
      'accumulatedToolOutputsCached',
    ];
    let expectedApportioned = 0;
    const expectedTokens = {};
    for (const k of KEYS) {
      expectedTokens[k] = Math.round((T * counts[k]) / breakdownSum);
      expectedApportioned += expectedTokens[k];
    }
    expectedTokens.unclassifiedCached = T - expectedApportioned;

    // Sum invariant on the expected side (proves the formula is sum-exact).
    const expSum =
      expectedTokens.systemPromptCached +
      expectedTokens.agentsMdCached +
      expectedTokens.mcpToolSchemasCached +
      expectedTokens.accumulatedHistoryCached +
      expectedTokens.accumulatedToolOutputsCached +
      expectedTokens.unclassifiedCached;
    assert.equal(
      expSum,
      T,
      `expected per-sub-bucket token sum (${expSum}) must equal ` +
        `session.tokens_cache_read (${T}) exactly by construction`,
    );

    // Implementation correctness: for each non-absorber sub-bucket,
    // the cost equals `expectedTokens × rate` exactly. (The
    // absorber takes the FP residual so it's checked indirectly
    // via the cost-sum invariant in the previous test.)
    for (const k of KEYS) {
      const expCost = expectedTokens[k] * rate;
      assert.ok(
        Math.abs(attr.cost.cachedReadBreakdown[k] - expCost) < COST_EPSILON,
        `cachedReadBreakdown.${k} must equal expected ${expectedTokens[k]} ` +
          `tokens × ${rate}/tok = ${expCost}; got ${attr.cost.cachedReadBreakdown[k]}`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.3: T_cacheR === 0 collapses every sub-bucket cost to 0', () => {
  // Degenerate case: session never read from cache. Apportionment
  // is undefined (divide-by-zero); all six sub-buckets must be 0
  // and the cost-sum invariant holds vacuously (0+0+0+0+0+0 === 0).
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({
      id: 'ses_synth_v2_cacheR_zero',
      tokens_cache_read: 0,
      cost: SYN_EXPECTED_COST - (SYN_CACHE_READ * SYN_CACHE_READ_PER_M) / M,
    });
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 0,
      accumulatedToolOutputsCached: 0,
      unclassifiedCached: 0,
    };
    // Override the assistant message so its cache.read matches the
    // session's zeroed-out cached-read total — otherwise the
    // per-message walk would still accumulate a non-zero
    // cost.cachedRead while session.tokens_cache_read says 0.
    const baseReader = makeMatchedSingleModelReader(ses);
    const reader = {
      partsOfSession(id) {
        return baseReader.partsOfSession(id);
      },
      messagesOfSession(id) {
        const msgs = [...baseReader.messagesOfSession(id)];
        for (const m of msgs) {
          if (m.role !== 'assistant') continue;
          const parsed = JSON.parse(m.data);
          parsed.tokens.cache.read = 0;
          m.data = JSON.stringify(parsed);
        }
        return msgs;
      },
      descendantSessionsOf(id) {
        return baseReader.descendantSessionsOf(id);
      },
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(breakdown)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.equal(attr.cost.cachedRead, 0, 'parent total is 0 when no cached reads');
    for (const k of [
      'systemPromptCached',
      'agentsMdCached',
      'mcpToolSchemasCached',
      'accumulatedHistoryCached',
      'accumulatedToolOutputsCached',
      'unclassifiedCached',
    ]) {
      assert.equal(
        attr.cost.cachedReadBreakdown[k],
        0,
        `cachedReadBreakdown.${k} must be 0 when session.tokens_cache_read===0`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.3: T_cacheR > 0 but all breakdown counts === 0 collapses sub-buckets to 0', () => {
  // Another degenerate case: session DID read from cache but the
  // classifier returned zero counts across every sub-bucket. The
  // apportionment ratio is undefined; design.md:584 specifies the
  // same collapse behaviour — every named sub-bucket goes to 0,
  // and unclassifiedCached also stays at 0 because there's no
  // residual to attribute. The cost-sum invariant holds vacuously
  // (0+0+0+0+0+0 === 0), but cost.cachedRead may itself be > 0 —
  // i.e., the parent total is real, just unattributable. (Task 5.7
  // owns the markersDegraded fallback that re-distributes via the
  // uncached ratios when this state is observed; 5.3 just stays
  // out of its way.)
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 0,
      accumulatedToolOutputsCached: 0,
      unclassifiedCached: 0,
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(breakdown)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    // Parent total is real (the per-message walk accumulated it).
    assert.ok(
      attr.cost.cachedRead > 0,
      'cost.cachedRead must reflect the real parent total even with all-zero breakdown',
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
        attr.cost.cachedReadBreakdown[k],
        0,
        `cachedReadBreakdown.${k} must be 0 when every breakdown count is 0`,
      );
    }
    // Cost-sum invariant is vacuous here — 0+0+0+0+0+0 === 0 ≠
    // cost.cachedRead. Task 5.7's degraded path fixes this in
    // production by re-distributing via the uncached ratios; 5.3
    // intentionally does NOT re-attribute on its own because the
    // markersDegraded signal isn't yet a branch in this engine.
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.3: unclassifiedCached absorbs token integer rounding (last-bucket pattern)', () => {
  // Direct exercise of the absorber: pick a small breakdown where
  // the round-multiply for the first five buckets is guaranteed to
  // produce a residual that lands on unclassifiedCached. With
  // T_cacheR=500 and breakdownSum=7, the per-bucket tokens are
  // round(500*1/7)=71 for each of the first five (355 total) and
  // unclassifiedCached absorbs 500-355=145 instead of round(500*2/7)=143.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 1,
      agentsMdCached: 1,
      mcpToolSchemasCached: 1,
      accumulatedHistoryCached: 1,
      accumulatedToolOutputsCached: 1,
      unclassifiedCached: 2,
    };
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenance(breakdown)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const T = ses.tokens_cache_read; // 500
    const rate = attr.cost.cachedRead / T;
    // Five sub-buckets at round(500/7) === 71 tokens each.
    const expFiveTokens = Math.round(T / 7);
    const expFiveCost = expFiveTokens * rate;
    for (const k of [
      'systemPromptCached',
      'agentsMdCached',
      'mcpToolSchemasCached',
      'accumulatedHistoryCached',
      'accumulatedToolOutputsCached',
    ]) {
      assert.ok(
        Math.abs(attr.cost.cachedReadBreakdown[k] - expFiveCost) < COST_EPSILON,
        `cachedReadBreakdown.${k} must equal ${expFiveTokens} tokens × rate ` +
          `(${expFiveCost}); got ${attr.cost.cachedReadBreakdown[k]}`,
      );
    }
    // Absorber: cost.cachedRead minus the five-bucket sum.
    const absorbed =
      attr.cost.cachedRead -
      attr.cost.cachedReadBreakdown.systemPromptCached -
      attr.cost.cachedReadBreakdown.agentsMdCached -
      attr.cost.cachedReadBreakdown.mcpToolSchemasCached -
      attr.cost.cachedReadBreakdown.accumulatedHistoryCached -
      attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached;
    assert.ok(
      Math.abs(attr.cost.cachedReadBreakdown.unclassifiedCached - absorbed) <
        COST_EPSILON,
      `unclassifiedCached must absorb the residual (${absorbed}); ` +
        `got ${attr.cost.cachedReadBreakdown.unclassifiedCached}`,
    );
    // Token-side: absorber gets T - 5×71 === 145 tokens (NOT 143).
    const absorberTokens =
      attr.cost.cachedReadBreakdown.unclassifiedCached / rate;
    assert.ok(
      Math.abs(absorberTokens - (T - 5 * expFiveTokens)) < 1e-6,
      `unclassifiedCached must carry ${T - 5 * expFiveTokens} tokens ` +
        `(T - 5×${expFiveTokens}); reconstructed ${absorberTokens}`,
    );
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
