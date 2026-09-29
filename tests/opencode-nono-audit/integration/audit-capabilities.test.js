/*
 * audit-capabilities.test.js — integration tests for runAudit's
 * observed-capability model (opencode-nono-audit spec, Task 2.2,
 * Requirements 1.2, 1.3).
 *
 * Task 2.2 replaces the 2.1 extension-point placeholders
 * (capabilities: [] / unobservableClasses: []) in buildAudit() with
 * REAL extraction: iterate the readable session source's tool parts
 * into CapabilityRecord[] (tool/count/output reliable; command/path/URL
 * best-effort from STRUCTURED state.input keys with confidence + source
 * tags; ports/env inference-only → empty + disclosed), and populate
 * unobservableClasses with the capability classes that cannot be
 * derived from the available sources (coverage-gap disclosure).
 *
 * Authoritative source (task 1.1 Phase 0 decision): OpenCode
 * `part.data.state.input` structured keys. Tool names and arguments
 * come from the session database alone.
 *
 * Lives under tests/opencode-nono-audit/integration/ (run.js recurses
 * everywhere except fixtures/ and node_modules/). runAudit resolves
 * SqliteReader by relative path under `node --test` (env var unset), so
 * no env setup is needed here — mirrors audit-sources.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const { runAudit } = require('../../../scripts/opencode-nono-audit.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');

// The structurally-unobservable capability classes per the Phase 0
// source-fidelity decision (sorted, stable).
const EXPECTED_UNOBSERVABLE = [
  'device',
  'env-var',
  'ipc',
  'port',
  'process-signal',
  'unix-socket',
];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Find the CapabilityRecord for a given tool name. */
function capOf(audit, tool) {
  return audit.capabilities.find((c) => c.tool === tool);
}

/**
 * Build a minimal valid OpenCode session DB at `dbPath` whose single
 * tool part has NO recognizable structured input keys (an
 * `unknown_tool` whose state.input is an opaque blob). Mirrors the
 * make-fixtures.js schema + supported migration set so SqliteReader
 * accepts it. Used by the "lacking derivable args" test.
 */
function buildArglessSessionDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  db.exec(`CREATE TABLE session (
     id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, agent TEXT,
     model TEXT, cost REAL NOT NULL DEFAULT 0,
     tokens_input INTEGER NOT NULL DEFAULT 0,
     tokens_output INTEGER NOT NULL DEFAULT 0,
     tokens_reasoning INTEGER NOT NULL DEFAULT 0,
     tokens_cache_read INTEGER NOT NULL DEFAULT 0,
     tokens_cache_write INTEGER NOT NULL DEFAULT 0,
     time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
     slug TEXT, share_url TEXT, permission TEXT
   )`);
  db.exec(`CREATE TABLE message (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
     time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
   )`);
  db.exec(`CREATE TABLE part (
     id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
     data TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
   )`);
  db.exec(`CREATE TABLE data_migration (
     name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL
   )`);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO session (id, parent_id, directory, agent, model, cost,
        tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write,
        time_created, time_updated, slug, share_url, permission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ses_argless', null, '/tmp/x', 'build', 'm', 0, 0, 0, 0, 0, 0, 1, 2, '', '', '');
    db.prepare(
      `INSERT INTO message (id, session_id, data, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('msg_argless', 'ses_argless', JSON.stringify({ role: 'assistant' }), 3, 3);
    // A tool part with NO recognizable structured input keys: no command,
    // no path/filePath, no url. Just an opaque, non-mappable blob.
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'prt_argless_0',
      'msg_argless',
      'ses_argless',
      JSON.stringify({
        type: 'tool',
        tool: 'unknown_tool',
        state: { status: 'completed', output: 'done', input: { mystery: true } },
      }),
      4,
      4,
    );
    db.prepare(
      `INSERT INTO data_migration (name, time_completed) VALUES (?, ?)`,
    ).run('session_usage_from_messages', 1);
  });
  tx();
  db.exec('VACUUM');
  db.close();
}

// ────────────────────────────────────────────────────────────────────
// 1. Capabilities derived over the valid session fixture (R1.2)
// ────────────────────────────────────────────────────────────────────

test('runAudit derives CapabilityRecords with confidence + sources over the valid fixture (R1.2)', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true, `expected ok Result; got ${JSON.stringify(res)}`);

  const audit = res.value;
  assert.ok(Array.isArray(audit.capabilities), 'capabilities must be an array');
  assert.ok(audit.capabilities.length >= 1, 'expected at least one CapabilityRecord');

  for (const cap of audit.capabilities) {
    assert.equal(typeof cap.tool, 'string');
    assert.ok(cap.tool.length > 0, 'tool name must be non-empty');
    assert.equal(typeof cap.count, 'number');
    assert.ok(cap.count >= 1, 'count must be >= 1');
    assert.ok(Array.isArray(cap.commands), 'commands must be an array');
    assert.ok(Array.isArray(cap.paths), 'paths must be an array');
    assert.ok(Array.isArray(cap.endpoints), 'endpoints must be an array');
    assert.ok(Array.isArray(cap.ports), 'ports must be an array');
    assert.ok(Array.isArray(cap.envVars), 'envVars must be an array');
    assert.ok(
      cap.confidence === 'high' || cap.confidence === 'medium' || cap.confidence === 'low',
      `confidence must be a Confidence literal; got ${cap.confidence}`,
    );
    assert.ok(Array.isArray(cap.sources), 'sources must be an array');
    assert.ok(cap.sources.length >= 1, 'every record must carry a non-empty sources array');
    assert.ok(
      cap.sources.includes('opencode-sqlite'),
      'session-derived records must tag opencode-sqlite',
    );
    assert.deepEqual(cap.sources, ['opencode-sqlite']);
  }
});

test('bash record derives commands; read record derives a path; webfetch record derives an endpoint (R1.2)', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true);
  const audit = res.value;

  // bash: two+ commands, count matches number of bash tool parts.
  const bash = capOf(audit, 'bash');
  assert.ok(bash, 'expected a bash CapabilityRecord');
  assert.equal(bash.count, 4, 'fixture has four bash tool parts');
  assert.ok(bash.commands.length >= 2, 'bash must derive multiple commands');
  assert.ok(
    bash.commands.some((c) => /\bgit\b/.test(c)),
    `expected a git command in bash.commands; saw ${JSON.stringify(bash.commands)}`,
  );
  assert.equal(bash.confidence, 'high', 'bash.command is a structured high-confidence key');
  // Command strings are raw (NOT redacted here — redaction is task 5.1).
  assert.ok(
    bash.commands.some((c) => c.includes('git clone')),
    'raw command must be preserved (redaction is applied later at serialization)',
  );

  // read: a structured filePath → high-confidence path.
  const read = capOf(audit, 'read');
  assert.ok(read, 'expected a read CapabilityRecord');
  assert.ok(read.paths.length >= 1, 'read must derive a path from filePath');
  assert.ok(
    read.paths.some((p) => p.includes('src/index.js')),
    `expected the read filePath; saw ${JSON.stringify(read.paths)}`,
  );
  assert.equal(read.confidence, 'high', 'read.filePath is a structured high-confidence key');

  // webfetch: a structured url → high-confidence endpoint.
  const webfetch = capOf(audit, 'webfetch');
  assert.ok(webfetch, 'expected a webfetch CapabilityRecord');
  assert.ok(webfetch.endpoints.length >= 1, 'webfetch must derive an endpoint from url');
  assert.ok(
    webfetch.endpoints.some((e) => e.includes('docs.example.invalid')),
    `expected the webfetch url; saw ${JSON.stringify(webfetch.endpoints)}`,
  );
  assert.equal(webfetch.confidence, 'high', 'webfetch.url is a structured high-confidence key');
});

test('ports and envVars stay empty (inference-only); path-like / URL-like command substrings are NOT promoted to high-confidence (R1.2 invariant)', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true);
  const audit = res.value;

  for (const cap of audit.capabilities) {
    assert.deepEqual(cap.ports, [], `${cap.tool}.ports must be empty (inference-only)`);
    assert.deepEqual(cap.envVars, [], `${cap.tool}.envVars must be empty (inference-only)`);
  }

  // The bash record carries a credentialed clone URL and an api URL INSIDE
  // command strings. Those URL-like substrings are low-confidence hints,
  // not structured endpoints — they must NOT be promoted into bash.endpoints.
  const bash = capOf(audit, 'bash');
  assert.deepEqual(
    bash.endpoints,
    [],
    'URL-like substrings inside commands must not become high-confidence endpoints',
  );
  // Likewise the bash workdir is a path-like value inside command context,
  // but bash has no structured path key → bash.paths stays empty.
  assert.deepEqual(
    bash.paths,
    [],
    'bash has no structured path key; command path substrings are not promoted',
  );
});

// ────────────────────────────────────────────────────────────────────
// 2. unobservableClasses disclosure (R1.2 observable completion)
// ────────────────────────────────────────────────────────────────────

test('unobservableClasses is populated, sorted, and discloses the structurally-unobservable classes (R1.2)', () => {
  const res = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(res.ok, true);
  const audit = res.value;

  assert.ok(Array.isArray(audit.unobservableClasses), 'unobservableClasses must be an array');
  assert.ok(audit.unobservableClasses.length > 0, 'unobservableClasses must be non-empty (coverage-gap disclosure)');
  assert.deepEqual(
    audit.unobservableClasses,
    EXPECTED_UNOBSERVABLE,
    'unobservableClasses must match the Phase 0 list, sorted/stable',
  );
  // Sorted invariant (so later determinism tests hold).
  const sorted = audit.unobservableClasses.slice().sort();
  assert.deepEqual(audit.unobservableClasses, sorted, 'unobservableClasses must be sorted');
});

// ────────────────────────────────────────────────────────────────────
// 3. "lacking derivable args" case → empty arrays + non-empty
//    unobservableClasses (does NOT imply full coverage)
// ────────────────────────────────────────────────────────────────────

test('a fixture whose tool part lacks derivable args yields empty capability arrays AND a non-empty unobservableClasses (R1.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nono-argless-'));
  const dbPath = path.join(dir, 'argless-session.db');
  try {
    buildArglessSessionDb(dbPath);

    const res = runAudit({ sessionDbPath: dbPath });
    assert.equal(res.ok, true, `expected ok Result; got ${JSON.stringify(res)}`);
    const audit = res.value;

    const cap = capOf(audit, 'unknown_tool');
    assert.ok(cap, 'expected a CapabilityRecord for the argless tool (name + count are reliable)');
    assert.equal(cap.count, 1);
    // No recognizable structured input keys → all derived arrays empty.
    assert.deepEqual(cap.commands, [], 'no command key → empty commands');
    assert.deepEqual(cap.paths, [], 'no path key → empty paths');
    assert.deepEqual(cap.endpoints, [], 'no url key → empty endpoints');
    assert.deepEqual(cap.ports, []);
    assert.deepEqual(cap.envVars, []);

    // Crucially: empty capability arrays must NOT imply full coverage.
    assert.ok(
      audit.unobservableClasses.length > 0,
      'a fixture lacking derivable args must still disclose coverage gaps via unobservableClasses',
    );
    assert.deepEqual(audit.unobservableClasses, EXPECTED_UNOBSERVABLE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// 4. Determinism: capability ordering is stable across runs
// ────────────────────────────────────────────────────────────────────

test('capability ordering is deterministic (stable tool order across runs)', () => {
  const a = runAudit({ sessionDbPath: SESSION_DB });
  const b = runAudit({ sessionDbPath: SESSION_DB });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const toolsA = a.value.capabilities.map((c) => c.tool);
  const toolsB = b.value.capabilities.map((c) => c.tool);
  assert.deepEqual(toolsA, toolsB, 'capability tool ordering must be stable across runs');
  // Documented order: sorted by tool name.
  assert.deepEqual(toolsA, toolsA.slice().sort(), 'capabilities must be sorted by tool name');
});
