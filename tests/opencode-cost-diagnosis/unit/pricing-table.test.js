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

// Task 2.2: synthetic pricing fixture lives under tests/.../fixtures/
// so the design-mandated semantics (variant-blind, reasoning-substitution,
// pin metadata accessor) can be asserted independent of the production pin.
// Note: the fixture's `pinDate` is intentionally NOT the bundled JSON's
// 2026-05-18 — the difference proves the constructor reads from the path
// we passed it and not from any compiled-in default.
const SYNTHETIC_PRICING_PATH = path.resolve(
  __dirname,
  '../fixtures/synthetic-pricing.json',
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

// ---------------------------------------------------------------------
// Task 2.2: synthetic-fixture coverage
//
// The tests above all run against the bundled JSON. That couples the
// design-mandated semantics (variant-blind, reasoning-substitution,
// pin metadata, happy-path lookup, null-on-miss) to whatever the
// production pin happens to look like on any given day. Task 2.2 lands
// a small synthetic fixture under tests/.../fixtures/ so the same
// semantics can be asserted independently of the production pin —
// including a model that intentionally carries a `variant` field the
// constructor must silently ignore (the bundled JSON has no variant
// fields, so the variant-blind property was previously implicit-not-
// asserted).
//
// Each test below instantiates its own PricingTable; no shared mutable
// state between tests.
// ---------------------------------------------------------------------

test('synthetic fixture: happy-path lookup returns all five rate fields with the fixture values', () => {
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  const rates = pt.lookup('testprovider', 'full-model');

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

  // Values are pinned to the fixture; see synthetic-pricing.json.
  assert.equal(rates.inputPerM, 2);
  assert.equal(rates.outputPerM, 10);
  assert.equal(rates.reasoningPerM, 8);
  assert.equal(rates.cacheReadPerM, 0.1);
  assert.equal(rates.cacheWritePerM, 1.5);
});

test('synthetic fixture: minimal-model omits cost.{reasoning,cache_read,cache_write} -> all three substitute to 0', () => {
  // Independent re-assertion of the substitution rule. The bundled
  // JSON's Claude entry exercises reasoning substitution; this test
  // proves the rule holds for an arbitrary upstream entry shape, not
  // just whatever the production pin happens to ship.
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  const rates = pt.lookup('testprovider', 'minimal-model');

  assert.ok(rates !== null, 'minimal-model must be a known key');
  assert.equal(rates.inputPerM, 1);
  assert.equal(rates.outputPerM, 4);
  assert.equal(
    rates.reasoningPerM,
    0,
    'missing cost.reasoning must substitute to 0 (requirements 3.2)',
  );
  assert.equal(
    rates.cacheReadPerM,
    0,
    'missing cost.cache_read must substitute to 0',
  );
  assert.equal(
    rates.cacheWritePerM,
    0,
    'missing cost.cache_write must substitute to 0',
  );
});

test('synthetic fixture: variant-blind — model entry with a `variant` field is loaded normally and Rates carries no variant key', () => {
  // Design.md Decision 2: PricingTable consumes only the base cost.*
  // rates; any `variant` dimension on the upstream model entry is
  // silently ignored. The bundled JSON has no variant fields, so this
  // test pins the variant-blind property against a fixture that DOES
  // carry one.
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  const rates = pt.lookup('testprovider', 'variant-tagged');

  assert.ok(rates !== null, 'variant-tagged must load successfully (variant is ignored, not rejected)');

  // The Rates shape carries exactly the five documented fields — no
  // `variant`, no extra keys leaked from the upstream JSON.
  assert.deepEqual(
    new Set(Object.keys(rates)),
    new Set([
      'inputPerM',
      'outputPerM',
      'reasoningPerM',
      'cacheReadPerM',
      'cacheWritePerM',
    ]),
    'variant-blind: Rates must not carry a `variant` key or any other extra fields',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(rates, 'variant'),
    false,
    'Rates.variant must not exist',
  );

  // The base cost.* rates are still loaded normally from the entry.
  assert.equal(rates.inputPerM, 3);
  assert.equal(rates.outputPerM, 12);
  assert.equal(rates.reasoningPerM, 9);
  assert.equal(rates.cacheReadPerM, 0.2);
  assert.equal(rates.cacheWritePerM, 2.5);
});

test('synthetic fixture: pinMetadata accessor returns the fixture pinDate, pinSource, and pinVersion', () => {
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  assert.equal(pt.pinMetadata.pinDate, '2026-01-01');
  assert.equal(pt.pinMetadata.pinSource, 'synthetic-test-fixture');
  assert.equal(pt.pinMetadata.pinVersion, 'v1.0-test');
  assert.equal(Object.isFrozen(pt.pinMetadata), true);
});

test('synthetic fixture: knownModels lists every (providerID, modelID) pair in the fixture', () => {
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  const keys = pt.knownModels.map((m) => `${m.providerID}::${m.modelID}`).sort();
  assert.deepEqual(keys, [
    'testprovider::full-model',
    'testprovider::minimal-model',
    'testprovider::variant-tagged',
  ]);
});

test('synthetic fixture: lookup of an unknown (providerID, modelID) returns null (no fuzzy match)', () => {
  const pt = new PricingTable(SYNTHETIC_PRICING_PATH);
  assert.equal(pt.lookup('testprovider', 'no-such-model'), null);
  assert.equal(pt.lookup('no-such-provider', 'full-model'), null);
});
