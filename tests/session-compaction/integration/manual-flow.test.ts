/*
 * manual-flow.test.ts — end-to-end integration test for the
 * manual `/compact` path (task 5.2 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Integration Tests #2
 * ("Manual `/compact` flow end-to-end") and the §Manual
 * Compaction Flow mermaid sequence diagram. Drives the
 * `createHooks(client)` factory exported by the impl module
 * across two synthetic-event sequences:
 *
 *   Scenario A — non-zero-turn manual /compact (R4.2 + R4.3):
 *     1. `session.created` initializes per-session state under the
 *        main-thread agent identity (parentID=null, agent=null), so
 *        the session is not put on the subagent ignore set.
 *     2. `message.updated` with ONE AssistantMessage advances
 *        `turnCount` to 1 without tripping the token threshold —
 *        the threshold is deliberately set very high so the
 *        automatic path cannot pre-empt the manual one. The
 *        suppression-log entry the evaluator emits here
 *        (`tokens_below_threshold` style) is harmless; we do not
 *        assert on it.
 *     3. `command.executed({ name: "compact", … })` lands on the
 *        manual handler's non-zero-turn branch, which funnels into
 *        the SAME `invokeCompaction` seam as the automatic path
 *        and produces exactly ONE `client.session.summarize` call.
 *     4. `experimental.session.compacting` then runs the
 *        augmentation handler unchanged — opencode itself fires
 *        this event after the plugin invokes `summarize`, and our
 *        manual /compact path produces no different augmentation
 *        chain than the automatic one (R4.3 = "identical to the
 *        automatic flow"). The handler invokes the PATH-stubbed
 *        cavemem and pushes the stub payload onto `output.context`.
 *
 *   Scenario B — zero-turn manual /compact (R4.4):
 *     1. `session.created` for a fresh sessionID — no
 *        `message.updated` ever follows, so `turnCount` stays at 0.
 *     2. `command.executed({ name: "compact", … })` lands on the
 *        zero-turn branch: `tui.showToast` fires with the literal
 *        `"Nothing to compact."` and variant `"info"`; no
 *        `client.session.summarize` call is made for this session.
 *
 * Requirements observably satisfied:
 *   - R4.2 (manual command triggers native compaction) —
 *     exactly one `client.session.summarize` call with
 *     `path.id === <Scenario A sessionID>` after the
 *     `command.executed` event.
 *   - R4.3 (manual augmentation identical to automatic) —
 *     `experimental.session.compacting` driven AFTER the manual
 *     `summarize` call pushes the cavemem stub payload onto
 *     `output.context` and leaves `output.prompt` undefined,
 *     proving the same handler chain that automatic-flow.test.ts
 *     (task 5.1) verifies.
 *   - R4.4 (zero-turn no-op) — the Scenario B sessionID gets zero
 *     `summarize` calls and exactly one toast with `variant ===
 *     "info"` and `message === "Nothing to compact."`.
 *
 * Runner: `node --test` via `opencode-cost-diagnosis-node`. Node
 * 22 with `--experimental-strip-types` strips type annotations at
 * load time and imports the `.ts` source module directly.
 *
 * Module-state caveat (intra-file)
 * --------------------------------
 * The impl module's `pluginConfig`, `selfCheckResult`,
 * `sessionStates`, `ignoredSessions`, `inFlightAttempts`, and
 * `lastErrorAt` are module-scoped and shared across every `it()`
 * block in this file. To keep the two scenarios independent we
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
 * Env vars are set once at the top of this file. `loadConfigFromEnv()`
 * is lazy (runs on the first handler entry), so any pre-handler
 * assignment is observed correctly. We intentionally pick a very
 * high token threshold so Scenario A's `message.updated` does NOT
 * automatically trip compaction — the only `summarize` call must
 * come from the manual /compact handler, otherwise the R4.2
 * assertion cannot distinguish the two trigger sources.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createHooks,
  type MessageInfo,
  type PluginClient,
} from "../../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

// ---------------------------------------------------------------
// Test configuration via env vars
// ---------------------------------------------------------------
//
// Threshold set very high (100,000 input+cacheRead tokens) so the
// Scenario A AssistantMessage (~300 tokens) cannot trip the
// automatic path. Only the explicit `command.executed` call
// should produce a `client.session.summarize` invocation, which
// makes the R4.2 assertion unambiguous.
//
// Augmentation enabled so the `experimental.session.compacting`
// handler reaches the cavemem stub (R4.3 requires the augmentation
// handler to fire identically for manual triggers).
//
// Cavemem timeout generous (10s) so slow CI runners spawning bash
// cannot SIGTERM the stub before it echoes.
process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100000"
process.env.SESSION_COMPACTION_AUGMENTATION_ENABLED = "1"
process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS = "10000"

// Recognizable sentinel emitted by the fake cavemem script.
// Asserting on a literal string rather than a regex keeps the
// failure message readable when the assertion regresses.
const STUB_CAVEMEM_PAYLOAD = "stub-cavemem-context-for-manual-flow"

// Literal toast message the impl emits on the zero-turn manual
// path (session-compaction-impl.ts:1731). Hardcoded here so a
// future copy edit to the impl is caught by this test rather
// than silently changing operator-visible UX.
const ZERO_TURN_TOAST_MESSAGE = "Nothing to compact."

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

interface CapturedToast {
  readonly message: string
  readonly variant: "info" | "success" | "warning" | "error"
}

interface MockClientHarness {
  readonly client: PluginClient
  readonly summarizeCalls: CapturedSummarize[]
  readonly logs: CapturedLog[]
  readonly toastCalls: CapturedToast[]
}

/**
 * Build a fully-shaped `PluginClient` so the startup self-check
 * latches `"ok"` on first handler entry. `session.get` returns the
 * subset of the opencode Session the plugin's handlers read:
 *
 *   - session.created reads `parentID` and `agent`; null for both
 *     → main-thread session, never added to the ignore set.
 *   - message.updated reads `time.compacting`; null → the session
 *     has never been compacted, so the cooldown gate is skipped.
 *
 * The double-cast through `unknown` mirrors `plugin-self-check
 * .test.ts:110` and `automatic-flow.test.ts:176`: it is the
 * minimum disturbance required to satisfy `PluginClient`'s
 * readonly structure while allowing the captured-args arrays to be
 * plain mutable arrays.
 *
 * `toastCalls` captures BOTH `message` AND `variant` (unlike
 * automatic-flow.test.ts which only needs `message`) because the
 * R4.4 zero-turn assertion requires the variant to equal
 * `"info"`.
 */
function makeMockClient(): MockClientHarness {
  const summarizeCalls: CapturedSummarize[] = []
  const logs: CapturedLog[] = []
  const toastCalls: CapturedToast[] = []
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
        toastCalls.push({
          message: params.body.message,
          variant: params.body.variant,
        })
        return true
      },
    },
  } as unknown as PluginClient
  return { client, summarizeCalls, logs, toastCalls }
}

interface FakeCavemem {
  readonly dir: string
  readonly cleanup: () => void
}

/**
 * Install an executable `cavemem` shell script that echoes
 * `STUB_CAVEMEM_PAYLOAD` to stdout and exits zero, then prepend
 * the script's tempdir to PATH so the impl module's
 * `spawn("cavemem", …)` resolves to our fake. Caller MUST invoke
 * the returned cleanup in a `finally` block to restore PATH and
 * remove the tempdir. Pattern lifted from
 * `cavemem-context-source.test.ts:73-92` and
 * `automatic-flow.test.ts:194-212`.
 */
function installFakeCavemem(): FakeCavemem {
  const dir = mkdtempSync(join(tmpdir(), "session-compaction-manual-"))
  const fakePath = join(dir, "cavemem")
  writeFileSync(
    fakePath,
    `#!/usr/bin/env bash\necho "${STUB_CAVEMEM_PAYLOAD}"\n`,
    { mode: 0o755 },
  )
  chmodSync(fakePath, 0o755)
  const originalPath = process.env.PATH ?? ""
  process.env.PATH = `${dir}:${originalPath}`
  return {
    dir,
    cleanup: (): void => {
      process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Construct an AssistantMessage shaped to bump `turnCount` by 1
 * without tripping the (100,000-token) automatic threshold. Token
 * counts are deliberately tiny so the math is obvious: total =
 * tokens.input + tokens.cache.read = 10 + 10 = 20, well below
 * 100,000. The exact totals are irrelevant — only the side effect
 * of `turnCount` advancing to 1 matters for this test.
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
      input: 10,
      output: 5,
      reasoning: 0,
      cache: { read: 10, write: 0 },
    },
  }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("manual /compact integration — R4.2 + R4.3 + R4.4", () => {
  it("non-zero-turn: command.executed routes through invokeCompaction and the augmentation handler pushes stubbed cavemem text onto output.context (R4.2, R4.3)", async () => {
    const sessionID = "ses_manual_flow_int_5_2_normal"
    const messageID = "msg_manual_flow_int_5_2_normal_a"

    const fake = installFakeCavemem()
    try {
      const harness = makeMockClient()
      const hooks = createHooks(harness.client)

      // ----- Step 1: session.created -----
      // Initializes per-session state with parentID=null,
      // agent=null → main-thread session, not subagent-ignored.
      // Also runs the startup self-check; the fully-shaped mock
      // makes it latch `"ok"`.
      await hooks["session.created"]({ info: { id: sessionID } })

      // Sanity: no compaction yet. session.created never calls
      // summarize on its own.
      assert.equal(
        harness.summarizeCalls.length,
        0,
        "session.created alone must not invoke session.summarize",
      )

      // ----- Step 2: message.updated (AssistantMessage) -----
      // Ticks `turnCount` to 1. The token total (20) is far below
      // the configured threshold (100,000), so the evaluator
      // returns `shouldCompact: false`; the automatic path
      // emits a suppression log but does NOT call summarize.
      // This isolates the upcoming manual /compact as the sole
      // trigger source.
      await hooks["message.updated"]({
        info: assistantMessage(sessionID, messageID),
      })

      assert.equal(
        harness.summarizeCalls.length,
        0,
        `message.updated below threshold must NOT call session.summarize; got ${harness.summarizeCalls.length} call(s) — the automatic path is leaking into this test`,
      )

      // ----- Step 3: command.executed (name=compact) -----
      // R4.2 + R4.3. The manual handler reads `turnCount(...) >= 1`,
      // takes the non-zero-turn branch, and calls
      // `invokeCompaction` with trigger="manual",
      // reason="user_initiated". `invokeCompaction` issues exactly
      // one `client.session.summarize` against the same
      // sessionID. No `tui.showToast` on the success path.
      await hooks["command.executed"]({
        name: "compact",
        sessionID,
        arguments: "",
        messageID,
      })

      assert.equal(
        harness.summarizeCalls.length,
        1,
        `expected exactly one client.session.summarize call from the manual /compact path; got ${harness.summarizeCalls.length}`,
      )
      assert.equal(
        harness.summarizeCalls[0].path.id,
        sessionID,
        `summarize must target the sessionID the slash command was invoked on; got ${JSON.stringify(harness.summarizeCalls[0].path)}`,
      )

      // No toast should fire on the success path of manual /compact
      // (toasts are reserved for R4.4 zero-turn and R4.5 failure;
      // neither applies here).
      assert.equal(
        harness.toastCalls.length,
        0,
        `manual /compact success path must not emit a toast; got ${JSON.stringify(harness.toastCalls)}`,
      )

      // ----- Step 4: experimental.session.compacting -----
      // R4.3: opencode fires this hook between calling summarize
      // and generating its native summary. The augmentation
      // handler is the SAME handler chain as the automatic path —
      // there is no manual-specific augmentation. We drive it
      // directly to assert "augmentation parity between automatic
      // and manual triggers" (the task brief's observable).
      const output: { context: string[]; prompt?: string } = {
        context: [],
      }
      await hooks["experimental.session.compacting"](
        { sessionID },
        output,
      )

      // R3.2 (which R4.3 inherits): exactly one entry pushed;
      // verbatim stub text present. The fake's `echo` appends a
      // trailing newline, so we assert containment rather than
      // strict equality.
      assert.equal(
        output.context.length,
        1,
        `expected output.context to grow by exactly one entry from the augmentation handler; got length=${output.context.length}, contents=${JSON.stringify(output.context)}`,
      )
      assert.ok(
        output.context[0].includes(STUB_CAVEMEM_PAYLOAD),
        `output.context[0] must carry the stubbed cavemem payload (augmentation parity, R4.3); got ${JSON.stringify(output.context[0])}`,
      )

      // R3.5 (which R4.3 inherits): the handler augments, never
      // replaces. opencode's continuation summary must be
      // generated by opencode itself; the plugin only adds to
      // `output.context`. The `prompt` field must remain
      // strictly `undefined` (its initial state above).
      assert.equal(
        output.prompt,
        undefined,
        `output.prompt must NOT be assigned by experimental.session.compacting; got ${JSON.stringify(output.prompt)}`,
      )
    } finally {
      fake.cleanup()
    }
  })

  it("zero-turn: command.executed on a session with turnCount==0 emits an info toast and skips summarize (R4.4)", async () => {
    const sessionID = "ses_manual_flow_int_5_2_zero_turn"

    // No fake cavemem installation needed: the zero-turn branch
    // returns before `experimental.session.compacting` is
    // anywhere in scope, so cavemem is never spawned. Skipping
    // the PATH override also documents the negative-space
    // assertion that the zero-turn path never reaches the
    // augmentation handler.
    const harness = makeMockClient()
    const hooks = createHooks(harness.client)

    // ----- Step 1: session.created -----
    // Initializes session state. CRUCIALLY we do NOT drive any
    // `message.updated` after this, so `turnCount(sessionID)`
    // stays at 0 — which is the precondition the zero-turn
    // branch tests.
    await hooks["session.created"]({ info: { id: sessionID } })

    // ----- Step 2: command.executed (name=compact) -----
    // R4.4. The handler reads `turnCount(sessionID) === 0` and
    // takes the zero-turn branch:
    //   - logSuppression(... "zero_turns_manual")
    //   - tui.showToast({ message: "Nothing to compact.", variant: "info" })
    //   - return WITHOUT calling invokeCompaction
    await hooks["command.executed"]({
      name: "compact",
      sessionID,
      arguments: "",
      messageID: "msg_zero_turn_dummy",
    })

    // R4.4: NO summarize call for this sessionID. We check
    // against this sessionID specifically (rather than overall
    // length 0) so the assertion remains correct if the test
    // file later grows other scenarios that also use the shared
    // harness — defensive even though this `it()` block does
    // not share its harness with anyone.
    const summarizeForThisSession = harness.summarizeCalls.filter(
      (c) => c.path.id === sessionID,
    )
    assert.equal(
      summarizeForThisSession.length,
      0,
      `zero-turn manual /compact must NOT call session.summarize for the affected sessionID; got ${summarizeForThisSession.length} call(s): ${JSON.stringify(summarizeForThisSession)}`,
    )

    // R4.4: exactly one toast emitted, both message and variant
    // must match the impl's literal output. The variant
    // assertion is what distinguishes this surface from the
    // R4.5 error-toast path (which uses variant="error").
    assert.equal(
      harness.toastCalls.length,
      1,
      `expected exactly one tui.showToast call from the zero-turn branch; got ${harness.toastCalls.length}: ${JSON.stringify(harness.toastCalls)}`,
    )
    assert.equal(
      harness.toastCalls[0].variant,
      "info",
      `zero-turn toast must use variant="info" (R4.4 informational, not R4.5 error); got ${JSON.stringify(harness.toastCalls[0])}`,
    )
    assert.equal(
      harness.toastCalls[0].message,
      ZERO_TURN_TOAST_MESSAGE,
      `zero-turn toast message must match the impl's literal copy; got ${JSON.stringify(harness.toastCalls[0].message)}`,
    )
  })
})
