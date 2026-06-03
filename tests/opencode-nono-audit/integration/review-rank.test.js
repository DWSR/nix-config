/*
 * review-rank.test.js — tests for the Tool-Use Replacement Review's
 * RANK + SEED layer (opencode-nono-audit spec, Task 4.1, Requirements
 * 3.1, 3.2, 3.3).
 *
 * Task 4.1 adds the deterministic tool-use ranker and the seeded
 * MCP-replacement candidate list over a UsageAudit's capability model:
 *
 *   - rankToolUse(audit) → RankedToolUse[]
 *       RankedToolUse = { tool, count, riskScore, rank }
 *       riskScore = count × capabilityRisk (static map; documented
 *       weights high=3 / medium=2 / low=1). Sorted by riskScore desc,
 *       tie-break count desc then tool name asc; contiguous 1-based ranks.
 *   - seedReplacementCandidates(audit) → ReplacementCandidate[]
 *       ReplacementCandidate = { tool, mcpCandidate?, rationale }
 *       git → Git MCP MUST be seeded; tools/categories with no known MCP
 *       candidate are marked "no viable replacement".
 *
 * Git is recognized by COMMAND PATTERN — bash commands whose program
 * token is `git` form a `git` category whose count = number of git
 * commands observed. The repo ships a git-mcp-server, so the candidate
 * name is git-mcp-server.
 *
 * Scope (4.1): RANK + SEED only. The decisions ledger (keep/replace/
 * defer/none reconciliation) is task 4.2; reporting + redaction are 5.x.
 *
 * Lives under integration/ (NOT fixtures/) so run.js's discoverTestFiles()
 * picks it up. runAudit resolves SqliteReader by relative path under
 * `node --test`, so no env setup is needed here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  runAudit,
  rankToolUse,
  seedReplacementCandidates,
  CAPABILITY_RISK,
  RISK_WEIGHTS,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');

/** Build the UsageAudit once from the valid session fixture. */
function loadAudit() {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true, `audit must succeed; got ${JSON.stringify(res)}`);
  return res.value;
}

/** Find a ranked entry by tool name. */
function rankedOf(ranked, tool) {
  return ranked.find((r) => r.tool === tool);
}

/** Find a candidate by a predicate over its tool name. */
function candidateMatching(candidates, pred) {
  return candidates.find((c) => pred(c.tool));
}

// ────────────────────────────────────────────────────────────────────
// 1. Ranking is deterministic, well-formed, and correctly ordered (R3.1)
// ────────────────────────────────────────────────────────────────────

test('rankToolUse produces a deterministic, well-formed ranked list ordered by riskScore desc with documented tie-break (R3.1)', () => {
  const audit = loadAudit();

  const a = rankToolUse(audit);
  const b = rankToolUse(audit);

  assert.ok(Array.isArray(a), 'rankToolUse must return an array');
  assert.ok(a.length >= 1, 'expected at least one ranked entry over the fixture');

  // Deterministic: two runs produce identical output (same order + values).
  assert.deepEqual(a, b, 'rankToolUse must be deterministic across runs');

  // Each entry is well-formed: tool/count/riskScore/rank present, correct types.
  for (const entry of a) {
    assert.equal(typeof entry.tool, 'string');
    assert.ok(entry.tool.length > 0, 'tool must be non-empty');
    assert.equal(typeof entry.count, 'number');
    assert.ok(entry.count >= 1, 'count must be >= 1');
    assert.equal(typeof entry.riskScore, 'number');
    assert.equal(typeof entry.rank, 'number');
  }

  // Ordered by riskScore desc; tie-break is count desc then tool name asc.
  for (let i = 1; i < a.length; i += 1) {
    const prev = a[i - 1];
    const cur = a[i];
    if (prev.riskScore !== cur.riskScore) {
      assert.ok(
        prev.riskScore > cur.riskScore,
        `riskScore must be non-increasing; ${prev.tool}(${prev.riskScore}) before ${cur.tool}(${cur.riskScore})`,
      );
    } else if (prev.count !== cur.count) {
      assert.ok(
        prev.count > cur.count,
        `tie on riskScore must break by count desc; ${prev.tool}(${prev.count}) before ${cur.tool}(${cur.count})`,
      );
    } else {
      assert.ok(
        prev.tool < cur.tool,
        `tie on riskScore+count must break by tool name asc; ${prev.tool} before ${cur.tool}`,
      );
    }
  }

  // Ranks are contiguous 1-based in list order.
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].rank, i + 1, `rank must be 1-based contiguous; entry ${i} had rank ${a[i].rank}`);
  }
});

// ────────────────────────────────────────────────────────────────────
// 2. riskScore math is correct for known fixture tools (R3.1)
// ────────────────────────────────────────────────────────────────────

test('riskScore = count × capabilityRisk for known fixture tools (bash high; read low; git high) (R3.1)', () => {
  const audit = loadAudit();
  const ranked = rankToolUse(audit);

  const high = RISK_WEIGHTS.high;
  const low = RISK_WEIGHTS.low;
  assert.ok(high > low, 'high weight must exceed low weight (documented constants)');

  // bash: 4 tool parts in the fixture, static risk high.
  const bash = rankedOf(ranked, 'bash');
  assert.ok(bash, 'expected a bash ranked entry');
  assert.equal(bash.count, 4, 'fixture has four bash tool parts');
  assert.equal(CAPABILITY_RISK.bash, 'high', 'bash must be classified high in the static map');
  assert.equal(bash.riskScore, bash.count * high, 'bash riskScore = count × high-weight');

  // read: 1 tool part, static risk low.
  const read = rankedOf(ranked, 'read');
  assert.ok(read, 'expected a read ranked entry');
  assert.equal(read.count, 1, 'fixture has one read tool part');
  assert.equal(CAPABILITY_RISK.read, 'low', 'read must be classified low in the static map');
  assert.equal(read.riskScore, read.count * low, 'read riskScore = count × low-weight');

  // git: recognized by command program token — `git status` + `git clone`
  // → count 2, static risk high.
  const git = rankedOf(ranked, 'git');
  assert.ok(git, 'expected a git ranked entry (recognized by command program token)');
  assert.equal(git.count, 2, 'fixture has two git commands (git status, git clone)');
  assert.equal(CAPABILITY_RISK.git, 'high', 'git must be classified high in the static map');
  assert.equal(git.riskScore, git.count * high, 'git riskScore = count × high-weight');
});

// ────────────────────────────────────────────────────────────────────
// 3. Seeded candidates surface git → Git MCP (R3.2 — the observable)
// ────────────────────────────────────────────────────────────────────

test('seedReplacementCandidates surfaces the git → Git MCP candidate (R3.2 observable)', () => {
  const audit = loadAudit();
  const candidates = seedReplacementCandidates(audit);

  assert.ok(Array.isArray(candidates), 'seedReplacementCandidates must return an array');
  assert.ok(candidates.length >= 1, 'expected at least one candidate over the fixture');

  // Deterministic: stable order across runs.
  const again = seedReplacementCandidates(audit);
  assert.deepEqual(candidates, again, 'candidate list must be deterministic across runs');

  // The git → Git MCP candidate MUST be present.
  const git = candidateMatching(candidates, (t) => /git/i.test(t));
  assert.ok(git, `expected a git-related replacement candidate; saw ${JSON.stringify(candidates.map((c) => c.tool))}`);
  assert.equal(git.tool, 'git', 'the git candidate is keyed on the git category');
  assert.equal(typeof git.mcpCandidate, 'string');
  assert.ok(git.mcpCandidate.length > 0, 'git candidate must name an MCP replacement');
  assert.ok(
    /git/i.test(git.mcpCandidate),
    `git candidate must point at a Git MCP server; saw ${git.mcpCandidate}`,
  );
  assert.equal(typeof git.rationale, 'string');
  assert.ok(git.rationale.length > 0, 'every candidate must carry a rationale');
});

// ────────────────────────────────────────────────────────────────────
// 4. A tool/category with no known MCP candidate is marked
//    "no viable replacement" (R3.3)
// ────────────────────────────────────────────────────────────────────

test('a tool with no known MCP candidate is marked "no viable replacement" (R3.3)', () => {
  const audit = loadAudit();
  const candidates = seedReplacementCandidates(audit);

  // `read` has no known MCP replacement in the seed map → it must appear
  // as a candidate with NO mcpCandidate and a "no viable replacement"
  // rationale.
  const read = candidateMatching(candidates, (t) => t === 'read');
  assert.ok(read, `expected a read candidate echoing "no viable replacement"; saw ${JSON.stringify(candidates.map((c) => c.tool))}`);
  assert.equal(
    typeof read.mcpCandidate,
    'undefined',
    'a tool with no known MCP replacement must omit mcpCandidate',
  );
  assert.equal(typeof read.rationale, 'string');
  assert.ok(
    /no viable replacement/i.test(read.rationale),
    `read rationale must state "no viable replacement"; saw ${read.rationale}`,
  );

  // Every candidate without an mcpCandidate must carry the "no viable
  // replacement" marker (no silent gaps).
  for (const c of candidates) {
    if (typeof c.mcpCandidate === 'undefined') {
      assert.ok(
        /no viable replacement/i.test(c.rationale),
        `candidate ${c.tool} lacks an mcpCandidate but does not state "no viable replacement"`,
      );
    }
  }
});
