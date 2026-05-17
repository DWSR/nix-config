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
const SUPPORTED_VERSION_RANGE = '>=0.18.0 <0.30.0';

// Pinned set of `data_migration.name` rows the reader expects to see.
// design.md:539 records this as the v1 baseline, verified live on
// 2026-05-16. Object.freeze prevents accidental mutation from any
// downstream caller that imports the constant.
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
   * @param {string} sessionId
   * @returns {Iterable<object>} part rows
   */
  partsOfSession(sessionId) {
    this._ensureOpen('partsOfSession');
    return this._db
      .prepare(
        'SELECT * FROM part WHERE session_id = ? ' +
          'ORDER BY time_created ASC, id ASC',
      )
      .iterate(sessionId);
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
 * CLI stub (preserved verbatim from task 1.3)
 *
 * The real CLI surface (--last, --session, --cwd, --include-content,
 * --format, --output) is implemented by tasks 5.x. This stub keeps
 * the contract from 1.3: --help / -h prints usage and exits 0;
 * anything else prints usage to stderr and exits 1.
 * ------------------------------------------------------------------ */

const usage = [
  'opencode-cost-report — per-component cost-attribution report for opencode sessions',
  '',
  'USAGE:',
  '  opencode-cost-report --help',
  '',
  'STATUS:',
  '  Stub (Task 1.3 of the opencode-cost-diagnosis spec). The full CLI',
  '  surface — --last, --session, --cwd, --include-content, --format,',
  '  --output — is implemented by tasks 2.x-5.x of the same spec.',
  '',
].join('\n');

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    process.exit(0);
  }
  process.stderr.write(usage);
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  SqliteReader,
  SchemaDriftError,
  SubagentAggregator,
  TokenizerSplitter,
  AttributionEngine,
  SUPPORTED_VERSION_RANGE,
  SUPPORTED_MIGRATION_SET,
  main,
};
