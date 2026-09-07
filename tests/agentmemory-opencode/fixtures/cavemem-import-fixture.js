'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createCavememImportFixture(databasePath, options = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const extendedRows = options.extended
    ? `
    INSERT INTO observations (session_id, kind, content, compressed, intensity, ts, metadata) VALUES
      ('unknown-session', 'response', 'This batch must fail once.', 0, NULL, 1700000010040, '{"fixture":true}'),
      ('unknown-session', 'response', 'This row has an invalid timestamp.', 0, NULL, 'not-a-timestamp', '{"fixture":true}'),
      ('unknown-session', 'response', 'This row follows the failed batch.', 0, NULL, 1700000010050, '{"fixture":true}');
    `
    : '';
  const duplicateSummary = options.duplicateSummary
    ? `
      INSERT INTO summaries (session_id, scope, content, compressed, intensity, ts)
      VALUES ('unknown-session', 'turn', 'Mystery turn summary.', 0, NULL, 1700000010035);
    `
    : '';
  const sql = `
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      ide TEXT NOT NULL,
      cwd TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      metadata TEXT
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      compressed INTEGER NOT NULL DEFAULT 1,
      intensity TEXT,
      ts INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('turn', 'session')),
      content TEXT NOT NULL,
      compressed INTEGER NOT NULL DEFAULT 1,
      intensity TEXT,
      ts INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE embeddings (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
    INSERT INTO schema_version VALUES (2);

    INSERT INTO sessions VALUES
      ('opencode-session', 'opencode', '/work/alpha', 1700000000000, 1700000001000, '{"project":"alpha"}'),
      ('unknown-session', 'unknown', '/work/mystery', 1700000010000, 1700000011000, '{"project":"mystery"}'),
      ('malformed-session', 'unknown', '/work/broken', 1700000020000, 1700000021000, '{"project":"broken"'),
      ('ambiguous-session', 'unknown', '/work/ambiguous', 1700000030000, 1700000031000, '{"note":"possibly imported"}'),
      ('pi-session', 'pi', '/work/pi', 1700000040000, 1700000041000, '{"project":"pi"}'),
      ('obsidian-session', 'obsidian-migration', '/work/obsidian', 1700000050000, 1700000051000, '{"project":"obsidian"}'),
      ('imported-session', 'unknown', '/work/imported', 1700000060000, 1700000061000, '{"importer":"agentmemory","import_hash":"fixture-hash","source_path":"legacy/session"}');

    INSERT INTO observations (session_id, kind, content, compressed, intensity, ts, metadata) VALUES
      ('opencode-session', 'prompt', 'Set up the project.', 0, NULL, 1700000000010, '{"fixture":true}'),
      ('opencode-session', 'response', 'The project is ready.', 0, NULL, 1700000000020, '{"fixture":true}'),
      ('unknown-session', 'prompt', 'Inspect the unknown session.', 0, NULL, 1700000010010, '{"fixture":true}'),
      ('malformed-session', 'response', 'Keep this row despite malformed metadata.', 0, NULL, 1700000020010, '{"fixture":true'),
      ('ambiguous-session', 'prompt', 'Do not discard ambiguous provenance.', 0, NULL, 1700000030010, '{"note":"possibly imported"}'),
      ('unknown-session', 'response', 'This row has an explicit importer marker.', 0, NULL, 1700000010020, '{"imported":true}'),
      ('pi-session', 'prompt', 'Pi history.', 0, NULL, 1700000040010, '{"fixture":true}'),
      ('obsidian-session', 'response', 'Obsidian history.', 0, NULL, 1700000050010, '{"fixture":true}'),
      ('imported-session', 'response', 'Already imported history.', 0, NULL, 1700000060010, '{"importer":"agentmemory"}');

    INSERT INTO summaries (session_id, scope, content, compressed, intensity, ts) VALUES
      ('opencode-session', 'session', 'Alpha session summary.', 0, NULL, 1700000000030),
      ('unknown-session', 'session', 'Mystery session summary.', 0, NULL, 1700000010030),
      ('malformed-session', 'session', 'Broken session summary.', 0, NULL, 1700000020030),
      ('ambiguous-session', 'session', 'Ambiguous session summary.', 0, NULL, 1700000030030),
      ('pi-session', 'session', 'Pi session summary.', 0, NULL, 1700000040030),
      ('obsidian-session', 'session', 'Obsidian session summary.', 0, NULL, 1700000050030),
      ('imported-session', 'session', 'Imported session summary.', 0, NULL, 1700000060030);

    ${extendedRows}
    ${duplicateSummary}

    VACUUM;
  `;
  execFileSync('sqlite3', [databasePath], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
  return databasePath;
}

module.exports = { createCavememImportFixture };
