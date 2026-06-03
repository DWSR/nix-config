/*
 * capability-model.test.js — UNIT tests for the observed-capability
 * model's confidence/source tagging + unobservable-class disclosure
 * (opencode-nono-audit spec, Task 2.2, Requirement 1.2).
 *
 * The integration suite (integration/audit-capabilities.test.js) already
 * exercises this behavior end-to-end through runAudit + the better-sqlite3
 * DB fixture. THIS suite drives the exported pure function
 * `extractCapabilities(reader)` directly against a tiny SYNTHETIC,
 * in-memory fake reader — no DB, no fixture, no I/O — to pin the
 * structured-key → high-confidence + source-tag mapping and the
 * inference-only → empty/disclosed invariants at the function boundary,
 * and to assert the frozen UNOBSERVABLE_CLASSES disclosure constant
 * independently of any audit run.
 *
 * The fake reader mirrors the three SqliteReader methods
 * extractCapabilities consumes (rootSessionsMatching / descendantSessionsOf
 * / partsOfSession). A "part" carries `.type` (so non-tool parts are
 * skipped) and `.data` (a JSON string parsed by the implementation).
 *
 * Lives under unit/ (run.js recurses everywhere except fixtures/ and
 * node_modules/).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCapabilities,
  UNOBSERVABLE_CLASSES,
} = require('../../../scripts/opencode-nono-audit.js');

// ────────────────────────────────────────────────────────────────────
// Synthetic fake reader: a pure in-memory stand-in for SqliteReader that
// extractCapabilities() iterates. `parts` maps a session id → an array
// of part objects ({ type, data }). Root/descendant topology is fixed by
// `roots` and `descendants`.
// ────────────────────────────────────────────────────────────────────

/**
 * Build a part object as the reader yields it: `type` plus a `data` JSON
 * string (the implementation re-parses data to read tool name + state).
 */
function toolPart(obj) {
  return { type: 'tool', data: JSON.stringify(obj) };
}

/**
 * @param {object} cfg
 * @param {string[]} cfg.roots root session ids
 * @param {Record<string,string[]>} [cfg.descendants] root id → descendant ids
 * @param {Record<string, Array<{type:string,data:string}>>} cfg.parts session id → parts
 */
function fakeReader(cfg) {
  const descendants = cfg.descendants || {};
  const parts = cfg.parts || {};
  return {
    rootSessionsMatching() {
      return cfg.roots.map((id) => ({ id }));
    },
    descendantSessionsOf(id) {
      return (descendants[id] || []).map((d) => ({ id: d }));
    },
    partsOfSession(id) {
      return parts[id] || [];
    },
  };
}

/** Find the record for a tool name. */
function recOf(records, tool) {
  return records.find((r) => r.tool === tool);
}

// ────────────────────────────────────────────────────────────────────
// 1. Structured keys → HIGH confidence + opencode-sqlite source tag
// ────────────────────────────────────────────────────────────────────

test('a structured command/path/url input yields HIGH confidence + opencode-sqlite source (R1.2)', () => {
  const reader = fakeReader({
    roots: ['root'],
    parts: {
      root: [
        toolPart({ tool: 'bash', state: { input: { command: 'git status' } } }),
        toolPart({ tool: 'read', state: { input: { filePath: '/tmp/a.js' } } }),
        toolPart({ tool: 'webfetch', state: { input: { url: 'https://x.invalid/d' } } }),
      ],
    },
  });

  const records = extractCapabilities(reader);

  const bash = recOf(records, 'bash');
  assert.ok(bash, 'expected a bash record');
  assert.deepEqual(bash.commands, ['git status'], 'bash command derived from structured key');
  assert.equal(bash.confidence, 'high', 'a structured command key → high confidence');
  assert.deepEqual(bash.sources, ['opencode-sqlite'], 'session-derived record tags opencode-sqlite');

  const read = recOf(records, 'read');
  assert.ok(read, 'expected a read record');
  assert.deepEqual(read.paths, ['/tmp/a.js'], 'path derived from structured filePath key');
  assert.equal(read.confidence, 'high', 'a structured path key → high confidence');

  const webfetch = recOf(records, 'webfetch');
  assert.ok(webfetch, 'expected a webfetch record');
  assert.deepEqual(webfetch.endpoints, ['https://x.invalid/d'], 'endpoint derived from url key');
  assert.equal(webfetch.confidence, 'high', 'a structured url key → high confidence');
});

// ────────────────────────────────────────────────────────────────────
// 2. Argless tool (name + count only, no structured args) → MEDIUM
//    confidence, all derived arrays empty (reliably observed but no
//    derivable capability surface).
// ────────────────────────────────────────────────────────────────────

test('an argless tool part (name + count, no structured args) is MEDIUM confidence with empty derived arrays (R1.2)', () => {
  const reader = fakeReader({
    roots: ['root'],
    parts: {
      root: [
        toolPart({ tool: 'mystery', state: { input: { opaque: true } } }),
        toolPart({ tool: 'mystery', state: { input: { opaque: false } } }),
      ],
    },
  });

  const records = extractCapabilities(reader);

  const mystery = recOf(records, 'mystery');
  assert.ok(mystery, 'expected a record for the argless tool (name + count reliable)');
  assert.equal(mystery.count, 2, 'count reflects the number of tool parts');
  assert.equal(mystery.confidence, 'medium', 'no structured args → confidence downgraded to medium');
  assert.deepEqual(mystery.commands, [], 'no command key → empty commands');
  assert.deepEqual(mystery.paths, [], 'no path key → empty paths');
  assert.deepEqual(mystery.endpoints, [], 'no url key → empty endpoints');
});

// ────────────────────────────────────────────────────────────────────
// 3. ports / envVars are inference-only → ALWAYS empty, even when the
//    structured input carries port-/env-looking keys. The unobservable
//    classes are disclosed via the frozen constant, NOT via these arrays.
// ────────────────────────────────────────────────────────────────────

test('ports and envVars stay empty even when input carries port/env-looking keys (inference-only, R1.2)', () => {
  const reader = fakeReader({
    roots: ['root'],
    parts: {
      root: [
        // A tool whose input mentions a port and env vars — these are NOT
        // structured capability keys, so they must never populate
        // ports/envVars (the classes are disclosed, not derived).
        toolPart({
          tool: 'server',
          state: { input: { command: 'serve', port: 8080, env: { TOKEN: 'x' } } },
        }),
      ],
    },
  });

  const records = extractCapabilities(reader);
  const server = recOf(records, 'server');
  assert.ok(server, 'expected a server record');
  assert.deepEqual(server.ports, [], 'ports are inference-only → always empty');
  assert.deepEqual(server.envVars, [], 'envVars are inference-only → always empty');
  // The structured command IS still derived (high confidence).
  assert.deepEqual(server.commands, ['serve'], 'the structured command is still derived');
  assert.equal(server.confidence, 'high');
});

// ────────────────────────────────────────────────────────────────────
// 4. Counts fold across root + descendant (sub-agent) sessions, and
//    structured values dedupe within a record.
// ────────────────────────────────────────────────────────────────────

test('tool parts fold across root and descendant sessions; duplicate structured values dedupe (R1.2)', () => {
  const reader = fakeReader({
    roots: ['root'],
    descendants: { root: ['sub'] },
    parts: {
      root: [toolPart({ tool: 'bash', state: { input: { command: 'ls' } } })],
      sub: [
        toolPart({ tool: 'bash', state: { input: { command: 'ls' } } }), // dup command
        toolPart({ tool: 'bash', state: { input: { command: 'pwd' } } }),
      ],
    },
  });

  const records = extractCapabilities(reader);
  const bash = recOf(records, 'bash');
  assert.ok(bash, 'expected a bash record folded across sessions');
  assert.equal(bash.count, 3, 'count folds across root + descendant sessions');
  assert.deepEqual(bash.commands, ['ls', 'pwd'], 'duplicate command values dedupe; order preserved');
});

// ────────────────────────────────────────────────────────────────────
// 5. Deterministic record ordering: sorted by tool name regardless of
//    observation order.
// ────────────────────────────────────────────────────────────────────

test('records are returned sorted by tool name regardless of observation order (R1.2 determinism)', () => {
  const reader = fakeReader({
    roots: ['root'],
    parts: {
      root: [
        toolPart({ tool: 'zeta', state: { input: { command: 'z' } } }),
        toolPart({ tool: 'alpha', state: { input: { command: 'a' } } }),
        toolPart({ tool: 'mid', state: { input: { command: 'm' } } }),
      ],
    },
  });

  const records = extractCapabilities(reader);
  const tools = records.map((r) => r.tool);
  assert.deepEqual(tools, ['alpha', 'mid', 'zeta'], 'records must be sorted by tool name');
});

// ────────────────────────────────────────────────────────────────────
// 6. UNOBSERVABLE_CLASSES is the frozen, sorted coverage-gap disclosure
//    constant — independent of any audit run. (population assertion)
// ────────────────────────────────────────────────────────────────────

test('UNOBSERVABLE_CLASSES is non-empty, sorted, and frozen (coverage-gap disclosure, R1.2)', () => {
  assert.ok(Array.isArray(UNOBSERVABLE_CLASSES), 'UNOBSERVABLE_CLASSES must be an array');
  assert.ok(UNOBSERVABLE_CLASSES.length > 0, 'must disclose at least one unobservable class');
  const sorted = [...UNOBSERVABLE_CLASSES].sort();
  assert.deepEqual([...UNOBSERVABLE_CLASSES], sorted, 'must be sorted for deterministic output');
  assert.ok(Object.isFrozen(UNOBSERVABLE_CLASSES), 'must be frozen (immutable disclosure constant)');
  // The inference-only classes the model deliberately cannot derive MUST
  // be disclosed here (port + env-var are the ports/envVars counterpart).
  assert.ok(UNOBSERVABLE_CLASSES.includes('port'), 'port must be disclosed as unobservable');
  assert.ok(UNOBSERVABLE_CLASSES.includes('env-var'), 'env-var must be disclosed as unobservable');
});
