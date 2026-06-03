/*
 * assess-ingest.test.js — tests for the Compatibility Assessor's grant
 * INGEST layer (opencode-nono-audit spec, Task 3.1, Requirement 2.1).
 *
 * Task 3.1 implements ONLY grant ingestion: the read-only
 * `nono profile show <name> --json` shell-out, the DEFENSIVE grant
 * parser, and the "skipped (nono unavailable)" status. Classification of
 * usage against grants (compatible/warning/blocker/unknown Findings) is
 * task 3.2 and is NOT exercised here.
 *
 * Phase 0 (tests/opencode-nono-audit/fixtures/phase0-source-fidelity-decision.md):
 *   - `nono` is unavailable on THIS host (exit 127 / command-not-found),
 *     so the real absent-binary path is testable for real (test 3).
 *   - The `nono profile show --json` shape is UNVERIFIED upstream, so the
 *     parser MUST be defensive: malformed / unexpected JSON resolves to a
 *     skipped/unknown result, never a crash, never a fabricated
 *     "available" grants payload.
 *
 * ingestProfileGrants(profileName, opts) contract under test:
 *   - opts.grantsJson : inject grant JSON text directly (no shell-out).
 *   - opts.nonoBin    : override the `nono` binary path (default 'nono');
 *                       lets test 3 exercise the real absent binary.
 *   - returns a discriminated result:
 *       { assessment: 'available', grants: <normalized> }
 *       { assessment: 'skipped', reason: <string>, grants: null }
 *
 * These tests live under integration/ (NOT fixtures/) because run.js's
 * discoverTestFiles() recurses into every subdirectory except fixtures/
 * and node_modules/.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ingestProfileGrants,
  runAudit,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SYNTHETIC_GRANTS = path.join(
  FIXTURES_DIR,
  'nono-profile-show-opencode.synthetic.json',
);
const UNAVAILABLE_FIXTURE = path.join(
  FIXTURES_DIR,
  'nono-profile-show-opencode.unavailable.json',
);
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');

// An absolute path to a binary that does not exist, so the spawn fails
// with ENOENT regardless of the host PATH. Complements the bare-name
// 'nono' default (which is absent on this host per Phase 0).
const ABSENT_BIN = path.join(FIXTURES_DIR, 'definitely-not-a-real-nono-binary');

// ────────────────────────────────────────────────────────────────────
// 1. PARSE: synthetic grants JSON → available + normalized grants (R2.1)
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants parses the synthetic grants fixture → available', () => {
  const grantsJson = fs.readFileSync(SYNTHETIC_GRANTS, 'utf8');
  const res = ingestProfileGrants('opencode', { grantsJson });

  assert.equal(res.assessment, 'available', `expected available; got ${JSON.stringify(res)}`);
  assert.ok(res.grants && typeof res.grants === 'object', 'grants must be an object');

  // Specific grant fields must be parsed/normalized, not just present.
  const ext = res.grants['external-command'];
  assert.ok(ext, 'external-command grant must parse');
  assert.equal(ext.mode, 'allowlist', 'external-command mode parsed');
  assert.deepEqual(ext.allow, ['git', 'ls', 'cat'], 'external-command allowlist parsed');

  const fsPath = res.grants['filesystem-path'];
  assert.ok(fsPath, 'filesystem-path grant must parse');
  assert.deepEqual(fsPath.allow, ['/Users', '/tmp'], 'filesystem-path allowlist parsed');

  const net = res.grants['network-endpoint'];
  assert.ok(net, 'network-endpoint grant must parse');
  assert.equal(net.mode, 'denylist', 'network-endpoint mode parsed');
});

// ────────────────────────────────────────────────────────────────────
// 2. DEFENSIVE: malformed / unexpected-shape JSON → skipped, no crash,
//    no fabricated grants.
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants on malformed JSON → skipped, no throw, grants null', () => {
  let res;
  assert.doesNotThrow(() => {
    res = ingestProfileGrants('opencode', { grantsJson: '{ this is not: valid json' });
  }, 'malformed JSON must not throw');

  assert.equal(res.assessment, 'skipped', `malformed JSON must skip; got ${JSON.stringify(res)}`);
  assert.equal(res.grants, null, 'no fabricated grants on malformed input');
  assert.equal(typeof res.reason, 'string', 'a skip reason string must be provided');
  assert.ok(res.reason.length > 0, 'skip reason must be non-empty');
});

test('ingestProfileGrants on unexpected-shape JSON → skipped, no fabricated grants', () => {
  // Valid JSON, but it is NOT a profile-show payload (no `grants` object).
  const cases = [
    JSON.stringify({ totally: 'unexpected', shape: [1, 2, 3] }),
    JSON.stringify(['an', 'array', 'not', 'an', 'object']),
    JSON.stringify('a bare string'),
    JSON.stringify(42),
    JSON.stringify(null),
    JSON.stringify({ profile: 'opencode', grants: 'not-an-object' }),
  ];

  for (const grantsJson of cases) {
    let res;
    assert.doesNotThrow(() => {
      res = ingestProfileGrants('opencode', { grantsJson });
    }, `unexpected shape must not throw: ${grantsJson}`);

    assert.equal(
      res.assessment,
      'skipped',
      `unexpected shape must skip (never fabricate available): ${grantsJson} → ${JSON.stringify(res)}`,
    );
    assert.equal(res.grants, null, `no fabricated grants for: ${grantsJson}`);
    assert.equal(typeof res.reason, 'string', 'skip reason string required');
  }
});

// ────────────────────────────────────────────────────────────────────
// 3. NONO-ABSENT (real): the real (absent) nono binary → skipped,
//    reason "nono unavailable". (R2.1; design "Assessment availability".)
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants with the real absent nono binary → skipped (nono unavailable)', () => {
  // No grantsJson injected → forces the real shell-out path. The default
  // bare-name `nono` is absent on this host (Phase 0: exit 127). Also
  // exercise an explicit absolute non-existent path (ENOENT) to cover the
  // spawn-failure branch regardless of host PATH.
  for (const opts of [{}, { nonoBin: ABSENT_BIN }]) {
    let res;
    assert.doesNotThrow(() => {
      res = ingestProfileGrants('opencode', opts);
    }, `absent binary must not throw (opts=${JSON.stringify(opts)})`);

    assert.equal(
      res.assessment,
      'skipped',
      `absent nono must skip; got ${JSON.stringify(res)} (opts=${JSON.stringify(opts)})`,
    );
    assert.equal(res.grants, null, 'no grants when nono is absent');
    assert.equal(
      res.reason,
      'nono unavailable',
      `skip reason must match design wording; got ${JSON.stringify(res)}`,
    );
  }
});

test('the unavailable fixture records the same skip expectation we produce', () => {
  // The recorded skip-path evidence (Phase 0) and our real run must agree.
  const fixture = JSON.parse(fs.readFileSync(UNAVAILABLE_FIXTURE, 'utf8'));
  assert.equal(fixture.assessorExpectation.assessment, 'skipped');
  assert.equal(fixture.assessorExpectation.reason, 'nono unavailable');

  const res = ingestProfileGrants('opencode', { nonoBin: ABSENT_BIN });
  assert.equal(res.assessment, fixture.assessorExpectation.assessment);
  assert.equal(res.reason, fixture.assessorExpectation.reason);
});

// ────────────────────────────────────────────────────────────────────
// 4. NON-FATAL coexistence: with nono absent, runAudit over the valid
//    session fixture STILL returns a UsageAudit (ok Result). The
//    assessment skip is distinct from the R1.5 no-source hard failure.
// ────────────────────────────────────────────────────────────────────

test('audit still emits a UsageAudit while grant ingest skips (non-fatal)', () => {
  // The audit (R1) does not depend on nono at all; prove it still
  // succeeds, then prove the assessor's ingest independently skips.
  const audit = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(audit.ok, true, `audit must still succeed; got ${JSON.stringify(audit)}`);
  assert.ok(Array.isArray(audit.value.capabilities), 'audit still produces capabilities');

  const ingest = ingestProfileGrants('opencode', { nonoBin: ABSENT_BIN });
  assert.equal(ingest.assessment, 'skipped', 'ingest skips when nono absent');
  assert.equal(ingest.reason, 'nono unavailable');

  // The skip is NOT the no-source hard failure: the audit Result is ok
  // even though assessment was skipped — the two are independent.
  assert.notEqual(audit.ok, false, 'assessment skip must not turn the audit into a hard failure');
});
