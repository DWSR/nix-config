#!/usr/bin/env node
/*
 * make-fixtures.js — generates the read-only test fixtures for the
 * opencode-nono-audit spec (Task 1.3; Requirements 1.1, 1.3, 1.4, 2.1).
 *
 * Follows the cost-diagnosis precedent
 * (scripts/opencode-cost-diagnosis-test-fixture.js): the three fixtures
 * are committed binaries/JSON, and THIS script documents and reproduces
 * exactly how they were generated. The loader test
 * (../unit/fixtures-load.test.js) consumes the artifacts directly; later
 * tasks (2.1 audit, 2.3 redactor, 6.2 integration) point at the same
 * committed paths so no test has to build a temp DB on demand.
 *
 * Invocation (better-sqlite3 resolves via the wrapper's NODE_PATH):
 *   opencode-cost-diagnosis-node \
 *     tests/opencode-nono-audit/fixtures/make-fixtures.js
 *
 * Outputs (all under tests/opencode-nono-audit/fixtures/):
 *   - opencode-nono-session.db  valid synthetic OpenCode session DB
 *   - opencode-nono-drift.db    schema-drift session DB
 *   - sandbox-metadata.json     sandbox metadata carrying profileVersion
 *
 * Determinism: every id, timestamp, and payload is a hard-coded
 * constant. Nothing depends on Date.now(), Math.random(), or any
 * environment. Each DB is unlinked then rebuilt on a fresh page-0 file,
 * inserted in a single transaction, and VACUUMed so re-generation is
 * byte-stable (same approach as the cost-diagnosis fixture).
 *
 * Schema fidelity:
 *   - Session DB schema mirrors the cost-diagnosis fixture (session,
 *     message, part, data_migration); part.type lives INSIDE part.data
 *     JSON, matching the live OpenCode schema.
 *   - The valid DB's data_migration holds EXACTLY
 *     ['session_usage_from_messages'] so the reused SqliteReader.open()
 *     (scripts/opencode-cost-report.js, SUPPORTED_MIGRATION_SET) accepts
 *     it. The drift DB adds a 'future_migration' row so the migration
 *     set differs and SqliteReader.open() raises SchemaDriftError.
 *
 * Secret-bearing strings: a couple of OBVIOUSLY FAKE secrets are
 * embedded (a credentialed URL and a TOKEN=... in a command) so the
 * redactor (task 2.3) and the audit have something to mask. They are
 * not real credentials.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

// ────────────────────────────────────────────────────────────────────
// Determinism anchor
// ────────────────────────────────────────────────────────────────────

const BASE_TIME = 1778775290084;

const FIXTURES_DIR = __dirname;
const SESSION_DB = path.join(FIXTURES_DIR, 'opencode-nono-session.db');
const DRIFT_DB = path.join(FIXTURES_DIR, 'opencode-nono-drift.db');
const METADATA_JSON = path.join(FIXTURES_DIR, 'sandbox-metadata.json');

// The sandbox metadata profile version for freshness-marker tests.
const FIXTURE_PROFILE_VERSION = 'fixture-profile-0001';

// ────────────────────────────────────────────────────────────────────
// OpenCode session DB schema (mirrors the cost-diagnosis fixture)
// ────────────────────────────────────────────────────────────────────

const SESSION_SCHEMA = [
  `CREATE TABLE session (
     id              TEXT PRIMARY KEY,
     parent_id       TEXT,
     directory       TEXT,
     agent           TEXT,
     model           TEXT,
     cost            REAL    NOT NULL DEFAULT 0,
     tokens_input    INTEGER NOT NULL DEFAULT 0,
     tokens_output   INTEGER NOT NULL DEFAULT 0,
     tokens_reasoning INTEGER NOT NULL DEFAULT 0,
     tokens_cache_read INTEGER NOT NULL DEFAULT 0,
     tokens_cache_write INTEGER NOT NULL DEFAULT 0,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     slug            TEXT,
     share_url       TEXT,
     permission      TEXT
   )`,
  `CREATE TABLE message (
     id           TEXT PRIMARY KEY,
     session_id   TEXT NOT NULL,
     data         TEXT NOT NULL,
     time_created INTEGER NOT NULL,
     time_updated INTEGER NOT NULL
   )`,
  `CREATE TABLE part (
     id           TEXT PRIMARY KEY,
     message_id   TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     data         TEXT NOT NULL,
     time_created INTEGER NOT NULL,
     time_updated INTEGER NOT NULL
   )`,
  `CREATE TABLE data_migration (
     name           TEXT PRIMARY KEY,
     time_completed INTEGER NOT NULL
   )`,
];

const MODEL_ID = 'claude-opus-4-7';
const PROVIDER_ID = 'anthropic';
const CWD = '/Users/test/project-nono';

const TOKENS = {
  total: 16600,
  input: 10000,
  output: 500,
  reasoning: 100,
  cache: { read: 5000, write: 1000 },
};
const COST = 0.05;

// Representative tool parts. Each entry becomes one `tool` part on the
// single assistant message. `data` is the part.data JSON (minus the
// `type` field, which is merged in at insert time).
//
// The bash parts deliberately include one git command and one non-git
// command (so task 2.x can surface the git -> Git MCP replacement
// candidate and rank others by capability). Two obviously-fake secrets
// are planted: a credentialed clone URL and a TOKEN=... in a curl.
const TOOL_PARTS = [
  {
    // git command #1 — drives the git -> Git MCP replacement candidate.
    tool: 'bash',
    state: {
      status: 'completed',
      output: 'On branch main\nnothing to commit, working tree clean\n',
      input: {
        command: 'git status',
        description: 'Check the working tree status',
        workdir: CWD,
      },
    },
  },
  {
    // git command #2 — clone over HTTPS with FAKE embedded credentials,
    // so the redactor (task 2.3) has a credentialed URL to mask.
    tool: 'bash',
    state: {
      status: 'completed',
      output: "Cloning into 'dep'...\n",
      input: {
        command:
          'git clone https://fakeuser:FAKE_SECRET_PW@example.invalid/org/repo.git dep',
        description: 'Clone a dependency repository',
        workdir: CWD,
      },
    },
  },
  {
    // non-git command #1 — so the ranker has a non-git capability too.
    tool: 'bash',
    state: {
      status: 'completed',
      output: 'added 1 package\n',
      input: {
        command: 'npm install',
        description: 'Install Node dependencies',
        workdir: CWD,
      },
    },
  },
  {
    // non-git command #2 — carries a FAKE bearer token env assignment
    // for the redactor to mask.
    tool: 'bash',
    state: {
      status: 'completed',
      output: '{"ok":true}\n',
      input: {
        command:
          'TOKEN=ghp_FAKE000000000000000000000000000000 curl -sH "Authorization: Bearer $TOKEN" https://api.example.invalid/v1/ping',
        description: 'Ping an API with a token',
        workdir: CWD,
      },
    },
  },
  {
    tool: 'read',
    state: {
      status: 'completed',
      output: '<file contents elided>',
      input: {
        filePath: '/Users/test/project-nono/src/index.js',
        offset: 0,
        limit: 200,
      },
    },
  },
  {
    tool: 'webfetch',
    state: {
      status: 'completed',
      output: '<page markdown elided>',
      input: {
        url: 'https://docs.example.invalid/guide',
        format: 'markdown',
      },
    },
  },
  {
    // MCP tool part — carries top-level `name` + `args` (the shape the
    // Phase 0 doc records for MCP parts). No state wrapper.
    name: 'context7_get_docs',
    args: {
      library: 'better-sqlite3',
      topic: 'transactions',
    },
  },
];

function buildSessionMessages(sessionId, baseTime) {
  return [
    // System turn.
    {
      message: {
        id: `msg_${sessionId}_sys`,
        sessionId,
        timeCreated: baseTime + 1,
        timeUpdated: baseTime + 1,
        data: { role: 'system', path: { cwd: CWD, root: CWD } },
      },
      parts: [
        {
          id: `prt_${sessionId}_sys_0`,
          type: 'text',
          timeCreated: baseTime + 2,
          timeUpdated: baseTime + 2,
          data: { text: 'You are a helpful assistant.' },
        },
      ],
    },
    // User turn.
    {
      message: {
        id: `msg_${sessionId}_usr`,
        sessionId,
        timeCreated: baseTime + 10,
        timeUpdated: baseTime + 10,
        data: { role: 'user', path: { cwd: CWD, root: CWD } },
      },
      parts: [
        {
          id: `prt_${sessionId}_usr_0`,
          type: 'text',
          timeCreated: baseTime + 11,
          timeUpdated: baseTime + 11,
          data: { text: 'Set up the project and fetch the docs.' },
        },
      ],
    },
    // Assistant turn — text + all the tool parts.
    {
      message: {
        id: `msg_${sessionId}_ast`,
        sessionId,
        timeCreated: baseTime + 20,
        timeUpdated: baseTime + 20,
        data: {
          role: 'assistant',
          cost: COST,
          tokens: TOKENS,
          modelID: MODEL_ID,
          providerID: PROVIDER_ID,
          path: { cwd: CWD, root: CWD },
        },
      },
      parts: [
        {
          id: `prt_${sessionId}_ast_text`,
          type: 'text',
          timeCreated: baseTime + 21,
          timeUpdated: baseTime + 21,
          data: { text: 'Running the requested steps.' },
        },
        ...TOOL_PARTS.map((tp, i) => ({
          id: `prt_${sessionId}_ast_tool_${i}`,
          type: 'tool',
          timeCreated: baseTime + 22 + i,
          timeUpdated: baseTime + 22 + i,
          data: tp,
        })),
      ],
    },
  ];
}

function buildSessionDb(dbPath, { migrations }) {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  db.pragma('application_id = 0');

  for (const stmt of SESSION_SCHEMA) db.exec(stmt);

  const insSession = db.prepare(`
    INSERT INTO session (
      id, parent_id, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write,
      time_created, time_updated, slug, share_url, permission
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMessage = db.prepare(`
    INSERT INTO message (id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insPart = db.prepare(`
    INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insMigration = db.prepare(`
    INSERT INTO data_migration (name, time_completed) VALUES (?, ?)
  `);

  const sessionId = 'ses_nono_root';
  const tx = db.transaction(() => {
    insSession.run(
      sessionId,
      null,
      CWD,
      'build',
      MODEL_ID,
      COST,
      TOKENS.input,
      TOKENS.output,
      TOKENS.reasoning,
      TOKENS.cache.read,
      TOKENS.cache.write,
      BASE_TIME,
      BASE_TIME + 100,
      '',
      '',
      '',
    );

    for (const m of buildSessionMessages(sessionId, BASE_TIME)) {
      insMessage.run(
        m.message.id,
        m.message.sessionId,
        JSON.stringify(m.message.data),
        m.message.timeCreated,
        m.message.timeUpdated,
      );
      for (const p of m.parts) {
        const data = { type: p.type, ...p.data };
        insPart.run(
          p.id,
          m.message.id,
          sessionId,
          JSON.stringify(data),
          p.timeCreated,
          p.timeUpdated,
        );
      }
    }

    for (const name of migrations) {
      insMigration.run(name, BASE_TIME);
    }
  });
  tx();

  db.exec('VACUUM');
  db.close();
}

// ────────────────────────────────────────────────────────────────────
// sandbox metadata.json (consumed by task 5.2 freshness marker)
// ────────────────────────────────────────────────────────────────────

function buildMetadataJson(jsonPath) {
  const meta = {
    profileVersion: FIXTURE_PROFILE_VERSION,
    host: 'fixture-host',
    generatedAt: '2026-06-03T00:00:00.000Z',
  };
  // Trailing newline + 2-space indent for stable, diff-friendly output.
  fs.writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);
}

// ────────────────────────────────────────────────────────────────────
// Generate all three fixtures
// ────────────────────────────────────────────────────────────────────

function generate() {
  // Valid session DB: migration set == supported baseline.
  buildSessionDb(SESSION_DB, { migrations: ['session_usage_from_messages'] });

  // Drift session DB: migration set differs (extra row) so
  // SqliteReader.open() raises SchemaDriftError. Still a valid SQLite
  // file with a populated data_migration table.
  buildSessionDb(DRIFT_DB, {
    migrations: ['session_usage_from_messages', 'future_migration'],
  });

  buildMetadataJson(METADATA_JSON);

  for (const p of [SESSION_DB, DRIFT_DB, METADATA_JSON]) {
    process.stdout.write(`wrote ${path.relative(process.cwd(), p)}\n`);
  }
}

generate();
