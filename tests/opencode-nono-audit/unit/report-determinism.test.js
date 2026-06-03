/*
 * report-determinism.test.js — focused UNIT tests for the Reporter's
 * SERIALIZER-LEVEL determinism (opencode-nono-audit spec, Task 5.1,
 * Requirement 2.5).
 *
 * integration/report-emit.test.js #1 proves byte-stability across two
 * full emitReport() runs (which write to disk). This suite isolates the
 * pure serialization path — assembleReport + serializeReportJson /
 * serializeReportMarkdown — with NO disk I/O, and pins the specific
 * determinism property that the integration test does not isolate:
 *
 *   The report's TOP-LEVEL key order is FIXED by assembleReport's
 *   insertion order and is therefore INDEPENDENT of the key insertion
 *   order of the `parts` argument. Two assembleReport calls whose `parts`
 *   objects carry the SAME content but in DIFFERENT property orders
 *   serialize to BYTE-IDENTICAL JSON.
 *
 * This is the contract that lets "identical inputs → byte-identical
 * report" hold regardless of how the caller (CLI / tests) happened to
 * build the parts object. It is asserted here at the function boundary,
 * not through a disk round-trip.
 *
 * Lives under unit/ (run.js recurses everywhere except fixtures/ and
 * node_modules/).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleReport,
  serializeReportJson,
  serializeReportMarkdown,
  REPORT_SCHEMA_VERSION,
} = require('../../../scripts/opencode-nono-audit.js');

/** A small fixed audit/assessment/review content set (no secrets). */
const AUDIT = {
  schemaVersion: 1,
  generatedAt: 'ignored-by-assemble',
  partial: false,
  sources: [{ source: 'opencode-sqlite', status: 'ok' }],
  capabilities: [
    {
      tool: 'bash',
      count: 2,
      commands: ['ls'],
      paths: [],
      endpoints: [],
      ports: [],
      envVars: [],
      confidence: 'high',
      sources: ['opencode-sqlite'],
    },
  ],
  unobservableClasses: ['env-var', 'port'],
};
const ASSESSMENT = { assessment: 'skipped', reason: 'nono unavailable', findings: [] };
const REVIEW = {
  ranked: [{ tool: 'bash', count: 2, riskScore: 6, rank: 1 }],
  candidates: [{ tool: 'bash', rationale: 'no viable replacement' }],
  ledger: { reconciled: [], undecided: ['bash'], errors: [] },
};

const FIXED_AT = '2026-06-03T00:00:00.000Z';
const HOST = 'unit-host';

/** Build the parts object with header fields in a chosen order. */
function partsForward() {
  return {
    audit: AUDIT,
    assessment: ASSESSMENT,
    review: REVIEW,
    generatedAt: FIXED_AT,
    host: HOST,
    profileVersion: 'p-1',
  };
}

/** Same content, header/body keys inserted in a DIFFERENT order. */
function partsReversed() {
  const p = {};
  p.profileVersion = 'p-1';
  p.host = HOST;
  p.generatedAt = FIXED_AT;
  p.review = REVIEW;
  p.assessment = ASSESSMENT;
  p.audit = AUDIT;
  return p;
}

// ────────────────────────────────────────────────────────────────────
// 1. Top-level key order is fixed, independent of parts key order (R2.5)
// ────────────────────────────────────────────────────────────────────

test('assembleReport top-level key order is fixed regardless of parts key order (R2.5)', () => {
  const a = assembleReport(partsForward());
  const b = assembleReport(partsReversed());

  const EXPECTED_TOP_KEYS = [
    'schemaVersion',
    'host',
    'profileVersion',
    'generatedAt',
    'audit',
    'assessment',
    'review',
  ];
  assert.deepEqual(Object.keys(a), EXPECTED_TOP_KEYS, 'forward parts → fixed top-level key order');
  assert.deepEqual(
    Object.keys(b),
    EXPECTED_TOP_KEYS,
    'reversed parts → SAME fixed top-level key order',
  );
  assert.equal(a.schemaVersion, REPORT_SCHEMA_VERSION, 'header carries the report schema version');
});

// ────────────────────────────────────────────────────────────────────
// 2. Byte-identical JSON for the same content in different parts orders
// ────────────────────────────────────────────────────────────────────

test('serializeReportJson is byte-identical for identical content regardless of parts key order (R2.5)', () => {
  const jsonA = serializeReportJson(assembleReport(partsForward()));
  const jsonB = serializeReportJson(assembleReport(partsReversed()));
  assert.equal(jsonA, jsonB, 'JSON must be byte-identical for identical content');
  // And it round-trips to the same bytes (stable key ordering, not just
  // stable across the two calls above).
  assert.equal(
    JSON.stringify(JSON.parse(jsonA)),
    JSON.stringify(JSON.parse(jsonB)),
    'serialized JSON must re-serialize identically',
  );
  // POSIX-clean trailing newline.
  assert.ok(jsonA.endsWith('\n'), 'serialized JSON must end with a trailing newline');
});

// ────────────────────────────────────────────────────────────────────
// 3. Byte-identical Markdown for the same content in different orders
// ────────────────────────────────────────────────────────────────────

test('serializeReportMarkdown is byte-identical for identical content regardless of parts key order (R2.5)', () => {
  const mdA = serializeReportMarkdown(assembleReport(partsForward()));
  const mdB = serializeReportMarkdown(assembleReport(partsReversed()));
  assert.equal(mdA, mdB, 'Markdown must be byte-identical for identical content');
});

// ────────────────────────────────────────────────────────────────────
// 4. The injected generatedAt is the ONLY varying input that changes
//    output — pinning that determinism is parameterized purely by inputs
//    (no hidden new Date() in the serialization path).
// ────────────────────────────────────────────────────────────────────

test('a differing injected generatedAt is the only thing that changes the serialized JSON (R2.5)', () => {
  const base = serializeReportJson(assembleReport(partsForward()));
  const shifted = serializeReportJson(
    assembleReport({ ...partsForward(), generatedAt: '2099-01-01T00:00:00.000Z' }),
  );
  assert.notEqual(base, shifted, 'a different timestamp must change the output');
  // Re-running with the original timestamp reproduces the original bytes
  // exactly (no wall-clock leakage into serialization).
  const again = serializeReportJson(assembleReport(partsForward()));
  assert.equal(base, again, 'identical inputs reproduce identical bytes (no hidden clock read)');
});
