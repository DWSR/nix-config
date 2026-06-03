/*
 * freshness-marker.test.js — unit test for the cross-spec freshness
 * marker (Task 5.2, Requirement 2.1).
 *
 * Observable completion (task 5.2): the marker is written with the
 * version read from the metadata fixture, and a mismatched version is
 * reported stale.
 *
 * Design contract (design.md:338): the Reporter writes
 *   `${XDG_STATE_HOME}/opencode-nono/last-report.json`
 *   = { markerSchemaVersion: 1, profileVersion, generatedAt, host }
 * at mode 0600 — a versioned cross-spec contract that
 * `opencode-nono-sandbox`'s strict-enforcement check reads. A marker
 * whose `profileVersion` differs from the live metadata's
 * `profileVersion` is STALE (the sandbox warns); matching = fresh.
 *
 * 5.2 reads `profileVersion` from the sandbox-rendered metadata via the
 * existing `readProfileVersion` (reused, NOT duplicated), writes the
 * marker, and provides a staleness check. CLI subcommand wiring (5.3)
 * is NOT exercised here; the report format (5.1) is unchanged.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeFreshnessMarker,
  evaluateMarkerStaleness,
} = require('../../../scripts/opencode-nono-audit.js');

const FIXTURE_METADATA = path.resolve(
  __dirname,
  '../fixtures/sandbox-metadata.json',
);
// The metadata fixture's profileVersion value (sandbox-metadata.json).
const FIXTURE_PROFILE_VERSION = 'fixture-profile-0001';

const MARKER_REL = path.join('opencode-nono', 'last-report.json');

/** Make a fresh, isolated temp state dir for one test. */
function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nono-marker-'));
}

// ── 1. Marker WRITTEN with profileVersion from the metadata fixture ──

test('writeFreshnessMarker writes the versioned marker from the metadata fixture', () => {
  const stateDir = mkStateDir();
  const generatedAt = '2026-06-03T12:34:56.000Z';
  const host = 'test-host-injected';

  const result = writeFreshnessMarker({
    stateDir,
    metadataPath: FIXTURE_METADATA,
    generatedAt,
    host,
  });

  const markerPath = path.join(stateDir, MARKER_REL);
  assert.ok(fs.existsSync(markerPath), `marker must be written: ${markerPath}`);

  // The result reports the path it wrote.
  assert.equal(result.markerPath, markerPath, 'result.markerPath matches written path');

  const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  // EXACT cross-spec shape: { markerSchemaVersion, profileVersion, generatedAt, host }.
  assert.deepEqual(parsed, {
    markerSchemaVersion: 1,
    profileVersion: FIXTURE_PROFILE_VERSION,
    generatedAt,
    host,
  });

  // The returned marker object mirrors the persisted bytes.
  assert.deepEqual(result.marker, parsed);
});

// ── 2. STALENESS: differing profileVersion → stale; matching → fresh ─

test('evaluateMarkerStaleness reports a differing profileVersion as STALE', () => {
  const marker = {
    markerSchemaVersion: 1,
    profileVersion: 'fixture-profile-0001',
    generatedAt: '2026-06-03T12:34:56.000Z',
    host: 'h',
  };
  const result = evaluateMarkerStaleness(marker, 'fixture-profile-0002');
  assert.equal(result.stale, true, 'mismatched profileVersion must be stale');
});

test('evaluateMarkerStaleness reports a matching profileVersion as FRESH', () => {
  const marker = {
    markerSchemaVersion: 1,
    profileVersion: 'fixture-profile-0001',
    generatedAt: '2026-06-03T12:34:56.000Z',
    host: 'h',
  };
  const result = evaluateMarkerStaleness(marker, 'fixture-profile-0001');
  assert.equal(result.stale, false, 'matching profileVersion must be fresh');
});

test('a marker written from the fixture is FRESH against the same fixture version', () => {
  const stateDir = mkStateDir();
  const { marker } = writeFreshnessMarker({
    stateDir,
    metadataPath: FIXTURE_METADATA,
    generatedAt: '2026-06-03T12:34:56.000Z',
    host: 'h',
  });
  // The live metadata version equals what was written → fresh.
  assert.equal(
    evaluateMarkerStaleness(marker, FIXTURE_PROFILE_VERSION).stale,
    false,
    'marker from the fixture must be fresh against the fixture version',
  );
  // A bumped live version → stale.
  assert.equal(
    evaluateMarkerStaleness(marker, 'fixture-profile-9999').stale,
    true,
    'marker must be stale once the live metadata version moves on',
  );
});

// ── 3. Marker file mode is 0600 (consistency with reports) ───────────

test('the marker file is written at mode 0600', () => {
  const stateDir = mkStateDir();
  const { markerPath } = writeFreshnessMarker({
    stateDir,
    metadataPath: FIXTURE_METADATA,
    generatedAt: '2026-06-03T12:34:56.000Z',
    host: 'h',
  });
  const mode = fs.statSync(markerPath).mode & 0o777;
  assert.equal(mode, 0o600, `marker must be mode 0600, got 0o${mode.toString(8)}`);
});

// ── 4. Graceful: metadata absent/unreadable → profileVersion null ────

test('writeFreshnessMarker writes profileVersion null when metadata is absent (no crash)', () => {
  const stateDir = mkStateDir();
  const absentMetadata = path.join(stateDir, 'does-not-exist-metadata.json');

  let result;
  assert.doesNotThrow(() => {
    result = writeFreshnessMarker({
      stateDir,
      metadataPath: absentMetadata,
      generatedAt: '2026-06-03T12:34:56.000Z',
      host: 'h',
    });
  }, 'absent metadata must not crash the marker write');

  const markerPath = path.join(stateDir, MARKER_REL);
  const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(parsed.profileVersion, null, 'absent metadata → profileVersion null');
  assert.equal(parsed.markerSchemaVersion, 1, 'markerSchemaVersion still 1');
  assert.equal(result.marker.profileVersion, null, 'returned marker mirrors null version');
});

test('evaluateMarkerStaleness treats a null-version marker against a real version as STALE', () => {
  const marker = {
    markerSchemaVersion: 1,
    profileVersion: null,
    generatedAt: '2026-06-03T12:34:56.000Z',
    host: 'h',
  };
  // A marker that never resolved a version cannot match a live version.
  assert.equal(evaluateMarkerStaleness(marker, 'fixture-profile-0001').stale, true);
});
