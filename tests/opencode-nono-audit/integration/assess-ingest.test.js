/*
 * assess-ingest.test.js — tests for the Compatibility Assessor's grant
 * INGEST layer re-targeted to the VERIFIED real `nono profile show
 * --json` shape (opencode-nono-audit spec, Tasks 3.3, Requirement 2.1).
 *
 * Task 3.3 re-targets `parseGrants`/`ingestProfileGrants` from the
 * SYNTHETIC `{ grants: { class: {mode,allow,deny} } }` assumption (which
 * does NOT exist in real nono output) to the REAL top-level shape
 * verified on nono 0.61.1 (Phase 0):
 *   { name, description, extends, security, filesystem{allow,read,write,
 *     deny,...}, groups{include,exclude}, network{block,allow_domain,
 *     open_port,...}, workdir{access}, rollback }
 * There is NO top-level `grants` object. `show` does NOT expand groups
 * into paths (only NAMES under groups.include), so concrete path grants
 * are known ONLY from explicit filesystem.* arrays.
 *
 * ingestProfileGrants normalizes to a ResolvedGrants:
 *   {
 *     filesystem: { allow[], read[], write[], deny[] },
 *     network:    { block, allowDomain[], openPort[] },
 *     groups:     { include[], exclude[] },
 *   }
 *
 * Phase 0 (tests/opencode-nono-audit/fixtures/phase0-source-fidelity-decision.md):
 *   - `nono` is unavailable on THIS host (exit 127), so the real
 *     absent-binary path is testable for real (test 4).
 *   - A payload lacking filesystem/network/groups → skipped, never a
 *     fabricated "available".
 *
 * Lives under integration/ (NOT fixtures/) so run.js's
 * discoverTestFiles() picks it up (recurses every subdir except
 * fixtures/ and node_modules/).
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
// The captured REAL nono 0.61.1 output (committed Phase 0 fixture).
const REAL_NODE_DEV = path.join(
  FIXTURES_DIR,
  'nono-profile-show-node-dev-0.61.1.json',
);
// The hand-authored real-shape tightened managed profile.
const REAL_MANAGED = path.join(
  FIXTURES_DIR,
  'nono-profile-show-managed.realshape.json',
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
// 1. REAL CAPTURE: the committed node-dev capture parses into normalized
//    grants (filesystem/network/groups). node-dev's filesystem.allow is
//    [] and grants flow via groups.include, so concrete paths are
//    unknown — but the payload IS available (R2.1, task 3.3).
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants parses the REAL node-dev capture → available + normalized', () => {
  const grantsJson = fs.readFileSync(REAL_NODE_DEV, 'utf8');
  const res = ingestProfileGrants('node-dev', { grantsJson });

  assert.equal(res.assessment, 'available', `expected available; got ${JSON.stringify(res)}`);
  assert.ok(res.grants && typeof res.grants === 'object', 'grants must be an object');

  // Normalized ResolvedGrants shape.
  const g = res.grants;
  assert.ok(g.filesystem && typeof g.filesystem === 'object', 'filesystem section normalized');
  assert.deepEqual(g.filesystem.allow, [], 'node-dev filesystem.allow is []');
  assert.deepEqual(g.filesystem.read, [], 'node-dev filesystem.read is []');
  assert.deepEqual(g.filesystem.write, [], 'node-dev filesystem.write is []');
  assert.deepEqual(g.filesystem.deny, [], 'node-dev filesystem.deny is []');

  assert.ok(g.network && typeof g.network === 'object', 'network section normalized');
  assert.equal(g.network.block, false, 'node-dev network.block is false');
  assert.deepEqual(g.network.allowDomain, [], 'node-dev network.allow_domain is []');
  assert.deepEqual(g.network.openPort, [], 'node-dev network.open_port is []');

  assert.ok(g.groups && typeof g.groups === 'object', 'groups section normalized');
  assert.ok(
    Array.isArray(g.groups.include) && g.groups.include.includes('node_runtime'),
    'groups.include carries the named policy groups (not expanded into paths)',
  );
  assert.deepEqual(g.groups.exclude, [], 'groups.exclude is []');
});

// ────────────────────────────────────────────────────────────────────
// 1b. REAL-SHAPE MANAGED: the hand-authored tightened profile normalizes
//     its explicit filesystem allow/read/deny + network block/allow_domain
//     /open_port + groups.include.
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants parses the real-shape managed fixture → available + tightened grants', () => {
  const grantsJson = fs.readFileSync(REAL_MANAGED, 'utf8');
  const res = ingestProfileGrants('opencode-managed', { grantsJson });

  assert.equal(res.assessment, 'available', `expected available; got ${JSON.stringify(res)}`);
  const g = res.grants;

  assert.deepEqual(g.filesystem.allow, ['$HOME/.config/opencode', '$TMPDIR'], 'explicit allow normalized');
  assert.deepEqual(g.filesystem.read, ['/Users/test/project-nono'], 'explicit read normalized');
  assert.deepEqual(g.filesystem.deny, ['$HOME/.ssh'], 'explicit deny normalized');

  assert.equal(g.network.block, true, 'network.block normalized');
  assert.deepEqual(g.network.allowDomain, ['api.anthropic.com'], 'allow_domain normalized');
  assert.deepEqual(g.network.openPort, [8080], 'open_port normalized');

  assert.deepEqual(g.groups.include, ['node_runtime'], 'groups.include normalized');
});

// ────────────────────────────────────────────────────────────────────
// 2. DEFENSIVE: malformed JSON → skipped, no crash, no fabricated grants.
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants on malformed JSON → skipped, no throw, grants null', () => {
  let res;
  assert.doesNotThrow(() => {
    res = ingestProfileGrants('opencode-managed', { grantsJson: '{ this is not: valid json' });
  }, 'malformed JSON must not throw');

  assert.equal(res.assessment, 'skipped', `malformed JSON must skip; got ${JSON.stringify(res)}`);
  assert.equal(res.grants, null, 'no fabricated grants on malformed input');
  assert.equal(typeof res.reason, 'string', 'a skip reason string must be provided');
  assert.ok(res.reason.length > 0, 'skip reason must be non-empty');
});

// ────────────────────────────────────────────────────────────────────
// 3. UNEXPECTED SHAPE: valid JSON lacking filesystem/network/groups →
//    skipped, never fabricated available (the real-shape discriminator).
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants on a payload with no fs/network/groups → skipped, no fabricated available', () => {
  const cases = [
    // The OLD synthetic shape: a `grants` map but none of the real
    // top-level sections → must skip now (the shape was wrong).
    JSON.stringify({
      profile: 'opencode',
      grants: { 'external-command': { mode: 'allowlist', allow: ['git'] } },
    }),
    JSON.stringify({ totally: 'unexpected', shape: [1, 2, 3] }),
    JSON.stringify(['an', 'array', 'not', 'an', 'object']),
    JSON.stringify('a bare string'),
    JSON.stringify(42),
    JSON.stringify(null),
    // A name-only profile carrying none of the three grant sections.
    JSON.stringify({ name: 'empty', description: 'no grant sections' }),
  ];

  for (const grantsJson of cases) {
    let res;
    assert.doesNotThrow(() => {
      res = ingestProfileGrants('opencode-managed', { grantsJson });
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

test('a payload with ONLY a network section still parses → available (network conservatively present)', () => {
  // Presence of ANY of filesystem/network/groups makes the payload
  // usable; missing sub-arrays default to [] and missing block defaults
  // to false ONLY when the network object exists.
  const res = ingestProfileGrants('net-only', {
    grantsJson: JSON.stringify({ name: 'net-only', network: { allow_domain: ['x.test'] } }),
  });
  assert.equal(res.assessment, 'available', `network-only payload usable; got ${JSON.stringify(res)}`);
  assert.equal(res.grants.network.block, false, 'missing network.block defaults to false when network exists');
  assert.deepEqual(res.grants.network.allowDomain, ['x.test'], 'allow_domain normalized');
  assert.deepEqual(res.grants.filesystem.allow, [], 'absent filesystem section → empty arrays');
});

// ────────────────────────────────────────────────────────────────────
// 4. NONO-ABSENT (real): the real (absent) nono binary → skipped,
//    reason "nono unavailable". (R2.1; design "Assessment availability".)
// ────────────────────────────────────────────────────────────────────

test('ingestProfileGrants with the real absent nono binary → skipped (nono unavailable)', () => {
  for (const opts of [{}, { nonoBin: ABSENT_BIN }]) {
    let res;
    assert.doesNotThrow(() => {
      res = ingestProfileGrants('opencode-managed', opts);
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
  const fixture = JSON.parse(fs.readFileSync(UNAVAILABLE_FIXTURE, 'utf8'));
  assert.equal(fixture.assessorExpectation.assessment, 'skipped');
  assert.equal(fixture.assessorExpectation.reason, 'nono unavailable');

  const res = ingestProfileGrants('opencode-managed', { nonoBin: ABSENT_BIN });
  assert.equal(res.assessment, fixture.assessorExpectation.assessment);
  assert.equal(res.reason, fixture.assessorExpectation.reason);
});

// ────────────────────────────────────────────────────────────────────
// 5. NON-FATAL coexistence: with nono absent, runAudit over the valid
//    session fixture STILL returns a UsageAudit (ok Result). The
//    assessment skip is distinct from the R1.5 no-source hard failure.
// ────────────────────────────────────────────────────────────────────

test('audit still emits a UsageAudit while grant ingest skips (non-fatal)', () => {
  const audit = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(audit.ok, true, `audit must still succeed; got ${JSON.stringify(audit)}`);
  assert.ok(Array.isArray(audit.value.capabilities), 'audit still produces capabilities');

  const ingest = ingestProfileGrants('opencode-managed', { nonoBin: ABSENT_BIN });
  assert.equal(ingest.assessment, 'skipped', 'ingest skips when nono absent');
  assert.equal(ingest.reason, 'nono unavailable');

  assert.notEqual(audit.ok, false, 'assessment skip must not turn the audit into a hard failure');
});
