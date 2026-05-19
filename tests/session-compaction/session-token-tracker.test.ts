/*
 * session-token-tracker.test.ts — unit tests for the
 * SessionTokenTracker seam (task 2.1 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Unit Tests #5:
 *   - dedupe by messageID (repeat updates replace the snapshot
 *     without double-counting toward turnCount)
 *   - aggregation across multiple messages
 *   - wall-time advances correctly after resetStartedAt
 *
 * Plus the wider invariants the tracker exports: tokenless
 * (UserMessage) updates are no-ops, unknown-sessionID calls are
 * no-ops, and the read accessors return 0 for unknown sessions.
 *
 * Requirements covered: 2.1.
 *
 * Runner: `node --test` via the `opencode-cost-diagnosis-node`
 * wrapper. Node 22's `--experimental-strip-types` lets us import
 * the .ts source module directly.
 *
 * Important — shared module state. The plugin's tracker is keyed
 * by sessionID inside a module-scoped Map and is NOT reset
 * between tests. Every test below MUST use a unique sessionID
 * (via `freshID`) to avoid cross-test pollution.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import {
  initializeSession,
  recordMessage,
  resetStartedAt,
  totalInputTokens,
  turnCount,
  wallTimeMillis,
  type MessageInfo,
} from "../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/**
 * Generate a unique sessionID for a test. The plugin's tracker
 * state is module-scoped (Map<sessionID, SessionState>) and not
 * reset between tests, so each test must use a unique key to
 * avoid contaminating its neighbours.
 */
function freshID(name: string): string {
  return `ses_4_2_${name}_${Math.random().toString(36).slice(2)}`
}

/**
 * Construct an AssistantMessage-shaped `MessageInfo`. The
 * `tokens` field present here is what makes `recordMessage`
 * advance turnCount; a UserMessage variant omits it entirely
 * (see `userMessage`).
 */
function assistantMessage(
  id: string,
  sessionID: string,
  input: number,
  cacheRead: number,
  opts: { output?: number; reasoning?: number; cacheWrite?: number } = {},
): MessageInfo {
  return {
    id,
    sessionID,
    role: "assistant",
    tokens: {
      input,
      output: opts.output ?? 0,
      reasoning: opts.reasoning ?? 0,
      cache: {
        read: cacheRead,
        write: opts.cacheWrite ?? 0,
      },
    },
  }
}

/**
 * UserMessage-shaped `MessageInfo` — no `tokens` field. The
 * tracker treats this as a no-op per the documented contract:
 * only AssistantMessages advance turnCount.
 */
function userMessage(id: string, sessionID: string): MessageInfo {
  return {
    id,
    sessionID,
    role: "user",
  }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("initializeSession", () => {
  it("creates state with zero turns, zero tokens, non-negative wall-time", () => {
    const id = freshID("init_basic")
    initializeSession(id, null, null, Date.now() - 1000)

    assert.equal(turnCount(id), 0)
    assert.equal(totalInputTokens(id), 0)
    // wallTimeMillis = Date.now() - startedAt; with startedAt
    // 1s in the past it must be >= 0 (likely ~1000 but timing-
    // sensitive, so only the sign is asserted).
    assert.ok(
      wallTimeMillis(id) >= 0,
      `wallTimeMillis must be non-negative; got ${wallTimeMillis(id)}`,
    )
  })

  it("is idempotent: a second call does not clobber in-flight aggregates", () => {
    // Documented invariant: if state for the sessionID already
    // exists, `initializeSession` is a no-op. Verify by feeding
    // a message between two init calls and asserting the
    // tokens / turnCount survive the second init.
    const id = freshID("init_idempotent")
    initializeSession(id, null, null, 1_000_000)
    recordMessage(id, assistantMessage("m1", id, 100, 200))
    assert.equal(turnCount(id), 1)
    assert.equal(totalInputTokens(id), 300)

    // Second init with a different startedAt — must be ignored.
    initializeSession(id, "parent", "subagent", 9_999_999)
    assert.equal(turnCount(id), 1)
    assert.equal(totalInputTokens(id), 300)
  })
})

describe("recordMessage — AssistantMessage path", () => {
  it("stores tokens for a single message (turnCount=1, total=input+cacheRead)", () => {
    const id = freshID("record_single")
    initializeSession(id, null, null, 1_000_000)
    recordMessage(
      id,
      assistantMessage("m1", id, 100, 200, { output: 50 }),
    )

    assert.equal(turnCount(id), 1)
    // totalInputTokens = Σ input + Σ cacheRead. Output is not
    // counted by the tracker (it is recorded but inert).
    assert.equal(totalInputTokens(id), 300)
  })

  it("dedupes by messageID: repeat update keeps only the latest snapshot", () => {
    // Design §Testing Strategy / Unit Tests #5: feed the same
    // messageID twice with different `tokens` payloads. The
    // tracker must replace the prior snapshot in place and
    // NOT double-count toward turnCount.
    const id = freshID("record_dedupe")
    initializeSession(id, null, null, 1_000_000)

    recordMessage(id, assistantMessage("m1", id, 100, 200))
    assert.equal(turnCount(id), 1)
    assert.equal(totalInputTokens(id), 300)

    // Same id, different tokens — must overwrite, not append.
    recordMessage(id, assistantMessage("m1", id, 500, 700))
    assert.equal(turnCount(id), 1)
    // 500 + 700 = 1200; the prior 300 must be gone.
    assert.equal(totalInputTokens(id), 1200)
  })

  it("aggregates across multiple distinct messageIDs", () => {
    // Design §Testing Strategy / Unit Tests #5: m1 (100,200)
    // plus m2 (50,100) → turnCount 2, total 450.
    const id = freshID("record_aggregate")
    initializeSession(id, null, null, 1_000_000)

    recordMessage(id, assistantMessage("m1", id, 100, 200))
    recordMessage(id, assistantMessage("m2", id, 50, 100))

    assert.equal(turnCount(id), 2)
    assert.equal(totalInputTokens(id), 450)
  })

  it("ignores output / reasoning / cacheWrite in the token total", () => {
    // The token-threshold formula is input + cacheRead only;
    // every other field on `tokens` must be inert. Pin large
    // non-zero values into the inert fields and confirm the
    // total still equals input + cacheRead.
    const id = freshID("record_inert_fields")
    initializeSession(id, null, null, 1_000_000)

    recordMessage(
      id,
      assistantMessage("m1", id, 10, 20, {
        output: 9_999,
        reasoning: 9_999,
        cacheWrite: 9_999,
      }),
    )

    assert.equal(turnCount(id), 1)
    assert.equal(totalInputTokens(id), 30)
  })
})

describe("recordMessage — UserMessage / no-op paths", () => {
  it("UserMessage (no tokens field) is a no-op: turnCount and totals stay put", () => {
    const id = freshID("record_user_noop")
    initializeSession(id, null, null, 1_000_000)

    recordMessage(id, userMessage("u1", id))
    assert.equal(turnCount(id), 0)
    assert.equal(totalInputTokens(id), 0)

    // Same UserMessage ID fed twice — still no increment.
    recordMessage(id, userMessage("u1", id))
    assert.equal(turnCount(id), 0)
    assert.equal(totalInputTokens(id), 0)
  })

  it("UserMessages interleaved with AssistantMessages do not bump turnCount", () => {
    // Sanity: a UserMessage between two distinct
    // AssistantMessages must not contribute to turnCount or
    // total tokens. Only the two assistant messages register.
    const id = freshID("record_mixed")
    initializeSession(id, null, null, 1_000_000)

    recordMessage(id, assistantMessage("a1", id, 100, 200))
    recordMessage(id, userMessage("u1", id))
    recordMessage(id, assistantMessage("a2", id, 50, 100))

    assert.equal(turnCount(id), 2)
    assert.equal(totalInputTokens(id), 450)
  })

  it("recordMessage on an unknown sessionID is a silent no-op (no throw)", () => {
    // The handler ordering contract is session.created →
    // message.updated. If message.updated arrives first for an
    // unknown session, the tracker must NOT throw — it should
    // simply ignore the event.
    const unknownID = freshID("record_unknown")
    assert.doesNotThrow(() => {
      recordMessage(
        unknownID,
        assistantMessage("m1", unknownID, 100, 200),
      )
    })
    // State should not have been created as a side effect.
    assert.equal(turnCount(unknownID), 0)
    assert.equal(totalInputTokens(unknownID), 0)
  })
})

describe("resetStartedAt", () => {
  it("re-anchors wallTimeMillis: post-reset elapsed << pre-reset elapsed", () => {
    // Design §Testing Strategy / Unit Tests #5: wall-time
    // advances correctly after resetStartedAt. We pin a very
    // old startedAt so the pre-reset elapsed is huge, then
    // reset to Date.now() and confirm the new elapsed is tiny
    // (close to zero, certainly far below the original).
    const id = freshID("reset_wall_time")
    const longAgo = Date.now() - 60 * 60 * 1000 // 1 hour ago
    initializeSession(id, null, null, longAgo)

    const before = wallTimeMillis(id)
    assert.ok(
      before >= 60 * 60 * 1000 - 1000,
      `pre-reset elapsed should be ~1h; got ${before}ms`,
    )

    resetStartedAt(id, Date.now())
    const after = wallTimeMillis(id)
    // Post-reset elapsed measures from "now" so it must be a
    // tiny number of milliseconds (well under one second on
    // any sane host). The strict invariant is `after < before`
    // with a wide margin.
    assert.ok(
      after < 1000,
      `post-reset elapsed should be near zero; got ${after}ms`,
    )
    assert.ok(
      after < before,
      `post-reset elapsed (${after}) must be < pre-reset (${before})`,
    )
  })

  it("preserves messageTokens and turnCount across the reset", () => {
    // The reset replaces the whole SessionState record to
    // honor the readonly contract on `startedAt`, but the
    // mutable aggregates (messageTokens, turnCount,
    // lastSelfCheckResult) must carry forward — see source
    // comment at resetStartedAt.
    const id = freshID("reset_preserves_tokens")
    initializeSession(id, null, null, Date.now() - 10_000)

    recordMessage(id, assistantMessage("m1", id, 100, 200))
    recordMessage(id, assistantMessage("m2", id, 50, 100))
    assert.equal(turnCount(id), 2)
    assert.equal(totalInputTokens(id), 450)

    resetStartedAt(id, Date.now())

    // Aggregates unchanged.
    assert.equal(turnCount(id), 2)
    assert.equal(totalInputTokens(id), 450)
  })

  it("is a silent no-op for an unknown sessionID", () => {
    // If session.compacted fires for a session the plugin
    // never initialized (e.g. external/native compaction on a
    // session that predates plugin install), resetStartedAt
    // must not throw.
    const unknownID = freshID("reset_unknown")
    assert.doesNotThrow(() => {
      resetStartedAt(unknownID, Date.now())
    })
    // Reader accessors still return the unknown-session
    // sentinel zeros.
    assert.equal(wallTimeMillis(unknownID), 0)
    assert.equal(turnCount(unknownID), 0)
    assert.equal(totalInputTokens(unknownID), 0)
  })
})

describe("read accessors on unknown sessions", () => {
  it("totalInputTokens, turnCount, wallTimeMillis all return 0", () => {
    // The accessors document a "0 for unknown sessions"
    // contract. Anchor it so future refactors cannot silently
    // flip the behaviour to NaN / -1 / throw.
    const unknownID = freshID("readers_unknown")
    assert.equal(totalInputTokens(unknownID), 0)
    assert.equal(turnCount(unknownID), 0)
    assert.equal(wallTimeMillis(unknownID), 0)
  })
})
