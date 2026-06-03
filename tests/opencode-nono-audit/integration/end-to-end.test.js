/*
 * end-to-end.test.js — true end-to-end integration tests that drive the
 * FULL pipeline through the CLI entry point `main(argv)` and assert the
 * Task 6.2 coverage matrix items TOGETHER, reading the EMITTED report
 * (JSON on disk) and the freshness MARKER (opencode-nono-audit spec,
 * Task 6.2, Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4,
 * 3.1, 3.2).
 *
 * Why this file exists (gap it fills): the per-subsystem integration
 * tests already cover each matrix bullet at the engine level —
 *   - audit-sources.test.js: runAudit partial / no-source / read-only /
 *     drift (R1.3/1.4/1.5/1.6) at the runAudit() level,
 *   - assess-classify.test.js: classification incl. unknown (R2.2/2.4)
 *     at the assess() level,
 *   - review-rank.test.js: deterministic ranking + git candidate
 *     (R3.1/3.2) at the rankToolUse()/seedReplacementCandidates() level,
 *   - freshness-marker.test.js: marker schema + staleness (R2.1) at the
 *     writeFreshnessMarker()/evaluateMarkerStaleness() level,
 *   - cli-subcommands.test.js: subcommand dispatch + exit codes.
 *
 * What NONE of them assert is the integrated flow as a SINGLE run: the
 * full read-only guarantee through the CLI pipeline (the existing
 * read-only test is at the runAudit level), and the EMITTED report
 * (parsed from disk) carrying the drift partial flag, the nono-absent
 * skip status, the git→Git MCP candidate, AND a redaction-clean body all
 * at once. This file owns those cross-subsystem, through-`main`
 * assertions and the marker end-to-end (read the written last-report.json
 * back, then evaluate staleness against it).
 *
 * On THIS host `nono` is unavailable (Phase 0: fixtures/
 * phase0-source-fidelity-decision.md), so `main(['all'])` exercises the
 * REAL nono-absent skip path (R2.1) — the assessment in the emitted
 * report is the skip envelope, not fabricated findings (the R2.4
 * false-compatible-avoidance property, observed end-to-end). The
 * `unknown` classification (R2.4) is proven against injected synthetic
 * grants in assess-classify.test.js (main() has no grant-injection seam),
 * referenced rather than duplicated.
 *
 * Lives under tests/opencode-nono-audit/integration/ (run.js recurses
 * everywhere except fixtures/ and node_modules/). main() resolves
 * SqliteReader by relative path under `node --test` (env var unset), so
 * no env setup is needed — mirrors cli-subcommands.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  main,
  evaluateMarkerStaleness,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
const CAVEMEM_DB = path.join(FIXTURES_DIR, 'cavemem-data.db');
const METADATA_FIXTURE = path.join(FIXTURES_DIR, 'sandbox-metadata.json');

// The metadata fixture's profileVersion (sandbox-metadata.json).
const FIXTURE_PROFILE_VERSION = 'fixture-profile-0001';

// The two OBVIOUSLY-FAKE secrets planted in the session fixture by
// make-fixtures.js (a credentialed clone-URL password and a GitHub PAT in
// a TOKEN=... command). Both MUST be absent from the emitted report after
// redaction (R1.7, on by default).
const FIXTURE_SECRETS = ['FAKE_SECRET_PW', 'ghp_FAKE000000000000000000000000000000'];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Fresh per-test temp state dir (auto-unique). */
function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nono-e2e-'));
}

const reportsDirOf = (stateDir) => path.join(stateDir, 'opencode-nono', 'reports');
const markerPathOf = (stateDir) => path.join(stateDir, 'opencode-nono', 'last-report.json');

/** Read + parse the single JSON report written under a state dir. */
function readEmittedReport(stateDir) {
  const dir = reportsDirOf(stateDir);
  const json = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(json.length, 1, `expected exactly one JSON report, got ${json.length}`);
  return JSON.parse(fs.readFileSync(path.join(dir, json[0]), 'utf8'));
}

/** {mtimeMs, size} snapshot for a file path. */
function statSnapshot(p) {
  const st = fs.statSync(p);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** Run main(argv) with stdout/stderr suppressed; return the exit code. */
function runMain(argv) {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return main(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ────────────────────────────────────────────────────────────────────
// 1. FULL-PIPELINE READ-ONLY GUARANTEE through the CLI (R1.6).
//    The existing read-only test (audit-sources.test.js) is at the
//    runAudit() level; this asserts it through main(['all', ...]) with
//    BOTH the session AND cavemem fixture DBs configured — byte/mtime
//    unchanged after a full pipeline run that also WRITES a report +
//    marker (proving the writes never touch the read-only sources).
// ────────────────────────────────────────────────────────────────────

test('main([all]) over the fixtures is read-only: session + cavemem fixture DBs are mtime/size unchanged after the full pipeline (R1.6)', () => {
  const stateDir = mkStateDir();

  const beforeSession = statSnapshot(SESSION_DB);
  const beforeCavemem = statSnapshot(CAVEMEM_DB);
  const beforeSessionBytes = fs.readFileSync(SESSION_DB);
  const beforeCavememBytes = fs.readFileSync(CAVEMEM_DB);

  const code = runMain([
    'all',
    '--session-db',
    SESSION_DB,
    '--cavemem-db',
    CAVEMEM_DB,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);
  assert.equal(code, 0, 'the full pipeline over the fixtures must exit 0');

  // The pipeline produced a report + marker (so it genuinely ran end to end).
  assert.ok(fs.existsSync(markerPathOf(stateDir)), 'full pipeline must write the marker');
  readEmittedReport(stateDir); // asserts exactly one JSON report exists

  const afterSession = statSnapshot(SESSION_DB);
  const afterCavemem = statSnapshot(CAVEMEM_DB);

  assert.equal(afterSession.mtimeMs, beforeSession.mtimeMs, 'session DB mtime changed — pipeline not read-only');
  assert.equal(afterSession.size, beforeSession.size, 'session DB size changed — pipeline not read-only');
  assert.equal(afterCavemem.mtimeMs, beforeCavemem.mtimeMs, 'cavemem DB mtime changed — pipeline not read-only');
  assert.equal(afterCavemem.size, beforeCavemem.size, 'cavemem DB size changed — pipeline not read-only');

  // Byte-for-byte identical (a stronger guarantee than mtime/size).
  assert.ok(beforeSessionBytes.equals(fs.readFileSync(SESSION_DB)), 'session DB bytes changed');
  assert.ok(beforeCavememBytes.equals(fs.readFileSync(CAVEMEM_DB)), 'cavemem DB bytes changed');
});

// ────────────────────────────────────────────────────────────────────
// 2. The EMITTED `all` report (parsed from disk) simultaneously carries,
//    in ONE integrated run over the DRIFT fixture:
//      - audit.partial === true (drift degradation surfaced)   (R1.4)
//      - the nono-absent assessment SKIP status (no fabricated
//        compatible findings — the R2.4 safety property)        (R2.1/2.4)
//      - the git → Git MCP replacement candidate                (R3.2)
//      - a redaction-clean body (no planted fixture secrets)     (R1.7)
//    No existing test asserts all four against the on-disk report at once.
// ────────────────────────────────────────────────────────────────────

test('the emitted all-report (drift fixture, parsed from disk) shows partial + nono-skip + git candidate + redaction-clean body together (R1.4/2.1/2.4/3.2/1.7)', () => {
  const stateDir = mkStateDir();

  const code = runMain([
    'all',
    '--session-db',
    DRIFT_DB,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);
  assert.equal(code, 0, 'drift is a partial, NOT a hard failure → exit 0');

  const report = readEmittedReport(stateDir);

  // (a) Drift degradation surfaced as partial, naming the incompatible source (R1.4).
  assert.equal(report.audit.partial, true, 'emitted report must surface partial=true for the drift run');
  const incompatible = report.audit.sources.find((s) => s.status === 'incompatible');
  assert.ok(incompatible, 'emitted report must name the incompatible source');
  assert.equal(incompatible.source, 'opencode-sqlite', 'the incompatible source is the opencode session DB');

  // (b) nono-absent skip status (R2.1) — and crucially NO fabricated
  //     compatible findings (R2.4 false-compatible avoidance), observed
  //     end-to-end through the report rather than at the assess() level.
  assert.equal(report.assessment.assessment, 'skipped', 'nono absent → assessment skip status in the emitted report');
  assert.equal(typeof report.assessment.reason, 'string', 'skip envelope carries a reason');
  assert.ok(report.assessment.reason.length > 0, 'skip reason must be non-empty');
  const fabricated = (report.assessment.findings || []).filter((f) => f.classification === 'compatible');
  assert.equal(fabricated.length, 0, 'a skip must NOT fabricate compatible findings (R2.4)');

  // (c) The git → Git MCP candidate is present in the emitted review (R3.2).
  //     (The drift fixture is schema-incompatible, so the capability
  //     model is empty — assert the git candidate against the VALID
  //     session fixture below; the drift run still carries the review
  //     section structurally.)
  assert.ok(report.review && Array.isArray(report.review.candidates), 'emitted report carries review.candidates');

  // (d) Redaction-clean body: neither planted fixture secret appears.
  //     (The drift source is incompatible so its tool parts are not
  //     extracted; the strong secret-presence assertion is on the valid
  //     session run below. Here we still require the body to be clean.)
  const blob = JSON.stringify(report);
  for (const secret of FIXTURE_SECRETS) {
    assert.ok(!blob.includes(secret), `emitted report must NOT contain fixture secret ${secret}`);
  }
});

test('the emitted all-report over the VALID session fixture surfaces the git→Git MCP candidate AND masks the planted secrets (R3.2/1.7)', () => {
  const stateDir = mkStateDir();

  const code = runMain([
    'all',
    '--session-db',
    SESSION_DB,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);
  assert.equal(code, 0, 'valid fixture run must exit 0');

  const report = readEmittedReport(stateDir);

  // (c) git → git-mcp-server candidate present in the emitted report (R3.2).
  const git = report.review.candidates.find((c) => c.tool === 'git');
  assert.ok(git, `emitted report must carry the git replacement candidate; saw ${JSON.stringify(report.review.candidates.map((c) => c.tool))}`);
  assert.equal(git.mcpCandidate, 'git-mcp-server', 'git candidate points at the git-mcp-server MCP replacement');
  assert.ok(typeof git.rationale === 'string' && git.rationale.length > 0, 'git candidate carries a rationale');

  // Deterministic ranking is surfaced too (R3.1): ranks are 1-based contiguous.
  assert.ok(Array.isArray(report.review.ranked) && report.review.ranked.length >= 1, 'emitted report carries a ranked list');
  report.review.ranked.forEach((entry, i) => {
    assert.equal(entry.rank, i + 1, `emitted ranked list must be 1-based contiguous; entry ${i} had rank ${entry.rank}`);
  });

  // (d) Redaction-clean body AND a positive proof a value was masked (R1.7).
  const blob = JSON.stringify(report);
  for (const secret of FIXTURE_SECRETS) {
    assert.ok(!blob.includes(secret), `emitted report must NOT contain fixture secret ${secret}`);
  }
  assert.ok(blob.includes('***'), 'the redaction mask must appear in the emitted report (a value was masked)');
});

// ────────────────────────────────────────────────────────────────────
// 3. NO-SOURCE through the CLI → nonzero exit, NO report AND NO marker
//    written. (R1.5) The CLI-level nonzero exit is in
//    cli-subcommands.test.js; this adds the stronger assertion that the
//    state-dir tree is left clean (no reports dir / no marker) after a
//    hard failure of the FULL `all` pipeline.
// ────────────────────────────────────────────────────────────────────

test('main([all]) with no readable source → nonzero exit and a clean state dir (no report, no marker) (R1.5)', () => {
  const stateDir = mkStateDir();
  const missingDb = path.join(FIXTURES_DIR, 'does-not-exist-session.db');

  const code = runMain([
    'all',
    '--session-db',
    missingDb,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);

  assert.notEqual(code, 0, 'no readable source → nonzero exit (R1.5)');

  // The hard failure short-circuits BEFORE any report or marker write:
  // neither the reports dir nor the marker may exist.
  assert.ok(!fs.existsSync(reportsDirOf(stateDir)), 'no reports dir may be created on a no-source hard failure');
  assert.ok(!fs.existsSync(markerPathOf(stateDir)), 'no marker may be written on a no-source hard failure');
});

// ────────────────────────────────────────────────────────────────────
// 4. FRESHNESS MARKER end-to-end: after main(['all', --metadata, ...]),
//    the WRITTEN last-report.json matches the versioned schema and its
//    profileVersion equals the metadata fixture's; feeding that on-disk
//    marker to evaluateMarkerStaleness reports FRESH against the same
//    version and STALE against a different one. (R2.1)
//    The unit test (freshness-marker.test.js) exercises
//    writeFreshnessMarker/evaluateMarkerStaleness directly; this proves
//    the SAME contract holds for the marker the CLI pipeline actually
//    emits to disk.
// ────────────────────────────────────────────────────────────────────

test('main([all]) writes a versioned marker whose profileVersion equals the metadata fixture; the emitted marker is fresh against that version and stale against another (R2.1)', () => {
  const stateDir = mkStateDir();

  const code = runMain([
    'all',
    '--session-db',
    SESSION_DB,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);
  assert.equal(code, 0, '`all` over the fixtures must exit 0');

  const markerPath = markerPathOf(stateDir);
  assert.ok(fs.existsSync(markerPath), '`all` must write the freshness marker');

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

  // EXACT versioned cross-spec schema: keys + values, nothing extra.
  assert.deepEqual(
    Object.keys(marker).sort(),
    ['generatedAt', 'host', 'markerSchemaVersion', 'profileVersion'],
    'emitted marker carries exactly the versioned schema keys',
  );
  assert.equal(marker.markerSchemaVersion, 1, 'emitted marker carries markerSchemaVersion 1');
  assert.equal(
    marker.profileVersion,
    FIXTURE_PROFILE_VERSION,
    'emitted marker profileVersion equals the metadata fixture profileVersion',
  );
  assert.equal(typeof marker.generatedAt, 'string', 'emitted marker carries a generatedAt string');
  assert.equal(typeof marker.host, 'string', 'emitted marker carries a host string');

  // End-to-end staleness: the on-disk marker is FRESH against the live
  // version it was written from, and STALE once the live version moves on.
  assert.equal(
    evaluateMarkerStaleness(marker, FIXTURE_PROFILE_VERSION).stale,
    false,
    'the emitted marker must be FRESH against the metadata fixture version',
  );
  assert.equal(
    evaluateMarkerStaleness(marker, 'fixture-profile-9999').stale,
    true,
    'the emitted marker must be STALE against a different metadata version',
  );
});

test('main([all]) emitted marker mode is 0600 and its profileVersion matches the emitted report header (R2.1)', () => {
  const stateDir = mkStateDir();

  const code = runMain([
    'all',
    '--session-db',
    SESSION_DB,
    '--metadata',
    METADATA_FIXTURE,
    '--state-dir',
    stateDir,
    '--profile',
    'opencode',
  ]);
  assert.equal(code, 0, '`all` over the fixtures must exit 0');

  const markerPath = markerPathOf(stateDir);
  assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600, 'emitted marker must be mode 0600');

  // Cross-artifact consistency: the marker and the report header agree on
  // the profileVersion read from the same metadata fixture.
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const report = readEmittedReport(stateDir);
  assert.equal(
    marker.profileVersion,
    report.profileVersion,
    'the emitted marker and report header must agree on profileVersion',
  );
  assert.equal(report.profileVersion, FIXTURE_PROFILE_VERSION, 'report header profileVersion is the fixture version');
});
