/*
 * fixtures-load.test.js — loader test for the opencode-nono-audit
 * read-only test fixtures (Task 1.3, Requirements 1.1, 1.3, 1.4, 2.1).
 *
 * This test is the observable-completion gate for task 1.3: it loads
 * each of the four committed fixtures and asserts the shape later
 * tasks depend on. It lives under tests/opencode-nono-audit/unit/
 * (NOT inside fixtures/) because run.js's discoverTestFiles() skips
 * the fixtures/ directory.
 *
 * Fixtures under tests/opencode-nono-audit/fixtures/, built by the
 * committed creator make-fixtures.js:
 *
 *   - opencode-nono-session.db  — valid synthetic OpenCode session DB.
 *       data_migration == ['session_usage_from_messages'] so the reused
 *       SqliteReader.open() (scripts/opencode-cost-report.js) accepts it.
 *       Carries tool parts for bash (one git command, one non-git),
 *       read, and webfetch, plus an MCP tool part, with representative
 *       state.input args and one obviously-fake secret-bearing string
 *       for the redactor (task 2.3) / audit to mask.
 *   - opencode-nono-drift.db    — schema-drift session DB. Its
 *       data_migration set differs from the supported baseline so
 *       SqliteReader.open() throws SchemaDriftError. Still a valid
 *       SQLite file with a data_migration table.
 *   - cavemem-data.db           — cavemem schema_version=2 fixture with
 *       a handful of uncompressed prompt/response observation rows.
 *   - sandbox-metadata.json     — sandbox metadata carrying a
 *       profileVersion string (consumed by the task 5.2 freshness
 *       marker).
 *
 * The drift assertion exercises SqliteReader directly. We require it by
 * relative path (../../../scripts/opencode-cost-report.js) rather than
 * via OPENCODE_NONO_COST_REPORT_LIB, because that env var is only set by
 * the .nix wrapper at runtime; requiring the relative path keeps this
 * test self-contained under `opencode-cost-diagnosis-node --test`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const {
  SqliteReader,
  SchemaDriftError,
} = require('../../../scripts/opencode-cost-report.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
const CAVEMEM_DB = path.join(FIXTURES_DIR, 'cavemem-data.db');
const METADATA_JSON = path.join(FIXTURES_DIR, 'sandbox-metadata.json');

// ────────────────────────────────────────────────────────────────────
// Helper: collect tool parts (data.tool / data.name) from a session DB
// ────────────────────────────────────────────────────────────────────

function readToolParts(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT data FROM part').all();
    const tools = [];
    for (const row of rows) {
      const data = JSON.parse(row.data);
      const tool = data.tool || data.name;
      if (!tool) continue;
      const input = (data.state && data.state.input) || data.args || null;
      tools.push({ tool, input, raw: data });
    }
    return tools;
  } finally {
    db.close();
  }
}

// ────────────────────────────────────────────────────────────────────
// Valid session DB
// ────────────────────────────────────────────────────────────────────

test('valid session fixture exists and opens read-only via SqliteReader', () => {
  assert.ok(fs.existsSync(SESSION_DB), `missing fixture: ${SESSION_DB}`);

  const reader = new SqliteReader();
  reader.open(SESSION_DB); // must NOT throw — migration set is the baseline
  try {
    assert.deepEqual(reader.detectMigrationSet(), ['session_usage_from_messages']);
    const roots = [...reader.rootSessionsMatching({})];
    assert.ok(roots.length >= 1, 'expected at least one root session');
  } finally {
    reader.close();
  }
});

test('valid session fixture carries bash(git+non-git), read, and webfetch tool parts', () => {
  const tools = readToolParts(SESSION_DB);
  const byTool = (name) => tools.filter((t) => t.tool === name);

  const bash = byTool('bash');
  assert.ok(bash.length >= 2, 'expected at least two bash tool parts');
  const bashCommands = bash.map((b) => (b.input && b.input.command) || '');
  assert.ok(
    bashCommands.some((c) => /\bgit\b/.test(c)),
    `expected a git bash command; saw ${JSON.stringify(bashCommands)}`,
  );
  assert.ok(
    bashCommands.some((c) => c && !/\bgit\b/.test(c)),
    `expected a non-git bash command; saw ${JSON.stringify(bashCommands)}`,
  );
  for (const b of bash) {
    assert.ok(b.input, 'bash part missing state.input');
    assert.equal(typeof b.input.command, 'string');
    assert.equal(typeof b.input.description, 'string');
    assert.ok('workdir' in b.input, 'bash input missing workdir key');
  }

  const read = byTool('read');
  assert.ok(read.length >= 1, 'expected a read tool part');
  assert.equal(typeof read[0].input.filePath, 'string');
  assert.ok('offset' in read[0].input && 'limit' in read[0].input);

  const webfetch = byTool('webfetch');
  assert.ok(webfetch.length >= 1, 'expected a webfetch tool part');
  assert.equal(typeof webfetch[0].input.url, 'string');
  assert.equal(typeof webfetch[0].input.format, 'string');
});

test('valid session fixture has an MCP tool part with name + args', () => {
  const tools = readToolParts(SESSION_DB);
  const mcp = tools.filter(
    (t) => t.raw && t.raw.name && (t.raw.args || t.raw.args_json),
  );
  assert.ok(mcp.length >= 1, 'expected at least one MCP tool part with name+args');
});

test('valid session fixture contains an obviously-fake secret for the redactor to mask', () => {
  const db = new Database(SESSION_DB, { readonly: true, fileMustExist: true });
  try {
    const blob = db
      .prepare('SELECT group_concat(data) AS all_data FROM part')
      .get().all_data;
    assert.match(
      blob,
      /(TOKEN=|:\/\/[^/@\s]+:[^/@\s]+@|ghp_|FAKE)/,
      'expected a secret-bearing string somewhere in the part data',
    );
  } finally {
    db.close();
  }
});

// ────────────────────────────────────────────────────────────────────
// Schema-drift session DB
// ────────────────────────────────────────────────────────────────────

test('drift session fixture exists and triggers SchemaDriftError on open', () => {
  assert.ok(fs.existsSync(DRIFT_DB), `missing fixture: ${DRIFT_DB}`);

  // It is still a valid SQLite file with a data_migration table.
  const db = new Database(DRIFT_DB, { readonly: true, fileMustExist: true });
  try {
    const migrations = db.prepare('SELECT name FROM data_migration ORDER BY name').all();
    assert.ok(migrations.length >= 1, 'drift DB must still have a data_migration table');
    const names = migrations.map((r) => r.name);
    assert.notDeepEqual(
      names.slice().sort(),
      ['session_usage_from_messages'],
      'drift DB migration set must differ from the supported baseline',
    );
  } finally {
    db.close();
  }

  const reader = new SqliteReader();
  assert.throws(
    () => reader.open(DRIFT_DB),
    (err) => err instanceof SchemaDriftError,
    'SqliteReader.open() must raise SchemaDriftError on the drift fixture',
  );
});

// ────────────────────────────────────────────────────────────────────
// cavemem data.db
// ────────────────────────────────────────────────────────────────────

test('cavemem fixture exists, is schema_version=2, and has prompt/response observations', () => {
  assert.ok(fs.existsSync(CAVEMEM_DB), `missing fixture: ${CAVEMEM_DB}`);

  const db = new Database(CAVEMEM_DB, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare('SELECT version FROM schema_version').get().version;
    assert.equal(version, 2);

    const obs = db
      .prepare('SELECT kind, content, compressed FROM observations ORDER BY id')
      .all();
    assert.ok(obs.length >= 2, 'expected at least two observation rows');
    const kinds = new Set(obs.map((o) => o.kind));
    assert.ok(kinds.has('prompt'), 'expected a prompt observation');
    assert.ok(kinds.has('response'), 'expected a response observation');
    for (const o of obs) {
      assert.equal(o.compressed, 0, 'fixture observations must be uncompressed');
      assert.equal(typeof o.content, 'string');
      assert.ok(o.content.length > 0, 'observation content must be non-empty');
    }

    // sessions row exists so observation FKs are satisfiable.
    const sessions = db.prepare('SELECT id, ide FROM sessions').all();
    assert.ok(sessions.length >= 1, 'expected at least one cavemem session row');
  } finally {
    db.close();
  }
});

// ────────────────────────────────────────────────────────────────────
// sandbox metadata.json
// ────────────────────────────────────────────────────────────────────

test('sandbox metadata fixture exists and carries a profileVersion string', () => {
  assert.ok(fs.existsSync(METADATA_JSON), `missing fixture: ${METADATA_JSON}`);
  const meta = JSON.parse(fs.readFileSync(METADATA_JSON, 'utf8'));
  assert.equal(typeof meta.profileVersion, 'string');
  assert.ok(meta.profileVersion.length > 0, 'profileVersion must be non-empty');
});
