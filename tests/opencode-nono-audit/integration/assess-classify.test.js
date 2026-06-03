/*
 * assess-classify.test.js — tests for the Compatibility Assessor's
 * CLASSIFICATION layer (opencode-nono-audit spec, Task 3.2, Requirements
 * 2.2, 2.3, 2.4).
 *
 * Task 3.1 (assess-ingest.test.js) covered grant INGEST. Task 3.2 adds
 * `assess(audit, profiles, opts)`: it classifies each observed capability
 * against resolved grants into compatible / warning / blocker / unknown
 * Findings.
 *
 * Phase 0 (tests/opencode-nono-audit/fixtures/phase0-source-fidelity-decision.md):
 *   - `nono` is unavailable on THIS host, so the live (absent-nono) path
 *     is testable for real (test 5 — it must SKIP, never fabricate
 *     compatible).
 *   - Classification is therefore exercised against the synthetic grants
 *     fixture INJECTED through the same `opts` seam 3.1 used (no nono).
 *
 * assess(audit, profiles, opts) contract under test:
 *   - opts.grantsByProfile : { <profile>: <grantsJson string> } injects
 *     pre-ingested grant JSON per profile (no shell-out), mirroring 3.1's
 *     grantsJson seam.
 *   - returns a discriminated Result:
 *       { ok: true, value: Finding[] }   (grants available → classified)
 *       { ok: true, value: { assessment: 'skipped', reason, findings: [] } }
 *         when nono is unavailable for every profile (the SKIP — NOT
 *         fabricated compatible).
 *   - Finding = { profile, classification, capability, sessionContext?,
 *     missingCapability? }.
 *
 * Lives under integration/ (NOT fixtures/) so run.js's discoverTestFiles()
 * picks it up (it recurses every subdir except fixtures/ and node_modules/).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assess,
  runAudit,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SYNTHETIC_GRANTS = path.join(
  FIXTURES_DIR,
  'nono-profile-show-opencode.synthetic.json',
);
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');

// An absolute path to a binary that does not exist so the spawn fails with
// ENOENT regardless of host PATH (the live nono path is also absent on this
// host per Phase 0).
const ABSENT_BIN = path.join(FIXTURES_DIR, 'definitely-not-a-real-nono-binary');

/** Build the UsageAudit once from the valid session fixture. */
function loadAudit() {
  const audit = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(audit.ok, true, `audit must succeed; got ${JSON.stringify(audit)}`);
  return audit.value;
}

/** The synthetic grants JSON text, keyed by the 'opencode' profile. */
function syntheticGrantsByProfile() {
  return { opencode: fs.readFileSync(SYNTHETIC_GRANTS, 'utf8') };
}

/** Classify against the synthetic grants; assert it produced Findings. */
function classifyWithSynthetic() {
  const audit = loadAudit();
  const res = assess(audit, ['opencode'], {
    grantsByProfile: syntheticGrantsByProfile(),
  });
  assert.equal(res.ok, true, `assess must succeed; got ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.value), `findings must be an array; got ${JSON.stringify(res.value)}`);
  return res.value;
}

/** All findings with a given classification. */
function withClassification(findings, classification) {
  return findings.filter((f) => f.classification === classification);
}

/** Findings whose observed capability string includes `needle`. */
function capabilityIncludes(findings, needle) {
  return findings.filter((f) => typeof f.capability === 'string' && f.capability.includes(needle));
}

// ────────────────────────────────────────────────────────────────────
// 1. OBSERVABLE: classification produces a mix and includes AT LEAST ONE
//    `unknown` and AT LEAST ONE `blocker` whose missingCapability is set.
//    (R2.2, R2.3)
// ────────────────────────────────────────────────────────────────────

test('classification yields at least one unknown and one blocker carrying missingCapability', () => {
  const findings = classifyWithSynthetic();

  const unknowns = withClassification(findings, 'unknown');
  assert.ok(unknowns.length >= 1, `expected >=1 unknown; got ${JSON.stringify(findings)}`);

  const blockers = withClassification(findings, 'blocker');
  assert.ok(blockers.length >= 1, `expected >=1 blocker; got ${JSON.stringify(findings)}`);

  const blockersWithMissing = blockers.filter(
    (f) => typeof f.missingCapability === 'string' && f.missingCapability.length > 0,
  );
  assert.ok(
    blockersWithMissing.length >= 1,
    `expected >=1 blocker carrying missingCapability; got ${JSON.stringify(blockers)}`,
  );

  // Concrete anchor: `npm install` is not in the external-command allowlist
  // (git/ls/cat) → blocker with a missing-capability naming npm.
  const npmBlocker = blockers.find(
    (f) =>
      typeof f.capability === 'string' &&
      f.capability.includes('npm') &&
      typeof f.missingCapability === 'string' &&
      f.missingCapability.includes('npm'),
  );
  assert.ok(
    npmBlocker,
    `expected an 'npm' blocker with an npm missingCapability; got ${JSON.stringify(blockers)}`,
  );
  assert.equal(
    npmBlocker.missingCapability,
    'external-command:npm',
    'missingCapability names the external-command class + program',
  );
});

// ────────────────────────────────────────────────────────────────────
// 2. SAFETY INVARIANT: unmappable observation → `unknown`, NEVER
//    `compatible`. (R2.4)
// ────────────────────────────────────────────────────────────────────

test('unmappable observations classify as unknown, never compatible (R2.4)', () => {
  const findings = classifyWithSynthetic();

  // context7_get_docs is an MCP tool with no derivable capability class
  // (no command/path/endpoint, inference-only) → unmappable.
  const mcp = findings.filter((f) => typeof f.capability === 'string' && f.capability.includes('context7_get_docs'));
  assert.ok(mcp.length >= 1, `expected a finding for the unmappable MCP tool; got ${JSON.stringify(findings)}`);
  for (const f of mcp) {
    assert.equal(
      f.classification,
      'unknown',
      `unmappable MCP tool must be unknown, never compatible; got ${JSON.stringify(f)}`,
    );
  }

  // No unknown finding may ever be reclassified as compatible: assert no
  // finding that lacks any mappable capability class is compatible.
  for (const f of withClassification(findings, 'unknown')) {
    assert.notEqual(f.classification, 'compatible', 'an unknown must not also be compatible');
  }
});

// ────────────────────────────────────────────────────────────────────
// 3. COMPLETENESS: every observation maps to EXACTLY ONE classification.
// ────────────────────────────────────────────────────────────────────

test('every observation maps to exactly one classification (no drop, no double-classify)', () => {
  const audit = loadAudit();
  const findings = classifyWithSynthetic();

  const validClasses = new Set(['compatible', 'warning', 'blocker', 'unknown']);
  for (const f of findings) {
    assert.ok(
      validClasses.has(f.classification),
      `every finding carries exactly one valid classification; got ${JSON.stringify(f)}`,
    );
  }

  // Each observed capability record contributes at least one finding (no
  // observation silently dropped). A record may yield multiple findings
  // (e.g. one bash record → one finding per command), but never zero.
  for (const rec of audit.capabilities) {
    const forTool = findings.filter(
      (f) => typeof f.capability === 'string' && f.capability.includes(rec.tool),
    );
    assert.ok(
      forTool.length >= 1,
      `observation for tool '${rec.tool}' must produce >=1 finding; got ${JSON.stringify(findings)}`,
    );
  }

  // The multi-command bash record (git status, git clone, npm install,
  // curl) must produce a finding per distinct command — none dropped.
  const bash = audit.capabilities.find((r) => r.tool === 'bash');
  assert.ok(bash, 'bash record present in fixture');
  const bashFindings = findings.filter(
    (f) => typeof f.capability === 'string' && f.capability.startsWith('bash:'),
  );
  assert.equal(
    bashFindings.length,
    bash.commands.length,
    `each bash command yields one finding; got ${JSON.stringify(bashFindings)}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// 4. BLOCKER/WARNING METADATA: carry profile + observed capability (and
//    missingCapability when applicable). (R2.3)
// ────────────────────────────────────────────────────────────────────

test('blocker/warning findings carry profile and observed capability (R2.3)', () => {
  const findings = classifyWithSynthetic();

  const actionable = findings.filter(
    (f) => f.classification === 'blocker' || f.classification === 'warning',
  );
  assert.ok(actionable.length >= 1, `expected >=1 blocker/warning; got ${JSON.stringify(findings)}`);

  for (const f of actionable) {
    assert.equal(f.profile, 'opencode', `blocker/warning must record the profile; got ${JSON.stringify(f)}`);
    assert.equal(
      typeof f.capability,
      'string',
      `blocker/warning must record the observed capability; got ${JSON.stringify(f)}`,
    );
    assert.ok(f.capability.length > 0, 'observed capability must be non-empty');
  }

  // The webfetch endpoint is denied by the network-endpoint denylist '*'
  // → blocker carrying a missing network-endpoint capability.
  const netBlocker = findings.find(
    (f) =>
      f.classification === 'blocker' &&
      typeof f.capability === 'string' &&
      f.capability.includes('webfetch'),
  );
  assert.ok(netBlocker, `expected a webfetch network blocker; got ${JSON.stringify(findings)}`);
  assert.equal(netBlocker.profile, 'opencode', 'network blocker records profile');
  assert.ok(
    typeof netBlocker.missingCapability === 'string' &&
      netBlocker.missingCapability.includes('network-endpoint'),
    `network blocker records a network-endpoint missingCapability; got ${JSON.stringify(netBlocker)}`,
  );

  // The /Users path read is inside the filesystem-path allowlist → compatible.
  const readFinding = findings.find(
    (f) => typeof f.capability === 'string' && f.capability.includes('read:'),
  );
  assert.ok(readFinding, `expected a read finding; got ${JSON.stringify(findings)}`);
  assert.equal(
    readFinding.classification,
    'compatible',
    `the /Users read is allowlisted → compatible; got ${JSON.stringify(readFinding)}`,
  );

  // The `git status` / `git clone` commands are allowlisted → compatible.
  const gitStatus = findings.find(
    (f) => typeof f.capability === 'string' && f.capability.includes('git status'),
  );
  assert.ok(gitStatus, `expected a git status finding; got ${JSON.stringify(findings)}`);
  assert.equal(
    gitStatus.classification,
    'compatible',
    `git is allowlisted → compatible; got ${JSON.stringify(gitStatus)}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// 4b. DETERMINISM: identical inputs yield identical, stably-ordered output.
// ────────────────────────────────────────────────────────────────────

test('classification is deterministic and stably ordered', () => {
  const audit = loadAudit();
  const opts = { grantsByProfile: syntheticGrantsByProfile() };

  const a = assess(audit, ['opencode'], opts);
  const b = assess(audit, ['opencode'], opts);
  assert.deepEqual(a, b, 'repeated assess over identical inputs must be identical');
});

// ────────────────────────────────────────────────────────────────────
// 5. NONO-ABSENT (real): assess driven through the live (absent) nono
//    yields the SKIP (no fabricated compatible Findings) — distinct from
//    classification. (design "Assessment availability"; R2.4 false-
//    compatible avoidance.)
// ────────────────────────────────────────────────────────────────────

test('assess with the real absent nono binary → skipped, no fabricated compatible', () => {
  const audit = loadAudit();

  // No grantsByProfile injected → forces the live ingest (absent nono).
  let res;
  assert.doesNotThrow(() => {
    res = assess(audit, ['opencode'], { nonoBin: ABSENT_BIN });
  }, 'absent nono must not throw');

  assert.equal(res.ok, true, `assess must still return ok (skip is not a hard failure); got ${JSON.stringify(res)}`);
  assert.equal(
    res.value.assessment,
    'skipped',
    `absent nono must SKIP classification; got ${JSON.stringify(res.value)}`,
  );
  assert.equal(typeof res.value.reason, 'string', 'skip carries a reason');
  assert.ok(res.value.reason.includes('nono'), 'skip reason mentions nono');
  assert.ok(Array.isArray(res.value.findings), 'skip carries an (empty) findings array');

  // The crucial safety property: a skip must NOT fabricate compatible.
  const fabricatedCompatible = (res.value.findings || []).filter(
    (f) => f.classification === 'compatible',
  );
  assert.equal(
    fabricatedCompatible.length,
    0,
    `a skip must NOT fabricate compatible findings; got ${JSON.stringify(res.value)}`,
  );
});
