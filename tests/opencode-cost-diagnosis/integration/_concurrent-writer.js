/*
 * _concurrent-writer.js — forked child process used by integration
 * test (2) to write to the diagnostic's SQLite DB while the parent
 * process reads it via SqliteReader / main().
 *
 * Filename prefix `_` so the run.js discovery regex
 * (`(\.|-)test\.(?:c?js|mjs)$`) does not register us as a test —
 * we are a worker, not a test file.
 *
 * Lifecycle:
 *
 *   1. Parent spawns this file via child_process.fork(modulePath, [],
 *      { env: { ...process.env, WRITER_DB_PATH: <path> } })
 *   2. We open the DB in write mode, prepare an INSERT statement,
 *      then send `{ type: 'ready' }` over IPC so the parent knows we
 *      are armed.
 *   3. On `{ type: 'start' }` from the parent, fire one INSERT every
 *      INTERVAL_MS, sending `{ type: 'wrote', count }` after each.
 *   4. On `{ type: 'stop' }` from the parent, stop the interval,
 *      close the DB, and `process.exit(0)`.
 *
 * The handshake matters: the parent needs `ready` before it kicks
 * off main(), and `start` only happens after the parent has armed
 * its own measurement infrastructure. This means the writes are
 * guaranteed to be live during main()'s execution, which is the
 * concurrency claim under test.
 *
 * Errors (SQLITE_BUSY, lock contention) are caught and counted but
 * NOT fatal — the test verifies the diagnostic survives concurrent
 * writes, not that every individual write succeeds.
 */
'use strict';

const Database = require('better-sqlite3');

const DB_PATH = process.env.WRITER_DB_PATH;
if (!DB_PATH) {
  // Defensive: fork() without WRITER_DB_PATH is a programming
  // error in the parent. Crash loudly so the parent's IPC times
  // out rather than waiting for `ready` forever.
  // eslint-disable-next-line no-console
  console.error('_concurrent-writer.js: WRITER_DB_PATH env var is required');
  process.exit(2);
}

const INTERVAL_MS = 5; // tight loop — main() is sub-second so we
                       // want many tick attempts during the window.

const db = new Database(DB_PATH);
// busy_timeout lets writes retry briefly under WAL contention
// instead of failing immediately. The parent's reader uses better-
// sqlite3's default (which is also lenient), so both sides have
// matching tolerance.
db.pragma('busy_timeout = 200');

const insertStmt = db.prepare(`
  INSERT INTO session (
    id, parent_id, directory, agent, model, cost,
    tokens_input, tokens_output, tokens_reasoning,
    tokens_cache_read, tokens_cache_write,
    time_created, time_updated
  ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let attempts = 0;
let successes = 0;
let interval = null;

function writeOne() {
  attempts += 1;
  const id = `ses_concurrent_${process.pid}_${attempts}`;
  // Use a wall-clock timestamp so the row passes any future
  // sanity check the reader might add for time_created. The exact
  // value isn't asserted by the test.
  const now = Date.now();
  try {
    insertStmt.run(
      id,
      '/Users/test/concurrent-writer',
      'concurrent-test',
      'test-model',
      0.0,
      0, 0, 0, 0, 0,
      now,
      now,
    );
    successes += 1;
    if (process.send) {
      process.send({ type: 'wrote', attempts, successes });
    }
  } catch (e) {
    // SQLITE_BUSY under WAL is rare but possible during checkpoint;
    // log via IPC so the parent test can surface it on failure.
    if (process.send) {
      process.send({
        type: 'error',
        attempts,
        message: e && e.message ? e.message : String(e),
      });
    }
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start') {
    if (interval !== null) return; // idempotent
    interval = setInterval(writeOne, INTERVAL_MS);
  } else if (msg.type === 'stop') {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    try { db.close(); } catch { /* best-effort */ }
    // Tell the parent we're done so it can wait on a final
    // confirmation before joining (it can also just rely on the
    // `exit` event from the child handle).
    if (process.send) {
      process.send({ type: 'stopped', attempts, successes });
    }
    process.exit(0);
  }
});

// Ready handshake — tells the parent we have the DB open and the
// statement prepared. The parent can now issue `start`.
if (process.send) {
  process.send({ type: 'ready' });
} else {
  // Not forked (no IPC). Treat as standalone invocation for ad-hoc
  // debugging: write one row and exit.
  writeOne();
  try { db.close(); } catch { /* best-effort */ }
  process.exit(0);
}

// Safety net: if the parent ever orphans us (test crash before
// sending `stop`), terminate after 30s rather than leaking a
// process. Long enough to never bite a healthy run, short enough to
// not haunt a developer's machine.
setTimeout(() => {
  if (interval !== null) clearInterval(interval);
  try { db.close(); } catch { /* best-effort */ }
  process.exit(0);
}, 30_000).unref();
