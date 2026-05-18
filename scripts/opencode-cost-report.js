#!/usr/bin/env node
/*
 * opencode-cost-report.js — diagnostic CLI entry point for the
 * opencode session cost-attribution report.
 *
 * Spec: .kiro/specs/opencode-cost-diagnosis.
 *
 * Task 1.3 landed the stub. Task 2.1 added the SQLite Reader's
 * open/close lifecycle + schema-drift detection. Task 2.2 (this
 * revision) layers the four iteration methods —
 * rootSessionsMatching, descendantSessionsOf, partsOfSession,
 * messagesOfSession — onto the same class. All four return lazy
 * iterables (better-sqlite3 StatementIterator) so large sessions do
 * not buffer entirely in memory. SQL is parameterized end-to-end;
 * no string concatenation of user input. Subsequent 3.x–5.x tasks
 * layer the attribution, tokenizer, reporter, and argument-parser
 * surfaces onto the same file (or split once it grows beyond
 * one-screen-of-purpose, per design.md File Structure Plan lines
 * 200-211).
 *
 * The stub --help / no-args / unknown-args behavior from 1.3 is
 * preserved verbatim and ONLY runs when this file is executed as a
 * script (require.main === module). When required as a module by the
 * test suite under tests/opencode-cost-diagnosis/, only the named
 * exports below are surfaced — there are no top-level side effects.
 *
 * Invoked from `scripts/opencode-cost-report.nix`, which is a
 * `writeShellApplication` that sets NODE_PATH to the vendored deps
 * tree produced by `pkgs.opencode-cost-diagnosis-deps`
 * (overlays/mcp-servers.nix) and execs `node` against this file.
 *
 * Design references:
 *   - design.md SQLite Reader component (lines 408-540)
 *   - design.md schema-drift Implementation Notes (lines 525-539)
 *   - requirements.md Requirement 5 (schema-drift detection) and
 *     Requirement 6 (read-only safety; AC4 names the expected DB
 *     path on missing-DB exit)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

/* ------------------------------------------------------------------ *
 * Pinned schema baseline
 * ------------------------------------------------------------------ */

// Semver range this build of the diagnostic supports. design.md does
// not pin a specific string; the range below brackets opencode releases
// around the 2026-05-16 verification baseline (when the v1 migration
// set was confirmed live on the Shopify host) and is intentionally
// generous so unrelated opencode point releases don't trigger spurious
// drift warnings — schema drift is detected by the migration-set check
// below, not by parsing opencode's version string. Tightened/bumped in
// future tasks if a new migration lands.
//
// MUST stay in sync with EXPECTED_VERSION_RANGE in
// scripts/opencode-cost-diagnosis-smoke-test.nix. The smoke test
// greps for this literal string in `--supported-opencode-version`
// output, so a one-sided update will fire its version_mismatch label.
const SUPPORTED_VERSION_RANGE = '>=0.18.0 <0.30.0';

// Pinned set of `data_migration.name` rows the reader expects to see.
// design.md:539 records this as the v1 baseline, verified live on
// 2026-05-16. Object.freeze prevents accidental mutation from any
// downstream caller that imports the constant.
//
// MUST stay in sync with SUPPORTED_MIGRATIONS (bash array) in
// scripts/opencode-cost-diagnosis-smoke-test.nix. The smoke test
// runs `SELECT name FROM data_migration ORDER BY name` directly via
// the sqlite3 CLI and compares against that array, so a one-sided
// update — adding a migration name here but not in the bash array,
// or vice versa — will surface as schema_drift on the next
// `darwin-rebuild switch`.
const SUPPORTED_MIGRATION_SET = Object.freeze(['session_usage_from_messages']);

/* ------------------------------------------------------------------ *
 * SchemaDriftError
 * ------------------------------------------------------------------ */

class SchemaDriftError extends Error {
  constructor(detectedMigrationSet, supportedMigrationSet, supportedVersionRange) {
    const detected = [...detectedMigrationSet].sort();
    const supported = [...supportedMigrationSet].sort();
    const added = detected.filter((n) => !supported.includes(n));
    const removed = supported.filter((n) => !detected.includes(n));

    const drift = [];
    if (added.length > 0) drift.push(`unexpected: [${added.join(', ')}]`);
    if (removed.length > 0) drift.push(`missing: [${removed.join(', ')}]`);

    const message =
      `opencode schema drift detected: data_migration table does not match the pinned baseline.\n` +
      `  detected:  [${detected.join(', ')}]\n` +
      `  supported: [${supported.join(', ')}]\n` +
      `  drift:     ${drift.join('; ') || '(set difference)'}\n` +
      `  supported opencode version range: ${supportedVersionRange}\n` +
      `\n` +
      `Recommended next action: re-verify the opencode-cost-diagnosis spec's\n` +
      `pinned migration set against the current opencode release, then either\n` +
      `(a) update SUPPORTED_MIGRATION_SET in scripts/opencode-cost-report.js\n` +
      `and re-run the smoke test, or (b) pin opencode back to a release within\n` +
      `the supported version range (${supportedVersionRange}).`;

    super(message);
    this.name = 'SchemaDriftError';
    this.detectedMigrationSet = detected;
    this.supportedMigrationSet = supported;
    this.supportedVersionRange = supportedVersionRange;
  }
}

/* ------------------------------------------------------------------ *
 * SqliteReader
 *
 * Read-only access to the opencode session DB, with a schema-drift
 * gate on open() and lazy iteration over the four row sets the rest
 * of the pipeline needs (root sessions matching a filter, the
 * recursive descendant tree of a root, parts of a single session,
 * and messages of a single session with role pre-parsed).
 * ------------------------------------------------------------------ */

class SqliteReader {
  constructor() {
    this._db = null;
  }

  get supportedVersionRange() {
    return SUPPORTED_VERSION_RANGE;
  }

  /**
   * Open the opencode session DB read-only and verify schema is at
   * the pinned baseline. On drift, throws SchemaDriftError carrying
   * both sets + the version range. On missing-DB, throws an Error
   * whose message names the expected path verbatim (R6.AC4).
   *
   * @param {string} dbPath absolute path to opencode-stable.db
   */
  open(dbPath) {
    if (this._db !== null) {
      throw new Error(
        `SqliteReader.open: already open against a database; call close() first`,
      );
    }

    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      // better-sqlite3 throws SqliteError with code 'SQLITE_CANTOPEN'
      // when fileMustExist:true and the path is missing, or a plain
      // Error from Node's underlying open() on ENOENT/EACCES paths
      // that don't make it as far as SQLite. Either way, surface the
      // expected path so an operator can act on it without spelunking
      // a stack trace (R6.AC4).
      const cause = e && e.message ? e.message : String(e);
      const wrapped = new Error(
        `opencode session database not found or not readable at ${dbPath}: ${cause}`,
      );
      wrapped.cause = e;
      wrapped.dbPath = dbPath;
      throw wrapped;
    }

    // Schema-drift check runs once per open(); if it throws, we
    // release the underlying handle before propagating so the caller
    // doesn't have to close a reader whose open() failed.
    try {
      const detected = this._readMigrationSet(db);
      if (!setsEqual(detected, SUPPORTED_MIGRATION_SET)) {
        throw new SchemaDriftError(
          detected,
          SUPPORTED_MIGRATION_SET,
          SUPPORTED_VERSION_RANGE,
        );
      }
    } catch (e) {
      try {
        db.close();
      } catch {
        // Best-effort cleanup; the original error is what the caller
        // wanted to know about.
      }
      throw e;
    }

    this._db = db;
  }

  /**
   * Reads the data_migration table and returns the sorted set of
   * applied migration names. Public so the smoke test in 6.3 can
   * inspect the live schema without going through open() (and so the
   * argument parser in 5.3 can implement --supported-opencode-version
   * by reading SUPPORTED_MIGRATION_SET directly).
   *
   * Requires an open reader.
   */
  detectMigrationSet() {
    if (this._db === null) {
      throw new Error(
        `SqliteReader.detectMigrationSet: reader is not open; call open() first`,
      );
    }
    return this._readMigrationSet(this._db);
  }

  // Internal: shared between open()'s drift check and the public
  // detectMigrationSet(). Sorted so callers (and the drift check)
  // can rely on deterministic ordering.
  _readMigrationSet(db) {
    const rows = db
      .prepare('SELECT name FROM data_migration ORDER BY name')
      .all();
    return rows.map((r) => r.name).sort();
  }

  /**
   * Iterate root sessions (parent_id IS NULL) matching the given
   * filter. Filter fields are AND-combined; absent / null fields are
   * not applied. SQL is parameterized — no user input is ever
   * concatenated into the query string.
   *
   * For task 2.2 cwdPattern is treated as an exact match. The
   * Session Selector (task 5.2) is the layer that translates a glob
   * into a SQL LIKE pattern and re-invokes this method; the design
   * intentionally keeps glob semantics out of the reader.
   *
   * Returns better-sqlite3's StatementIterator, which fetches one
   * row per `next()` call and so does not materialize the full
   * result set in memory.
   *
   * @param {{
   *   timeRangeStart?: number,
   *   timeRangeEnd?: number,
   *   sessionId?: string,
   *   cwdPattern?: string,
   * }} filter
   * @returns {Iterable<object>} session rows in (time_created, id) ASC
   */
  rootSessionsMatching(filter) {
    this._ensureOpen('rootSessionsMatching');
    const f = filter || {};
    const clauses = ['parent_id IS NULL'];
    const params = [];
    if (f.timeRangeStart != null) {
      clauses.push('time_created >= ?');
      params.push(f.timeRangeStart);
    }
    if (f.timeRangeEnd != null) {
      clauses.push('time_created < ?');
      params.push(f.timeRangeEnd);
    }
    if (f.sessionId != null) {
      clauses.push('id = ?');
      params.push(f.sessionId);
    }
    if (f.cwdPattern != null) {
      clauses.push('directory = ?');
      params.push(f.cwdPattern);
    }
    const sql =
      `SELECT * FROM session WHERE ${clauses.join(' AND ')} ` +
      `ORDER BY time_created ASC, id ASC`;
    return this._db.prepare(sql).iterate(...params);
  }

  /**
   * Iterate the recursive descendants of `rootSessionId` (direct
   * children + grandchildren + …, walking via parent_id). Used by
   * the Subagent Aggregator (task 3.1) to roll subagent token
   * totals up to the originating root.
   *
   * @param {string} rootSessionId
   * @returns {Iterable<object>} session rows
   */
  descendantSessionsOf(rootSessionId) {
    this._ensureOpen('descendantSessionsOf');
    const sql = `
      WITH RECURSIVE descendants AS (
        SELECT * FROM session WHERE parent_id = ?
        UNION ALL
        SELECT s.* FROM session s
        JOIN descendants d ON s.parent_id = d.id
      )
      SELECT * FROM descendants
    `;
    return this._db.prepare(sql).iterate(rootSessionId);
  }

  /**
   * Iterate parts of a single session in (time_created, id) ASC
   * order. The Tokenizer Splitter (task 4.x) needs deterministic
   * ordering both for prompt-composition reasoning and for stable
   * test snapshots.
   *
   * Schema reality (live opencode, confirmed via
   * `sqlite3 ~/.local/share/opencode/opencode-stable.db
   * ".schema part"`): the `part` table has NO top-level `type`
   * column. The part kind lives INSIDE the `data` JSON blob as
   * `{ "type": "text", ... }` etc. The design document
   * (PartRow interface, design.md:482-491) and the v1 fixture
   * earlier assumed `type` was a column; both were wrong against
   * the production schema, and the consequence — every live part
   * classified as "unknown type" — surfaced via the diagnostic's
   * own fail-loud findings rather than corrupting attribution
   * silently.
   *
   * We preserve the consumer-facing PartRow contract (downstream
   * code reads `part.type` and `part.data` directly) by parsing
   * `data` once per row inside the iterator and synthesising the
   * `type` field on the returned object. Malformed JSON or a
   * missing `type` field both resolve to `null`, mirroring
   * messagesOfSession's role-synthesis behaviour, so the
   * TokenizerSplitter's existing classification logic (which
   * routes unrecognised types to `unclassifiedCount`) handles
   * the edge cases without needing to be aware of the schema
   * change.
   *
   * @param {string} sessionId
   * @returns {Iterable<object>} part rows with `type` added
   */
  partsOfSession(sessionId) {
    this._ensureOpen('partsOfSession');
    const inner = this._db
      .prepare(
        'SELECT id, message_id, session_id, time_created, time_updated, data ' +
          'FROM part WHERE session_id = ? ' +
          'ORDER BY time_created ASC, id ASC',
      )
      .iterate(sessionId);
    return {
      [Symbol.iterator]() {
        return {
          next() {
            const step = inner.next();
            if (step.done) return { value: undefined, done: true };
            const row = step.value;
            let type = null;
            try {
              const parsed = JSON.parse(row.data);
              if (parsed && typeof parsed.type === 'string') {
                type = parsed.type;
              }
            } catch {
              // Malformed JSON → type stays null. The full data
              // blob is preserved on the row so the Tokenizer
              // can still attempt its own JSON.parse and surface
              // a schema_partial_data finding for the operator.
            }
            return { value: { ...row, type }, done: false };
          },
          // Forward early-termination (for…of break, throw, etc.) to
          // the inner better-sqlite3 StatementIterator so it releases
          // the underlying sqlite3_stmt. Without this, a partial
          // iteration would leave the connection "busy executing a
          // query" and any subsequent close() / re-query would throw.
          return(value) {
            if (typeof inner.return === 'function') inner.return();
            return { value, done: true };
          },
        };
      },
    };
  }

  /**
   * Iterate messages of a single session in time_created ASC order,
   * with `role` pre-parsed out of `message.data` JSON. Defaults to
   * null when the JSON is missing a `role` field or fails to parse,
   * so downstream callers can rely on the field being present even
   * for malformed rows without re-parsing the blob themselves.
   *
   * The wrapper iterator parses one row at a time inside `next()`,
   * preserving the laziness of the underlying StatementIterator —
   * roleless rows do not force a full table read.
   *
   * @param {string} sessionId
   * @returns {Iterable<object>} message rows with `role` added
   */
  messagesOfSession(sessionId) {
    this._ensureOpen('messagesOfSession');
    const inner = this._db
      .prepare(
        'SELECT * FROM message WHERE session_id = ? ' +
          'ORDER BY time_created ASC',
      )
      .iterate(sessionId);
    return {
      [Symbol.iterator]() {
        return {
          next() {
            const step = inner.next();
            if (step.done) return { value: undefined, done: true };
            const row = step.value;
            let role = null;
            try {
              const parsed = JSON.parse(row.data);
              if (parsed && typeof parsed.role === 'string') {
                role = parsed.role;
              }
            } catch {
              // Malformed JSON → role stays null. The full data blob
              // is preserved on the row so callers can introspect.
            }
            return { value: { ...row, role }, done: false };
          },
          // Forward early-termination (for…of break, throw, etc.) to
          // the inner better-sqlite3 StatementIterator so it releases
          // the underlying sqlite3_stmt. Without this, a partial
          // iteration would leave the connection "busy executing a
          // query" and any subsequent close() / re-query would throw.
          return(value) {
            if (typeof inner.return === 'function') inner.return();
            return { value, done: true };
          },
        };
      },
    };
  }

  // Internal guard for iteration methods; keeps each method's
  // "reader is not open" error self-identifying so an operator can
  // see which API was misused without a stack-trace dive.
  _ensureOpen(method) {
    if (this._db === null) {
      throw new Error(
        `SqliteReader.${method}: reader is not open; call open() first`,
      );
    }
  }

  /**
   * Releases the underlying file handle. Safe to call multiple times
   * and safe to call before open() — the latter matters because
   * open()'s drift-failure path may want to call close() defensively
   * during test teardown.
   */
  close() {
    if (this._db === null) return;
    try {
      this._db.close();
    } finally {
      this._db = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * SubagentAggregator
 *
 * Recursive parent_id rollup of descendant-session token + cost
 * totals into a single SubagentBucketTotals record for the
 * originating root session. Used by the Attribution Engine (task
 * 3.3) to populate the `subagentDispatch` bucket on the root's
 * SessionAttribution.
 *
 * Topology: walks descendants via the Reader's
 * `descendantSessionsOf(rootId)`, which already implements the
 * recursive CTE on `session.parent_id`. The CTE itself does not
 * detect cycles — the SQL is `parent_id = d.id` joined unboundedly
 * — so a malformed DB whose parent_id chain forms a loop will yield
 * an infinite row stream. Cycle defence lives here: a `visited` Set
 * keyed by session id is consulted before counting each row;
 * duplicates trigger exactly one `schema_partial_data` finding per
 * cycle and bail out of the subtree by skipping the rest of the
 * iterator.
 *
 * The visited set is seeded with the root id so the root itself
 * (which descendantSessionsOf never returns anyway) cannot become
 * a phantom self-cycle, and so that if a descendant's parent_id
 * incorrectly points back at the root we treat it as a cycle on
 * first re-encounter.
 *
 * Per design.md lines 671-681 the interface signature is
 * `rollup(rootSessionId): SubagentBucketTotals`. We return
 * `{totals, findings}` instead so the Attribution Engine receives
 * findings without a second method call or instance-state read;
 * see aggregator.test.js header for the deviation rationale.
 *
 * `schemaSupportsParentLink` is true in v1 because the 2.1
 * schema-drift check verified the pinned migration set, which
 * implicitly guarantees the parent_id column. The accessor exists
 * for the 5.3 fallback contract (future opencode change drops the
 * column) but in v1 the drift check fails-loudly before this
 * accessor is consulted.
 *
 * Per-descendant token sum follows requirements 2.3 (e) + task
 * 3.1: tokens_input + tokens_output + tokens_cache_read +
 * tokens_cache_write + tokens_reasoning. SubagentBucketTotals'
 * design field is `tokensTotal: number` (single sum across all
 * kinds), not per-bucket, because the Attribution Engine consumes
 * it as one number to plug into the parent's subagentDispatch
 * bucket.
 * ------------------------------------------------------------------ */

class SubagentAggregator {
  constructor(reader) {
    this._reader = reader;
  }

  get schemaSupportsParentLink() {
    // v1 baseline: the schema-drift check in SqliteReader.open()
    // already verifies the pinned migration set, which includes
    // parent_id. A future opencode release that drops parent_id
    // would fail open() with SchemaDriftError before any
    // aggregator method is reachable, so v1 returns true
    // unconditionally. The accessor exists for the 5.3 fallback
    // contract that future implementations can flip.
    return true;
  }

  /**
   * Roll up all descendants of `rootSessionId` into a single
   * SubagentBucketTotals + a findings array.
   *
   * @param {string} rootSessionId
   * @returns {{
   *   totals: { tokensTotal: number, cost: number, childCount: number },
   *   findings: Array<{ kind: string, detail: string }>,
   * }}
   */
  rollup(rootSessionId) {
    // Fresh per-call state. Both `visited` and `findings` MUST be
    // local — instance-state caching would bleed cycle findings
    // and visited-ids from one rollup() into the next and break
    // the per-root attribution contract. The aggregator.test.js
    // "does not memoize across calls" test guards this.
    const visited = new Set([rootSessionId]);
    const findings = [];
    let tokensTotal = 0;
    let cost = 0;
    let childCount = 0;
    // One finding per detected cycle. The recursive CTE can revisit
    // many rows once a cycle exists; we deduplicate so the operator
    // sees one actionable finding per malformed link, not noise.
    let cycleEmitted = false;

    // Iterate the recursive descendants. The for…of loop's early
    // termination forwards into the StatementIterator's return()
    // hook (see messagesOfSession's wrapper for the same pattern),
    // so a hard break on cycle detection releases the underlying
    // sqlite3_stmt and prevents the recursive CTE from materialising
    // unbounded rows.
    for (const session of this._reader.descendantSessionsOf(rootSessionId)) {
      if (visited.has(session.id)) {
        if (!cycleEmitted) {
          findings.push({
            kind: 'schema_partial_data',
            detail:
              `subagent rollup: parent_id cycle detected at session ` +
              `${session.id} in descendant chain from root ` +
              `${rootSessionId}; bailing out of subtree, partial ` +
              `subagent totals may be reported`,
          });
          cycleEmitted = true;
        }
        // Bail out of the entire descendant walk on first cycle.
        // The alternative — `continue` past the duplicate row —
        // still trusts the recursive CTE to terminate, but in a
        // true loop the CTE will keep emitting the same duplicate
        // rows forever and the visited check will fire every time
        // without ever advancing. break is the only safe response.
        break;
      }
      visited.add(session.id);
      tokensTotal +=
        (session.tokens_input || 0) +
        (session.tokens_output || 0) +
        (session.tokens_cache_read || 0) +
        (session.tokens_cache_write || 0) +
        (session.tokens_reasoning || 0);
      cost += session.cost || 0;
      childCount += 1;
    }

    return {
      totals: { tokensTotal, cost, childCount },
      findings,
    };
  }
}

/* ------------------------------------------------------------------ *
 * TokenizerSplitter
 *
 * Walks the parts of one session and accumulates per-provenance
 * token counts using tiktoken's `cl100k_base` encoding. Lazy-init
 * + per-process cache the encoder (design.md:752-753); the rest of
 * the pipeline (Attribution Engine, task 3.3) constructs a single
 * Tokenizer per CLI invocation and shares it across every session.
 *
 * Classification rules (design.md:766-787; tasks.md:209-214):
 *
 *   - part.type == "text" AND messages.get(part.message_id).role
 *     == "system"                                  → systemPrompt
 *   - part.type == "text" AND role ∈ {user, assistant}
 *                                                  → history
 *   - part.type == "tool" AND part.data.state.output is a non-empty
 *     string                                       → toolOutput
 *   - part.type == "reasoning"                     → SKIP (counted
 *     in tokens_reasoning, not in the input bucket)
 *   - part.type ∈ {step-start, step-finish, compaction, agent,
 *     patch, file}                                 → SKIP (metadata,
 *     not in prompt body)
 *   - everything else                              → unclassifiedCount
 *
 * Text content extraction matches the on-disk shape that
 * SqliteReader.partsOfSession returns: `part.data` is a JSON string
 * (better-sqlite3 returns the raw TEXT column). We parse it once per
 * part and then read `data.text` for text/reasoning/metadata-style
 * parts and `data.state.output` for tool parts.
 *
 * Unknown-type contribution: the design says "Tokens summed across
 * parts whose part.type did not match any classification rule"
 * (design.md:806-810), so we DO encode the part's content rather
 * than counting "1 per unknown part". We try the text body first,
 * then the tool-output body, then fall back to JSON-stringifying
 * the parsed data so even a part with a completely novel shape
 * accrues some signal — the Attribution Engine (3.3) only needs
 * "did anything land here?" as the trigger for its
 * schema_partial_data finding.
 *
 * Text-part fallback (role lookup miss): a text part whose
 * `message_id` isn't in the `messages` Map, or whose message row
 * has `role` neither "system" nor "user" nor "assistant", goes to
 * unclassifiedCount — NOT silently into a default bucket. The
 * design's 5.4 contract ("fail loud, not silent") means anything
 * the classifier can't place must end up where 3.3 can surface it.
 *
 * What we deliberately do NOT do here:
 *
 *   - We don't free the tiktoken encoder. Per the task brief, the
 *     "memory leak" of holding the encoder for the process lifetime
 *     is acceptable for a one-shot CLI — correctness over tidy.
 *   - We don't filter "cached-prefix" parts. The design mentions
 *     this for completeness (lines 757-758) but the v1 opencode
 *     part rows carry no cache marker; the cached/uncached split
 *     comes from session.tokens_cache_read / .tokens_cache_write
 *     totals, which the Attribution Engine reads directly. The
 *     Tokenizer's output is consumed only as proportions over the
 *     three classified buckets.
 * ------------------------------------------------------------------ */

// Skipped non-classified part types per design.md:777-780. Built
// once as a Set so the per-part lookup is O(1). Module-scope so we
// don't allocate a fresh Set on every classifyAndCount call.
const TOKENIZER_SKIPPED_TYPES = Object.freeze(
  new Set(['reasoning', 'step-start', 'step-finish', 'compaction', 'agent', 'patch', 'file']),
);

class TokenizerSplitter {
  constructor() {
    // Lazy-init sentinel. The constructor MUST NOT call
    // get_encoding — task brief lazy-init contract, reader.test.js
    // -style white-box assertion in tokenizer.test.js, AND the
    // operational requirement that a `--help` / `--supported-opencode-version`
    // run (task 5.x) doesn't pay tiktoken's startup cost.
    this._encoding = null;
  }

  /**
   * Returns the cached tiktoken encoder, initializing it on first
   * call. Subsequent calls reuse the same instance for the lifetime
   * of this TokenizerSplitter (and, in normal CLI use, the lifetime
   * of the process).
   */
  _ensureEncoding() {
    if (this._encoding === null) {
      // Require lazily: keeps the constructor cheap and lets a unit
      // test that exercises only the no-encoder paths (e.g. the
      // "every metadata type is skipped" test) avoid pulling
      // tiktoken in at all. The require() result is cached by Node
      // so a second invocation of _ensureEncoding (different
      // TokenizerSplitter instance) does not re-traverse the module
      // graph.
      const { get_encoding } = require('tiktoken');
      this._encoding = get_encoding('cl100k_base');
    }
    return this._encoding;
  }

  /**
   * Compute per-provenance token counts for the parts of a single
   * session.
   *
   * @param {Iterable<object>} parts          part rows in any order;
   *   we treat them independently so the StatementIterator from
   *   SqliteReader.partsOfSession can be passed in directly (a for-of
   *   walk is the only iteration shape we use).
   * @param {ReadonlyMap<string, object>} messages
   *   map keyed by message.id with a `role` field on each value
   *   (SqliteReader.messagesOfSession already pre-parses it).
   * @returns {{
   *   systemPrompt: number,
   *   history: number,
   *   toolOutput: number,
   *   unclassifiedCount: number,
   * }} ProvenanceCounts. All four keys are always present; absent
   *   contributions are 0.
   */
  classifyAndCount(parts, messages) {
    const enc = this._ensureEncoding();

    let systemPrompt = 0;
    let history = 0;
    let toolOutput = 0;
    let unclassifiedCount = 0;

    for (const part of parts) {
      const type = part.type;

      // Skipped types short-circuit before parsing data — saves a
      // JSON.parse per skipped row, which matters for long sessions
      // where step-start / step-finish parts dominate.
      if (TOKENIZER_SKIPPED_TYPES.has(type)) {
        continue;
      }

      // Parse data once per part. The DB-backed path sends in a
      // string; synthetic tests may send in an already-parsed
      // object — accept either so unit tests don't have to mimic
      // better-sqlite3's TEXT-column shape exactly.
      let data;
      if (typeof part.data === 'string') {
        try {
          data = JSON.parse(part.data);
        } catch {
          // Malformed JSON: treat as unknown content. We can't
          // extract a text body so the part falls through to the
          // unclassified branch via the type test below; that's
          // already the right behavior for `text` / `tool` types
          // whose payloads aren't parseable.
          data = null;
        }
      } else {
        data = part.data;
      }

      if (type === 'text') {
        const text = (data && typeof data.text === 'string') ? data.text : '';
        if (text.length === 0) {
          // Empty text body: no tokens to bucket. Skip rather than
          // unclassify — a zero-length text part isn't a schema
          // surprise, just an empty turn.
          continue;
        }
        const message = messages.get(part.message_id);
        const role = message && typeof message.role === 'string' ? message.role : null;
        const tokens = enc.encode(text).length;
        if (role === 'system') {
          systemPrompt += tokens;
        } else if (role === 'user' || role === 'assistant') {
          history += tokens;
        } else {
          // Text part whose role we can't resolve (missing message
          // row, malformed message.data, or a role value opencode
          // adds later that isn't system/user/assistant). The 5.4
          // fail-loud contract says: surface, don't silently bucket.
          unclassifiedCount += tokens;
        }
      } else if (type === 'tool') {
        const output = data && data.state && typeof data.state.output === 'string'
          ? data.state.output
          : '';
        if (output.length > 0) {
          toolOutput += enc.encode(output).length;
        }
        // Tool parts whose state.output is absent or empty (pending
        // / running / errored-without-body) contribute 0. They are
        // NOT unclassified — the design rule covers tool parts
        // explicitly; the "no output" condition is just an empty
        // contribution.
      } else {
        // Unknown part.type. Extract whatever content we can find
        // so the Attribution Engine sees a non-zero count (its
        // trigger for the schema_partial_data finding). Fallback
        // order matches the most-likely content carriers in
        // opencode's part.data shape.
        let content = '';
        if (data && typeof data.text === 'string') {
          content = data.text;
        } else if (data && data.state && typeof data.state.output === 'string') {
          content = data.state.output;
        } else if (data !== null && data !== undefined) {
          // Last-resort fallback: serialize the whole parsed data
          // blob so we count *something* proportional to the part's
          // size. Better an over-count than a silent zero.
          try {
            content = JSON.stringify(data);
          } catch {
            content = '';
          }
        }
        if (content.length > 0) {
          unclassifiedCount += enc.encode(content).length;
        }
      }
    }

    return { systemPrompt, history, toolOutput, unclassifiedCount };
  }
}

/* ------------------------------------------------------------------ *
 * AttributionEngine
 *
 * Per-session 5-bucket attribution composer. Wires the SQLite Reader,
 * Subagent Aggregator, and Tokenizer Splitter together and produces
 * one SessionAttribution per root session: authoritative buckets
 * straight from opencode + the recursive subagent rollup, uncached
 * sub-buckets from the Flow 2 proportional split, cost.total from
 * session.cost, and findings flowing through from the aggregator plus
 * the Engine's own per-session findings.
 *
 * Per design.md:617-624 the published signature is
 * `attributeSession(session, parts, subagentBucket)`. We adopt the
 * simpler one-arg variant the task brief sanctions: the Engine
 * already has the reader + aggregator + tokenizer in its constructor,
 * so re-asking the caller to materialize parts / messages / the
 * subagent rollup is just busywork. The reader's iteration methods
 * are lazy (StatementIterator), so the Engine itself controls when
 * to spend the I/O. See task 3.3 brief lines on signature deviation
 * for the rationale.
 *
 * Flow 2 proportional math (design.md:574-586; tasks.md:240-245):
 *
 *   T_input = session.tokens_input
 *   P_sys   = Tokenizer.classifyAndCount(parts, messages).systemPrompt
 *   P_hist  = Tokenizer.classifyAndCount(parts, messages).history
 *   P_tool  = Tokenizer.classifyAndCount(parts, messages).toolOutput
 *   P_sum   = P_sys + P_hist + P_tool
 *
 *   bucket_sys  = round(T_input * P_sys  / P_sum)
 *   bucket_hist = round(T_input * P_hist / P_sum)
 *   bucket_tool = T_input - bucket_sys - bucket_hist   // last-bucket
 *                                                      // absorbs
 *                                                      // rounding
 *
 *   INVARIANT: bucket_sys + bucket_hist + bucket_tool == T_input
 *
 * When P_sum is 0 (all parts skipped or unclassified — degenerate
 * case where the Tokenizer can't see any classifiable content) we
 * can't divide and we don't try to: all three uncached sub-buckets
 * collapse to 0 and an `unclassifiable_input` finding fires. This
 * intentionally violates the INVARIANT in the sum-correctness sense
 * (0+0+0 != T_input), but the finding makes the gap visible and the
 * Reporter (4.2) is responsible for showing T_input as
 * "unattributed" in that case. The INVARIANT exit-5 enforcement
 * below treats this branch as a special case: the violation is
 * expected when the finding fired, so we do NOT throw.
 *
 * Findings emitted per session (design.md:591-603; tasks.md:246-250):
 *
 *   - per_bucket_cost_deferred — ALWAYS emitted, every session.
 *     Operator-facing reminder that the per-bucket cost.* fields are
 *     null and that a follow-on spec is the trigger to populate them.
 *   - unclassifiable_input — emitted when P_sum == 0.
 *   - schema_partial_data — emitted when
 *     provenance.unclassifiedCount > 0, naming the count. The task
 *     brief notes the part.type-name list is acceptable as a
 *     placeholder for v1 since the Tokenizer's ProvenanceCounts
 *     intentionally doesn't expose type names; the count alone is
 *     sufficient signal.
 *   - findings forwarded from SubagentAggregator.rollup() (cycle
 *     detection, parent_id fallback, etc.) flow through verbatim.
 *
 * NOT emitted by the Engine: `caching_not_enabled`. That's a
 * report-level (global) finding emitted by 4.2 when the sum of
 * tokens_cache_read across every in-scope session is 0.
 *
 * State: nothing cached across attributeSession() calls. Each call
 * builds its own visited set / findings array / messages Map. The
 * Tokenizer's encoder is cached for the lifetime of the
 * TokenizerSplitter instance (its own contract), but that's
 * orthogonal — the encoder is stateless w.r.t. attribution.
 * ------------------------------------------------------------------ */

class AttributionEngine {
  constructor(reader, aggregator, tokenizer) {
    this._reader = reader;
    this._aggregator = aggregator;
    this._tokenizer = tokenizer;
  }

  /**
   * Compute the SessionAttribution for one root session.
   *
   * @param {object} session a session row from SqliteReader (any
   *   shape that has the documented column names).
   * @returns {{
   *   sessionId: string,
   *   directory: string,
   *   agent: string|null,
   *   model: string|null,
   *   timeCreated: number,
   *   timeUpdated: number,
   *   tokens: {
   *     cachedRead: number, cachedWrite: number,
   *     uncachedSystemPrompt: number, history: number,
   *     toolOutputs: number, output: number, reasoning: number,
   *     subagentDispatch: number,
   *   },
   *   cost: {
   *     total: number,
   *     cachedRead: null, cachedWrite: null, uncachedInput: null,
   *     output: null, reasoning: null, subagentDispatch: null,
   *   },
   *   findings: Array<{ kind: string, detail: string }>,
   * }}
   */
  attributeSession(session) {
    const findings = [];

    // ── Subagent rollup ──────────────────────────────────────────
    // Aggregator returns {totals, findings}; the totals' tokensTotal
    // plugs straight into the subagentDispatch bucket and the
    // findings (cycle / fallback) flow through verbatim.
    const rollup = this._aggregator.rollup(session.id);
    const subagentDispatch = rollup.totals.tokensTotal || 0;
    for (const f of rollup.findings) {
      findings.push(f);
    }

    // ── Tokenizer proportional split ─────────────────────────────
    // Materialize parts + the role-keyed messages map. The reader's
    // iteration methods return lazy iterables; we drain them into
    // arrays / a Map because the Tokenizer needs a finite parts
    // walk AND the part→message lookup requires random access. For
    // typical session sizes (tens to low-hundreds of parts) this
    // is negligible; large-session memory pressure is a known
    // accepted cost documented in design.md performance notes.
    const parts = [];
    for (const p of this._reader.partsOfSession(session.id)) {
      parts.push(p);
    }
    const messages = new Map();
    for (const m of this._reader.messagesOfSession(session.id)) {
      messages.set(m.id, m);
    }
    const provenance = this._tokenizer.classifyAndCount(parts, messages);
    const P_sys = provenance.systemPrompt;
    const P_hist = provenance.history;
    const P_tool = provenance.toolOutput;
    const P_sum = P_sys + P_hist + P_tool;
    const T_input = session.tokens_input || 0;

    let uncachedSystemPrompt;
    let history;
    let toolOutputs;
    let unclassifiableFired = false;
    if (P_sum === 0) {
      // Degenerate path: nothing classifiable. The proportional
      // split is undefined; collapse all three sub-buckets to 0 and
      // emit unclassifiable_input. The Reporter shows T_input as
      // unattributed; per design.md:602-603 this is a finding, not
      // an error.
      uncachedSystemPrompt = 0;
      history = 0;
      toolOutputs = 0;
      findings.push({
        kind: 'unclassifiable_input',
        detail:
          `session ${session.id}: no classifiable parts available ` +
          `(systemPrompt+history+toolOutput == 0); ${T_input} ` +
          `tokens_input left unattributed across the three ` +
          `proportional sub-buckets`,
      });
      unclassifiableFired = true;
    } else {
      uncachedSystemPrompt = Math.round((T_input * P_sys) / P_sum);
      history = Math.round((T_input * P_hist) / P_sum);
      // Last bucket absorbs all rounding error so the integer sum
      // is exact. This is what makes the INVARIANT below trivially
      // true on the happy path.
      toolOutputs = T_input - uncachedSystemPrompt - history;
    }

    // ── Schema_partial_data for unclassified part.type values ───
    // Tokenizer's ProvenanceCounts intentionally exposes only the
    // count (not the type names) to keep the surface narrow. We
    // surface the count here so 3.3's observable contract is met;
    // a follow-up could extend ProvenanceCounts with a type-name
    // set if operator-facing diagnostics need more.
    if (provenance.unclassifiedCount > 0) {
      findings.push({
        kind: 'schema_partial_data',
        detail:
          `session ${session.id}: tokenizer reported ` +
          `${provenance.unclassifiedCount} tokens under unrecognized ` +
          `part.type values (count only; type names not surfaced ` +
          `in v1 Tokenizer ProvenanceCounts shape). These tokens ` +
          `are NOT folded into any attribution bucket; surface as ` +
          `a partial-data finding so the operator can update the ` +
          `Tokenizer classification rules or pin opencode back to ` +
          `the supported version range.`,
      });
    }

    // ── INVARIANT enforcement ────────────────────────────────────
    // Sum-correctness guarantee (design.md:587-588). When the
    // proportional math ran, the last-bucket-absorbs-rounding
    // trick makes the sum exact by construction; if this ever
    // fails it's a math bug, not a data bug, and per the design's
    // Error Categories (exit code 5) the right move is to throw.
    // We skip the check when the unclassifiable_input branch fired
    // because 0+0+0 != T_input is the expected degenerate state.
    if (!unclassifiableFired) {
      const sum = uncachedSystemPrompt + history + toolOutputs;
      if (sum !== T_input) {
        throw new Error(
          `AttributionEngine INVARIANT violated for session ` +
            `${session.id}: uncachedSystemPrompt(${uncachedSystemPrompt}) + ` +
            `history(${history}) + toolOutputs(${toolOutputs}) = ${sum}, ` +
            `expected T_input=${T_input}. This is a programming error in ` +
            `the proportional split (Flow 2 math); exit code 5 per design ` +
            `Error Categories.`,
        );
      }
    }

    // ── per_bucket_cost_deferred (always emitted) ───────────────
    // Design.md:639-655 + tasks.md:246-247: every session carries
    // this finding so the operator never wonders why cost.cachedRead
    // / cost.history / etc. are null. The text references the
    // follow-on spec hook so an operator with the report in front
    // of them can pick up the trail without consulting design.md.
    findings.push({
      kind: 'per_bucket_cost_deferred',
      detail:
        `session ${session.id}: cost.total = ${session.cost || 0} is ` +
        `populated from opencode's authoritative session.cost; ` +
        `per-bucket cost fields (cachedRead/cachedWrite/uncachedInput/` +
        `output/reasoning/subagentDispatch) require recomputing from ` +
        `token counts × model pricing and are deferred to a follow-on ` +
        `spec. Set to null in v1; shape preserved for forward-compat.`,
    });

    return {
      sessionId: session.id,
      directory: session.directory,
      agent: session.agent == null ? null : session.agent,
      model: session.model == null ? null : session.model,
      timeCreated: session.time_created,
      timeUpdated: session.time_updated,
      tokens: {
        cachedRead: session.tokens_cache_read || 0,
        cachedWrite: session.tokens_cache_write || 0,
        uncachedSystemPrompt,
        history,
        toolOutputs,
        output: session.tokens_output || 0,
        reasoning: session.tokens_reasoning || 0,
        subagentDispatch,
      },
      cost: {
        total: session.cost || 0,
        cachedRead: null,
        cachedWrite: null,
        uncachedInput: null,
        output: null,
        reasoning: null,
        subagentDispatch: null,
      },
      findings,
    };
  }
}

/* ------------------------------------------------------------------ *
 * FileWriter
 *
 * Persists rendered Markdown + JSON report payloads to disk. Default
 * destination is
 * `${XDG_STATE_HOME ?? "$HOME/.local/state"}/opencode-cost-diagnosis/reports/<iso8601>.{md,json}`
 * with file mode 0600 (R4.AC4) and XDG-scoped placement (R4.AC5).
 * After each successful default-path write, the writer prunes the
 * reports/ directory back to the last 10 files per extension, sorted
 * by mtime descending. Mirrors `scripts/memory-sync.nix:437-449`'s
 * last-N retention contract (the task brief cites lines 467-489;
 * that range is the print_operator_summary helper that immediately
 * follows prune_logs in the same file — the prune_logs function
 * proper lives at 437-449. Behavioural parity holds either way).
 *
 * The `--output <path>` override (consumed by the CLI in task 5.1,
 * accepted here as `outputOverride`) flips the writer into
 * single-file mode: exactly one file is written at the operator's
 * named path, the format is inferred from the path's extension
 * (.md → markdown only, .json → JSON only, anything else throws),
 * and pruning is skipped entirely. The default reports/ dir is not
 * created.
 *
 * I/O error handling (R6.AC5): non-ENOENT errno on write surfaces
 * as a thrown Error carrying `.path`, `.operation`, and the
 * underlying `.code` so the CLI Entry (task 5.3) can map to exit
 * code 4 and assemble the stderr trailer from named fields rather
 * than parsing the message text. ENOENT-on-write is impossible by
 * construction here — we mkdir the parent recursively right before
 * opening — so it is not specially handled.
 *
 * Mode-0600 guarantee: process.umask(0o077) is set BEFORE any
 * fs.writeFileSync call and the prior umask is restored in a
 * finally block so a thrown write doesn't leak the diagnostic's
 * umask into the rest of the CLI's lifetime. fs.writeFileSync
 * defaults `mode` to 0o666, which the active umask masks down to
 * 0o600 — same trick memory-sync.nix and other ops-grade scripts
 * in this repo use.
 *
 * Implementation notes for the cycle-of-construction:
 *
 *   - The constructor accepts a `stateDir` override so unit tests
 *     never pollute the operator's real $XDG_STATE_HOME. When
 *     `stateDir` is absent, the writer consults `XDG_STATE_HOME`
 *     and falls back to `${HOME}/.local/state` per the XDG basedir
 *     spec — same default chain `scripts/memory-sync.nix` uses.
 *   - `retentionCount` is exposed for the same reason: the
 *     integration tests in 6.2 can pick a small cap to exercise
 *     pruning without seeding 10+ files. Default is 10 (R4.AC5 +
 *     memory-sync parity).
 *   - File names use a filename-safe ISO 8601 form (`:` → `-`) so
 *     macOS HFS+, FAT-derived filesystems, and Windows tooling
 *     don't choke. The replacement is global (`replace(/:/g, '-')`)
 *     because Date.toISOString() emits two colons per timestamp
 *     (`HH:MM:SS`).
 *
 * Currently unused by main(); wired in by task 5.3.
 * ------------------------------------------------------------------ */

class FileWriterError extends Error {
  constructor(message, { path: failedPath, operation, code, cause }) {
    super(message);
    this.name = 'FileWriterError';
    this.path = failedPath;
    this.operation = operation;
    // Preserve the underlying errno so the CLI can distinguish
    // EACCES from ENOSPC etc. in the stderr trailer (R6.AC5).
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

class FileWriter {
  /**
   * @param {{
   *   stateDir?: string,           // overrides XDG_STATE_HOME for tests
   *   outputOverride?: string,     // single-file mode; skip pruning
   *   retentionCount?: number,     // default 10 per extension
   * }} [options]
   */
  constructor(options) {
    const opts = options || {};
    this._stateDirOverride = opts.stateDir || null;
    this._outputOverride = opts.outputOverride || null;
    // Guard against absurd or invalid retention values. Negative
    // or non-integer caps would either delete every report on the
    // first run (cap=0) or throw mid-prune; reject up front so the
    // error surfaces in the constructor, not in a later write.
    if (opts.retentionCount !== undefined) {
      if (
        !Number.isInteger(opts.retentionCount) ||
        opts.retentionCount < 1
      ) {
        throw new Error(
          `FileWriter: retentionCount must be a positive integer; got ${opts.retentionCount}`,
        );
      }
      this._retentionCount = opts.retentionCount;
    } else {
      this._retentionCount = 10;
    }
  }

  /**
   * Resolve the effective state dir. Order of precedence:
   *   1. Constructor `stateDir` option (tests use this).
   *   2. `XDG_STATE_HOME` env var.
   *   3. `${HOME}/.local/state` (XDG basedir default).
   */
  _resolveStateDir() {
    if (this._stateDirOverride) return this._stateDirOverride;
    if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
    return path.join(os.homedir(), '.local', 'state');
  }

  /**
   * Filename-safe ISO 8601 for the given Date. Date.toISOString()
   * produces e.g. `2026-05-17T14:30:22.123Z`; we globally replace
   * `:` with `-` so the result is safe on every filesystem we
   * support.
   */
  _filenameStem(date) {
    return date.toISOString().replace(/:/g, '-');
  }

  /**
   * Write Markdown + JSON to disk. Returns the paths written.
   * Either field of the return may be `null` when the override
   * causes us to write only one of the two formats.
   *
   * @param {{ markdown: string, json: string, generatedAt: Date }} payload
   * @returns {{ mdPath: string|null, jsonPath: string|null }}
   */
  write(payload) {
    if (this._outputOverride) {
      return this._writeOverride(payload);
    }
    return this._writeDefault(payload);
  }

  // ── Default path ─────────────────────────────────────────────
  // XDG-scoped layout + last-N prune. Always writes BOTH formats.
  _writeDefault(payload) {
    const stateDir = this._resolveStateDir();
    const reportsDir = path.join(stateDir, 'opencode-cost-diagnosis', 'reports');
    // recursive: true is the simplest way to satisfy "create
    // parent dirs"; mkdirSync swallows EEXIST when recursive is
    // set, so re-runs against an existing reports/ dir are
    // idempotent.
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
    } catch (e) {
      throw new FileWriterError(
        `FileWriter: failed to create reports directory at ${reportsDir}: ${e.message}`,
        { path: reportsDir, operation: 'mkdir', code: e.code, cause: e },
      );
    }

    const stem = this._filenameStem(payload.generatedAt);
    const mdPath = path.join(reportsDir, `${stem}.md`);
    const jsonPath = path.join(reportsDir, `${stem}.json`);

    this._withUmask(0o077, () => {
      this._safeWrite(mdPath, payload.markdown);
      this._safeWrite(jsonPath, payload.json);
    });

    this._prune(reportsDir);

    return { mdPath, jsonPath };
  }

  // ── Override path ────────────────────────────────────────────
  // Single named file, format inferred from extension, no
  // pruning. The override path's parent dir is created
  // recursively so an operator can hand us a fresh `/tmp/foo.json`
  // without pre-`mkdir -p`'ing the dir themselves.
  _writeOverride(payload) {
    const override = this._outputOverride;
    const ext = path.extname(override).toLowerCase();
    if (ext !== '.md' && ext !== '.json') {
      throw new Error(
        `FileWriter: unsupported --output extension "${ext || '<none>'}" ` +
          `for path ${override}; supported extensions are .md and .json`,
      );
    }

    const parent = path.dirname(override);
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch (e) {
      throw new FileWriterError(
        `FileWriter: failed to create override parent directory at ${parent}: ${e.message}`,
        { path: parent, operation: 'mkdir', code: e.code, cause: e },
      );
    }

    let mdPath = null;
    let jsonPath = null;
    this._withUmask(0o077, () => {
      if (ext === '.md') {
        this._safeWrite(override, payload.markdown);
        mdPath = override;
      } else {
        this._safeWrite(override, payload.json);
        jsonPath = override;
      }
    });
    // No prune under override per task brief / design lines 256-257.
    return { mdPath, jsonPath };
  }

  // ── umask scope guard ────────────────────────────────────────
  // process.umask is global to the process; we set it to 0o077
  // before opening any report file (so writeFileSync's default
  // 0o666 mode masks down to 0o600) and restore the prior value
  // in a finally block so a thrown write doesn't leave the
  // operator's umask altered for the rest of the CLI's lifetime.
  _withUmask(mask, fn) {
    const prior = process.umask(mask);
    try {
      fn();
    } finally {
      process.umask(prior);
    }
  }

  // ── Safe write ───────────────────────────────────────────────
  // Wraps fs.writeFileSync to convert any errno on write into a
  // FileWriterError carrying .path + .operation so the CLI can
  // map to exit code 4 (R6.AC5). ENOENT on write is impossible
  // by construction (mkdir-recursive ran first) so it is not
  // specially distinguished; the spec only requires non-ENOENT
  // to propagate, which is the default behaviour here.
  _safeWrite(p, content) {
    try {
      fs.writeFileSync(p, content);
    } catch (e) {
      throw new FileWriterError(
        `FileWriter: failed to write ${p}: ${e.message}`,
        { path: p, operation: 'write', code: e.code, cause: e },
      );
    }
  }

  // ── Pruner ───────────────────────────────────────────────────
  // Per-extension last-N retention. Reads the directory, splits
  // by extension, sorts by mtime descending, keeps the first
  // `retentionCount`, unlinks the tail. Per-extension so 12 .md
  // files don't trigger pruning of 5 .json files (or vice versa)
  // and so a future third extension could be added without
  // re-architecting.
  _prune(reportsDir) {
    let entries;
    try {
      entries = fs.readdirSync(reportsDir, { withFileTypes: true });
    } catch (e) {
      throw new FileWriterError(
        `FileWriter: failed to enumerate reports dir for prune at ${reportsDir}: ${e.message}`,
        { path: reportsDir, operation: 'readdir', code: e.code, cause: e },
      );
    }

    const byExt = { '.md': [], '.json': [] };
    for (const ent of entries) {
      // Only prune flat files (no recursion into subdirs) and
      // only files with the two managed extensions. Anything
      // else — operator notes, stray editor swap files, a
      // hypothetical future telemetry artefact — survives.
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!(ext in byExt)) continue;
      const full = path.join(reportsDir, ent.name);
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (e) {
        // A file that vanished between readdir and stat (race)
        // is treated as already-pruned; ENOENT is the only
        // benign errno here and the spec explicitly allows
        // ignoring it. Anything else is a real I/O fault.
        if (e.code === 'ENOENT') continue;
        throw new FileWriterError(
          `FileWriter: failed to stat ${full} during prune: ${e.message}`,
          { path: full, operation: 'stat', code: e.code, cause: e },
        );
      }
      byExt[ext].push({ full, mtimeMs });
    }

    for (const ext of Object.keys(byExt)) {
      const list = byExt[ext];
      if (list.length <= this._retentionCount) continue;
      list.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      const toDelete = list.slice(this._retentionCount);
      for (const { full } of toDelete) {
        try {
          fs.unlinkSync(full);
        } catch (e) {
          // ENOENT during unlink mirrors the stat race above —
          // benign, skip. Everything else propagates as a typed
          // I/O fault.
          if (e.code === 'ENOENT') continue;
          throw new FileWriterError(
            `FileWriter: failed to unlink ${full} during prune: ${e.message}`,
            { path: full, operation: 'unlink', code: e.code, cause: e },
          );
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * ReportAssembler
 *
 * Composes the post-AttributionEngine pipeline state into a single
 * DiagnosticReport (design.md:870-879, post-Iteration 2.5). Given
 * `SessionAttribution[]` from the 3.3 Attribution Engine, it:
 *
 *   1. Groups by `directory` to produce `byProject`
 *      (`Record<string, ProjectAggregate>`).
 *   2. Computes `globalTotals.tokens` as the per-bucket sum across
 *      every session.
 *   3. Computes `globalTotals.cost.total` as the per-session sum of
 *      `cost.total` (per-bucket cost fields stay `null` per the
 *      `per_bucket_cost_deferred` decision — both at the global
 *      level and the per-project level, so the v1 JSON shape is
 *      forward-compatible with the follow-on per-bucket cost
 *      recompute spec).
 *   4. Builds the structured `TokenizerDisclaimer` once per report
 *      run (design.md:912-921).
 *   5. Applies privacy filtering (R4.AC1, R4.AC2, R4.AC3). On the
 *      default path this is satisfied by-construction: the
 *      AttributionEngine's `SessionAttribution` shape (design.md:
 *      617-624) doesn't carry message bodies / tool-output content
 *      / prompt content, so there's nothing for the assembler to
 *      strip. When `includeContent: true` AND the caller supplies a
 *      `contentLoader: (sessionId) => ({ messages, parts })`
 *      callback (R4.AC3), the assembler invokes the loader once per
 *      session and attaches the returned content as `session.content`
 *      on a shallow copy of the SessionAttribution. The CLI Entry
 *      (task 5.3) wires the loader using the SqliteReader's
 *      messagesOfSession / partsOfSession methods. Calling with
 *      `includeContent: true` but no `contentLoader` is a programming
 *      error and throws (exit code 5 per design Error Categories).
 *   6. Emits global findings:
 *        - `caching_not_enabled` (R2.AC7) when at least one session
 *          is in scope and the sum of `tokens.cachedRead` across
 *          every in-scope session is 0;
 *        - every per-session finding flowed through, tagged with the
 *          source `sessionId` so the operator can trace it back from
 *          the global array.
 *
 * Empty-DB shape (R2.AC8): `assemble([])` produces a valid report
 * with `sessionCount: 0`, empty `sessions` / `byProject`, zero
 * `globalTotals`, the disclaimer object present, and NO
 * `caching_not_enabled` finding (vacuous emission would be noise —
 * R2.AC7 presupposes at least one session).
 *
 * State: the assembler holds no mutable state; `assemble()` is pure
 * w.r.t. its input (modulo the disclaimer's `humanReadable` string,
 * which interpolates `supportedOpencodeVersionRange` when supplied).
 *
 * Out of scope (task 4.3): Markdown / JSON serialization. This
 * class only assembles the structured object.
 * ------------------------------------------------------------------ */

const TOKENIZER_AFFECTED_BUCKETS = Object.freeze([
  'uncachedSystemPrompt',
  'history',
  'toolOutputs',
]);

const TOKENIZER_AUTHORITATIVE_BUCKETS = Object.freeze([
  'cachedRead',
  'cachedWrite',
  'output',
  'reasoning',
  'subagentDispatch',
]);

const BUCKET_TOTAL_KEYS = Object.freeze([
  'cachedRead',
  'cachedWrite',
  'uncachedSystemPrompt',
  'history',
  'toolOutputs',
  'output',
  'reasoning',
  'subagentDispatch',
]);

// v1's per-bucket cost keys — the original six fields, kept as a
// private constant so the v1 `makeZeroCostBuckets` helper below
// continues to produce the exact v1 cost shape (six null fields
// plus `total`). Touching this array changes every v1 caller's
// emitted JSON / Markdown, so the v1 byte-identical integration
// golden depends on this list staying frozen at six entries until
// task 5.x replaces the v1 cost-shape callers with the v2 path.
//
// New code should reference `PER_BUCKET_COST_KEYS` below, NOT this
// private list.
const V1_PER_BUCKET_COST_KEYS = Object.freeze([
  'cachedRead',
  'cachedWrite',
  'uncachedInput',
  'output',
  'reasoning',
  'subagentDispatch',
]);

// v2's extended per-bucket cost keys: the six v1 fields verbatim
// followed by the three new v2 uncached sub-bucket fields
// (design.md:599-611). The trailing three entries sit alongside
// the v1 `uncachedInput` total — `uncachedInput` itself remains
// in the shape and equals `uncachedSystemPrompt + history +
// toolOutputs` within rounding when pricing is matched.
//
// This is the canonical exported per-bucket cost key list and is
// what every v2 task downstream (3.1 / 4.x / 5.x) reads.
const PER_BUCKET_COST_KEYS = Object.freeze([
  ...V1_PER_BUCKET_COST_KEYS,
  // v2 additions
  'uncachedSystemPrompt',
  'history',
  'toolOutputs',
]);

// The six named cachedRead sub-buckets that decompose
// `session.tokens_cache_read` (design.md:612-619). All five named
// content-shape sub-buckets plus the `unclassifiedCached` residual
// that absorbs proportional-split rounding. Used both by the
// classifier (task 3.1) and the drift fallback shape below.
const CACHED_READ_SUB_BUCKET_KEYS = Object.freeze([
  'systemPromptCached',
  'agentsMdCached',
  'mcpToolSchemasCached',
  'accumulatedHistoryCached',
  'accumulatedToolOutputsCached',
  'unclassifiedCached',
]);

// Cost-reconciliation tolerance: a per-session sum invariant fires
// `cost_invariant_violation` when the bucket-sum diverges from
// `session.cost` by MORE than `max(COST_INVARIANT_TOLERANCE_PCT,
// COST_INVARIANT_TOLERANCE_FLOOR_USD)`. Tighter than the brief's
// 0.5% because models.dev is the same catalog opencode uses
// internally — see design.md:654.
const COST_INVARIANT_TOLERANCE_PCT = 0.001; // 0.1%
const COST_INVARIANT_TOLERANCE_FLOOR_USD = 0.01;

// Subagent residual labels and below-threshold fold thresholds
// (design.md:529, 564, requirements 5.4 / 6.5). Both labels are
// quoted with parens to make them unmistakable in the rendered
// reports — no real agent or tool name starts with `(`.
const SUBAGENT_NULL_AGENT_LABEL = '(unattributed-no-agent-column)';
const SUBAGENT_BELOW_THRESHOLD_LABEL = '(below-threshold-fold)';
const SUBAGENT_BELOW_THRESHOLD_PCT = 0.01; // 1% of descendant count
const SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR = 1; // never less than 1

// Tool residual label. Lives in a separate namespace from the
// subagent residual (per-tool maps, not per-agent maps), so the
// shared `(below-threshold-fold)` wording is appropriate — the
// surrounding context disambiguates.
const TOOL_BELOW_THRESHOLD_LABEL = '(below-threshold-fold)';
const TOOL_BELOW_THRESHOLD_PCT = 0.01; // 1% of total tool output tokens

// Classifier marker sentinels for the cachedRead sub-buckets.
//
// Task 1.1 (Decision 6 gate, see research.md:835-1086) found that
// all three "literal marker" sub-buckets — systemPrompt, AGENTS.md,
// MCP schemas — are constructed per-turn at request time and never
// persisted into the opencode `parts` table. They are marked
// `marker-unreliable` and the constants are set to a recognized
// sentinel value. TokenizerSplitter (task 3.1) treats any
// occurrence of `MARKER_UNRELIABLE_SENTINEL` as a degraded marker
// and unconditionally sets `markersDegraded: true` on its
// TokenizerProvenance output, which triggers the proportional-from
// uncached degraded path in AttributionEngine (design.md:583,
// Decision 6 fallback).
//
// The other two sub-buckets — accumulatedHistory and
// accumulatedToolOutputs — are `inferred-marker`: classified by
// `message.role` / `part.type` shape rather than by a literal
// substring. They use a distinct `MARKER_BY_STRUCTURE` sentinel so
// the classifier can branch on shape rather than on a string
// search. The sentinel is structurally distinguishable from the
// unreliable sentinel even though both are `null`-shaped values:
// the classifier code reads the constant by name, not by value, so
// a future change in the underlying sentinel representation is
// localised here.
const MARKER_UNRELIABLE_SENTINEL = null;
const MARKER_BY_STRUCTURE = Object.freeze({ kind: 'by-structure' });

const SYSTEM_PROMPT_MARKER = MARKER_UNRELIABLE_SENTINEL;
const AGENTS_MD_MARKER = MARKER_UNRELIABLE_SENTINEL;
const MCP_TOOL_SCHEMAS_MARKER = MARKER_UNRELIABLE_SENTINEL;
const ACCUMULATED_HISTORY_MARKER = MARKER_BY_STRUCTURE;
const ACCUMULATED_TOOL_OUTPUTS_MARKER = MARKER_BY_STRUCTURE;

function makeZeroBucketTotals() {
  const out = {};
  for (const k of BUCKET_TOTAL_KEYS) out[k] = 0;
  return out;
}

function makeZeroCostBuckets() {
  // `total` is the only field that ever holds a non-null value in
  // v1; every per-bucket field is `null` by Iteration 2.5 decision.
  //
  // PRESERVED FOR v1 CALLERS. Iterates over the private
  // `V1_PER_BUCKET_COST_KEYS` list so v1's emitted shape is
  // unaffected by the v2 extension on `PER_BUCKET_COST_KEYS`.
  // v2's drift fallback uses `makeNullCostShape()` below, which
  // produces the extended shape with the same null discipline.
  const out = { total: 0 };
  for (const k of V1_PER_BUCKET_COST_KEYS) out[k] = null;
  return out;
}

/**
 * v2 drift-fallback cost shape factory (design.md:581-583, 648).
 *
 * Returns a fresh CostBuckets object where every cost-bearing
 * field is `null`:
 *   - the six v1 per-bucket fields (cachedRead, cachedWrite,
 *     uncachedInput, output, reasoning, subagentDispatch)
 *   - the three v2 uncached sub-bucket fields
 *     (uncachedSystemPrompt, history, toolOutputs)
 *   - every key in cachedReadBreakdown
 *   - the entire subagentDispatchByAgent map (null, not {})
 *   - the entire toolOutputsByTool map (null, not {})
 *
 * `total` is the sole non-null field; it carries `session.cost`
 * because that value's authoritative source is independent of
 * pricing drift. The caller passes it as the optional argument.
 *
 * Used by AttributionEngine on `pricing_table_drift` (task 5.6)
 * and by ReportAssembler tests that need a known-shape fixture.
 *
 * @param {number} [sessionCost=0] — value to assign to `.total`.
 * @returns {object} the v2 all-null CostBuckets shape.
 */
function makeNullCostShape(sessionCost = 0) {
  const out = { total: sessionCost };
  for (const k of PER_BUCKET_COST_KEYS) out[k] = null;
  out.cachedReadBreakdown = {};
  for (const k of CACHED_READ_SUB_BUCKET_KEYS) {
    out.cachedReadBreakdown[k] = null;
  }
  out.subagentDispatchByAgent = null;
  out.toolOutputsByTool = null;
  return out;
}

class ReportAssembler {
  /**
   * Build a DiagnosticReport from the AttributionEngine's per-session
   * output.
   *
   * @param {Array<object>} sessionAttributions
   *   Each entry: a SessionAttribution per design.md:617-624.
   *   Specifically required fields read here: `sessionId`,
   *   `directory`, `tokens` (BucketTotals), `cost.total`,
   *   `findings`.
   * @param {{
   *   includeContent?: boolean,
   *   contentLoader?: (sessionId: string) => { messages: any[], parts: any[] },
   *   generatedAt?: Date,
   *   supportedOpencodeVersionRange?: string,
   * }} [options]
   *   When `includeContent: true`, the assembler invokes
   *   `contentLoader(sessionId)` once per session and attaches the
   *   returned `{ messages, parts }` as `session.content` on a
   *   shallow copy of each session attribution. If `includeContent`
   *   is true but `contentLoader` is absent or not a function, the
   *   assembler throws (programming error per design Error
   *   Categories; the CLI Entry should never reach this branch).
   *   `generatedAt` and `supportedOpencodeVersionRange` are accepted
   *   for forward-compat with the CLI Entry (task 5.3) — they are
   *   not consumed by the v1 assembler beyond being interpolated
   *   into the disclaimer's `humanReadable` string when supplied.
   *   The disclaimer is generated deterministically regardless;
   *   `generatedAt` does NOT appear in the JSON-serialised report
   *   (R6.AC3 byte-identical guarantee — the MD serializer
   *   surfaces it in the header but JSON does not).
   * @returns {object} DiagnosticReport per design.md:870-879
   */
  assemble(sessionAttributions, options) {
    const attrs = Array.isArray(sessionAttributions)
      ? sessionAttributions
      : [];
    const opts = options || {};

    const findings = [];

    // ── Sessions array and sessionCount ─────────────────────────
    // Privacy default-exclude (R4.AC1, R4.AC2) is satisfied
    // by-construction on the default path: SessionAttribution shape
    // doesn't carry body strings (only ids, directories, timestamps,
    // token counts, and findings). So we pass attrs through verbatim
    // unless `--include-content` is set.
    //
    // R4.AC3 (task 4.3): when `includeContent: true` AND the caller
    // supplies a `contentLoader: (sessionId) => ({ messages, parts })`
    // callback, attach the loaded content as `session.content` on a
    // SHALLOW COPY of each session attribution. The shallow copy is
    // load-bearing: the assembler must not mutate the caller's
    // SessionAttribution objects (those are owned by the
    // AttributionEngine output and may be re-used elsewhere). The
    // CLI Entry (task 5.3) is the only caller that supplies the
    // loader; it wires the loader against the SqliteReader.
    //
    // When `includeContent: true` but no loader is supplied, this
    // is a programming error — the CLI Entry forgot to wire the
    // loader. Per design.md Error Categories this should be exit
    // code 5 (programming/assertion); we throw a typed Error so
    // the CLI Entry's top-level try/catch can map it. The error
    // message names the missing argument so the operator/CLI
    // author can diagnose without a stack-trace dive.
    const includeContent = !!opts.includeContent;
    const contentLoader = opts.contentLoader || null;
    if (includeContent && typeof contentLoader !== 'function') {
      throw new Error(
        `ReportAssembler.assemble: --include-content was set but no ` +
          `contentLoader callback was provided. The CLI Entry (task 5.3) ` +
          `must pass options.contentLoader = (sessionId) => ({ messages, ` +
          `parts }) when --include-content is requested; the loader is ` +
          `wired against the SqliteReader's messagesOfSession / ` +
          `partsOfSession methods. Without it, the assembler cannot ` +
          `embed content into the DiagnosticReport.`,
      );
    }
    const sessions = attrs.map((a) => {
      if (!includeContent) return a;
      // Shallow copy so the caller's SessionAttribution stays
      // pristine. Content is the only field added; everything else
      // is preserved verbatim.
      const content = contentLoader(a.sessionId);
      return { ...a, content };
    });

    // ── globalTotals.tokens ─────────────────────────────────────
    const globalTokens = makeZeroBucketTotals();
    let cachedReadSum = 0;
    for (const a of attrs) {
      for (const k of BUCKET_TOTAL_KEYS) {
        // Defensive zero-coalesce: a malformed SessionAttribution
        // (e.g. one that came from a path that didn't write every
        // bucket) shouldn't propagate NaN into the global sum.
        // The AttributionEngine's v1 contract is to always emit
        // all 8 fields, so this is belt-and-suspenders.
        globalTokens[k] += a.tokens && a.tokens[k] ? a.tokens[k] : 0;
      }
      cachedReadSum += a.tokens && a.tokens.cachedRead ? a.tokens.cachedRead : 0;
    }

    // ── globalTotals.cost ───────────────────────────────────────
    const globalCost = makeZeroCostBuckets();
    for (const a of attrs) {
      // Per-session cost.total is opencode's authoritative
      // session.cost; sum directly. Per-bucket cost fields stay
      // null (forward-compat with per_bucket_cost_deferred spec).
      globalCost.total += (a.cost && typeof a.cost.total === 'number')
        ? a.cost.total
        : 0;
    }

    // ── byProject (group by directory) ──────────────────────────
    // Use a plain object so the JSON serialisation in 4.3 lands a
    // stable shape. Within each project: a fresh BucketTotals + a
    // fresh CostBuckets so cross-project aggregates never share a
    // reference (a follow-on spec that mutates the aggregate
    // in-place wouldn't accidentally write through to a sibling).
    const byProject = {};
    for (const a of attrs) {
      const dir = a.directory || '';
      let agg = byProject[dir];
      if (!agg) {
        agg = {
          directory: dir,
          sessionCount: 0,
          tokens: makeZeroBucketTotals(),
          cost: makeZeroCostBuckets(),
        };
        byProject[dir] = agg;
      }
      agg.sessionCount += 1;
      for (const k of BUCKET_TOTAL_KEYS) {
        agg.tokens[k] += a.tokens && a.tokens[k] ? a.tokens[k] : 0;
      }
      agg.cost.total += (a.cost && typeof a.cost.total === 'number')
        ? a.cost.total
        : 0;
    }

    // ── Per-session findings → global findings ─────────────────
    // Tag each forwarded finding with sessionId so the global
    // findings array remains traceable even when a per-session
    // finding's `detail` string doesn't already name the session.
    // (The AttributionEngine emits detail strings that DO include
    // the session id, but the assembler can't rely on that for
    // findings emitted by some hypothetical future producer; an
    // explicit field is cheaper than parsing.)
    for (const a of attrs) {
      const sesId = a.sessionId;
      if (!Array.isArray(a.findings)) continue;
      for (const f of a.findings) {
        findings.push({
          kind: f.kind,
          detail: f.detail,
          sessionId: sesId,
        });
      }
    }

    // ── Global caching_not_enabled (R2.AC7) ────────────────────
    // Emit when at least one session is in scope AND every
    // in-scope session has cachedRead == 0. The zero-session case
    // (empty DB / no matches) suppresses the finding because the
    // requirement presupposes at least one session was observed.
    if (attrs.length > 0 && cachedReadSum === 0) {
      findings.push({
        kind: 'caching_not_enabled',
        detail:
          `Anthropic prompt-caching is not being exercised by opencode: ` +
          `sum(tokens.cachedRead) across ${attrs.length} in-scope ` +
          `session(s) is 0. Enable caching for non-trivial workloads to ` +
          `reduce per-turn input-token costs. R2.AC7 surfaces this as a ` +
          `notable finding, not an error — the report itself is valid.`,
      });
    }

    // ── TokenizerDisclaimer ─────────────────────────────────────
    // Built unconditionally — present on every report, including
    // the empty-DB case. R2.AC9 demands the disclaimer whenever
    // the report's attribution includes the three uncached
    // sub-buckets; v1 always includes them structurally (even when
    // zero), and a future spec change that introduces conditional
    // sub-bucket reporting in the empty case would otherwise lose
    // the disclaimer. Defaulting to always-present is the safer
    // contract for downstream consumers.
    const versionRange =
      typeof opts.supportedOpencodeVersionRange === 'string'
        ? opts.supportedOpencodeVersionRange
        : null;
    const tokenizer_disclaimer = {
      library: 'tiktoken',
      encoding: 'cl100k_base',
      accuracyClass: 'relative-only',
      affectedBuckets: TOKENIZER_AFFECTED_BUCKETS.slice(),
      authoritativeBuckets: TOKENIZER_AUTHORITATIVE_BUCKETS.slice(),
      sumCorrectnessGuarantee:
        'Uncached sub-buckets sum exactly to opencode.session.tokens_input',
      humanReadable:
        `Bucket totals for ${TOKENIZER_AFFECTED_BUCKETS.join(', ')} are ` +
        `tiktoken (cl100k_base) estimates derived from a proportional ` +
        `split of opencode's authoritative session.tokens_input; they ` +
        `are relative-only and suitable for ranking cost drivers, but ` +
        `are NOT billing-grade absolute counts. The three buckets ` +
        `nevertheless sum exactly to opencode's stored tokens_input ` +
        `value (last bucket absorbs rounding). Authoritative buckets ` +
        `(${TOKENIZER_AUTHORITATIVE_BUCKETS.join(', ')}) are read ` +
        `directly from opencode and require no estimation` +
        (versionRange
          ? `. Supported opencode version range: ${versionRange}.`
          : `.`),
    };

    return {
      schemaVersion: 1,
      reportType: 'opencode-cost-diagnosis',
      tokenizer_disclaimer,
      globalTotals: { tokens: globalTokens, cost: globalCost },
      sessionCount: attrs.length,
      byProject,
      sessions,
      findings,
    };
  }
}

/* ------------------------------------------------------------------ *
 * ReportSerializer
 *
 * Renders a DiagnosticReport (the output of ReportAssembler.assemble)
 * into the two human + machine surface formats: Markdown and JSON.
 *
 *   - formatJson(report) → string. Stable key order at every object
 *     level (custom replacer sorts keys alphabetically). No
 *     wall-clock fields anywhere in the output (R6.AC3 byte-identical
 *     guarantee — two successive calls on the same report produce
 *     the same string).
 *   - formatMarkdown(report, { generatedAt }) → string. Headline
 *     disclaimer block FIRST, then global totals, then per-project
 *     breakdown, then per-session detail tables, then findings.
 *     `generatedAt` is rendered inside the header (optional;
 *     omitted entirely when not supplied so the default Markdown is
 *     deterministic across runs the same way the JSON is).
 *
 * Stable-key-order implementation note: the replacer returns a new
 * object whose `Object.keys()` order is alphabetical. JSON.stringify
 * iterates the returned object's enumeration order (insertion
 * order), so the output respects the sort. The replacer recurses
 * into nested objects automatically because JSON.stringify calls
 * the replacer for every key it visits in the returned object;
 * arrays are left alone so element order is preserved (the
 * disclaimer's `affectedBuckets` / `authoritativeBuckets` sequence
 * is meaningful and must not be re-sorted).
 *
 * IEEE 754 cost note: the assembler's `globalTotals.cost.total`
 * for the fixture comes out as `0.15000000000000002` from
 * `0 + 0.05 + 0.05 + 0.05` — a fully deterministic IEEE 754 quirk.
 * `JSON.stringify(0.15000000000000002)` emits exactly that string
 * on every Node release we care about, so the byte-identical
 * guarantee holds without canonicalization. Canonicalization
 * would mechanically defeat the guarantee by introducing
 * arbitrary precision choices (e.g. rounding to 2 dp); we
 * deliberately do NOT canonicalize and let JSON.stringify's
 * deterministic float-to-string path do the work.
 * ------------------------------------------------------------------ */

// Top-level Markdown headings. Centralised so the section-ordering
// contract from the task brief (disclaimer → global → per-project →
// per-session → findings) is one-line-auditable.
const MD_SECTION_GLOBAL = '## Global Totals';
const MD_SECTION_PROJECT = '## Per-Project Breakdown';
const MD_SECTION_SESSION = '## Per-Session Detail';
const MD_SECTION_FINDINGS = '## Findings';

class ReportSerializer {
  /**
   * Serialize the given DiagnosticReport as JSON with stable key
   * order at every object level. Returns a multi-line string with
   * 2-space indent for readability; arrays preserve their input
   * order (only object keys are sorted). No wall-clock fields are
   * injected — the output is byte-identical across successive
   * calls on the same report.
   *
   * @param {object} report DiagnosticReport from
   *   ReportAssembler.assemble
   * @returns {string} JSON text, terminated with a single trailing
   *   newline so downstream `cat` / `diff` operations match operator
   *   expectations.
   */
  formatJson(report) {
    const body = JSON.stringify(
      report,
      (_key, val) => {
        // Sort keys of plain objects; leave arrays and primitives
        // untouched. Sorting array elements would corrupt the
        // disclaimer's affectedBuckets sequence and the sessions
        // / findings arrays' caller-defined ordering.
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          const sorted = {};
          for (const k of Object.keys(val).sort()) {
            sorted[k] = val[k];
          }
          return sorted;
        }
        return val;
      },
      2,
    );
    // Trailing newline — POSIX text-file convention; makes the
    // output diff cleanly against itself and against
    // operator-edited fixtures.
    return `${body}\n`;
  }

  /**
   * Render the given DiagnosticReport as Markdown. The output
   * begins with the headline tokenizer disclaimer block (first
   * line references "tiktoken"), then the optional
   * report-generation timestamp (only when `options.generatedAt`
   * is a Date), then global totals, then per-project breakdown,
   * then per-session detail, then findings.
   *
   * @param {object} report DiagnosticReport from
   *   ReportAssembler.assemble
   * @param {{ generatedAt?: Date }} [options]
   * @returns {string} Markdown text, terminated with a single
   *   trailing newline.
   */
  formatMarkdown(report, options) {
    const opts = options || {};
    const lines = [];

    // ── Headline disclaimer block ────────────────────────────────
    // First line MUST reference "tiktoken" — operator-facing
    // recognisability + a binding observable in the task brief.
    // The bolded label is the first line; the rest of the
    // disclaimer follows immediately.
    const d = report.tokenizer_disclaimer || {};
    lines.push(
      `**TOKENIZER ACCURACY DISCLAIMER (${d.library || 'tiktoken'} / ${d.encoding || 'cl100k_base'})**`,
    );
    lines.push('');
    if (typeof d.humanReadable === 'string' && d.humanReadable.length > 0) {
      lines.push(d.humanReadable);
      lines.push('');
    }
    // Surface the structured fields by name so the operator can
    // identify affected buckets without dropping into the JSON.
    if (Array.isArray(d.affectedBuckets)) {
      lines.push(
        `- Affected buckets (tokenizer-derived, relative-only): ${d.affectedBuckets.join(', ')}`,
      );
    }
    if (Array.isArray(d.authoritativeBuckets)) {
      lines.push(
        `- Authoritative buckets (read directly from opencode): ${d.authoritativeBuckets.join(', ')}`,
      );
    }
    if (typeof d.accuracyClass === 'string') {
      lines.push(`- Accuracy class: ${d.accuracyClass}`);
    }
    if (typeof d.sumCorrectnessGuarantee === 'string') {
      lines.push(`- Sum-correctness guarantee: ${d.sumCorrectnessGuarantee}`);
    }
    lines.push('');

    // ── Optional generation timestamp (MD only — R6.AC3) ────────
    if (opts.generatedAt instanceof Date) {
      // Italic + "Report generated:" label. Deliberately NOT
      // "Generated:" at start of line — the absence-mode test
      // asserts no line begins with that literal so we keep the
      // label format distinct.
      lines.push(`_Report generated: ${opts.generatedAt.toISOString()}_`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');

    // ── Global totals ────────────────────────────────────────────
    lines.push(MD_SECTION_GLOBAL);
    lines.push('');
    lines.push(`- Sessions: ${report.sessionCount}`);
    const gtCost = (report.globalTotals && report.globalTotals.cost) || {};
    if (typeof gtCost.total === 'number') {
      // Raw float — see IEEE 754 note in the class header. No
      // canonicalization; we trust JSON.stringify's
      // float-to-string path, and toString matches it for the
      // values we'll ever see here.
      lines.push(`- Cost total: ${gtCost.total}`);
    }
    lines.push('');
    lines.push(...renderBucketTable((report.globalTotals && report.globalTotals.tokens) || {}));
    lines.push('');

    // ── Per-project breakdown ────────────────────────────────────
    lines.push(MD_SECTION_PROJECT);
    lines.push('');
    const projectDirs = Object.keys(report.byProject || {}).sort();
    if (projectDirs.length === 0) {
      lines.push('_No projects in scope._');
      lines.push('');
    } else {
      for (const dir of projectDirs) {
        const agg = report.byProject[dir];
        lines.push(`### ${dir}`);
        lines.push('');
        lines.push(`- Sessions: ${agg.sessionCount}`);
        if (agg.cost && typeof agg.cost.total === 'number') {
          lines.push(`- Cost: ${agg.cost.total}`);
        }
        lines.push('');
        lines.push(...renderBucketTable(agg.tokens || {}));
        lines.push('');
      }
    }

    // ── Per-session detail ───────────────────────────────────────
    lines.push(MD_SECTION_SESSION);
    lines.push('');
    const sessions = Array.isArray(report.sessions) ? report.sessions : [];
    if (sessions.length === 0) {
      lines.push('_No sessions in scope._');
      lines.push('');
    } else {
      for (const s of sessions) {
        lines.push(`### ${s.sessionId}`);
        lines.push('');
        if (s.directory) lines.push(`- Directory: ${s.directory}`);
        if (s.agent) lines.push(`- Agent: ${s.agent}`);
        if (s.model) lines.push(`- Model: ${s.model}`);
        if (typeof s.timeCreated === 'number') {
          lines.push(`- Time created: ${s.timeCreated}`);
        }
        if (typeof s.timeUpdated === 'number') {
          lines.push(`- Time updated: ${s.timeUpdated}`);
        }
        if (s.cost && typeof s.cost.total === 'number') {
          lines.push(`- Cost: ${s.cost.total}`);
        }
        lines.push('');
        lines.push(...renderBucketTable(s.tokens || {}));
        lines.push('');
        // When --include-content was set, the assembler attached
        // a `content` field. Surface its bare shape (counts) so the
        // operator knows content was included without dumping
        // every message body inline — full inspection is via the
        // JSON output.
        if (s.content) {
          const mc = Array.isArray(s.content.messages)
            ? s.content.messages.length
            : 0;
          const pc = Array.isArray(s.content.parts) ? s.content.parts.length : 0;
          lines.push(`- Content: ${mc} message(s), ${pc} part(s) (full bodies in JSON)`);
          lines.push('');
        }
      }
    }

    // ── Findings ─────────────────────────────────────────────────
    lines.push(MD_SECTION_FINDINGS);
    lines.push('');
    const findings = Array.isArray(report.findings) ? report.findings : [];
    if (findings.length === 0) {
      lines.push('_No findings._');
      lines.push('');
    } else {
      for (const f of findings) {
        const sesTag = f.sessionId ? ` (session ${f.sessionId})` : '';
        lines.push(`- **${f.kind}**${sesTag}: ${f.detail}`);
      }
      lines.push('');
    }

    // Join with newlines, single trailing newline.
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }
}

// Bucket order matches BUCKET_TOTAL_KEYS so the table reads
// consistently with the rest of the diagnostic. Module-scope so
// every per-project / per-session table renders identically.
function renderBucketTable(tokens) {
  const rows = ['| Bucket | Tokens |', '| --- | ---: |'];
  for (const k of BUCKET_TOTAL_KEYS) {
    const v = typeof tokens[k] === 'number' ? tokens[k] : 0;
    rows.push(`| ${k} | ${v} |`);
  }
  return rows;
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Argument Parser (task 5.1)
 *
 * Hand-rolled flag parser — no commander/yargs (project convention
 * forbids; design.md Tech Stack table line 190 calls this out
 * explicitly: "Small flag surface (`--last`, `--session`, `--cwd`,
 * `--include-content`, `--format`, `--output`, `--help`); avoids
 * `commander`/`yargs` bloat"). The parser is pure: it returns a
 * structured action descriptor, throws `ArgumentError` on bad input,
 * and never touches process.{stdout,stderr,exit}. The CLI Entry
 * (task 5.3) is responsible for printing usage on error and mapping
 * the throw to exit 1.
 *
 * Result shape:
 *   {
 *     action: 'report' | 'help' | 'supported-opencode-version',
 *     selectors: { timeRangeStart?, timeRangeEnd?, sessionId?, cwdPattern? },
 *     includeContent: boolean,
 *     format: 'md' | 'json' | 'both',     // default 'both'
 *     outputOverride: string | null,
 *   }
 *
 * `--last <duration>` parsing mirrors `parse_since` from
 * scripts/memory-sync.nix: single-unit only (`<N><unit>`, unit ∈
 * {h, d, w}). Multi-unit forms like `7d6h` are rejected loudly
 * rather than silently parsing the prefix — operators would
 * otherwise believe a longer/shorter window was applied. N must
 * be a positive integer; `0d`, `-1d`, `1.5d`, `30` (no unit), `d`
 * (no count), and unsupported units (`1y`, `1m`) all throw.
 *
 * Requirements covered: R3.AC1 (--last), R3.AC2 (--session),
 * R3.AC3 (--cwd), R3.AC5 (bad-arg actionable error), R4.AC3
 * (--include-content), R5.AC1 (--supported-opencode-version
 * surfaces the pinned range + migration set).
 * ------------------------------------------------------------------ */

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentError';
  }
}

// Single-unit `<N><unit>` regex. N is a positive integer (no
// leading sign, no decimal, no leading zero beyond the canonical
// `0` — which we reject below as zero-window). The whole-string
// anchors are deliberate so `7d6h` does not partial-match `7d`.
const TIME_RANGE_RE = /^(\d+)([hdw])$/;

const TIME_RANGE_UNIT_MS = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const VALID_FORMATS = ['md', 'json', 'both'];

function parseTimeRangeDuration(value) {
  // Reject empty/undefined up front with a clear shape error
  // (R3.AC5: name the offending value — empty string gets quoted
  // so the operator sees the truthy fact that it was empty).
  if (value == null || value === '') {
    throw new ArgumentError(
      "--last: missing or empty duration value. Expected '<N><unit>' where unit ∈ {h, d, w} (e.g. '1h', '7d', '2w').",
    );
  }
  const m = TIME_RANGE_RE.exec(value);
  if (!m) {
    throw new ArgumentError(
      `--last: cannot parse duration '${value}'. Expected single-unit '<N><unit>' where N is a positive integer and unit ∈ {h, d, w} (e.g. '1h', '24h', '7d', '30d', '2w'). Multi-unit forms like '7d6h' are not supported.`,
    );
  }
  const n = Number.parseInt(m[1], 10);
  // Zero-window is an operator error: either they meant some
  // positive amount or they didn't mean to pass --last at all.
  // Surfacing it loudly is friendlier than returning an empty
  // report.
  if (n <= 0) {
    throw new ArgumentError(
      `--last: duration '${value}' has non-positive count. Expected N ≥ 1.`,
    );
  }
  return n * TIME_RANGE_UNIT_MS[m[2]];
}

// Flags that consume the next argv token as their value. Centralised
// so the missing-value check below has a single source of truth.
const VALUE_FLAGS = new Set(['--last', '--session', '--cwd', '--format', '--output']);

// Flags that are bare booleans (no value). Includes the short-circuit
// action flags (--help, -h, --supported-opencode-version) — those
// don't fit the "value" axis but they're parsed positionally before
// we ever consult VALUE_FLAGS for them.
const BOOLEAN_FLAGS = new Set([
  '--help',
  '-h',
  '--include-content',
  '--supported-opencode-version',
]);

class ArgumentParser {
  /**
   * Parse argv into a structured action descriptor.
   *
   * @param {string[]} argv  Raw argv after node + script-name have been
   *   sliced off (i.e. what the CLI Entry passes through from
   *   process.argv.slice(2)).
   * @param {{ now?: number }} [options]
   *   `now` is the wall-clock epoch ms used for --last math. Defaults
   *   to Date.now(). Injected primarily for deterministic unit tests;
   *   the CLI Entry does not pass it.
   * @returns {{
   *   action: 'report' | 'help' | 'supported-opencode-version',
   *   selectors: {
   *     timeRangeStart?: number,
   *     timeRangeEnd?: number,
   *     sessionId?: string,
   *     cwdPattern?: string,
   *   },
   *   includeContent: boolean,
   *   format: 'md' | 'json' | 'both',
   *   outputOverride: string | null,
   * }}
   * @throws {ArgumentError} on unknown flag, missing required value,
   *   unparseable --last duration, or unsupported --format value.
   *   Message always names the offending arg or value so the CLI
   *   Entry can echo it verbatim into the stderr usage trailer
   *   (R3.AC5).
   */
  parse(argv, options) {
    const opts = options || {};
    const now = typeof opts.now === 'number' ? opts.now : Date.now();

    // Short-circuit on --help / -h. Operators reach for help most
    // often when the rest of the line is wrong — burying the help
    // action behind validation of the broken remainder would be
    // hostile. Check before any other parsing.
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        return {
          action: 'help',
          selectors: {},
          includeContent: false,
          format: 'both',
          outputOverride: null,
        };
      }
    }

    // Same short-circuit logic for --supported-opencode-version: it
    // is a pure introspection command, no other flags should be
    // required to make it work.
    for (const a of argv) {
      if (a === '--supported-opencode-version') {
        return {
          action: 'supported-opencode-version',
          selectors: {},
          includeContent: false,
          format: 'both',
          outputOverride: null,
        };
      }
    }

    const result = {
      action: 'report',
      selectors: {},
      includeContent: false,
      format: 'both',
      outputOverride: null,
    };

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];

      // Consume value-taking flags first. The "missing value" check
      // covers both `--flag` at end-of-argv AND `--flag --next` (we
      // treat any value beginning with `--` as missing, since
      // accepting `--last --cwd` would silently set `timeRangeStart`
      // from the literal string `--cwd` and the operator would never
      // notice).
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1];
        if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
          throw new ArgumentError(
            `${arg}: missing required value. Expected ${arg} <value>; got ${value === undefined ? 'end of arguments' : `next flag '${value}'`}.`,
          );
        }
        i++; // consume the value
        switch (arg) {
          case '--last':
            result.selectors.timeRangeStart = now - parseTimeRangeDuration(value);
            break;
          case '--session':
            result.selectors.sessionId = value;
            break;
          case '--cwd':
            result.selectors.cwdPattern = value;
            break;
          case '--format':
            if (!VALID_FORMATS.includes(value)) {
              throw new ArgumentError(
                `--format: unsupported value '${value}'. Expected one of: ${VALID_FORMATS.join(', ')}.`,
              );
            }
            result.format = value;
            break;
          case '--output':
            result.outputOverride = value;
            break;
          default:
            // Unreachable: VALUE_FLAGS membership was checked above.
            throw new ArgumentError(`internal: unhandled value flag '${arg}'`);
        }
        continue;
      }

      // Bare boolean flags. --help / -h / --supported-opencode-version
      // already short-circuited above, so the only one that can land
      // here is --include-content.
      if (BOOLEAN_FLAGS.has(arg)) {
        if (arg === '--include-content') {
          result.includeContent = true;
        }
        // --help, -h, --supported-opencode-version: already handled
        // by the short-circuits above; we'd only reach here if those
        // were duplicated, in which case it's a no-op (caller's
        // intent was already captured by the first occurrence).
        continue;
      }

      // Anything else is either an unknown flag (`--bogus`, `-x`) or
      // a stray positional (`stray-arg`). The CLI takes no
      // positional arguments, so both shapes are R3.AC5 errors.
      // Both branches name the offending token verbatim so the
      // operator sees exactly what was rejected.
      throw new ArgumentError(
        `unknown argument '${arg}'. Run --help for the supported flag list.`,
      );
    }

    return result;
  }
}

/* ------------------------------------------------------------------ *
 * SessionSelector (task 5.2)
 *
 * Pure translator between the structured action descriptor that
 * ArgumentParser.parse() returns (task 5.1) and the SessionFilter
 * shape the SqliteReader.rootSessionsMatching(filter) method
 * consumes (task 2.2). The reader is the layer that turns the
 * filter into parameterised SQL — its WHERE-clause builder emits
 * one `<column> <op> ?` fragment per non-null filter field, joins
 * them with ` AND `, and passes the values through
 * better-sqlite3's parameter binding (`.iterate(...params)`). All
 * the R3.AC4 SQL-injection-safety + AND-combination work
 * therefore lives in 2.2; this Selector only has to map the
 * parser's nested `parsedArgs.selectors` object onto the reader's
 * flat filter object.
 *
 * Design rationale (design.md:396): the Selector is the "Build
 * SQL WHERE clauses from validated selectors" surface. We
 * implement it as a SHAPE-MAPPING layer rather than a SQL-EMITTING
 * layer because the reader already owns the WHERE-clause shape
 * (and parameter binding, and column-name knowledge). Splitting
 * the responsibility — Selector emits "filter shape", Reader emits
 * SQL — keeps the parser ignorant of the DB schema (so a column
 * rename in 2.2 doesn't cascade into 5.1) and keeps the reader
 * ignorant of the CLI's argv vocabulary (so adding a new flag in
 * 5.1 doesn't cascade into 2.2).
 *
 * Tightness invariant: the returned filter object MUST NOT carry
 * own-keys for selectors that aren't present on parsedArgs. The
 * reader's WHERE builder uses `f.X != null` to decide whether to
 * emit a clause, which is safe against undefined values (`undefined
 * != null` is false under loose-equality) — but emitting
 * present-but-undefined would leak a "this selector was set"
 * signal that callers might `'X' in filter`-test against. Tightness
 * keeps the interface honest.
 *
 * Purity: this is a static method with no instance state and no
 * mutation of the input parsedArgs. The CLI Entry (5.3) can call
 * it repeatedly against the same parsed object without observing
 * state leak.
 * ------------------------------------------------------------------ */

class SessionSelector {
  /**
   * Translate a parsed action descriptor into a SessionFilter
   * object suitable for SqliteReader.rootSessionsMatching(filter).
   *
   * @param {{
   *   selectors: {
   *     timeRangeStart?: number,
   *     timeRangeEnd?: number,
   *     sessionId?: string,
   *     cwdPattern?: string,
   *   },
   * }} parsedArgs The result of ArgumentParser.parse().
   * @returns {{
   *   timeRangeStart?: number,
   *   timeRangeEnd?: number,
   *   sessionId?: string,
   *   cwdPattern?: string,
   * }} Filter object; selectors absent from parsedArgs are absent
   *   from the returned object (NOT present-with-undefined). All
   *   values are forwarded verbatim — parameterisation +
   *   AND-combination happen inside the reader.
   */
  static fromParsedArgs(parsedArgs) {
    const filter = {};
    const sel = (parsedArgs && parsedArgs.selectors) || {};
    // Guard each field with hasOwnProperty so the tightness invariant
    // holds even if a caller hand-constructs a parsedArgs whose
    // selectors object explicitly sets a field to undefined. (The
    // ArgumentParser itself never does this; it only sets fields
    // when the flag was present. The hasOwnProperty check is the
    // belt to that suspenders so a future parser quirk can't leak
    // an undefined into the filter.)
    if (Object.prototype.hasOwnProperty.call(sel, 'timeRangeStart') &&
        sel.timeRangeStart !== undefined) {
      filter.timeRangeStart = sel.timeRangeStart;
    }
    if (Object.prototype.hasOwnProperty.call(sel, 'timeRangeEnd') &&
        sel.timeRangeEnd !== undefined) {
      filter.timeRangeEnd = sel.timeRangeEnd;
    }
    if (Object.prototype.hasOwnProperty.call(sel, 'sessionId') &&
        sel.sessionId !== undefined) {
      filter.sessionId = sel.sessionId;
    }
    if (Object.prototype.hasOwnProperty.call(sel, 'cwdPattern') &&
        sel.cwdPattern !== undefined) {
      filter.cwdPattern = sel.cwdPattern;
    }
    return filter;
  }
}

/* ------------------------------------------------------------------ *
 * CLI Entry (task 5.3)
 *
 * Process-entry orchestrator. Wires every component above into a
 * single end-to-end pipeline:
 *
 *   ArgumentParser → SqliteReader.open → SessionSelector →
 *   SubagentAggregator → TokenizerSplitter → AttributionEngine →
 *   ReportAssembler → ReportSerializer → FileWriter → operator
 *   summary on stdout
 *
 * Wrapped in a single top-level try/catch that maps caught errors
 * to exit codes per design.md:1025-1041 Error Categories table:
 *
 *   1 = bad CLI arg            (ArgumentError)
 *   2 = missing source DB      (ENOENT-shaped open failure)
 *   3 = schema drift           (SchemaDriftError)
 *   4 = I/O error              (FileWriterError, non-ENOENT)
 *   5 = programming/assertion  (anything else — INVARIANT throw,
 *                               TypeError, etc.)
 *
 * Recoverable conditions (per design.md:1035-1040) do NOT exit
 * non-zero: zero sessions in scope, caching not enabled, subagent
 * cycle detected, unknown part.type — all surface as findings in
 * the report and the run exits 0.
 *
 * Contract: main(argv) RETURNS a numeric exit code. It does NOT
 * call process.exit itself. The `require.main === module` block at
 * the bottom of this file is the only place that translates the
 * return value into a process exit. This is what makes the CLI
 * unit-testable: tests can call main(argv) and read the exit code
 * without forking, while still observing the side effects (stdout
 * summary, files on disk).
 *
 * Testability hooks:
 *
 *   - `OPENCODE_DB_PATH`  overrides default DB resolution. The
 *     unit tests in tests/opencode-cost-diagnosis/unit/cli-entry.test.js
 *     point this at the pinned fixture under
 *     tests/opencode-cost-diagnosis/fixtures/opencode-stable.db.
 *   - `XDG_STATE_HOME`    redirects FileWriter's default output
 *     dir. Tests use a mkdtemp'd state dir so they never write
 *     into the operator's real $HOME/.local/state.
 *
 * The smoke-test derivation (task 6.3) consumes the
 * `--supported-opencode-version` short-circuit action; it must
 * remain a pure introspection command that does NOT open the
 * source DB (so the smoke test can verify the diagnostic is on
 * PATH without requiring the DB to exist).
 * ------------------------------------------------------------------ */

const USAGE = [
  'opencode-cost-report — per-component cost-attribution report for opencode sessions',
  '',
  'USAGE:',
  '  opencode-cost-report [options]',
  '',
  'OPTIONS:',
  '  --last <duration>             Restrict to sessions whose time_created falls within the',
  '                                last <duration>. Single-unit form only: <N><unit> where',
  '                                unit ∈ {h, d, w} (e.g. 1h, 24h, 7d, 30d, 2w). Multi-unit',
  '                                forms like 7d6h are rejected. (R3.AC1)',
  '  --session <id>                Restrict to a single root session by exact id. (R3.AC2)',
  '  --cwd <pattern>               Restrict to sessions whose directory matches <pattern>.',
  '                                v1: exact match. (R3.AC3)',
  '  --include-content             Embed message bodies + tool output in the report. Default',
  '                                is OFF (privacy-by-default per R4.AC1/AC2).',
  '  --format <md|json|both>       Pick which report format to write. Default: both.',
  '  --output <path>               Single-file mode: write exactly one report at <path>.',
  '                                Format inferred from extension (.md or .json). Skips the',
  '                                default XDG reports/ dir and the last-N prune.',
  '  --supported-opencode-version  Print this build\'s supported opencode version range and',
  '                                pinned migration set, then exit 0. (R5.AC1)',
  '  --help, -h                    Print this usage block and exit 0.',
  '',
  'ENVIRONMENT:',
  '  OPENCODE_DB_PATH              Override the default DB path resolution. When unset,',
  '                                defaults to ${XDG_DATA_HOME:-$HOME/.local/share}/',
  '                                opencode/opencode-stable.db.',
  '  XDG_STATE_HOME                Controls where default-path reports are written. When',
  '                                unset, defaults to $HOME/.local/state.',
  '',
  'EXIT CODES:',
  '  0  Success (including empty-but-valid reports when no sessions are in scope).',
  '  1  Bad CLI argument.',
  '  2  Source opencode DB not found at the expected path.',
  '  3  Schema drift — opencode\'s data_migration set does not match this build\'s pin.',
  '  4  I/O error reading or writing report files.',
  '  5  Programming error or assertion failure (file a bug).',
  '',
].join('\n');

function resolveOpencodeDbPath() {
  // OPENCODE_DB_PATH wins so unit tests (and any operator who has
  // moved the DB) can override without re-deriving XDG.
  if (process.env.OPENCODE_DB_PATH) return process.env.OPENCODE_DB_PATH;
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'opencode', 'opencode-stable.db');
}

function printHelp() {
  process.stdout.write(USAGE);
}

function printSupportedVersion() {
  // Plain-text "key: value" block so an operator can read it
  // without a JSON parser and so the 6.3 smoke test can grep
  // either line. Multi-line so the migration set has room to
  // grow without overflowing a terminal.
  const lines = [
    `Supported opencode version range: ${SUPPORTED_VERSION_RANGE}`,
    `Pinned data_migration set: ${[...SUPPORTED_MIGRATION_SET].join(', ')}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

function printOperatorSummary({ sessionCount, mdPath, jsonPath }) {
  // Mirrors memory-sync's print_operator_summary shape: header
  // line + key/value detail lines. Both file paths surface
  // verbatim so the operator can `cat` or `open` directly from
  // the terminal without re-deriving the XDG path. When a path
  // is null (override mode wrote only one format) we surface
  // "(not written)" so the operator knows the slot is intentional,
  // not a bug.
  const lines = [
    'opencode-cost-report: report written',
    `  sessions in scope: ${sessionCount}`,
    `  markdown: ${mdPath !== null && mdPath !== undefined ? mdPath : '(not written)'}`,
    `  json:     ${jsonPath !== null && jsonPath !== undefined ? jsonPath : '(not written)'}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

function mapErrorToExitCode(err) {
  // Order matters: ArgumentError and SchemaDriftError are the two
  // typed errors we recognise unambiguously. FileWriterError is
  // also typed but ENOENT shape on a *read* (Reader.open) takes
  // precedence over the FileWriterError check (which only fires on
  // write paths anyway). The default branch — exit 5 — is for
  // programming errors (INVARIANT throws, TypeErrors, etc.) which
  // are not the operator's fault and should be filed as bugs.
  if (err instanceof ArgumentError) return 1;
  if (err instanceof SchemaDriftError) return 3;
  if (err instanceof FileWriterError) return 4;
  // Missing-DB shape: SqliteReader.open wraps better-sqlite3's
  // SqliteError ENOENT (or any open failure) into an Error
  // carrying `.dbPath` and the original cause. We use the
  // presence of `.dbPath` as the signal — it's an own-property
  // set explicitly in open()'s catch — rather than checking err.code
  // directly, because better-sqlite3 emits 'SQLITE_CANTOPEN' rather
  // than 'ENOENT' for missing files even though the design's
  // Error Categories table says "ENOENT on Reader.open".
  if (err && typeof err === 'object' && typeof err.dbPath === 'string') {
    return 2;
  }
  return 5;
}

function writeStderrTrailer(err, exitCode) {
  // One-line `[<code>] <action>: <message>` trailer. The action
  // label is operator-facing and stable across runs so wrapping
  // scripts can grep on it. The message is whatever the error
  // surfaced — the inner classes have already shaped it to be
  // actionable, so we don't trim or re-format here.
  let action;
  switch (exitCode) {
    case 1:
      action = 'bad argument';
      break;
    case 2:
      action = 'missing opencode database';
      break;
    case 3:
      action = 'schema drift';
      break;
    case 4:
      action = 'I/O error';
      break;
    case 5:
    default:
      action = 'internal error';
      break;
  }
  const msg = err && err.message ? err.message : String(err);
  // First line: short, greppable trailer. Subsequent lines: full
  // error message so the operator gets the recovery hint that the
  // typed errors above already carry without us re-stitching it
  // into a single very-long line.
  process.stderr.write(`[${exitCode}] ${action}: ${msg.split('\n', 1)[0]}\n`);
  if (msg.includes('\n')) {
    // Surface the rest of the message verbatim so SchemaDriftError's
    // multi-line recovery hint (and FileWriterError's path/operation
    // detail when richer) reaches the operator.
    const tail = msg.slice(msg.indexOf('\n') + 1);
    if (tail.length > 0) {
      process.stderr.write(`${tail}\n`);
    }
  }
}

function main(argv) {
  let exitCode = 0;
  let reader = null;
  try {
    const parsed = new ArgumentParser().parse(argv);

    if (parsed.action === 'help') {
      printHelp();
      return 0;
    }
    if (parsed.action === 'supported-opencode-version') {
      printSupportedVersion();
      return 0;
    }
    // parsed.action === 'report'

    // ── Open the source DB ──────────────────────────────────────
    // resolveOpencodeDbPath consults OPENCODE_DB_PATH first, then
    // falls back to ${XDG_DATA_HOME:-$HOME/.local/share}/opencode/
    // opencode-stable.db per design.md path conventions.
    const dbPath = resolveOpencodeDbPath();
    reader = new SqliteReader();
    reader.open(dbPath);

    // ── Build the selector + iterate root sessions ──────────────
    const filter = SessionSelector.fromParsedArgs(parsed);

    // ── Wire the per-run components ─────────────────────────────
    // Each component holds no cross-session state so a single
    // instance per run is correct; the AttributionEngine
    // consumes the reader + aggregator + tokenizer in its
    // attributeSession() per-call path.
    const aggregator = new SubagentAggregator(reader);
    const tokenizer = new TokenizerSplitter();
    const engine = new AttributionEngine(reader, aggregator, tokenizer);

    const attributions = [];
    for (const session of reader.rootSessionsMatching(filter)) {
      attributions.push(engine.attributeSession(session));
    }

    // ── Assemble + serialize the report ─────────────────────────
    // generatedAt is captured once and reused for both the
    // assembler's disclaimer interpolation AND the FileWriter's
    // filename stem so the operator sees one consistent timestamp.
    // The JSON serializer ignores it (R6.AC3 byte-identical
    // guarantee); the MD serializer surfaces it in the header.
    const generatedAt = new Date();
    const assembler = new ReportAssembler();
    const contentLoader = parsed.includeContent
      ? (sessionId) => ({
          messages: [...reader.messagesOfSession(sessionId)],
          parts: [...reader.partsOfSession(sessionId)],
        })
      : null;
    const report = assembler.assemble(attributions, {
      includeContent: parsed.includeContent,
      contentLoader,
      generatedAt,
      supportedOpencodeVersionRange: SUPPORTED_VERSION_RANGE,
    });
    const serializer = new ReportSerializer();
    const markdown = serializer.formatMarkdown(report, { generatedAt });
    const json = serializer.formatJson(report);

    // ── Write to disk ───────────────────────────────────────────
    // outputOverride flips the writer into single-file mode and
    // skips the last-N prune; default-path mode writes both
    // formats under $XDG_STATE_HOME/opencode-cost-diagnosis/reports.
    const writer = new FileWriter({
      outputOverride: parsed.outputOverride,
    });
    const { mdPath, jsonPath } = writer.write({
      markdown,
      json,
      generatedAt,
    });

    // ── Operator summary ────────────────────────────────────────
    printOperatorSummary({
      sessionCount: report.sessionCount,
      mdPath,
      jsonPath,
    });

    return 0;
  } catch (err) {
    exitCode = mapErrorToExitCode(err);
    writeStderrTrailer(err, exitCode);
    return exitCode;
  } finally {
    // close() is safe before open() and idempotent across multiple
    // calls (see SqliteReader.close), so we don't need to track
    // whether open() succeeded. The only way reader stays null is
    // if we exited via the help / supported-opencode-version
    // short-circuits, in which case there's nothing to close.
    if (reader !== null) {
      try {
        reader.close();
      } catch {
        // Best-effort: a close() failure during error cleanup
        // shouldn't mask the original error in the trailer above.
      }
    }
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  SqliteReader,
  SchemaDriftError,
  SubagentAggregator,
  TokenizerSplitter,
  AttributionEngine,
  FileWriter,
  FileWriterError,
  ReportAssembler,
  ReportSerializer,
  ArgumentParser,
  ArgumentError,
  SessionSelector,
  SUPPORTED_VERSION_RANGE,
  SUPPORTED_MIGRATION_SET,
  main,
  // v2 additions (task 1.5): constants + drift fallback helper.
  // Exposed for unit-test reach; production wiring lands in
  // tasks 2.x / 3.x / 4.x / 5.x.
  PER_BUCKET_COST_KEYS,
  CACHED_READ_SUB_BUCKET_KEYS,
  COST_INVARIANT_TOLERANCE_PCT,
  COST_INVARIANT_TOLERANCE_FLOOR_USD,
  SUBAGENT_NULL_AGENT_LABEL,
  SUBAGENT_BELOW_THRESHOLD_LABEL,
  SUBAGENT_BELOW_THRESHOLD_PCT,
  SUBAGENT_BELOW_THRESHOLD_CHILD_FLOOR,
  TOOL_BELOW_THRESHOLD_LABEL,
  TOOL_BELOW_THRESHOLD_PCT,
  MARKER_UNRELIABLE_SENTINEL,
  MARKER_BY_STRUCTURE,
  SYSTEM_PROMPT_MARKER,
  AGENTS_MD_MARKER,
  MCP_TOOL_SCHEMAS_MARKER,
  ACCUMULATED_HISTORY_MARKER,
  ACCUMULATED_TOOL_OUTPUTS_MARKER,
  makeNullCostShape,
};
