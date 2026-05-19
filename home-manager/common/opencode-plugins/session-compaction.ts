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
import { spawn } from "node:child_process"

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

// ============================================================
// ThresholdEvaluator (task 2.2)
// ============================================================
//
// Pure function: given the per-session aggregates, the operator's
// ThresholdConfig, and the most-recent compaction timestamp
// (mirrors `Session.time.compacting`), produce a ThresholdDecision.
// Wired into `message.updated` by task 3.2; until then this seam
// is unreachable from opencode's runtime.

// ThresholdConfig mirrors design §Components / SessionCompactionPlugin
// / Service Interface byte-for-byte. The Nix install module emits a
// matching env-var contract that task 3.x parses into this shape.
export interface ThresholdConfig {
  readonly thresholdTokens: number | null
  readonly thresholdWallTimeHours: number | null
  readonly cooldownMinutes: number
  readonly augmentationEnabled: boolean
  readonly watchSubagents: boolean
  readonly subagentAllowlist: SubagentAllowlist
  readonly cavememContextTimeoutMillis: number
}

// SubagentAllowlist trichotomy preserved across the
// Nix → env-var → TS boundary. The three kind-tagged variants
// prevent the watcher from silently degenerating into "match every
// subagent" when the operator meant "match none". Shape matches
// design §Service Interface byte-for-byte.
export type SubagentAllowlist =
  | { kind: "match-any" }
  | { kind: "match-none" }
  | { kind: "match-listed"; agents: ReadonlyArray<string> }

// ThresholdDecision is the evaluator's only output. The reason
// string follows the convention documented in design §Service
// Interface so the suppression-log path (task 5.x) can attribute
// every miss without re-deriving cause.
export interface ThresholdDecision {
  readonly shouldCompact: boolean
  readonly reason: string
}

/**
 * Pure threshold evaluator. Decides whether the session should
 * undergo automatic compaction given current state, operator
 * configuration, and the most-recent compaction timestamp.
 *
 * Caller supplies `now` (ms since epoch); this function never reads
 * wall-clock time internally so tests (task 4.1) can pin time.
 *
 * Precedence (matches design §Service Interface):
 *   1. Zero turns         → reason "zero_turns" (R2.10).
 *   2. In cooldown        → reason "in_cooldown:<sec>s_remaining"
 *                           (R2.6, R2.7).
 *   3. Token trip         → reason "tokens_exceeded:<total>"
 *                           (R2.2, R2.3).
 *   4. Wall-time trip     → reason "wall_time_exceeded:<hours>h"
 *                           (R2.4, R2.5).
 *   5. Fall-through       → reason "tokens_disabled" /
 *                           "wall_time_disabled" / "no_threshold_met"
 *                           per R2.8 (null/0 → disabled).
 *
 * `lastCompactionAt = null` means the session has never been
 * compacted (read from `Session.time.compacting` by the caller),
 * so the cooldown window does not apply.
 */
export function evaluateThreshold(
  state: SessionState,
  config: ThresholdConfig,
  lastCompactionAt: number | null,
  now: number,
): ThresholdDecision {
  // R2.10: zero-turn no-op precedes every other check. A session
  // that has produced zero LLM turns is never a compaction
  // candidate, regardless of wall-time or token configuration.
  if (state.turnCount === 0) {
    return { shouldCompact: false, reason: "zero_turns" }
  }

  // R2.6, R2.7: cooldown short-circuits all trips. A zero or
  // negative `cooldownMinutes` disables the cooldown gate entirely
  // (operator opt-out path). `lastCompactionAt === null` means the
  // session has never been compacted, so there is nothing to
  // cooldown from.
  if (lastCompactionAt !== null && config.cooldownMinutes > 0) {
    const cooldownMillis = config.cooldownMinutes * 60 * 1000
    const elapsedSinceCompaction = now - lastCompactionAt
    if (elapsedSinceCompaction < cooldownMillis) {
      const remainingSeconds = Math.ceil(
        (cooldownMillis - elapsedSinceCompaction) / 1000,
      )
      return {
        shouldCompact: false,
        reason: `in_cooldown:${remainingSeconds}s_remaining`,
      }
    }
  }

  // R2.8: `null` or `0` disables a threshold axis. After this point
  // the booleans gate every read of the underlying threshold value.
  const tokensThreshold = config.thresholdTokens
  const tokensEnabled =
    tokensThreshold !== null && tokensThreshold > 0
  const wallTimeThreshold = config.thresholdWallTimeHours
  const wallTimeEnabled =
    wallTimeThreshold !== null && wallTimeThreshold > 0

  // R2.2, R2.3: token threshold trip. Sum uses the same
  // `input + cacheRead` formula SessionTokenTracker exposes via
  // `totalInputTokens(sessionID)`. We inline the sum here because
  // the evaluator is pure: state is the input, no module-scoped
  // Map lookup needed (design §Data Models / Logical Data Model).
  if (tokensEnabled) {
    let total = 0
    for (const tokens of state.messageTokens.values()) {
      total += tokens.input + tokens.cacheRead
    }
    if (total > (tokensThreshold as number)) {
      return {
        shouldCompact: true,
        reason: `tokens_exceeded:${total}`,
      }
    }
  }

  // R2.4, R2.5: wall-time trip. Elapsed is measured from the
  // current `startedAt` anchor, which task 3.6 re-anchors via
  // `resetStartedAt` on every `session.compacted` event so the
  // wall-clock threshold measures from the most recent compaction.
  if (wallTimeEnabled) {
    const elapsedHours = (now - state.startedAt) / (3600 * 1000)
    if (elapsedHours > (wallTimeThreshold as number)) {
      const hours = Math.floor(elapsedHours)
      return {
        shouldCompact: true,
        reason: `wall_time_exceeded:${hours}h`,
      }
    }
  }

  // R2.8: fall-through. Surface the most-specific disabled reason
  // so the suppression-log path can attribute the miss without
  // re-deriving cause. When both axes are disabled,
  // "tokens_disabled" is the canonical reason (both axes treated
  // interchangeably for the suppression log per design §Service
  // Interface).
  if (!tokensEnabled) {
    return { shouldCompact: false, reason: "tokens_disabled" }
  }
  if (!wallTimeEnabled) {
    return { shouldCompact: false, reason: "wall_time_disabled" }
  }
  return { shouldCompact: false, reason: "no_threshold_met" }
}

// ============================================================
// PluginSelfCheck (task 2.3)
// ============================================================
//
// Startup API-probe seam. R7.2 requires the plugin to confirm
// opencode's SDK client surface matches the shape this plugin
// depends on; R7.3 requires self-disabling for the session on
// failure with a structured error naming the gap; R7.4 requires
// every other handler to short-circuit while disabled. The probe
// itself is idempotent and runs on the first received event of
// any kind (task 3.x handlers call `runSelfCheckIfNeeded(client)`
// at entry; until then the seam is unreachable from opencode's
// runtime).
//
// The probe is intentionally side-effect-free: it inspects
// `typeof` for each method we depend on and emits exactly one
// `app.log` entry per outcome path. No SDK method is invoked
// with real arguments here — calling `session.summarize` or
// `session.get` for a probe would mutate opencode state or page
// the user with toasts. The R5.6 subagent-observability warn-once
// belongs to task 3.1 (session.created handler), where the actual
// `parentID` shape is observable; this seam only establishes the
// broader self-check infrastructure that 3.1 builds on.

// PluginClient is the minimal subset of opencode's SDK client
// surface this plugin touches. The runtime `Client` type (passed
// to the plugin via `ctx.client`) has more surface; we only
// annotate the methods we actually use so the type contract is
// reviewable in isolation. `@opencode-ai/plugin` does not
// re-export the SDK Client type, so we declare locally — same
// precedent as MessageInfo above.
//
// Every method returns a Promise (the opencode SDK client is
// async-by-construction); the probe checks only `typeof === "function"`,
// so the Promise return types are advisory for callers, not the
// probe.
export interface PluginClient {
  readonly session: {
    readonly summarize: (params: {
      readonly path: { readonly id: string }
      readonly body: Record<string, unknown>
    }) => Promise<boolean>
    readonly get: (params: {
      readonly path: { readonly id: string }
    }) => Promise<unknown>
  }
  readonly app: {
    readonly log: (params: {
      readonly body: {
        readonly service: string
        readonly level: "info" | "warn" | "error" | "debug"
        readonly message: string
        readonly extra?: Record<string, unknown>
      }
    }) => Promise<boolean>
  }
  readonly tui: {
    readonly showToast: (params: {
      readonly body: {
        readonly message: string
        readonly variant: "info" | "success" | "warning" | "error"
        readonly title?: string
      }
    }) => Promise<boolean>
  }
}

// Module-scoped self-check result. `null` = not yet probed;
// `"ok"` / `"failed"` = terminal outcomes set on first probe.
// Mutable (so `let`, not `const`); read via the exported getter
// so the field stays encapsulated and future handlers can branch
// on `selfCheckResult === "failed"` per R7.4.
let selfCheckResult: "ok" | "failed" | null = null

/**
 * Read the current self-check outcome. Returns `null` until the
 * first event-handler invocation calls `runSelfCheckIfNeeded`;
 * `"ok"` or `"failed"` thereafter. Exported so task 3.x handlers
 * (and task 4.4 tests) can branch without re-running the probe.
 */
export function getSelfCheckResult(): "ok" | "failed" | null {
  return selfCheckResult
}

/**
 * Idempotent startup self-check. On the first invocation, probes
 * the four SDK methods the plugin depends on and emits one
 * structured `app.log` entry summarizing the outcome. On every
 * subsequent invocation, returns the cached result without
 * re-probing.
 *
 * Probe semantics: `typeof client.<surface>.<method> === "function"`
 * for each of `session.summarize`, `session.get`, `app.log`, and
 * `tui.showToast`. We never actually call the SDK methods here;
 * a real call would mutate opencode state (summarize) or page
 * the user (showToast). Existence-by-typeof is the strongest
 * non-destructive contract we can assert at startup.
 *
 * Outcome paths (mutually exclusive — exactly one log per call
 * that performs a real probe; cached calls log nothing):
 *
 *   - All four probes pass → `selfCheckResult = "ok"`, emit
 *     `service: "session-compaction", level: "info", message:
 *     "self-check passed"`. Returns `"ok"`.
 *   - One or more probes fail → `selfCheckResult = "failed"`,
 *     emit `service: "session-compaction", level: "error",
 *     message: "self-check failed", extra: { missing: [...] }`
 *     listing every gap in a single entry. Returns `"failed"`.
 *
 * The error path makes a best-effort `app.log` call: if
 * `app.log` itself is the missing surface, the entry naturally
 * has no sink, but the module-scoped flag is still set so
 * handlers short-circuit per R7.4. Awaiting the log keeps the
 * promise chain deterministic for tests.
 */
export async function runSelfCheckIfNeeded(
  client: PluginClient,
): Promise<"ok" | "failed"> {
  if (selfCheckResult !== null) return selfCheckResult

  // Collect every missing surface in one pass so the failure
  // log names all gaps in a single entry (per task brief
  // acceptance criterion: no per-gap log spam).
  const missing: Array<string> = []
  if (typeof client.session?.summarize !== "function") {
    missing.push("session.summarize")
  }
  if (typeof client.session?.get !== "function") {
    missing.push("session.get")
  }
  if (typeof client.app?.log !== "function") {
    missing.push("app.log")
  }
  if (typeof client.tui?.showToast !== "function") {
    missing.push("tui.showToast")
  }

  if (missing.length === 0) {
    selfCheckResult = "ok"
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "self-check passed",
      },
    })
    return "ok"
  }

  selfCheckResult = "failed"
  // Best-effort: if `app.log` is itself in `missing` the call
  // below will throw, but the flag is already set so the
  // short-circuit semantics in R7.4 are preserved. We still
  // attempt the log so the operator sees the gap when the
  // missing surface is anything *other* than `app.log`.
  if (typeof client.app?.log === "function") {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "error",
        message: "self-check failed",
        extra: { missing },
      },
    })
  }
  return "failed"
}

// ============================================================
// CompactionInvoker (task 2.4)
// ============================================================
//
// Single entry point for `client.session.summarize`. Every
// compaction the plugin originates — threshold trip (task 3.2),
// `/compact` slash command (task 3.3) — funnels through
// `invokeCompaction`. Externally-triggered compactions
// (opencode-native TUI keybind, or any opencode internal
// auto-trigger we did not initiate) never call this function;
// task 3.6's `session.compacted` handler detects the absence of
// a tracked `CompactionAttempt` and attributes those to
// `"external"`.
//
// Failure semantics (R2.9, R7.5):
//   - Errors are caught, recorded, and surfaced via the
//     `CompactionResult` return value; they never propagate to
//     opencode's main loop.
//   - One `app.log` entry per outcome (info on success, error on
//     failure). No retry inside this function — R7.5's
//     "no retry within cooldown" is enforced upstream by
//     `evaluateThreshold` reading `Session.time.compacting`. The
//     `lastErrorAt` Map is exposed so the manual-compaction
//     handler (task 3.3) and any future suppression-log path can
//     attribute or rate-limit on per-session error history.

// CompactionTrigger discriminated union. Three observable sources;
// the plugin must attribute every `session.compacted` event to
// exactly one of them for R6 (observability). Shape matches design
// §Service Interface byte-for-byte.
export type CompactionTrigger =
  | "automatic"
  | "manual"
  | "external"

// CompactionAttempt is the record stored in `inFlightAttempts`
// between `invokeCompaction` succeeding and `session.compacted`
// firing. Task 3.6 consumes it for trigger attribution. Shape
// matches design §Service Interface byte-for-byte.
export interface CompactionAttempt {
  readonly sessionID: string
  readonly trigger: CompactionTrigger
  readonly reason: string
  readonly timestamp: number
}

// CompactionResult is `invokeCompaction`'s only output. Callers
// (task 3.2 threshold-trip path, task 3.3 manual path) inspect
// `succeeded` / `error` to decide whether to surface a
// `tui.showToast` to the operator. Shape matches design §Service
// Interface byte-for-byte.
export interface CompactionResult {
  readonly attempt: CompactionAttempt
  readonly succeeded: boolean
  readonly error: string | null
}

// Module-scoped in-flight attempts. Keyed by sessionID; one entry
// at most per session because opencode serializes plugin handlers
// per session and `session.compacted` consumes the entry as soon
// as it fires. Set ONLY on successful `session.summarize` calls
// (failed compactions intentionally do NOT register an attempt:
// if a failed call were registered, the next opencode-native
// compaction for the same session would be mis-attributed to
// `"automatic"` / `"manual"` instead of `"external"`).
const inFlightAttempts: Map<string, CompactionAttempt> = new Map()

// Module-scoped per-session error timestamps. Set ONLY on
// failure. Exposed via `getLastErrorAt` for callers that want to
// inspect per-session error history without granting them write
// access to the Map.
const lastErrorAt: Map<string, number> = new Map()

/**
 * Invoke opencode's native compaction for a session. The single
 * entry point into `client.session.summarize` for this plugin;
 * task 3.2 (automatic) and task 3.3 (manual) call this and
 * inspect the returned `CompactionResult`.
 *
 * Outcome paths (mutually exclusive — exactly one `app.log` per
 * call):
 *
 *   - SDK accepts the call → register a `CompactionAttempt` in
 *     `inFlightAttempts` for task 3.6 to consume on the
 *     subsequent `session.compacted` event; emit info-level
 *     `app.log` `"compaction triggered"` with `trigger` and
 *     `reason`; return `{ attempt, succeeded: true, error: null }`.
 *   - SDK rejects → extract `errorMessage` defensively
 *     (`Error.message` or `String(e)` for non-Error throws);
 *     set `lastErrorAt[sessionID] = now`; emit error-level
 *     `app.log` `"compaction failed"` with `errorMessage`;
 *     return `{ attempt, succeeded: false, error: errorMessage }`.
 *
 * R2.9: failures are recorded and surfaced via the return value;
 * they never propagate to opencode's main loop.
 * R7.5: this function never retries. The cooldown gate is enforced
 * by `evaluateThreshold` reading `Session.time.compacting`; the
 * `lastErrorAt` Map is for callers that want per-session error
 * attribution, not for re-entry suppression.
 */
export async function invokeCompaction(
  client: PluginClient,
  sessionID: string,
  trigger: CompactionTrigger,
  reason: string,
  now: number,
): Promise<CompactionResult> {
  const attempt: CompactionAttempt = {
    sessionID,
    trigger,
    reason,
    timestamp: now,
  }

  try {
    await client.session.summarize({
      path: { id: sessionID },
      body: {},
    })
  } catch (e: unknown) {
    // Defensive extraction: opencode's SDK throws Error in the
    // common path, but the runtime can surface non-Error throws
    // (string rejections, undefined, etc.). String(e) is the
    // last-resort coercion that never throws.
    const errorMessage =
      e instanceof Error ? e.message : String(e)
    lastErrorAt.set(sessionID, now)
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "error",
        message: "compaction failed",
        extra: { sessionID, trigger, reason, errorMessage },
      },
    })
    return { attempt, succeeded: false, error: errorMessage }
  }

  // Success path: register the attempt FIRST so the consume-side
  // (task 3.6) can attribute correctly even if the
  // `session.compacted` event races the info log.
  inFlightAttempts.set(sessionID, attempt)
  await client.app.log({
    body: {
      service: "session-compaction",
      level: "info",
      message: "compaction triggered",
      extra: { sessionID, trigger, reason },
    },
  })
  return { attempt, succeeded: true, error: null }
}

/**
 * Atomically claim the in-flight `CompactionAttempt` for a
 * session, if any. Returns the attempt and removes it from the
 * Map in a single call so only one consumer can succeed per
 * attempt; subsequent calls for the same sessionID return `null`
 * until a new `invokeCompaction` succeeds.
 *
 * Called by task 3.6's `session.compacted` handler: presence of
 * an attempt means the plugin initiated the compaction
 * (attribute to `attempt.trigger`); absence means opencode-native
 * (attribute to `"external"`).
 */
export function consumeInFlightAttempt(
  sessionID: string,
): CompactionAttempt | null {
  const attempt = inFlightAttempts.get(sessionID)
  if (!attempt) return null
  inFlightAttempts.delete(sessionID)
  return attempt
}

/**
 * Read-only accessor for the per-session last-error timestamp.
 * Returns `null` if the session has never had a recorded
 * compaction failure. Exposed for the manual-compaction handler
 * (task 3.3) and any future suppression-log path that wants to
 * attribute or rate-limit on error history.
 */
export function getLastErrorAt(sessionID: string): number | null {
  const value = lastErrorAt.get(sessionID)
  return value === undefined ? null : value
}

// ============================================================
// CavememContextSource (task 2.5)
// ============================================================
//
// Read-only spawn of `cavemem search` to fetch context for the
// augmentation path (task 3.4). The only cavemem subcommand this
// plugin ever invokes is `search` (R3.4, R8.4); the arg list is
// hardcoded except for the sessionID and limit, so no operator-
// controlled string ever determines which cavemem subcommand
// runs. Every failure path (spawn error, non-zero exit, timeout)
// returns an empty result; the function never throws (R3.3 —
// compaction must proceed even if cavemem is unreachable).
//
// Stderr is discarded by setting `stdio[2] = "ignore"` so cavemem's
// own error messages cannot leak into the caller's `app.log`
// stream. Stdout is capped at 4096 bytes; once the cap is
// reached, subsequent chunks are dropped and a sentinel marker
// `…[truncated]` is appended to the returned text.

// CavememContextResult mirrors design §Service Interface byte-
// for-byte. Empty `text` + empty `source` is the canonical
// sentinel for "no context retrieved"; `elapsedMillis` is always
// populated so callers can attribute timing without branching.
export interface CavememContextResult {
  readonly text: string
  readonly source: string
  readonly elapsedMillis: number
}

const CAVEMEM_CLI = "cavemem"
const CAVEMEM_DEFAULT_TIMEOUT_MS = 2000
const CAVEMEM_STDOUT_CAP_BYTES = 4096
const CAVEMEM_TRUNCATION_MARKER = "…[truncated]"
const CAVEMEM_DEFAULT_LIMIT = 10

/**
 * Resolve the per-call timeout from the HM-module-exported env
 * var `SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS` (task 1.3), falling
 * back to `CAVEMEM_DEFAULT_TIMEOUT_MS` (2000ms) when the var is
 * missing, empty, non-numeric, or non-positive. Tests (task 4.3)
 * override the env var directly. Returns a strictly positive
 * integer count of milliseconds.
 */
function resolveCavememTimeoutMillis(): number {
  const raw = process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS
  if (typeof raw !== "string" || raw.length === 0) {
    return CAVEMEM_DEFAULT_TIMEOUT_MS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CAVEMEM_DEFAULT_TIMEOUT_MS
  }
  return parsed
}

/**
 * Spawn `cavemem search --session <sessionID> --limit <limit>`
 * and return its stdout, bounded by the configured timeout and a
 * 4096-byte stdout cap. Read-only by construction: the only
 * cavemem subcommand this plugin invokes is `search`, and the
 * arg list is hardcoded except for the caller-supplied sessionID
 * and limit (R3.4, R8.4).
 *
 * Failure semantics (R3.3 — cavemem unreachable/empty must not
 * block compaction; the function never throws):
 *
 *   - Spawn error (ENOENT, EPERM, etc.) → `{ text: "",
 *     source: "", elapsedMillis: <small, typically <100ms> }`.
 *   - Subprocess exits non-zero → `{ text: "", source: "",
 *     elapsedMillis }`.
 *   - Subprocess exceeds the timeout → SIGTERM the child;
 *     resolve `{ text: "", source: "", elapsedMillis ≈ timeout }`.
 *   - Stdout exceeds 4096 bytes → truncate at the cap and
 *     append `"…[truncated]"`.
 *   - Subprocess exits zero with empty stdout → `{ text: "",
 *     source: "cavemem search", elapsedMillis }` (a successful
 *     call returning no payload is distinguishable from a
 *     failure by the non-empty `source`).
 *
 * The Promise resolves at most once; the `settled` guard handles
 * the race between the `close` event and the timeout timer.
 */
export async function fetchCavememContext(
  sessionID: string,
  limit?: number,
): Promise<CavememContextResult> {
  const startedAt = Date.now()
  const timeoutMillis = resolveCavememTimeoutMillis()
  const effectiveLimit = limit ?? CAVEMEM_DEFAULT_LIMIT

  return new Promise<CavememContextResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const chunks: Array<Buffer> = []
    let collected = 0
    let truncated = false

    const empty = (): CavememContextResult => ({
      text: "",
      source: "",
      elapsedMillis: Date.now() - startedAt,
    })

    const finish = (result: CavememContextResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        CAVEMEM_CLI,
        [
          "search",
          "--session",
          sessionID,
          "--limit",
          String(effectiveLimit),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
    } catch {
      // Synchronous spawn failures are rare (most surface as
      // async 'error' events) but possible (e.g. argv too large).
      // Resolve empty so callers never observe a thrown
      // exception — R3.3 demands compaction proceeds regardless.
      resolve(empty())
      return
    }

    timer = setTimeout(() => {
      // R3.3 timeout bound: kill the subprocess and resolve
      // empty. The killed child's subsequent 'close' event is
      // ignored by the `settled` guard inside `finish`.
      try {
        child.kill("SIGTERM")
      } catch {
        // kill() returns false (does not throw) when the
        // process is already gone; the catch is defensive for
        // unexpected runtime variants.
      }
      finish(empty())
    }, timeoutMillis)

    child.on("error", () => {
      // Async spawn error — most commonly ENOENT when cavemem
      // is not on PATH. Resolve empty; never throw.
      finish(empty())
    })

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return
        const remaining = CAVEMEM_STDOUT_CAP_BYTES - collected
        if (remaining <= 0) {
          truncated = true
          return
        }
        if (chunk.length <= remaining) {
          chunks.push(chunk)
          collected += chunk.length
        } else {
          chunks.push(chunk.subarray(0, remaining))
          collected += remaining
          truncated = true
        }
      })
      child.stdout.on("error", () => {
        // Stream errors are non-fatal: the 'close' event still
        // fires and produces the final result via `finish`.
      })
    }

    child.on("close", (code) => {
      if (code !== 0) {
        finish(empty())
        return
      }
      const text =
        Buffer.concat(chunks).toString("utf8") +
        (truncated ? CAVEMEM_TRUNCATION_MARKER : "")
      finish({
        text,
        source: "cavemem search",
        elapsedMillis: Date.now() - startedAt,
      })
    })
  })
}

export const SessionCompactionPlugin: Plugin = async (ctx) => ({})
