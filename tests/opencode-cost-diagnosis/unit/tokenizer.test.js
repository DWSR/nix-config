/*
 * tokenizer.test.js — unit tests for the Tokenizer Splitter
 * (task 3.2 of .kiro/specs/opencode-cost-diagnosis).
 *
 * Acceptance: requirements.md 2.3 (b/c/d) + 2.9; design.md Tokenizer
 * Splitter component (lines 692-764) and classification rules
 * (lines 760-784).
 *
 * The Splitter takes a `parts` iterable + a `messages` Map keyed by
 * message.id (with `role` pre-parsed by SqliteReader.messagesOfSession)
 * and returns ProvenanceCounts { systemPrompt, history, toolOutput,
 * unclassifiedCount }. It MUST:
 *
 *   - lazy-init tiktoken's `cl100k_base` encoder on the first
 *     classifyAndCount() call (NOT in the constructor), and reuse
 *     the same encoder for the process lifetime
 *   - classify text parts by message role (system → systemPrompt;
 *     user|assistant → history)
 *   - classify tool parts whose data.state.output is a non-empty
 *     string into toolOutput
 *   - skip reasoning, step-start, step-finish, compaction, agent,
 *     patch, file parts entirely (zero contribution to ANY bucket,
 *     not even unclassifiedCount)
 *   - send anything else into unclassifiedCount (the 5.3
 *     fail-loud-not-silent path: the Attribution Engine in task 3.3
 *     turns nonzero unclassifiedCount into a schema_partial_data
 *     finding)
 *
 * Tests cover both the published observable in tasks.md:220-226 (one
 * text part per role + tool + reasoning + unknown-type → 3 classified
 * buckets > 0 AND unclassifiedCount > 0 AND reasoning leaks
 * nowhere) and the per-rule edge cases (empty parts, every skip
 * type, lazy init).
 *
 * Real-data verification uses the pinned 1.6 fixture's `ses_root_a`
 * session, which contains exactly the part shape the spec was built
 * around: system text + user text + assistant text + tool (with
 * state.output) + reasoning + step-finish. unclassifiedCount must be
 * 0 against that session — every part type the fixture emits is
 * classified or explicitly skipped.
 *
 * Synthetic in-memory tests mirror the on-disk shape: `part.data`
 * is a JSON string (not a parsed object), matching what
 * `SqliteReader.partsOfSession` returns from better-sqlite3. The
 * Tokenizer is responsible for parsing it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  SqliteReader,
  TokenizerSplitter,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

// Helper: materialize a session's parts + role-keyed messages map
// from the fixture, exactly as the Attribution Engine (task 3.3)
// will do at runtime before invoking classifyAndCount.
function loadSession(reader, sessionId) {
  const parts = [...reader.partsOfSession(sessionId)];
  const messages = new Map();
  for (const m of reader.messagesOfSession(sessionId)) {
    messages.set(m.id, m);
  }
  return { parts, messages };
}

test('TokenizerSplitter: constructor does not eagerly initialize the encoder', () => {
  const t = new TokenizerSplitter();
  // White-box check on the instance field documented in the task
  // brief's lazy-init pattern. The point of lazy init is that the
  // CLI's argument-parser path (5.x) can construct a Tokenizer
  // without paying the tiktoken initialization cost when no session
  // ends up being tokenized (e.g. --help, --supported-opencode-version).
  assert.equal(
    t._encoding,
    null,
    'encoder must be null until the first classifyAndCount() call',
  );
});

test('TokenizerSplitter: lazy-init populates the encoder on first call and reuses it', () => {
  const t = new TokenizerSplitter();
  assert.equal(t._encoding, null);

  // First call: populates _encoding. Empty inputs are fine — we are
  // probing the init-on-first-use behavior, not classification.
  t.classifyAndCount([], new Map());
  const first = t._encoding;
  assert.notEqual(
    first,
    null,
    'first classifyAndCount call must initialize the encoder',
  );

  // Second call: MUST reuse the same encoder instance. If the
  // implementation re-`get_encoding`d every call we'd leak memory
  // (tiktoken's encoder has a non-trivial native buffer) and burn
  // ~5-10ms of startup per session aggregated over a multi-root
  // report.
  t.classifyAndCount([], new Map());
  assert.equal(
    t._encoding,
    first,
    'second classifyAndCount call must reuse the cached encoder reference',
  );
});

test('TokenizerSplitter: empty parts list returns all-zero ProvenanceCounts', () => {
  const t = new TokenizerSplitter();
  const counts = t.classifyAndCount([], new Map());
  assert.deepEqual(
    counts,
    { systemPrompt: 0, history: 0, toolOutput: 0, unclassifiedCount: 0 },
    'zero parts must produce all-zero counts with all four keys present',
  );
});

test('TokenizerSplitter: classifies fixture root session A into systemPrompt + history + toolOutput', () => {
  const reader = new SqliteReader();
  reader.open(FIXTURE);
  try {
    const { parts, messages } = loadSession(reader, 'ses_root_a');
    const t = new TokenizerSplitter();
    const counts = t.classifyAndCount(parts, messages);

    assert.ok(
      counts.systemPrompt > 0,
      'fixture system-role text part must contribute to systemPrompt',
    );
    assert.ok(
      counts.history > 0,
      'fixture user + assistant text parts must contribute to history',
    );
    assert.ok(
      counts.toolOutput > 0,
      'fixture tool part with state.output must contribute to toolOutput',
    );
    assert.equal(
      counts.unclassifiedCount,
      0,
      'fixture root session A contains no unknown part.type values; ' +
        'unclassifiedCount must be exactly 0',
    );
  } finally {
    reader.close();
  }
});

test('TokenizerSplitter: reasoning parts do not contribute to any bucket', () => {
  const t = new TokenizerSplitter();
  const messages = new Map([
    ['m1', { id: 'm1', role: 'assistant' }],
  ]);

  // A→B differential: identical parts list except B adds a reasoning
  // part with non-trivial text. If the Tokenizer leaks reasoning
  // into ANY of the four counts the deepEqual fails. Token-positive
  // text ensures the leak would be detectable.
  const baseParts = [
    {
      message_id: 'm1',
      type: 'text',
      data: JSON.stringify({ text: 'Hello there, this is assistant output.' }),
    },
  ];
  const withReasoning = [
    ...baseParts,
    {
      message_id: 'm1',
      type: 'reasoning',
      data: JSON.stringify({
        text: 'Internal chain-of-thought that must not be billed as input.',
      }),
    },
  ];

  const base = t.classifyAndCount(baseParts, messages);
  const withR = t.classifyAndCount(withReasoning, messages);
  assert.deepEqual(
    withR,
    base,
    'adding a reasoning part must not change systemPrompt, history, ' +
      'toolOutput, or unclassifiedCount',
  );
});

test('TokenizerSplitter: metadata part types (step-*, compaction, agent, patch, file) are all skipped', () => {
  const t = new TokenizerSplitter();
  const messages = new Map([
    ['m1', { id: 'm1', role: 'assistant' }],
  ]);

  const skipped = [
    'step-start',
    'step-finish',
    'compaction',
    'agent',
    'patch',
    'file',
  ];
  const parts = skipped.map((type) => ({
    message_id: 'm1',
    type,
    // Token-positive content so a leak into any bucket would show.
    data: JSON.stringify({ text: `metadata payload for ${type}` }),
  }));

  const counts = t.classifyAndCount(parts, messages);
  assert.deepEqual(
    counts,
    { systemPrompt: 0, history: 0, toolOutput: 0, unclassifiedCount: 0 },
    'design.md:779-780 metadata part types must contribute zero to every bucket',
  );
});

test('TokenizerSplitter: unknown part.type values accrue tokens to unclassifiedCount', () => {
  const t = new TokenizerSplitter();
  const messages = new Map([
    ['m1', { id: 'm1', role: 'assistant' }],
  ]);

  const parts = [
    {
      message_id: 'm1',
      type: 'futuristic-future-type',
      data: JSON.stringify({ text: 'novel content for an unknown type' }),
    },
  ];

  const counts = t.classifyAndCount(parts, messages);
  assert.equal(counts.systemPrompt, 0);
  assert.equal(counts.history, 0);
  assert.equal(counts.toolOutput, 0);
  assert.ok(
    counts.unclassifiedCount > 0,
    'unknown part.type must accrue tokens to unclassifiedCount, ' +
      'not be silently dropped (design.md:781-783; R5.4 fail-loud contract)',
  );
});

test('TokenizerSplitter: tool part without state.output does not contribute to toolOutput', () => {
  const t = new TokenizerSplitter();
  const messages = new Map([
    ['m1', { id: 'm1', role: 'assistant' }],
  ]);

  // A tool part still in 'running' or 'pending' state, with no output
  // body, should produce 0 toolOutput tokens — the design rule says
  // "AND part.data.state.output present".
  const parts = [
    {
      message_id: 'm1',
      type: 'tool',
      data: JSON.stringify({
        tool: 'bash',
        state: { status: 'pending', input: { command: 'ls' } },
      }),
    },
  ];

  const counts = t.classifyAndCount(parts, messages);
  assert.equal(
    counts.toolOutput,
    0,
    'tool part without state.output must contribute 0 toolOutput tokens',
  );
});

test('TokenizerSplitter: combined observable (task brief 220-226) — one part per role + tool + reasoning + unknown-type', () => {
  // Mirrors the published task observable exactly: system text +
  // user text + assistant text + tool-with-output + reasoning +
  // unknown-type. Verifies all four observable conditions in a
  // single call:
  //   - systemPrompt > 0
  //   - history > 0 (sum of user + assistant)
  //   - toolOutput > 0
  //   - unclassifiedCount > 0
  //   - reasoning leaks into none of the above
  const t = new TokenizerSplitter();
  const messages = new Map([
    ['m_sys', { id: 'm_sys', role: 'system' }],
    ['m_usr', { id: 'm_usr', role: 'user' }],
    ['m_ast', { id: 'm_ast', role: 'assistant' }],
  ]);
  const parts = [
    {
      message_id: 'm_sys',
      type: 'text',
      data: JSON.stringify({ text: 'You are a helpful assistant.' }),
    },
    {
      message_id: 'm_usr',
      type: 'text',
      data: JSON.stringify({ text: 'Please answer briefly.' }),
    },
    {
      message_id: 'm_ast',
      type: 'text',
      data: JSON.stringify({ text: 'Sure, here is the answer.' }),
    },
    {
      message_id: 'm_ast',
      type: 'tool',
      data: JSON.stringify({
        tool: 'bash',
        state: { status: 'completed', output: 'tool output body text' },
      }),
    },
    {
      message_id: 'm_ast',
      type: 'reasoning',
      data: JSON.stringify({ text: 'reasoning trace that must be skipped' }),
    },
    {
      message_id: 'm_ast',
      type: 'something-novel',
      data: JSON.stringify({ text: 'unknown bucket content' }),
    },
  ];

  const counts = t.classifyAndCount(parts, messages);
  assert.ok(counts.systemPrompt > 0, 'systemPrompt > 0');
  assert.ok(counts.history > 0, 'history > 0 (user + assistant text combined)');
  assert.ok(counts.toolOutput > 0, 'toolOutput > 0');
  assert.ok(counts.unclassifiedCount > 0, 'unclassifiedCount > 0');

  // Differential check: removing only the reasoning part must not
  // change any count. Combined with the per-bucket > 0 asserts
  // above, this proves reasoning leaks into none of the four
  // counters (including unclassifiedCount, which would be a
  // misclassification, not just leakage).
  const withoutReasoning = parts.filter((p) => p.type !== 'reasoning');
  const countsNR = t.classifyAndCount(withoutReasoning, messages);
  assert.deepEqual(
    counts,
    countsNR,
    'removing the reasoning part must leave every count unchanged',
  );

  // The history bucket must equal the sum of two independent
  // assistant-only and user-only sub-runs — proves user + assistant
  // text both map to history (not just one of them).
  const userOnly = t.classifyAndCount(
    [parts[1]],
    messages,
  );
  const assistantOnly = t.classifyAndCount(
    [parts[2]],
    messages,
  );
  assert.equal(
    counts.history,
    userOnly.history + assistantOnly.history,
    'history must equal sum(user-text-tokens, assistant-text-tokens)',
  );
});

test('TokenizerSplitter: text part with role lookup miss (missing message) is unclassified, not silently buckected', () => {
  // Defensive: if Attribution Engine somehow passes a parts list
  // whose message_ids don't all exist in the messages Map, the
  // Tokenizer must not silently drop the text into a "default"
  // bucket. The design's fail-loud contract (5.4) means anything
  // unrecognized goes to unclassifiedCount so 3.3 can surface a
  // schema_partial_data finding.
  const t = new TokenizerSplitter();
  const messages = new Map(); // intentionally empty: no message rows
  const parts = [
    {
      message_id: 'm_missing',
      type: 'text',
      data: JSON.stringify({ text: 'text whose role cannot be resolved' }),
    },
  ];
  const counts = t.classifyAndCount(parts, messages);
  assert.equal(counts.systemPrompt, 0);
  assert.equal(counts.history, 0);
  assert.equal(counts.toolOutput, 0);
  assert.ok(
    counts.unclassifiedCount > 0,
    'text part with no resolvable role must NOT be silently bucketed; ' +
      'go to unclassifiedCount so the Attribution Engine can flag it',
  );
});
