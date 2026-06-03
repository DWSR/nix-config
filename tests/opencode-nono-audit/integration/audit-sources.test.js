/*
 * audit-sources.test.js — integration tests for runAudit's source-opening
 * layer (opencode-nono-audit spec, Task 2.1, Requirements 1.1, 1.3, 1.4,
 * 1.5, 1.6).
 *
 * This file owns the source-opening + SourceStatus + partial +
 * no-source-error contract of runAudit. Capability extraction (parsing
 * tool parts into CapabilityRecord[]) and unobservableClasses population
 * are task 2.2 and are asserted in audit-capabilities.test.js; here we
 * only require capabilities/unobservableClasses to be arrays.
 *
 * These tests live under tests/opencode-nono-audit/integration/ (NOT
 * inside fixtures/) because run.js's discoverTestFiles() recurses into
 * every subdirectory except fixtures/ and node_modules/.
 *
 * runAudit is required from scripts/opencode-nono-audit.js. The CLI's
 * own SqliteReader require falls back to a relative path
 * (../scripts/opencode-cost-report.js resolved from the CLI file's
 * __dirname) when OPENCODE_NONO_COST_REPORT_LIB is unset, which is the
 * case under `opencode-cost-diagnosis-node --test` (the env var is only
 * exported by the .nix wrapper at runtime). So no env setup is required
 * here — mirrors how fixtures-load.test.js requires the reader by
 * relative path.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runAudit } = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
const CAVEMEM_DB = path.join(FIXTURES_DIR, 'cavemem-data.db');
const MISSING_DB = path.join(FIXTURES_DIR, 'does-not-exist-session.db');
const MISSING_CAVEMEM = path.join(FIXTURES_DIR, 'does-not-exist-cavemem.db');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Find the SourceStatus entry for a given EvidenceSource. */
function sourceOf(audit, source) {
  return audit.sources.find((s) => s.source === source);
}

/** Snapshot {mtimeMs, size} for a file path. */
function statSnapshot(p) {
  const st = fs.statSync(p);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

// ────────────────────────────────────────────────────────────────────
// 1. Valid session DB → ok, partial=false
// ────────────────────────────────────────────────────────────────────

test('runAudit over the valid session fixture → ok source, partial=false', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true, `expected ok Result; got ${JSON.stringify(res)}`);

  const audit = res.value;
  assert.equal(audit.schemaVersion, 1);
  assert.equal(typeof audit.generatedAt, 'string');
  assert.ok(audit.generatedAt.length > 0, 'generatedAt must be non-empty');

  const sqlite = sourceOf(audit, 'opencode-sqlite');
  assert.ok(sqlite, 'expected an opencode-sqlite SourceStatus');
  assert.equal(sqlite.status, 'ok');

  // No cavemem path configured and the only source is ok → not partial.
  assert.equal(audit.partial, false, 'no degraded source → partial must be false');

  // Task 2.2 populates capabilities + unobservableClasses. The
  // source-opening contract this test guards only requires that both
  // are arrays (capability extraction itself is asserted in
  // audit-capabilities.test.js).
  assert.ok(Array.isArray(audit.capabilities), 'capabilities must be an array');
  assert.ok(Array.isArray(audit.unobservableClasses), 'unobservableClasses must be an array');
});

// ────────────────────────────────────────────────────────────────────
// 2. Drift session DB → incompatible + partial, no crash (R1.4)
// ────────────────────────────────────────────────────────────────────

test('runAudit over the drift fixture → opencode-sqlite incompatible + partial (no crash)', () => {
  // Must not throw on schema drift.
  const res = runAudit({ sessionDbPath: DRIFT_DB });
  assert.equal(res.ok, true, 'drift must degrade to a partial report, not an error Result');

  const audit = res.value;
  const sqlite = sourceOf(audit, 'opencode-sqlite');
  assert.ok(sqlite, 'expected an opencode-sqlite SourceStatus');
  assert.equal(sqlite.status, 'incompatible', 'schema drift maps to incompatible');
  assert.equal(typeof sqlite.detail, 'string');
  assert.ok(sqlite.detail.length > 0, 'incompatible source must carry a detail');
  assert.equal(audit.partial, true, 'an incompatible source marks the report partial');
});

// ────────────────────────────────────────────────────────────────────
// 3. Missing session + no cavemem → error Result (R1.5)
// ────────────────────────────────────────────────────────────────────

test('runAudit with a missing session path and no cavemem → error Result (R1.5)', () => {
  const res = runAudit({ sessionDbPath: MISSING_DB });
  assert.equal(res.ok, false, 'no readable source must yield an error Result');
  assert.ok(res.error, 'error Result must carry an error');
  // No UsageAudit / assessment when nothing is readable.
  assert.equal(res.value, undefined, 'error Result must not carry a UsageAudit value');
  // The error should name the failing source so the operator can act (R1.4/1.5).
  const blob = JSON.stringify(res.error);
  assert.match(blob, /opencode-sqlite/, 'error should name the opencode-sqlite source');
});

// ────────────────────────────────────────────────────────────────────
// 4. cavemem secondary source (R1.3)
// ────────────────────────────────────────────────────────────────────

test('runAudit with valid session + valid cavemem → cavemem source ok', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB, cavememDbPath: CAVEMEM_DB });
  assert.equal(res.ok, true);

  const audit = res.value;
  assert.equal(sourceOf(audit, 'opencode-sqlite').status, 'ok');

  const cavemem = sourceOf(audit, 'cavemem');
  assert.ok(cavemem, 'cavemem SourceStatus must be present when a path is configured');
  assert.equal(cavemem.status, 'ok', 'valid cavemem fixture (schema_version=2) → ok');

  // Both sources ok → not partial.
  assert.equal(audit.partial, false);
});

test('runAudit with valid session + bad cavemem path → cavemem unreadable + partial, session still ok', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB, cavememDbPath: MISSING_CAVEMEM });
  assert.equal(res.ok, true, 'a bad cavemem secondary must not fail the whole audit');

  const audit = res.value;
  // The primary session source stays ok.
  assert.equal(sourceOf(audit, 'opencode-sqlite').status, 'ok');

  const cavemem = sourceOf(audit, 'cavemem');
  assert.ok(cavemem, 'a configured-but-bad cavemem path must still be recorded');
  assert.ok(
    cavemem.status === 'unreadable' || cavemem.status === 'missing',
    `bad cavemem path → unreadable/missing; got ${cavemem.status}`,
  );
  assert.equal(audit.partial, true, 'a degraded configured cavemem marks the report partial');
});

test('runAudit with NO cavemem configured → cavemem absence does not mark partial', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true);
  const audit = res.value;
  // An optional, unconfigured source must not be treated as a degradation.
  assert.equal(audit.partial, false, 'absence of an optional source is not partial');
});

// ────────────────────────────────────────────────────────────────────
// 5. READ-ONLY guarantee (R1.6): mtime + size unchanged
// ────────────────────────────────────────────────────────────────────

test('runAudit does not mutate the session fixture (mtime + size unchanged) (R1.6)', () => {
  const before = statSnapshot(SESSION_DB);
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true);
  const after = statSnapshot(SESSION_DB);
  assert.equal(after.mtimeMs, before.mtimeMs, 'session fixture mtime changed — audit is not read-only');
  assert.equal(after.size, before.size, 'session fixture size changed — audit is not read-only');
});

test('runAudit does not mutate the cavemem fixture (mtime + size unchanged) (R1.6)', () => {
  const beforeSession = statSnapshot(SESSION_DB);
  const beforeCavemem = statSnapshot(CAVEMEM_DB);
  const res = runAudit({ sessionDbPath: SESSION_DB, cavememDbPath: CAVEMEM_DB });
  assert.equal(res.ok, true);
  const afterSession = statSnapshot(SESSION_DB);
  const afterCavemem = statSnapshot(CAVEMEM_DB);

  assert.equal(afterSession.mtimeMs, beforeSession.mtimeMs, 'session fixture mtime changed');
  assert.equal(afterSession.size, beforeSession.size, 'session fixture size changed');
  assert.equal(afterCavemem.mtimeMs, beforeCavemem.mtimeMs, 'cavemem fixture mtime changed');
  assert.equal(afterCavemem.size, beforeCavemem.size, 'cavemem fixture size changed');
});
