/*
 * external-trigger.test.ts — integration test for the
 * `session.compacted` trigger-attribution discriminator (task 5.5
 * of .kiro/specs/session-compaction).
 *
 * Covers design §Components / SessionCompactionPlugin's
 * `session.compacted` handler and the design's Critical Issue 2
 * fix description (external attribution). The handler's
 * attribution rule is:
 *
 *   const attempt = consumeInFlightAttempt(input.sessionID)
 *   const trigger: CompactionTrigger = attempt?.trigger ?? "external"
 *
 * Two paths therefore exist into `logCompacted`'s `body.extra.trigger`:
 *
 *   - Plugin-initiated: `invokeCompaction` registered a
 *     `CompactionAttempt` before opencode fired `session.compacted`.
 *     Trigger attributed to the attempt's own trigger value
 *     (`"automatic"` for the threshold path, `"manual"` for the
 *     `/compact` path).
 *   - opencode-initiated ("external"): no in-flight attempt exists
 *     for the session. Trigger attributed to the literal
 *     `"external"`, distinguishing opencode-native compactions from
 *     anything the plugin triggered.
 *
 * This file drives both paths through one Node process to prove
 * the discriminator works in BOTH directions — a one-sided test
 * (only `"external"` or only `"automatic"`) would not catch a
 * regression where the handler ignored `consumeInFlightAttempt`
 * altogether and hard-coded one variant.
 *
 *   Scenario A — automatic-trigger positive control (R6.1):
 *     1. `session.created` initializes per-session state as a
 *        main-thread session (parentID=null, agent=null), keeping
 *        the session OUT of the subagent ignore set.
 *     2. `message.updated` with an AssistantMessage tripping the
 *        configured 100-token threshold funnels through
 *        `invokeCompaction("automatic", …)`, which registers a
 *        `CompactionAttempt` in `inFlightAttempts`.
 *     3. `session.compacted` consumes the attempt and emits
 *        `logCompacted(…, trigger="automatic")` — i.e. one
 *        `app.log` entry shaped
 *        `{ service: "session-compaction", level: "info", message:
 *        "session compacted", extra: { sessionID, trigger:
 *        "automatic" } }`.
 *     4. Post-handler, `consumeInFlightAttempt(<scenario-A
 *        sessionID>)` returns `null`, proving the handler cleared
 *        the entry. This is the "inFlightAttempts map is cleared
 *        after each matched event" observable in the task brief.
 *
 *   Scenario B — external-trigger negative path (R6.1, R6.2):
 *     1. A fresh sessionID is fired into `session.compacted`
 *        DIRECTLY, with NO preceding `session.created`,
 *        `message.updated`, or `command.executed` for that ID.
 *        `inFlightAttempts` therefore has no entry for the
 *        session.
 *     2. `consumeInFlightAttempt` returns null inside the handler;
 *        the discriminator falls through to `"external"`.
 *     3. `logCompacted(…, trigger="external")` fires — one
 *        `app.log` entry with `extra.trigger === "external"` and
 *        `extra.sessionID` equal to scenario B's sessionID.
 *
 * Requirements observably satisfied:
 *   - R6.1 (observable compaction events): each `session.compacted`
 *     produces exactly one `app.log` "session compacted" record
 *     carrying the attribution.
 *   - R6.2 (operator can reconstruct provenance): the
 *     discriminator distinguishes plugin-initiated compactions
 *     ("automatic" here) from opencode-native compactions
 *     ("external"), proving the operator can grep `extra.trigger`
 *     to recover provenance after the fact.
 *
 * Runner: `node --test` via `opencode-cost-diagnosis-node`. Node
 * 22 with `--experimental-strip-types` strips type annotations at
 * load time and imports the `.ts` source module directly. `node
 * --test <files>` runs every test file in its own worker, so the
 * impl module's module-scoped latches (`selfCheckResult`,
 * `pluginConfig`, `sessionStates`, `ignoredSessions`,
 * `inFlightAttempts`) start fresh for this file's process and are
 * not polluted by the other suites listed alongside it on the
 * same command line.
 *
 * Module-state caveat (intra-file)
 * --------------------------------
 * Inside this file the impl module's module-scoped state DOES
 * persist across `it()` blocks. To keep the two scenarios
 * independent we:
 *
 *   - use DISTINCT sessionIDs per scenario, so per-session state
 *     maps (`sessionStates`, `inFlightAttempts`, etc.) carry
 *     independent entries that cannot leak across scenarios; and
 *   - capture call args on a FRESH mock-client harness per `it()`
 *     so the assertion arrays start empty regardless of test
 *     declaration order. The `selfCheckResult` latch becomes
 *     `"ok"` on the first `it()`'s first handler entry and
 *     short-circuits subsequent `runSelfCheckIfNeeded` calls in
 *     the second `it()`; both harnesses build the same fully-
 *     shaped client so the latch is correct regardless.
 *
 * Scenario order: Scenario A runs first. Its `session.compacted`
 * handler MUST clear the `inFlightAttempts` entry it consumes; the
 * post-handler `consumeInFlightAttempt` assertion proves it. If
 * Scenario A were to leak an entry, that's a regression in the
 * handler — but it would not affect Scenario B because Scenario B
 * uses a different sessionID. The two are independent by
 * construction.
 *
 * `consumeInFlightAttempt` is destructive. If Scenario A's handler
 * regressed (left an entry), the post-handler `consumeInFlightAttempt`
 * call would remove it. That's acceptable — the assertion is
 * `=== null`, and the failure case (`!== null`) leaves no state for
 * subsequent assertions in the same block to worry about.
 *
 * Env-var ordering: `loadConfigFromEnv()` is LAZY — it runs the
 * first time `getOrLoadConfig()` is called inside a handler, not
 * at module-load time. Setting env vars at module scope below
 * (after the impl-module import) is therefore observed correctly
 * provided no handler invocation precedes the assignment. We
 * assign env vars at top-of-file scope before any `describe`/`it`.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"

import {
  consumeInFlightAttempt,
  createHooks,
  type MessageInfo,
  type PluginClient,
} from "../../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

// ---------------------------------------------------------------
// Test configuration via env vars
// ---------------------------------------------------------------
//
// AssistantMessage tokens below total `input(100) + cacheRead(200)
// = 300` by the evaluator's formula. A threshold of 100 means
// 300 > 100 trips `tokens_exceeded` on the very first
// AssistantMessage, exactly what Scenario A needs.
//
process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100"

// Literal `body.message` the impl emits from `logCompacted`
// (session-compaction-impl.ts:1155). Hardcoded here so a future
// copy edit to the impl is caught by this test rather than
// silently changing the post-compaction observation surface.
const COMPACTED_LOG_MESSAGE = "session compacted"

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

interface CapturedLog {
  readonly service: string
  readonly level: "info" | "warn" | "error" | "debug"
  readonly message: string
  readonly extra?: Record<string, unknown>
}

interface CapturedSummarize {
  readonly path: { readonly id: string }
  readonly body: Record<string, unknown>
}

interface MockClientHarness {
  readonly client: PluginClient
  readonly summarizeCalls: CapturedSummarize[]
  readonly logs: CapturedLog[]
  readonly toastCalls: Array<{ readonly message: string }>
}

/**
 * Build a fully-shaped `PluginClient` so the startup self-check
 * latches `"ok"` on first handler entry. `session.get` returns
 * the subset of the opencode Session that the plugin's handlers
 * read:
 *
 *   - session.created reads `parentID` and `agent`; null for both
 *     → main-thread session, never added to the ignore set.
 *   - message.updated reads `time.compacting`; null → the session
 *     has never been compacted, so the cooldown gate is skipped.
 *
 * The double-cast through `unknown` mirrors
 * `automatic-flow.test.ts:176` and `manual-flow.test.ts:225`: it
 * is the minimum disturbance required to satisfy `PluginClient`'s
 * readonly structure while allowing the captured-args arrays to
 * be plain mutable arrays.
 */
function makeMockClient(): MockClientHarness {
  const summarizeCalls: CapturedSummarize[] = []
  const logs: CapturedLog[] = []
  const toastCalls: Array<{ readonly message: string }> = []
  const client = {
    session: {
      summarize: async (params: {
        readonly path: { readonly id: string }
        readonly body: Record<string, unknown>
      }) => {
        summarizeCalls.push({ path: params.path, body: params.body })
        return true
      },
      get: async (_params: { readonly path: { readonly id: string } }) => ({
        parentID: null,
        agent: null,
        time: { compacting: null },
      }),
    },
    app: {
      log: async (params: { readonly body: CapturedLog }) => {
        logs.push(params.body)
        return true
      },
    },
    tui: {
      showToast: async (params: {
        readonly body: {
          readonly message: string
          readonly variant: "info" | "success" | "warning" | "error"
        }
      }) => {
        toastCalls.push({ message: params.body.message })
        return true
      },
    },
  } as unknown as PluginClient
  return { client, summarizeCalls, logs, toastCalls }
}

/**
 * Construct an AssistantMessage shaped to trip the configured
 * 100-token threshold on a single `message.updated`:
 *   total = tokens.input + tokens.cache.read = 100 + 200 = 300
 *   threshold = 100 → 300 > 100 fires `tokens_exceeded:300`.
 */
function assistantMessage(
  sessionID: string,
  messageID: string,
): MessageInfo {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 200, write: 0 },
    },
  }
}

/**
 * Filter captured logs to the `session compacted` entries for a
 * specific sessionID. The impl emits multiple log entries during
 * a single compaction (one `compaction triggered` from
 * `invokeCompaction`, then one `session compacted` from the
 * `session.compacted` handler), and Scenario A's harness will
 * capture both. The trigger-attribution observable lives on the
 * latter ONLY — filtering by message AND by `extra.sessionID`
 * isolates the assertion target unambiguously.
 */
function compactedLogsFor(
  logs: readonly CapturedLog[],
  sessionID: string,
): readonly CapturedLog[] {
  return logs.filter(
    (l) =>
      l.message === COMPACTED_LOG_MESSAGE &&
      typeof l.extra === "object" &&
      l.extra !== null &&
      (l.extra as { readonly sessionID?: unknown }).sessionID === sessionID,
  )
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("session.compacted trigger attribution — R6.1 + R6.2", () => {
  it("automatic positive control: session.created → message.updated past threshold → session.compacted produces extra.trigger==='automatic' and clears inFlightAttempts", async () => {
    const sessionID = "ses_attrib_automatic"
    const messageID = "msg_attrib_automatic_a"

    const harness = makeMockClient()
    const hooks = createHooks(harness.client)

    // ----- Step 1: session.created -----
    // Initializes per-session state with parentID=null,
    // agent=null → main-thread session, not subagent-ignored.
    // Also runs the startup self-check; the fully-shaped mock
    // makes it latch `"ok"`.
    await hooks["session.created"]({ info: { id: sessionID } })

    // Sanity: no compaction has been triggered yet, and no
    // attempt is in flight. `consumeInFlightAttempt` returns
    // `null` for unknown sessionIDs — this baseline read is
    // safe and non-destructive (the impl deletes only when a
    // matching entry is present).
    assert.equal(
      consumeInFlightAttempt(sessionID),
      null,
      "no in-flight attempt should exist before message.updated trips the threshold",
    )

    // ----- Step 2: message.updated (AssistantMessage) -----
    // Tokens 100/200 total 300; threshold 100 → trip.
    // `invokeCompaction` is called with trigger="automatic",
    // calls `client.session.summarize` exactly once, and
    // registers a `CompactionAttempt` in `inFlightAttempts` on
    // success. We do not assert on the in-flight state from
    // outside here — `consumeInFlightAttempt` is destructive,
    // and consuming it before `session.compacted` runs would
    // invalidate the test. The downstream
    // `session.compacted` assertion is the indirect proof
    // that the attempt was registered.
    await hooks["message.updated"]({
      info: assistantMessage(sessionID, messageID),
    })

    assert.equal(
      harness.summarizeCalls.length,
      1,
      `expected exactly one client.session.summarize call after threshold trip; got ${harness.summarizeCalls.length}`,
    )

    // ----- Step 3: session.compacted -----
    // opencode fires this hook after running its native
    // summary. The handler consumes the in-flight attempt
    // (trigger="automatic"), emits `logCompacted`, and
    // re-anchors `startedAt`. We assert the attribution and
    // the clearing of `inFlightAttempts` separately.
    await hooks["session.compacted"]({ sessionID })

    // R6.1 + R6.2: exactly one `session compacted` log entry
    // for THIS sessionID, with `extra.trigger === "automatic"`.
    // Filtering by sessionID isolates the assertion target
    // from any Scenario-B logs that might appear later in the
    // same process (separate `it()` block uses a separate
    // harness, but module-scoped session state can still
    // cross-pollute).
    const compactedLogs = compactedLogsFor(harness.logs, sessionID)
    assert.equal(
      compactedLogs.length,
      1,
      `expected exactly one "${COMPACTED_LOG_MESSAGE}" log for ${sessionID}; got ${compactedLogs.length}: ${JSON.stringify(compactedLogs)}`,
    )
    const compactedLog = compactedLogs[0]
    assert.equal(
      compactedLog.service,
      "session-compaction",
      `compacted log must declare service="session-compaction" (R6.1 attribution); got ${JSON.stringify(compactedLog.service)}`,
    )
    assert.equal(
      compactedLog.level,
      "info",
      `compacted log must be level="info" (R6.1 surface), not error/warn; got ${JSON.stringify(compactedLog.level)}`,
    )
    assert.equal(
      (compactedLog.extra as { readonly trigger?: unknown }).trigger,
      "automatic",
      `plugin-initiated automatic path must produce extra.trigger="automatic" (R6.2 discriminator); got ${JSON.stringify(compactedLog.extra)}`,
    )

    // Observable from the task brief: "the `inFlightAttempts`
    // map is cleared after each matched event". The
    // `session.compacted` handler already consumed the
    // attempt; a second `consumeInFlightAttempt` for the same
    // sessionID MUST return `null`. If a non-null entry
    // appears, the handler regressed (did not consume); the
    // failure-side destructive call clears it anyway, leaving
    // no state for subsequent tests.
    assert.equal(
      consumeInFlightAttempt(sessionID),
      null,
      `inFlightAttempts must be cleared for ${sessionID} after session.compacted consumes the entry (task brief observable); a non-null result means the handler did not call consumeInFlightAttempt`,
    )
  })

  it("external negative path: session.compacted for a sessionID with no preceding plugin-initiated attempt produces extra.trigger==='external'", async () => {
    // DIFFERENT sessionID from Scenario A so per-session
    // module-scoped state (sessionStates, inFlightAttempts)
    // cannot pollute this scenario. This sessionID is NEVER
    // passed through `session.created`, `message.updated`,
    // `command.executed`, or any other plugin-initiating
    // surface; the FIRST handler that sees it is
    // `session.compacted`.
    const sessionID = "ses_attrib_external"

    const harness = makeMockClient()
    const hooks = createHooks(harness.client)

    // Sanity: there is no in-flight attempt for this session.
    // `consumeInFlightAttempt` returns null for unknown
    // sessionIDs and is a no-op when the map has no matching
    // entry, so this read is non-destructive.
    assert.equal(
      consumeInFlightAttempt(sessionID),
      null,
      `precondition: external scenario must start with no in-flight attempt for ${sessionID}`,
    )

    // ----- session.compacted (sole event) -----
    // No preceding plugin-initiated attempt → discriminator
    // falls through to `"external"`. The handler should still
    // produce exactly one `logCompacted` entry; the
    // `resetStartedAt` call inside is a no-op for unknown
    // sessions (impl comment at lines 2055-2058).
    await hooks["session.compacted"]({ sessionID })

    // R6.1 + R6.2 (Critical Issue 2 fix): exactly one
    // `session compacted` log entry for THIS sessionID, with
    // `extra.trigger === "external"`. Filtering by sessionID
    // disambiguates from Scenario A's log (which used a
    // different sessionID but lives in the same harness if
    // tests were ever to share one — they don't here, but the
    // filter is cheap defensive code).
    const compactedLogs = compactedLogsFor(harness.logs, sessionID)
    assert.equal(
      compactedLogs.length,
      1,
      `expected exactly one "${COMPACTED_LOG_MESSAGE}" log for ${sessionID}; got ${compactedLogs.length}: ${JSON.stringify(compactedLogs)}`,
    )
    const compactedLog = compactedLogs[0]
    assert.equal(
      compactedLog.service,
      "session-compaction",
      `compacted log must declare service="session-compaction" (R6.1); got ${JSON.stringify(compactedLog.service)}`,
    )
    assert.equal(
      compactedLog.level,
      "info",
      `compacted log must be level="info" (R6.1 surface); got ${JSON.stringify(compactedLog.level)}`,
    )
    assert.equal(
      (compactedLog.extra as { readonly trigger?: unknown }).trigger,
      "external",
      `session.compacted with no preceding plugin attempt must produce extra.trigger="external" (R6.2 + design Critical Issue 2 fix); got ${JSON.stringify(compactedLog.extra)}`,
    )

    // Negative-space assertion: the external path NEVER calls
    // `client.session.summarize` itself (it is opencode that
    // ran the summary, not the plugin). A non-zero count
    // would mean the plugin spuriously self-triggered.
    assert.equal(
      harness.summarizeCalls.length,
      0,
      `external-trigger session.compacted must NOT call session.summarize (opencode already ran the summary); got ${harness.summarizeCalls.length} call(s): ${JSON.stringify(harness.summarizeCalls)}`,
    )

    // `consumeInFlightAttempt` was null both pre-handler and
    // (implicitly) inside the handler. Re-confirm post-
    // handler: still null. This protects against a regression
    // where the handler accidentally REGISTERED an attempt
    // instead of consuming one.
    assert.equal(
      consumeInFlightAttempt(sessionID),
      null,
      `external-trigger session.compacted must not leave a stale attempt for ${sessionID} (the handler must not register entries, only consume them)`,
    )
  })
})
