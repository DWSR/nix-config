#!/usr/bin/env node
/*
 * opencode-cost-diagnosis-test-fixture.js — generates the synthetic
 * opencode-shaped SQLite fixture used by the test suite.
 *
 * Task 1.6 of .kiro/specs/opencode-cost-diagnosis. Implements
 * Requirement 1.4. The fixture is the input substrate for tasks
 * 6.1 (unit tests of attribution/tokenizer math) and 6.2
 * (integration tests of the CLI end-to-end against the fixture).
 *
 * Invocation:
 *   opencode-cost-diagnosis-node \
 *     scripts/opencode-cost-diagnosis-test-fixture.js
 *
 * The wrapper (scripts/opencode-cost-diagnosis-node.nix) exports
 * NODE_PATH against the vendored `better-sqlite3` derivation so this
 * script can `require('better-sqlite3')` without any user-side npm
 * install.
 *
 * Output:
 *   tests/opencode-cost-diagnosis/fixtures/opencode-stable.db
 *
 * The fixture is committed to the repo. Re-running the script
 * overwrites the file deterministically — re-generation MUST
 * produce a byte-identical artifact so a sha256 check is sufficient
 * to verify "fixture matches source-of-truth". All IDs, timestamps,
 * and token counts are hard-coded constants; nothing depends on
 * Date.now(), Math.random(), or any environmental input.
 *
 * Schema mirrored from design.md "Data Models" (lines 855-925) plus
 * the live-verified `data_migration` table at design.md:555 with
 * the v1 baseline migration set `[session_usage_from_messages]`
 * (lines 557-558). Only the columns the diagnostic actually reads
 * are populated with meaningful values; the other documented columns
 * exist on the table (so opening it under opencode's schema
 * assumptions doesn't surface "no such column" errors) but hold
 * empty strings or NULL.
 *
 * Fixture content (designed for tasks 6.1 and 6.2 to make
 * predictable assertions):
 *
 *   Session A (root, agent=build,    cwd=/Users/test/project-a)
 *     ├── Session A1 (direct child)
 *     │   └── Session A1a (grandchild — nested subagent dispatch)
 *     └── Session A2 (direct child)
 *   Session B (root, agent=general,  cwd=/Users/test/project-b)
 *     ├── Session B1 (direct child)
 *     │   └── Session B1a (grandchild — nested subagent dispatch)
 *     └── Session B2 (direct child)
 *   Session C (root, agent=explore,  cwd=/Users/test/project-c)
 *     (no children — covers the "root with no subagents" path)
 *
 * Topology rationale: the acceptance criteria specify both "2 of
 * which dispatch 2 subagents each" AND "9 sessions total
 * (3 roots + 6 children)". A literal 2 roots × 2 direct children
 * yields 7 sessions; the 9-count is the binding observable check.
 * The nested-grandchild structure reconciles both — A and B each
 * dispatch exactly 2 direct subagents (A1+A2, B1+B2), C dispatches
 * none, and the two depth-2 chains (A1→A1a, B1→B1a) bring the
 * total to 9 while preserving "C has no descendants" semantic
 * coverage. The depth-2 chains also exercise the recursive CTE
 * task 2.2 introduces.
 *
 * Per-root messages: a system text part, a user text part, an
 * assistant message whose parts include text + tool (with output) +
 * reasoning + step-finish. The assistant message.data carries the
 * `tokens` and `cost` JSON sub-objects exactly as opencode emits
 * them (design.md:983-998).
 *
 * Per-child / per-grandchild messages: a single assistant message
 * with text + tool parts (simpler — subagent dispatches are
 * typically short).
 *
 * Token / cost numbers: small but realistic. Each root assistant
 * message carries tokens {input:10000, output:500, reasoning:100,
 * cache:{read:5000, write:1000}} and cost 0.05. Each child assistant
 * message carries tokens {input:2000, output:200, reasoning:50,
 * cache:{read:1000, write:200}} and cost 0.01. These were chosen so
 * tasks 6.1/6.2 can hand-compute expected bucket sums and
 * subagent-rollup totals from these constants without needing to
 * read the fixture script first.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

// ────────────────────────────────────────────────────────────────────
// Determinism anchors
// ────────────────────────────────────────────────────────────────────
//
// BASE_TIME is the timestamp used as the anchor for every other
// timestamp in the fixture. Chosen to match the verified live
// `session_usage_from_messages` migration timestamp from the
// gap-analysis log so the fixture's data_migration row looks
// indistinguishable from a real opencode install of the pinned
// version. Every other timestamp is BASE_TIME + a small fixed
// offset so ordering is stable and reproducible.

const BASE_TIME = 1778775290084;

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'tests',
  'opencode-cost-diagnosis',
  'fixtures',
  'opencode-stable.db',
);

// ────────────────────────────────────────────────────────────────────
// Schema (mirrors design.md:855-925 plus design.md:555)
// ────────────────────────────────────────────────────────────────────
//
// The reader only consults the columns named in design.md's ER
// diagram and the `data_migration` table. We declare every column
// the ER diagram lists so a future reader update that selects a
// not-yet-read column doesn't blow up against this fixture. Columns
// outside the ER diagram (`slug`, `share_url`, `permission`, etc.,
// referenced in the task brief's Implementation Notes) are added as
// nullable TEXT so they exist for forward-compat without forcing
// the fixture to carry meaningless values.

const SCHEMA_STATEMENTS = [
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
  // The live opencode schema (`sqlite3 ~/.local/share/opencode/
  // opencode-stable.db ".schema part"`) carries `type` INSIDE the
  // `data` JSON blob, not as a top-level column. The earlier v1
  // fixture modeled `type` as a column, which made the diagnostic
  // appear correct against the fixture but fail against live data —
  // every live part was classified as "unknown" because the column
  // didn't exist. Match the production schema so reader/tokenizer
  // tests exercise the same JSON-derived `type` synthesis the live
  // path uses.
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

// ────────────────────────────────────────────────────────────────────
// Token / cost shapes (the diagnostic's primary measurement surface)
// ────────────────────────────────────────────────────────────────────

const ROOT_TOKENS = {
  total: 16600,
  input: 10000,
  output: 500,
  reasoning: 100,
  cache: { read: 5000, write: 1000 },
};
const ROOT_COST = 0.05;

const CHILD_TOKENS = {
  total: 3450,
  input: 2000,
  output: 200,
  reasoning: 50,
  cache: { read: 1000, write: 200 },
};
const CHILD_COST = 0.01;

const MODEL_ID = 'claude-opus-4-7';
const PROVIDER_ID = 'anthropic';

// ────────────────────────────────────────────────────────────────────
// Fixture topology
// ────────────────────────────────────────────────────────────────────
//
// Three roots; A and B dispatch 2 direct subagents each, and the
// first direct subagent of each dispatches a single grandchild
// (nested subagent). C dispatches none. Asymmetry is intentional:
// tests cover (a) rollup over a root with descendants, (b) rollup
// over a root with no descendants, and (c) the recursive CTE path
// over depth-2 chains.
//
//   3 roots + 4 direct children + 2 grandchildren = 9 sessions.

const ROOTS = [
  {
    id: 'ses_root_a',
    agent: 'build',
    cwd: '/Users/test/project-a',
    children: [
      { id: 'ses_root_a_child_0', grandchildren: ['ses_root_a_child_0_sub_0'] },
      { id: 'ses_root_a_child_1', grandchildren: [] },
    ],
    offset: 0,
  },
  {
    id: 'ses_root_b',
    agent: 'general',
    cwd: '/Users/test/project-b',
    children: [
      { id: 'ses_root_b_child_0', grandchildren: ['ses_root_b_child_0_sub_0'] },
      { id: 'ses_root_b_child_1', grandchildren: [] },
    ],
    offset: 1000,
  },
  {
    id: 'ses_root_c',
    agent: 'explore',
    cwd: '/Users/test/project-c',
    children: [],
    offset: 2000,
  },
];

// ────────────────────────────────────────────────────────────────────
// Insert helpers
// ────────────────────────────────────────────────────────────────────

function insertSession(stmt, opts) {
  stmt.run(
    opts.id,
    opts.parentId,
    opts.directory,
    opts.agent,
    MODEL_ID,
    opts.cost,
    opts.tokens.input,
    opts.tokens.output,
    opts.tokens.reasoning,
    opts.tokens.cache.read,
    opts.tokens.cache.write,
    opts.timeCreated,
    opts.timeUpdated,
    '',   // slug — not read by diagnostic
    '',   // share_url — not read by diagnostic
    '',   // permission — not read by diagnostic
  );
}

function insertMessage(stmt, opts) {
  stmt.run(
    opts.id,
    opts.sessionId,
    JSON.stringify(opts.data),
    opts.timeCreated,
    opts.timeUpdated,
  );
}

function insertPart(stmt, opts) {
  // Embed `type` inside the `data` JSON blob to match the live
  // opencode schema (see SCHEMA_STATEMENTS comment above). The
  // builder functions below still pass `type` as a sibling
  // property for readability — we merge it into data at insert
  // time so the on-disk shape matches what SqliteReader's
  // synthesized-type path expects to parse.
  const data = { type: opts.type, ...opts.data };
  stmt.run(
    opts.id,
    opts.messageId,
    opts.sessionId,
    JSON.stringify(data),
    opts.timeCreated,
    opts.timeUpdated,
  );
}

// ────────────────────────────────────────────────────────────────────
// Message generators
// ────────────────────────────────────────────────────────────────────
//
// Roots get the full mix: system text, user text, assistant message
// whose parts span text + tool + reasoning + step-finish. Children
// get a single assistant message with text + tool, modelling the
// short-lived subagent dispatch pattern.

function buildRootMessages(sessionId, cwd, baseTime) {
  const msgs = [];

  // System message — one text part, role:system in message.data.
  msgs.push({
    message: {
      id: `msg_${sessionId}_sys`,
      sessionId,
      timeCreated: baseTime + 1,
      timeUpdated: baseTime + 1,
      data: { role: 'system', path: { cwd, root: cwd } },
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
  });

  // User message — one text part, role:user.
  msgs.push({
    message: {
      id: `msg_${sessionId}_usr`,
      sessionId,
      timeCreated: baseTime + 10,
      timeUpdated: baseTime + 10,
      data: { role: 'user', path: { cwd, root: cwd } },
    },
    parts: [
      {
        id: `prt_${sessionId}_usr_0`,
        type: 'text',
        timeCreated: baseTime + 11,
        timeUpdated: baseTime + 11,
        data: { text: 'Please analyze the project layout.' },
      },
    ],
  });

  // Assistant message — text + tool (with output) + reasoning +
  // step-finish. message.data carries the authoritative `cost` and
  // `tokens` per design.md:983-998. The step-finish part carries the
  // per-step cost/tokens snapshot.
  msgs.push({
    message: {
      id: `msg_${sessionId}_ast`,
      sessionId,
      timeCreated: baseTime + 20,
      timeUpdated: baseTime + 20,
      data: {
        role: 'assistant',
        cost: ROOT_COST,
        tokens: ROOT_TOKENS,
        modelID: MODEL_ID,
        providerID: PROVIDER_ID,
        path: { cwd, root: cwd },
      },
    },
    parts: [
      {
        id: `prt_${sessionId}_ast_0`,
        type: 'text',
        timeCreated: baseTime + 21,
        timeUpdated: baseTime + 21,
        data: { text: 'I will look at the project tree.' },
      },
      {
        id: `prt_${sessionId}_ast_1`,
        type: 'tool',
        timeCreated: baseTime + 22,
        timeUpdated: baseTime + 22,
        data: {
          tool: 'bash',
          state: {
            status: 'completed',
            output: 'src/\ntests/\nREADME.md\n',
            input: { command: 'ls' },
          },
        },
      },
      {
        id: `prt_${sessionId}_ast_2`,
        type: 'reasoning',
        timeCreated: baseTime + 23,
        timeUpdated: baseTime + 23,
        data: { text: 'Standard layout; nothing unusual.' },
      },
      {
        id: `prt_${sessionId}_ast_3`,
        type: 'step-finish',
        timeCreated: baseTime + 24,
        timeUpdated: baseTime + 24,
        data: {
          cost: ROOT_COST,
          tokens: ROOT_TOKENS,
        },
      },
    ],
  });

  return msgs;
}

function buildChildMessages(sessionId, cwd, baseTime) {
  // Single assistant message with text + tool parts. Subagent
  // dispatches are typically short and don't include a separate
  // system/user turn at this layer (the parent session orchestrated
  // those).
  return [
    {
      message: {
        id: `msg_${sessionId}_ast`,
        sessionId,
        timeCreated: baseTime + 1,
        timeUpdated: baseTime + 1,
        data: {
          role: 'assistant',
          cost: CHILD_COST,
          tokens: CHILD_TOKENS,
          modelID: MODEL_ID,
          providerID: PROVIDER_ID,
          path: { cwd, root: cwd },
        },
      },
      parts: [
        {
          id: `prt_${sessionId}_ast_0`,
          type: 'text',
          timeCreated: baseTime + 2,
          timeUpdated: baseTime + 2,
          data: { text: 'Subagent: reading the requested file.' },
        },
        {
          id: `prt_${sessionId}_ast_1`,
          type: 'tool',
          timeCreated: baseTime + 3,
          timeUpdated: baseTime + 3,
          data: {
            tool: 'read',
            state: {
              status: 'completed',
              output: '<file contents elided>',
              input: { filePath: '/Users/test/sample.txt' },
            },
          },
        },
      ],
    },
  ];
}

// ────────────────────────────────────────────────────────────────────
// Build the fixture
// ────────────────────────────────────────────────────────────────────

function generate() {
  // Idempotency: rebuild from scratch. SQLite cannot reliably
  // overwrite-in-place to produce a byte-identical file because the
  // existing pages may carry historical row IDs / freelist state
  // that subsequent inserts inherit. Unlink first; reopen on a
  // fresh, page-0 file.
  if (fs.existsSync(FIXTURE_PATH)) {
    fs.unlinkSync(FIXTURE_PATH);
  }
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });

  const db = new Database(FIXTURE_PATH);

  // Determinism knobs: lock to the default rollback journal mode
  // (WAL would create sidecar files and change the main file's
  // header) and disable synchronous so SQLite doesn't tag the file
  // with environmental state. The diagnostic opens with
  // `{ readonly: true }` so journal mode of the source DB is
  // irrelevant at read time.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  // SQLite tags every new DB with an `application_id` of 0 by
  // default; pinning explicitly removes one source of cross-version
  // drift if a future SQLite release ever changes the default.
  db.pragma('application_id = 0');

  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }

  const insertSessionStmt = db.prepare(`
    INSERT INTO session (
      id, parent_id, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write,
      time_created, time_updated,
      slug, share_url, permission
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessageStmt = db.prepare(`
    INSERT INTO message (id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPartStmt = db.prepare(`
    INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMigrationStmt = db.prepare(`
    INSERT INTO data_migration (name, time_completed) VALUES (?, ?)
  `);

  // Single transaction across all inserts. Bulk insert in a single
  // transaction is the easiest way to get a stable on-disk page
  // layout — SQLite allocates pages monotonically inside one txn
  // and doesn't have to reshuffle anything afterwards.
  const tx = db.transaction(() => {
    for (const root of ROOTS) {
      const rootTime = BASE_TIME + root.offset;

      insertSession(insertSessionStmt, {
        id: root.id,
        parentId: null,
        directory: root.cwd,
        agent: root.agent,
        cost: ROOT_COST,
        tokens: ROOT_TOKENS,
        timeCreated: rootTime,
        timeUpdated: rootTime + 100,
      });

      for (const m of buildRootMessages(root.id, root.cwd, rootTime)) {
        insertMessage(insertMessageStmt, m.message);
        for (const p of m.parts) {
          insertPart(insertPartStmt, { ...p, messageId: m.message.id, sessionId: root.id });
        }
      }

      // Direct children + their grandchildren. Per-child time
      // offset (50 + i*20) keeps every child's timestamps distinct
      // from the parent's and from sibling children's; grandchildren
      // get a further +5 offset off their parent so the ordering is
      // unambiguous without depending on any external state.
      for (let i = 0; i < root.children.length; i++) {
        const child = root.children[i];
        const childTime = rootTime + 50 + i * 20;

        insertSession(insertSessionStmt, {
          id: child.id,
          parentId: root.id,
          directory: root.cwd,
          agent: 'general',
          cost: CHILD_COST,
          tokens: CHILD_TOKENS,
          timeCreated: childTime,
          timeUpdated: childTime + 5,
        });

        for (const m of buildChildMessages(child.id, root.cwd, childTime)) {
          insertMessage(insertMessageStmt, m.message);
          for (const p of m.parts) {
            insertPart(insertPartStmt, { ...p, messageId: m.message.id, sessionId: child.id });
          }
        }

        // Grandchildren — nested subagent dispatches. Parent is the
        // direct child, NOT the root, so the recursive CTE in
        // descendantSessionsOf (task 2.2) has to walk depth ≥ 2 to
        // include them.
        for (let j = 0; j < child.grandchildren.length; j++) {
          const grandchildId = child.grandchildren[j];
          const grandchildTime = childTime + 5 + j * 2;

          insertSession(insertSessionStmt, {
            id: grandchildId,
            parentId: child.id,
            directory: root.cwd,
            agent: 'general',
            cost: CHILD_COST,
            tokens: CHILD_TOKENS,
            timeCreated: grandchildTime,
            timeUpdated: grandchildTime + 2,
          });

          for (const m of buildChildMessages(grandchildId, root.cwd, grandchildTime)) {
            insertMessage(insertMessageStmt, m.message);
            for (const p of m.parts) {
              insertPart(insertPartStmt, {
                ...p,
                messageId: m.message.id,
                sessionId: grandchildId,
              });
            }
          }
        }
      }
    }

    // data_migration: pinned v1 baseline (design.md:557-558).
    // Single row, recorded at BASE_TIME.
    insertMigrationStmt.run('session_usage_from_messages', BASE_TIME);
  });
  tx();

  // VACUUM rewrites the file with no freelist pages and a compact
  // page layout. This is the single most important determinism step:
  // without VACUUM the file would carry any incidental allocator
  // state from the inserts above and could differ run-to-run if
  // better-sqlite3 / SQLite were ever rebuilt against different
  // page-size defaults.
  db.exec('VACUUM');
  db.close();

  process.stdout.write(
    `wrote ${path.relative(process.cwd(), FIXTURE_PATH)}\n`,
  );
}

generate();
