/*
 * threshold-evaluator.test.ts — unit tests for the
 * ThresholdEvaluator pure function (task 2.2 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Unit Tests #1–#4:
 *   #1 token threshold trip exactly at the boundary (strict
 *      greater-than semantics; equality must NOT trip)
 *   #2 wall-time threshold trip
 *   #3 cooldown short-circuits trips
 *   #4 disabled thresholds (null / 0) are inert
 *
 * Requirements covered: 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.10.
 *
 * Runner: `node --test` via the `opencode-cost-diagnosis-node`
 * wrapper (NODE_PATH wires up the vendored dev-deps tree). The
 * file is `.ts`; Node 22 with `--experimental-strip-types`
 * strips type annotations at load time and imports the .ts
 * source module directly.
 *
 * Determinism: the SUT's `evaluateThreshold` accepts `now` as an
 * explicit parameter and never reads wall-clock time internally,
 * so every test below pins time with concrete millis values.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import {
  evaluateThreshold,
  type MessageTokens,
  type SessionState,
  type ThresholdConfig,
} from "../../home-manager/common/opencode-plugins/session-compaction.ts"

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
//
// `makeState` constructs a SessionState with a single
// AssistantMessage worth of token aggregates totalling
// input(100) + cacheRead(200) = 300 input-tokens by the formula
// the evaluator uses (`messageTokens[*].input +
// messageTokens[*].cacheRead`). Tests pick threshold values
// around 300 so the boundary cases are reasoned in absolute
// terms rather than from a synthetic constant.
//
// `makeConfig` returns a permissive baseline that no axis trips
// against `makeState()` at `now === startedAt`: thresholdTokens
// well above 300, thresholdWallTimeHours = 24, cooldownMinutes
// = 30. Individual tests override the one axis under examination.

const DEFAULT_MESSAGE_TOKENS: MessageTokens = {
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 200,
  cacheWrite: 0,
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  // Pull messageTokens and turnCount out of the spread so the
  // computed turnCount (size of the final Map) wins unless the
  // caller pinned turnCount explicitly. Mirrors the
  // SessionTokenTracker invariant `turnCount === messageTokens.size`.
  const {
    messageTokens: overrideTokens,
    turnCount: overrideTurnCount,
    ...rest
  } = overrides
  const messageTokens =
    overrideTokens ??
    new Map<string, MessageTokens>([["m1", DEFAULT_MESSAGE_TOKENS]])
  return {
    sessionID: "ses_test",
    parentID: null,
    agentName: null,
    startedAt: 1_000_000,
    lastSelfCheckResult: "ok",
    ...rest,
    messageTokens,
    turnCount: overrideTurnCount ?? messageTokens.size,
  }
}

function makeConfig(
  overrides: Partial<ThresholdConfig> = {},
): ThresholdConfig {
  return {
    thresholdTokens: 10_000,
    thresholdWallTimeHours: 24,
    cooldownMinutes: 30,
    augmentationEnabled: true,
    watchSubagents: false,
    subagentAllowlist: { kind: "match-any" },
    cavememContextTimeoutMillis: 2000,
    ...overrides,
  }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("evaluateThreshold — R2.10 zero-turn guard", () => {
  it("returns zero_turns when turnCount is 0", () => {
    const state = makeState({
      messageTokens: new Map<string, MessageTokens>(),
      turnCount: 0,
    })
    const decision = evaluateThreshold(
      state,
      makeConfig(),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "zero_turns")
  })

  it("zero-turn precedes a cooldown evaluation", () => {
    // Even with an in-flight cooldown that would otherwise be
    // the first short-circuit, zero_turns wins. Anchors the
    // precedence contract from design §Service Interface.
    const state = makeState({
      messageTokens: new Map<string, MessageTokens>(),
      turnCount: 0,
    })
    const now = 2_000_000
    const lastCompactionAt = now - 60_000 // 1 minute ago
    const decision = evaluateThreshold(
      state,
      makeConfig({ cooldownMinutes: 30 }),
      lastCompactionAt,
      now,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "zero_turns")
  })
})

describe("evaluateThreshold — R2.2, R2.3 token threshold", () => {
  it("fires when total input > thresholdTokens", () => {
    // makeState totals input+cacheRead = 100 + 200 = 300.
    // Threshold 200 → 300 > 200 trips tokens_exceeded.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 200 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, true)
    assert.ok(
      decision.reason.startsWith("tokens_exceeded:"),
      `expected tokens_exceeded prefix; got ${decision.reason}`,
    )
    assert.equal(decision.reason, "tokens_exceeded:300")
  })

  it("does NOT fire at the exact boundary (strict greater-than)", () => {
    // Total 300, threshold 300 → 300 > 300 is false. The
    // evaluator must use strict `>`, not `>=`, per the source
    // contract and design §Service Interface.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 300 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("does NOT fire one below the boundary", () => {
    // Total 300, threshold 301 → 300 > 301 is false.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 301 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("fires one above the boundary", () => {
    // Total 300, threshold 299 → 300 > 299 trips.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 299 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "tokens_exceeded:300")
  })

  it("sums input+cacheRead across multiple messages", () => {
    // Two messages: 100+200=300 and 400+800=1200; total=1500.
    // output / reasoning / cacheWrite are intentionally
    // non-zero to confirm the evaluator ignores them.
    const messageTokens = new Map<string, MessageTokens>([
      ["m1", { input: 100, output: 999, reasoning: 999, cacheRead: 200, cacheWrite: 999 }],
      ["m2", { input: 400, output: 999, reasoning: 999, cacheRead: 800, cacheWrite: 999 }],
    ])
    const state = makeState({ messageTokens })
    const decision = evaluateThreshold(
      state,
      makeConfig({ thresholdTokens: 1000 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "tokens_exceeded:1500")
  })
})

describe("evaluateThreshold — R2.4, R2.5 wall-time threshold", () => {
  it("fires when elapsed > thresholdWallTimeHours", () => {
    // startedAt = 1_000_000, now = startedAt + 25h.
    // Threshold 24h → 25 > 24 trips wall_time_exceeded.
    // Token axis disabled (null) so it cannot pre-empt.
    const startedAt = 1_000_000
    const now = startedAt + 25 * 3_600_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: 24,
      }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "wall_time_exceeded:25h")
  })

  it("does NOT fire at the exact boundary (strict greater-than)", () => {
    // 24h elapsed, 24h threshold → 24 > 24 is false.
    const startedAt = 1_000_000
    const now = startedAt + 24 * 3_600_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: 24,
      }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("reason carries floored elapsed hours", () => {
    // 30h elapsed plus 30 extra minutes — the reason should
    // report `30h`, not `30.5h`, per the source's
    // `Math.floor(elapsedHours)` formatting.
    const startedAt = 1_000_000
    const now = startedAt + 30 * 3_600_000 + 30 * 60_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: 24,
      }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "wall_time_exceeded:30h")
  })
})

describe("evaluateThreshold — R2.6, R2.7 cooldown short-circuit", () => {
  it("in_cooldown blocks a token-exceeded trip", () => {
    // Without the cooldown the token axis would trip
    // immediately (total 300 > threshold 100).
    const now = 2_000_000
    const lastCompactionAt = now - 5 * 60_000 // 5 min ago, cooldown 30 min
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 100, cooldownMinutes: 30 }),
      lastCompactionAt,
      now,
    )
    assert.equal(decision.shouldCompact, false)
    assert.ok(
      decision.reason.startsWith("in_cooldown:"),
      `expected in_cooldown prefix; got ${decision.reason}`,
    )
    // Remaining = ceil((30min - 5min)/1s) = 25*60 = 1500 sec.
    assert.equal(decision.reason, "in_cooldown:1500s_remaining")
  })

  it("in_cooldown blocks a wall-time trip too", () => {
    const startedAt = 1_000_000
    const now = startedAt + 25 * 3_600_000
    const lastCompactionAt = now - 10 * 60_000 // 10 min ago
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: 24,
        cooldownMinutes: 30,
      }),
      lastCompactionAt,
      now,
    )
    assert.equal(decision.shouldCompact, false)
    assert.ok(decision.reason.startsWith("in_cooldown:"))
  })

  it("cooldown elapsed → token trip fires", () => {
    const now = 5_000_000
    const lastCompactionAt = now - 60 * 60_000 // 1 hour ago, well past 30-min cooldown
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 100, cooldownMinutes: 30 }),
      lastCompactionAt,
      now,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "tokens_exceeded:300")
  })

  it("cooldownMinutes = 0 disables the cooldown gate", () => {
    // Operator opt-out path: cooldown 0 must NOT short-circuit
    // a trip even when lastCompactionAt is recent.
    const now = 2_000_000
    const lastCompactionAt = now - 1_000 // 1 second ago
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 100, cooldownMinutes: 0 }),
      lastCompactionAt,
      now,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "tokens_exceeded:300")
  })

  it("lastCompactionAt = null skips the cooldown gate", () => {
    // A session that has never been compacted has nothing to
    // cool down from.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 100, cooldownMinutes: 30 }),
      null,
      2_000_000,
    )
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, "tokens_exceeded:300")
  })
})

describe("evaluateThreshold — R2.8 disabled-axis inertness", () => {
  it("thresholdTokens = null is inert (no token trip)", () => {
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: null }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("thresholdTokens = 0 is inert (no token trip)", () => {
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({ thresholdTokens: 0 }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("thresholdWallTimeHours = null is inert (no wall trip)", () => {
    // 100h elapsed but wall axis disabled → no trip.
    const startedAt = 1_000_000
    const now = startedAt + 100 * 3_600_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: 99_999,
        thresholdWallTimeHours: null,
      }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("thresholdWallTimeHours = 0 is inert (no wall trip)", () => {
    const startedAt = 1_000_000
    const now = startedAt + 100 * 3_600_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({
        thresholdTokens: 99_999,
        thresholdWallTimeHours: 0,
      }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, false)
  })

  it("both axes disabled → reason names the token axis (canonical fall-through)", () => {
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: null,
      }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "tokens_disabled")
  })

  it("tokens disabled but wall-time configured → reason is tokens_disabled (still)", () => {
    // The source treats `!tokensEnabled` as the first
    // fall-through branch even when wall-time is enabled but
    // not tripped; lock this in so changes to the
    // suppression-log path do not silently flip semantics.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({
        thresholdTokens: null,
        thresholdWallTimeHours: 24,
      }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "tokens_disabled")
  })

  it("tokens enabled-but-not-tripped, wall disabled → wall_time_disabled", () => {
    // Token threshold 10_000, total 300 → no trip; wall axis
    // disabled → fall-through resolves to wall_time_disabled.
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({
        thresholdTokens: 10_000,
        thresholdWallTimeHours: null,
      }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "wall_time_disabled")
  })

  it("both axes enabled-but-not-tripped → no_threshold_met", () => {
    const decision = evaluateThreshold(
      makeState(),
      makeConfig({
        thresholdTokens: 10_000,
        thresholdWallTimeHours: 24,
      }),
      null,
      1_000_000,
    )
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, "no_threshold_met")
  })
})

describe("evaluateThreshold — precedence between trip axes", () => {
  it("token trip precedes wall-time trip when both would fire", () => {
    // Arrange both axes to trip. The source's branch order
    // checks tokens first, then wall-time, so the reason must
    // be the token one.
    const startedAt = 1_000_000
    const now = startedAt + 25 * 3_600_000
    const state = makeState({ startedAt })
    const decision = evaluateThreshold(
      state,
      makeConfig({ thresholdTokens: 100, thresholdWallTimeHours: 24 }),
      null,
      now,
    )
    assert.equal(decision.shouldCompact, true)
    assert.ok(
      decision.reason.startsWith("tokens_exceeded:"),
      `expected tokens precedence; got ${decision.reason}`,
    )
  })
})
