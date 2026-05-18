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
  makeNullCostShape,
  PER_BUCKET_COST_KEYS,
  CACHED_READ_SUB_BUCKET_KEYS,
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
    // 5.6 / 5.8 container — still null at this boundary.
    // (Task 5.3 populated `cachedReadBreakdown`; task 5.4 populated
    // `toolOutputsByTool`. Their boundary-relaxation assertions live
    // in their respective blocks lower in this file.)
    assert.equal(
      attr.cost.subagentDispatchByAgent,
      null,
      'cost.subagentDispatchByAgent is task 5.8 boundary — must stay null until subagent per-agent dispatch lands',
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

// ---------------------------------------------------------------------
// Task 5.4 — per-tool sub-bucket apportionment with cached/uncached
// partition. AttributionEngine consumes `provenance.byTool` (a Map
// keyed by tool name carrying `{ cached, uncached }` token weights
// per Approach C from task 3.2) and emits `cost.toolOutputsByTool`
// as a Map of `{ cached: <usd>, uncached: <usd> }` entries.
//
// Apportionment formula (design.md:585, tasks.md:152-159):
//   per-tool cached cost   = parentCached × (byTool[name].cached / sumCached)
//   per-tool uncached cost = parentUncached × (byTool[name].uncached / sumUncached)
// where:
//   parentCached   = cost.cachedReadBreakdown.accumulatedToolOutputsCached
//   parentUncached = cost.toolOutputs
//
// The LAST iteration entry absorbs the FP residual within each
// partition independently so:
//   sum(toolOutputsByTool[*].uncached) === cost.toolOutputs                                 (ULP)
//   sum(toolOutputsByTool[*].cached)   === cost.cachedReadBreakdown.accumulatedToolOutputsCached (ULP)
//
// Per design.md ReportAssembler Implementation Notes (line 695),
// the Map → plain Object conversion happens at the ReportAssembler
// boundary (task 6.2) — AttributionEngine emits a Map here so the
// freeze pattern from TokenizerSplitter (per-entry Object.freeze)
// can carry through to consumers without an intermediate copy.
//
// Degenerate cases:
//   - empty provenance.byTool → empty Map (no per-tool weights to
//     attribute).
//   - sumCached === 0 with parentCached > 0 → all cached entries 0
//     (analogous to 5.3's all-zero-breakdown collapse; 5.7's
//     markersDegraded path owns the proportional-from-uncached
//     fallback).
//   - sumUncached === 0 with parentUncached > 0 → all uncached
//     entries 0.
//   - parentCached === 0 or parentUncached === 0 → naturally 0 via
//     multiplication; absorber's subtraction also yields 0.
// ---------------------------------------------------------------------

// Build a provenance with an explicit byTool map for 5.4 tests.
// Extends makeProvenance() by accepting a `byTool` arg so tests
// don't have to fully re-spell the rest of the provenance shape.
function makeProvenanceWithByTool(cachedReadBreakdown, byTool, uncached = null) {
  const base = makeProvenance(cachedReadBreakdown, uncached);
  return { ...base, byTool };
}

test('flag ON / 5.4: cost.toolOutputsByTool is a Map populated from provenance.byTool on the matched path', () => {
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
    // Per Approach C from task 3.2: cached === uncached per tool
    // part. The classifier emits both partitions populated from the
    // same tiktoken count; AttributionEngine apportions session-
    // level cached/uncached dollars across those weights
    // independently.
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 40, uncached: 40 })],
      ['read', Object.freeze({ cached: 35, uncached: 35 })],
      ['edit', Object.freeze({ cached: 25, uncached: 25 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.ok(
      attr.cost.toolOutputsByTool instanceof Map,
      'cost.toolOutputsByTool must be a Map after task 5.4 (Map → Object conversion deferred to ReportAssembler 6.2)',
    );
    assert.equal(
      attr.cost.toolOutputsByTool.size,
      3,
      'cost.toolOutputsByTool size must match provenance.byTool size',
    );
    for (const name of ['bash', 'read', 'edit']) {
      assert.ok(
        attr.cost.toolOutputsByTool.has(name),
        `cost.toolOutputsByTool must carry key '${name}' from provenance.byTool`,
      );
      const entry = attr.cost.toolOutputsByTool.get(name);
      assert.equal(typeof entry, 'object');
      assert.equal(typeof entry.cached, 'number');
      assert.equal(typeof entry.uncached, 'number');
      assert.ok(
        Number.isFinite(entry.cached) && entry.cached >= 0,
        `toolOutputsByTool['${name}'].cached must be finite + non-negative`,
      );
      assert.ok(
        Number.isFinite(entry.uncached) && entry.uncached >= 0,
        `toolOutputsByTool['${name}'].uncached must be finite + non-negative`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: cost.toolOutputsByTool entries are frozen against mutation', () => {
  // Mirrors the TokenizerSplitter freeze pattern (lines 1391-1393):
  // entries cannot be mutated by reference. The Map itself is not
  // Object.freeze-able in a meaningful way (Map.prototype.set is
  // not a frozen own property), but per-entry freeze blocks the
  // primary mutation risk — a downstream consumer that does
  // `cost.toolOutputsByTool.get(name).cached++` for accumulator
  // bookkeeping.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 40, uncached: 40 })],
      ['read', Object.freeze({ cached: 40, uncached: 40 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    for (const [name, entry] of attr.cost.toolOutputsByTool) {
      assert.ok(
        Object.isFrozen(entry),
        `toolOutputsByTool['${name}'] must be frozen so downstream cannot mutate per-entry partitions by reference`,
      );
    }
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: per-tool uncached cost sum === cost.toolOutputs (ULP)', () => {
  // tasks.md:155 partition invariant for the uncached side. The
  // last-bucket-absorbs-rounding pattern makes the sum exact by
  // construction even when the per-tool multiply-divide yields FP
  // residuals.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    // Weights whose sum (7 = 1+2+3+1) doesn't divide
    // parentUncached cleanly so the multiply-divide leaves a real
    // residual the absorber must catch. Three tools so the absorber
    // is the third (not also the first).
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 1, uncached: 1 })],
      ['read', Object.freeze({ cached: 2, uncached: 2 })],
      ['edit', Object.freeze({ cached: 3, uncached: 3 })],
      ['grep', Object.freeze({ cached: 1, uncached: 1 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    let perToolUncachedSum = 0;
    for (const entry of attr.cost.toolOutputsByTool.values()) {
      perToolUncachedSum += entry.uncached;
    }
    assert.ok(
      Math.abs(perToolUncachedSum - attr.cost.toolOutputs) < COST_EPSILON,
      `sum(toolOutputsByTool[*].uncached) (${perToolUncachedSum}) must equal ` +
        `cost.toolOutputs (${attr.cost.toolOutputs}) within ULP via the ` +
        `last-bucket-absorbs-rounding pattern; observed delta = ` +
        `${Math.abs(perToolUncachedSum - attr.cost.toolOutputs)}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: per-tool cached cost sum === cost.cachedReadBreakdown.accumulatedToolOutputsCached (ULP)', () => {
  // tasks.md:155 partition invariant for the cached side. The
  // cached partition is bounded by accumulatedToolOutputsCached
  // (the 5.3-emitted sub-bucket dollars for cached tool outputs),
  // NOT by cost.toolOutputs (which is the uncached share).
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 1, uncached: 1 })],
      ['read', Object.freeze({ cached: 2, uncached: 2 })],
      ['edit', Object.freeze({ cached: 3, uncached: 3 })],
      ['grep', Object.freeze({ cached: 1, uncached: 1 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    let perToolCachedSum = 0;
    for (const entry of attr.cost.toolOutputsByTool.values()) {
      perToolCachedSum += entry.cached;
    }
    const parentCached =
      attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached;
    assert.ok(
      Math.abs(perToolCachedSum - parentCached) < COST_EPSILON,
      `sum(toolOutputsByTool[*].cached) (${perToolCachedSum}) must equal ` +
        `cost.cachedReadBreakdown.accumulatedToolOutputsCached (${parentCached}) ` +
        `within ULP; observed delta = ${Math.abs(perToolCachedSum - parentCached)}`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: per-tool apportionment matches expected weights for non-absorber entries', () => {
  // Direct check on the apportionment formula for the non-absorber
  // entries. With three tools at weights [40, 35, 25] (sum 100):
  //   tool A uncached = parentUncached × 0.40
  //   tool B uncached = parentUncached × 0.35
  //   tool C (absorber) = parentUncached - A - B  (== 0.25 within ULP)
  // Same shape on the cached side using the cached weights.
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
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 40, uncached: 40 })],
      ['read', Object.freeze({ cached: 35, uncached: 35 })],
      ['edit', Object.freeze({ cached: 25, uncached: 25 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const parentUncached = attr.cost.toolOutputs;
    const parentCached =
      attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached;

    // Non-absorber entries: exact multiplication.
    const bash = attr.cost.toolOutputsByTool.get('bash');
    const read = attr.cost.toolOutputsByTool.get('read');
    const edit = attr.cost.toolOutputsByTool.get('edit');

    assert.ok(
      Math.abs(bash.uncached - parentUncached * 0.4) < COST_EPSILON,
      `bash.uncached must equal parentUncached × 40/100; expected ` +
        `${parentUncached * 0.4}, got ${bash.uncached}`,
    );
    assert.ok(
      Math.abs(read.uncached - parentUncached * 0.35) < COST_EPSILON,
      `read.uncached must equal parentUncached × 35/100; expected ` +
        `${parentUncached * 0.35}, got ${read.uncached}`,
    );
    assert.ok(
      Math.abs(bash.cached - parentCached * 0.4) < COST_EPSILON,
      `bash.cached must equal parentCached × 40/100; expected ` +
        `${parentCached * 0.4}, got ${bash.cached}`,
    );
    assert.ok(
      Math.abs(read.cached - parentCached * 0.35) < COST_EPSILON,
      `read.cached must equal parentCached × 35/100; expected ` +
        `${parentCached * 0.35}, got ${read.cached}`,
    );

    // Absorber: subtract from parent. With this clean-divisible
    // split the absorber's value also equals parent × 25/100
    // exactly, but the test is written against the absorption
    // formula (parent - apportioned) which is what makes the sum
    // invariant ULP-tight regardless of weight choice.
    assert.ok(
      Math.abs(edit.uncached - (parentUncached - bash.uncached - read.uncached)) <
        COST_EPSILON,
      `edit.uncached (absorber) must equal parentUncached - bash.uncached - read.uncached`,
    );
    assert.ok(
      Math.abs(edit.cached - (parentCached - bash.cached - read.cached)) <
        COST_EPSILON,
      `edit.cached (absorber) must equal parentCached - bash.cached - read.cached`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: empty provenance.byTool → empty cost.toolOutputsByTool Map', () => {
  // Degenerate: no tool parts in the session. Map is empty (not
  // null). The session-level cost.toolOutputs and
  // accumulatedToolOutputsCached are still computed by the
  // uncached/cached split logic; they simply have no per-tool
  // attribution.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    const byTool = new Map(); // explicitly empty
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.ok(
      attr.cost.toolOutputsByTool instanceof Map,
      'cost.toolOutputsByTool must still be a Map (just empty) when no tool parts exist',
    );
    assert.equal(
      attr.cost.toolOutputsByTool.size,
      0,
      'empty provenance.byTool → empty cost.toolOutputsByTool',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: parentUncached === 0 → all per-tool uncached entries are 0', () => {
  // Degenerate: cost.toolOutputs is 0 (e.g., P_sum == 0 collapsed
  // the uncached side, or no tokens_input). Cached partition can
  // still be apportioned; uncached collapses to 0 across all tools.
  setV2CostComputeEnabled(true);
  try {
    // Override the synthetic session to zero out tokens_input so
    // cost.uncachedInput === 0 → toolOutputs === 0 via the Flow 2
    // proportional split's all-zero absorber.
    const ses = makeSyntheticSession({
      id: 'ses_synth_v2_uncached_zero',
      tokens_input: 0,
      cost: SYN_EXPECTED_COST - (SYN_INPUT * SYN_INPUT_PER_M) / M,
    });
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
          parsed.tokens.input = 0;
          m.data = JSON.stringify(parsed);
        }
        return msgs;
      },
      descendantSessionsOf(id) {
        return baseReader.descendantSessionsOf(id);
      },
    };
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 1, uncached: 1 })],
      ['read', Object.freeze({ cached: 1, uncached: 1 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.equal(
      attr.cost.toolOutputs,
      0,
      'precondition: cost.toolOutputs must be 0 in this degenerate fixture',
    );
    for (const [name, entry] of attr.cost.toolOutputsByTool) {
      assert.equal(
        entry.uncached,
        0,
        `toolOutputsByTool['${name}'].uncached must be 0 when cost.toolOutputs === 0`,
      );
    }
    // The cached side is independent — accumulatedToolOutputsCached
    // is computed from session.tokens_cache_read which is still
    // non-zero, so cached entries reflect the real apportionment.
    let perToolCachedSum = 0;
    for (const entry of attr.cost.toolOutputsByTool.values()) {
      perToolCachedSum += entry.cached;
    }
    assert.ok(
      Math.abs(
        perToolCachedSum -
          attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached,
      ) < COST_EPSILON,
      `cached partition sum invariant must hold independently of uncached collapse`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: parentCached === 0 → all per-tool cached entries are 0', () => {
  // Degenerate: accumulatedToolOutputsCached is 0 (e.g.,
  // markersDegraded collapsed the cached-side breakdown, or the
  // session never read tool-output content from cache). Uncached
  // partition is unaffected.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 100,
      agentsMdCached: 50,
      mcpToolSchemasCached: 50,
      accumulatedHistoryCached: 150,
      accumulatedToolOutputsCached: 0, // explicitly zero
      unclassifiedCached: 150,
    };
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 1, uncached: 1 })],
      ['read', Object.freeze({ cached: 1, uncached: 1 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    assert.equal(
      attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached,
      0,
      'precondition: accumulatedToolOutputsCached must be 0 in this fixture',
    );
    for (const [name, entry] of attr.cost.toolOutputsByTool) {
      assert.equal(
        entry.cached,
        0,
        `toolOutputsByTool['${name}'].cached must be 0 when accumulatedToolOutputsCached === 0`,
      );
    }
    // The uncached side is independent — sum invariant still holds.
    let perToolUncachedSum = 0;
    for (const entry of attr.cost.toolOutputsByTool.values()) {
      perToolUncachedSum += entry.uncached;
    }
    assert.ok(
      Math.abs(perToolUncachedSum - attr.cost.toolOutputs) < COST_EPSILON,
      `uncached partition sum invariant must hold independently of cached collapse`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.4: single-tool session → the lone entry receives the full parent in each partition', () => {
  // Edge: byTool has exactly one entry. The loop's only iteration
  // is also the absorber, so the entry receives parent - 0 in each
  // partition. Verifies the absorber-as-first-and-only branch
  // doesn't double-count or zero the entry.
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const breakdown = {
      systemPromptCached: 0,
      agentsMdCached: 0,
      mcpToolSchemasCached: 0,
      accumulatedHistoryCached: 100,
      accumulatedToolOutputsCached: 80,
      unclassifiedCached: 70,
    };
    const byTool = new Map([
      ['bash', Object.freeze({ cached: 50, uncached: 50 })],
    ]);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      makeStubTokenizer(makeProvenanceWithByTool(breakdown, byTool)),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const bash = attr.cost.toolOutputsByTool.get('bash');
    assert.ok(bash !== undefined, "single-tool 'bash' entry must exist");
    assert.ok(
      Math.abs(bash.uncached - attr.cost.toolOutputs) < COST_EPSILON,
      `single-tool entry must receive the full parent uncached (${attr.cost.toolOutputs}); got ${bash.uncached}`,
    );
    assert.ok(
      Math.abs(
        bash.cached -
          attr.cost.cachedReadBreakdown.accumulatedToolOutputsCached,
      ) < COST_EPSILON,
      `single-tool entry must receive the full parent cached`,
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

// ---------------------------------------------------------------------
// Task 5.5 — Reconciliation and cost_invariant_violation finding.
//
// After per-bucket cost accumulation the engine reconciles
//   actualSum = cost.cachedRead + cost.cachedWrite + cost.uncachedInput +
//               cost.output + cost.reasoning + cost.subagentDispatch
// against `session.cost` with tolerance
//   max(COST_INVARIANT_TOLERANCE_PCT × session.cost,
//       COST_INVARIANT_TOLERANCE_FLOOR_USD)
// = max(0.001 × session.cost, 0.01). The 3 uncached sub-buckets
// are NOT summed (they partition uncachedInput per the 5.2
// invariant). Outside tolerance → exactly one
// cost_invariant_violation finding naming session id, expected,
// actual. Within tolerance → no finding. Either way the report
// continues to emit (R2.AC4).
// ---------------------------------------------------------------------

test('flag ON / 5.5: out-of-tolerance session emits exactly one cost_invariant_violation finding', () => {
  setV2CostComputeEnabled(true);
  try {
    // The matched single-model fixture produces per-bucket sum
    // === SYN_EXPECTED_COST exactly. Inflate session.cost by
    // +$0.02 — well above the $0.01 tolerance floor — so the
    // engine MUST emit a cost_invariant_violation.
    const inflated = SYN_EXPECTED_COST + 0.02;
    const ses = makeSyntheticSession({ cost: inflated });
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const civ = attr.findings.filter(
      (f) => f.kind === 'cost_invariant_violation',
    );
    assert.equal(
      civ.length,
      1,
      'out-of-tolerance session must emit exactly one cost_invariant_violation',
    );
    // Detail must name session id, expected (session.cost), and
    // actual (per-bucket sum) per design.md:580.
    assert.match(civ[0].detail, new RegExp(ses.id));
    assert.match(
      civ[0].detail,
      new RegExp(String(inflated)),
      'detail must include the expected (session.cost) value',
    );
    assert.match(
      civ[0].detail,
      new RegExp(String(SYN_EXPECTED_COST)),
      'detail must include the actual (per-bucket sum) value',
    );

    // R2.AC4: report continues to emit. The SessionAttribution
    // must still be a fully-shaped object even when the finding
    // fires — i.e., reconciliation never throws or aborts.
    assert.equal(attr.sessionId, ses.id);
    assert.equal(typeof attr.cost, 'object');
    assert.equal(attr.cost.total, inflated);
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.5: within-tolerance session emits NO cost_invariant_violation finding', () => {
  setV2CostComputeEnabled(true);
  try {
    // Default synthetic session has cost === per-bucket sum to
    // 1e-9. Well within tolerance.
    const ses = makeSyntheticSession();
    const reader = makeMatchedSingleModelReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const civ = attr.findings.filter(
      (f) => f.kind === 'cost_invariant_violation',
    );
    assert.equal(
      civ.length,
      0,
      'within-tolerance session must NOT emit cost_invariant_violation',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.5: violation just above the $0.01 floor fires; just below does not', () => {
  // Boundary check for the COST_INVARIANT_TOLERANCE_FLOOR_USD term.
  // session.cost is so small that 0.001 × session.cost ≪ $0.01,
  // so the floor dominates and tolerance = $0.01 flat.
  setV2CostComputeEnabled(true);
  try {
    // BELOW the floor: delta = +$0.009 < $0.01 → no finding.
    const sesBelow = makeSyntheticSession({
      cost: SYN_EXPECTED_COST + 0.009,
    });
    const eng1 = new AttributionEngine(
      makeMatchedSingleModelReader(sesBelow),
      new SubagentAggregator(makeMatchedSingleModelReader(sesBelow)),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attrBelow = eng1.attributeSession(sesBelow);
    assert.equal(
      attrBelow.findings.filter(
        (f) => f.kind === 'cost_invariant_violation',
      ).length,
      0,
      'delta of $0.009 must NOT trigger (below $0.01 floor)',
    );

    // ABOVE the floor: delta = +$0.011 > $0.01 → finding.
    const sesAbove = makeSyntheticSession({
      cost: SYN_EXPECTED_COST + 0.011,
    });
    const eng2 = new AttributionEngine(
      makeMatchedSingleModelReader(sesAbove),
      new SubagentAggregator(makeMatchedSingleModelReader(sesAbove)),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attrAbove = eng2.attributeSession(sesAbove);
    assert.equal(
      attrAbove.findings.filter(
        (f) => f.kind === 'cost_invariant_violation',
      ).length,
      1,
      'delta of $0.011 must trigger (above $0.01 floor)',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag OFF: reconciliation never runs (v1 null-shape path)', () => {
  // R7.AC1 forward-compat: the v1 cost shape has all per-bucket
  // fields null. Reconciliation MUST NOT fire on flag OFF — even
  // if session.cost would be "out of tolerance" against a
  // computed-but-not-present per-bucket sum.
  const ses = makeSyntheticSession({ cost: SYN_EXPECTED_COST + 100.0 });
  const reader = makeMatchedSingleModelReader(ses);
  const eng = new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
    makeMatchedSinglePricing(),
  );
  const attr = eng.attributeSession(ses);
  assert.equal(
    attr.findings.filter((f) => f.kind === 'cost_invariant_violation')
      .length,
    0,
    'flag OFF must not emit cost_invariant_violation',
  );
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

// ---------------------------------------------------------------------
// Task 5.6 — Pricing-drift fallback via makeNullCostShape and
// pricing_table_drift finding emission.
//
// Trigger: any message in the session had unmatched (providerID,
// modelID). _computeV2Cost marks the cost object with a
// non-enumerable `_v2PricingDrift` and `_v2DriftKey`; attributeSession
// must then:
//   - replace cost with makeNullCostShape(session.cost) (so every v2
//     cost field is null except cost.total which preserves
//     session.cost), and
//   - emit exactly one `pricing_table_drift` finding naming the
//     session id and the unrecognized key.
//
// Token-side fields stay populated (no change to TokenBuckets on
// drift). Other sessions in the same engine run retain their
// populated cost shape.
// ---------------------------------------------------------------------

// Variant of the single-model reader where the assistant message
// data carries `providerID` but is missing `modelID`. This triggers
// the "per-message data-shape failure" drift branch in
// _computeV2Cost (typeof modelID !== 'string').
function makeMissingModelIdReader(session) {
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
            // modelID intentionally omitted — drift trigger.
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

// Variant where modelID is present but the pricing table has no
// entry for that key. Exercises the second drift branch (lookup
// returns null) and lets us assert the exact unrecognized key
// captured in the finding.
function makeUnknownModelReader(session, providerID, modelID) {
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
            providerID,
            modelID,
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

test('flag ON / 5.6: drift session — cost.cachedRead === null AND every other v2 cost field null EXCEPT cost.total', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({ id: 'ses_drift_missing_modelid' });
    const reader = makeMissingModelIdReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    // Observable verbatim from the task brief: cost.cachedRead is
    // null and every other v2 cost field is null EXCEPT cost.total.
    assert.equal(
      attr.cost.cachedRead,
      null,
      'drift cost.cachedRead must be null (makeNullCostShape fallback)',
    );
    for (const k of PER_BUCKET_COST_KEYS) {
      assert.equal(
        attr.cost[k],
        null,
        `drift cost.${k} must be null on the v2 fallback shape`,
      );
    }
    // cachedReadBreakdown is present-but-all-null on the drift shape.
    assert.equal(
      typeof attr.cost.cachedReadBreakdown,
      'object',
      'drift cost.cachedReadBreakdown must remain a {key:null,...} object',
    );
    assert.notEqual(attr.cost.cachedReadBreakdown, null);
    for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
      assert.equal(
        attr.cost.cachedReadBreakdown[k],
        null,
        `drift cost.cachedReadBreakdown.${k} must be null`,
      );
    }
    // The two per-dimension maps collapse to null entirely (not {}).
    assert.equal(
      attr.cost.subagentDispatchByAgent,
      null,
      'drift cost.subagentDispatchByAgent must be null (entire map)',
    );
    assert.equal(
      attr.cost.toolOutputsByTool,
      null,
      'drift cost.toolOutputsByTool must be null (entire map)',
    );
    // cost.total is the sole survivor and carries session.cost.
    assert.equal(
      attr.cost.total,
      ses.cost,
      'drift cost.total must equal session.cost',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.6: drift session emits exactly one pricing_table_drift finding tagged to the session id and the unrecognized key', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({ id: 'ses_drift_unknown_model' });
    // Use a (provider, model) the makeMatchedSinglePricing fake
    // does not know about so the lookup returns null and we can
    // assert the exact key string captured by the finding.
    const reader = makeUnknownModelReader(
      ses,
      'fakeprovider',
      'fakemodel-xyz',
    );
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const drift = attr.findings.filter(
      (f) => f.kind === 'pricing_table_drift',
    );
    assert.equal(
      drift.length,
      1,
      'drift session must emit exactly one pricing_table_drift finding',
    );
    assert.match(
      drift[0].detail,
      new RegExp(ses.id),
      'pricing_table_drift detail must name the session id',
    );
    assert.match(
      drift[0].detail,
      /fakeprovider\/fakemodel-xyz/,
      'pricing_table_drift detail must name the unrecognized providerID/modelID key',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.6: drift session token-side BucketTotals fields remain populated (drift only nulls cost)', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({ id: 'ses_drift_tokens_preserved' });
    const reader = makeMissingModelIdReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    // Tokens.* must reflect the raw session counters regardless of
    // pricing drift — the BucketTotals contract is independent of
    // the cost shape.
    assert.equal(attr.tokens.cachedRead, SYN_CACHE_READ);
    assert.equal(attr.tokens.cachedWrite, SYN_CACHE_WRITE);
    assert.equal(attr.tokens.output, SYN_OUTPUT);
    assert.equal(attr.tokens.reasoning, SYN_REASONING);
    // The three uncached sub-buckets must partition tokens_input
    // exactly per the 5.2 invariant; we assert the sum here rather
    // than each branch because the proportional split depends on
    // the tokenizer's classification of the fixture parts.
    const sumUncached =
      attr.tokens.uncachedSystemPrompt +
      attr.tokens.history +
      attr.tokens.toolOutputs;
    assert.equal(
      sumUncached,
      SYN_INPUT,
      'tokens.uncachedSystemPrompt + history + toolOutputs must equal session.tokens_input on drift',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.6: drift session must NOT emit cost_invariant_violation (drift owns the cost-shape fault)', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({ id: 'ses_drift_no_civ' });
    const reader = makeMissingModelIdReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);
    const civ = attr.findings.filter(
      (f) => f.kind === 'cost_invariant_violation',
    );
    assert.equal(
      civ.length,
      0,
      'drift suppresses cost_invariant_violation (5.5 reconciliation gated on _v2PricingDrift)',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.6: drift cost shape matches makeNullCostShape(session.cost) key-for-key', () => {
  setV2CostComputeEnabled(true);
  try {
    const ses = makeSyntheticSession({ id: 'ses_drift_shape_parity' });
    const reader = makeMissingModelIdReader(ses);
    const eng = new AttributionEngine(
      reader,
      new SubagentAggregator(reader),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const attr = eng.attributeSession(ses);

    const expected = makeNullCostShape(ses.cost);
    // Compare the enumerable own-key shape so any drift marker
    // (_v2PricingDrift / _v2DriftKey) that may still ride along
    // non-enumerably does not interfere.
    assert.deepEqual(
      Object.keys(attr.cost).sort(),
      Object.keys(expected).sort(),
      'drift cost must carry exactly the makeNullCostShape key set',
    );
    for (const k of Object.keys(expected)) {
      assert.deepEqual(
        attr.cost[k],
        expected[k],
        `drift cost.${k} must match makeNullCostShape parity`,
      );
    }
    // Internal markers, if still attached, must remain
    // non-enumerable so they cannot leak into JSON.stringify.
    const enumerableKeys = Object.keys(attr.cost);
    assert.equal(
      enumerableKeys.includes('_v2PricingDrift'),
      false,
      '_v2PricingDrift must not be enumerable on the drift cost shape',
    );
    assert.equal(
      enumerableKeys.includes('_v2DriftKey'),
      false,
      '_v2DriftKey must not be enumerable on the drift cost shape',
    );
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag ON / 5.6: across two sessions in one engine run, matched stays populated AND drift gets the null shape', () => {
  // The task brief's central observable: "two sessions (one
  // matched, one with a synthetic missing modelID) returns the
  // matched session with populated cost.* fields and the drift
  // session with cost.cachedRead === null".
  //
  // We exercise this by running the engine against each session
  // separately (attributeSession is per-session; the "run" is
  // simulated at the test layer the way ReportAssembler will
  // consume per-session attributions).
  setV2CostComputeEnabled(true);
  try {
    const matchedSes = makeSyntheticSession({ id: 'ses_matched_in_run' });
    const matchedEng = new AttributionEngine(
      makeMatchedSingleModelReader(matchedSes),
      new SubagentAggregator(makeMatchedSingleModelReader(matchedSes)),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const matchedAttr = matchedEng.attributeSession(matchedSes);

    const driftSes = makeSyntheticSession({ id: 'ses_drift_in_run' });
    const driftEng = new AttributionEngine(
      makeMissingModelIdReader(driftSes),
      new SubagentAggregator(makeMissingModelIdReader(driftSes)),
      new TokenizerSplitter(),
      makeMatchedSinglePricing(),
    );
    const driftAttr = driftEng.attributeSession(driftSes);

    // Matched: cost.* fields populated; no drift finding.
    assert.equal(typeof matchedAttr.cost.cachedRead, 'number');
    assert.equal(typeof matchedAttr.cost.output, 'number');
    assert.equal(typeof matchedAttr.cost.uncachedInput, 'number');
    assert.equal(typeof matchedAttr.cost.uncachedSystemPrompt, 'number');
    assert.ok(
      Math.abs(matchedAttr.cost.total - matchedSes.cost) < COST_EPSILON,
      'matched cost.total must equal session.cost',
    );
    assert.equal(
      matchedAttr.findings.filter(
        (f) => f.kind === 'pricing_table_drift',
      ).length,
      0,
      'matched session must NOT emit pricing_table_drift',
    );

    // Drift: cost.cachedRead === null; exactly one drift finding
    // tagged to the drift session's id.
    assert.equal(driftAttr.cost.cachedRead, null);
    assert.equal(driftAttr.cost.output, null);
    assert.equal(driftAttr.cost.uncachedSystemPrompt, null);
    assert.equal(driftAttr.cost.total, driftSes.cost);
    const drift = driftAttr.findings.filter(
      (f) => f.kind === 'pricing_table_drift',
    );
    assert.equal(drift.length, 1);
    assert.match(drift[0].detail, new RegExp(driftSes.id));
  } finally {
    setV2CostComputeEnabled(false);
  }
});

test('flag OFF / 5.6: drift fallback path is not exercised (v1 null-shape path)', () => {
  // R7.AC1 forward-compat: flag-OFF runs the v1 cost shape. The
  // 5.6 drift fallback only runs when the flag is ON.
  const ses = makeSyntheticSession({ id: 'ses_drift_flag_off' });
  const reader = makeMissingModelIdReader(ses);
  const eng = new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
    makeMatchedSinglePricing(),
  );
  const attr = eng.attributeSession(ses);
  // No pricing_table_drift finding on flag OFF.
  assert.equal(
    attr.findings.filter((f) => f.kind === 'pricing_table_drift').length,
    0,
    'flag OFF must not emit pricing_table_drift',
  );
  // v1 cost shape: total + six v1 nulls, no v2 keys.
  for (const k of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(attr.cost, k),
      false,
      `flag OFF must not surface v2 sub-bucket cost.${k}`,
    );
  }
});
