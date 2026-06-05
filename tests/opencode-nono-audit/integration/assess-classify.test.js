/*
 * assess-classify.test.js — tests for the Compatibility Assessor's
 * CLASSIFICATION layer re-targeted to the VERIFIED real `nono profile
 * show --json` grant model (opencode-nono-audit spec, Task 3.4,
 * Requirements 2.2, 2.3, 2.4).
 *
 * Task 3.3 (assess-ingest.test.js) covered the real-shape grant INGEST.
 * Task 3.4 reworks `assess(audit, profiles, opts)` to classify each
 * observed capability against the real grant model:
 *   - PATH  → filesystem.deny prefix → blocker; filesystem.allow/read/
 *     write prefix → compatible; else → unknown (may be group-covered).
 *   - ENDPOINT (host) → network.block=false + empty allow_domain →
 *     compatible; allow_domain non-empty → host ∈ list → compatible else
 *     blocker; network.block=true → host ∈ list → compatible else
 *     blocker; network absent → unknown.
 *   - COMMAND → unknown (nono governs fs/net, not per-command allowlists).
 *   - ports/envVars / records with no derivable surface → unknown.
 *   - $HOME/$TMPDIR tokens in grant prefixes are expanded before matching.
 *
 * Safety invariants (MANDATORY): unmappable → unknown, NEVER compatible
 * (R2.4); never a false blocker for a group-coverable path (→ unknown).
 *
 * Phase 0: `nono` is unavailable on THIS host, so the live (absent-nono)
 * path is testable for real (it must SKIP, never fabricate compatible).
 * Classification is exercised against the real-shape managed fixture
 * INJECTED through the same `opts.grantsByProfile` seam.
 *
 * Lives under integration/ (NOT fixtures/) so run.js's
 * discoverTestFiles() picks it up.
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
const REAL_MANAGED = path.join(
  FIXTURES_DIR,
  'nono-profile-show-managed.realshape.json',
);
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');

const ABSENT_BIN = path.join(FIXTURES_DIR, 'definitely-not-a-real-nono-binary');

/** Build the UsageAudit from the valid session fixture. */
function loadAudit() {
  const audit = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(audit.ok, true, `audit must succeed; got ${JSON.stringify(audit)}`);
  return audit.value;
}

/** The real-shape managed grants JSON, keyed by the assessed profile. */
function managedGrantsByProfile(profile) {
  return { [profile]: fs.readFileSync(REAL_MANAGED, 'utf8') };
}

/** Classify the session fixture against the real-shape managed grants. */
function classifyManaged() {
  const audit = loadAudit();
  const res = assess(audit, ['opencode-managed'], {
    grantsByProfile: managedGrantsByProfile('opencode-managed'),
  });
  assert.equal(res.ok, true, `assess must succeed; got ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.value), `findings must be an array; got ${JSON.stringify(res.value)}`);
  return res.value;
}

function withClassification(findings, classification) {
  return findings.filter((f) => f.classification === classification);
}

// ────────────────────────────────────────────────────────────────────
// 1. OBSERVABLE BRANCH MIX: classification over the real-shape fixture +
//    the session capabilities yields >=1 compatible (path under read
//    allow), >=1 blocker carrying missingCapability (endpoint not in
//    allow_domain under block), >=1 unknown (bare command / group-only /
//    MCP). (R2.2, R2.3, R2.4)
// ────────────────────────────────────────────────────────────────────

test('classification yields compatible + blocker(missingCapability) + unknown over the real-shape fixture', () => {
  const findings = classifyManaged();

  const compatibles = withClassification(findings, 'compatible');
  const blockers = withClassification(findings, 'blocker');
  const unknowns = withClassification(findings, 'unknown');

  assert.ok(compatibles.length >= 1, `expected >=1 compatible; got ${JSON.stringify(findings)}`);
  assert.ok(blockers.length >= 1, `expected >=1 blocker; got ${JSON.stringify(findings)}`);
  assert.ok(unknowns.length >= 1, `expected >=1 unknown; got ${JSON.stringify(findings)}`);

  // COMPATIBLE: the read path /Users/test/project-nono/src/index.js is
  // under the explicit filesystem.read prefix /Users/test/project-nono.
  const readCompatible = findings.find(
    (f) =>
      f.classification === 'compatible' &&
      typeof f.capability === 'string' &&
      f.capability.includes('/Users/test/project-nono/src/index.js'),
  );
  assert.ok(
    readCompatible,
    `expected the read path under filesystem.read → compatible; got ${JSON.stringify(findings)}`,
  );

  // BLOCKER: the webfetch endpoint host docs.example.invalid is not in
  // allow_domain (api.anthropic.com) under network.block=true → blocker,
  // missingCapability names the network-endpoint host.
  const netBlocker = blockers.find(
    (f) =>
      typeof f.capability === 'string' &&
      f.capability.includes('docs.example.invalid'),
  );
  assert.ok(netBlocker, `expected a webfetch network blocker; got ${JSON.stringify(blockers)}`);
  assert.equal(netBlocker.profile, 'opencode-managed', 'blocker records the profile');
  assert.equal(
    netBlocker.missingCapability,
    'network-endpoint:docs.example.invalid',
    `blocker missingCapability names class + host; got ${JSON.stringify(netBlocker)}`,
  );

  // UNKNOWN: a bare bash command (npm install) is unknown (commands are
  // not classified against per-command allowlists in the real model).
  const cmdUnknown = findings.find(
    (f) =>
      f.classification === 'unknown' &&
      typeof f.capability === 'string' &&
      f.capability.includes('npm install'),
  );
  assert.ok(cmdUnknown, `expected the bare command → unknown; got ${JSON.stringify(findings)}`);
});

// ────────────────────────────────────────────────────────────────────
// 2. SAFETY INVARIANT: unmappable observation → unknown, NEVER
//    compatible; AND no false blocker for a group-coverable path. (R2.4)
// ────────────────────────────────────────────────────────────────────

test('unmappable observations classify as unknown, never compatible (R2.4)', () => {
  const findings = classifyManaged();

  // context7_get_docs is an MCP tool with no derivable capability class
  // (no command/path/endpoint) → unmappable → unknown.
  const mcp = findings.filter(
    (f) => typeof f.capability === 'string' && f.capability.includes('context7_get_docs'),
  );
  assert.ok(mcp.length >= 1, `expected a finding for the unmappable MCP tool; got ${JSON.stringify(findings)}`);
  for (const f of mcp) {
    assert.equal(
      f.classification,
      'unknown',
      `unmappable MCP tool must be unknown, never compatible; got ${JSON.stringify(f)}`,
    );
  }

  // No finding lacking a mappable surface may be compatible.
  for (const f of withClassification(findings, 'unknown')) {
    assert.notEqual(f.classification, 'compatible', 'an unknown must not also be compatible');
  }
});

test('a group-only path (not under any explicit filesystem grant) → unknown, never a false blocker', () => {
  // A path covered ONLY by an unexpanded group must be unknown — neither
  // compatible (false-compatible avoidance) nor blocker (false-blocker
  // avoidance), because `show` does not expand groups into paths.
  const audit = {
    schemaVersion: 1,
    capabilities: [
      {
        tool: 'read',
        count: 1,
        commands: [],
        paths: ['/usr/local/lib/node_modules/pkg/index.js'], // group-covered, not explicit
        endpoints: [],
        ports: [],
        envVars: [],
        confidence: 'high',
        sources: ['opencode-sqlite'],
      },
    ],
  };
  const res = assess(audit, ['opencode-managed'], {
    grantsByProfile: managedGrantsByProfile('opencode-managed'),
  });
  assert.equal(res.ok, true);
  const f = res.value.find((x) => x.capability.includes('node_modules/pkg/index.js'));
  assert.ok(f, `expected a finding for the group-only path; got ${JSON.stringify(res.value)}`);
  assert.equal(f.classification, 'unknown', 'group-only path → unknown (never compatible, never blocker)');
  assert.equal(typeof f.missingCapability, 'undefined', 'unknown carries no missingCapability');
});

// ────────────────────────────────────────────────────────────────────
// 3. DENY PRECEDENCE + $HOME / $TMPDIR EXPANSION. A synthetic audit with
//    $HOME-relative observed paths drives the deny→blocker and
//    allow→compatible branches via token-expanded grant prefixes.
// ────────────────────────────────────────────────────────────────────

test('$HOME/$TMPDIR expansion: deny prefix → blocker, allow prefix → compatible', () => {
  const home = process.env.HOME;
  const tmp = process.env.TMPDIR;
  assert.ok(typeof home === 'string' && home.length > 0, 'HOME must be set for this test');

  // Concrete observed paths derived from the SAME $HOME the grant
  // prefixes will expand against.
  const sshKey = path.join(home, '.ssh', 'id_ed25519'); // under deny $HOME/.ssh
  const cfgFile = path.join(home, '.config', 'opencode', 'opencode.json'); // under allow $HOME/.config/opencode

  const audit = {
    schemaVersion: 1,
    capabilities: [
      {
        tool: 'read',
        count: 2,
        commands: [],
        paths: [sshKey, cfgFile],
        endpoints: [],
        ports: [],
        envVars: [],
        confidence: 'high',
        sources: ['opencode-sqlite'],
      },
    ],
  };

  const res = assess(audit, ['opencode-managed'], {
    grantsByProfile: managedGrantsByProfile('opencode-managed'),
  });
  assert.equal(res.ok, true);

  const denied = res.value.find((f) => f.capability.includes(sshKey));
  assert.ok(denied, `expected a finding for the $HOME/.ssh path; got ${JSON.stringify(res.value)}`);
  assert.equal(denied.classification, 'blocker', '$HOME/.ssh deny prefix (expanded) → blocker');
  assert.equal(
    denied.missingCapability,
    `filesystem-path:${sshKey}`,
    'blocker missingCapability names the filesystem-path + value',
  );

  const allowed = res.value.find((f) => f.capability.includes(cfgFile));
  assert.ok(allowed, `expected a finding for the $HOME/.config/opencode path; got ${JSON.stringify(res.value)}`);
  assert.equal(allowed.classification, 'compatible', '$HOME/.config/opencode allow prefix (expanded) → compatible');

  // If TMPDIR is set, a $TMPDIR-relative path also matches the expanded
  // allow prefix → compatible.
  if (typeof tmp === 'string' && tmp.length > 0) {
    const tmpFile = path.join(tmp, 'scratch.txt');
    const res2 = assess(
      {
        schemaVersion: 1,
        capabilities: [
          {
            tool: 'read',
            count: 1,
            commands: [],
            paths: [tmpFile],
            endpoints: [],
            ports: [],
            envVars: [],
            confidence: 'high',
            sources: ['opencode-sqlite'],
          },
        ],
      },
      ['opencode-managed'],
      { grantsByProfile: managedGrantsByProfile('opencode-managed') },
    );
    const tmpFinding = res2.value.find((f) => f.capability.includes(tmpFile));
    assert.ok(tmpFinding, 'expected a $TMPDIR path finding');
    assert.equal(tmpFinding.classification, 'compatible', '$TMPDIR allow prefix (expanded) → compatible');
  }
});

// ────────────────────────────────────────────────────────────────────
// 4. ENDPOINT branches: block=false + empty allow_domain → compatible;
//    network absent → unknown; allow_domain hit → compatible.
// ────────────────────────────────────────────────────────────────────

test('endpoint classification: open network → compatible, absent network → unknown, allowed host → compatible', () => {
  const audit = {
    schemaVersion: 1,
    capabilities: [
      {
        tool: 'webfetch',
        count: 3,
        commands: [],
        paths: [],
        endpoints: [
          'https://anything.test/x', // open network → compatible
          'https://api.anthropic.com/v1', // allowed host → compatible
          'https://blocked.test/y', // not allowed → blocker (under block-aware profiles)
        ],
        ports: [],
        envVars: [],
        confidence: 'high',
        sources: ['opencode-sqlite'],
      },
    ],
  };

  // Open network (block=false, allow_domain=[]) → every endpoint compatible.
  const open = assess(audit, ['open'], {
    grantsByProfile: {
      open: JSON.stringify({ name: 'open', network: { block: false, allow_domain: [] } }),
    },
  });
  assert.equal(open.ok, true);
  for (const f of open.value) {
    assert.equal(
      f.classification,
      'compatible',
      `open network → compatible for ${f.capability}; got ${JSON.stringify(f)}`,
    );
  }

  // Network section absent entirely → endpoints are unknown.
  const noNet = assess(audit, ['fsonly'], {
    grantsByProfile: {
      fsonly: JSON.stringify({ name: 'fsonly', filesystem: { allow: ['/x'] } }),
    },
  });
  assert.equal(noNet.ok, true);
  for (const f of noNet.value) {
    assert.equal(
      f.classification,
      'unknown',
      `absent network → endpoint unknown for ${f.capability}; got ${JSON.stringify(f)}`,
    );
    assert.equal(typeof f.missingCapability, 'undefined', 'unknown carries no missingCapability');
  }

  // allow_domain hit under block=true → compatible; miss → blocker.
  const allowlisted = assess(audit, ['al'], {
    grantsByProfile: {
      al: JSON.stringify({ name: 'al', network: { block: true, allow_domain: ['api.anthropic.com'] } }),
    },
  });
  assert.equal(allowlisted.ok, true);
  const anthropic = allowlisted.value.find((f) => f.capability.includes('api.anthropic.com'));
  assert.equal(anthropic.classification, 'compatible', 'allow_domain hit → compatible');
  const blocked = allowlisted.value.find((f) => f.capability.includes('blocked.test'));
  assert.equal(blocked.classification, 'blocker', 'allow_domain miss under block → blocker');
  assert.equal(blocked.missingCapability, 'network-endpoint:blocked.test', 'blocker names the host');
});

// ────────────────────────────────────────────────────────────────────
// 5. COMPLETENESS: every observation maps to EXACTLY ONE classification.
// ────────────────────────────────────────────────────────────────────

test('every observation maps to exactly one classification (no drop, no double-classify)', () => {
  const audit = loadAudit();
  const findings = classifyManaged();

  const validClasses = new Set(['compatible', 'warning', 'blocker', 'unknown']);
  for (const f of findings) {
    assert.ok(
      validClasses.has(f.classification),
      `every finding carries exactly one valid classification; got ${JSON.stringify(f)}`,
    );
    if (f.classification !== 'blocker') {
      assert.equal(
        typeof f.missingCapability,
        'undefined',
        `missingCapability only on blockers; got ${JSON.stringify(f)}`,
      );
    }
    assert.equal(f.profile, 'opencode-managed', 'every finding carries the profile');
    assert.equal(typeof f.capability, 'string', 'every finding carries an observed capability');
  }

  // Each observed record contributes >=1 finding (no observation dropped).
  for (const rec of audit.capabilities) {
    const forTool = findings.filter(
      (f) => typeof f.capability === 'string' && f.capability.includes(rec.tool),
    );
    assert.ok(
      forTool.length >= 1,
      `observation for tool '${rec.tool}' must produce >=1 finding; got ${JSON.stringify(findings)}`,
    );
  }

  // The multi-command bash record must produce a finding per command.
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
  for (const f of bashFindings) {
    assert.equal(f.classification, 'unknown', 'bash commands are unknown in the real grant model');
  }
});

// ────────────────────────────────────────────────────────────────────
// 6. DETERMINISM: identical inputs yield identical, stably-ordered output.
// ────────────────────────────────────────────────────────────────────

test('classification is deterministic and stably ordered', () => {
  const audit = loadAudit();
  const opts = { grantsByProfile: managedGrantsByProfile('opencode-managed') };

  const a = assess(audit, ['opencode-managed'], opts);
  const b = assess(audit, ['opencode-managed'], opts);
  assert.deepEqual(a, b, 'repeated assess over identical inputs must be identical');
});

// ────────────────────────────────────────────────────────────────────
// 7. NONO-ABSENT (real): assess driven through the live (absent) nono
//    yields the SKIP (no fabricated compatible) — distinct from
//    classification. (R2.4 false-compatible avoidance.)
// ────────────────────────────────────────────────────────────────────

test('assess with the real absent nono binary → skipped, no fabricated compatible', () => {
  const audit = loadAudit();

  let res;
  assert.doesNotThrow(() => {
    res = assess(audit, ['opencode-managed'], { nonoBin: ABSENT_BIN });
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

  const fabricatedCompatible = (res.value.findings || []).filter(
    (f) => f.classification === 'compatible',
  );
  assert.equal(
    fabricatedCompatible.length,
    0,
    `a skip must NOT fabricate compatible findings; got ${JSON.stringify(res.value)}`,
  );
});
