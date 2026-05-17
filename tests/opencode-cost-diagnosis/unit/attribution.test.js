/*
 * attribution.test.js — unit tests for the Attribution Engine
 * (task 3.3 of .kiro/specs/opencode-cost-diagnosis).
 *
 * The Attribution Engine composes Reader + Subagent Aggregator +
 * Tokenizer Splitter to produce a per-session SessionAttribution
 * with the 5-bucket sum-correctness math, the
 * `per_bucket_cost_deferred` finding (always), and the
 * `unclassifiable_input` / `schema_partial_data` findings when their
 * trigger conditions hold (P_sum == 0 / provenance.unclassifiedCount
 * > 0). Requirements 2.3, 2.6, 5.4 and design.md lines 541-643.
 *
 * Interface (per design.md:617-624 + task brief, simpler-signature
 * variant): the Engine takes the trio in its constructor and exposes
 * `attributeSession(sessionRow): SessionAttribution`. The Engine
 * itself reaches back into the reader to materialize parts +
 * messages for that session — callers do not pre-build them.
 *
 * BucketTotals shape (design.md:588-597, 8 fields):
 *   cachedRead, cachedWrite, uncachedSystemPrompt, history,
 *   toolOutputs, output, reasoning, subagentDispatch
 *
 * CostBuckets shape (design.md:599-606, 7 fields):
 *   total (from session.cost), cachedRead, cachedWrite,
 *   uncachedInput, output, reasoning, subagentDispatch
 *   — every per-bucket field is null in v1 per the
 *   per_bucket_cost_deferred decision
 *
 * Fixture sums (from the 1.6 fixture, hand-derived from
 * scripts/opencode-cost-diagnosis-test-fixture.js):
 *
 *   ROOT_TOKENS = { input:10000, output:500, reasoning:100,
 *                   cache:{ read:5000, write:1000 } }
 *   ROOT_COST   = 0.05
 *
 *   CHILD_TOKENS = { input:2000, output:200, reasoning:50,
 *                    cache:{ read:1000, write:200 } }
 *   CHILD_COST   = 0.01
 *
 *   Per-descendant tokensTotal = 2000+200+50+1000+200 = 3450
 *   ses_root_a has 3 descendants (2 children + 1 grandchild)
 *   → subagentDispatch = 3 * 3450 = 10350 (R2.AC3 (e))
 *
 *   ses_root_c has 0 descendants → subagentDispatch = 0
 *
 * Per-bucket cost-deferred finding text per design.md:639-655:
 * every session emits exactly one finding of kind
 * `per_bucket_cost_deferred`. The `unclassifiable_input` finding
 * fires only when P_sum (systemPrompt + history + toolOutput from
 * the Tokenizer) is exactly 0 for that session — which never
 * happens against the fixture (root sessions all have system + user
 * + assistant text + a tool with state.output, so all three
 * classified buckets contribute). To exercise that branch we build
 * a synthetic in-memory mock reader whose partsOfSession yields
 * only `step-start` parts (all skipped by the Tokenizer).
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
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

// Fixture constants — single source of truth, kept here next to
// the assertions so a fixture rebuild produces a single diff site.
const ROOT_INPUT = 10000;
const ROOT_OUTPUT = 500;
const ROOT_REASONING = 100;
const ROOT_CACHE_READ = 5000;
const ROOT_CACHE_WRITE = 1000;
const ROOT_COST = 0.05;

const CHILD_TOKENS_TOTAL_PER = 2000 + 200 + 50 + 1000 + 200; // 3450
const ROOT_A_DESCENDANTS = 3;
const ROOT_A_SUBAGENT_DISPATCH = ROOT_A_DESCENDANTS * CHILD_TOKENS_TOTAL_PER; // 10350

function buildEngine(reader) {
  return new AttributionEngine(
    reader,
    new SubagentAggregator(reader),
    new TokenizerSplitter(),
  );
}

function getSession(reader, id) {
  // The Reader doesn't expose a "get one session by id" method
  // (its public surface is the iteration suite), so we filter
  // through rootSessionsMatching with sessionId.
  for (const s of reader.rootSessionsMatching({ sessionId: id })) {
    return s;
  }
  return null;
}

test('AttributionEngine: constructor takes reader + aggregator + tokenizer', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const eng = buildEngine(r);
    assert.equal(typeof eng.attributeSession, 'function');
  } finally {
    r.close();
  }
});

test('attributeSession(ses_root_a): authoritative buckets equal session row fields verbatim', () => {
  // R2.AC3 (a)/(e) + design.md:579-583: cachedRead/cachedWrite/
  // output/reasoning/subagentDispatch come straight from opencode
  // (or the aggregator); no math, no rounding, no proportional split.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_a');
    assert.ok(ses, 'fixture must contain ses_root_a');

    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);

    assert.equal(attr.tokens.cachedRead, ROOT_CACHE_READ);
    assert.equal(attr.tokens.cachedWrite, ROOT_CACHE_WRITE);
    assert.equal(attr.tokens.output, ROOT_OUTPUT);
    assert.equal(attr.tokens.reasoning, ROOT_REASONING);
    assert.equal(
      attr.tokens.subagentDispatch,
      ROOT_A_SUBAGENT_DISPATCH,
      'subagentDispatch must equal sum of per-descendant tokensTotal ' +
        '(3 descendants × 3450 = 10350)',
    );
  } finally {
    r.close();
  }
});

test('attributeSession(ses_root_a): SessionAttribution identity fields match session row', () => {
  // SessionAttribution shape per design.md:617-624.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_a');
    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);

    assert.equal(attr.sessionId, 'ses_root_a');
    assert.equal(attr.directory, '/Users/test/project-a');
    assert.equal(attr.agent, 'build');
    assert.equal(attr.model, 'claude-opus-4-7');
    assert.equal(typeof attr.timeCreated, 'number');
    assert.equal(typeof attr.timeUpdated, 'number');
    assert.equal(attr.timeCreated, ses.time_created);
    assert.equal(attr.timeUpdated, ses.time_updated);
  } finally {
    r.close();
  }
});

test('attributeSession: uncached sub-buckets sum EXACTLY to tokens_input (INVARIANT)', () => {
  // R2.AC3 (b/c/d) + design.md:587-588 INVARIANT + task brief Flow 2
  // math. The proportional split with the last-bucket-absorbs-rounding
  // strategy guarantees an exact integer sum, every session, no
  // tolerance window.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const eng = buildEngine(r);
    for (const sesId of ['ses_root_a', 'ses_root_b', 'ses_root_c']) {
      const ses = getSession(r, sesId);
      const attr = eng.attributeSession(ses);

      const sum =
        attr.tokens.uncachedSystemPrompt +
        attr.tokens.history +
        attr.tokens.toolOutputs;
      assert.equal(
        sum,
        ses.tokens_input,
        `${sesId}: uncachedSystemPrompt+history+toolOutputs (${sum}) ` +
          `must equal session.tokens_input (${ses.tokens_input}) exactly`,
      );

      // Sanity: every sub-bucket is a non-negative integer (the
      // proportional math must never produce a fraction or a
      // negative count, even with the last-bucket-absorbs-rounding
      // trick).
      for (const k of ['uncachedSystemPrompt', 'history', 'toolOutputs']) {
        assert.equal(
          Number.isInteger(attr.tokens[k]),
          true,
          `${sesId}.${k} must be an integer; got ${attr.tokens[k]}`,
        );
        assert.ok(
          attr.tokens[k] >= 0,
          `${sesId}.${k} must be non-negative; got ${attr.tokens[k]}`,
        );
      }
    }
  } finally {
    r.close();
  }
});

test('attributeSession: ses_root_c (zero subagents) has subagentDispatch=0', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_c');
    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);
    assert.equal(attr.tokens.subagentDispatch, 0);
  } finally {
    r.close();
  }
});

test('attributeSession: cost.total comes from session.cost; per-bucket cost fields all null', () => {
  // R2.AC6 + design.md:639-655: every per-bucket cost field is null
  // in v1 (per_bucket_cost_deferred). total alone is populated from
  // opencode's authoritative session.cost.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_a');
    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);

    assert.equal(attr.cost.total, ROOT_COST);
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
        `cost.${k} must be null in v1 (per_bucket_cost_deferred); got ${JSON.stringify(attr.cost[k])}`,
      );
    }
  } finally {
    r.close();
  }
});

test('attributeSession: emits exactly one per_bucket_cost_deferred finding per session', () => {
  // Design.md:639-655 + tasks.md:246-250: this finding is
  // unconditional — every SessionAttribution carries it. The fixture
  // root sessions don't trigger any of the other per-session
  // findings (no cycle, no unclassified parts, no P_sum==0), so the
  // exact-count assertion is strict.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const eng = buildEngine(r);
    for (const sesId of ['ses_root_a', 'ses_root_b', 'ses_root_c']) {
      const ses = getSession(r, sesId);
      const attr = eng.attributeSession(ses);

      const pbcd = attr.findings.filter(
        (f) => f.kind === 'per_bucket_cost_deferred',
      );
      assert.equal(
        pbcd.length,
        1,
        `${sesId}: expected exactly one per_bucket_cost_deferred ` +
          `finding, got ${pbcd.length}: ${JSON.stringify(attr.findings)}`,
      );
      assert.equal(typeof pbcd[0].detail, 'string');
      assert.ok(
        pbcd[0].detail.length > 0,
        'finding detail must be a non-empty string',
      );
    }
  } finally {
    r.close();
  }
});

test('attributeSession: fixture root_a does NOT emit unclassifiable_input (P_sum > 0)', () => {
  // Published task observable (tasks.md:262): findings includes
  // per_bucket_cost_deferred AND no unclassifiable_input. The
  // fixture's root assistant message includes a system text part,
  // user text part, assistant text part, and a tool with
  // state.output — three classified buckets all contribute, so
  // P_sum > 0.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_a');
    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);

    const uci = attr.findings.filter((f) => f.kind === 'unclassifiable_input');
    assert.equal(
      uci.length,
      0,
      `expected no unclassifiable_input findings against fixture root_a; ` +
        `got: ${JSON.stringify(uci)}`,
    );
  } finally {
    r.close();
  }
});

test('attributeSession: P_sum==0 triggers unclassifiable_input finding + zero uncached buckets', () => {
  // R5.4 fail-loud contract. When the Tokenizer returns
  // systemPrompt+history+toolOutput == 0 (every part is skipped or
  // unclassified), the Engine cannot do the proportional split —
  // dividing by 0 would produce NaN. The Engine instead emits a
  // schema_partial_data-class finding (kind: unclassifiable_input
  // per design.md:602-603) AND zeroes all three uncached buckets,
  // leaving tokens_input visibly unattributed in the
  // SessionAttribution but consistent (sum-correctness still
  // holds in the degenerate sense: 0+0+0 == 0 ≠ T_input, but the
  // INVARIANT is intentionally relaxed when the finding fires).
  //
  // Build a mock reader whose partsOfSession yields only
  // step-start parts (all skipped by the Tokenizer). The Engine
  // composes against the same SubagentAggregator+Tokenizer it
  // would use in production; only the reader is mocked so we can
  // inject the synthetic part stream.
  const synthetic = {
    id: 'ses_synth_unclassifiable',
    parent_id: null,
    directory: '/Users/test/synth',
    agent: 'build',
    model: 'claude-opus-4-7',
    tokens_input: 12345,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
    time_created: 1700000000000,
    time_updated: 1700000000001,
  };

  const mockReader = {
    partsOfSession(sessionId) {
      assert.equal(sessionId, synthetic.id);
      return [
        {
          id: 'prt_synth_0',
          message_id: 'msg_synth_0',
          session_id: synthetic.id,
          type: 'step-start',
          data: JSON.stringify({}),
          time_created: synthetic.time_created,
          time_updated: synthetic.time_created,
        },
      ];
    },
    messagesOfSession() {
      // No messages — the parts have no message_id resolution
      // path, but they're all skipped anyway.
      return [];
    },
    descendantSessionsOf() {
      return [];
    },
  };

  const eng = new AttributionEngine(
    mockReader,
    new SubagentAggregator(mockReader),
    new TokenizerSplitter(),
  );
  const attr = eng.attributeSession(synthetic);

  // Uncached sub-buckets all zero.
  assert.equal(attr.tokens.uncachedSystemPrompt, 0);
  assert.equal(attr.tokens.history, 0);
  assert.equal(attr.tokens.toolOutputs, 0);

  // unclassifiable_input finding emitted exactly once.
  const uci = attr.findings.filter((f) => f.kind === 'unclassifiable_input');
  assert.equal(
    uci.length,
    1,
    `expected exactly one unclassifiable_input finding when P_sum==0; ` +
      `got: ${JSON.stringify(attr.findings)}`,
  );

  // per_bucket_cost_deferred still emitted (it's unconditional).
  const pbcd = attr.findings.filter(
    (f) => f.kind === 'per_bucket_cost_deferred',
  );
  assert.equal(pbcd.length, 1);
});

test('attributeSession: unclassifiedCount > 0 triggers schema_partial_data with the count named', () => {
  // tasks.md:248-250 + design.md:595-599: when the Tokenizer
  // reports unclassifiedCount > 0 for a session, the Engine emits
  // exactly one schema_partial_data finding per session naming the
  // count. The task brief notes the part.type-name list is
  // acceptable as a placeholder for v1 (Tokenizer ProvenanceCounts
  // doesn't expose the type names); we just verify the count
  // shows up in the detail string.
  const synthetic = {
    id: 'ses_synth_unknown_types',
    parent_id: null,
    directory: '/Users/test/synth',
    agent: 'build',
    model: 'claude-opus-4-7',
    tokens_input: 100,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
    time_created: 1700000000000,
    time_updated: 1700000000001,
  };

  // A part list with both a classified text part (so P_sum > 0 and
  // the proportional math runs normally) AND an unknown-type part
  // (so unclassifiedCount > 0 and the finding fires).
  const mockReader = {
    partsOfSession() {
      return [
        {
          id: 'prt_a',
          message_id: 'msg_user',
          session_id: synthetic.id,
          type: 'text',
          data: JSON.stringify({ text: 'classified user text' }),
          time_created: 0,
          time_updated: 0,
        },
        {
          id: 'prt_b',
          message_id: 'msg_user',
          session_id: synthetic.id,
          type: 'totally-novel-type',
          data: JSON.stringify({ text: 'unknown bucket payload' }),
          time_created: 1,
          time_updated: 1,
        },
      ];
    },
    messagesOfSession() {
      return [
        {
          id: 'msg_user',
          session_id: synthetic.id,
          data: JSON.stringify({ role: 'user' }),
          role: 'user',
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
    mockReader,
    new SubagentAggregator(mockReader),
    new TokenizerSplitter(),
  );
  const attr = eng.attributeSession(synthetic);

  const spd = attr.findings.filter((f) => f.kind === 'schema_partial_data');
  assert.equal(
    spd.length,
    1,
    `expected exactly one schema_partial_data finding when ` +
      `unclassifiedCount > 0; got: ${JSON.stringify(attr.findings)}`,
  );
  // The count must appear somewhere in the detail string so the
  // operator can see it without consulting another source.
  assert.match(
    spd[0].detail,
    /\d+/,
    'finding detail must include the unclassifiedCount value',
  );
});

test('attributeSession: aggregator findings (e.g. cycle) flow through to SessionAttribution', () => {
  // Per task brief: "Aggregator's rollup() returns {totals,
  // findings} — flow the findings through to the SessionAttribution".
  // Verify with a mock aggregator that emits a synthetic finding;
  // the Engine must include it in attr.findings alongside its own.
  const synthetic = {
    id: 'ses_synth_cycle',
    parent_id: null,
    directory: '/Users/test/synth',
    agent: 'build',
    model: 'claude-opus-4-7',
    tokens_input: 100,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
    time_created: 1700000000000,
    time_updated: 1700000000001,
  };

  const mockReader = {
    partsOfSession() {
      return [
        {
          id: 'prt_a',
          message_id: 'msg_user',
          session_id: synthetic.id,
          type: 'text',
          data: JSON.stringify({ text: 'classified text' }),
          time_created: 0,
          time_updated: 0,
        },
      ];
    },
    messagesOfSession() {
      return [
        {
          id: 'msg_user',
          session_id: synthetic.id,
          data: JSON.stringify({ role: 'user' }),
          role: 'user',
          time_created: 0,
          time_updated: 0,
        },
      ];
    },
    descendantSessionsOf() {
      return [];
    },
  };

  const mockAggregator = {
    schemaSupportsParentLink: true,
    rollup(rootId) {
      assert.equal(rootId, synthetic.id);
      return {
        totals: { tokensTotal: 0, cost: 0, childCount: 0 },
        findings: [
          {
            kind: 'schema_partial_data',
            detail: 'mock aggregator cycle finding for ' + rootId,
          },
        ],
      };
    },
  };

  const eng = new AttributionEngine(
    mockReader,
    mockAggregator,
    new TokenizerSplitter(),
  );
  const attr = eng.attributeSession(synthetic);

  const cycle = attr.findings.filter(
    (f) =>
      f.kind === 'schema_partial_data' &&
      /mock aggregator cycle finding/.test(f.detail),
  );
  assert.equal(
    cycle.length,
    1,
    'aggregator-emitted findings must flow through into the SessionAttribution',
  );
});

test('attributeSession: does not cache state across calls (each call independent)', () => {
  // Task brief critical constraint: "Do NOT cache Attribution state
  // across calls". Two attributions in a row, both for the same
  // session, must produce equal-content but distinct findings
  // arrays — proves no shared mutable state.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const eng = buildEngine(r);
    const ses = getSession(r, 'ses_root_a');
    const a = eng.attributeSession(ses);
    const b = eng.attributeSession(ses);
    assert.notEqual(
      a.findings,
      b.findings,
      'each attributeSession call must return a fresh findings array',
    );
    assert.deepEqual(a.tokens, b.tokens);
    assert.deepEqual(a.cost, b.cost);
  } finally {
    r.close();
  }
});

test('attributeSession: BucketTotals contains all 8 keys per design.md:588-597', () => {
  // Defensive shape check: a future refactor that accidentally
  // omits one of the keys would silently break downstream
  // Reporter aggregation (4.2). Pin the contract here.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const ses = getSession(r, 'ses_root_a');
    const eng = buildEngine(r);
    const attr = eng.attributeSession(ses);
    const expectedKeys = [
      'cachedRead',
      'cachedWrite',
      'uncachedSystemPrompt',
      'history',
      'toolOutputs',
      'output',
      'reasoning',
      'subagentDispatch',
    ];
    for (const k of expectedKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(attr.tokens, k),
        `tokens.${k} must be present`,
      );
      assert.equal(typeof attr.tokens[k], 'number');
    }
    assert.deepEqual(
      Object.keys(attr.tokens).sort(),
      expectedKeys.slice().sort(),
      'tokens object must contain exactly the 8 documented keys (no extras)',
    );
  } finally {
    r.close();
  }
});
