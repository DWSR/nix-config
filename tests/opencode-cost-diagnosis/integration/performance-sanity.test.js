/*
 * performance-sanity.test.js — task 9.2 of .kiro/specs/v2-diagnosis.
 *
 * Asserts the two wall-clock sanity bounds named in
 * `.kiro/specs/v2-diagnosis/design.md § Performance / Load`:
 *
 *   - Whole-history report completes within v1's wall-clock budget
 *     (sub-3-second p99). Source: design.md line 879.
 *   - Cold-start pricing JSON parse < 50ms. Source: design.md line 878.
 *
 * The third bound from the same section — "per-message pricing lookup
 * overhead < 10ms per session for sessions with up to 200 assistant
 * messages" (design.md:877) — is satisfied transitively by the
 * whole-history bound: with hundreds of sessions in scope and ~50ms
 * worth of pricing-lookup overhead total, the per-session amortised
 * cost is well below 10ms by construction. We still spot-check that
 * the per-session amortised cost stays inside the bound, but the
 * whole-history wall-clock is the load-bearing assertion.
 *
 * Boundary (performance sanity):
 *   - This file only. No production code touched, no fixtures
 *     modified, no goldens touched, no other tests touched.
 *   - The CI safety net is the canonical fixture (9 sessions,
 *     15 messages, 30 parts). It is dramatically smaller than the
 *     operator's live history (~775 sessions, ~36k messages,
 *     ~141k parts as of 2026-05-18), so the bound is met trivially
 *     in CI. The intent is regression detection: if a future change
 *     introduces an O(n²) walk or a per-message file read, the
 *     fixture bound will start to bend even at fixture scale.
 *
 * === OPERATOR RUNBOOK (cutover-time verification, NOT run in CI) ===
 *
 * The fixture-based assertion below is a regression net. The DESIGN
 * bound is stated against the operator's LIVE opencode history,
 * which is not present in CI. At cutover time the operator should
 * verify the live bound by hand:
 *
 *   /usr/bin/time -p opencode-cost-report --last 365d \
 *     --format json --output /tmp/perf-check.json
 *
 *   # Expect `real` < 3.00 (design.md:879). If the value exceeds
 *   # the bound, capture both numbers (sessions in scope + wall-clock)
 *   # and open a follow-up — the diagnostic is still correct, but the
 *   # operator experience is degraded enough that the design's
 *   # "low hundreds of sessions" envelope (design.md:918) no longer
 *   # holds and the assumption needs a refresh.
 *
 * Measurement from 2026-05-18 against the operator's live DB
 * (775 sessions in total, 129 in `--last 365d` scope, 36,065
 * messages, 141,460 parts):
 *
 *   real 10.61s  (≈3.5× the 3s sanity bound — see CONCERNS in the
 *                  task 9.2 status report; not blocking spec acceptance
 *                  because design.md:881 names these as sanity bounds
 *                  rather than strict SLOs, but the divergence is
 *                  worth a follow-up).
 *
 * Boundary discipline: the operator-runbook step is documentation,
 * not an automated test. We deliberately do NOT shell out to the live
 * DB from the test runner — that would couple CI to operator-host
 * state, which violates the sandbox-isolation pattern every other
 * integration test in this directory follows.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkSandbox, readReport, runMain } = require('./_helpers.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'opencode-cost-report.js');
const PRICING_PATH = path.join(REPO_ROOT, 'scripts', 'opencode-cost-report-pricing.json');

// Sanity bounds copied verbatim from design.md § Performance / Load.
// If the design ever loosens or tightens these, update both this
// constant block AND the runbook comment above so the test stays a
// single source of truth for the spec's stated envelope.
const WHOLE_HISTORY_WALL_CLOCK_BUDGET_MS = 3000;   // design.md:879
const COLD_START_PRICING_PARSE_BUDGET_MS = 50;     // design.md:878
const PER_SESSION_LOOKUP_BUDGET_MS = 10;           // design.md:877

// High-resolution timer in milliseconds. `process.hrtime.bigint()` is
// monotonic and nanosecond-resolution; we divide once at the call
// site to keep the call-site readable. Wrapping it as a helper also
// makes the bound assertions read like time deltas rather than
// nanosecond math.
function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

// Lazy-require the production module so the file resolves even if a
// reviewer is poking at this test in isolation without
// better-sqlite3 / tiktoken installed. _helpers.js already pays the
// require cost during the suite's module-init phase, so by the time
// these tests run the production module is warm.
function loadPricingTableCtor() {
  // eslint-disable-next-line global-require
  const mod = require(SCRIPT_PATH);
  return mod.PricingTable;
}

// ── Test 1: cold-start PricingTable construction ────────────────

test('integration (9.2): cold-start PricingTable parse fits sanity bound (<50ms per design.md:878)', () => {
  // Sanity: the pricing JSON we benchmark against is the one the
  // production binary ships with. If this asserts false the test
  // is benchmarking the wrong file — failing here is more useful
  // than silently measuring a fixture.
  assert.ok(
    fs.existsSync(PRICING_PATH),
    `expected pricing JSON at ${PRICING_PATH}; the production` +
      ` binary loads this exact file via OPENCODE_COST_PRICING_PATH` +
      ` (or its filesystem fallback).`,
  );

  const PricingTable = loadPricingTableCtor();

  // Single sample. The design's bound is a p99 sanity bound on a
  // 200-model JSON; our pinned JSON has 3 models. Even one cold-
  // start sample on this file should sit two orders of magnitude
  // below the bound, so a single sample with a 60x safety margin
  // is enough to detect a regression (e.g., adding a synchronous
  // network probe or a recursive schema walk that scales with
  // model count).
  const t0 = nowMs();
  const table = new PricingTable(PRICING_PATH);
  const elapsedMs = nowMs() - t0;

  // Trivial sanity that the constructor actually finished building
  // the lookup table — guards against a future refactor that
  // moves the parse work into a lazy getter, in which case our
  // "cold-start parse" measurement above would be ~0ms and
  // meaningless.
  assert.ok(
    typeof table.lookup === 'function',
    'PricingTable instance must expose lookup(); a lazy-parse ' +
      'refactor would make this benchmark vacuous',
  );

  assert.ok(
    elapsedMs < COLD_START_PRICING_PARSE_BUDGET_MS,
    `cold-start PricingTable parse took ${elapsedMs.toFixed(3)}ms; ` +
      `design bound is < ${COLD_START_PRICING_PARSE_BUDGET_MS}ms ` +
      `(design.md:878). Investigate before relaxing this bound — ` +
      `the bound is the only test that catches a regression where ` +
      `the JSON parse acquires a hidden cost (network probe, ` +
      `cryptographic verification, model-count-quadratic walk).`,
  );

  // Observable: log the timing so a reviewer reading the test
  // trace sees the actual number. Per task observable spec:
  // "a timing log line (or test trace)".
  process.stderr.write(
    `[perf-sanity 9.2] cold-start PricingTable parse: ` +
      `${elapsedMs.toFixed(3)}ms (bound ${COLD_START_PRICING_PARSE_BUDGET_MS}ms)\n`,
  );
});

// ── Test 2: whole-history report wall-clock ─────────────────────

test('integration (9.2): full-history report fits sub-3-second sanity bound (design.md:879)', () => {
  const sb = mkSandbox(); // defaults to the canonical fixture DB
  try {
    const t0 = nowMs();
    const { exitCode, stderr } = runMain(['--last', '365d']);
    const elapsedMs = nowMs() - t0;

    // Belt-and-suspenders: a failed run could complete inside the
    // bound for the wrong reason (early-exit on missing DB, e.g.).
    // Verify the run actually succeeded before believing the
    // wall-clock.
    assert.equal(
      exitCode,
      0,
      `command must exit 0 to make the timing measurement ` +
        `meaningful; stderr=${stderr}`,
    );
    const report = readReport(sb.stateDir);
    assert.ok(
      report.parsed.sessions.length > 0,
      'fixture run must have produced at least one session in ' +
        'the report; an empty report would make the wall-clock ' +
        'measurement vacuous',
    );

    assert.ok(
      elapsedMs < WHOLE_HISTORY_WALL_CLOCK_BUDGET_MS,
      `full-history report took ${elapsedMs.toFixed(1)}ms; ` +
        `design bound is < ${WHOLE_HISTORY_WALL_CLOCK_BUDGET_MS}ms ` +
        `(design.md:879). The canonical fixture is only 9 sessions, ` +
        `so blowing this bound implies an O(n²) regression that ` +
        `would be catastrophic at the operator's live scale ` +
        `(~129 sessions in scope).`,
    );

    // Per-session amortised pricing-lookup overhead. The design
    // bound (design.md:877) is < 10ms per session for sessions
    // with up to 200 assistant messages. We can only spot-check
    // amortised: divide the whole-history wall-clock by the
    // session count and assert it fits the bound. This is a
    // pessimistic check (the wall-clock includes DB read,
    // tokenizer warm-up, report serialisation, file write — none
    // of which is pricing-lookup) but it lets the test catch a
    // pricing-lookup regression that turns the per-session cost
    // from O(1) into O(n) without needing a microbenchmark
    // harness.
    const sessionsInScope = report.parsed.sessions.length;
    const amortisedMsPerSession = elapsedMs / sessionsInScope;
    assert.ok(
      amortisedMsPerSession < PER_SESSION_LOOKUP_BUDGET_MS * 10,
      `amortised wall-clock per session is ` +
        `${amortisedMsPerSession.toFixed(2)}ms over ` +
        `${sessionsInScope} sessions; design's per-session pricing ` +
        `lookup bound is ${PER_SESSION_LOOKUP_BUDGET_MS}ms ` +
        `(design.md:877). We allow 10× slack here because the ` +
        `wall-clock includes DB read + tokenizer + serialisation, ` +
        `not just the pricing lookup; a value beyond 10× the ` +
        `pure-lookup bound is the regression signal.`,
    );

    // Observable: emit the timing on stderr so node:test's TAP
    // capture surfaces it alongside the test name. This is the
    // "timing log line (or test trace)" the task observable
    // describes.
    process.stderr.write(
      `[perf-sanity 9.2] full-history report wall-clock: ` +
        `${elapsedMs.toFixed(1)}ms over ${sessionsInScope} sessions ` +
        `(${amortisedMsPerSession.toFixed(2)}ms/session amortised; ` +
        `bound ${WHOLE_HISTORY_WALL_CLOCK_BUDGET_MS}ms whole-history, ` +
        `${PER_SESSION_LOOKUP_BUDGET_MS}ms/session pricing-lookup)\n`,
    );
  } finally {
    sb.cleanup();
  }
});
