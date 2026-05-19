/*
 * forward-compat.test.js — v1→v2 structural forward-compatibility
 * verification, per task 9.1 of .kiro/specs/v2-diagnosis/tasks.md.
 *
 * Covers Requirements 1.1-1.5 (drop-in replacement, including the
 * file-permission posture in 1.5) and 7.1-7.5 (additive JSON schema,
 * byte-identical determinism, sum-correctness invariants preserved,
 * findings preserved, null-to-value transition shape preserved).
 *
 * The task observable enumerates six labeled PASS/FAIL checks:
 *
 *   v1-keys-present       — every key in v1 JSON is present in v2 JSON
 *                           with the same type and the same alphabetical
 *                           position (R7.AC1)
 *   alphabetical-ordering — every object in v2 has its keys in
 *                           alphabetical order at every level (R7.AC2
 *                           byte-identical determinism precondition)
 *   findings-preserved    — every distinct finding `kind` code from v1
 *                           still appears in v2 (R7.AC4)
 *   null-to-value         — each cost field v1 emitted as `null` is now
 *                           a number in v2 for every matched-pricing
 *                           session, with name/position unchanged
 *                           (R7.AC5)
 *   no-generatedAt-in-json — the literal substring `"generatedAt"` does
 *                           NOT appear in v2 JSON output (R7.AC2 — wall
 *                           clock stays out of the JSON; cf. design.md
 *                           line 690)
 *   file-permission-0600  — the report files the CLI writes have
 *                           mode 0o600 (R1.AC5)
 *
 * Each check is a discrete `test()` so node:test's TAP output IS the
 * labeled PASS/FAIL checklist. The test names embed the exact label so
 * grepping the TAP stream gives the operator the same view the
 * observable describes.
 *
 * Tooth-check / self-verification: the helpers `walkV1KeysPresent`,
 * `walkAlphabeticalOrdering`, `collectFindingKinds`, `walkNullToValue`
 * are exported via a private hook AND exercised against in-memory
 * perturbed inputs at the bottom of this file. This guards against the
 * verification-mode TDD trap where every assertion vacuously passes
 * because the v1 and v2 goldens are committed in a healthy state — if
 * a helper had no teeth, the perturbation test would not catch the
 * regression and would PASS where it should FAIL.
 *
 * Boundary: this file ONLY reads goldens at
 * tests/opencode-cost-diagnosis/integration/golden/ and writes report
 * files into a per-test sandbox via mkSandbox(). No production-code
 * mutation. No mutation of the committed v1 / v2 goldens.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  GOLDEN_DIR,
  mkSandbox,
  readReport,
  runMain,
} = require('./_helpers.js');

const V1_GOLDEN_JSON_PATH = path.join(GOLDEN_DIR, 'fixture-365d-all-v1.json');
const V2_GOLDEN_JSON_PATH = path.join(GOLDEN_DIR, 'fixture-365d-all.json');

// Lazy-loaded so the test file can be `require()`d even if a golden
// transiently doesn't exist (e.g. before 8.1 has been re-run). The
// individual tests assert presence before reading.
function readJsonGolden(p) {
  assert.ok(
    fs.existsSync(p),
    `expected golden file at ${p}; was task 8.1 run? regenerate with UPDATE_GOLDEN=1`,
  );
  const raw = fs.readFileSync(p, 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

// ── Recursive verification helpers ──────────────────────────────

/**
 * Walk every object in `v1` and assert that every key is present on
 * the same path in `v2` with the same JavaScript type. For arrays,
 * recurse into element index 0 (the v1/v2 goldens commit object
 * shapes that are uniform within an array; per-element divergence
 * inside an array would itself be a v1/v2 regression).
 *
 * "Same type" means typeof check on primitives, Array.isArray() for
 * arrays, and bare object for plain objects. NULL values in v1 are
 * allowed to become NUMBERS in v2 — this is the R7.AC5
 * null-to-value transition that's explicitly carved out — so when
 * v1[key] is null we only assert v2 has a defined value (any type),
 * and the null-to-value test pins the specific type transition.
 *
 * Throws AssertionError with a path-qualified message on the first
 * violation; callers wrap in assert.doesNotThrow to convert into a
 * test PASS/FAIL.
 */
function walkV1KeysPresent(v1, v2, ctxPath) {
  if (v1 === null || v1 === undefined) {
    // v1 explicitly null — v2 may carry a value; the null-to-value
    // test inspects the type transition separately.
    return;
  }
  if (Array.isArray(v1)) {
    assert.ok(
      Array.isArray(v2),
      `${ctxPath}: v1 is an array; v2 must also be an array (got ${typeof v2})`,
    );
    if (v1.length > 0) {
      // Both v1.findings and v1.sessions commit uniform element
      // shapes; sampling index 0 is sufficient AND avoids the
      // false-positive risk of comparing v2's larger findings array
      // element-by-element when v2 may have ADDED findings v1 never
      // had (e.g. cost_invariant_violation in v2).
      assert.ok(v2.length > 0, `${ctxPath}: v1 had elements; v2 is empty`);
      walkV1KeysPresent(v1[0], v2[0], `${ctxPath}[0]`);
    }
    return;
  }
  if (typeof v1 === 'object') {
    assert.equal(
      typeof v2,
      'object',
      `${ctxPath}: v1 is an object; v2 must also be an object (got ${typeof v2})`,
    );
    assert.ok(
      v2 !== null,
      `${ctxPath}: v1 is an object; v2 is null`,
    );
    for (const key of Object.keys(v1)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(v2, key),
        `${ctxPath}.${key}: present in v1 but missing from v2 ` +
          '(R7.AC1 — v2 may add fields, may not remove)',
      );
      walkV1KeysPresent(v1[key], v2[key], `${ctxPath}.${key}`);
    }
    return;
  }
  // Primitive in v1 — v2 must match type.
  assert.equal(
    typeof v2,
    typeof v1,
    `${ctxPath}: v1 type=${typeof v1} value=${JSON.stringify(v1)}; ` +
      `v2 type=${typeof v2} value=${JSON.stringify(v2)} (R7.AC1)`,
  );
}

/**
 * Walk every object in v2 and assert its own-key list is
 * alphabetically sorted. v1 and v2 both serialize via the same
 * deterministic stringifier (R7.AC2 byte-identical determinism);
 * the alphabetical-order invariant is the precondition that makes
 * the byte-identical promise possible across hosts.
 */
function walkAlphabeticalOrdering(obj, ctxPath) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      walkAlphabeticalOrdering(obj[i], `${ctxPath}[${i}]`);
    }
    return;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    const sorted = [...keys].sort();
    for (let i = 0; i < keys.length; i += 1) {
      assert.equal(
        keys[i],
        sorted[i],
        `${ctxPath}: keys not in alphabetical order at position ${i}; ` +
          `got ${JSON.stringify(keys)}; expected ${JSON.stringify(sorted)} ` +
          '(R7.AC2 byte-identical determinism)',
      );
    }
    for (const k of keys) {
      walkAlphabeticalOrdering(obj[k], `${ctxPath}.${k}`);
    }
  }
}

/**
 * Verify "same alphabetical position": every v1 key, when v2's keys
 * are filtered to the v1 key set, appears in the same relative order
 * as in v1. Because both v1 and v2 serialize alphabetically sorted,
 * this is automatically satisfied as long as v2 contains every v1
 * key; we still assert it explicitly so a future regression that
 * abandons alphabetical sorting (and reshuffles where v1's keys
 * land) trips this check.
 */
function walkSameAlphabeticalPosition(v1, v2, ctxPath) {
  if (v1 === null || v1 === undefined) return;
  if (Array.isArray(v1)) {
    if (v1.length > 0 && Array.isArray(v2) && v2.length > 0) {
      walkSameAlphabeticalPosition(v1[0], v2[0], `${ctxPath}[0]`);
    }
    return;
  }
  if (typeof v1 === 'object' && typeof v2 === 'object' && v2 !== null) {
    const v1Keys = Object.keys(v1);
    const v1KeySet = new Set(v1Keys);
    const v2KeysFilteredToV1 = Object.keys(v2).filter((k) => v1KeySet.has(k));
    assert.deepEqual(
      v2KeysFilteredToV1,
      v1Keys,
      `${ctxPath}: v1 key order ${JSON.stringify(v1Keys)} not preserved ` +
        `in v2; v2 (filtered to v1 keys) = ${JSON.stringify(v2KeysFilteredToV1)} ` +
        '(R7.AC1 / R7.AC5 — name AND position preserved)',
    );
    for (const k of v1Keys) {
      walkSameAlphabeticalPosition(v1[k], v2[k], `${ctxPath}.${k}`);
    }
  }
}

/**
 * Collect every distinct `kind` string appearing in a findings array
 * at the top level (`json.findings`) and inside each session
 * (`json.sessions[*].findings`). Returns a Set so callers can do
 * subset / intersection arithmetic.
 */
function collectFindingKinds(json) {
  const kinds = new Set();
  const top = Array.isArray(json && json.findings) ? json.findings : [];
  for (const f of top) {
    if (f && typeof f.kind === 'string') kinds.add(f.kind);
  }
  const sessions = Array.isArray(json && json.sessions) ? json.sessions : [];
  for (const s of sessions) {
    const sf = Array.isArray(s && s.findings) ? s.findings : [];
    for (const f of sf) {
      if (f && typeof f.kind === 'string') kinds.add(f.kind);
    }
  }
  return kinds;
}

/**
 * For each session in v2 that has no `pricing_table_drift`-class
 * fallback (i.e. matched-pricing sessions), assert that each cost
 * field v1 emitted as `null` (R7.AC5 list:
 *   cachedRead, cachedWrite, output, reasoning, subagentDispatch,
 *   uncachedInput)
 * is now `typeof === 'number'` in v2 — NOT null, NOT undefined, NOT
 * a string. Returns the count of (session, field) pairs verified so
 * the caller can sanity-check the test had real work to do.
 *
 * Also verifies the per-project and global aggregations: those v1
 * locations also emitted null and must now be numbers.
 */
function walkNullToValue(v1Json, v2Json) {
  // The exact set of fields v1 emitted as null at session.cost.*.
  // Pinned in fixture-365d-all-v1.json lines 4-12; if v1 ever grew
  // additional null-valued cost fields, this list would need
  // extension and a corresponding R7.AC5 update.
  const V1_NULL_COST_FIELDS = [
    'cachedRead',
    'cachedWrite',
    'output',
    'reasoning',
    'subagentDispatch',
    'uncachedInput',
  ];

  let verifiedCount = 0;

  // (a) Per-session cost.
  const v2Sessions = Array.isArray(v2Json.sessions) ? v2Json.sessions : [];
  for (const s of v2Sessions) {
    const sid = s.sessionId || '<unknown>';
    // Matched-pricing detection: a session whose findings include
    // pricing-fallback would carry null cost in v2 by design (R3.AC4).
    // The canonical fixture has no such session; if one ever lands
    // here we skip it explicitly so the assertion remains crisp.
    const finds = Array.isArray(s.findings) ? s.findings : [];
    const driftKinds = new Set([
      'pricing_table_drift',
      'pricing_drift',
    ]);
    const isDrift = finds.some((f) => f && driftKinds.has(f.kind));
    if (isDrift) continue;
    assert.ok(s.cost && typeof s.cost === 'object',
      `session ${sid}: cost object must be present in v2`);
    for (const field of V1_NULL_COST_FIELDS) {
      // Confirm v1 had this field as null on its session as
      // precondition; if v1's shape changes this caller-level
      // precondition trips first.
      const v1Sessions = Array.isArray(v1Json.sessions) ? v1Json.sessions : [];
      const v1S = v1Sessions.find((x) => x && x.sessionId === sid);
      if (v1S) {
        assert.equal(
          v1S.cost[field], null,
          `precondition: session ${sid}.cost.${field} should have been null in v1`,
        );
      }
      assert.equal(
        typeof s.cost[field], 'number',
        `session ${sid}.cost.${field}: v1 was null; v2 must be a number ` +
          `(got ${typeof s.cost[field]}=${JSON.stringify(s.cost[field])}) (R7.AC5)`,
      );
      verifiedCount += 1;
    }
  }

  // (b) Per-project rollup cost.
  const v2ByProject = (v2Json.byProject && typeof v2Json.byProject === 'object')
    ? v2Json.byProject : {};
  for (const [proj, entry] of Object.entries(v2ByProject)) {
    assert.ok(entry.cost && typeof entry.cost === 'object',
      `byProject[${proj}].cost must be an object in v2`);
    for (const field of V1_NULL_COST_FIELDS) {
      assert.equal(
        typeof entry.cost[field], 'number',
        `byProject[${proj}].cost.${field}: v1 was null; v2 must be a number ` +
          `(got ${typeof entry.cost[field]}=${JSON.stringify(entry.cost[field])}) (R7.AC5)`,
      );
      verifiedCount += 1;
    }
  }

  // (c) Global totals.
  const gt = (v2Json.globalTotals && typeof v2Json.globalTotals === 'object')
    ? v2Json.globalTotals : {};
  assert.ok(gt.cost && typeof gt.cost === 'object',
    'globalTotals.cost must be an object in v2');
  for (const field of V1_NULL_COST_FIELDS) {
    assert.equal(
      typeof gt.cost[field], 'number',
      `globalTotals.cost.${field}: v1 was null; v2 must be a number ` +
        `(got ${typeof gt.cost[field]}=${JSON.stringify(gt.cost[field])}) (R7.AC5)`,
    );
    verifiedCount += 1;
  }

  return verifiedCount;
}

// ── Check (a): v1-keys-present ──────────────────────────────────

test('forward-compat (9.1): v1-keys-present', () => {
  const v1 = readJsonGolden(V1_GOLDEN_JSON_PATH);
  const v2 = readJsonGolden(V2_GOLDEN_JSON_PATH);
  walkV1KeysPresent(v1.parsed, v2.parsed, '$');
  walkSameAlphabeticalPosition(v1.parsed, v2.parsed, '$');
});

// ── Check (b): alphabetical-ordering ────────────────────────────

test('forward-compat (9.1): alphabetical-ordering', () => {
  const v2 = readJsonGolden(V2_GOLDEN_JSON_PATH);
  walkAlphabeticalOrdering(v2.parsed, '$');
  // Also walk v1's own ordering as a control: if v1 was already
  // out-of-order, the v2 invariant is meaningless. Both v1 and v2
  // share the same serializer; v1's pass is an upstream sanity
  // check.
  const v1 = readJsonGolden(V1_GOLDEN_JSON_PATH);
  walkAlphabeticalOrdering(v1.parsed, '$');
});

// ── Check (c): findings-preserved ───────────────────────────────

test('forward-compat (9.1): findings-preserved', () => {
  const v1 = readJsonGolden(V1_GOLDEN_JSON_PATH);
  const v2 = readJsonGolden(V2_GOLDEN_JSON_PATH);
  const v1Kinds = collectFindingKinds(v1.parsed);
  const v2Kinds = collectFindingKinds(v2.parsed);
  assert.ok(
    v1Kinds.size > 0,
    'v1 golden must surface at least one finding kind for this check to be meaningful',
  );
  for (const k of v1Kinds) {
    assert.ok(
      v2Kinds.has(k),
      `finding kind "${k}" present in v1; missing in v2 ` +
        `(R7.AC4 — v2 may add findings, may not remove). v2 kinds: ${[...v2Kinds].sort()}`,
    );
  }
});

// ── Check (d): null-to-value ────────────────────────────────────

test('forward-compat (9.1): null-to-value', () => {
  const v1 = readJsonGolden(V1_GOLDEN_JSON_PATH);
  const v2 = readJsonGolden(V2_GOLDEN_JSON_PATH);
  const verifiedCount = walkNullToValue(v1.parsed, v2.parsed);
  // Sanity floor: the canonical fixture has 3 sessions × 6 fields +
  // 3 projects × 6 + 1 global × 6 = 42 (session, field) pairs. The
  // exact number is deterministic given the fixture; we assert a
  // floor so a regression that silently turns the fixture's
  // sessions into drift fallbacks (skipping the check entirely)
  // would surface as a false negative.
  assert.ok(
    verifiedCount >= 42,
    `null-to-value must verify ≥42 (session,field) pairs against the ` +
      `canonical fixture; got ${verifiedCount}. ` +
      'If this drops, a session may have silently transitioned to drift fallback.',
  );
});

// ── Check (e): no-generatedAt-in-json ───────────────────────────

test('forward-compat (9.1): no-generatedAt-in-json', () => {
  // Walk both the committed v2 golden AND a freshly-emitted JSON
  // run-through (defence in depth: a regression that only manifests
  // on certain sandbox env values would slip past a golden-only
  // check).
  const goldenRaw = fs.readFileSync(V2_GOLDEN_JSON_PATH, 'utf8');
  assert.ok(
    !goldenRaw.includes('"generatedAt"'),
    'v2 JSON golden must NOT contain the substring "generatedAt" ' +
      '(R7.AC2 — wall-clock stays in MD only; cf. design.md line 690)',
  );

  const sb = mkSandbox();
  try {
    const r = runMain(['--last', '365d']);
    assert.equal(r.exitCode, 0,
      `CLI must exit 0 for the no-generatedAt check (stderr=${r.stderr})`);
    const report = readReport(sb.stateDir);
    assert.ok(
      !report.json.includes('"generatedAt"'),
      'freshly-emitted v2 JSON must NOT contain the substring "generatedAt" ' +
        '(R7.AC2 — wall-clock stays in MD only)',
    );
  } finally {
    sb.cleanup();
  }
});

// ── Check (f): file-permission-0600 ─────────────────────────────

test('forward-compat (9.1): file-permission-0600', () => {
  const sb = mkSandbox();
  try {
    const r = runMain(['--last', '365d']);
    assert.equal(r.exitCode, 0,
      `CLI must exit 0 for the file-permission check (stderr=${r.stderr})`);
    const report = readReport(sb.stateDir);
    for (const p of [report.mdPath, report.jsonPath]) {
      const st = fs.statSync(p);
      const perm = st.mode & 0o777;
      assert.equal(
        perm, 0o600,
        `${p}: file permission must be 0o600; got 0o${perm.toString(8)} ` +
          '(R1.AC5 — per-user-readable posture preserved from v1)',
      );
    }
  } finally {
    sb.cleanup();
  }
});

// ── Tooth-check / self-verification ─────────────────────────────
//
// Verification-mode TDD is vulnerable to the "vacuous PASS" failure
// mode: the production code at 8.1 already emits a healthy v2 shape,
// so every check above passes on first run. If a helper had no
// teeth — e.g. walkV1KeysPresent silently accepted a missing key —
// the suite would still go green and the operator would have false
// confidence at cutover.
//
// To rule that out, each helper is exercised against in-memory
// perturbed inputs that deliberately violate the invariant it
// guards. The helper is REQUIRED to throw; if it does not, this
// test fails and surfaces the toothless-helper bug.
//
// All perturbations are constructed from the committed v1 golden so
// the tooth-check stays in sync with the actual contract. Nothing on
// disk is mutated.

test('forward-compat (9.1): self-check — helpers have teeth (do not skip in CI)', () => {
  const v1 = readJsonGolden(V1_GOLDEN_JSON_PATH);
  const v2 = readJsonGolden(V2_GOLDEN_JSON_PATH);

  // (a) walkV1KeysPresent must reject a v2 that's missing a v1
  // key. Drop `total` from v2's globalTotals.cost.
  const v2Missing = JSON.parse(JSON.stringify(v2.parsed));
  delete v2Missing.globalTotals.cost.total;
  assert.throws(
    () => walkV1KeysPresent(v1.parsed, v2Missing, '$'),
    /globalTotals\.cost\.total.*missing from v2/,
    'walkV1KeysPresent must reject a v2 missing a v1 key',
  );

  // (b) walkV1KeysPresent must reject a type change: turn v2's
  // session.cost.total (number) into a string.
  const v2TypeChanged = JSON.parse(JSON.stringify(v2.parsed));
  v2TypeChanged.sessions[0].cost.total = String(v2TypeChanged.sessions[0].cost.total);
  assert.throws(
    () => walkV1KeysPresent(v1.parsed, v2TypeChanged, '$'),
    /type=number.*type=string/,
    'walkV1KeysPresent must reject a v1→v2 type change',
  );

  // (c) walkAlphabeticalOrdering must reject an out-of-order object.
  // Construct a synthetic object whose keys are NOT alphabetically
  // sorted in iteration order.
  const unordered = {};
  unordered.z = 1;
  unordered.a = 2;
  assert.throws(
    () => walkAlphabeticalOrdering(unordered, '$'),
    /keys not in alphabetical order/,
    'walkAlphabeticalOrdering must reject an unsorted object',
  );

  // (d) walkSameAlphabeticalPosition must reject a v2 that contains
  // every v1 key but in a different relative order. The check would
  // never naturally fail in practice (both serializers sort), but a
  // future regression that switched to insertion-order would slip
  // past walkAlphabeticalOrdering if applied to fewer levels.
  const v2Reordered = JSON.parse(JSON.stringify(v2.parsed));
  // Rebuild globalTotals.cost with v1's keys in REVERSE alphabetical
  // order (still containing every key, but ordering broken).
  const origCost = v2Reordered.globalTotals.cost;
  const v1CostKeys = Object.keys(v1.parsed.globalTotals.cost);
  const reversed = {};
  for (const k of [...v1CostKeys].reverse()) {
    reversed[k] = origCost[k];
  }
  // Add the v2-only keys at the end so the v1 subset is reversed
  // but no key is missing.
  for (const k of Object.keys(origCost)) {
    if (!Object.prototype.hasOwnProperty.call(reversed, k)) {
      reversed[k] = origCost[k];
    }
  }
  v2Reordered.globalTotals.cost = reversed;
  assert.throws(
    () => walkSameAlphabeticalPosition(v1.parsed, v2Reordered, '$'),
    /not preserved/,
    'walkSameAlphabeticalPosition must reject a v2 with reordered v1 keys',
  );

  // (e) collectFindingKinds + findings-preserved tooth: remove all
  // copies of `per_bucket_cost_deferred` from v2 and assert the
  // resulting set fails the subset check.
  const v2Stripped = JSON.parse(JSON.stringify(v2.parsed));
  v2Stripped.findings = v2Stripped.findings.filter(
    (f) => f.kind !== 'per_bucket_cost_deferred',
  );
  for (const s of v2Stripped.sessions || []) {
    s.findings = (s.findings || []).filter(
      (f) => f.kind !== 'per_bucket_cost_deferred',
    );
  }
  const v1Kinds = collectFindingKinds(v1.parsed);
  const v2KindsStripped = collectFindingKinds(v2Stripped);
  let strippedThrew = false;
  for (const k of v1Kinds) {
    if (!v2KindsStripped.has(k)) {
      strippedThrew = true;
      break;
    }
  }
  assert.ok(
    strippedThrew,
    'tooth-check (findings-preserved): removing per_bucket_cost_deferred ' +
      'from v2 must trigger the missing-kind branch',
  );

  // (f) walkNullToValue must reject a v2 that turned a populated
  // field back to null. Mutate sessions[0].cost.cachedRead to null.
  const v2NulledBack = JSON.parse(JSON.stringify(v2.parsed));
  v2NulledBack.sessions[0].cost.cachedRead = null;
  assert.throws(
    () => walkNullToValue(v1.parsed, v2NulledBack),
    /cost\.cachedRead.*v2 must be a number/,
    'walkNullToValue must reject a v2 that regressed a populated field to null',
  );
});

// ── Private export for sibling-test reuse (if ever needed) ──────
//
// The helpers above are kept module-local; if a future task wants
// to reuse them from another test file, prefer extracting them into
// _helpers.js rather than reaching across `*.test.js` boundaries.
