// Session-compaction plugin — Foundation-phase stub.
//
// Placeholder per .kiro/specs/session-compaction. Loads cleanly into
// opencode's plugin runtime so subsequent Nix wiring (task 1.3) and
// rebuild verification (task 1.4) can land before behavior is
// introduced. The full handler chain (token tracking, threshold logic,
// cavemem augmentation, manual compaction, observability) is filled
// in by Core-phase tasks 2.x and Integration-phase tasks 3.x.
//
// Task 2.1 (Core phase): SessionTokenTracker seam. Pure per-session,
// per-message token aggregation, callable as named exports. The
// message.updated handler that drives this seam lands in task 3.2;
// until then the exported `SessionCompactionPlugin` handler stays
// empty and the seam is unreachable from opencode's runtime.

import type { Plugin } from "@opencode-ai/plugin"

// Minimal duck-typed shape for opencode's Message payload, mirroring
// the subset this seam reads from `types.gen.ts`. The
// `@opencode-ai/plugin` types package does not currently re-export
// the Message type, so we declare it locally — the same precedent
// `zellij-attention.ts` uses for event payloads. UserMessages omit
// `tokens`; only AssistantMessages carry it.
export interface MessageInfo {
  readonly id: string
  readonly sessionID: string
  readonly role: "user" | "assistant"
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
}

// MessageTokens is the per-message cumulative snapshot retained
// inside SessionState.messageTokens. Shape matches design
// §Components / SessionCompactionPlugin / Service Interface exactly.
// All fields readonly; we replace whole records on update rather
// than mutate in place.
export interface MessageTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

// Per-session aggregate state held in module-scoped memory. Shape
// matches design §Components / SessionCompactionPlugin / Service
// Interface exactly: identity fields (sessionID, parentID,
// agentName, startedAt) are readonly; the rolling aggregates
// (messageTokens, turnCount, lastSelfCheckResult) are mutable.
// `startedAt` is conceptually replace-only — resetStartedAt swaps
// the whole record to honor the readonly contract while still
// allowing the session.compacted handler (task 3.6) to anchor the
// wall-clock threshold from the most recent compaction.
export interface SessionState {
  readonly sessionID: string
  readonly parentID: string | null
  readonly agentName: string | null
  readonly startedAt: number
  messageTokens: Map<string, MessageTokens>
  turnCount: number
  lastSelfCheckResult: "ok" | "failed" | null
}

// Module-scoped state map. One entry per opencode session this
// plugin process has observed. Transient by design — opencode owns
// session persistence; reload semantics are documented in design
// §State Management.
const sessionStates: Map<string, SessionState> = new Map()

/**
 * Initialize per-session state. Called by the session.created
 * handler in task 3.1. Idempotent: if a state for the same
 * sessionID already exists, the existing record is left unchanged
 * so out-of-order or duplicate session.created events do not
 * clobber in-flight aggregates.
 */
export function initializeSession(
  sessionID: string,
  parentID: string | null,
  agentName: string | null,
  startedAt: number,
): void {
  if (sessionStates.has(sessionID)) return
  sessionStates.set(sessionID, {
    sessionID,
    parentID,
    agentName,
    startedAt,
    messageTokens: new Map(),
    turnCount: 0,
    lastSelfCheckResult: null,
  })
}

/**
 * Record a `message.updated` event for an already-initialized
 * session. Dedupes by `message.id` (messageID): a repeat update
 * for the same messageID replaces the prior token snapshot but
 * does not double-count toward `turnCount`. Tokenless messages
 * (UserMessages) are no-ops; only AssistantMessages with `tokens`
 * advance `turnCount`. This matches R2.10's "LLM turns" semantic.
 * `turnCount` is derived from `messageTokens.size` after every
 * insert so the field stays in sync with the Map and cannot
 * over-count across repeated `message.updated` events for the
 * same messageID. No-op for unknown sessions, per the design's
 * expected session.created-then-message.updated ordering.
 *
 * Observable (task brief): feeding two distinct messageIDs
 * accumulates both totals; feeding the same messageID twice with
 * different snapshots keeps only the latest.
 */
export function recordMessage(
  sessionID: string,
  message: MessageInfo,
): void {
  const state = sessionStates.get(sessionID)
  if (!state) return
  if (!message.tokens) return

  state.messageTokens.set(message.id, {
    input: message.tokens.input,
    output: message.tokens.output,
    reasoning: message.tokens.reasoning,
    cacheRead: message.tokens.cache.read,
    cacheWrite: message.tokens.cache.write,
  })
  state.turnCount = state.messageTokens.size
}

/**
 * Cumulative input tokens used for the token-threshold decision:
 * `Σ messageTokens[*].input + Σ messageTokens[*].cacheRead`.
 * Cached reads are included because they are the cost driver per
 * the 2026-05-19 cost diagnostic (design §Data Models / Logical
 * Data Model). Returns 0 for unknown sessions.
 */
export function totalInputTokens(sessionID: string): number {
  const state = sessionStates.get(sessionID)
  if (!state) return 0
  let total = 0
  for (const tokens of state.messageTokens.values()) {
    total += tokens.input + tokens.cacheRead
  }
  return total
}

/**
 * Number of distinct messageIDs observed for the session.
 * Returns 0 for unknown sessions.
 */
export function turnCount(sessionID: string): number {
  const state = sessionStates.get(sessionID)
  if (!state) return 0
  return state.turnCount
}

/**
 * Milliseconds elapsed since the session's `startedAt` anchor
 * (initial or most recent `resetStartedAt`). Returns 0 for
 * unknown sessions.
 */
export function wallTimeMillis(sessionID: string): number {
  const state = sessionStates.get(sessionID)
  if (!state) return 0
  return Date.now() - state.startedAt
}

/**
 * Re-anchor the session's wall-time. Called from the
 * session.compacted handler in task 3.6 so the wall-clock
 * threshold measures from the most recent compaction. No-op for
 * unknown sessions. Because `startedAt` is `readonly` on
 * SessionState, we replace the whole record while preserving the
 * mutable aggregate fields (messageTokens, turnCount,
 * lastSelfCheckResult).
 */
export function resetStartedAt(sessionID: string, now: number): void {
  const existing = sessionStates.get(sessionID)
  if (!existing) return
  sessionStates.set(sessionID, {
    sessionID: existing.sessionID,
    parentID: existing.parentID,
    agentName: existing.agentName,
    startedAt: now,
    messageTokens: existing.messageTokens,
    turnCount: existing.turnCount,
    lastSelfCheckResult: existing.lastSelfCheckResult,
  })
}

export const SessionCompactionPlugin: Plugin = async (ctx) => ({})
