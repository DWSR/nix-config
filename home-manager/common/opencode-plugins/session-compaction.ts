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
    await logSelfCheck(client, "ok")
    return "ok"
  }

  selfCheckResult = "failed"
  // Best-effort: if `app.log` is itself in `missing` the wrapper's
  // try/catch swallows the resulting TypeError so the flag-set
  // above governs R7.4 short-circuit semantics regardless of
  // whether the log entry actually reaches opencode.
  await logSelfCheck(client, "failed", missing)
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
    await logError(client, sessionID, {
      message: errorMessage,
      context: "invokeCompaction",
    })
    return { attempt, succeeded: false, error: errorMessage }
  }

  // Success path: register the attempt FIRST so the consume-side
  // (task 3.6) can attribute correctly even if the
  // `session.compacted` event races the info log.
  inFlightAttempts.set(sessionID, attempt)
  await logTrigger(client, attempt)
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

// ============================================================
// SessionCompactionLogger (task 2.6)
// ============================================================
//
// Centralized wrapper around `client.app.log` for every emission
// the plugin produces. Design §Components / SessionCompactionPlugin
// / Logger Contract fixes the envelope:
//   - `service: "session-compaction"` literal on every entry
//     (R6.1, R6.2, R6.4, R6.5 — grepability in the operator's
//     log sink).
//   - `level: "debug" | "info" | "warn" | "error"`.
//   - `extra` carries structured fields (sessionID, trigger,
//     reason, etc.); free-form prose stays in `message`.
//
// Every wrapper:
//   - Is `async` and returns `Promise<void>`. Awaiting keeps the
//     emission ordering deterministic relative to surrounding
//     state mutations (e.g. `inFlightAttempts.set` before
//     `logTrigger` in CompactionInvoker).
//   - Swallows `app.log` failures with a try/catch that never
//     re-throws. Logging is best-effort observability; it must
//     never block opencode's event loop or propagate an error to
//     a calling handler (R7.4 / R7.5 — a self-disabled or
//     SDK-broken plugin must still hand control back to opencode
//     cleanly).
//   - Performs zero state mutation, zero Map reads, zero side
//     effects beyond the single `client.app.log` call. The
//     surrounding handlers own state; loggers only emit.
//
// The eight methods cover every emission shape declared in design
// §Event Contract:
//   logSelfCheck       — startup self-check (R7.2, R7.3)
//   logSessionStart    — session.created init (R6.5)
//   logSessionIdle     — session.idle summary (R6.5)
//   logTrigger         — compaction triggered (R6.1)
//   logSuppression     — automatic compaction suppressed (R6.4)
//   logAugmentation    — cavemem context pushed (R6.2)
//   logCompacted       — session.compacted observation (R6.1)
//   logError           — handler-scope failure (R7.5)

/**
 * Emit the startup self-check outcome. Called by
 * `runSelfCheckIfNeeded` on the first event of any kind.
 *
 * `"ok"` path → info-level `"self-check passed"` with no extras.
 * `"failed"` path → error-level `"self-check failed"` carrying
 * the list of missing SDK surfaces under `extra.missing` so the
 * operator sees every gap in one entry (no per-gap log spam).
 *
 * When `result === "failed"` and `missing` is omitted, the field
 * is included as an empty array so the log shape stays uniform
 * across failure variants.
 */
export async function logSelfCheck(
  client: PluginClient,
  result: "ok" | "failed",
  missing?: ReadonlyArray<string>,
): Promise<void> {
  try {
    if (result === "ok") {
      await client.app.log({
        body: {
          service: "session-compaction",
          level: "info",
          message: "self-check passed",
        },
      })
      return
    }
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "error",
        message: "self-check failed",
        extra: { missing: missing ?? [] },
      },
    })
  } catch {
    // Swallow: `app.log` itself may be the missing surface on
    // the failure path. The module-scoped `selfCheckResult` flag
    // is set independently so handlers short-circuit per R7.4
    // even when no log entry reaches opencode.
  }
}

/**
 * Emit the per-session startup record (R6.5). Called by task 3.1's
 * `session.created` handler immediately after `initializeSession`.
 * The full `ThresholdConfig` snapshot is included so the operator
 * can later confirm which threshold values were active for any
 * historical session.
 */
export async function logSessionStart(
  client: PluginClient,
  sessionID: string,
  parentID: string | null,
  agentName: string | null,
  config: ThresholdConfig,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "session started",
        extra: {
          sessionID,
          parentID,
          agentName,
          thresholdTokens: config.thresholdTokens,
          thresholdWallTimeHours: config.thresholdWallTimeHours,
          cooldownMinutes: config.cooldownMinutes,
          augmentationEnabled: config.augmentationEnabled,
          watchSubagents: config.watchSubagents,
          subagentAllowlist: config.subagentAllowlist,
          cavememContextTimeoutMillis:
            config.cavememContextTimeoutMillis,
        },
      },
    })
  } catch {
    // Swallow per Logger Contract: logging is never load-bearing.
  }
}

/**
 * Emit the session-idle summary (R6.5). Called by task 3.5's
 * `session.idle` handler. Carries the per-session aggregates so
 * the operator can correlate idle-time totals with cost-diagnostic
 * data without re-deriving them from raw messages.
 */
export async function logSessionIdle(
  client: PluginClient,
  sessionID: string,
  summary: {
    readonly turnCount: number
    readonly totalInputTokens: number
    readonly wallTimeMillis: number
    readonly compactionEvents?: number
  },
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "session idle",
        extra: {
          sessionID,
          turnCount: summary.turnCount,
          totalInputTokens: summary.totalInputTokens,
          wallTimeMillis: summary.wallTimeMillis,
          compactionEvents: summary.compactionEvents ?? 0,
        },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit "compaction triggered" (R6.1). Called by CompactionInvoker
 * on the success path immediately after registering the attempt
 * in `inFlightAttempts`. Carries the full `CompactionAttempt`
 * fields so the operator can attribute the event to its origin
 * (`automatic` | `manual` | `external`).
 */
export async function logTrigger(
  client: PluginClient,
  attempt: CompactionAttempt,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "compaction triggered",
        extra: {
          sessionID: attempt.sessionID,
          trigger: attempt.trigger,
          reason: attempt.reason,
          timestamp: attempt.timestamp,
        },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit "compaction suppressed" (R6.4). Called by task 3.2's
 * threshold-trip path when `evaluateThreshold` returns
 * `shouldCompact: false` for a session that has produced LLM
 * turns. The `reason` string is the evaluator's own reason
 * (e.g. `"in_cooldown:120s_remaining"`, `"tokens_disabled"`).
 */
export async function logSuppression(
  client: PluginClient,
  sessionID: string,
  reason: string,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "compaction suppressed",
        extra: { sessionID, reason },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit "augmentation pushed" (R6.2). Called by task 3.4's
 * `experimental.session.compacting` handler after pushing
 * cavemem context onto `output.context`. The `source` field
 * names the augmenting context's origin (e.g. `"cavemem search"`)
 * so the operator can later determine what was injected.
 */
export async function logAugmentation(
  client: PluginClient,
  sessionID: string,
  source: string,
  lengthChars: number,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "augmentation pushed",
        extra: {
          sessionID,
          augmentationSource: source,
          augmentationLengthChars: lengthChars,
        },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit "session compacted" (R6.1). Called by task 3.6's
 * `session.compacted` handler — this is the post-compaction
 * observation that records the trigger attribution. The
 * `trigger` parameter is the result of inspecting
 * `consumeInFlightAttempt(sessionID)`: an in-flight attempt
 * means the plugin initiated the compaction (use the attempt's
 * trigger); no attempt means opencode-native (use `"external"`).
 */
export async function logCompacted(
  client: PluginClient,
  sessionID: string,
  trigger: CompactionTrigger,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "info",
        message: "session compacted",
        extra: { sessionID, trigger },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit a handler-scope failure (R7.5). Called by any handler that
 * catches an error it does not propagate. `err.context` names the
 * code site (e.g. `"invokeCompaction"`, `"sessionCreatedHandler"`)
 * so the operator can attribute failures without re-deriving
 * cause from the message text.
 */
export async function logError(
  client: PluginClient,
  sessionID: string,
  err: { readonly message: string; readonly context: string },
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "error",
        message: "session-compaction error",
        extra: {
          sessionID,
          errorMessage: err.message,
          context: err.context,
        },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

/**
 * Emit a handler-scope benign degradation (design §Error Handling,
 * R5.6). Same shape as `logError` but at `level: "warn"`, for
 * paths where the plugin gracefully continues despite a broken
 * dependency — e.g. the subagent observability path being
 * unavailable while `watchSubagents` is enabled. The `context`
 * field names the code site so the operator can attribute the
 * warning without parsing the message text.
 */
export async function logWarn(
  client: PluginClient,
  sessionID: string,
  payload: { readonly message: string; readonly context: string },
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "session-compaction",
        level: "warn",
        message: payload.message,
        extra: { sessionID, context: payload.context },
      },
    })
  } catch {
    // Swallow per Logger Contract.
  }
}

// ============================================================
// Plugin bootstrap: config loader, ignore set, session.created
// handler (task 3.1)
// ============================================================
//
// The first event-handler wiring on the plugin's exported
// function. Earlier seams (SessionTokenTracker, ThresholdEvaluator,
// CompactionInvoker, CavememContextSource, SessionCompactionLogger,
// PluginSelfCheck) were declared as pure modules with no runtime
// connection to opencode's event bus. This section closes the gap
// for `session.created`:
//
//   1. `loadConfigFromEnv()` parses the seven SESSION_COMPACTION_*
//      env vars the HM module exports (task 1.3) into a typed
//      `ThresholdConfig`. The trichotomy parser
//      (`parseSubagentAllowlist`) honors the same sentinel scheme
//      documented in session-compaction.nix lines 128-137:
//        - unset / empty   → match-any
//        - "__MATCH_NONE__" → match-none
//        - "a,b,c"          → match-listed
//      Conflating any two of those would silently misconfigure the
//      watcher (R5.5).
//
//   2. Module-scoped state:
//        - `pluginConfig` — lazy-loaded ThresholdConfig snapshot,
//          cached for the plugin process lifetime. `getOrLoadConfig`
//          is the only reader/writer.
//        - `ignoredSessions` — Set of sessionIDs that should be
//          skipped by every other handler (tasks 3.2, 3.6 consult
//          via `isSessionIgnored`). Populated by the gating logic
//          below: non-watched subagents, allowlist misses.
//        - `subagentObservabilityWarned` — R5.6 one-time warn flag.
//          Flips true after the first failed `client.session.get`
//          while `watchSubagents` is enabled, so the operator sees
//          exactly one error entry per plugin lifetime instead of
//          one per subagent.
//
//   3. `session.created` handler — the runtime entry point:
//        a. Run the self-check; short-circuit if it has failed
//           (R7.4).
//        b. Lazy-load the config snapshot (idempotent).
//        c. Read `parentID` and `agent` from `client.session.get`.
//           Read failure is graceful: state is still initialized
//           with null parent/agent so later handlers don't NPE,
//           and the warn-once R5.6 path fires when applicable.
//        d. Initialize `SessionState` via the task-2.1 seam.
//        e. Apply subagent gating: subagents (parentID !== null)
//           are added to `ignoredSessions` when watchSubagents is
//           off, or when the allowlist trichotomy excludes them.
//        f. Emit the R6.5 session-start log carrying the active
//           config snapshot so the operator can later audit which
//           threshold values were live for any historical session.

const SUBAGENT_ALLOWLIST_MATCH_NONE_SENTINEL = "__MATCH_NONE__"

/**
 * Parse the `SESSION_COMPACTION_SUBAGENT_ALLOWLIST` env var into
 * the discriminated-union shape `ThresholdConfig.subagentAllowlist`
 * declares. Trichotomy contract (mirrors session-compaction.nix
 * lines 128-137):
 *   - undefined OR empty string → `{ kind: "match-any" }`
 *   - exactly `"__MATCH_NONE__"` → `{ kind: "match-none" }`
 *   - otherwise → split on ",", trim each element, drop empties,
 *     return `{ kind: "match-listed", agents }`. A list that ends
 *     up empty after trimming (e.g. raw input was just commas)
 *     falls back to `match-any` rather than silently degenerating
 *     into a no-op match-none.
 */
function parseSubagentAllowlist(
  raw: string | undefined,
): SubagentAllowlist {
  if (raw === undefined || raw.length === 0) {
    return { kind: "match-any" }
  }
  if (raw === SUBAGENT_ALLOWLIST_MATCH_NONE_SENTINEL) {
    return { kind: "match-none" }
  }
  const agents = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (agents.length === 0) {
    return { kind: "match-any" }
  }
  return { kind: "match-listed", agents }
}

/**
 * Parse a non-negative integer from an env var. Returns `fallback`
 * when the value is missing, empty, non-numeric, or negative.
 * Centralized so every numeric env var follows the same parsing
 * contract.
 */
function parseNonNegativeIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/**
 * Parse the HM module's boolean env-var convention: `"1"` is true,
 * everything else (including `"0"`, unset, empty, and any other
 * value) is false. Matches `${if cfg.X then "1" else "0"}` exactly.
 */
function parseBoolEnv(raw: string | undefined): boolean {
  return raw === "1"
}

/**
 * Read the seven SESSION_COMPACTION_* env vars the HM module
 * exports (task 1.3) into a `ThresholdConfig`. Token and wall-time
 * threshold axes are normalized so `0` → `null` per R2.8 (the
 * canonical "disabled" form in the type signature; the evaluator
 * already treats both as disabled but the type contract prefers
 * `null`).
 *
 * Called exactly once per plugin process via `getOrLoadConfig`;
 * lazy on the first event so test harnesses (task 4.x) that set
 * env vars after `require()` still see the right values.
 */
function loadConfigFromEnv(): ThresholdConfig {
  const tokens = parseNonNegativeIntEnv(
    process.env.SESSION_COMPACTION_THRESHOLD_TOKENS,
    0,
  )
  const wallHours = parseNonNegativeIntEnv(
    process.env.SESSION_COMPACTION_THRESHOLD_WALL_HOURS,
    0,
  )
  return {
    thresholdTokens: tokens > 0 ? tokens : null,
    thresholdWallTimeHours: wallHours > 0 ? wallHours : null,
    cooldownMinutes: parseNonNegativeIntEnv(
      process.env.SESSION_COMPACTION_COOLDOWN_MINUTES,
      0,
    ),
    augmentationEnabled: parseBoolEnv(
      process.env.SESSION_COMPACTION_AUGMENTATION_ENABLED,
    ),
    watchSubagents: parseBoolEnv(
      process.env.SESSION_COMPACTION_WATCH_SUBAGENTS,
    ),
    subagentAllowlist: parseSubagentAllowlist(
      process.env.SESSION_COMPACTION_SUBAGENT_ALLOWLIST,
    ),
    cavememContextTimeoutMillis: resolveCavememTimeoutMillis(),
  }
}

// Module-scoped, lazy-loaded config snapshot. `null` until the
// first event triggers `getOrLoadConfig`. Mutable (so `let`); the
// only writer is `getOrLoadConfig`.
let pluginConfig: ThresholdConfig | null = null

/**
 * Idempotent config accessor. First call invokes
 * `loadConfigFromEnv()` and caches the result; subsequent calls
 * return the cached snapshot. The plugin's effective configuration
 * is therefore frozen at the first received event and stable for
 * the rest of the process lifetime — a deliberate choice so the
 * config snapshot logged in `logSessionStart` (R6.5) matches what
 * the rest of the plugin's handlers actually use.
 */
function getOrLoadConfig(): ThresholdConfig {
  if (pluginConfig === null) {
    pluginConfig = loadConfigFromEnv()
  }
  return pluginConfig
}

// Module-scoped set of sessionIDs that subsequent handlers
// (tasks 3.2 message.updated, 3.6 session.compacted) must skip.
// Populated by the gating logic in the `session.created` handler:
// non-watched subagents (R5.2), or subagents excluded by the
// allowlist trichotomy (R5.5).
const ignoredSessions: Set<string> = new Set()

/**
 * Read-only predicate over the ignore set. True for sessions that
 * the `session.created` handler classified as out-of-scope. Tasks
 * 3.2 and 3.6 consult this at handler entry to short-circuit.
 * Exported (not just module-scoped) because those handlers live
 * in this same file but are exercised by integration tests
 * (task 5.4) that import the predicate directly.
 */
export function isSessionIgnored(sessionID: string): boolean {
  return ignoredSessions.has(sessionID)
}

// R5.6 warn-once flag. Set on the first `client.session.get`
// failure observed while `watchSubagents` is enabled; never reset.
// Module-scoped so the warn fires exactly once per plugin process
// regardless of how many subagent sessions hit the same gap.
let subagentObservabilityWarned: boolean = false

export const SessionCompactionPlugin: Plugin = async (ctx) => {
  // Bridge opencode's runtime client type to our minimal
  // PluginClient interface. The double cast through `unknown`
  // avoids `any` while expressing that the runtime shape and our
  // local interface are structurally compatible but nominally
  // unrelated — opencode does not re-export its SDK Client type
  // from `@opencode-ai/plugin`.
  const client = ctx.client as unknown as PluginClient
  return {
    "session.created": async (input: { info: { id: string } }) => {
      // R7.4 short-circuit: every handler runs the self-check on
      // entry. After the first event (any kind), subsequent calls
      // return the cached result instantly.
      await runSelfCheckIfNeeded(client)
      if (getSelfCheckResult() === "failed") return

      // Lazy-load the operator's config snapshot. Idempotent
      // across the plugin process lifetime; subsequent handlers
      // see the same instance.
      const config = getOrLoadConfig()

      // Read parentID and agent name from opencode. Failure is
      // non-fatal: we still initialize the session with null
      // values so later handlers do not NPE, and we emit a single
      // R5.6 warn-once entry if the observability path is broken
      // but `watchSubagents` was requested.
      let parentID: string | null = null
      let agentName: string | null = null
      try {
        const result = await client.session.get({
          path: { id: input.info.id },
        })
        const session = result as {
          readonly parentID?: string | null
          readonly agent?: string | null
        }
        parentID = session.parentID ?? null
        agentName = session.agent ?? null
      } catch {
        if (config.watchSubagents && !subagentObservabilityWarned) {
          subagentObservabilityWarned = true
          // R5.6: benign degradation — main-thread coverage
          // continues, so this is warn-level, not error-level.
          await logWarn(client, input.info.id, {
            message:
              "subagent observability check failed; " +
              "main-thread coverage continues",
            context: "session.created",
          })
        }
      }

      // Initialize state via the task-2.1 seam. Idempotent: a
      // repeat session.created event for the same sessionID
      // leaves any existing in-flight aggregates alone.
      initializeSession(input.info.id, parentID, agentName, Date.now())

      // Subagent gating (R5.1, R5.2, R5.3, R5.5). A null parentID
      // means main-thread session — never ignored. A non-null
      // parentID means subagent: gate on the operator's
      // watchSubagents toggle and, when enabled, the allowlist
      // trichotomy.
      const isSubagent = parentID !== null
      if (isSubagent) {
        if (!config.watchSubagents) {
          // R5.2: subagent watch off → ignore every subagent.
          ignoredSessions.add(input.info.id)
        } else {
          // R5.5: allowlist gates which subagents we track.
          const allow = config.subagentAllowlist
          if (allow.kind === "match-none") {
            ignoredSessions.add(input.info.id)
          } else if (allow.kind === "match-listed") {
            // Subagent must declare an agent name AND it must
            // be on the list. A subagent with no agent name
            // (opencode runtime variant) cannot be allowlisted
            // by definition, so it is ignored.
            if (
              agentName === null ||
              !allow.agents.includes(agentName)
            ) {
              ignoredSessions.add(input.info.id)
            }
          }
          // allow.kind === "match-any" → never added to the set.
        }
      }

      // R6.5: emit the session-start record carrying the active
      // config snapshot so historical sessions can be audited
      // against the configuration that was live at startup.
      await logSessionStart(
        client,
        input.info.id,
        parentID,
        agentName,
        config,
      )
    },
    // ============================================================
    // message.updated handler (task 3.2)
    // ============================================================
    //
    // The runtime driver of the automatic-compaction path. On every
    // `message.updated` event opencode emits, this handler:
    //
    //   1. Runs the startup self-check; short-circuits the rest of
    //      the handler if it has failed (R7.4).
    //   2. Skips sessions the task-3.1 gating logic flagged as
    //      out-of-scope — unwatched subagents, allowlist misses
    //      (R5.2, R5.5). Skipping happens BEFORE token aggregation
    //      so ignored sessions never grow plugin-side state.
    //   3. Feeds the message through the SessionTokenTracker seam
    //      (task 2.1). UserMessages are no-ops inside `recordMessage`;
    //      only AssistantMessages with a `tokens` payload advance the
    //      per-session aggregates and turnCount.
    //   4. Reads `Session.time.compacting` via `client.session.get`
    //      to source the cooldown signal (Decision D.7 in design
    //      §Implementation Notes — the cooldown is anchored to the
    //      most recent compaction tracked by opencode itself, not to
    //      a plugin-side counter). A missing field, a null value, or
    //      a thrown SDK error are all treated as "never compacted":
    //      `lastCompactionAt = null` so `evaluateThreshold` does not
    //      apply a cooldown window. Per R2.9, the SDK failure must
    //      not block the handler.
    //   5. Runs `evaluateThreshold` (task 2.2) — the pure decision
    //      function — with a single `now = Date.now()` captured once
    //      and passed verbatim to `invokeCompaction` so the threshold
    //      evaluation and the resulting attempt timestamp agree.
    //   6. On `shouldCompact: true` → `invokeCompaction` (task 2.4),
    //      attributed `"automatic"`. The return value is discarded;
    //      success and failure are both self-logged inside the
    //      invoker (R7.5: no caller-side re-emit).
    //   7. On `shouldCompact: false` → `logSuppression` (task 2.6)
    //      with the evaluator's reason string so the operator can
    //      grep for why a session is not compacting (R6.4). The
    //      `zero_turns` path (R2.10) also flows through here:
    //      UserMessage-only sessions never trip a token or wall-time
    //      threshold, so the evaluator returns `zero_turns` and the
    //      suppression log fires.
    //
    // The handler is `async` and never throws: every external call is
    // either pure, internally try/caught, or wrapped here.
    "message.updated": async (input: { info: MessageInfo }) => {
      // R7.4 short-circuit: every handler runs the self-check on
      // entry. After the first event (any kind), subsequent calls
      // return the cached result instantly.
      await runSelfCheckIfNeeded(client)
      if (getSelfCheckResult() === "failed") return

      const sessionID = input.info.sessionID
      // R5.2 / R5.5: skip sessions classified as out-of-scope by
      // the task-3.1 gating logic. Short-circuit BEFORE recordMessage
      // so ignored sessions do not accumulate plugin-side state.
      if (isSessionIgnored(sessionID)) return

      // Update per-message token aggregates via the task-2.1 seam.
      // UserMessages (no `tokens` payload) are no-ops inside the
      // tracker; AssistantMessages advance the per-session totals
      // and turnCount.
      recordMessage(sessionID, input.info)

      // Defensive: a `message.updated` without a prior
      // `session.created` (out-of-order events, plugin reload mid-
      // session, etc.) has no SessionState to evaluate against.
      // Skip rather than fabricate a synthetic state.
      const state = sessionStates.get(sessionID)
      if (!state) return

      const config = getOrLoadConfig()

      // Decision D.7 (design §Implementation Notes): the cooldown
      // signal is sourced from `Session.time.compacting` rather than
      // a plugin-side timestamp so it survives plugin reload and so
      // multiple plugin instances cannot disagree about the cooldown
      // window. A read failure, a missing `time` field, or a missing
      // `compacting` sub-field are all treated as "never compacted"
      // (null) — graceful per R2.9; the threshold evaluator simply
      // skips the cooldown clause.
      let lastCompactionAt: number | null = null
      try {
        const result = await client.session.get({
          path: { id: sessionID },
        })
        const session = result as {
          readonly time?: {
            readonly compacting?: number | null
          }
        }
        lastCompactionAt = session.time?.compacting ?? null
      } catch {
        lastCompactionAt = null
      }

      // Capture `now` once so the evaluator and any resulting
      // `invokeCompaction` attempt agree on the timestamp.
      const now = Date.now()
      const decision = evaluateThreshold(
        state,
        config,
        lastCompactionAt,
        now,
      )

      if (decision.shouldCompact) {
        // R2.3 / R2.5: token or wall-time threshold tripped.
        // CompactionInvoker self-logs both success (R6.1) and
        // failure (R7.5); we discard the result.
        await invokeCompaction(
          client,
          sessionID,
          "automatic",
          decision.reason,
          now,
        )
      } else {
        // R6.4: every suppression carries the evaluator's reason
        // so the operator can attribute the miss without re-
        // deriving cause. R2.7 in-cooldown and R2.10 zero-turn
        // paths both flow through here.
        await logSuppression(client, sessionID, decision.reason)
      }
    },
  }
}
