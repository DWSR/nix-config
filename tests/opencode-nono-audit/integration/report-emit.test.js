/*
 * report-emit.test.js — integration tests for the Reporter
 * (opencode-nono-audit spec, Task 5.1, Requirements 2.5, 1.7, 1.4).
 *
 * Task 5.1 assembles ONE stably-key-ordered report object from the
 * UsageAudit (runAudit), the assessment (assess), and the review
 * (rankToolUse + seedReplacementCandidates + reconcileLedger), passes
 * EVERY secret-bearing string through redact() at serialization time
 * (R1.7), serializes to byte-stable JSON + human-readable Markdown
 * (R2.5), and writes both under
 * `${stateDir}/opencode-nono/reports/<ISO>.{json,md}` at mode 0600 with
 * last-N retention (R1.4 location). The header records schemaVersion,
 * host, profileVersion (read from the sandbox-rendered metadata), and
 * generatedAt.
 *
 * The freshness marker (last-report.json) is task 5.2 and the CLI
 * subcommand wiring is task 5.3 — neither is exercised here.
 *
 * Lives under tests/opencode-nono-audit/integration/ (run.js recurses
 * everywhere except fixtures/ and node_modules/). runAudit resolves
 * SqliteReader by relative path under `node --test` (env var unset), so
 * no env setup is needed — mirrors audit-sources.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runAudit,
  assess,
  rankToolUse,
  seedReplacementCandidates,
  reconcileLedger,
  emitReport,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
// Real-shape managed grants (task 3.3/3.4): the synthetic shape was
// removed; the Reporter just needs a non-skipped assessment to render.
const MANAGED_GRANTS = path.join(
  FIXTURES_DIR,
  'nono-profile-show-managed.realshape.json',
);
const METADATA_FIXTURE = path.join(FIXTURES_DIR, 'sandbox-metadata.json');

// The two OBVIOUSLY-FAKE secrets planted in the session fixture by
// make-fixtures.js: a credentialed clone URL password and a GitHub PAT
// in a TOKEN=... command. Both MUST be absent from the serialized
// output after redaction (R1.7).
const FIXTURE_SECRETS = ['FAKE_SECRET_PW', 'ghp_FAKE000000000000000000000000000000'];

// A FIXED injected timestamp so byte-stability does not depend on the
// wall clock. Filename-safe stem derived from this is used to locate the
// written files.
const FIXED_GENERATED_AT = '2026-06-03T12:34:56.000Z';
const FIXED_STEM = FIXED_GENERATED_AT.replace(/:/g, '-');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Fresh per-test temp state dir (auto-unique). */
function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nono-report-'));
}

/**
 * Assemble the full review bundle (ranked + candidates + ledger
 * reconciliation) for an audit, with an empty (operator-not-created)
 * ledger so every candidate is undecided.
 */
function buildReview(audit) {
  const ranked = rankToolUse(audit);
  const candidates = seedReplacementCandidates(audit);
  const ledger = reconcileLedger(candidates, { ledger: { entries: [] } });
  return { ranked, candidates, ledger };
}

/** Assemble the standard inputs (audit/assessment/review) over a DB. */
function buildInputs(dbPath) {
  const audit = runAudit({ sessionDbPath: dbPath }).value;
  const grantsJson = fs.readFileSync(MANAGED_GRANTS, 'utf8');
  const assessment = assess(audit, ['opencode-managed'], {
    grantsByProfile: { 'opencode-managed': grantsJson },
  }).value;
  const review = buildReview(audit);
  return { audit, assessment, review };
}

// ────────────────────────────────────────────────────────────────────
// 1. BYTE-STABLE JSON + Markdown (R2.5)
// ────────────────────────────────────────────────────────────────────

test('emitReport produces byte-identical JSON + Markdown across runs with a fixed generatedAt (R2.5)', () => {
  const stateDirA = mkStateDir();
  const stateDirB = mkStateDir();
  const inputs = buildInputs(SESSION_DB);

  const opts = {
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: METADATA_FIXTURE,
  };

  const a = emitReport({ ...opts, stateDir: stateDirA });
  const b = emitReport({ ...opts, stateDir: stateDirB });

  assert.equal(typeof a.json, 'string', 'json must be a string');
  assert.equal(typeof a.markdown, 'string', 'markdown must be a string');
  assert.equal(a.json, b.json, 'JSON must be byte-identical for identical inputs');
  assert.equal(a.markdown, b.markdown, 'Markdown must be byte-identical for identical inputs');

  // The serialized JSON must itself round-trip and re-serialize to the
  // same bytes (stable key ordering, not just stable across two
  // emitReport calls).
  assert.equal(JSON.stringify(JSON.parse(a.json)), JSON.stringify(JSON.parse(b.json)));
});

// ────────────────────────────────────────────────────────────────────
// 2. 0600 + XDG-state location (R1.4)
// ────────────────────────────────────────────────────────────────────

test('emitReport writes JSON + Markdown at mode 0600 under <stateDir>/opencode-nono/reports (R1.4)', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(SESSION_DB);

  const res = emitReport({
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: METADATA_FIXTURE,
    stateDir,
  });

  const reportsDir = path.join(stateDir, 'opencode-nono', 'reports');
  const jsonPath = path.join(reportsDir, `${FIXED_STEM}.json`);
  const mdPath = path.join(reportsDir, `${FIXED_STEM}.md`);

  assert.ok(fs.existsSync(jsonPath), `expected JSON report at ${jsonPath}`);
  assert.ok(fs.existsSync(mdPath), `expected Markdown report at ${mdPath}`);

  // Reporter returns the written paths.
  assert.equal(res.jsonPath, jsonPath);
  assert.equal(res.mdPath, mdPath);

  assert.equal(fs.statSync(jsonPath).mode & 0o777, 0o600, 'JSON must be mode 0600');
  assert.equal(fs.statSync(mdPath).mode & 0o777, 0o600, 'Markdown must be mode 0600');

  // The bytes on disk match the returned serialization.
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), res.json);
  assert.equal(fs.readFileSync(mdPath, 'utf8'), res.markdown);
});

// ────────────────────────────────────────────────────────────────────
// 3. REDACTION: fixture secrets absent, legit content present (R1.7)
// ────────────────────────────────────────────────────────────────────

test('emitReport redacts every secret-bearing string from JSON + Markdown (R1.7)', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(SESSION_DB);

  // Sanity: the RAW audit still carries the planted secrets, so the
  // redaction below is genuinely exercised (RED would surface here if
  // redaction were not wired into serialization).
  const rawAudit = JSON.stringify(inputs.audit);
  for (const secret of FIXTURE_SECRETS) {
    assert.ok(
      rawAudit.includes(secret),
      `precondition: raw audit must contain ${secret} so redaction is exercised`,
    );
  }

  const res = emitReport({
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: METADATA_FIXTURE,
    stateDir,
  });

  for (const secret of FIXTURE_SECRETS) {
    assert.ok(
      !res.json.includes(secret),
      `serialized JSON must NOT contain fixture secret ${secret}`,
    );
    assert.ok(
      !res.markdown.includes(secret),
      `serialized Markdown must NOT contain fixture secret ${secret}`,
    );
  }

  // Legitimate non-secret content (the credential-free host of the
  // clone URL, and a real tool name) survives redaction.
  assert.ok(res.json.includes('example.invalid'), 'non-secret URL host must survive');
  assert.ok(res.json.includes('bash'), 'a real observed tool name must survive');

  // The mask token must be present (proves a value was actually masked,
  // not merely dropped).
  assert.ok(res.json.includes('***'), 'the redaction mask must appear in the output');
});

// ────────────────────────────────────────────────────────────────────
// 4. HEADER: schemaVersion / host / profileVersion / generatedAt
// ────────────────────────────────────────────────────────────────────

test('emitReport header carries schemaVersion, host, profileVersion (from metadata), generatedAt', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(SESSION_DB);

  const res = emitReport({
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: METADATA_FIXTURE,
    stateDir,
  });

  const report = res.report;
  assert.equal(report.schemaVersion, 1, 'report.schemaVersion must be 1');
  assert.equal(report.host, 'fixture-host', 'header host must be the injected host');
  assert.equal(
    report.profileVersion,
    'fixture-profile-0001',
    'profileVersion must be read from the metadata fixture',
  );
  assert.equal(report.generatedAt, FIXED_GENERATED_AT, 'generatedAt must be the injected timestamp');

  // The same header fields are visible in the serialized JSON.
  const parsed = JSON.parse(res.json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.host, 'fixture-host');
  assert.equal(parsed.profileVersion, 'fixture-profile-0001');
  assert.equal(parsed.generatedAt, FIXED_GENERATED_AT);

  // Markdown header surfaces the version + timestamp too.
  assert.ok(res.markdown.includes('fixture-profile-0001'), 'MD header must name profileVersion');
  assert.ok(res.markdown.includes(FIXED_GENERATED_AT), 'MD header must name generatedAt');
});

test('emitReport gracefully defaults profileVersion when metadata is absent (no crash)', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(SESSION_DB);

  const res = emitReport({
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: path.join(FIXTURES_DIR, 'does-not-exist-metadata.json'),
    stateDir,
  });

  // Absent metadata → a graceful default, never a throw / undefined key.
  assert.ok(
    res.report.profileVersion === null || res.report.profileVersion === 'unknown',
    `absent metadata must yield a graceful default; got ${JSON.stringify(res.report.profileVersion)}`,
  );
  // The key still exists in the serialized JSON (stable shape).
  assert.ok('profileVersion' in JSON.parse(res.json), 'profileVersion key must always be present');
});

// ────────────────────────────────────────────────────────────────────
// 5. RETENTION: prune to last N per extension
// ────────────────────────────────────────────────────────────────────

test('emitReport prunes the reports dir to the last N per extension (retention override)', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(SESSION_DB);
  const reportsDir = path.join(stateDir, 'opencode-nono', 'reports');

  const RETENTION = 3;
  const WRITES = 6;

  // Distinct injected timestamps so each write lands at its own
  // filename stem (no overwrite); retention then prunes the oldest.
  for (let i = 0; i < WRITES; i += 1) {
    const ts = `2026-06-03T12:00:${String(i).padStart(2, '0')}.000Z`;
    emitReport({
      ...inputs,
      generatedAt: ts,
      host: 'fixture-host',
      metadataPath: METADATA_FIXTURE,
      stateDir,
      retentionCount: RETENTION,
    });
  }

  const entries = fs.readdirSync(reportsDir);
  const jsons = entries.filter((n) => n.endsWith('.json'));
  const mds = entries.filter((n) => n.endsWith('.md'));

  assert.equal(jsons.length, RETENTION, `expected ${RETENTION} JSON reports after pruning`);
  assert.equal(mds.length, RETENTION, `expected ${RETENTION} Markdown reports after pruning`);
});

// ────────────────────────────────────────────────────────────────────
// 6. PARTIAL surfaced (R1.4): a degraded source is named in the report
// ────────────────────────────────────────────────────────────────────

test('emitReport over the drift fixture marks the report partial and names the incompatible source (R1.4)', () => {
  const stateDir = mkStateDir();
  const inputs = buildInputs(DRIFT_DB);

  // Precondition: the drift audit is partial with an incompatible source.
  assert.equal(inputs.audit.partial, true, 'drift audit must be partial');

  const res = emitReport({
    ...inputs,
    generatedAt: FIXED_GENERATED_AT,
    host: 'fixture-host',
    metadataPath: METADATA_FIXTURE,
    stateDir,
  });

  const parsed = JSON.parse(res.json);
  assert.equal(parsed.audit.partial, true, 'report must surface partial=true');

  const incompatible = parsed.audit.sources.find((s) => s.status === 'incompatible');
  assert.ok(incompatible, 'report must name the incompatible source');
  assert.equal(incompatible.source, 'opencode-sqlite');

  // Markdown surfaces the partial state for the operator.
  assert.match(res.markdown, /partial/i, 'Markdown must surface the partial state');
});
