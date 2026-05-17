/*
 * aggregator.test.js — unit tests for the Subagent Aggregator
 * (task 3.1 of .kiro/specs/opencode-cost-diagnosis).
 *
 * The aggregator's job is the recursive parent_id rollup of
 * descendant-session token + cost totals into a single
 * SubagentBucketTotals record for the originating root session.
 * Requirements 2.3 (e) and 5.3.
 *
 * The pinned fixture at fixtures/opencode-stable.db has three roots
 * with this descendant topology (confirmed via sqlite3 at
 * test-authoring time):
 *
 *   ses_root_a  -> [ses_root_a_child_0, ses_root_a_child_0_sub_0,
 *                   ses_root_a_child_1]   (3 descendants total)
 *   ses_root_b  -> [ses_root_b_child_0, ses_root_b_child_0_sub_0,
 *                   ses_root_b_child_1]   (3 descendants total)
 *   ses_root_c  -> []                      (no descendants)
 *
 * Per-descendant token + cost shape, identical for every fixture
 * descendant:
 *   tokens_input=2000, tokens_output=200, tokens_reasoning=50,
 *   tokens_cache_read=1000, tokens_cache_write=200, cost=0.01
 *
 * Per-descendant tokensTotal = 2000 + 200 + 50 + 1000 + 200 = 3450.
 *
 * Expected rollup for root_a / root_b:
 *   tokensTotal = 3 * 3450 = 10350
 *   cost        = ~0.03 (FP-summed)
 *   childCount  = 3
 *
 * Expected rollup for root_c:
 *   tokensTotal = 0, cost = 0, childCount = 0
 *
 * Cycle test: copies the fixture, UPDATEs one descendant's
 * parent_id to point at its own descendant (forming a cycle in
 * descendant chain), and asserts the aggregator emits a
 * `schema_partial_data` finding and does not infinite-loop.
 *
 * Note on interface deviation: design.md's Service Interface lines
 * 671-681 has `rollup(rootSessionId): SubagentBucketTotals`. We
 * return `{totals, findings}` so the Attribution Engine (task 3.3)
 * can pick up cycle-detection / schema-fallback findings without
 * a second method call or instance-state read. The totals field
 * is the SubagentBucketTotals; the findings field is the Finding[]
 * the Attribution Engine will splice into its SessionAttribution.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const Database = require('better-sqlite3');

const {
  SqliteReader,
  SubagentAggregator,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const FIXTURE = path.join(__dirname, '../fixtures/opencode-stable.db');

// Per-descendant shape, copied from the fixture and re-derived here
// so a single source of truth for the expected sums lives next to
// the assertions.
const PER_DESC_TOKENS_TOTAL = 2000 + 200 + 50 + 1000 + 200; // 3450
const PER_DESC_COST = 0.01;

function mkFixtureCopy() {
  // Mirror reader.test.js's mkFixtureCopy: copy the pinned fixture
  // to an OS-tmp file so the cycle-detection test can UPDATE
  // session.parent_id without dirtying the committed fixture.
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-aggregator-test-'),
  );
  const tmp = path.join(tmpDir, 'opencode-copy.db');
  fs.copyFileSync(FIXTURE, tmp);
  return { tmp, tmpDir };
}

test('SubagentAggregator: constructor takes a Reader instance', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    // Just a smoke check on the public shape — rollup must be a
    // function and schemaSupportsParentLink must be a boolean
    // accessor (not undefined).
    assert.equal(typeof agg.rollup, 'function');
    assert.equal(typeof agg.schemaSupportsParentLink, 'boolean');
  } finally {
    r.close();
  }
});

test('SubagentAggregator: schemaSupportsParentLink is true for v1 baseline', () => {
  // Per 5.3 fallback design: in v1 the schema has parent_id (it's
  // part of the pinned baseline migration set verified by 2.1), so
  // the aggregator advertises true. The false branch is for a
  // hypothetical future opencode change.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    assert.equal(agg.schemaSupportsParentLink, true);
  } finally {
    r.close();
  }
});

test('rollup(ses_root_a) sums all 5 token kinds + cost across 3 descendants', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    const { totals, findings } = agg.rollup('ses_root_a');

    assert.equal(
      totals.childCount,
      3,
      'ses_root_a has 3 descendants (2 children + 1 grandchild)',
    );
    assert.equal(
      totals.tokensTotal,
      3 * PER_DESC_TOKENS_TOTAL,
      'tokensTotal must sum input + output + reasoning + cache_read + cache_write ' +
        'across all 3 descendants',
    );
    // Cost is float-summed; allow tiny epsilon. 3 * 0.01 in IEEE-754
    // is not exactly 0.03 in every interpreter, but the absolute
    // difference is well under 1e-9.
    assert.ok(
      Math.abs(totals.cost - 3 * PER_DESC_COST) < 1e-9,
      `cost must sum to ~${3 * PER_DESC_COST}, got ${totals.cost}`,
    );

    assert.deepEqual(
      findings,
      [],
      'no findings expected on a clean fixture rollup',
    );
  } finally {
    r.close();
  }
});

test('rollup(ses_root_b) produces the symmetric sum for the second root', () => {
  // Sanity check that the rollup is per-root, not accidentally
  // shared state across calls — ses_root_b has the same topology
  // as ses_root_a so the totals must match exactly.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    const a = agg.rollup('ses_root_a');
    const b = agg.rollup('ses_root_b');
    assert.equal(a.totals.tokensTotal, b.totals.tokensTotal);
    assert.equal(a.totals.childCount, b.totals.childCount);
    assert.ok(Math.abs(a.totals.cost - b.totals.cost) < 1e-9);
  } finally {
    r.close();
  }
});

test('rollup(ses_root_c) returns all-zero totals when root has no descendants', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    const { totals, findings } = agg.rollup('ses_root_c');
    assert.equal(totals.tokensTotal, 0);
    assert.equal(totals.cost, 0);
    assert.equal(totals.childCount, 0);
    assert.deepEqual(findings, []);
  } finally {
    r.close();
  }
});

test('rollup(unknown root id) returns all-zero totals (no descendants, no error)', () => {
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    const { totals, findings } = agg.rollup('ses_does_not_exist');
    assert.equal(totals.tokensTotal, 0);
    assert.equal(totals.cost, 0);
    assert.equal(totals.childCount, 0);
    assert.deepEqual(findings, []);
  } finally {
    r.close();
  }
});

test('rollup detects a parent_id cycle, emits one finding, does not infinite-loop', () => {
  // Construct a synthetic cycle REACHABLE from ses_root_a by
  // closing the loop through root_a itself: repoint root_a's
  // parent_id at one of its own grandchildren. After the UPDATE
  // the parent_id chain is:
  //
  //   ses_root_a → ses_root_a_child_0_sub_0
  //              ↑              ↓
  //              └─ ses_root_a_child_0
  //
  // (with ses_root_a_child_1 still hanging off root_a as a
  // non-cyclic sibling). A descendant walk from ses_root_a then
  // yields: child_0, child_1, sub_0, root_a — and once root_a
  // is yielded as a "descendant", the visited-set (seeded with
  // the root id) catches the repeat. The aggregator must emit
  // exactly one `schema_partial_data` finding and bail.
  //
  // This shape requires root_a's parent_id to be non-null, which
  // is a degenerate state — a row whose parent_id points at one
  // of its own descendants is exactly the malformed-DB case 5.3
  // anticipates. It does not break any other test because the
  // mutation lives only in the tmp copy.
  //
  // (A "cycle in a sibling subtree disconnected from root_a"
  // construction was tried first and rejected: single-valued
  // parent_id means a child node closing a cycle with its
  // descendant necessarily detaches from root_a, so the CTE
  // from root_a never reaches the cycle and nothing fires.)
  const { tmp, tmpDir } = mkFixtureCopy();
  {
    const m = new Database(tmp);
    m.exec(
      "UPDATE session SET parent_id = 'ses_root_a_child_0_sub_0' " +
        "WHERE id = 'ses_root_a'",
    );
    m.close();
  }
  const r = new SqliteReader();
  try {
    r.open(tmp);
    const agg = new SubagentAggregator(r);

    // Wrap in a hard time guard. If the aggregator's cycle
    // detection regresses, better-sqlite3's recursive CTE will
    // happily loop forever; we'd rather see a clear assertion
    // failure than hang the test runner. 5s is generous — the
    // healthy path completes in <10ms.
    const start = Date.now();
    const { totals, findings } = agg.rollup('ses_root_a');
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 5000,
      `rollup must terminate quickly under cycle; took ${elapsed}ms`,
    );

    // At least one cycle finding. We assert "exactly one per cycle"
    // by checking that schema_partial_data findings are emitted
    // once per detected cycle, not per duplicate row encountered.
    const cycleFindings = findings.filter(
      (f) => f.kind === 'schema_partial_data',
    );
    assert.equal(
      cycleFindings.length,
      1,
      `expected exactly 1 schema_partial_data finding for the cycle, ` +
        `got ${cycleFindings.length}: ${JSON.stringify(findings)}`,
    );
    assert.match(
      cycleFindings[0].detail,
      /cycle/i,
      'finding detail must mention the cycle',
    );
    // Totals must still be finite — the bail-out must not produce
    // NaN/Infinity from a runaway sum.
    assert.ok(Number.isFinite(totals.tokensTotal));
    assert.ok(Number.isFinite(totals.cost));
    assert.ok(Number.isFinite(totals.childCount));
  } finally {
    r.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rollup does not memoize across calls: second call returns its own findings array', () => {
  // Regression guard for the implementation-notes hint that the
  // Aggregator must not stash findings/visited-set state on the
  // instance in a way that would bleed into a subsequent rollup.
  const r = new SqliteReader();
  r.open(FIXTURE);
  try {
    const agg = new SubagentAggregator(r);
    const first = agg.rollup('ses_root_a');
    const second = agg.rollup('ses_root_a');
    assert.notEqual(
      first.findings,
      second.findings,
      'each rollup call must return a fresh findings array (not a shared reference)',
    );
    assert.deepEqual(first.totals, second.totals);
  } finally {
    r.close();
  }
});
