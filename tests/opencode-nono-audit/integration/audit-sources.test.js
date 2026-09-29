'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runAudit } = require('../../../scripts/opencode-nono-audit.js');

const fixtures = path.resolve(__dirname, '..', 'fixtures');
const sessionDb = path.join(fixtures, 'opencode-nono-session.db');
const driftDb = path.join(fixtures, 'opencode-nono-drift.db');
const missingDb = path.join(fixtures, 'does-not-exist-session.db');

test('the session DB supplies the audit and its source status', () => {
  const result = runAudit({ sessionDbPath: sessionDb });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.schemaVersion, 1);
  assert.match(result.value.generatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(result.value.sources, [{ source: 'opencode-sqlite', status: 'ok' }]);
  assert.equal(result.value.partial, false);
  assert.ok(Array.isArray(result.value.capabilities));
  assert.ok(Array.isArray(result.value.unobservableClasses));
});

test('schema drift is reported as partial instead of crashing', () => {
  const result = runAudit({ sessionDbPath: driftDb });
  assert.equal(result.ok, true);
  assert.equal(result.value.partial, true);
  assert.equal(result.value.sources.length, 1);
  assert.equal(result.value.sources[0].source, 'opencode-sqlite');
  assert.equal(result.value.sources[0].status, 'incompatible');
  assert.match(result.value.sources[0].detail, /schema drift/);
});

test('a missing session database produces no audit', () => {
  const result = runAudit({ sessionDbPath: missingDb });
  assert.equal(result.ok, false);
  assert.equal(result.value, undefined);
  assert.equal(result.error.kind, 'no-readable-source');
  assert.equal(result.error.sources[0].source, 'opencode-sqlite');
  assert.equal(result.error.sources[0].status, 'missing');
});

test('auditing leaves the session database bytes and metadata unchanged', () => {
  const before = fs.readFileSync(sessionDb);
  const beforeStat = fs.statSync(sessionDb);
  assert.equal(runAudit({ sessionDbPath: sessionDb }).ok, true);
  const afterStat = fs.statSync(sessionDb);

  assert.deepEqual(fs.readFileSync(sessionDb), before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(afterStat.size, beforeStat.size);
});
