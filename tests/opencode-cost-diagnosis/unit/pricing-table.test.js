/*
 * pricing-table.test.js — unit tests for the v2 `PricingTable` class
 * (task 2.1 of .kiro/specs/v2-diagnosis).
 *
 * PricingTable is the domain-layer service that loads the bundled
 * `opencode-cost-report-pricing.json` once at construction, exposes
 * `(providerID, modelID) -> Rates` lookups, and surfaces operator-
 * visible pin metadata. See design.md § PricingTable (lines 389-453)
 * and requirements 3.1-3.4.
 *
 * This task lands the minimum viable observable test set:
 *   - bundled-JSON construction succeeds and surfaces pin metadata
 *   - known Anthropic lookup returns all five Rates fields,
 *     with reasoningPerM === 0 because the upstream JSON omits
 *     cost.reasoning for Claude (the design-mandated substitution)
 *   - known OpenAI lookup (`openai.gpt-5.5-pro`) returns all five
 *     fields with cacheReadPerM === 0 and cacheWritePerM === 0,
 *     proving the same substitution rule applies to any omitted
 *     rate, not just `reasoning` — the forward-flag from task 1.2
 *     reviewer.
 *   - unknown lookup returns `null` (no fuzzy match, no fallback)
 *   - constructor surfaces clear errors for missing file, malformed
 *     JSON, and missing top-level keys
 *
 * Task 2.2 (PricingTable property tests) expands coverage; this file
 * lands the observable defined in tasks.md task 2.1.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

const { PricingTable } = mod;

const BUNDLED_PRICING_PATH = path.resolve(
  __dirname,
  '../../../scripts/opencode-cost-report-pricing.json',
);

// ---------------------------------------------------------------------
// Construction + pin metadata
// ---------------------------------------------------------------------

test('PricingTable is exported as a constructor function', () => {
  assert.equal(typeof PricingTable, 'function');
});

test('PricingTable() loads the bundled JSON without throwing', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.ok(pt instanceof PricingTable);
});

test('pinMetadata exposes the bundled pin date and source', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.equal(pt.pinMetadata.pinDate, '2026-05-18');
  assert.equal(pt.pinMetadata.pinSource, 'https://models.dev/api.json');
});

test('pinMetadata is frozen (immutable)', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.equal(Object.isFrozen(pt.pinMetadata), true);
});

// ---------------------------------------------------------------------
// lookup() — known keys
// ---------------------------------------------------------------------

test('lookup("anthropic", "claude-opus-4-7") returns all five rate fields', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  const rates = pt.lookup('anthropic', 'claude-opus-4-7');

  assert.ok(rates !== null && typeof rates === 'object', 'expected a Rates object');
  assert.deepEqual(
    new Set(Object.keys(rates)),
    new Set([
      'inputPerM',
      'outputPerM',
      'reasoningPerM',
      'cacheReadPerM',
      'cacheWritePerM',
    ]),
    'Rates must always carry exactly the five documented fields',
  );

  // Values come straight from the JSON (USD per million tokens; no
  // transformation). Bundled pricing-JSON line numbers in the comment
  // are for quick cross-reference; the assertions are authoritative.
  assert.equal(rates.inputPerM, 5);       // cost.input
  assert.equal(rates.outputPerM, 25);     // cost.output
  assert.equal(rates.cacheReadPerM, 0.5); // cost.cache_read
  assert.equal(rates.cacheWritePerM, 6.25); // cost.cache_write

  // Anthropic Claude omits cost.reasoning in the upstream JSON, so the
  // design-mandated substitution applies: reasoningPerM === 0. Lookup
  // does NOT throw and the Rates shape is still complete.
  assert.equal(
    rates.reasoningPerM,
    0,
    'missing cost.reasoning must substitute to 0, not undefined or null',
  );
});

test('lookup("openai", "gpt-5.5-pro") substitutes 0 for missing cache_read AND cache_write', () => {
  // Forward-flag from task 1.2 reviewer: the bundled JSON's
  // openai.gpt-5.5-pro entry has ONLY cost.input + cost.output. The
  // substitution rule from design.md is general — ANY missing rate
  // substitutes to 0, not just `reasoning`. This test pins that
  // behavior so a future refactor cannot quietly weaken it.
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  const rates = pt.lookup('openai', 'gpt-5.5-pro');

  assert.ok(rates !== null, 'gpt-5.5-pro must be a known key');
  assert.equal(rates.inputPerM, 30);
  assert.equal(rates.outputPerM, 180);
  assert.equal(rates.reasoningPerM, 0, 'missing cost.reasoning -> 0');
  assert.equal(rates.cacheReadPerM, 0, 'missing cost.cache_read -> 0');
  assert.equal(rates.cacheWritePerM, 0, 'missing cost.cache_write -> 0');

  // No Rates field is undefined or missing on any successful lookup.
  for (const key of [
    'inputPerM',
    'outputPerM',
    'reasoningPerM',
    'cacheReadPerM',
    'cacheWritePerM',
  ]) {
    assert.equal(
      typeof rates[key],
      'number',
      `Rates.${key} must always be a number on a successful lookup`,
    );
    assert.equal(
      Number.isFinite(rates[key]),
      true,
      `Rates.${key} must be a finite number`,
    );
  }
});

test('lookup returns the same cached Rates object on repeated calls (per design postcondition)', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  const a = pt.lookup('anthropic', 'claude-opus-4-7');
  const b = pt.lookup('anthropic', 'claude-opus-4-7');
  assert.strictEqual(a, b, 'design.md:439 — cached Rates by Map');
});

test('lookup-returned Rates is frozen (callers cannot mutate)', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  const rates = pt.lookup('anthropic', 'claude-opus-4-7');
  assert.equal(Object.isFrozen(rates), true);
});

// ---------------------------------------------------------------------
// lookup() — unknown keys (drift is loud-by-design; the LOUD part is
// the finding emitted by AttributionEngine in task 5.6; THIS class
// just returns null and never throws)
// ---------------------------------------------------------------------

test('lookup("unknown", "unknown") returns null (no fuzzy match, no fallback)', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.equal(pt.lookup('unknown', 'unknown'), null);
});

test('lookup with unknown provider but known modelID returns null', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  // claude-opus-4-7 exists under anthropic, NOT under "openai".
  assert.equal(pt.lookup('openai', 'claude-opus-4-7'), null);
});

test('lookup with known provider but unknown modelID returns null', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.equal(pt.lookup('anthropic', 'claude-opus-99-future'), null);
});

// ---------------------------------------------------------------------
// knownModels accessor
// ---------------------------------------------------------------------

test('knownModels lists every (providerID, modelID) pair in the bundled JSON', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  const keys = pt.knownModels.map((m) => `${m.providerID}::${m.modelID}`).sort();
  assert.deepEqual(keys, [
    'anthropic::claude-opus-4-7',
    'anthropic::claude-sonnet-4-5',
    'openai::gpt-5.5-pro',
  ]);
});

test('knownModels is a frozen array (immutable)', () => {
  const pt = new PricingTable(BUNDLED_PRICING_PATH);
  assert.equal(Object.isFrozen(pt.knownModels), true);
});

// ---------------------------------------------------------------------
// Constructor validation: clear errors on bad input
// ---------------------------------------------------------------------

test('constructor throws a clear error when the file is missing', () => {
  assert.throws(
    () => new PricingTable('/this/path/does/not/exist.json'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /\/this\/path\/does\/not\/exist\.json/,
        'error message must name the path that failed',
      );
      return true;
    },
  );
});

test('constructor throws a clear error on malformed JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-table-test-'));
  const badPath = path.join(tmpDir, 'bad.json');
  fs.writeFileSync(badPath, '{ this is not valid JSON');
  try {
    assert.throws(
      () => new PricingTable(badPath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          new RegExp(badPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'error message must name the path that failed to parse',
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('constructor throws when a top-level key is missing (pinDate)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-table-test-'));
  const badPath = path.join(tmpDir, 'no-pin-date.json');
  fs.writeFileSync(
    badPath,
    JSON.stringify({ pinSource: 'x', models: {} }),
  );
  try {
    assert.throws(
      () => new PricingTable(badPath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /pinDate/, 'must name the missing key');
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('constructor throws when a top-level key is missing (pinSource)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-table-test-'));
  const badPath = path.join(tmpDir, 'no-pin-source.json');
  fs.writeFileSync(
    badPath,
    JSON.stringify({ pinDate: '2026-05-18', models: {} }),
  );
  try {
    assert.throws(
      () => new PricingTable(badPath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /pinSource/, 'must name the missing key');
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('constructor throws when a top-level key is missing (models)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-table-test-'));
  const badPath = path.join(tmpDir, 'no-models.json');
  fs.writeFileSync(
    badPath,
    JSON.stringify({ pinDate: '2026-05-18', pinSource: 'x' }),
  );
  try {
    assert.throws(
      () => new PricingTable(badPath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /models/, 'must name the missing key');
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
